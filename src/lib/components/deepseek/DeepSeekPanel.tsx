import { useCallback, useEffect, useState } from 'react';
import { useStore } from '$lib/react/useStore';
import { activeProject } from '$lib/stores/workspace';
import { remoteTarget } from '$lib/stores/remoteWorkspace';
import { deepSeekPanelRoot, deepSeekPlacements, startDeepSeekHarnessWeb } from '$lib/services/deepseek-harness';
import type { WorktreeInfo, WorktreeStatus } from '$lib/services/orchestrator/worktree-manager';
import { subscribeWorktreeStatus } from '$lib/services/orchestrator/worktree-status-poll';
import './DeepSeekPanel.css';
import '$lib/components/orchestrator/AgentWorktreeBadge.css';

type PanelState =
  | { kind: 'idle' }
  | { kind: 'starting' }
  | { kind: 'ready'; url: string; mcpWarning: string | null }
  | { kind: 'error'; message: string };

/**
 * DeepSeek Harness's own web UI, in a room of its own.
 *
 * It always shows the ACTIVE project's harness: Rust keeps one `dsh web` per
 * project root and returns the running one, so switching projects switches the
 * harness rather than leaving the previous project's conversation on screen.
 * The frame talks to Rust's loopback gateway directly — no preview proxy — and
 * the room stays mounted while hidden so a conversation is never reloaded.
 */
export default function DeepSeekPanel() {
  const project = useStore(activeProject);
  const remote = useStore(remoteTarget);
  const placements = useStore(deepSeekPlacements);
  // The main checkout, or the project's DeepSeek worktree when it was opened isolated.
  const root = project?.root_path ? deepSeekPanelRoot(placements, project.id, project.root_path) : null;
  const [state, setState] = useState<PanelState>({ kind: 'idle' });
  const [attempt, setAttempt] = useState(0);

  const retry = useCallback(() => setAttempt((n) => n + 1), []);

  useEffect(() => {
    if (!root || remote) return;
    let cancelled = false;
    setState({ kind: 'starting' });
    startDeepSeekHarnessWeb(root)
      .then((panel) => {
        if (!cancelled) setState({ kind: 'ready', url: panel.url, mcpWarning: panel.mcpWarning });
      })
      .catch((e: unknown) => {
        if (!cancelled) setState({ kind: 'error', message: e instanceof Error ? e.message : String(e) });
      });
    return () => {
      cancelled = true;
    };
  }, [root, remote, attempt]);

  if (remote) {
    return <Message title="Not available here" body="DeepSeek Harness runs on this computer only, not in a remote workspace." />;
  }
  if (!root) {
    return <Message title="Open a project" body="DeepSeek Harness opens on the project you have open." />;
  }
  if (state.kind === 'error') {
    return <Message title="DeepSeek Harness did not start" body={state.message} onRetry={retry} />;
  }
  if (state.kind !== 'ready') {
    return (
      <Message
        title="Starting DeepSeek Harness…"
        body="The very first start on this computer takes about a minute; after that it takes a few seconds."
        busy
      />
    );
  }
  return (
    <div className="deepseek-panel">
      <PlacementBadge worktree={placements[project!.id]?.worktree ?? null} />
      {state.mcpWarning && (
        <div className="deepseek-panel__warning" role="status">
          {state.mcpWarning}
          <button type="button" onClick={retry}>Retry</button>
        </div>
      )}
      <iframe
        key={state.url}
        className="deepseek-panel__frame"
        src={state.url}
        // Not `title`: WebView2 shows an iframe's title as a native tooltip
        // wherever the pointer rests inside the frame.
        aria-label="DeepSeek Harness"
        allow="clipboard-read; clipboard-write"
      />
    </div>
  );
}

/**
 * The same "Main repo" / worktree strip every terminal agent shows above its
 * pane (AgentWorktreeBadge), so it is clear where DeepSeek's edits land. The
 * harness has no terminal output to count, so the shared poller runs at its
 * idle cadence (~30s) for the changed-file count.
 */
function PlacementBadge({ worktree }: { worktree: WorktreeInfo | null }) {
  const [status, setStatus] = useState<WorktreeStatus | null>(null);
  useEffect(() => {
    if (!worktree) {
      setStatus(null);
      return;
    }
    return subscribeWorktreeStatus(worktree, () => 0, setStatus);
  }, [worktree?.path]);

  if (!worktree) {
    return (
      <div className="wt-badge main-repo" title="Running in the project root, with no worktree isolation">
        <span className="wt-icon" aria-hidden="true">
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.1" strokeLinecap="round" strokeLinejoin="round">
            <path d="M3 9l9-7 9 7v11a2 2 0 01-2 2H5a2 2 0 01-2-2z" />
            <polyline points="9 22 9 12 15 12 15 22" />
          </svg>
        </span>
        <span className="wt-label">Main repo</span>
      </div>
    );
  }
  const changed = status?.changedFiles ?? 0;
  return (
    <div
      className="wt-badge"
      title={`Isolated worktree
Branch: ${worktree.branch}
Forked from: ${worktree.baseBranch}
Path: ${worktree.path}`}
    >
      <span className="wt-icon" aria-hidden="true">
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.1" strokeLinecap="round" strokeLinejoin="round">
          <circle cx="6" cy="6" r="2.6" />
          <circle cx="6" cy="18" r="2.6" />
          <circle cx="18" cy="9" r="2.6" />
          <path d="M6 8.6v6.8" />
          <path d="M18 11.4c0 4-4 3.4-6.6 4.4" />
        </svg>
      </span>
      <span className="wt-branch">{worktree.branch}</span>
      <span className="wt-sep" aria-hidden="true">·</span>
      <span className={`wt-changes${changed > 0 ? ' dirty' : ''}`}>
        {changed === 0 ? 'no changes' : `${changed} changed`}
      </span>
    </div>
  );
}

function Message({ title, body, busy, onRetry }: { title: string; body: string; busy?: boolean; onRetry?: () => void }) {
  return (
    <div className="deepseek-panel deepseek-panel--message">
      <div className="deepseek-panel__message" aria-busy={busy || undefined}>
        {busy && <span className="deepseek-panel__spinner" aria-hidden="true" />}
        <h2>{title}</h2>
        <p>{body}</p>
        {onRetry && (
          <button type="button" className="deepseek-panel__retry" onClick={onRetry}>
            Try again
          </button>
        )}
      </div>
    </div>
  );
}
