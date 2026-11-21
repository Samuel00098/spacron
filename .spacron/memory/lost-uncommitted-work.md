# Uncommitted work vanished from the shared tree: how it was recovered

On 2026-11-20 at 12:38, right after a delegated worker finished, every tracked change in the main folder
(71 files, several people's uncommitted work) disappeared: `git status` showed only untracked files,
`HEAD` was unchanged, and `git stash list` was empty. A `git stash` had been made and then dropped.
Who ran it was not found; no agent was running at the time.

A dropped stash survives as a dangling commit until gc:

```sh
git fsck --no-reflogs --lost-found | grep "dangling commit"   # look for "WIP on <branch>"
git show --stat <sha>                                         # check it is the lost work
git diff --binary <parent-sha> <sha> > restore.patch          # parent = the first parent shown
git apply --check restore.patch && git apply restore.patch    # restores without any stash command
```

Untracked files are never part of a plain stash, so they stay put. Check for this before concluding that
uncommitted work is gone, and before re-doing it.

Related: [[structured-chat]]
