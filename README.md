# touchset-gate

[![tests](https://github.com/justin-rhee/touchset-gate/actions/workflows/test.yml/badge.svg)](https://github.com/justin-rhee/touchset-gate/actions/workflows/test.yml)

Every task I hand my coding agents names the files it is allowed to change. Across three build runs, seventeen fixes landed in files that weren't on the list, and I didn't see it happen.

The list sat in each task's plan and went out with each agent's instructions. Nothing ever compared it with what the agent changed. A list nobody checks is a comment. The same stretch had nine collisions between agents working side by side, and five of them were decided at launch, before anyone edited a thing: an agent started in the wrong folder, shared a scratch folder or state with another agent, or lost its lock. Another developer's field report added a hazard I hadn't hit yet. Every worktree of a repo shares one stash, so one agent's `git stash pop` can take another agent's work.

If you hand an agent a list of files, or run more than one agent on a repo, that list is an unchecked promise.

touchset-gate checks it at both ends. Before an agent starts, it refuses a risky starting point. After the agent works, it compares every changed, committed, staged, and newly created file with the list. One JavaScript file, no dependencies beyond Node and git.

## Use it if

- your agents' plans name the files each task may change
- more than one agent works in the same repo, in worktrees or not
- your agents commit as they go, so a diff of uncommitted work shows you part of the story
- you'd rather a missing baseline stop the check than pass it

## What it catches

On a branch where an agent committed a change to `lib/util.js`, then edited `src/app.js` and created `tools/new/helper.sh`, `git diff --name-only` lists only `src/app.js`. With the task allowed `src/**`, the gate reports this (its `note` lines left out):

```
FINDING "lib/util.js" (modified) is outside the declared touch-set
ok "src/app.js" (modified) matches "src/**"
FINDING "tools/new/helper.sh" (untracked) is outside the declared touch-set
touchset-gate: FINDING
```

A run ends in one of three verdicts: CLEAN (exit 0), FINDING (exit 1), or UNKNOWN (exit 2). UNKNOWN means the gate couldn't look, and it is never reported as CLEAN.

## How it works

`check` runs after the agent works. The change set is everything the branch did:

- edits to tracked files against the base, committed or not
- anything staged, including a file added and then deleted from disk
- new untracked files, which `git diff` can't see at all
- files git has been told to stop watching with `assume-unchanged` or `skip-worktree`, which the gate hashes and compares itself

Renames count as two changes, because moving a file out of an off-limits path changes that path. Git's output is read NUL-separated, so a file named `café.txt` matches its glob instead of arriving as a quoted escape string.

The base is the commit you pass with `--base`. Without it, the gate uses the point where the branch left `main` (or `master`). If the checkout is on that branch itself, on a detached HEAD, or has no such branch, the result is UNKNOWN. A base of HEAD would hide everything the agent committed, and the gate won't guess.

The declaration comes from `--touchset <file>` (one glob per line, `#` for comments), from repeated `--allow <glob>` flags, or both. A line reading `none` means the task may change nothing. A missing or empty declaration is UNKNOWN. Globs are relative to the repo root: `*` stays inside one folder and `**` crosses folders. Every other character is literal, so `app/[slug]/page.tsx` means that one file. Wildcards skip names that start with a dot, so `src/**` doesn't quietly cover `src/.env`.

`preflight` runs where an agent is about to work, and reports a FINDING for any of these:

- a protected branch (`main` and `master` unless you name others) or a detached HEAD
- any stash entry, whoever made it
- a working directory inside one you passed with `--forbid-dir`, compared on real paths so a symlink can't get it past
- the main checkout, when you pass `--require-worktree`

Both commands take `--json` for scripts.

## Install

Copy `src/touchset-gate.mjs` anywhere. It needs Node 22 or newer and git.

```sh
base=$(git rev-parse HEAD)
node touchset-gate.mjs preflight --forbid-dir ~/Sync --require-worktree
# the agent works here
node touchset-gate.mjs check --base "$base" --touchset task.touchset
```

Recording the base before the agent starts is the strongest way to run it, because an agent can move a branch but can't change a commit id you already wrote down. A touchset file kept inside the repo is left out of its own change set, and the output says so.

## What it won't do

Gitignored files are invisible to it, including files ignored through `.git/info/exclude` or a global excludes file. Counting them would flag every editor and OS file on the machine, so this is a trade rather than an oversight.

It can't see edits outside the repo, including writes through a symlink to a file outside it.

It checks whether a change was declared, never whether an in-scope change is right.

Without `--base`, the baseline is only as fixed as the default branch. An agent that moves `main` forward moves the baseline with it.

It isn't a defense against a process that rewrites git's own files to hide from it. It closes the cheap routes: replaced objects, an fsmonitor hook that reports nothing changed, environment variables that point git at another repo, and the two flags above.

A submodule's changes show up as the submodule's own path, so `vendor/sub/**` won't cover `vendor/sub`. A mode-only change to a file flagged `assume-unchanged` or `skip-worktree` isn't detected, because those files are compared by content.

`preflight` covers the wrong starting folder, a protected branch, and a shared stash. It can't tell that two agents share a scratch folder unless you name it with `--forbid-dir`, and it knows nothing about locks.

I've run it on macOS with Node 25 and git 2.50, and the suite runs on macOS and Ubuntu with Node 22 in CI. It hasn't been tried on Windows.

## How I tested it

The suite is 61 tests on Node's built-in test runner, each building real git repos, and takes about sixteen seconds: `node tests/touchset-gate.test.mjs`. Two of them cross-check the glob matcher against Node's own glob engine. Those run only with `TOUCHSET_GLOB_ORACLE=1`, since Node's engine changes between releases.

The break-the-claim test tries nine ways to sneak an out-of-scope change past `check`, each in a fresh repo next to legitimate work: a new file in a new nested folder, a commit followed by more in-scope work, a rename into the allowed folder, a file with a non-ASCII name, a staged file deleted from disk, a deletion, a mode-only change, an edit hidden behind `assume-unchanged`, and an amended commit. All nine come back FINDING with the right path named.

For the load-bearing check I removed the untracked-file lookup from a copy of the gate, and 11 tests went red. Turning off NUL-separated output turned 3 red, all through non-ASCII file names. That is why those tests exist.

I also spent a pass trying to hide edits from it. Plain `git diff` misses an edit behind `assume-unchanged` or `skip-worktree`, an fsmonitor hook that claims nothing changed, and a replace ref that swaps out the base commit. The gate catches all four. It also catches a file whose name contains a newline and a fake verdict line, a tag named `main`, and environment variables pointing git somewhere else. The gaps from that pass are the ones listed above.

Run read-only against a real repo with `--base HEAD~3`, it named the same four files that `git log` shows changed in those commits.

More reasoning behind the design is in [docs/ADR.md](docs/ADR.md).

## License

MIT. See [LICENSE](LICENSE). No warranty. Security notes and how to report a problem: [SECURITY.md](SECURITY.md).

---

This little tool is one of a handful I pulled out of my own day-to-day agent setup. I use them all myself, so when something breaks I usually notice fast. But if you run into any issues, or anything that looks off, open an issue. I read every one. More tools on my [GitHub profile](https://github.com/justin-rhee).
