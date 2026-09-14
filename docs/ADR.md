# Architecture Decision Records (ADRs)

Why touchset-gate is shaped the way it is. The first two decisions come from the build runs where seventeen fixes landed outside their declared files. Most of the rest came from a pass spent trying to hide edits from the gate, where plain git turned out to miss more than I expected.

## The declaration is compared with the repo twice

The lists existed and were written carefully. They went into each task's plan and out with each agent's instructions, and then nothing compared them with anything. Seventeen fixes landed outside them anyway.

The collisions had a different clock. Five of nine were decided when an agent was launched, not when it edited: the wrong folder, a shared scratch folder or state, a lost lock. An after-the-fact diff can't see any of that, because the damage happens outside the task's own changes. So the gate has two commands. `preflight` refuses a bad starting point before any work exists, and `check` compares the finished work with the list.

## The change set is a union, and every part of it is load-bearing

The obvious check is `git diff --name-only` against the list. That misses a file the agent created, which is the most likely out-of-scope file and the one with no other copy anywhere. It misses a file staged and then deleted from disk. It misses edits to files git has been told to stop watching.

So the change set is the tracked diff against the base, plus the staged diff, plus untracked files, plus a content hash of every file flagged `assume-unchanged` or `skip-worktree`. Removing the untracked part from a copy of the gate turns 11 tests red. Removing the staged diff or the flagged-file hash turns their own tests red too.

## The base is never HEAD, and a missing base is UNKNOWN

An agent that commits moves HEAD. A diff against HEAD would show only uncommitted work, and an agent that committed everything out of scope would come back CLEAN. Without `--base`, the gate uses the merge-base of HEAD and `main` or `master`, which covers everything the branch did.

When that can't be computed, the answer is UNKNOWN: no default branch, a checkout sitting on the default branch (where the merge-base is HEAD again), or a detached HEAD. I rejected falling back from a missing `--default-branch` name to `main`, since that invents a baseline the caller never named. The bypass pass showed the default still has a soft spot, because an agent can move `main` forward. That is why the README recommends recording a commit id before the agent starts. A branch can move and a recorded commit can't.

## UNKNOWN is never CLEAN

A gate that prints green when it couldn't look has reported an inspection that didn't happen. An exception, an unreadable declaration, a missing repo, or git failing halfway through all grade UNKNOWN with exit 2 and one line, with no stack trace in the way. A FINDING outranks UNKNOWN, so a real out-of-scope change is never hidden behind a problem elsewhere in the run.

## Git's output is read NUL-separated, with rename detection off

By default git quotes any path with non-ASCII bytes, so `café.txt` arrives as an escaped string in quotes. A quoted path never matches its glob, which makes an in-scope file a false FINDING and leaves the gate with the wrong idea of what changed. Turning off NUL-separated output in a copy of the gate turns 3 tests red, all through non-ASCII names, which is why those tests exist.

Rename detection prints only the new name. Moving a file out of an off-limits folder into the allowed one would then look like an in-scope addition, and the change to the folder it left would disappear. With detection off, a rename is a deletion and an addition, and both are graded.

## The glob matcher is the gate's own

Node's `path.matchesGlob` was the first choice. Fuzzing it against a small matcher written for this found that on one current Node release, `**/x/**/.a` does not match `y/x/.a`, while `*/x/**/.a` and `x/**/.a` match their equivalents. Node bundles its glob engine, so that answer can change with the Node version. A scope verdict that depends on the runtime's minor version isn't a verdict, so the CLI uses only its own matcher. The builtin stays in the test suite as an opt-in cross-check.

The language is deliberately small. `*` stays inside one segment, `**` crosses segments, and every other character is literal. Web frameworks put brackets and parentheses in real file names, and a declaration of `app/[id]/page.tsx` that quietly meant `app/i/page.tsx` or `app/d/page.tsx` would widen the list without anyone seeing it. A brace group with a comma is refused rather than read literally, since whoever wrote `src/{a,b}.js` meant expansion. Wildcards skip names starting with a dot, because dot folders are mostly CI, credentials, and tool config, and a wildcard shouldn't sweep those in unasked.

## Files git was told to ignore are hashed, not refused

`git update-index --assume-unchanged` and `--skip-worktree` make `git diff` report nothing for a file, whatever happens to it. Both hid a real edit in the bypass pass. Refusing to grade any repo with a flagged file would have been simpler, but some developers flag local config files on purpose, and a gate that is always UNKNOWN on their machines is a gate they turn off. So the gate hashes those files and compares them with the index. A `skip-worktree` file missing from disk is normal in a sparse checkout and isn't counted.

## Cheap hardening on every git call

Three more routes fooled plain git in the bypass pass. A replace ref can swap the base commit for another one. An fsmonitor hook is a program that tells git which files changed, and it can say none. Environment variables like `GIT_DIR` can point git at a different repo than the one named. Each git call passes `--no-replace-objects` and `core.fsmonitor=false`, and the redirect variables are removed. Calls also pass `--no-optional-locks`, since a read-only gate shouldn't refresh the index or compete for its lock with an agent that is still working.

None of this makes the gate a defense against a process that rewrites git's own files. It closes the routes that take one command.

## preflight compares real things

A sync folder reached through a symlink is still the sync folder, so containment is decided on real paths at both ends. The native realpath matters on macOS: on a case-insensitive disk, Node's plain `realpathSync` returned `SYNC` for a folder named `Sync`, and a string compare let it through. The compare also adds a separator, so `/a/foo` is never inside `/a/fo`.

The branch check compares the full ref. With a tag also named `main`, the short name git prints is `heads/main`, and a string compare against `main` passes.

A detached HEAD is a FINDING. The source this came from graded it UNKNOWN, but the state is known, and work committed on no branch is one checkout away from being lost.

Any stash entry is a FINDING, whoever made it. That hazard came from another developer's field report rather than my own runs: every worktree shares one stash, so there is no reliable way to tell whose it is. The fix is the same either way.

A `--forbid-dir` that doesn't exist is a note rather than UNKNOWN. A working directory that exists can't be inside a folder that doesn't, and a shared config naming a folder absent on one machine shouldn't make every run there UNKNOWN.

## What is deliberately not here

Gitignored files stay invisible. Listing untracked files without the standard excludes would also stop `.git/info/exclude` from hiding a file, and it would report every ignored editor and OS file as out of scope. I took the blind spot over the noise, and the README says so.

The original read the list out of a particular plan format and mapped a couple of prose entries to the files they probably meant. Here the list is globs and nothing else, so what the gate enforces is exactly what the file says.

There is no Unicode normalization. It would let two distinct file names that differ only in normalization share one declaration on filesystems that store both.
