# Security policy. touchset-gate

## Posture

touchset-gate is provided as-is, with NO WARRANTY (see LICENSE). It is a scope check for agents that are trying to do the right thing and drift, not a security boundary against a process that is trying to hide. It **reduces, does not eliminate**, the chance that out-of-scope work goes unnoticed. If an agent must not be able to touch a path, the thing that stops it is a permission or sandbox the operating system enforces.

Anything that can write to the repository's `.git` directory can make the gate see less. It resists the routes that take one command, listed below, and makes no claim about a process that rewrites git's config, refs, or index by hand.

A CLEAN result says every change the gate could see matched the declaration. It does not say the changes were correct, and it says nothing about files outside the repository.

## Known limits from the bypass pass

Each of these was tried against the built gate. The ones marked caught are covered by the fix named.

- an edit hidden with `git update-index --assume-unchanged` or `--skip-worktree`: caught, the gate hashes flagged files itself
- an fsmonitor hook that reports no changes: caught, every git call passes `core.fsmonitor=false`
- a replace ref that swaps the base commit: caught, every git call passes `--no-replace-objects`
- `GIT_DIR`, `GIT_INDEX_FILE` and similar variables pointing git elsewhere: caught, they are removed before git runs
- a file name containing a newline and a fake verdict line: caught, paths are printed quoted with control characters escaped
- a tag named `main` while the checkout is on `main`: caught, the branch is compared by full ref
- a forbidden folder given in different letter case on a case-insensitive disk: caught, paths are resolved to their on-disk case
- a submodule change hidden by `diff.ignoreSubmodules` config: caught, diffs pass `--ignore-submodules=none`
- a new file in a gitignored path, or one hidden through `.git/info/exclude` or `core.excludesFile`: **not caught**
- an edit outside the repository, including a write through an in-repo symlink to an outside file: **not caught**
- out-of-scope work committed and then `main` moved forward to cover it, when no `--base` is given: **not caught**, and passing a commit id recorded before the agent started closes it
- `core.worktree` rewritten to point at a decoy folder: graded UNKNOWN rather than CLEAN, but only because the decoy is not a repository

## Validation status

The offline suite has been run and passes: 61 tests on Node's test runner against real git repositories, two of which (a cross-check against Node's built-in glob engine) run only when `TOUCHSET_GLOB_ORACLE=1` is set. The break-the-claim test tries nine separate ways to sneak a change past `check`, and all nine are caught. Load-bearing mutations were run: removing the untracked-file lookup turns 11 tests red, and turning off NUL-separated git output turns 3 red. The fsmonitor, replace-ref, letter-case, and `core.worktree` results above come from the bypass pass and are not suite tests. Local runs were on macOS with Node 25 and git 2.50. Linux and Node 22 coverage comes from the CI matrix.

## Reporting a vulnerability

Report privately via a GitHub security advisory on this repository (Security tab, "Report a vulnerability"). Please do not open a public issue for a suspected vulnerability. Give a reasonable window for a fix first.
