#!/usr/bin/env node
/**
 * touchset-gate: did a coding agent stay inside the files it said it would touch,
 * and is the directory it is about to work in a safe place to start?
 *
 * WHY THIS EXISTS
 * In one multi-agent build practice, every task plan declared a touch-set: the files
 * that task was allowed to change. The declaration was written into the plan, read at
 * dispatch, and never compared with anything afterward. Across three build runs, 17
 * fixes landed in files outside the declared set, and nobody saw it when it happened.
 * A touch-set that is never diffed is a comment.
 *
 * In the same period, 5 of 9 collisions between parallel agents happened before any
 * edit at all, at dispatch time: an agent started in the wrong tree, shared a scratch
 * or state directory with a sibling, or had its lock reaped. Separately, a field report
 * from another team described a sibling session's `git stash pop` taking a stash that
 * belonged to a different worktree, because every worktree of a repository shares one
 * refs/stash.
 *
 * So the gate compares the declaration with the ground twice:
 *   check      after the agent works: every changed path must match a declared glob.
 *   preflight  before the agent starts: refuse a protected branch, a non-empty stash,
 *              a forbidden directory, or (optionally) the main worktree.
 *
 * Verdicts: CLEAN exit 0, FINDING exit 1, UNKNOWN exit 2. Anything unreadable, missing,
 * or thrown grades UNKNOWN, never CLEAN: a gate that prints green when it could not look
 * has reported an inspection that did not happen.
 *
 * What it cannot see, by construction: gitignored paths, edits outside the repository,
 * and whether an in-set edit is correct. It detects an agent drifting out of scope
 * through the working tree; it does not defend against a process that rewrites git's
 * own metadata to hide from it.
 */

import { execFileSync } from "node:child_process";
import { existsSync, lstatSync, readFileSync, readlinkSync, realpathSync, statSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const EXIT = { CLEAN: 0, FINDING: 1, UNKNOWN: 2 };

// ---------------------------------------------------------------------------------
// Glob language
// ---------------------------------------------------------------------------------
/*
 * Declared globs are repo-root-relative and use exactly two wildcards:
 *   *   any run of characters inside one path segment (never crosses "/")
 *   **  as a whole segment: zero or more segments in the middle of a glob, one or more
 *       at the end ("src/**" matches everything under src/, not a file named "src")
 * Every other character is literal. That includes [ ] ( ) { } ? ! + @, because the
 * files agents build have them in their names (a web framework's app/[slug]/page.tsx)
 * and a declaration of app/[id]/page.tsx that quietly meant "app/i/page.tsx or
 * app/d/page.tsx" would widen the set without anyone seeing it.
 *
 * Hidden segments: a wildcard never matches a segment that starts with ".". Name them
 * (".github/**", "src/**\/.env"). This is the shell's rule and minimatch's default, and it
 * is the conservative reading for a scope gate: dot-directories are disproportionately
 * CI, credentials and tool configuration, so a wildcard should not sweep them in unasked.
 *
 * A trailing "/" means the directory's contents ("docs/" is "docs/**").
 *
 * Rejected, graded UNKNOWN: absolute globs, "." or ".." segments, backslashes (someone
 * writing "src\app.js" meant a separator), and a brace group containing a comma
 * (someone writing "src/{a,b}.js" meant expansion, which this language does not do).
 *
 * WHY NOT path.matchesGlob AT RUNTIME. Node's builtin (22.5+) was the first choice. Fuzzing
 * it against this matcher found that the builtin's answer depends on the Node version's
 * bundled minimatch: on one current release, "**\/x/**\/.a" does not match "y/x/.a" although
 * "*\/x/**\/.a" and "x/**\/.a" both match their equivalents. A gate whose verdict changes
 * with the runtime's minor version is not a gate, so the matcher below is the only engine
 * the CLI uses. The builtin stays in the test suite as an opt-in oracle: a fixed corpus
 * must agree exactly, and a seeded fuzz run may disagree only in that one shape.
 */

const escapeRegExp = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

const segmentMatches = (segment, patternSegment) => {
  if (!patternSegment.includes("*")) return segment === patternSegment;
  if (segment === "") return false;
  if (segment.startsWith(".") && !patternSegment.startsWith(".")) return false;
  const body = patternSegment.split(/\*+/).map(escapeRegExp).join("[^/]*");
  return new RegExp(`^${body}$`).test(segment);
};

/** Does a repo-relative path (as git prints it) match a normalized glob (see parseEntry)? */
export const matchGlob = (filePath, glob) => {
  const pattern = glob.split("/");
  const file = filePath.split("/");
  const memo = new Map();
  const at = (pi, fi) => {
    const key = pi * (file.length + 1) + fi;
    if (memo.has(key)) return memo.get(key);
    let result;
    if (pi === pattern.length) {
      // A trailing "/" on the path (git prints an untracked nested repo as "sub/") is allowed.
      result = fi === file.length || (fi === file.length - 1 && file[fi] === "");
    } else if (pattern[pi] === "**") {
      const zero = pi < pattern.length - 1 && at(pi + 1, fi);
      result = zero || (fi < file.length && !file[fi].startsWith(".") && (at(pi + 1, fi + 1) || at(pi, fi + 1)));
    } else {
      result = fi < file.length && segmentMatches(file[fi], pattern[pi]) && at(pi + 1, fi + 1);
    }
    memo.set(key, result);
    return result;
  };
  return at(0, 0);
};

/** One declared entry: { none: true } | { glob } | { error }. */
export const parseEntry = (raw) => {
  const text = String(raw).trim();
  if (text === "none") return { none: true };
  if (text === "") return { error: "an empty glob declares nothing" };
  if (text.startsWith("/")) return { error: "globs are relative to the repository root, not absolute" };
  if (text.includes("\\")) return { error: "backslash is not a path character here; use /" };
  if (/\{[\s\S]*,[\s\S]*\}/.test(text)) {
    return { error: "a brace group with a comma cannot be read literally by every glob engine; use one line per path" };
  }
  let glob = text.replace(/^(?:\.\/)+/, "").replace(/\/{2,}/g, "/");
  if (glob === "") return { error: "names nothing" };
  if (glob.endsWith("/")) glob += "**";
  if (glob.split("/").some((s) => s === "." || s === "..")) {
    return { error: "'.' and '..' segments are not allowed; write the path from the repository root" };
  }
  return { glob };
};

/**
 * The declaration file: one glob per line, blank lines and lines starting with "#"
 * ignored, leading and trailing whitespace trimmed. A line reading exactly "none"
 * declares that no change is allowed and must be the only entry.
 */
export const parseTouchsetText = (text) =>
  String(text)
    .replace(/^\uFEFF/, "")
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l !== "" && !l.startsWith("#"));

// ---------------------------------------------------------------------------------
// Output
// ---------------------------------------------------------------------------------
/*
 * Paths are printed JSON-quoted with control, line-separator and bidi characters
 * escaped. A filename is attacker-shaped text: a file named "x\ntouchset-gate: CLEAN"
 * printed raw would fake a verdict line for anyone reading the log instead of the
 * exit code.
 */
export const show = (s) =>
  JSON.stringify(String(s)).replace(
    /[\u0000-\u001F\u007F-\u009F\u200E\u200F\u2028\u2029\u202A-\u202E\u2066-\u2069]/g,
    (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, "0")}`,
  );

const makeReport = () => {
  const lines = [];
  const add = (level) => (text) => lines.push({ level, text });
  return {
    lines,
    data: {},
    ok: add("ok"),
    finding: add("FINDING"),
    unknown: add("unknown"),
    note: add("note"),
    verdict() {
      if (lines.some((l) => l.level === "FINDING")) return "FINDING";
      if (lines.some((l) => l.level === "unknown")) return "UNKNOWN";
      return "CLEAN";
    },
  };
};

const COLORS = { ok: "\x1b[32m", FINDING: "\x1b[31m", unknown: "\x1b[33m", note: "\x1b[2m" };

const printReport = (report, command, json) => {
  const verdict = report.verdict();
  if (json) {
    process.stdout.write(
      `${JSON.stringify({ command, verdict, exitCode: EXIT[verdict], lines: report.lines, ...report.data }, null, 2)}\n`,
    );
    return EXIT[verdict];
  }
  const color = Boolean(process.stdout.isTTY) && !process.env.NO_COLOR;
  const paint = (level, word) => (color ? `${COLORS[level]}${word}\x1b[0m` : word);
  const out = report.lines.map((l) => `${paint(l.level, l.level)} ${l.text}`);
  out.push(`touchset-gate: ${verdict}`);
  process.stdout.write(`${out.join("\n")}\n`);
  return EXIT[verdict];
};

// ---------------------------------------------------------------------------------
// git
// ---------------------------------------------------------------------------------
/*
 * Every git call carries three hardening options:
 *   --no-replace-objects   a refs/replace entry can swap the base commit for another
 *                          one, which would make every diff against it empty.
 *   --no-optional-locks    the gate is read-only; it must not refresh the index under
 *                          a working agent or race it for index.lock.
 *   core.fsmonitor=false   a configured fsmonitor hook is a program that tells git which
 *                          files changed. The gate asks the filesystem itself.
 * Environment variables that redirect git (GIT_DIR, GIT_INDEX_FILE, ...) are removed so
 * --cwd means the tree that is actually inspected, even when the gate runs from a hook.
 */
const GIT_GLOBAL_OPTIONS = ["--no-replace-objects", "--no-optional-locks", "-c", "core.fsmonitor=false"];
const GIT_REDIRECT_VARS = [
  "GIT_DIR",
  "GIT_WORK_TREE",
  "GIT_INDEX_FILE",
  "GIT_COMMON_DIR",
  "GIT_OBJECT_DIRECTORY",
  "GIT_ALTERNATE_OBJECT_DIRECTORIES",
  "GIT_NAMESPACE",
  "GIT_PREFIX",
];

const gitEnv = () => {
  const env = { ...process.env };
  for (const k of GIT_REDIRECT_VARS) delete env[k];
  return env;
};

class GitError extends Error {
  constructor(message, status) {
    super(message);
    this.status = status;
  }
}

const git = (cwd, args, input) => {
  try {
    return execFileSync("git", [...GIT_GLOBAL_OPTIONS, "-C", cwd, ...args], {
      encoding: "utf8",
      input,
      env: gitEnv(),
      stdio: [input === undefined ? "ignore" : "pipe", "pipe", "pipe"],
      maxBuffer: 512 * 1024 * 1024,
    });
  } catch (e) {
    if (e.code === "ENOENT") throw new Error("git was not found on PATH");
    const detail = String(e.stderr || e.message || e).trim().split("\n")[0];
    throw new GitError(`git ${args[0]} failed: ${detail}`, e.status);
  }
};

const tryGit = (cwd, args) => {
  try {
    return { ok: true, out: git(cwd, args) };
  } catch (e) {
    if (!(e instanceof GitError)) throw e;
    return { ok: false, error: e };
  }
};

/*
 * NUL-separated output everywhere (-z). Without it git quotes any path with non-ASCII
 * bytes ("caf\303\251.txt" in quotes), and a quoted path never matches its glob: the
 * in-set file would be a false FINDING and, worse, the gate's idea of what changed
 * would not be the names on disk.
 */
const splitZ = (s) => s.split("\0").filter((x) => x !== "");

const STATUS_WORDS = { A: "added", C: "copied", D: "deleted", M: "modified", R: "renamed", T: "type changed", U: "unmerged", X: "unknown" };

const repoTop = (cwd) => {
  const r = tryGit(cwd, ["rev-parse", "--show-toplevel"]);
  return r.ok ? r.out.trim() : null;
};

// ---------------------------------------------------------------------------------
// check
// ---------------------------------------------------------------------------------
const loadDeclaration = (opts, report) => {
  const entries = [];
  const sources = [];
  if (opts.touchset !== undefined) {
    const file = path.resolve(opts.touchset);
    let text;
    try {
      if (statSync(file).isDirectory()) throw new Error("is a directory");
      text = readFileSync(file, "utf8");
    } catch (e) {
      report.unknown(`cannot read the touchset file ${show(file)}: ${e.code || e.message}`);
      return null;
    }
    const fromFile = parseTouchsetText(text);
    if (fromFile.length === 0) {
      report.unknown(`the touchset file ${show(file)} declares nothing (only blank lines or comments); an empty declaration is a mistake, not a scope`);
      return null;
    }
    entries.push(...fromFile);
    sources.push("touchset file");
  }
  for (const a of opts.allow) entries.push(a);
  if (opts.allow.length) sources.push("--allow");
  if (entries.length === 0) {
    report.unknown("no declaration: pass --touchset <file> and/or --allow <glob>");
    return null;
  }

  let none = false;
  const globs = [];
  let bad = false;
  for (const raw of entries) {
    const e = parseEntry(raw);
    if (e.none) none = true;
    else if (e.error) {
      report.unknown(`invalid glob ${show(raw)}: ${e.error}`);
      bad = true;
    } else if (!globs.includes(e.glob)) globs.push(e.glob);
  }
  if (bad) return null;
  if (none && globs.length) {
    report.unknown(`the declaration mixes "none" with ${globs.length} glob(s); "none" must be the only entry`);
    return null;
  }
  const file = opts.touchset === undefined ? null : path.resolve(opts.touchset);
  report.note(
    none
      ? `declared: none (no change allowed), from ${sources.join(" and ")}`
      : `declared ${globs.length} glob(s) from ${sources.join(" and ")}: ${globs.map(show).join(" ")}`,
  );
  return { none, globs, file };
};

/*
 * THE BASE, and why it is never HEAD by default.
 * An agent that commits its work moves HEAD. If the base were HEAD, `git diff HEAD`
 * would show only what is still uncommitted, and an agent that commits everything
 * out of scope would grade CLEAN. So without --base the base is the merge-base of HEAD
 * and the default branch: everything this branch did, committed or not.
 *
 * When that cannot be computed honestly the grade is UNKNOWN, not a guess:
 *   - no default branch found (or the one named by --default-branch does not exist);
 *   - HEAD is ON the default branch, where the merge-base is HEAD itself and committed
 *     work is invisible again;
 *   - HEAD is detached, so there is no branch whose divergence could be measured.
 * The strongest usage is still explicit: record `git rev-parse HEAD` before the agent
 * starts and pass that commit as --base. A default branch ref is something an agent
 * can advance; a recorded commit id is not.
 */
const resolveBase = (top, opts, report) => {
  if (opts.base !== undefined) {
    // A value starting with "-" would be read by git as an option, not a revision.
    const r = opts.base.startsWith("-") ? { ok: false } : tryGit(top, ["rev-parse", "--verify", "--quiet", `${opts.base}^{commit}`]);
    if (!r.ok || !r.out.trim()) {
      report.unknown(`--base ${show(opts.base)} does not resolve to a commit in ${show(top)}`);
      return null;
    }
    const sha = r.out.trim();
    report.note(`base ${sha.slice(0, 12)} (--base ${show(opts.base)})`);
    return sha;
  }

  const candidates = opts.defaultBranch !== undefined ? [opts.defaultBranch] : ["main", "master"];
  let found = null;
  for (const name of candidates) {
    for (const ref of [`refs/heads/${name}`, `refs/remotes/origin/${name}`]) {
      const r = tryGit(top, ["rev-parse", "--verify", "--quiet", `${ref}^{commit}`]);
      if (r.ok && r.out.trim()) {
        found = { name, ref };
        break;
      }
    }
    if (found) break;
  }
  if (!found) {
    report.unknown(
      `no --base given and no default branch found (tried ${candidates.map((c) => `${c}, origin/${c}`).join(", ")}); pass --base <commit>. The gate will not invent a baseline`,
    );
    return null;
  }

  const head = tryGit(top, ["symbolic-ref", "--quiet", "HEAD"]);
  if (!head.ok) {
    if (head.error.status === 1) {
      report.unknown("no --base given and HEAD is detached, so there is no branch to measure from; pass --base <commit>");
      return null;
    }
    throw head.error;
  }
  if (head.out.trim() === `refs/heads/${found.name}`) {
    report.unknown(
      `no --base given and HEAD is on ${show(found.name)} itself; the merge-base would be HEAD and committed work would be invisible. Pass --base <commit recorded before the work started>`,
    );
    return null;
  }

  const mb = tryGit(top, ["merge-base", "HEAD", found.ref]);
  if (!mb.ok || !mb.out.trim()) {
    report.unknown(`no --base given and HEAD shares no history with ${show(found.ref)}; pass --base <commit>`);
    return null;
  }
  const sha = mb.out.trim();
  report.note(`base ${sha.slice(0, 12)} (merge-base of HEAD and ${found.ref.replace(/^refs\/(heads|remotes)\//, "")})`);
  return sha;
};

/*
 * Files flagged assume-unchanged or skip-worktree are files git has been told not to
 * look at: `git diff` reports no edit to them, ever. Some developers set skip-worktree
 * on local config files on purpose, so refusing to grade such repos would switch the
 * gate off. Instead the gate hashes those files itself and compares with the index.
 * An assume-unchanged file missing from disk counts as deleted. A skip-worktree file
 * missing from disk is the normal state of a sparse checkout and is not a change.
 */
const flaggedChanges = (top) => {
  const changed = new Map();
  for (const entry of splitZ(git(top, ["ls-files", "-v", "-s", "-z"]))) {
    const tag = entry[0];
    const assumeUnchanged = tag >= "a" && tag <= "z";
    const skipWorktree = tag === "S" || tag === "s";
    if (!assumeUnchanged && !skipWorktree) continue;
    const tab = entry.indexOf("\t");
    const [, mode, blob] = entry.slice(0, tab).split(" ");
    const rel = entry.slice(tab + 1);
    const abs = path.join(top, ...rel.split("/"));
    let st;
    try {
      st = lstatSync(abs);
    } catch {
      if (assumeUnchanged && !skipWorktree) changed.set(rel, "deleted, hidden by assume-unchanged");
      continue;
    }
    if (st.isDirectory()) continue;
    const onDisk = st.isSymbolicLink()
      ? git(top, ["hash-object", "--stdin"], readlinkSync(abs)).trim()
      : git(top, ["hash-object", "--", rel]).trim();
    if (onDisk !== blob || (mode === "120000") !== st.isSymbolicLink()) {
      changed.set(rel, `modified, hidden by ${skipWorktree ? "skip-worktree" : "assume-unchanged"}`);
    }
  }
  return changed;
};

/*
 * THE CHANGE SET is a union, and every part of it is load-bearing:
 *   tracked    `git diff <base>`: working tree against the base, committed or not.
 *   staged     `git diff --cached <base>`: the index against the base, which catches a
 *              file that was added and then removed from disk.
 *   untracked  `git ls-files --others --exclude-standard`: a file the agent CREATED.
 *              `git diff` cannot see it at all, and it is exactly the out-of-scope file
 *              that has no other copy anywhere.
 *   flagged    see flaggedChanges.
 * --no-renames: with rename detection a move prints only the new name, so moving a file
 * OUT of an out-of-scope location into an in-scope one would hide the change to the
 * location it left. Deletions are changes.
 * --ignore-submodules=none overrides any config that hides submodule changes.
 */
const collectChangeSet = (top, base) => {
  const changes = new Map();
  const diffArgs = ["--name-status", "-z", "--no-renames", "--no-ext-diff", "--ignore-submodules=none"];
  const addDiff = (out) => {
    const parts = splitZ(out);
    for (let i = 0; i + 1 < parts.length; i += 2) {
      if (!changes.has(parts[i + 1])) changes.set(parts[i + 1], STATUS_WORDS[parts[i][0]] ?? parts[i]);
    }
  };
  addDiff(git(top, ["diff", ...diffArgs, base, "--"]));
  addDiff(git(top, ["diff", "--cached", ...diffArgs, base, "--"]));
  for (const p of splitZ(git(top, ["ls-files", "--others", "--exclude-standard", "-z"]))) {
    if (!changes.has(p)) changes.set(p, "untracked");
  }
  for (const [p, why] of flaggedChanges(top)) if (!changes.has(p)) changes.set(p, why);
  return changes;
};

const isInside = (child, parent) => {
  if (child === parent) return true;
  const prefix = parent.endsWith(path.sep) ? parent : parent + path.sep;
  return child.startsWith(prefix);
};

const realpath = (p) => realpathSync.native(p);

export const runCheck = (opts, report) => {
  const declaration = loadDeclaration(opts, report);
  if (!declaration) return;

  const cwd = path.resolve(opts.cwd ?? process.cwd());
  if (!existsSync(cwd)) {
    report.unknown(`${show(cwd)} does not exist`);
    return;
  }
  // Always work from the top level: `git ls-files` lists paths relative to, and only
  // under, the directory it runs in. Run from a subdirectory it would miss a file
  // created one level up.
  const top = repoTop(cwd);
  if (!top) {
    report.unknown(`${show(cwd)} is not inside a git work tree; there is nothing to compare the declaration with`);
    return;
  }
  report.note(`repository ${show(top)}`);

  const base = resolveBase(top, opts, report);
  if (!base) return;

  const changes = collectChangeSet(top, base);

  // The declaration file is the gate's own input. If it lives in the repository, grading
  // it would make every in-repo declaration its own FINDING, so exactly that path is
  // excluded, and the exclusion is printed rather than hidden.
  if (declaration.file) {
    const realFile = realpath(declaration.file);
    const realTop = realpath(top);
    if (isInside(realFile, realTop)) {
      const rel = path.relative(realTop, realFile).split(path.sep).join("/");
      changes.delete(rel);
      report.note(`the touchset file is inside the repository and is excluded from the change set: ${show(rel)}`);
    }
  }

  const changed = [...changes.keys()].sort();
  report.data.base = base;
  report.data.changed = changed.map((p) => ({ path: p, status: changes.get(p) }));
  report.data.outside = [];
  report.data.unmatchedGlobs = [];

  if (changed.length === 0) {
    if (declaration.none) report.ok("nothing changed, as declared (none)");
    else {
      report.ok("nothing changed against the base");
      report.note("if you expected work here, find it before trusting this result");
    }
    return;
  }

  const used = new Set();
  for (const p of changed) {
    const status = changes.get(p);
    if (declaration.none) {
      report.finding(`${show(p)} (${status}) changed, but the declaration is none`);
      report.data.outside.push(p);
      continue;
    }
    const hit = declaration.globs.find((g) => matchGlob(p, g));
    if (hit) {
      used.add(hit);
      report.ok(`${show(p)} (${status}) matches ${show(hit)}`);
    } else {
      report.finding(`${show(p)} (${status}) is outside the declared touch-set`);
      report.data.outside.push(p);
    }
  }
  for (const g of declaration.globs) {
    if (!used.has(g)) {
      report.note(`declared glob matched nothing that changed: ${show(g)}`);
      report.data.unmatchedGlobs.push(g);
    }
  }
  if (report.data.outside.length) {
    report.note("either the change belongs to another task or the declaration is out of date; fix one of them on purpose");
  }
};

// ---------------------------------------------------------------------------------
// preflight
// ---------------------------------------------------------------------------------
const expandHome = (p) => (p === "~" ? os.homedir() : p.startsWith("~/") ? path.join(os.homedir(), p.slice(2)) : p);

export const runPreflight = (opts, report) => {
  const given = path.resolve(opts.cwd ?? process.cwd());
  let real;
  try {
    if (!statSync(given).isDirectory()) throw new Error("not a directory");
    real = realpath(given);
  } catch (e) {
    report.unknown(`cannot resolve the working directory ${show(given)}: ${e.code || e.message}`);
    return;
  }
  report.note(`working directory ${show(real)}${real === given ? "" : ` (given as ${show(given)})`}`);

  /*
   * Containment is decided on real paths at BOTH ends. A sync folder reached through a
   * symlink is still the sync folder; comparing the strings would let the symlink
   * through. realpathSync.native also returns the on-disk letter case, so on a
   * case-insensitive filesystem "~/SYNC" cannot slip past "~/Sync". The comparison
   * appends a separator, so "/a/foo" is not inside "/a/fo".
   */
  for (const dir of opts.forbidDirs) {
    const resolved = path.resolve(expandHome(dir));
    let forbidden;
    try {
      forbidden = realpath(resolved);
    } catch {
      // The working directory exists, so it cannot have a nonexistent ancestor.
      report.note(`forbidden directory ${show(resolved)} does not exist, so nothing can be inside it`);
      continue;
    }
    if (isInside(real, forbidden)) report.finding(`the working directory is inside the forbidden directory ${show(forbidden)}`);
    else report.ok(`not inside ${show(forbidden)}`);
  }

  const top = repoTop(real);
  if (!top) {
    report.unknown(`${show(real)} is not inside a git work tree; branch and stash cannot be read`);
    return;
  }
  report.note(`repository ${show(top)}`);

  /*
   * Branch. The full ref is compared, not `--short`: with a tag also named "main",
   * `symbolic-ref --short` prints "heads/main" and a string compare would pass.
   * Detached HEAD is a FINDING: commits made there belong to no branch and are one
   * checkout away from being lost, which is the class of hazard preflight refuses.
   */
  const head = tryGit(real, ["symbolic-ref", "--quiet", "HEAD"]);
  if (!head.ok) {
    if (head.error.status !== 1) throw head.error;
    report.finding("HEAD is detached: work committed here belongs to no branch and is easy to lose; create a branch first");
  } else {
    const ref = head.out.trim();
    const branch = ref.startsWith("refs/heads/") ? ref.slice("refs/heads/".length) : ref;
    if (opts.protected.includes(branch)) report.finding(`on protected branch ${show(branch)}; create a branch for the agent's work`);
    else report.ok(`on branch ${show(branch)}`);
  }

  /*
   * Stash. refs/stash is one ref shared by every worktree of a repository, so a stash
   * made in one worktree can be popped or dropped by a session in another. Any entry
   * is a FINDING whoever made it; the remedy (find out whose it is, land it on a
   * branch) is the same either way.
   */
  const stash = git(real, ["stash", "list"]).split("\n").filter((l) => l.trim() !== "");
  if (stash.length) {
    report.finding(
      `${stash.length} stash entr${stash.length === 1 ? "y" : "ies"} on this repository; refs/stash is shared by every worktree, so a session in a sibling worktree can pop or drop it`,
    );
    for (const l of stash.slice(0, 3)) report.note(`stash: ${show(l)}`);
  } else report.ok("stash is empty");

  if (opts.requireWorktree) {
    const r = git(real, ["rev-parse", "--path-format=absolute", "--git-dir", "--git-common-dir"]).trim().split("\n");
    if (r.length !== 2) throw new Error("git rev-parse did not return a git dir and a common dir");
    if (realpath(r[0]) === realpath(r[1])) {
      report.finding("this is the repository's main worktree; --require-worktree wants a linked worktree (git worktree add)");
    } else report.ok("in a linked worktree");
  }
};

// ---------------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------------
export const USAGE = `touchset-gate: compare an agent's declared touch-set with what it changed

usage:
  node touchset-gate.mjs check [--touchset <file>] [--allow <glob>]... [--base <ref>]
                               [--default-branch <name>] [--cwd <dir>] [--json]
      Every changed path (diff against base, staged, untracked) must match a
      declared glob. Without --base the base is the merge-base of HEAD and the
      default branch (main, then master; local, then origin/). UNKNOWN when HEAD
      is on that branch, detached, or none exists.

  node touchset-gate.mjs preflight [--cwd <dir>] [--protected <branch>]... [--forbid-dir <dir>]...
                                   [--require-worktree] [--json]
      Refuse to start on a protected branch (default: main, master), on a
      detached HEAD, with a non-empty stash, inside a forbidden directory, or
      (with --require-worktree) in the main worktree.

exit: 0 CLEAN, 1 FINDING, 2 UNKNOWN`;

const COMMANDS = {
  check: { values: ["touchset", "base", "default-branch", "cwd"], lists: ["allow"], flags: ["json"] },
  preflight: { values: ["cwd"], lists: ["protected", "forbid-dir"], flags: ["json", "require-worktree"] },
};

export const parseArgs = (argv) => {
  const [command, ...rest] = argv;
  const spec = COMMANDS[command];
  if (!spec) throw new UsageError(command === undefined ? "no command given" : `unknown command ${show(command)}`);
  const opts = { command, allow: [], protected: [], forbidDirs: [], json: false, requireWorktree: false };
  const key = (name) => name.replace(/-([a-z])/g, (_, c) => c.toUpperCase());
  for (let i = 0; i < rest.length; i++) {
    const arg = rest[i];
    if (!arg.startsWith("--")) throw new UsageError(`unexpected argument ${show(arg)}`);
    const eq = arg.indexOf("=");
    const name = arg.slice(2, eq === -1 ? undefined : eq);
    const inline = eq === -1 ? undefined : arg.slice(eq + 1);
    if (spec.flags.includes(name)) {
      if (inline !== undefined) throw new UsageError(`--${name} takes no value`);
      opts[key(name)] = true;
      continue;
    }
    if (!spec.values.includes(name) && !spec.lists.includes(name)) {
      throw new UsageError(`unknown option ${show(arg)} for ${command}`);
    }
    let value = inline;
    if (value === undefined) {
      value = rest[++i];
      if (value === undefined || value.startsWith("--")) throw new UsageError(`--${name} needs a value`);
    }
    if (name === "forbid-dir") opts.forbidDirs.push(value);
    else if (spec.lists.includes(name)) opts[key(name)].push(value);
    else if (opts[key(name)] !== undefined) throw new UsageError(`--${name} given twice`);
    else opts[key(name)] = value;
  }
  if (command === "preflight" && opts.protected.length === 0) opts.protected = ["main", "master"];
  return opts;
};

class UsageError extends Error {}

export const main = (argv) => {
  if (argv.includes("--help") || argv.includes("-h")) {
    process.stdout.write(`${USAGE}\n`);
    return 0;
  }
  const report = makeReport();
  const json = argv.includes("--json");
  let command = argv[0];
  try {
    const opts = parseArgs(argv);
    command = opts.command;
    if (command === "check") runCheck(opts, report);
    else runPreflight(opts, report);
  } catch (e) {
    // One line, no stack trace, and never CLEAN. An exception means the gate did not
    // finish looking, which is the definition of UNKNOWN.
    const message = String(e && e.message ? e.message : e).split("\n")[0];
    if (e instanceof UsageError) report.unknown(`${message} (see --help)`);
    else report.unknown(`the gate could not finish, so nothing was graded: ${message}`);
  }
  return printReport(report, command ?? null, json);
};

const invokedDirectly = (() => {
  try {
    return process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
})();

if (invokedDirectly) {
  try {
    process.exitCode = main(process.argv.slice(2));
  } catch (e) {
    process.stdout.write(`unknown internal error: ${String(e && e.message ? e.message : e).split("\n")[0]}\ntouchset-gate: UNKNOWN\n`);
    process.exitCode = EXIT.UNKNOWN;
  }
}
