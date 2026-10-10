# touchset-gate

[![tests](https://github.com/justin-rhee/touchset-gate/actions/workflows/test.yml/badge.svg)](https://github.com/justin-rhee/touchset-gate/actions/workflows/test.yml)

One plain gate for repos you hand to coding agents: **refuses a risky starting point before an agent works**, and **compares every changed file with the task's declared touch-set after it works**. It is one JavaScript file with no dependencies beyond Node 22 and git, and every run ends in a verdict, never a shrug.

It was built after seventeen fixes across three build runs landed in files the task's plan did not allow, and nothing ever compared the plan with what the agent changed. The same stretch saw nine agent collisions, five decided at launch, and a field report that every worktree of a repo shares one stash, so one agent's `git stash pop` can take another agent's work. A list nobody checks is a comment.

## Use it if

- your agents' plans name the files each task may change
- more than one agent works in the same repo, in worktrees or not
- you'd rather a missing baseline stop the check than pass it

## What it does

`check` runs after the agent works. The change set is everything the branch did: edits to tracked files against the base, committed or not, anything staged including a file deleted from disk, new untracked files `git diff` can't see, and files marked `assume-unchanged` or `skip-worktree`, which the gate hashes and compares itself. Renames count as two changes, and git's output is read NUL-separated, so `café.txt` matches its glob. On a branch with an out-of-scope commit and an untracked script, it reports:

```
FINDING "lib/util.js" (modified) is outside the declared touch-set
ok "src/app.js" (modified) matches "src/**"
touchset-gate: FINDING
```

Verdicts are CLEAN (exit 0), FINDING (exit 1), and UNKNOWN (exit 2); UNKNOWN means the gate couldn't look, and it is never reported as CLEAN. The base is `--base`, else where the branch left `main`; on that branch itself, a detached HEAD, or no such branch, the result is UNKNOWN, and a base of HEAD is refused rather than guessed. The declaration is a `--touchset` file (one glob per line) or repeated `--allow` flags; a line reading `none` permits nothing, a missing one is UNKNOWN, globs are repo-root relative with `*` inside a folder and `**` across, every other character is literal, and wildcards skip dotfiles, so `src/**` doesn't cover `src/.env`.

`preflight` runs where an agent is about to work and reports a FINDING for a protected branch (`main` and `master` unless you name others), a detached HEAD, any stash entry, a working directory inside a `--forbid-dir` (compared on real paths so a symlink can't get past), and the main checkout under `--require-worktree`. Both commands take `--json`.

## Install

Copy `src/touchset-gate.mjs` anywhere. Verify it with the test suite below.

```sh
base=$(git rev-parse HEAD)
node touchset-gate.mjs preflight --forbid-dir ~/Sync --require-worktree
# the agent works here
node touchset-gate.mjs check --base "$base" --touchset task.touchset
```

Recording the base before the agent starts is the strongest way to run it: an agent can move a branch but can't change a commit id you already wrote down. A touchset file kept inside the repo is left out of its own change set, and the output says so.

## What it won't do

Gitignored files are invisible to it, including files ignored through `.git/info/exclude` or a global excludes file. Counting them would flag every editor and OS file on the machine, so this is a trade rather than an oversight. It can't see edits outside the repo, including writes through a symlink to a file outside it. It checks whether a change was declared, never whether an in-scope change is right.

Without `--base`, the baseline is only as fixed as the default branch. It isn't a defense against a process that rewrites git's own files to hide from it, but it closes the cheap routes: replaced objects, an fsmonitor hook that reports nothing changed, environment variables that point git at another repo, and the two flags above. A submodule's changes show up as the submodule's own path, so `vendor/sub/**` won't cover `vendor/sub`, and a mode-only change to a flagged `assume-unchanged` or `skip-worktree` file isn't detected, because those are compared by content. `preflight` covers the wrong starting folder, a protected branch, and a shared stash; it can't tell two agents share a scratch folder unless you name it, and it knows nothing about locks.

## Platforms

macOS and Linux today (the suite runs on macOS and Ubuntu with Node 22 in CI). Windows on the way.

## How I tested it

The suite is 61 tests on Node's built-in test runner, each building real git repos, and takes about sixteen seconds: `node tests/touchset-gate.test.mjs`. Two of them cross-check the glob matcher against Node's own glob engine, behind `TOUCHSET_GLOB_ORACLE=1` since Node's engine changes between releases.

The break-the-claim test tries nine ways to sneak an out-of-scope change past `check`, each in a fresh repo next to legitimate work: a new file in a new nested folder, a commit followed by more in-scope work, a rename into the allowed folder, a non-ASCII file name, a staged file deleted from disk, a deletion, a mode-only change, an edit hidden behind `assume-unchanged`, and an amended commit. All nine come back FINDING with the right path named.

Two mutation checks are load-bearing: removing the untracked-file lookup from a copy of the gate turned 11 tests red, and turning off NUL-separated output turned 3 red, all through non-ASCII file names. That is why those tests exist.

I also spent a pass trying to hide edits from it. Plain `git diff` misses an edit behind `assume-unchanged` or `skip-worktree`, an fsmonitor hook that claims nothing changed, and a replace ref that swaps out the base commit; the gate catches all four, plus a file whose name contains a newline and a fake verdict line, a tag named `main`, and environment variables pointing git somewhere else. The gaps from that pass are the ones listed above. Run read-only against a real repo with `--base HEAD~3`, it named the same four files that `git log` shows changed in those commits. Design reasoning in [docs/ADR.md](docs/ADR.md).

## License

MIT. See [LICENSE](LICENSE). No warranty. Security notes and how to report a problem: [SECURITY.md](SECURITY.md).

This little tool is one of a handful I pulled out of my own day-to-day agent setup. I use them all myself, so when something breaks I usually notice fast. If you run into any issues, or anything that looks off, open an issue. I read every one. More tools on my [GitHub profile](https://github.com/justin-rhee).