/**
 * Everything that is not "what needs a human right now", one click deep.
 *
 * The ambient shell docks its tools: drawers on both sides, a room grid, a dock
 * of launchers. That is a lot of permanently-visible chrome for surfaces you
 * touch occasionally, and it is the main reason the workspace reads as busy. The
 * stream keeps the tools and moves them here — a slide-over, opened from a
 * specific agent, closed with Esc.
 *
 * The panes are the app's existing ones, not reimplementations:
 *
 * - **Changes** — the agent's own diff, read from *its* repo. Not
 *   `SourceControl`, which is scoped to the open project and so would show the
 *   user's working tree instead of the agent's branch.
 * - **Terminal** — the real `TerminalPane` for that agent's session, mounted the
 *   same way an agent room mounts it. Safe because the ambient shell is not
 *   mounted in stream mode; two live mounts of one session would attach xterm
 *   twice.
 * - **Files** and **Preview** — the editor and preview panels as they already
 *   are. Both are project-scoped today, which the sheet says out loud rather
 *   than implying they are showing the agent's copy. Per-worktree preview is
 *   real work in the proxy layer and is not pretended at here.
 */
import { Suspense, lazy, useEffect, useState } from 'react';
import HunkDiffView from '$lib/components/review/HunkDiffView.tsx';
import FileIcon from '$lib/components/explorer/FileIcon.tsx';
import TerminalPane from '$lib/components/terminal/TerminalPane.tsx';
import { AgentBrandMark } from '$lib/components/shared/useAgentBrand.tsx';
import { useStore } from '$lib/react/useStore';
import { paneAssignments, setActiveSession, killSession, activeSessionId } from '$lib/stores/terminal';
// Already a lazy boundary of its own — wrapping it in another `lazy` would just
// add a chunk the bundler then declines to split.
import PreviewPanel from '$lib/components/preview/PreviewPanelLazy.tsx';
import type { DiffStat, FleetRow } from '$lib/components/orchestrator/useFleetRows';
import './StreamSheet.css';

const EditorPanel = lazy(() => import('$lib/components/editor/EditorPanel.tsx'));

export type SheetTab = 'changes' | 'preview' | 'terminal' | 'files';

const TAB_LABEL: Record<SheetTab, string> = {
  changes: 'Changes',
  preview: 'Preview',
  terminal: 'Terminal',
  files: 'Files',
};

export default function StreamSheet({
  row,
  stat,
  tab,
  onTab,
  onClose,
}: {
  row: FleetRow | null;
  stat: DiffStat | undefined;
  tab: SheetTab;
  onTab: (tab: SheetTab) => void;
  onClose: () => void;
}) {
  const assignments = useStore(paneAssignments);
  const currentSessionId = useStore(activeSessionId);
  const [openFile, setOpenFile] = useState<string | null>(null);

  const open = row !== null;

  // Esc closes. Registered only while open so it can't swallow the key from the
  // palette or the composer when the sheet is not showing.
  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.stopPropagation();
        onClose();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onClose]);

  // A new agent starts on its own first file, not on whatever the last one had
  // expanded.
  useEffect(() => {
    setOpenFile(null);
  }, [row?.key]);

  const files = stat?.files ?? [];

  return (
    <>
      <div
        className={`stsheet-scrim${open ? ' open' : ''}`}
        onClick={onClose}
        aria-hidden="true"
      />
      <aside
        className={`stsheet${open ? ' open' : ''}`}
        aria-hidden={!open}
        // Kept in the tree while closed so the slide-out is animated rather than
        // a disappearance, but inert so its controls stay out of the tab order.
        inert={!open}
        aria-label={row ? `${row.agentName} — details` : 'Agent details'}
      >
        {row && (
          <>
            <header className="stsheet-head">
              <span className="stsheet-mark">
                <AgentBrandMark command={row.agentPreset} name={row.agentName} />
              </span>
              <span className="stsheet-title">
                {row.agentName}
                <small>
                  {row.worktree
                    ? `its own safe copy · ${row.worktree.branch}`
                    : 'working directly in your project folder'}
                </small>
              </span>
              <button className="stsheet-close" onClick={onClose}>
                Close <kbd>Esc</kbd>
              </button>
            </header>

            <nav className="stsheet-tabs" role="tablist">
              {(Object.keys(TAB_LABEL) as SheetTab[]).map((id) => (
                <button
                  key={id}
                  role="tab"
                  aria-selected={tab === id}
                  className={tab === id ? 'on' : ''}
                  onClick={() => onTab(id)}
                  disabled={id === 'terminal' && row.sessionId === null}
                  title={
                    id === 'terminal' && row.sessionId === null
                      ? 'This agent has no terminal open any more'
                      : undefined
                  }
                >
                  {TAB_LABEL[id]}
                  {id === 'changes' && files.length > 0 && (
                    <span className="stsheet-tabcount">{files.length}</span>
                  )}
                </button>
              ))}
            </nav>

            <div className="stsheet-body">
              {tab === 'changes' && (
                <div className="stsheet-changes">
                  {row.placement === 'main' && (
                    /* Stated plainly: a main-repo agent shares your working tree,
                       so these numbers are the checkout's, not this one agent's. */
                    <p className="stsheet-note">
                      This agent works in your project folder, so what you see here is
                      everything uncommitted in it — shared with you and with any other
                      agent doing the same.
                    </p>
                  )}
                  {files.length === 0 ? (
                    <p className="stsheet-empty">Nothing has changed yet.</p>
                  ) : (
                    files.map((file) => {
                      const isOpen = openFile === file.path;
                      return (
                        <div className="stsheet-file" key={file.path}>
                          <button
                            className="stsheet-file-row"
                            onClick={() => setOpenFile(isOpen ? null : file.path)}
                            aria-expanded={isOpen}
                          >
                            <FileIcon name={file.path.split('/').pop() || ''} isDir={false} />
                            <span className="stsheet-file-path">{file.path}</span>
                            <span className="stsheet-file-stat">
                              <span className="add">+{file.additions}</span>
                              <span className="del">&minus;{file.deletions}</span>
                            </span>
                          </button>
                          {isOpen && stat && (
                            <div className="stsheet-file-diff">
                              {/* The agent's repo, measured against the base the
                                  stat used — a main-repo row asks for HEAD without
                                  knowing its sha, and the two views must agree. */}
                              <HunkDiffView
                                projectId={row.projectId}
                                repoPath={row.repoPath}
                                filePath={file.path}
                                side="unstaged"
                                baseRef={stat.base_commit}
                              />
                            </div>
                          )}
                        </div>
                      );
                    })
                  )}
                </div>
              )}

              {tab === 'terminal' && row.sessionId !== null && (
                <div className="stsheet-terminal">
                  <TerminalPane
                    sessionId={row.sessionId}
                    paneIndex={assignments.indexOf(row.sessionId)}
                    isActive={currentSessionId === row.sessionId}
                    onActivate={() => setActiveSession(row.sessionId!)}
                    onClose={() => void killSession(row.sessionId!)}
                  />
                </div>
              )}

              {tab === 'files' && (
                <Suspense fallback={<p className="stsheet-empty">Opening the editor…</p>}>
                  <div className="stsheet-panel">
                    <EditorPanel />
                  </div>
                </Suspense>
              )}

              {tab === 'preview' && (
                <Suspense fallback={<p className="stsheet-empty">Starting the preview…</p>}>
                  <div className="stsheet-panel">
                    {row.worktree && (
                      /* Honest about a real limitation: the preview proxy is
                         per-project, so this runs your checkout, not this
                         agent's branch. Saying so beats implying otherwise. */
                      <p className="stsheet-note">
                        This runs your project, not {row.agentName}'s copy. Bring its
                        changes in first if you want to see them here.
                      </p>
                    )}
                    <PreviewPanel />
                  </div>
                </Suspense>
              )}
            </div>
          </>
        )}
      </aside>
    </>
  );
}
