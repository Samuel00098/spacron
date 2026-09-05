# Local agent worktrees

Choose **Main repo** to work directly in the open project's checkout. Choose
**Isolated worktree** to give an agent its own checkout and branch, starting at
that project's current HEAD. Uncommitted edits in the main checkout are not
copied into a new isolated checkout. If isolation fails, the launch stops with an
error rather than changing placement.

## Review and test before publishing

1. Open **Fleet**, select the isolated agent, and review its changes.
2. Use **Bring in** to apply its outstanding changes to the main checkout and
   stage them in Source Control. The app saves uncommitted agent edits on the
   agent's local branch first. Your main checkout's HEAD does not change, and
   running agents keep their worktree; closed, fully brought-in checkouts can be cleaned up automatically.
3. Run your project's normal development server or tests from the main checkout.
   Further turns and other agents can be brought in before making a main-branch
   commit. Bring in does not leave an unfinished Git merge.
4. Commit the tested changes in Source Control when ready. Push only when you
   want to publish them.

**Merge** is a separate option that merges the agent branch into the main
checkout's currently checked-out branch and creates a local merge commit. It
also requires no push or remote repository. If changes have already been brought
in, commit or resolve the pending main-checkout changes before using Merge.
The worktree's displayed base branch records where it started; it does not
switch the main checkout back to that branch.

If your own unstaged edits overlap the agent's changes, Bring in stops and keeps
both copies. Conflicting staged changes are surfaced in Source Control for
resolution. Failed snapshots or failed cleanup verification keep the worktree.

Worktrees share Git history, but each has separate files and an index. Install
project dependencies in an isolated checkout if the agent needs to run tests
there. To test the combined result, run from the main checkout after Bring in.

## Disk space and cleanup

Git shares history between worktrees; it does not delete a checkout when you
commit. Each worktree still uses disk space for its files and installed dependencies.
Spacron stores these under `.spacron/worktrees/`, excluded from Git tracking.

After Bring in, Merge, or a Source Control commit, Spacron checks stopped agents
from both the picker and fleet. It removes checkouts with no outstanding changes,
and retries every five minutes while the project is loaded. Active agent terminals
keep their working directories: close the agent when you are finished with it.
Automatic cleanup does not bring in new, unreviewed changes. Git refuses dirty or
locked checkouts, and failed removals remain tracked for retry.

Removing a checkout also removes its ignored dependency/build files. Recovery
branches remain until Git confirms they are merged; refs are small and share the
repository's objects. Bring in followed by a separate commit does not necessarily
record the agent branch as merged, so its recovery branch may remain. Cleanup does
not push, switch branches, or rewrite history.
