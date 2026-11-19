import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { useStore } from '$lib/react/useStore';
import { showToast } from '$lib/stores/notification';
import { createTerminalSession, type TerminalSessionInfo } from '$lib/stores/terminal';
import type { ChatThread } from '$lib/types/chat';
import {
  activeWorktreeByProject,
  mainWorktreeRow,
  openCreateWorktree,
  refreshProjectWorktrees,
  setActiveWorktree,
  worktreesByProject,
} from '$lib/stores/projectWorktrees';
import {
  deleteProjectWorktree,
  isPathInside,
  orderWorktreeTree,
  updateProjectWorktree,
  worktreeForPath,
  type ProjectWorktree,
} from '$lib/services/project-worktrees';

/**
 * The worktree rows under a project, Orca-style: the main checkout (🏠) first,
 * then every worktree the user created, children nested under their parent.
 * Selecting a row makes it where new agents, terminals and chat threads start;
 * each row counts the agents working in it.
 */

function samePath(a: string | null | undefined, b: string | null | undefined): boolean {
  return Boolean(a && b) && isPathInside(a, b!) && isPathInside(b, a!);
}

function relativeAge(ms: number | null): string | null {
  if (!ms) return null;
  const minutes = Math.max(0, Math.round((Date.now() - ms) / 60000));
  if (minutes < 1) return 'now';
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h`;
  return `${Math.round(hours / 24)}d`;
}

export default function ProjectWorktreeList({
  projectId,
  rootPath,
  sessions,
  threads,
  renderChildren,
  onNewItem,
  newItemLabel = 'New agent here',
  renderNewItem,
}: {
  projectId: string;
  /** The project root: a project git cannot list still shows its master row. */
  rootPath?: string | null;
  sessions: TerminalSessionInfo[];
  threads: ChatThread[];
  /** What is working inside each worktree (agents, terminals, threads),
   *  drawn under its row. */
  renderChildren?: (worktree: ProjectWorktree) => ReactNode;
  /** Start new work in a worktree, from the row's + button. */
  onNewItem?: (worktree: ProjectWorktree) => void;
  newItemLabel?: string;
  /** Replaces the row's + button with a control of the caller's (the agent
   *  launcher, aimed at this worktree). */
  renderNewItem?: (worktree: ProjectWorktree) => ReactNode;
}) {
  const all = useStore(worktreesByProject);
  const active = useStore(activeWorktreeByProject);
  // Master is there from the start: before git answers, and for a project git
  // cannot list at all.
  const loaded = all[projectId];
  const worktrees = useMemo(
    () => (loaded && loaded.length > 0 ? loaded : rootPath ? [mainWorktreeRow(rootPath)] : loaded),
    [loaded, rootPath],
  );
  const [menuPath, setMenuPath] = useState<string | null>(null);
  const [renamingPath, setRenamingPath] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState('');
  const [busyPath, setBusyPath] = useState<string | null>(null);
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const menuRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    void refreshProjectWorktrees(projectId, rootPath);
    // Worktrees can be added or removed from a terminal; re-read when the
    // window regains focus rather than polling.
    const onFocus = () => void refreshProjectWorktrees(projectId, rootPath);
    window.addEventListener('focus', onFocus);
    return () => window.removeEventListener('focus', onFocus);
  }, [projectId, rootPath]);

  useEffect(() => {
    if (!menuPath) return;
    const onDown = (event: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(event.target as Node)) setMenuPath(null);
    };
    window.addEventListener('mousedown', onDown);
    return () => window.removeEventListener('mousedown', onDown);
  }, [menuPath]);

  const activePath = active[projectId] ?? null;

  // Who is working where: each running session and chat thread is counted
  // once, in the deepest worktree that contains its folder.
  const agentsByWorktree = useMemo(() => {
    const counts = new Map<string, { agents: number; working: boolean }>();
    if (!worktrees) return counts;
    const bump = (path: string | null | undefined, working: boolean) => {
      const owner = worktreeForPath(worktrees, path);
      if (!owner) return;
      const entry = counts.get(owner.path) ?? { agents: 0, working: false };
      entry.agents += 1;
      entry.working ||= working;
      counts.set(owner.path, entry);
    };
    for (const session of sessions) {
      if (!session.agentPreset) continue;
      bump(session.worktree?.path ?? session.cwd, Boolean(session.isExecuting));
    }
    for (const thread of threads) {
      if (thread.archived || !thread.worktree?.shared) continue;
      bump(thread.worktree.path, thread.status === 'working');
    }
    return counts;
  }, [worktrees, sessions, threads]);

  if (!worktrees || worktrees.length === 0) return null;

  const rows = orderWorktreeTree(worktrees);
  const childCount = new Map<string, number>();
  for (const { worktree } of rows) {
    if (worktree.parent) childCount.set(worktree.parent.toLowerCase(), (childCount.get(worktree.parent.toLowerCase()) ?? 0) + 1);
  }
  // Hide rows whose ancestor is collapsed.
  const hiddenUnder = (w: ProjectWorktree): boolean => {
    let parent = w.parent;
    const seen = new Set<string>();
    while (parent && !seen.has(parent)) {
      seen.add(parent);
      if (collapsed.has(parent.toLowerCase())) return true;
      parent = worktrees.find((x) => samePath(x.path, parent))?.parent ?? null;
    }
    return false;
  };

  async function remove(worktree: ProjectWorktree) {
    setMenuPath(null);
    const using = agentsByWorktree.get(worktree.path)?.agents ?? 0;
    const warning = using > 0 ? `\n\n${using} agent${using === 1 ? ' is' : 's are'} still working in it.` : '';
    if (!window.confirm(`Delete worktree “${worktree.name}”?${warning}\n\nIts branch is kept if it has unmerged commits.`)) return;
    setBusyPath(worktree.path);
    try {
      let result = await deleteProjectWorktree(projectId, worktree.path, false);
      if (!result.ok && result.dirty) {
        if (!window.confirm(`“${worktree.name}” has uncommitted changes. Delete it anyway and discard them?`)) return;
        result = await deleteProjectWorktree(projectId, worktree.path, true);
      }
      if (!result.ok) {
        showToast(result.error, 'error', 6000);
        return;
      }
      if (samePath(activePath, worktree.path)) setActiveWorktree(projectId, null);
      showToast(
        result.preservedBranch
          ? `Deleted worktree ${worktree.name}. Kept branch ${result.preservedBranch} because it has unmerged commits.`
          : `Deleted worktree ${worktree.name}.`,
        'success',
        4000,
      );
    } finally {
      setBusyPath(null);
      void refreshProjectWorktrees(projectId);
    }
  }

  async function saveRename(worktree: ProjectWorktree) {
    const value = renameValue.trim();
    setRenamingPath(null);
    if (!value || value === worktree.name) return;
    try {
      await updateProjectWorktree({ projectId, worktreePath: worktree.path, name: value });
    } catch (failure) {
      showToast(failure instanceof Error ? failure.message : String(failure), 'error');
    }
    void refreshProjectWorktrees(projectId);
  }

  async function copyPath(path: string) {
    setMenuPath(null);
    try {
      await navigator.clipboard.writeText(path);
      showToast('Path copied', 'success', 1500);
    } catch {
      showToast('Could not copy the path', 'error');
    }
  }

  return (
    <div className="project-contents-section project-worktrees-section">
      <div className="project-contents-label project-threads-label">
        <span>Worktrees</span>
        <button
          type="button"
          className="project-new-thread-btn"
          onClick={() => openCreateWorktree(projectId)}
          title="Create worktree"
          aria-label="Create worktree"
        >
          <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round">
            <line x1="12" y1="5" x2="12" y2="19" />
            <line x1="5" y1="12" x2="19" y2="12" />
          </svg>
        </button>
      </div>
      <div className="project-worktree-list" role="list">
        {rows.map(({ worktree, depth }) => {
          if (hiddenUnder(worktree)) return null;
          const isActive = worktree.is_main ? !activePath : samePath(activePath, worktree.path);
          const usage = agentsByWorktree.get(worktree.path);
          const kids = childCount.get(worktree.path.toLowerCase()) ?? 0;
          const isCollapsed = collapsed.has(worktree.path.toLowerCase());
          const children = renderChildren ? renderChildren(worktree) : null;
          const hasContents = children != null && children !== false;
          const contents = isCollapsed ? null : children;
          const label = worktree.is_main ? worktree.branch ?? worktree.name : worktree.name;
          const branchDetail = !worktree.is_main && worktree.branch && worktree.branch !== worktree.name ? worktree.branch : null;
          const age = worktree.is_main ? null : relativeAge(worktree.created_at);
          const title = [
            worktree.is_main ? 'Primary worktree (original clone directory)' : worktree.name,
            worktree.branch ? `Branch: ${worktree.branch}` : worktree.head ? 'Detached HEAD' : null,
            worktree.base_ref ? `From: ${worktree.base_ref}` : null,
            worktree.note,
            worktree.missing ? 'The folder is missing.' : null,
            worktree.path,
          ].filter(Boolean).join('\n');
          return (
            <div key={worktree.path} role="listitem" className="project-worktree-group" style={{ paddingLeft: depth * 14 }}>
            <div className={`project-worktree-row-wrap${isActive ? ' active' : ''}${worktree.missing ? ' missing' : ''}`}>
              {renamingPath === worktree.path ? (
                <input
                  className="project-worktree-rename"
                  value={renameValue}
                  autoFocus
                  aria-label={`Rename ${worktree.name}`}
                  onChange={(e) => setRenameValue(e.target.value)}
                  onBlur={() => void saveRename(worktree)}
                  onKeyDown={(e) => {
                    e.stopPropagation();
                    if (e.key === 'Enter') e.currentTarget.blur();
                    if (e.key === 'Escape') setRenamingPath(null);
                  }}
                />
              ) : (
                <button
                  type="button"
                  className="project-worktree-row"
                  onClick={() => !worktree.missing && setActiveWorktree(projectId, worktree.is_main ? null : worktree.path)}
                  disabled={busyPath === worktree.path}
                  title={title}
                  aria-current={isActive ? 'true' : undefined}
                >
                  {kids > 0 || hasContents ? (
                    <span
                      className={`project-worktree-twisty${isCollapsed ? '' : ' open'}`}
                      role="button"
                      aria-label={isCollapsed ? `Show what is in ${worktree.name}` : `Hide what is in ${worktree.name}`}
                      onClick={(e) => {
                        e.stopPropagation();
                        setCollapsed((prev) => {
                          const next = new Set(prev);
                          const key = worktree.path.toLowerCase();
                          if (next.has(key)) next.delete(key);
                          else next.add(key);
                          return next;
                        });
                      }}
                    >
                      <svg width="8" height="8" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round"><polyline points="9 6 15 12 9 18" /></svg>
                    </span>
                  ) : null}
                  <span className="project-worktree-icon" aria-hidden="true">
                    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                      <circle cx="6" cy="6" r="2.5" /><circle cx="6" cy="18" r="2.5" /><circle cx="18" cy="8" r="2.5" />
                      <path d="M6 8.5v7M18 10.5c0 4-6 3-11 5.5" />
                    </svg>
                  </span>
                  <span className="project-worktree-name">{label}</span>
                  {worktree.is_main && (
                    <span className="project-worktree-home" title="Primary worktree" aria-label="Primary worktree">
                      <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                        <path d="M3 10.5 12 3l9 7.5V20a1 1 0 0 1-1 1h-5v-6H9v6H4a1 1 0 0 1-1-1z" />
                      </svg>
                    </span>
                  )}
                  {branchDetail && <span className="project-worktree-branch">{branchDetail}</span>}
                  <span className="project-worktree-meta">
                    {usage && usage.agents > 0 && (
                      <span
                        className={`project-worktree-agents${usage.working ? ' working' : ''}`}
                        title={`${usage.agents} agent${usage.agents === 1 ? '' : 's'}${usage.working ? ', working' : ''}`}
                      >
                        <span className="project-worktree-dot" aria-hidden="true" />
                        {usage.agents}
                      </span>
                    )}
                    {worktree.missing ? <span className="project-worktree-missing">missing</span> : age && <span>{age}</span>}
                  </span>
                </button>
              )}
              <div className="project-worktree-actions" ref={menuPath === worktree.path ? menuRef : undefined}>
                {renderNewItem && !worktree.missing ? renderNewItem(worktree) : onNewItem && !worktree.missing && (
                  <button
                    type="button"
                    className="project-thread-action-btn"
                    onClick={() => onNewItem(worktree)}
                    aria-label={`${newItemLabel}: ${worktree.name}`}
                    title={newItemLabel}
                  >
                    <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" aria-hidden="true">
                      <line x1="12" y1="5" x2="12" y2="19" />
                      <line x1="5" y1="12" x2="19" y2="12" />
                    </svg>
                  </button>
                )}
                <button
                  type="button"
                  className="project-thread-action-btn"
                  onClick={() => setMenuPath(menuPath === worktree.path ? null : worktree.path)}
                  aria-label={`Actions for ${worktree.name}`}
                  aria-expanded={menuPath === worktree.path}
                  title="Worktree actions"
                >
                  <svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
                    <circle cx="5" cy="12" r="2" /><circle cx="12" cy="12" r="2" /><circle cx="19" cy="12" r="2" />
                  </svg>
                </button>
                {menuPath === worktree.path && (
                  <div className="project-thread-action-menu project-worktree-menu" role="menu">
                    {!worktree.missing && (
                      <button
                        type="button"
                        role="menuitem"
                       
                        onClick={() => {
                          setMenuPath(null);
                          void createTerminalSession(worktree.path, undefined, projectId);
                        }}
                      >
                        New terminal here
                      </button>
                    )}
                    <button type="button" role="menuitem" onClick={() => void copyPath(worktree.path)}>
                      Copy path
                    </button>
                    {!worktree.is_main && !worktree.missing && (
                      <button
                        type="button"
                        role="menuitem"
                       
                        onClick={() => {
                          setMenuPath(null);
                          openCreateWorktree(projectId, worktree.path);
                        }}
                      >
                        New child worktree
                      </button>
                    )}
                    {!worktree.is_main && !worktree.missing && (
                      <button
                        type="button"
                        role="menuitem"
                       
                        onClick={() => {
                          setMenuPath(null);
                          setRenameValue(worktree.name);
                          setRenamingPath(worktree.path);
                        }}
                      >
                        Rename
                      </button>
                    )}
                    {!worktree.is_main && (
                      <button
                        type="button"
                        role="menuitem"
                        className="danger"
                        onClick={() => void remove(worktree)}
                      >
                        Delete worktree
                      </button>
                    )}
                  </div>
                )}
              </div>
            </div>
            {contents && <div className="project-worktree-children">{contents}</div>}
            </div>
          );
        })}
      </div>
    </div>
  );
}
