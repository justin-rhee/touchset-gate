# touchset-gate

[![tests](https://github.com/justin-rhee/touchset-gate/actions/workflows/test.yml/badge.svg)](https://github.com/justin-rhee/touchset-gate/actions/workflows/test.yml) [![license: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE) ![node >= 22](https://img.shields.io/badge/node-%3E%3D22-brightgreen.svg) ![zero dependencies](https://img.shields.io/badge/dependencies-0-brightgreen.svg)

Checks that a coding agent changed only the files its task said it would, and stops it from starting somewhere risky.

```
FINDING "lib/util.js" (modified) is outside the declared touch-set
ok "src/app.js" (modified) matches "src/**"
touchset-gate: FINDING
```

Seventeen fixes across three build runs landed in files the task's plan didn't allow, and nothing ever compared the plan with what changed. The same stretch saw nine agent collisions, and a report that every worktree of a repo shares one stash, so one agent's `git stash pop` can take another's work. A list nobody checks is a comment.

## Use it if

- your agents' plans name the files each task may change
- more than one agent works in the same repo, in worktrees or not
- you'd rather a missing baseline stop the check than pass it

## Install

One JavaScript file, nothing beyond Node 22 and git. Copy `src/touchset-gate.mjs` anywhere:

```sh
base=$(git rev-parse HEAD)
node touchset-gate.mjs preflight --forbid-dir ~/Sync --require-worktree
# the agent works here
node touchset-gate.mjs check --base "$base" --touchset task.touchset
```

Writing the base down before the agent starts is the strongest way to run it: an agent can move a branch but can't change a commit id you already recorded.

## How it works

1. `preflight` runs before the agent starts and flags a protected branch, a detached HEAD, any stash entry, a folder you've forbidden, or the main checkout when you require a worktree
2. the touch-set is a file of globs, one per line, or repeated `--allow` flags; `none` permits nothing, and wildcards skip dotfiles, so `src/**` doesn't cover `src/.env`
3. `check` runs after and counts everything the branch did: committed and uncommitted edits, staged files, new untracked files `git diff` can't see, and files hidden behind `assume-unchanged`
4. the verdict is CLEAN (exit 0), FINDING (1) or UNKNOWN (2), and UNKNOWN, meaning it couldn't look, is never reported as CLEAN

Both commands take `--json`.

## What it won't do

- see gitignored files, since counting them would flag every editor and OS file on the machine
- see edits outside the repo, including writes through a symlink to a file outside it
- judge whether an in-scope change is right, only whether it was declared
- hold a fixed baseline without `--base`, since it's then only as fixed as the default branch
- defend against a process that rewrites git's own files, though it closes the cheap routes (replaced objects, a lying fsmonitor hook, environment variables pointing git elsewhere)
- cover a submodule's folder with a glob for its contents, so `vendor/sub/**` won't cover `vendor/sub`
- detect a mode-only change to an `assume-unchanged` file, since those are compared by content
- know two agents share a scratch folder unless you name it, or know anything about locks
- run on Windows yet

## How I tested it

- 61 tests building real git repos, in about sixteen seconds: `node tests/touchset-gate.test.mjs`
- the break-the-claim test tries nine ways to sneak a change past `check`, from a rename into the allowed folder to an amended commit, and all nine come back FINDING with the right path
- removing the untracked-file lookup turns 11 tests red, and turning off NUL-separated output turns 3 red

<details>
<summary>More on testing</summary>

Plain `git diff` misses an edit behind `assume-unchanged` or `skip-worktree`, an fsmonitor hook that claims nothing changed, and a replace ref that swaps out the base commit; the gate catches all four. Run read-only against a real repo with `--base HEAD~3`, it named the same four files `git log` shows changed in those commits. CI runs the suite on macOS and Ubuntu with Node 22. Design reasoning: [docs/ADR.md](docs/ADR.md).

</details>

## License

MIT. See [LICENSE](LICENSE). No warranty. Security notes and how to report a problem: [SECURITY.md](SECURITY.md).

<!-- related:start -->
## Related

- [take-once](https://github.com/justin-rhee/take-once): lets several coding agents share one task list without two of them grabbing the same task
- [never-worse-backup](https://github.com/justin-rhee/never-worse-backup): keeps an auto-backup from saving another session's half-finished work

Part of a small set of tools I pulled out of my own agent harness. I use them myself and read every issue. More on my [GitHub profile](https://github.com/justin-rhee).
<!-- related:end -->
