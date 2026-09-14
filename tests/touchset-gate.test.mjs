// Tests for touchset-gate. Run: node tests/touchset-gate.test.mjs
//
// Every CLI test builds a real git repository under os.tmpdir(). Git runs with an
// empty global config and no system config, so a developer's hooks, excludes or
// signing setup cannot change the result, and identity is passed per command so a
// CI runner with no git identity works.

import { after, describe, test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { matchGlob, parseEntry, show } from "../src/touchset-gate.mjs";

const CLI = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "src", "touchset-gate.mjs");
const ROOT = realpathSync(mkdtempSync(path.join(os.tmpdir(), "touchset-gate-test-")));
after(() => rmSync(ROOT, { recursive: true, force: true }));

const EMPTY_CONFIG = path.join(ROOT, "empty-gitconfig");
writeFileSync(EMPTY_CONFIG, "");
const ENV = { ...process.env, GIT_CONFIG_GLOBAL: EMPTY_CONFIG, GIT_CONFIG_NOSYSTEM: "1" };
delete ENV.NO_COLOR;
for (const k of ["GIT_DIR", "GIT_WORK_TREE", "GIT_INDEX_FILE"]) delete ENV[k];

const IDENTITY = ["-c", "user.name=test", "-c", "user.email=test@example.com", "-c", "commit.gpgsign=false"];
const CAFE = `caf${String.fromCodePoint(0xe9)}`;
const UMLAUT_DIR = `n${String.fromCodePoint(0xe4)}me`;

const git = (cwd, ...args) =>
  execFileSync("git", [...IDENTITY, ...args], { cwd, env: ENV, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });

let counter = 0;
const mkdirp = (p) => mkdirSync(p, { recursive: true });
const write = (dir, rel, content = "x\n") => {
  const abs = path.join(dir, rel);
  mkdirp(path.dirname(abs));
  writeFileSync(abs, content);
};

/** A repo on main with one commit, then (by default) a feature branch checked out. */
const newRepo = ({ branch = "feature", files } = {}) => {
  const dir = path.join(ROOT, `repo${++counter}`);
  mkdirp(dir);
  git(dir, "-c", "init.defaultBranch=main", "init", "-q");
  const initial = files ?? {
    "src/app.js": "app\n",
    "lib/util.js": "util\n",
    "docs/readme.md": "docs\n",
    "README.md": "readme\n",
  };
  for (const [rel, content] of Object.entries(initial)) write(dir, rel, content);
  git(dir, "add", "-A");
  git(dir, "commit", "-qm", "initial");
  if (branch) git(dir, "checkout", "-qb", branch);
  return dir;
};

const commitAll = (dir, message = "work") => {
  git(dir, "add", "-A");
  git(dir, "commit", "-qm", message);
};

const run = (args, { cwd = ROOT, env = {} } = {}) => {
  const r = spawnSync(process.execPath, [CLI, ...args], { cwd, env: { ...ENV, ...env }, encoding: "utf8" });
  const lines = r.stdout.split("\n").filter((l) => l !== "");
  return { code: r.status, out: r.stdout, err: r.stderr, lines, verdict: lines.at(-1) };
};

const check = (dir, ...args) => run(["check", "--cwd", dir, ...args]);
const preflight = (dir, ...args) => run(["preflight", "--cwd", dir, ...args]);

const expectVerdict = (r, verdict) => {
  const code = { CLEAN: 0, FINDING: 1, UNKNOWN: 2 }[verdict];
  assert.equal(r.verdict, `touchset-gate: ${verdict}`, r.out + r.err);
  assert.equal(r.code, code, r.out + r.err);
};

const findingFor = (r, p) => r.lines.some((l) => l.startsWith(`FINDING ${show(p)} `));
const okFor = (r, p) => r.lines.some((l) => l.startsWith(`ok ${show(p)} `));

// =================================================================================
describe("check: the change set against the declaration", () => {
  test("an in-set modification is CLEAN", () => {
    const dir = newRepo();
    write(dir, "src/app.js", "changed\n");
    const r = check(dir, "--allow", "src/**");
    expectVerdict(r, "CLEAN");
    assert.ok(okFor(r, "src/app.js"), r.out);
  });

  test("an out-of-set modification (unstaged) is a FINDING", () => {
    const dir = newRepo();
    write(dir, "src/app.js", "changed\n");
    write(dir, "lib/util.js", "changed\n");
    const r = check(dir, "--allow", "src/**");
    expectVerdict(r, "FINDING");
    assert.ok(findingFor(r, "lib/util.js"), r.out);
    assert.ok(okFor(r, "src/app.js"), r.out);
  });

  test("an out-of-set staged change is a FINDING", () => {
    const dir = newRepo();
    write(dir, "lib/util.js", "changed\n");
    git(dir, "add", "lib/util.js");
    const r = check(dir, "--allow", "src/**");
    expectVerdict(r, "FINDING");
    assert.ok(findingFor(r, "lib/util.js"), r.out);
  });

  test("an out-of-set file that was CREATED (untracked) is a FINDING", () => {
    const dir = newRepo();
    write(dir, "scripts/new-tool.sh", "echo\n");
    const r = check(dir, "--allow", "src/**");
    expectVerdict(r, "FINDING");
    assert.ok(r.lines.includes(`FINDING ${show("scripts/new-tool.sh")} (untracked) is outside the declared touch-set`), r.out);
  });

  test("an out-of-set deletion is a FINDING", () => {
    const dir = newRepo();
    unlinkSync(path.join(dir, "lib/util.js"));
    const r = check(dir, "--allow", "src/**");
    expectVerdict(r, "FINDING");
    assert.ok(r.lines.some((l) => l.startsWith(`FINDING ${show("lib/util.js")} (deleted)`)), r.out);
  });

  test("a rename OUT of an out-of-set location is a FINDING on the location it left", () => {
    const dir = newRepo();
    git(dir, "mv", "docs/readme.md", "src/readme.md");
    const r = check(dir, "--allow", "src/**");
    expectVerdict(r, "FINDING");
    assert.ok(r.lines.some((l) => l.startsWith(`FINDING ${show("docs/readme.md")} (deleted)`)), r.out);
    assert.ok(okFor(r, "src/readme.md"), r.out);
  });

  test("a committed rename is still split into both paths", () => {
    const dir = newRepo();
    git(dir, "mv", "docs/readme.md", "src/readme.md");
    commitAll(dir);
    const r = check(dir, "--allow", "src/**");
    expectVerdict(r, "FINDING");
    assert.ok(findingFor(r, "docs/readme.md"), r.out);
  });

  test("none: any change is a FINDING, no change is CLEAN", () => {
    const dir = newRepo();
    expectVerdict(check(dir, "--allow", "none"), "CLEAN");
    write(dir, "src/app.js", "changed\n");
    const r = check(dir, "--allow", "none");
    expectVerdict(r, "FINDING");
    assert.ok(r.lines.some((l) => l.includes("changed, but the declaration is none")), r.out);
  });

  test("committed out-of-set work is caught with the default merge-base", () => {
    const dir = newRepo();
    write(dir, "lib/util.js", "committed out of scope\n");
    commitAll(dir, "sneak");
    write(dir, "src/app.js", "in scope, uncommitted\n");
    const r = check(dir, "--allow", "src/**");
    expectVerdict(r, "FINDING");
    assert.ok(findingFor(r, "lib/util.js"), r.out);
    assert.ok(r.lines.some((l) => /^note base [0-9a-f]{12} \(merge-base of HEAD and main\)$/.test(l)), r.out);
  });

  test("an explicit --base catches work committed before it; a bad --base is UNKNOWN", () => {
    const dir = newRepo({ branch: null });
    const start = git(dir, "rev-parse", "HEAD").trim();
    write(dir, "lib/util.js", "committed on main\n");
    commitAll(dir);
    const r = check(dir, "--allow", "src/**", "--base", start);
    expectVerdict(r, "FINDING");
    assert.ok(findingFor(r, "lib/util.js"), r.out);
    expectVerdict(check(dir, "--allow", "src/**", "--base", "no-such-ref"), "UNKNOWN");
  });

  test("HEAD on main with no --base is UNKNOWN, never a guessed baseline", () => {
    const dir = newRepo({ branch: null });
    write(dir, "lib/util.js", "x\n");
    commitAll(dir);
    const r = check(dir, "--allow", "src/**");
    expectVerdict(r, "UNKNOWN");
    assert.match(r.out, /HEAD is on "main" itself/);
  });

  test("detached HEAD with no --base is UNKNOWN", () => {
    const dir = newRepo();
    git(dir, "checkout", "-q", "--detach");
    expectVerdict(check(dir, "--allow", "src/**"), "UNKNOWN");
  });

  test("no main or master is UNKNOWN; a named --default-branch that does not exist is UNKNOWN", () => {
    const dir = newRepo({ branch: "trunk" });
    git(dir, "branch", "-qD", "main");
    expectVerdict(check(dir, "--allow", "src/**"), "UNKNOWN");
    git(dir, "checkout", "-qb", "feature");
    write(dir, "lib/util.js", "x\n");
    expectVerdict(check(dir, "--allow", "src/**", "--default-branch", "develop"), "UNKNOWN");
    const r = check(dir, "--allow", "src/**", "--default-branch", "trunk");
    expectVerdict(r, "FINDING");
  });

  test("the default branch falls back to origin/<name> when there is no local branch", () => {
    const upstream = newRepo({ branch: null });
    const clone = path.join(ROOT, `clone${++counter}`);
    git(ROOT, "clone", "-q", upstream, clone);
    git(clone, "checkout", "-qb", "feature");
    git(clone, "branch", "-qD", "main");
    write(clone, "lib/util.js", "x\n");
    const r = check(clone, "--allow", "src/**");
    expectVerdict(r, "FINDING");
    assert.ok(r.lines.some((l) => l.includes("(merge-base of HEAD and origin/main)")), r.out);
  });

  test("an empty change set is CLEAN but says nothing changed", () => {
    const dir = newRepo();
    const r = check(dir, "--allow", "src/**");
    expectVerdict(r, "CLEAN");
    assert.ok(r.lines.includes("ok nothing changed against the base"), r.out);
    assert.ok(r.lines.some((l) => l.startsWith("note if you expected work here")), r.out);
  });

  test("a declared glob that matched nothing is a note, not a finding", () => {
    const dir = newRepo();
    write(dir, "src/app.js", "changed\n");
    const r = check(dir, "--allow", "src/**", "--allow", "docs/**");
    expectVerdict(r, "CLEAN");
    assert.ok(r.lines.includes(`note declared glob matched nothing that changed: ${show("docs/**")}`), r.out);
  });

  test("run from a subdirectory, a file created elsewhere in the repo is still seen", () => {
    const dir = newRepo();
    write(dir, "top-level-new.txt");
    const r = check(path.join(dir, "src"), "--allow", "src/**");
    expectVerdict(r, "FINDING");
    assert.ok(findingFor(r, "top-level-new.txt"), r.out);
  });
});

// =================================================================================
describe("check: the declaration itself", () => {
  test("a missing touchset file is UNKNOWN", () => {
    const dir = newRepo();
    const r = check(dir, "--touchset", path.join(ROOT, "does-not-exist.txt"));
    expectVerdict(r, "UNKNOWN");
    assert.match(r.out, /cannot read the touchset file/);
  });

  test("a touchset file with only comments and blank lines is UNKNOWN, even with --allow", () => {
    const dir = newRepo();
    const file = path.join(ROOT, `empty${++counter}.txt`);
    writeFileSync(file, "# nothing here\n\n   \n");
    expectVerdict(check(dir, "--touchset", file), "UNKNOWN");
    expectVerdict(check(dir, "--touchset", file, "--allow", "src/**"), "UNKNOWN");
  });

  test("none mixed with a glob is UNKNOWN, in a file or across file and --allow", () => {
    const dir = newRepo();
    const file = path.join(ROOT, `mixed${++counter}.txt`);
    writeFileSync(file, "none\nsrc/**\n");
    expectVerdict(check(dir, "--touchset", file), "UNKNOWN");
    const noneFile = path.join(ROOT, `none${++counter}.txt`);
    writeFileSync(noneFile, "# no changes\nnone\n");
    expectVerdict(check(dir, "--touchset", noneFile), "CLEAN");
    expectVerdict(check(dir, "--touchset", noneFile, "--allow", "src/**"), "UNKNOWN");
  });

  test("no declaration at all is UNKNOWN", () => {
    const dir = newRepo();
    expectVerdict(check(dir), "UNKNOWN");
  });

  test("an invalid glob is UNKNOWN", () => {
    const dir = newRepo();
    for (const bad of ["/abs/path", "../outside/**", "src\\app.js", "src/{a,b}.js", "./"]) {
      const r = check(dir, "--allow", bad);
      expectVerdict(r, "UNKNOWN");
      assert.match(r.out, /invalid glob/, bad);
    }
  });

  test("the file format: comments, blank lines, CRLF and surrounding whitespace", () => {
    const dir = newRepo();
    write(dir, "src/app.js", "changed\n");
    write(dir, "docs/readme.md", "changed\n");
    const file = path.join(ROOT, `format${++counter}.txt`);
    writeFileSync(file, "# the task may touch:\r\n\r\n   src/**   \r\ndocs/\r\n");
    const r = check(dir, "--touchset", file);
    expectVerdict(r, "CLEAN");
    assert.ok(okFor(r, "docs/readme.md"), r.out);
  });

  test("a touchset file inside the repo is excluded from the change set, and says so", () => {
    const dir = newRepo();
    write(dir, "src/app.js", "changed\n");
    write(dir, "TOUCHSET.txt", "src/**\n");
    const r = check(dir, "--touchset", path.join(dir, "TOUCHSET.txt"));
    expectVerdict(r, "CLEAN");
    assert.ok(r.lines.includes(`note the touchset file is inside the repository and is excluded from the change set: ${show("TOUCHSET.txt")}`), r.out);
  });
});

// =================================================================================
describe("check: path names and glob semantics", () => {
  test("non-ASCII and space-containing names match their globs (tracked and untracked)", () => {
    const dir = newRepo({ files: { [`src/${CAFE} menu.txt`]: "a\n", [`${UMLAUT_DIR}/old file.txt`]: "b\n" } });
    write(dir, `src/${CAFE} menu.txt`, "changed\n");
    write(dir, `src/${UMLAUT_DIR}/new ${CAFE}.txt`, "new\n");
    const clean = check(dir, "--allow", "src/**");
    expectVerdict(clean, "CLEAN");
    assert.ok(okFor(clean, `src/${CAFE} menu.txt`), clean.out);
    assert.ok(okFor(clean, `src/${UMLAUT_DIR}/new ${CAFE}.txt`), clean.out);

    write(dir, `${UMLAUT_DIR}/old file.txt`, "changed\n");
    write(dir, `${UMLAUT_DIR}/${CAFE} new.txt`, "new\n");
    const bad = check(dir, "--allow", "src/**");
    expectVerdict(bad, "FINDING");
    assert.ok(findingFor(bad, `${UMLAUT_DIR}/old file.txt`), bad.out);
    assert.ok(findingFor(bad, `${UMLAUT_DIR}/${CAFE} new.txt`), bad.out);

    const exact = check(dir, "--allow", "src/**", "--allow", `${UMLAUT_DIR}/old file.txt`, "--allow", `${UMLAUT_DIR}/${CAFE} *`);
    expectVerdict(exact, "CLEAN");
  });

  test("* does not cross a slash; ** does", () => {
    const dir = newRepo();
    write(dir, "src/deep/nested/file.js");
    expectVerdict(check(dir, "--allow", "src/*"), "FINDING");
    expectVerdict(check(dir, "--allow", "src/*/file.js"), "FINDING");
    expectVerdict(check(dir, "--allow", "src/**/file.js"), "CLEAN");
    expectVerdict(check(dir, "--allow", "src/**"), "CLEAN");
  });

  test("brackets are literal: app/[slug]/page.tsx does not declare app/s/page.tsx", () => {
    const dir = newRepo();
    write(dir, "app/[slug]/page.tsx");
    expectVerdict(check(dir, "--allow", "app/[slug]/page.tsx"), "CLEAN");
    const other = newRepo();
    write(other, "app/s/page.tsx");
    expectVerdict(check(other, "--allow", "app/[slug]/page.tsx"), "FINDING");
  });

  test("wildcards do not match hidden segments unless named", () => {
    const dir = newRepo();
    write(dir, ".github/workflows/ci.yml");
    expectVerdict(check(dir, "--allow", "**"), "FINDING");
    expectVerdict(check(dir, "--allow", ".github/**"), "CLEAN");
  });

  test("LIMIT: a gitignored file is not reported", () => {
    const dir = newRepo({ files: { ".gitignore": "build/\n", "src/app.js": "a\n" } });
    write(dir, "build/output.js", "generated\n");
    const r = check(dir, "--allow", "src/**");
    expectVerdict(r, "CLEAN");
    assert.ok(!r.out.includes("build/output.js"), r.out);
  });

  test("a file flagged assume-unchanged or skip-worktree is compared by content", () => {
    const dir = newRepo();
    git(dir, "update-index", "--assume-unchanged", "lib/util.js");
    git(dir, "update-index", "--skip-worktree", "docs/readme.md");
    expectVerdict(check(dir, "--allow", "src/**"), "CLEAN");
    write(dir, "lib/util.js", "hidden edit\n");
    write(dir, "docs/readme.md", "hidden edit\n");
    assert.equal(git(dir, "diff", "--name-only").trim(), "", "precondition: git diff itself hides both edits");
    const r = check(dir, "--allow", "src/**");
    expectVerdict(r, "FINDING");
    assert.ok(r.lines.some((l) => l.startsWith(`FINDING ${show("lib/util.js")} (modified, hidden by assume-unchanged)`)), r.out);
    assert.ok(r.lines.some((l) => l.startsWith(`FINDING ${show("docs/readme.md")} (modified, hidden by skip-worktree)`)), r.out);
  });

  test("a newline in a filename cannot fake a verdict line", () => {
    const dir = newRepo();
    write(dir, "evil\ntouchset-gate: CLEAN");
    const r = check(dir, "--allow", "src/**");
    expectVerdict(r, "FINDING");
    assert.equal(r.lines.filter((l) => l.startsWith("touchset-gate:")).length, 1, r.out);
  });

  test("GIT_DIR and GIT_INDEX_FILE in the environment do not redirect the inspection", () => {
    const dir = newRepo();
    const decoy = newRepo();
    write(dir, "lib/util.js", "changed\n");
    const r = run(["check", "--cwd", dir, "--allow", "src/**"], {
      env: { GIT_DIR: path.join(decoy, ".git"), GIT_INDEX_FILE: path.join(ROOT, "no-index") },
    });
    expectVerdict(r, "FINDING");
    assert.ok(findingFor(r, "lib/util.js"), r.out);
  });

  test("--json reports the verdict, the change set and what fell outside", () => {
    const dir = newRepo();
    write(dir, "src/app.js", "changed\n");
    write(dir, "lib/new.js");
    const r = check(dir, "--allow", "src/**", "--allow", "docs/**", "--json");
    assert.equal(r.code, 1);
    const report = JSON.parse(r.out);
    assert.equal(report.command, "check");
    assert.equal(report.verdict, "FINDING");
    assert.equal(report.exitCode, 1);
    assert.deepEqual(report.outside, ["lib/new.js"]);
    assert.deepEqual(report.unmatchedGlobs, ["docs/**"]);
    assert.deepEqual(
      report.changed.map((c) => c.path),
      ["lib/new.js", "src/app.js"],
    );
  });

  test("no ANSI color when stdout is not a terminal", () => {
    const dir = newRepo();
    write(dir, "lib/util.js", "changed\n");
    const r = check(dir, "--allow", "src/**");
    assert.ok(!r.out.includes("\x1b"), r.out);
  });
});

// =================================================================================
describe("BREAK THE CLAIM: every sneak the tool says it catches, tried for real", () => {
  // Each sneak runs in a fresh repo with only in-set work alongside it, so one caught
  // sneak cannot mask another that slipped through.
  const sneaks = [
    ["untracked file in a brand-new nested directory", (d) => write(d, "tools/a/b/c/new.js"), "tools/a/b/c/new.js"],
    [
      "commit the out-of-set change, then keep working in scope",
      (d) => {
        write(d, "lib/util.js", "committed\n");
        commitAll(d, "looks innocent");
        write(d, "src/app.js", "more in-scope work\n");
      },
      "lib/util.js",
    ],
    ["rename an out-of-set file into the declared set", (d) => git(d, "mv", "lib/util.js", "src/util.js"), "lib/util.js"],
    [
      "unicode-named file outside the set",
      (d) => write(d, `${UMLAUT_DIR}/${CAFE}.txt`),
      `${UMLAUT_DIR}/${CAFE}.txt`,
    ],
    [
      "stage a new out-of-set file, then delete it from disk",
      (d) => {
        write(d, "lib/staged-only.js");
        git(d, "add", "lib/staged-only.js");
        unlinkSync(path.join(d, "lib/staged-only.js"));
      },
      "lib/staged-only.js",
    ],
    ["delete an out-of-set file", (d) => unlinkSync(path.join(d, "docs/readme.md")), "docs/readme.md"],
    ["change only the file mode of an out-of-set file", (d) => chmodSync(path.join(d, "lib/util.js"), 0o755), "lib/util.js"],
    [
      "hide an out-of-set edit behind assume-unchanged",
      (d) => {
        git(d, "update-index", "--assume-unchanged", "lib/util.js");
        write(d, "lib/util.js", "hidden\n");
      },
      "lib/util.js",
    ],
    [
      "fold an out-of-set change into an amended commit",
      (d) => {
        write(d, "lib/util.js", "x\n");
        commitAll(d);
        write(d, "src/app.js", "amended in\n");
        git(d, "add", "-A");
        git(d, "commit", "-q", "--amend", "-m", "only src, honest");
      },
      "lib/util.js",
    ],
  ];

  test("each sneak is caught on its own", async (t) => {
    for (const [name, sneak, expected] of sneaks) {
      await t.test(name, () => {
        const dir = newRepo();
        write(dir, "src/app.js", "in-scope work\n");
        sneak(dir);
        const r = check(dir, "--allow", "src/**");
        expectVerdict(r, "FINDING");
        assert.ok(findingFor(r, expected), `${name}\n${r.out}`);
      });
    }
  });
});

// =================================================================================
describe("preflight", () => {
  test("a clean feature branch is CLEAN", () => {
    const dir = newRepo();
    expectVerdict(preflight(dir), "CLEAN");
  });

  test("a protected branch is a FINDING (default main, custom --protected)", () => {
    const main = newRepo({ branch: null });
    const r = preflight(main);
    expectVerdict(r, "FINDING");
    assert.match(r.out, /on protected branch "main"/);
    const release = newRepo({ branch: "release" });
    expectVerdict(preflight(release), "CLEAN");
    expectVerdict(preflight(release, "--protected", "release"), "FINDING");
  });

  test("a tag named main does not disguise the main branch", () => {
    const dir = newRepo({ branch: null });
    git(dir, "tag", "main");
    expectVerdict(preflight(dir), "FINDING");
  });

  test("detached HEAD is a FINDING", () => {
    const dir = newRepo();
    git(dir, "checkout", "-q", "--detach");
    const r = preflight(dir);
    expectVerdict(r, "FINDING");
    assert.match(r.out, /HEAD is detached/);
  });

  test("a stash made in the main checkout is a FINDING from a linked worktree (refs/stash is shared)", () => {
    const dir = newRepo();
    const wt = path.join(ROOT, `wt${++counter}`);
    git(dir, "worktree", "add", "-q", "-b", "agent", wt);
    expectVerdict(preflight(wt), "CLEAN");
    write(dir, "src/app.js", "stash me\n");
    git(dir, "stash", "push", "-q", "-m", "main checkout work");
    const r = preflight(wt);
    expectVerdict(r, "FINDING");
    assert.match(r.out, /1 stash entry on this repository; refs\/stash is shared by every worktree/);
  });

  test("--forbid-dir is decided on real paths: a symlink either way is still inside", () => {
    const base = path.join(ROOT, `forbid${++counter}`);
    const sync = path.join(base, "real", "sync");
    mkdirp(sync);
    const link = path.join(base, "link-to-sync");
    symlinkSync(sync, link);
    const git_ = (d) => {
      mkdirp(d);
      git(d, "-c", "init.defaultBranch=main", "init", "-q");
      git(d, "commit", "-q", "--allow-empty", "-m", "i");
      git(d, "checkout", "-qb", "feature");
      return d;
    };
    const proj = git_(path.join(sync, "proj"));
    const viaLink = path.join(link, "proj");
    const a = preflight(viaLink, "--forbid-dir", sync);
    expectVerdict(a, "FINDING");
    assert.match(a.out, /inside the forbidden directory/);
    expectVerdict(preflight(proj, "--forbid-dir", link), "FINDING");
    expectVerdict(preflight(proj, "--forbid-dir", `${link}/`), "FINDING");
  });

  test("a prefix sibling is not inside: /x/foo is not inside /x/fo", () => {
    const base = path.join(ROOT, `sibling${++counter}`);
    const dir = path.join(base, "foo");
    mkdirp(dir);
    mkdirp(path.join(base, "fo"));
    git(dir, "-c", "init.defaultBranch=main", "init", "-q");
    git(dir, "commit", "-q", "--allow-empty", "-m", "i");
    git(dir, "checkout", "-qb", "feature");
    const r = preflight(dir, "--forbid-dir", path.join(base, "fo"));
    expectVerdict(r, "CLEAN");
    assert.ok(r.lines.some((l) => l.startsWith("ok not inside")), r.out);
  });

  test("--forbid-dir expands ~ and a nonexistent forbidden dir is a visible note", () => {
    const home = path.join(ROOT, `home${++counter}`);
    const dir = path.join(home, "Sync", "proj");
    mkdirp(dir);
    git(dir, "-c", "init.defaultBranch=main", "init", "-q");
    git(dir, "commit", "-q", "--allow-empty", "-m", "i");
    git(dir, "checkout", "-qb", "feature");
    const r = run(["preflight", "--cwd", dir, "--forbid-dir", "~/Sync", "--forbid-dir", "~/NotThere"], { env: { HOME: home } });
    expectVerdict(r, "FINDING");
    assert.ok(r.lines.some((l) => l.startsWith("note forbidden directory") && l.includes("NotThere")), r.out);
  });

  test("--require-worktree: the main worktree is a FINDING, a git worktree add is CLEAN", () => {
    const dir = newRepo();
    const r = preflight(dir, "--require-worktree");
    expectVerdict(r, "FINDING");
    assert.match(r.out, /main worktree/);
    const wt = path.join(ROOT, `wt${++counter}`);
    git(dir, "worktree", "add", "-q", "-b", "agent", wt);
    const w = preflight(wt, "--require-worktree");
    expectVerdict(w, "CLEAN");
    assert.ok(w.lines.includes("ok in a linked worktree"), w.out);
  });

  test("a directory that is not a git repository is UNKNOWN", () => {
    const dir = path.join(ROOT, `plain${++counter}`);
    mkdirp(dir);
    const r = preflight(dir);
    expectVerdict(r, "UNKNOWN");
    assert.match(r.out, /not inside a git work tree/);
    expectVerdict(preflight(path.join(ROOT, "missing-dir")), "UNKNOWN");
  });
});

// =================================================================================
describe("failure grades UNKNOWN, never CLEAN", () => {
  test("git missing from PATH: UNKNOWN, one line, no stack trace", () => {
    const dir = newRepo();
    for (const args of [["check", "--cwd", dir, "--allow", "src/**"], ["preflight", "--cwd", dir]]) {
      const r = run(args, { env: { PATH: path.join(ROOT, "empty-path") } });
      expectVerdict(r, "UNKNOWN");
      assert.ok(!/\n\s+at /.test(r.out + r.err), r.out + r.err);
      assert.equal(r.err, "");
    }
  });

  test("git failing halfway through reading the change set is UNKNOWN, not an empty CLEAN", { skip: process.platform === "win32" }, () => {
    const dir = newRepo();
    const realGit = execFileSync("sh", ["-c", "command -v git"], { env: ENV, encoding: "utf8" }).trim();
    const shimDir = path.join(ROOT, `shim${++counter}`);
    mkdirp(shimDir);
    writeFileSync(
      path.join(shimDir, "git"),
      `#!/bin/sh\nfor a in "$@"; do [ "$a" = "ls-files" ] && { echo "fatal: simulated failure" >&2; exit 128; }; done\nexec "${realGit}" "$@"\n`,
    );
    chmodSync(path.join(shimDir, "git"), 0o755);
    const r = run(["check", "--cwd", dir, "--allow", "src/**"], { env: { PATH: `${shimDir}:${process.env.PATH}` } });
    expectVerdict(r, "UNKNOWN");
    assert.match(r.out, /could not finish, so nothing was graded: git ls-files failed: fatal: simulated failure/);
  });

  test("usage errors are UNKNOWN; --help exits 0", () => {
    expectVerdict(run([]), "UNKNOWN");
    expectVerdict(run(["frobnicate"]), "UNKNOWN");
    expectVerdict(run(["check", "--allow"]), "UNKNOWN");
    expectVerdict(run(["check", "--nope"]), "UNKNOWN");
    expectVerdict(run(["preflight", "stray"]), "UNKNOWN");
    const help = run(["--help"]);
    assert.equal(help.code, 0);
    assert.match(help.out, /^touchset-gate:/);
  });
});

// =================================================================================
describe("glob engine: the matcher against Node's path.matchesGlob as an oracle", () => {
  // The oracle runs only when asked (TOUCHSET_GLOB_ORACLE=1). Node's bundled glob engine
  // changes between releases, so a CI run on a different Node could go red over Node's
  // behavior rather than the gate's. The fixed table below pins the gate's own answers on
  // every run; the oracle is the cross-check I run by hand when the matcher changes.
  const HAS_BUILTIN = typeof path.posix.matchesGlob === "function";
  const NO_BUILTIN = !HAS_BUILTIN
    ? "path.matchesGlob is not in this Node"
    : process.env.TOUCHSET_GLOB_ORACLE !== "1" && "oracle comparison is opt-in: set TOUCHSET_GLOB_ORACLE=1";
  // The builtin reads [ ] ( ) { } ? as glob syntax; wrapping each in a class makes it
  // literal, which is the gate's language.
  const toBuiltinPattern = (glob) => glob.replace(/[[\](){}?]/g, (c) => `[${c}]`);
  const oracle = (p, g) => path.posix.matchesGlob(p, toBuiltinPattern(g));

  const CORPUS = [
    ["src/a.js", "src/*"],
    ["src/a/b.js", "src/*"],
    ["src/a/b.js", "src/**"],
    ["src", "src/**"],
    ["sub/", "sub/**"],
    ["sub/", "sub/*"],
    ["a/b/", "a/*"],
    ["a/c", "a/**/c"],
    ["a/x/y/c", "a/**/c"],
    ["b.ts", "**/b.ts"],
    [".github/w/ci.yml", "**"],
    [".github/w/ci.yml", ".github/**"],
    ["x/.env", "x/*"],
    ["x/.env", "x/.*"],
    ["x/.env", "**/.env"],
    ["a/.hidden/c", "a/**/c"],
    ["abc", "a**c"],
    ["ac/c", "a**/c"],
    ["app/[slug]/page.tsx", "app/[slug]/page.tsx"],
    ["app/s/page.tsx", "app/[slug]/page.tsx"],
    ["app/(group)/page.tsx", "app/(group)/*.tsx"],
    ["a?b", "a?b"],
    ["axb", "a?b"],
    ["a{b}", "a{b}"],
    ["ab", "a+(b)"],
    ["a+(b)", "a+(b)"],
    ["!x", "!x"],
    ["#x", "#x"],
    ["a b/c d", "a b/*"],
    [`${CAFE}/x`, `${CAFE}/*`],
    ["evil\nname", "*"],
    ["", "**"],
  ];

  test("expected answers of the gate's own language", () => {
    const expected = [true, false, true, false, true, false, true, true, true, true, false, true, false, true, true, false, true, true, true, false, true, true, false, true, false, true, true, true, true, true, true, true];
    assert.deepEqual(CORPUS.map(([p, g]) => matchGlob(p, g)), expected);
    // The one shape where a current builtin disagrees; the gate answers by its stated rule.
    assert.equal(matchGlob("y/x/.a", "**/x/**/.a"), true);
  });

  test("agrees with path.matchesGlob on the fixed corpus", { skip: NO_BUILTIN }, () => {
    for (const [p, g] of CORPUS) assert.equal(matchGlob(p, g), oracle(p, g), `${JSON.stringify(p)} vs ${JSON.stringify(g)}`);
  });

  test("agrees with path.matchesGlob on 20000 seeded random cases, except one known builtin shape", { skip: NO_BUILTIN }, (t) => {
    let seed = 0x2f6e2b1;
    const rand = () => {
      seed = (seed + 0x6d2b79f5) | 0;
      let x = Math.imul(seed ^ (seed >>> 15), 1 | seed);
      x = (x + Math.imul(x ^ (x >>> 7), 61 | x)) ^ x;
      return ((x ^ (x >>> 14)) >>> 0) / 4294967296;
    };
    const pick = (arr) => arr[Math.floor(rand() * arr.length)];
    const CHARS = ["a", "b", ".", "[", "]", "(", ")", "?", "{", "}", "!", "+", "@", "#", " ", ",", String.fromCodePoint(0xe9)];
    const segment = (extra) => Array.from({ length: 1 + Math.floor(rand() * 3) }, () => pick([...CHARS, ...extra])).join("");
    let compared = 0;
    let knownShape = 0;
    const unexplained = [];
    for (let i = 0; i < 20000; i++) {
      const pathSegs = Array.from({ length: 1 + Math.floor(rand() * 5) }, () => segment([])).filter((s) => s !== "." && s !== "..");
      if (pathSegs.length === 0) continue;
      const filePath = pathSegs.join("/") + (rand() < 0.1 ? "/" : "");
      const globSegs = Array.from({ length: 1 + Math.floor(rand() * 5) }, () => (rand() < 0.25 ? "**" : segment(["*", "*"])));
      // Half the globs are derived from the path, so matches are common rather than rare.
      const raw = rand() < 0.5 ? globSegs.join("/") : pathSegs.map((s) => (rand() < 0.35 ? pick(["*", "**", `${s[0]}*`]) : s)).join("/");
      const entry = parseEntry(raw);
      if (!entry.glob) continue;
      compared++;
      const ours = matchGlob(filePath, entry.glob);
      const theirs = oracle(filePath, entry.glob);
      if (ours === theirs) continue;
      // Known: some minimatch versions refuse a match when two "**" segments surround a
      // literal and a later literal dot-segment. Only that shape, and only in that direction.
      const globstars = entry.glob.split("/").filter((s) => s === "**").length;
      const hiddenLiteral = entry.glob.split("/").some((s) => s.startsWith("."));
      if (ours && !theirs && globstars >= 2 && hiddenLiteral) knownShape++;
      else unexplained.push({ filePath, glob: entry.glob, ours, theirs });
    }
    t.diagnostic(`compared ${compared}; known-shape disagreements ${knownShape}; unexplained ${unexplained.length}`);
    assert.ok(compared > 10000, `only ${compared} cases were comparable`);
    assert.deepEqual(unexplained.slice(0, 5), []);
  });

  test("parseEntry normalizes and rejects", () => {
    assert.deepEqual(parseEntry("none"), { none: true });
    assert.deepEqual(parseEntry("  src/**  "), { glob: "src/**" });
    assert.deepEqual(parseEntry("./src//a.js"), { glob: "src/a.js" });
    assert.deepEqual(parseEntry("docs/"), { glob: "docs/**" });
    assert.deepEqual(parseEntry("a{b}"), { glob: "a{b}" });
    for (const bad of ["", "/etc/**", "a/../b", "./", "a\\b", "{a,b}/**", "a/./b"]) {
      assert.ok(parseEntry(bad).error, `should reject ${JSON.stringify(bad)}`);
    }
  });
});
