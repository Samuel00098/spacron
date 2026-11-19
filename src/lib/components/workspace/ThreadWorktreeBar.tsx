import { useState } from 'react';
import type { ChatThread } from '$lib/types/chat';
import { setChatThreadPullRequest, setChatThreadWorktree, STANDALONE_CHAT_SCOPE } from '$lib/stores/chatThreads';
import {
  commitAndOpenPullRequest,
  createThreadWorktree,
  removeThreadWorktree,
  shipSummary,
  toThreadPullRequest,
} from '$lib/services/thread-worktree';

/**
 * The per-thread worktree control: give this thread its own checkout, then ship
 * it with one button.
 *
 * Everything here is scoped to one thread on purpose. Two threads sharing a
 * working tree is what makes parallel agent work overwrite itself, so the
 * worktree is bound to the thread rather than to the project or the app.
 */

type Busy = 'creating' | 'shipping' | 'leaving' | null;

export default function ThreadWorktreeBar({ thread, projectId }: { thread: ChatThread; projectId: string }) {
  const [busy, setBusy] = useState<Busy>(null);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);

  // A standalone conversation has no repository to isolate.
  if (!projectId || projectId === STANDALONE_CHAT_SCOPE) return null;

  const worktree = thread.worktree ?? null;
  const pullRequest = thread.pullRequest ?? null;
  // Switching cwd while a turn is streaming would leave half the work in the
  // old tree, so structural changes wait for the turn to end.
  const working = thread.status === 'working';
  const locked = working || busy !== null;

  const isolate = async () => {
    setBusy('creating');
    setError(null);
    setNote(null);
    try {
      const created = await createThreadWorktree({
        projectId,
        threadId: thread.id,
        title: thread.title,
      });
      setChatThreadWorktree(thread.id, created);
      setNote(`Working in ${created.branch}. Every new turn runs in that checkout.`);
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : String(failure));
    } finally {
      setBusy(null);
    }
  };

  const ship = async () => {
    if (!worktree) return;
    setBusy('shipping');
    setError(null);
    setNote(null);
    try {
      const result = await commitAndOpenPullRequest({
        projectId,
        threadId: thread.id,
        repoPath: worktree.path,
        title: thread.title,
        base: worktree.baseBranch,
      });
      setChatThreadPullRequest(thread.id, toThreadPullRequest(result));
      const summary = shipSummary(result);
      setNote(`${summary.headline} — ${summary.detail}`);
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : String(failure));
    } finally {
      setBusy(null);
    }
  };

  const leave = async () => {
    if (!worktree) return;
    // A shared project worktree belongs to the sidebar, not to this thread:
    // other agents may be working in it, so leaving only detaches the thread.
    if (worktree.shared) {
      setChatThreadWorktree(thread.id, null);
      setChatThreadPullRequest(thread.id, null);
      setError(null);
      setNote('This thread now works in the project root. The worktree is still there for its other agents.');
      return;
    }
    setBusy('leaving');
    setError(null);
    setNote(null);
    try {
      const removed = await removeThreadWorktree(projectId, worktree);
      if (!removed) {
        setError(`Could not remove the checkout at ${worktree.path}. Commit or discard its changes first.`);
        return;
      }
      setChatThreadWorktree(thread.id, null);
      setChatThreadPullRequest(thread.id, null);
      setNote(`Left the isolated checkout. Branch ${worktree.branch} was kept.`);
    } finally {
      setBusy(null);
    }
  };

  const status = busy === 'creating'
    ? 'Creating the checkout…'
    : busy === 'shipping'
      ? 'Committing, pushing and opening the pull request…'
      : busy === 'leaving'
        ? 'Removing the checkout…'
        : null;

  return (
    <div className="thread-worktree-bar" role="group" aria-label="Thread checkout">
      {!worktree ? (
        <>
          <button
            type="button"
            className="thread-worktree-action"
            onClick={() => void isolate()}
            disabled={locked}
            title={working
              ? 'Finish the running turn first: switching checkouts mid-turn would split the work.'
              : 'Give this thread its own git worktree and branch, so it never collides with another thread'}
          >
            {busy === 'creating' ? 'Isolating…' : '⑂ Work in its own worktree'}
          </button>
          <span className="thread-worktree-hint">Parallel threads stop overwriting each other.</span>
        </>
      ) : (
        <>
          <span className="thread-worktree-chip" title={`${worktree.path}\nForked from ${worktree.baseBranch}`}>
            ⑂ {worktree.branch}
          </span>
          <button
            type="button"
            className="thread-worktree-ship"
            onClick={() => void ship()}
            disabled={locked}
            title={working ? 'Finish the running turn first.' : 'Commit everything, push the branch and open a pull request'}
          >
            {busy === 'shipping' ? 'Shipping…' : 'Commit & open PR'}
          </button>
          {pullRequest?.url ? (
            <a
              className="thread-worktree-link"
              href={pullRequest.url}
              target="_blank"
              rel="noreferrer noopener"
            >
              {pullRequest.number ? `PR #${pullRequest.number}` : 'Pull request'}
            </a>
          ) : pullRequest?.compareUrl ? (
            <a
              className="thread-worktree-link"
              href={pullRequest.compareUrl}
              target="_blank"
              rel="noreferrer noopener"
            >
              Open PR on GitHub
            </a>
          ) : null}
          <button
            type="button"
            className="thread-worktree-action subtle"
            onClick={() => void leave()}
            disabled={locked}
            title={worktree.shared
              ? 'Move this thread back to the project root. The worktree itself stays.'
              : 'Remove this checkout but keep its branch'}
          >
            {busy === 'leaving' ? 'Leaving…' : 'Leave worktree'}
          </button>
        </>
      )}
      {status && <span className="thread-worktree-status" role="status">{status}</span>}
      {note && !error && <span className="thread-worktree-note" role="status">{note}</span>}
      {error && <span className="thread-worktree-error" role="alert">{error}</span>}
    </div>
  );
}
