import { useState, useMemo, useRef, useEffect } from 'react';
import { createPortal } from 'react-dom';
import { useStore } from '$lib/react/useStore';
import { useModalFocus } from '$lib/react/useModalFocus';
import { get } from '$lib/stores/storeCompat';
import {
  globalWorkspaceCleanupRule,
  type WorkspaceCleanupRule,
} from '$lib/stores/settings';
import { activeProjectId, projects, recentWorkspaces, openWorkspace, switchToProject } from '$lib/stores/workspace';
import { activeWorktreeByProject, refreshProjectWorktrees, setActiveWorktree } from '$lib/stores/projectWorktrees';
import { allProjectSessions, devProjectTerminalStates } from '$lib/stores/terminal';
import { fileCache } from '$lib/stores/editor';
import { chatThreadState } from '$lib/stores/chatThreads';
import {
  deleteProjectWorktree, getWorktreeReviewMetadata, isPathInside, listProjectWorktrees,
  type ProjectWorktree, type WorktreeReviewMetadata,
} from '$lib/services/project-worktrees';
import { activeRemoteId, hostLabel, remoteTarget } from '$lib/stores/remoteWorkspace';
import { clearDeepSeekPlacement } from '$lib/services/deepseek-harness';
import { normalizeProjectPath } from '$lib/components/workspace/projectListPrefs';
import { cleanupStaleWorktrees, sweepAgentBranchesForProject, sweepOrphanWorktrees } from '$lib/stores/orchestrator';
import { pruneWorktrees } from '$lib/services/orchestrator/worktree-manager';
import { showToast } from '$lib/stores/notification';
import { allProjectSettings, projectConfigFor, projectIconFor } from '$lib/stores/projectSettings';
import { ProjectIconBadge } from './ProjectIcons';
import Dropdown from './Dropdown';
import './WorkspaceCleanupSection.css';

interface CleanupActivityItem {
  id: string;
  time: string;
  type: string;
  result: string;
}

interface CleanupWorkspace {
  id: string;
  name: string;
  path: string;
  projectId?: string;
  workspaceId?: string;
  projectName: string;
  projectIcon: string;
  worktree?: ProjectWorktree;
  lastOpened?: number;
}

function folderSize(metadata: WorktreeReviewMetadata | null | undefined): string {
  if (metadata === undefined) return '…';
  if (metadata === null) return '—';
  let size = metadata.size_bytes;
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let unit = 0;
  while (size >= 1024 && unit < units.length - 1) {
    size /= 1024;
    unit++;
  }
  return `${metadata.size_partial ? '≥ ' : ''}${size.toLocaleString(undefined, { maximumFractionDigits: unit === 0 ? 0 : 1 })} ${units[unit]}`;
}

function activityLabel(timestamp: number): string {
  if (!timestamp) return '—';
  const age = Math.max(0, Date.now() - timestamp);
  const minutes = Math.floor(age / 60_000);
  if (minutes === 0) return 'Just now';
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  return hours < 48 ? `${hours}h ago` : `${Math.floor(hours / 24)}d ago`;
}

const IGNORED_WORKSPACES_KEY = 'spacron.workspaceCleanup.ignored.v1';

function loadIgnoredWorkspaces(): Record<string, string> {
  try {
    const saved = JSON.parse(localStorage.getItem(IGNORED_WORKSPACES_KEY) ?? '{}');
    if (saved && typeof saved === 'object' && !Array.isArray(saved)) {
      return Object.fromEntries(Object.entries(saved).filter((entry): entry is [string, string] => typeof entry[1] === 'string'));
    }
  } catch {
    // The current review still works without local storage.
  }
  return {};
}

function ReviewIcon({ name }: { name: 'refresh' | 'close' | 'filter' | 'open' | 'hide' | 'restore' | 'details' }) {
  const paths = {
    refresh: 'M20 5v5h-5M5 19v-5h5M5.7 8a7 7 0 0 1 11.5-3L20 8M4 16l2.8 3A7 7 0 0 0 18.3 16',
    close: 'm6 6 12 12M18 6 6 18',
    filter: 'M4 7h16M4 12h16M4 17h16M8 5v4m8 1v4m-5 1v4',
    open: 'M13 5h6v6m0-6-8 8m-2-7H5v13h13v-4',
    hide: 'M3 3l18 18M10 5a11 11 0 0 1 12 7 13 13 0 0 1-3 3.7M6 6.5A13 13 0 0 0 2 12s4 7 10 7a9 9 0 0 0 4-.9',
    restore: 'M2 12s4-7 10-7 10 7 10 7-4 7-10 7S2 12 2 12Zm13 0a3 3 0 1 0-6 0 3 3 0 0 0 6 0Z',
    details: 'm6 9 6 6 6-6',
  };
  return <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d={paths[name]} /></svg>;
}

function workspaceProtection(row: CleanupWorkspace): string | null {
  if (!row.worktree || row.worktree.is_main) return 'Main workspace';
  if (row.worktree.missing) return 'Workspace folder missing';
  if (!row.worktree.branch) return 'Detached HEAD';
  const activePath = row.projectId ? get(activeWorktreeByProject)[row.projectId] : null;
  if (activePath && normalizeProjectPath(activePath) === row.id) return 'Active workspace';
  const inUse = [...get(allProjectSessions), ...Array.from(get(devProjectTerminalStates).values()).flatMap((state) => state.sessions)];
  if (inUse.some((session) => (session.isRunning || session.isExecuting) && isPathInside(session.worktree?.path ?? session.cwd, row.path))) {
    return 'Running agent or terminal';
  }
  if (row.projectId && get(chatThreadState).threadsByProject[row.projectId]?.some((thread) =>
    thread.status === 'working' && isPathInside(thread.worktree?.path, row.path)
  )) return 'Running chat';
  if (Array.from(get(fileCache).values()).some((file) => file.isDirty && isPathInside(file.path, row.path))) {
    return 'Unsaved editor changes';
  }
  return null;
}

export default function WorkspaceCleanupSection({ onCloseSettings }: { onCloseSettings: () => void }) {
  const allProjectsMap = useStore(projects);
  const rawWorkspaces = useStore(recentWorkspaces);
  const remote = useStore(remoteTarget);
  const remoteId = useStore(activeRemoteId);
  const globalRule = useStore(globalWorkspaceCleanupRule);

  const [deleteMerged, setDeleteMerged] = useState(
    globalRule === 'merged_only' || globalRule === 'merged_unchanged'
  );
  const [deleteUnchanged, setDeleteUnchanged] = useState(
    globalRule === 'merged_unchanged'
  );
  const [deleteInactive, setDeleteInactive] = useState(false);
  const [inactiveDays, setInactiveDays] = useState('30');
  const [deleteAutomationWorkspaces, setDeleteAutomationWorkspaces] = useState(false);
  const [deleteOrchestrationWorkspaces, setDeleteOrchestrationWorkspaces] = useState(false);
  const [keepIgnoredFiles, setKeepIgnoredFiles] = useState(true);
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const [isRunningRules, setIsRunningRules] = useState(false);
  const [reviewModalOpen, setReviewModalOpen] = useState(false);
  const [selectedWorkspaces, setSelectedWorkspaces] = useState<Set<string>>(new Set());
  const [modalSearch, setModalSearch] = useState('');

  const allConfigs = useStore(allProjectSettings);

  const [activities, setActivities] = useState<CleanupActivityItem[]>([
    {
      id: '1',
      time: 'Today, 12:47 PM',
      type: 'Hourly',
      result: 'Nothing to clean, 0 kept',
    },
  ]);

  const openProjects = useMemo(() => Array.from(allProjectsMap.values()), [allProjectsMap]);

  const [listedWorktrees, setListedWorktrees] = useState<Record<string, ProjectWorktree[]>>({});
  const [refreshing, setRefreshing] = useState(false);
  const [updatedAt, setUpdatedAt] = useState<number | null>(null);
  const [refreshFailures, setRefreshFailures] = useState<string[]>([]);
  const [expanded, setExpanded] = useState<string | null>(null);
  const [ignoredWorkspaces, setIgnoredWorkspaces] = useState(loadIgnoredWorkspaces);
  const [ascending, setAscending] = useState(true);
  const [sortBy, setSortBy] = useState('activity');
  const [selectableOnly, setSelectableOnly] = useState(false);
  const [reviewMetadata, setReviewMetadata] = useState<Record<string, WorktreeReviewMetadata | null>>({});
  const [deleting, setDeleting] = useState(false);
  const reviewButton = useRef<HTMLButtonElement>(null);
  const reviewRequest = useRef(0);
  const reviewDialog = useRef<HTMLDivElement>(null);
  const searchInput = useRef<HTMLInputElement>(null);
  useModalFocus(reviewDialog, undefined, reviewModalOpen);
  useEffect(() => {
    if (reviewModalOpen) searchInput.current?.focus();
  }, [reviewModalOpen]);
  useEffect(() => () => { reviewRequest.current++; }, []);

  // Keep eligibility in sync while the dialog is open.
  const worktreeSelection = useStore(activeWorktreeByProject);
  const liveSessions = useStore(allProjectSessions);
  useStore(devProjectTerminalStates);
  useStore(chatThreadState);
  useStore(fileCache);
  const currentProjectId = useStore(activeProjectId);

  const workspaceItems = useMemo(() => {
    const rows = new Map<string, CleanupWorkspace>();
    for (const p of openProjects) {
      const projectName = projectConfigFor(allConfigs, p.root_path, p.id).displayName || p.name;
      const projectIcon = projectIconFor(allConfigs, p.root_path, p.id);
      const worktrees = listedWorktrees[p.id] ?? [];
      const root = normalizeProjectPath(p.root_path);
      const main = worktrees.find((tree) => tree.is_main);
      rows.set(root, { id: root, name: main?.branch ?? p.name, projectId: p.id, projectName, projectIcon, path: p.root_path, worktree: main });
      for (const tree of worktrees) {
        if (tree.is_main) continue;
        const id = normalizeProjectPath(tree.path);
        rows.set(id, { id, name: tree.name, path: tree.path, projectId: p.id, projectName, projectIcon, worktree: tree });
      }
    }
    for (const ws of rawWorkspaces) {
      const paths = new Set([...(ws.project_paths ?? []), ws.active_project_path].filter((path): path is string => Boolean(path)));
      for (const path of paths) {
        const id = normalizeProjectPath(path);
        const lastOpened = Number(ws.last_opened) || Date.parse(ws.last_opened) || 0;
        const row = rows.get(id);
        if (row) {
          row.lastOpened = Math.max(row.lastOpened ?? 0, lastOpened);
          continue;
        }
        const name = path.replace(/\\/g, '/').split('/').filter(Boolean).pop() || ws.name;
        rows.set(id, { id, name, workspaceId: ws.id, path, lastOpened, projectName: projectConfigFor(allConfigs, path).displayName || name, projectIcon: projectIconFor(allConfigs, path) });
      }
    }
    return [...rows.values()];
  }, [openProjects, rawWorkspaces, allConfigs, listedWorktrees]);

  const query = modalSearch.trim().toLowerCase();
  const hostFor = (ws: CleanupWorkspace) => remote && ws.projectId ? hostLabel(remote.url) : 'Local';
  const activityFor = (ws: CleanupWorkspace) => Math.max(ws.lastOpened ?? 0, reviewMetadata[ws.id]?.modified_at ?? 0, ws.worktree?.created_at ?? 0);
  const ignoreKey = (ws: CleanupWorkspace) => JSON.stringify([ws.projectId && remote ? remoteId : null, ws.id]);
  const reviewFingerprint = (ws: CleanupWorkspace) => JSON.stringify([
    ws.worktree?.branch ?? reviewMetadata[ws.id]?.branch ?? null,
    ws.worktree?.head ?? null,
    reviewMetadata[ws.id]?.git_state ?? null,
    Math.floor(activityFor(ws) / 86_400_000),
  ]);
  const isIgnored = (ws: CleanupWorkspace) => Boolean(ignoredWorkspaces[ignoreKey(ws)]) && (
    (reviewMetadata[ws.id] == null && !ws.worktree?.missing)
    || ignoredWorkspaces[ignoreKey(ws)] === reviewFingerprint(ws)
  );
  const protectionFor = (ws: CleanupWorkspace) => (isIgnored(ws) ? 'Ignored' : workspaceProtection(ws))
    ?? (reviewMetadata[ws.id] === undefined ? 'Checking Git status'
      : reviewMetadata[ws.id]?.git_state === 'Clean' ? null
        : reviewMetadata[ws.id]?.git_state ?? 'Git status unavailable');
  const filteredWorkspaces = workspaceItems
    .filter((ws) => (!selectableOnly || !protectionFor(ws)) && [ws.name, ws.projectName, ws.worktree?.branch, reviewMetadata[ws.id]?.branch, ws.path, hostFor(ws)]
      .some((value) => value?.toLowerCase().includes(query)))
    .sort((a, b) => {
      const primary = sortBy === 'activity' ? activityFor(a) - activityFor(b)
        : sortBy === 'size' ? (reviewMetadata[a.id]?.size_bytes ?? -1) - (reviewMetadata[b.id]?.size_bytes ?? -1) : 0;
      return (ascending ? 1 : -1) * (primary || a.name.localeCompare(b.name) || a.path.localeCompare(b.path));
    });
  const selectable = filteredWorkspaces.filter((ws) => !protectionFor(ws));
  const selection = workspaceItems.filter((ws) => selectedWorkspaces.has(ws.id) && !protectionFor(ws));
  const allSelected = selectable.length > 0 && selectable.every((ws) => selectedWorkspaces.has(ws.id));

  function toggleIgnored(ws: CleanupWorkspace) {
    const key = ignoreKey(ws);
    const next = { ...ignoredWorkspaces };
    if (isIgnored(ws)) {
      delete next[key];
    } else {
      next[key] = reviewFingerprint(ws);
    }
    try {
      localStorage.setItem(IGNORED_WORKSPACES_KEY, JSON.stringify(next));
    } catch {
      // Keep the choice for this session.
    }
    setIgnoredWorkspaces(next);
    setSelectedWorkspaces((previous) => {
      const selection = new Set(previous);
      selection.delete(ws.id);
      return selection;
    });
  }

  async function refreshReview() {
    const request = ++reviewRequest.current;
    setRefreshing(true);
    setReviewMetadata({});
    const results = await Promise.allSettled(openProjects.map((project) => listProjectWorktrees(project.id)));
    if (request !== reviewRequest.current) return;
    const next: Record<string, ProjectWorktree[]> = {};
    const failed: string[] = [];
    results.forEach((result, index) => {
      const project = openProjects[index];
      if (result.status === 'fulfilled') next[project.id] = result.value;
      else if (!String(result.reason).includes('This project is not a Git repository.')) failed.push(project.name);
    });
    setListedWorktrees(next);
    setRefreshFailures(failed);
    setUpdatedAt(Date.now());
    setRefreshing(false);

    const targets = new Map<string, { projectId: string; worktreePath?: string }>();
    for (const project of openProjects) {
      targets.set(normalizeProjectPath(project.root_path), { projectId: project.id });
      for (const tree of next[project.id] ?? []) {
        if (!tree.is_main && !tree.missing) {
          targets.set(normalizeProjectPath(tree.path), { projectId: project.id, worktreePath: tree.path });
        }
      }
    }
    const remote = get(remoteTarget);
    for (const workspace of rawWorkspaces) {
      for (const path of [...(workspace.project_paths ?? []), workspace.active_project_path]) {
        if (!path || targets.has(normalizeProjectPath(path))) continue;
        if (!remote) targets.set(normalizeProjectPath(path), { projectId: path });
        else setReviewMetadata((previous) => ({ ...previous, [normalizeProjectPath(path)]: null }));
      }
    }
    const pending = targets.entries();
    await Promise.all(Array.from({ length: Math.min(3, targets.size) }, async () => {
      for (const [key, target] of pending) {
        if (request !== reviewRequest.current) return;
        const metadata = await getWorktreeReviewMetadata(target.projectId, target.worktreePath).catch(() => null);
        if (request !== reviewRequest.current) return;
        setReviewMetadata((previous) => ({ ...previous, [key]: metadata }));
      }
    }));
  }

  function dismissReview() {
    if (deleting) return;
    reviewRequest.current++;
    setReviewModalOpen(false);
    queueMicrotask(() => reviewButton.current?.focus());
  }

  async function openReviewedWorkspace(row: CleanupWorkspace) {
    try {
      if (row.projectId) {
        if (!get(projects).has(row.projectId)) throw new Error('Project is no longer open');
        if (get(activeProjectId) !== row.projectId) switchToProject(row.projectId);
        setActiveWorktree(row.projectId, row.worktree && !row.worktree.is_main ? row.path : null);
      } else if (row.workspaceId) {
        await openWorkspace(row.workspaceId);
        const project = [...get(projects).values()].find((entry) => normalizeProjectPath(entry.root_path) === row.id);
        if (!project) throw new Error('Project could not be loaded');
        if (get(activeProjectId) !== project.id) switchToProject(project.id);
      }
      dismissReview();
      onCloseSettings();
    } catch (error) {
      showToast(`Could not open workspace: ${String(error)}`, 'error');
    }
  }

  async function deleteSelected() {
    if (deleting || refreshing || !selection.length) return;
    const names = selection.map((row) => row.path).join('\n');
    if (!window.confirm(`Delete these worktrees?\n\n${names}\n\nGit keeps branches it cannot safely delete.`)) return;
    setDeleting(true);
    const removed = new Set<string>();
    const keptBranches: string[] = [];
    try {
      for (const row of selection) {
        if (!row.projectId || !get(projects).has(row.projectId)) continue;
        const protection = protectionFor(row);
        if (protection) {
          showToast(`${row.name}: ${protection}`, 'warning');
          continue;
        }
        const result = await deleteProjectWorktree(row.projectId, row.path, false, true);
        if (!result.ok) {
          showToast(`${row.name}: ${result.error}`, 'error');
          continue;
        }
        removed.add(row.id);
        if (result.preservedBranch) keptBranches.push(result.preservedBranch);
        clearDeepSeekPlacement(row.projectId, row.path);
        void refreshProjectWorktrees(row.projectId);
      }
      setSelectedWorkspaces((previous) => new Set([...previous].filter((id) => !removed.has(id))));
      if (removed.size) showToast(
        `Deleted ${removed.size} worktree(s).${keptBranches.length ? ` Kept branches: ${keptBranches.join(', ')}` : ''}`,
        'success',
      );
      await refreshReview();
    } finally {
      setDeleting(false);
    }
  }

  async function handleRunRulesNow() {
    setIsRunningRules(true);
    try {
      let cleanedWorktrees = 0;
      let sweptBranches = 0;
      for (const p of openProjects) {
        try {
          const c1 = await cleanupStaleWorktrees(p.id);
          const c2 = await sweepOrphanWorktrees(p.id);
          const b = await sweepAgentBranchesForProject(p.id);
          await pruneWorktrees(p.id);
          cleanedWorktrees += c1 + c2;
          sweptBranches += b;
        } catch {
          // Continue with next project
        }
      }

      const resText =
        cleanedWorktrees > 0 || sweptBranches > 0
          ? `Cleaned ${cleanedWorktrees} worktrees, swept ${sweptBranches} branches`
          : 'Nothing to clean, 0 kept';

      const now = new Date();
      const timeStr = now.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

      setActivities((prev) => [
        {
          id: String(Date.now()),
          time: `Today, ${timeStr}`,
          type: 'Manual',
          result: resText,
        },
        ...prev.slice(0, 5),
      ]);

      showToast(`Cleanup run complete: ${resText}`, 'info');
    } catch (err) {
      showToast(`Error running cleanup rules: ${String(err)}`, 'error');
    } finally {
      setIsRunningRules(false);
    }
  }

  function handleRuleToggle(merged: boolean, unchanged: boolean) {
    let nextRule: WorkspaceCleanupRule = 'merged_unchanged';
    if (!merged && !unchanged) {
      nextRule = 'never';
    } else if (merged && !unchanged) {
      nextRule = 'merged_only';
    } else {
      nextRule = 'merged_unchanged';
    }
    globalWorkspaceCleanupRule.set(nextRule);
  }

  return (
    <div className="workspace-cleanup-page">
      {/* Section 1: Manual Cleanup Card */}
      <section className="settings-card">
        <h3>Manual cleanup</h3>
        <div className="settings-card-body">
          <div className="settings-control-row">
            <div className="settings-control-copy">
              <span>Delete workspaces you're done with</span>
              <small>Free up disk space and reduce clutter by removing workspaces you no longer need.</small>
            </div>
            <div className="settings-control">
              <button
                type="button"
                className="settings-secondary"
                ref={reviewButton}
                onClick={() => {
                  setSelectedWorkspaces(new Set());
                  setExpanded(null);
                  setModalSearch('');
                  setSelectableOnly(false);
                  setReviewModalOpen(true);
                  void refreshReview();
                }}
              >
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" style={{ marginRight: '6px' }}>
                  <line x1="8" y1="6" x2="21" y2="6" />
                  <line x1="8" y1="12" x2="21" y2="12" />
                  <line x1="8" y1="18" x2="21" y2="18" />
                  <line x1="3" y1="6" x2="3.01" y2="6" />
                  <line x1="3" y1="12" x2="3.01" y2="12" />
                  <line x1="3" y1="18" x2="3.01" y2="18" />
                </svg>
                Review workspaces…
              </button>
            </div>
          </div>
        </div>
      </section>

      {/* Section 2: Automatic Cleanup Card */}
      <section className="settings-card">
        <div className="cleanup-section-header-row">
          <div className="cleanup-header-left">
            <h3>Automatic cleanup</h3>
            <span className={`cleanup-status-pill ${deleteMerged || deleteUnchanged ? 'on' : 'off'}`}>
              <span className="cleanup-status-dot" />
              {deleteMerged || deleteUnchanged ? 'Active' : 'Inactive'}
            </span>
          </div>
          <button
            type="button"
            className="settings-secondary"
            onClick={() => void handleRunRulesNow()}
            disabled={isRunningRules}
          >
            {isRunningRules ? 'Running rules…' : 'Run rules now'}
          </button>
        </div>

        <div className="settings-card-body">
          <p className="shell-hint">
            Workspaces are cleaned automatically when Spacron starts, or run rules immediately.
          </p>
          {/* Rule 1: Delete merged */}
          <div className="settings-control-row">
            <div className="settings-control-copy">
              <div className="cleanup-heading-with-badge">
                <span>Delete merged workspaces</span>
                <span className="cleanup-recommended-badge">Recommended</span>
              </div>
              <small>Automatically delete workspaces whose branches have been merged into the default branch.</small>
            </div>
            <div className="settings-control">
              <button
                type="button"
                role="switch"
                aria-checked={deleteMerged}
                className={`settings-toggle ${deleteMerged ? 'active' : ''}`}
                onClick={() => {
                  const next = !deleteMerged;
                  setDeleteMerged(next);
                  handleRuleToggle(next, deleteUnchanged);
                }}
              >
                <span className="settings-toggle-thumb" />
              </button>
            </div>
          </div>

          {/* Rule 2: Delete unchanged */}
          <div className="settings-control-row">
            <div className="settings-control-copy">
              <span>Delete unchanged workspaces</span>
              <small>Delete workspaces that have no uncommitted changes and no unique commits.</small>
            </div>
            <div className="settings-control">
              <button
                type="button"
                role="switch"
                aria-checked={deleteUnchanged}
                className={`settings-toggle ${deleteUnchanged ? 'active' : ''}`}
                onClick={() => {
                  const next = !deleteUnchanged;
                  setDeleteUnchanged(next);
                  handleRuleToggle(deleteMerged, next);
                }}
              >
                <span className="settings-toggle-thumb" />
              </button>
            </div>
          </div>

          {/* Rule 3: Delete inactive */}
          <div className="settings-control-row">
            <div className="settings-control-copy">
              <span>Delete inactive workspaces</span>
              <small>Delete workspaces that haven't been modified in the specified timeframe.</small>
            </div>
            <div className="settings-control">
              <button
                type="button"
                role="switch"
                aria-checked={deleteInactive}
                className={`settings-toggle ${deleteInactive ? 'active' : ''}`}
                onClick={() => setDeleteInactive(!deleteInactive)}
              >
                <span className="settings-toggle-thumb" />
              </button>
            </div>
          </div>

          {/* Inactive Timeframe Dropdown (when enabled) */}
          {deleteInactive && (
            <div className="settings-control-row sub-row">
              <div className="settings-control-copy">
                <span>Inactive timeframe</span>
                <small>Number of days without git activity before workspace becomes eligible for cleanup.</small>
              </div>
              <div className="settings-control">
                <Dropdown
                  options={[
                    { value: '7', label: '7 days' },
                    { value: '14', label: '14 days' },
                    { value: '30', label: '30 days' },
                    { value: '60', label: '60 days' },
                    { value: '90', label: '90 days' },
                  ]}
                  value={inactiveDays}
                  onChange={setInactiveDays}
                  ariaLabel="Inactive timeframe"
                />
              </div>
            </div>
          )}

          {/* Advanced Disclosure */}
          <div className="cleanup-advanced-box">
            <button
              type="button"
              className="cleanup-advanced-btn"
              aria-expanded={advancedOpen}
              onClick={() => setAdvancedOpen(!advancedOpen)}
            >
              <svg
                width="12"
                height="12"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2.5"
                strokeLinecap="round"
                strokeLinejoin="round"
                style={{ transform: advancedOpen ? 'rotate(90deg)' : 'none', transition: 'transform 0.15s ease' }}
              >
                <polyline points="9 18 15 12 9 6" />
              </svg>
              <span className="cleanup-advanced-title">Advanced</span>
              <span className="cleanup-advanced-subtitle">Automation and orchestration worker workspaces</span>
            </button>
            {advancedOpen && (
              <div className="cleanup-advanced-panel">
                <div className="settings-control-row">
                  <div className="settings-control-copy">
                    <span>Delete finished automation workspaces</span>
                    <small>Workspaces an automation run created, once the run has finished.</small>
                  </div>
                  <div className="settings-control">
                    <button
                      type="button"
                      role="switch"
                      aria-checked={deleteAutomationWorkspaces}
                      className={`settings-toggle ${deleteAutomationWorkspaces ? 'active' : ''}`}
                      onClick={() => setDeleteAutomationWorkspaces(!deleteAutomationWorkspaces)}
                    >
                      <span className="settings-toggle-thumb" />
                    </button>
                  </div>
                </div>

                <div className="settings-control-row">
                  <div className="settings-control-copy">
                    <span>Delete released orchestration worker workspaces</span>
                    <small>Workspaces an orchestration worker used, once the coordinator has released it.</small>
                  </div>
                  <div className="settings-control">
                    <button
                      type="button"
                      role="switch"
                      aria-checked={deleteOrchestrationWorkspaces}
                      className={`settings-toggle ${deleteOrchestrationWorkspaces ? 'active' : ''}`}
                      onClick={() => setDeleteOrchestrationWorkspaces(!deleteOrchestrationWorkspaces)}
                    >
                      <span className="settings-toggle-thumb" />
                    </button>
                  </div>
                </div>

                <div className="cleanup-advanced-note">
                  <span>Merged branches are deleted with their workspace. Unmerged branches are kept.</span>
                </div>
              </div>
            )}
          </div>
        </div>
      </section>

      {/* Section 3: Protection Card */}
      <section className="settings-card">
        <h3>Protection</h3>
        <div className="settings-card-body">
          <div className="settings-control-row">
            <div className="settings-control-copy">
              <span>Always kept</span>
              <small>
                Pinned workspaces, running agents or terminals, unsaved editor changes, uncommitted changes, unpushed commits.
              </small>
            </div>
            <div className="settings-control">
              <span className="cleanup-always-kept-tag">Protected</span>
            </div>
          </div>

          <div className="settings-control-row">
            <div className="settings-control-copy">
              <span>Keep workspaces with ignored files</span>
              <small>
                Prevent deletion if workspace contains untracked files matching .gitignore patterns (e.g. .env, local secrets).
              </small>
            </div>
            <div className="settings-control">
              <button
                type="button"
                role="switch"
                aria-checked={keepIgnoredFiles}
                className={`settings-toggle ${keepIgnoredFiles ? 'active' : ''}`}
                onClick={() => setKeepIgnoredFiles(!keepIgnoredFiles)}
              >
                <span className="settings-toggle-thumb" />
              </button>
            </div>
          </div>
        </div>
      </section>

      {/* Section 4: Activity Card */}
      <section className="settings-card">
        <h3>Activity</h3>
        <div className="settings-card-body">
          <div className="cleanup-activity-panel">
            {activities.map((act) => (
              <div className="cleanup-activity-item" key={act.id}>
                <div className="cleanup-activity-left">
                  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round">
                    <polyline points="6 9 12 15 18 9" />
                  </svg>
                  <span className="cleanup-activity-time">{act.time}</span>
                  <span className="cleanup-activity-badge">{act.type}</span>
                </div>
                <span className="cleanup-activity-result">{act.result}</span>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* Review Workspaces Modal (Orca Delete Parity) */}
      {reviewModalOpen && createPortal(
        <div className="cleanup-modal-overlay" onClick={dismissReview}>
          <div
            className="cleanup-modal-box"
            ref={reviewDialog}
            role="dialog"
            aria-modal="true"
            aria-labelledby="cleanup-review-title"
            onClick={(event) => event.stopPropagation()}
            onKeyDown={(event) => {
              if (event.key !== 'Escape') return;
              event.preventDefault();
              event.stopPropagation();
              dismissReview();
            }}
          >
            <div className="cleanup-modal-top">
              <h3 id="cleanup-review-title">Delete workspaces</h3>
              <div className="cleanup-modal-top-right">
                <span className="cleanup-updated-text" role="status">
                  {refreshing ? 'Refreshing…' : updatedAt && `Updated ${new Date(updatedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`}
                </span>
                <button type="button" className="cleanup-icon-action-btn" aria-label="Refresh workspaces" title="Refresh workspaces"
                  disabled={refreshing || deleting} onClick={() => void refreshReview()}>
                  <ReviewIcon name="refresh" />
                </button>
                <button type="button" className="cleanup-icon-action-btn" aria-label="Close" title="Close"
                  disabled={deleting} onClick={dismissReview}><ReviewIcon name="close" /></button>
              </div>
            </div>

            <div className="cleanup-search-filter-row">
              <div className="cleanup-search-bar">
                <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true">
                  <circle cx="11" cy="11" r="8" />
                  <line x1="21" y1="21" x2="16.65" y2="16.65" />
                </svg>
                <input ref={searchInput} type="search" aria-label="Search workspaces" placeholder="Search name, project, branch, path, or host"
                  value={modalSearch} onChange={(event) => setModalSearch(event.target.value)} />
                <button type="button" className="cleanup-icon-action-btn" aria-pressed={selectableOnly}
                  aria-label="Show only worktrees eligible for deletion" title="Show only worktrees eligible for deletion"
                  onClick={() => setSelectableOnly((only) => !only)}><ReviewIcon name="filter" /></button>
              </div>
              <span className="cleanup-count-badge">{filteredWorkspaces.length} workspaces</span>
            </div>

            {!!refreshFailures.length && (
              <p className="cleanup-empty-text" role="status">Could not list worktrees for {refreshFailures.join(', ')}.</p>
            )}

            <div className="cleanup-select-sort-row">
              <label className="cleanup-select-all-label">
                <input
                  type="checkbox"
                  checked={allSelected}
                  disabled={refreshing || deleting || !selectable.length}
                  onChange={(event) => {
                    const checked = event.target.checked;
                    setSelectedWorkspaces((previous) => {
                      const next = new Set(previous);
                      for (const row of selectable) {
                        if (checked) next.add(row.id);
                        else next.delete(row.id);
                      }
                      return next;
                    });
                  }}
                />
                <span>Select all {selectable.length} available worktrees</span>
              </label>
              <div className="cleanup-sort-controls">
                <Dropdown ariaLabel="Sort workspaces by" value={sortBy} onChange={setSortBy} options={[
                  { value: 'activity', label: 'Last activity' },
                  { value: 'size', label: 'Folder size' },
                  { value: 'name', label: 'Workspace name' },
                ]} />
                <button type="button" className="cleanup-icon-action-btn"
                  aria-label={ascending ? 'Sort descending' : 'Sort ascending'}
                  title={ascending ? 'Ascending' : 'Descending'}
                  onClick={() => setAscending((value) => !value)}>{ascending ? '↑' : '↓'}</button>
              </div>
            </div>

            <div className="cleanup-workspace-cards-list">
              {!filteredWorkspaces.length && (
                <p className="cleanup-empty-text">{refreshing ? 'Loading workspaces…' : 'No workspaces match your search.'}</p>
              )}
              {filteredWorkspaces.map((ws) => {
                const protection = protectionFor(ws);
                const ignored = isIgnored(ws);
                const isExpanded = expanded === ws.id;
                const metadata = ws.worktree?.missing ? null : reviewMetadata[ws.id];
                const activity = activityFor(ws);
                const branch = ws.worktree?.branch ?? metadata?.branch;
                const title = !ws.worktree || ws.worktree.is_main ? branch ?? ws.name : ws.name;
                const selectedPath = ws.projectId ? worktreeSelection[ws.projectId] : null;
                const main = !ws.worktree || ws.worktree.is_main;
                const active = ws.projectId === currentProjectId && (selectedPath
                  ? normalizeProjectPath(selectedPath) === ws.id
                  : main);
                const terminals = liveSessions.filter((session) => {
                  if (!session.isRunning || !isPathInside(session.worktree?.path ?? session.cwd, ws.path)) return false;
                  return !main || !(listedWorktrees[ws.projectId ?? ''] ?? []).some((tree) =>
                    !tree.is_main && isPathInside(session.worktree?.path ?? session.cwd, tree.path));
                }).length;
                const status = [...new Set([
                  workspaceProtection(ws),
                  protection ?? 'Ready for review',
                  active ? 'Active workspace' : null,
                  metadata?.git_state && metadata.git_state !== 'Clean' ? metadata.git_state : null,
                  terminals > 0 ? `${terminals} running terminal${terminals === 1 ? '' : 's'}` : null,
                ].filter(Boolean))].join(' · ');
                return (
                  <div key={ws.id} className="cleanup-ws-row">
                    <div className="cleanup-ws-summary">
                      <div className="cleanup-ws-row-left">
                        {protection ? (
                          <svg className="cleanup-lock-icon" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-label={protection} role="img">
                            <rect x="3" y="11" width="18" height="11" rx="2" />
                            <path d="M7 11V7a5 5 0 0 1 10 0v4" />
                          </svg>
                        ) : (
                          <input type="checkbox" aria-label={`Select ${ws.name}`} checked={selectedWorkspaces.has(ws.id)}
                            disabled={refreshing || deleting}
                            onChange={(event) => {
                              const checked = event.target.checked;
                              setSelectedWorkspaces((previous) => {
                                const next = new Set(previous);
                                if (checked) next.add(ws.id);
                                else next.delete(ws.id);
                                return next;
                              });
                            }} />
                        )}
                        <div className="cleanup-ws-details">
                          <div className="cleanup-ws-title-line">
                            <strong className="cleanup-ws-branch-name">{title}</strong>
                            <span className="cleanup-ws-project-chip"><ProjectIconBadge icon={ws.projectIcon} size={14} />{ws.projectName}</span>
                          </div>
                          <span className="cleanup-ws-status-line">{status}</span>
                        </div>
                      </div>
                      <div className="cleanup-ws-row-right">
                        <div className="cleanup-ws-quick-actions">
                          <button type="button" className="cleanup-icon-action-btn" aria-label="Open workspace" title="Open workspace"
                            disabled={deleting || ws.worktree?.missing} onClick={() => void openReviewedWorkspace(ws)}><ReviewIcon name="open" /></button>
                          <button type="button" className="cleanup-icon-action-btn"
                            aria-label={ignored ? `Stop ignoring ${title}` : `Ignore ${title} for bulk delete`}
                            title={ignored ? 'Stop ignoring' : 'Ignore: skip in bulk delete'}
                            disabled={deleting || (!ignored && metadata === undefined)}
                            onClick={() => toggleIgnored(ws)}><ReviewIcon name={ignored ? 'restore' : 'hide'} /></button>
                        </div>
                        <span className="cleanup-ws-activity" title={activity ? new Date(activity).toLocaleString() : 'Activity unavailable'}>
                          {activityLabel(activity)}
                        </span>
                        <span className="cleanup-ws-size" title={metadata === undefined ? 'Calculating folder size' : metadata?.size_partial ? 'Partial folder scan' : 'Folder size'}>
                          {folderSize(metadata)}
                        </span>
                        <button type="button" className={`cleanup-icon-action-btn cleanup-ws-details-button${isExpanded ? ' open' : ''}`}
                          aria-label={isExpanded ? 'Hide workspace details' : 'Show workspace details'} aria-expanded={isExpanded}
                          onClick={() => setExpanded(isExpanded ? null : ws.id)}><ReviewIcon name="details" /></button>
                      </div>
                    </div>
                    {isExpanded && (
                      <dl className="cleanup-ws-metadata">
                        <dt>Path</dt><dd>{ws.path}</dd>
                        <dt>Host</dt><dd>{hostFor(ws)}</dd>
                        <dt>Branch</dt><dd>{branch ?? (ws.worktree?.head ? 'Detached HEAD' : 'Unavailable')}</dd>
                        <dt>Git</dt><dd>{metadata?.git_state ?? 'Unavailable'}</dd>
                        <dt>Folder size</dt><dd>{folderSize(metadata)}{metadata?.size_partial ? ' (partial scan)' : ''}</dd>
                        <dt>Last activity</dt><dd>{activity ? new Date(activity).toLocaleString() : 'Unavailable'}</dd>
                        {ws.worktree?.head && <><dt>Commit</dt><dd>{ws.worktree.head}</dd></>}
                        {ws.worktree?.created_at && <><dt>Created</dt><dd>{new Date(ws.worktree.created_at).toLocaleString()}</dd></>}
                      </dl>
                    )}
                  </div>
                );
              })}
            </div>

            <div className="cleanup-modal-footer">
              <button type="button" className="cleanup-icon-action-btn" disabled={deleting} onClick={dismissReview}>Close</button>
              {selection.length > 0 && (
                <button type="button" className="cleanup-delete-btn" disabled={deleting || refreshing} onClick={() => void deleteSelected()}>
                  {deleting ? 'Deleting…' : `Delete selected (${selection.length})`}
                </button>
              )}
            </div>
          </div>
        </div>,
        document.body,
      )}

    </div>
  );
}
