import { useEffect, useMemo, useRef, useState } from 'react';
import { useWorkspaceStore } from '$lib/stores/zustand/workspace';
import { useGitBranchStore } from '$lib/stores/zustand/gitBranch';
import { useStore } from '$lib/react/useStore';
import {
  recentWorkspaces,
  openWorkspace,
  switchToProject,
  deleteCollection,
  removeProjectFromCollection,
  moveProjectToWorkspace,
  moveProjectToStandalone,
  addProjectToWorkspace,
  openProject,
  createNewWorkspace,
  newFolderPromptOpen,
  cloneRepoPromptOpen,
  projectOpenRooms,
  isProjectSwitching,
} from '$lib/stores/workspace';
import {
  allProjectSessions,
  getSessionPromptTargetLabel,
  getSessionPaneDisplayTitle,
  isAgentSession,
  type TerminalSessionInfo,
} from '$lib/stores/terminal';
import {
  orchestratorTasks,
  readProjectOrchestratorTaskSummaries,
  type OrchestratorTask,
} from '$lib/stores/orchestrator';
import { setInteractionMode } from '$lib/stores/interactionMode';
import {
  chatThreadState,
  createChatThread,
  selectChatThread,
  type ChatThread,
  type ChatThreadStatus,
} from '$lib/stores/chatThreads';
import { getAgentDisplayName } from '$lib/stores/terminal';
import { requestRoomControl } from '$lib/stores/layoutControl';
import './ProjectHUD.css';

function getFilename(path: string): string {
  const normalized = path.replace(/\\/g, '/');
  const parts = normalized.split('/');
  return parts[parts.length - 1] || path;
}

function shortPath(path: string) {
  const normalized = path.replace(/\\/g, '/');
  const parts = normalized.split('/');
  return parts.length <= 2 ? normalized : `.../${parts.slice(-2).join('/')}`;
}

const COLLAPSED_WORKSPACES_KEY = 'spacron.hud.collapsedWorkspaces';
const EXPANDED_PROJECTS_KEY = 'spacron.hud.expandedProjects';
const DOUBLE_TAP_MS = 400;

const ROOM_LABELS: Record<string, string> = {
  terminal: 'Terminal',
  editor: 'Editor',
  preview: 'Preview',
  review: 'Review',
  tasks: 'Tasks',
  sketch: 'Sketch',
};

const TASK_STATUS_LABELS: Record<OrchestratorTask['status'], string> = {
  todo: 'Queued',
  'in-progress': 'Working',
  complete: 'Done',
  blocked: 'Needs input',
  failed: 'Failed',
  cancelled: 'Cancelled',
};

interface ProjectItem {
  workspaceId: string;
  name: string;
  path: string;
  isActive: boolean;
  isInsideWorkspace?: boolean;
}

interface ChatSidebarRow {
  id: string;
  projectId: string;
  title: string;
  agentName: string;
  provider: string;
  status: ChatThreadStatus;
  unreadCount: number;
  thread: ChatThread | null;
  task: OrchestratorTask | null;
  session: TerminalSessionInfo | null;
}

function threadStatusFromTask(task: OrchestratorTask): ChatThreadStatus {
  switch (task.status) {
    case 'in-progress': return 'working';
    case 'blocked': return 'needs-input';
    case 'complete': return 'complete';
    case 'failed':
    case 'cancelled': return 'failed';
    case 'todo': return 'draft';
  }
}

function chatStatusLabel(status: ChatThreadStatus): string {
  switch (status) {
    case 'working': return 'Working';
    case 'needs-input': return 'Needs input';
    case 'complete': return 'Done';
    case 'failed': return 'Failed';
    case 'archived': return 'Archived';
    case 'draft': return 'New';
    case 'idle': return 'Idle';
  }
}

function chatStatusRank(status: ChatThreadStatus): number {
  switch (status) {
    case 'working': return 0;
    case 'needs-input': return 1;
    case 'draft': return 2;
    case 'idle': return 3;
    case 'complete': return 4;
    case 'failed': return 5;
    case 'archived': return 6;
  }
}

export default function ProjectHUD() {
  const rawWorkspaces = useWorkspaceStore((s) => s.recentWorkspaces) || [];
  const activeWsId = useWorkspaceStore((s) => s.activeWorkspaceId);
  const activeProjId = useWorkspaceStore((s) => s.activeProjectId);
  const projectsMap = useWorkspaceStore((s) => s.projects);
  const branchInfo = useGitBranchStore((s) => s.branchInfoByProject);

  const [search, setSearch] = useState('');
  const [showNewWs, setShowNewWs] = useState(false);
  const [newWsName, setNewWsName] = useState('');
  const [activeMoveMenuPath, setActiveMoveMenuPath] = useState<string | null>(null);

  const [collapsedWorkspaces, setCollapsedWorkspaces] = useState<Set<string>>(() => {
    try {
      const raw = localStorage.getItem(COLLAPSED_WORKSPACES_KEY);
      return new Set<string>(raw ? (JSON.parse(raw) as string[]) : []);
    } catch {
      return new Set<string>();
    }
  });

  const [expandedProjects, setExpandedProjects] = useState<Set<string>>(() => {
    try {
      const raw = localStorage.getItem(EXPANDED_PROJECTS_KEY);
      return new Set<string>(raw ? (JSON.parse(raw) as string[]) : []);
    } catch {
      return new Set<string>();
    }
  });

  const inputRef = useRef<HTMLInputElement | null>(null);
  const newWsInputRef = useRef<HTMLInputElement | null>(null);
  const lastCardClickRef = useRef<{ path: string; at: number }>({ path: '', at: 0 });

  const crossProjectSessions = useStore(allProjectSessions);
  const liveOrchestratorTasks = useStore(orchestratorTasks);
  const openRoomsByProject = useStore(projectOpenRooms);
  const allChatThreads = useStore(chatThreadState);
  const [persistedTasksByProject, setPersistedTasksByProject] = useState<Map<string, OrchestratorTask>>(new Map());

  const projectIdByPath = useMemo(() => {
    const byPath = new Map<string, string>();
    for (const project of projectsMap.values()) byPath.set(project.root_path, project.id);
    return byPath;
  }, [projectsMap]);

  const sessionsByProject = useMemo(() => {
    const byProject = new Map<string, TerminalSessionInfo[]>();
    for (const session of crossProjectSessions) {
      if (!session.isRunning || session.hidden) continue;
      const list = byProject.get(session.projectId);
      if (list) list.push(session);
      else byProject.set(session.projectId, [session]);
    }
    return byProject;
  }, [crossProjectSessions]);

  // The orchestrator store is live for projects visited in this session. Read a
  // lightweight history for the other projects as well, so a workspace switch
  // does not make their completed work disappear from the project tree.
  useEffect(() => {
    let cancelled = false;
    void Promise.all(
      Array.from(projectsMap.values()).map(async (project) => {
        const tasks = await readProjectOrchestratorTaskSummaries(project);
        return [project.id, tasks] as const;
      }),
    ).then((entries) => {
      if (cancelled) return;
      const next = new Map<string, OrchestratorTask>();
      for (const [projectId, tasks] of entries) {
        for (const task of tasks) next.set(`${projectId}:${task.id}`, task);
      }
      setPersistedTasksByProject(next);
    });
    return () => {
      cancelled = true;
    };
  }, [projectsMap]);

  const tasksByProject = useMemo(() => {
    const byProject = new Map<string, OrchestratorTask[]>();
    for (const task of persistedTasksByProject.values()) {
      const list = byProject.get(task.projectId);
      if (list) list.push(task);
      else byProject.set(task.projectId, [task]);
    }
    for (const task of liveOrchestratorTasks) {
      const list = byProject.get(task.projectId);
      if (list) {
        const index = list.findIndex((entry) => entry.id === task.id);
        if (index >= 0) list[index] = task;
        else list.push(task);
      } else {
        byProject.set(task.projectId, [task]);
      }
    }
    return byProject;
  }, [liveOrchestratorTasks, persistedTasksByProject]);

  // Derive active project's path
  const activeProjPath = useMemo(() => {
    if (!activeProjId) return null;
    return projectsMap.get(activeProjId)?.root_path ?? null;
  }, [activeProjId, projectsMap]);

  // Distinguish between Standalone Projects and Workspace Groups
  // A Workspace is either explicitly marked with is_workspace: true, or has multiple project paths
  const { standaloneProjects, workspaceGroups } = useMemo(() => {
    const standalones: ProjectItem[] = [];
    const groups: typeof rawWorkspaces = [];

    for (const ws of rawWorkspaces) {
      const isGroup = ws.is_workspace || (ws.project_paths && ws.project_paths.length > 1);
      if (isGroup) {
        groups.push(ws);
      } else {
        const pPath = ws.project_paths?.[0] || '';
        standalones.push({
          workspaceId: ws.id,
          name: pPath ? getFilename(pPath) : ws.name,
          path: pPath,
          isActive: activeWsId === ws.id && (activeProjPath === pPath || !activeProjPath),
          isInsideWorkspace: false,
        });
      }
    }
    return { standaloneProjects: standalones, workspaceGroups: groups };
  }, [rawWorkspaces, activeWsId, activeProjPath]);

  // Filtered lists
  const query = search.toLowerCase().trim();

  const filteredStandalones = useMemo(() => {
    if (!query) return standaloneProjects;
    return standaloneProjects.filter(
      (p) => p.name.toLowerCase().includes(query) || p.path.toLowerCase().includes(query)
    );
  }, [standaloneProjects, query]);

  const filteredWorkspaces = useMemo(() => {
    if (!query) return workspaceGroups;
    return workspaceGroups.filter((ws) => {
      if (ws.name.toLowerCase().includes(query)) return true;
      return (ws.project_paths || []).some((p) =>
        getFilename(p).toLowerCase().includes(query) || p.toLowerCase().includes(query)
      );
    });
  }, [workspaceGroups, query]);

  // Close move-menu on outside click
  useEffect(() => {
    if (!activeMoveMenuPath) return;
    const handler = (e: MouseEvent) => {
      const target = e.target as HTMLElement;
      if (!target.closest('.hud-move-menu') && !target.closest('.hud-card-action-btn')) {
        setActiveMoveMenuPath(null);
      }
    };
    window.addEventListener('click', handler);
    return () => window.removeEventListener('click', handler);
  }, [activeMoveMenuPath]);

  // Toggle workspace collapse
  function toggleWorkspaceCollapse(id: string) {
    setCollapsedWorkspaces((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      try {
        localStorage.setItem(COLLAPSED_WORKSPACES_KEY, JSON.stringify(Array.from(next)));
      } catch {
        /* storage unavailable */
      }
      return next;
    });
  }

  // Toggle project expand
  function toggleProjectExpanded(path: string) {
    if (!path) return;
    setExpandedProjects((prev) => {
      const next = new Set(prev);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      try {
        localStorage.setItem(EXPANDED_PROJECTS_KEY, JSON.stringify(Array.from(next)));
      } catch {
        /* storage unavailable */
      }
      return next;
    });
  }

  // Handle open project
  async function handleOpen(wsId: string, path: string) {
    if (wsId !== activeWsId) {
      if (path) {
        recentWorkspaces.update((list) =>
          list.map((w) => (w.id === wsId ? { ...w, active_project_path: path } : w))
        );
      }
      await openWorkspace(wsId);
    } else if (path) {
      const proj = Array.from(projectsMap.values()).find((p) => p.root_path === path);
      if (proj) {
        switchToProject(proj.id);
      }
    }
  }

  // Handle create new workspace
  function handleCreateWorkspace(e: React.FormEvent) {
    e.preventDefault();
    const name = newWsName.trim();
    if (!name) return;
    createNewWorkspace(name);
    setNewWsName('');
    setShowNewWs(false);
  }

  // Handle delete workspace
  async function handleDeleteWorkspace(wsId: string, wsName: string) {
    if (confirm(`Delete workspace "${wsName}"? (Your project files on disk will not be deleted)`)) {
      await deleteCollection(wsId);
    }
  }

  // Handle remove standalone project from list
  async function handleRemoveStandalone(wsId: string, projectName: string) {
    if (confirm(`Remove "${projectName}" from project list? (Your files on disk will not be deleted)`)) {
      await deleteCollection(wsId);
    }
  }

  // Room jump
  const pendingFocusRef = useRef<(() => void) | null>(null);

  function focusRoomAfterSwitch(room: string) {
    pendingFocusRef.current?.();

    let settled = false;
    let sawSwitch = false;
    let unsubscribe: (() => void) | null = null;
    let timer = 0;

    function cancel() {
      window.clearTimeout(timer);
      unsubscribe?.();
      unsubscribe = null;
      if (pendingFocusRef.current === cancel) pendingFocusRef.current = null;
    }

    function finish() {
      if (settled) return;
      settled = true;
      cancel();
      requestRoomControl('focus', room);
    }

    pendingFocusRef.current = cancel;
    unsubscribe = isProjectSwitching.subscribe((busy) => {
      if (busy) sawSwitch = true;
      else if (sawSwitch) finish();
    });
    timer = window.setTimeout(() => {
      if (!sawSwitch) finish();
    }, 800);
  }

  useEffect(() => () => pendingFocusRef.current?.(), []);

  async function openRoom(wsId: string, path: string, room: string) {
    const projectId = projectIdByPath.get(path);
    if (projectId && activeProjId === projectId) {
      requestRoomControl('focus', room);
      return;
    }
    focusRoomAfterSwitch(room);
    await handleOpen(wsId, path);
  }

  async function openChatThread(
    wsId: string,
    path: string,
    row: ChatSidebarRow | null,
  ) {
    const projectId = projectIdByPath.get(path);
    if (!projectId) return;

    let threadId = row?.thread?.id ?? null;
    if (!threadId) {
      const thread = createChatThread(projectId, {
        title: row?.title,
        agentName: row?.agentName || null,
        agentPreset: row?.task?.agentPreset ?? row?.session?.agentPreset ?? null,
        taskId: row?.task?.id ?? null,
        sessionId: row?.session?.id ?? row?.task?.assignedSessionId ?? null,
      });
      threadId = thread.id;
    }
    selectChatThread(projectId, threadId);
    await handleOpen(wsId, path);
    setInteractionMode('chat');
  }

  // Render a project card
  function renderProjectCard(p: ProjectItem, parentWorkspaceId?: string) {
    const gitInfo = p.isActive && activeProjId ? branchInfo[activeProjId] : null;
    const projectId = p.path ? projectIdByPath.get(p.path) ?? null : null;
    const projectSessions = projectId ? sessionsByProject.get(projectId) ?? [] : [];
    const projectRooms = projectId ? openRoomsByProject.get(projectId) ?? [] : [];
    const allProjectTasks = projectId ? tasksByProject.get(projectId) ?? [] : [];
    const projectTasks = [...allProjectTasks]
      .sort((a, b) => (b.completedAt ?? b.startedAt ?? b.createdAt) - (a.completedAt ?? a.startedAt ?? a.createdAt))
      .slice(0, 5);
    const workingCount = projectSessions.filter((s) => s.isExecuting).length;
    const storedThreads = projectId ? allChatThreads.threadsByProject[projectId] ?? [] : [];
    const activeThreadId = projectId ? allChatThreads.activeThreadByProject[projectId] ?? null : null;
    const taskById = new Map(allProjectTasks.map((task) => [task.id, task]));
    const sessionById = new Map(projectSessions.map((session) => [session.id, session]));
    const storedTaskIds = new Set(storedThreads.map((thread) => thread.taskId).filter((id): id is string => !!id));
    const storedSessionIds = new Set(storedThreads.map((thread) => thread.sessionId).filter((id): id is number => id != null));
    const chatRows: ChatSidebarRow[] = storedThreads.map((thread) => {
      const task = thread.taskId ? taskById.get(thread.taskId) ?? null : null;
      const session = thread.sessionId != null
        ? sessionById.get(thread.sessionId) ?? null
        : task?.assignedSessionId != null
          ? sessionById.get(task.assignedSessionId) ?? null
          : null;
      let status = thread.status;
      if (task) {
        status = task.status === 'in-progress' && !session ? 'idle' : threadStatusFromTask(task);
      } else if (session?.isExecuting) {
        status = 'working';
      } else if (status === 'working') {
        status = 'idle';
      }
      const agentPreset = thread.agentPreset ?? task?.agentPreset ?? session?.agentPreset ?? null;
      const agentName = thread.agentName
        ?? task?.name
        ?? (session ? getSessionPromptTargetLabel(session, projectSessions) : null)
        ?? getAgentDisplayName(agentPreset)
        ?? 'Agent';
      return {
        id: thread.id,
        projectId: thread.projectId,
        title: thread.title,
        agentName,
        provider: getAgentDisplayName(agentPreset) ?? agentPreset ?? 'Spacron',
        status,
        unreadCount: thread.unreadCount,
        thread,
        task,
        session,
      };
    });
    for (const task of allProjectTasks) {
      if (storedTaskIds.has(task.id)) continue;
      const session = task.assignedSessionId != null ? sessionById.get(task.assignedSessionId) ?? null : null;
      const agentPreset = task.agentPreset ?? session?.agentPreset ?? null;
      chatRows.push({
        id: `task:${task.id}`,
        projectId: task.projectId,
        title: task.title,
        agentName: task.name ?? (session ? getSessionPromptTargetLabel(session, projectSessions) : null) ?? getAgentDisplayName(agentPreset) ?? 'Agent',
        provider: getAgentDisplayName(agentPreset) ?? agentPreset ?? 'Spacron',
        status: task.status === 'in-progress' && !session ? 'idle' : threadStatusFromTask(task),
        unreadCount: 0,
        thread: null,
        task,
        session,
      });
    }
    for (const session of projectSessions) {
      if (!isAgentSession(session) || storedSessionIds.has(session.id)) continue;
      if (allProjectTasks.some((task) => task.assignedSessionId === session.id)) continue;
      const agentPreset = session.agentPreset ?? null;
      chatRows.push({
        id: `session:${session.id}`,
        projectId: session.projectId,
        title: session.taskSummary || getSessionPaneDisplayTitle(session, projectSessions) || 'Agent session',
        agentName: getSessionPromptTargetLabel(session, projectSessions),
        provider: getAgentDisplayName(agentPreset) ?? agentPreset ?? 'Spacron',
        status: session.isExecuting ? 'working' : 'idle',
        unreadCount: 0,
        thread: null,
        task: null,
        session,
      });
    }
    chatRows.sort((a, b) => {
      const rank = chatStatusRank(a.status) - chatStatusRank(b.status);
      if (rank !== 0) return rank;
      const aActivity = a.thread?.lastActivityAt ?? a.task?.completedAt ?? a.task?.startedAt ?? a.task?.createdAt ?? a.session?.lastActivatedAt ?? 0;
      const bActivity = b.thread?.lastActivityAt ?? b.task?.completedAt ?? b.task?.startedAt ?? b.task?.createdAt ?? b.session?.lastActivatedAt ?? 0;
      return bActivity - aActivity;
    });
    const hasOpenContents = projectSessions.length > 0 || projectRooms.length > 0 || allProjectTasks.length > 0;
    const hasContents = hasOpenContents || chatRows.length > 0 || Boolean(p.path);
    const isExpanded = p.path ? expandedProjects.has(p.path) : false;
    const showMoveMenu = activeMoveMenuPath === p.path;

    return (
      <div key={`${p.workspaceId}-${p.path}`} className="project-sidebar-entry">
        <div
          data-project-path={p.path}
          className={`project-sidebar-card${p.isActive ? ' active' : ''}${isExpanded ? ' expanded' : ''}`}
          onClick={() => {
            const now = Date.now();
            const last = lastCardClickRef.current;
            lastCardClickRef.current = { path: p.path, at: now };
            if (last.path === p.path && now - last.at < DOUBLE_TAP_MS) return;
            handleOpen(p.workspaceId, p.path);
          }}
          onDoubleClick={(e) => {
            e.preventDefault();
            if (p.path) toggleProjectExpanded(p.path);
          }}
        >
          {p.path && hasContents && (
            <button
              type="button"
              className={`project-disclosure-btn${isExpanded ? ' open' : ''}`}
              onClick={(e) => {
                e.stopPropagation();
                toggleProjectExpanded(p.path);
              }}
              aria-expanded={isExpanded}
              title={isExpanded ? 'Hide contents' : 'Show contents'}
            >
              <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.8" strokeLinecap="round" strokeLinejoin="round">
                <polyline points="9 6 15 12 9 18" />
              </svg>
            </button>
          )}

          <div className="project-sidebar-card-avatar">
            <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" className="project-folder-icon">
              <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z" fill="currentColor" fillOpacity="0.12" />
            </svg>
          </div>

          <div className="project-sidebar-card-info">
            <div className="project-sidebar-card-name-row">
              <span className="project-sidebar-card-name" title={p.name}>{p.name}</span>
              {p.isActive && (
                <span className="project-active-badge">
                  <span className="project-active-dot" />
                  Active
                </span>
              )}
            </div>

            <div className="project-sidebar-card-meta-row">
              {p.path ? (
                <span className="project-sidebar-card-path" title={p.path}>
                  {shortPath(p.path)}
                </span>
              ) : (
                <span className="project-sidebar-card-path" style={{ fontStyle: 'italic' }}>
                  No folder
                </span>
              )}

              {gitInfo && (
                <span className="project-sidebar-card-git" title={`Branch: ${gitInfo.current}`}>
                  <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
                    <line x1="6" y1="3" x2="6" y2="15" />
                    <circle cx="18" cy="6" r="3" />
                    <circle cx="6" cy="18" r="3" />
                    <path d="M18 9a9 9 0 0 1-9 9" />
                  </svg>
                  <span className="git-branch-text">{gitInfo.current}</span>
                </span>
              )}

              {!isExpanded && projectSessions.length > 0 && (
                <span className="project-sidebar-card-agents" title={`${projectSessions.length} sessions`}>
                  <span className={`hud-status-dot${workingCount > 0 ? ' working' : ''}`} />
                  {projectSessions.length}
                </span>
              )}
              {!isExpanded && allProjectTasks.length > 0 && (
                <span className="project-sidebar-card-task-count" title={`${allProjectTasks.length} tasks`}>
                  {allProjectTasks.length} task{allProjectTasks.length === 1 ? '' : 's'}
                </span>
              )}
            </div>
          </div>

          {/* Action Buttons */}
          <div className="project-card-actions" onClick={(e) => e.stopPropagation()}>
            {/* Move to workspace button */}
            <button
              type="button"
              className="hud-card-action-btn"
              onClick={() => setActiveMoveMenuPath(showMoveMenu ? null : p.path)}
              title="Move to workspace..."
              aria-label="Move to workspace"
            >
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M17 3a2.85 2.83 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5Z" />
              </svg>
            </button>

            {/* Remove / Delete button */}
            {parentWorkspaceId ? (
              <button
                type="button"
                className="hud-card-action-btn hover-danger"
                onClick={() => void removeProjectFromCollection(parentWorkspaceId, p.path)}
                title="Remove from workspace"
                aria-label="Remove from workspace"
              >
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <line x1="18" y1="6" x2="6" y2="18" />
                  <line x1="6" y1="6" x2="18" y2="18" />
                </svg>
              </button>
            ) : (
              <button
                type="button"
                className="hud-card-action-btn hover-danger"
                onClick={() => void handleRemoveStandalone(p.workspaceId, p.name)}
                title="Remove from project list"
                aria-label="Remove from project list"
              >
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <polyline points="3 6 5 6 21 6" />
                  <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
                </svg>
              </button>
            )}

            {/* Move to Workspace Dropdown Menu */}
            {showMoveMenu && (
              <div className="hud-move-menu">
                <div className="hud-move-menu-label">Move to Workspace</div>
                {workspaceGroups
                  .filter((ws) => ws.id !== parentWorkspaceId)
                  .map((ws) => (
                    <button
                      key={ws.id}
                      type="button"
                      className="hud-move-menu-item"
                      onClick={() => {
                        moveProjectToWorkspace(p.path, ws.id);
                        setActiveMoveMenuPath(null);
                      }}
                    >
                      <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                        <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z" />
                      </svg>
                      <span>{ws.name}</span>
                    </button>
                  ))}

                {parentWorkspaceId && (
                  <button
                    type="button"
                    className="hud-move-menu-item"
                    onClick={() => {
                      moveProjectToStandalone(p.path, parentWorkspaceId);
                      setActiveMoveMenuPath(null);
                    }}
                  >
                    <span>Move to Standalone Projects</span>
                  </button>
                )}

                {workspaceGroups.length === 0 && !parentWorkspaceId && (
                  <div className="hud-move-menu-empty">No workspaces created yet</div>
                )}
              </div>
            )}
          </div>
        </div>

        {/* Expanded Contents */}
        {isExpanded && p.path && (
          <div className="project-contents">
            {!hasOpenContents && chatRows.length === 0 && (
              <div className="project-contents-empty">Nothing open in this project</div>
            )}
            <div className="project-contents-section project-threads-section">
              <div className="project-contents-label project-threads-label">
                <span>Threads</span>
                <button
                  type="button"
                  className="project-new-thread-btn"
                  onClick={() => void openChatThread(p.workspaceId, p.path, null)}
                  title="New chat thread"
                  aria-label={`New chat thread in ${p.name}`}
                >
                  <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round">
                    <line x1="12" y1="5" x2="12" y2="19" />
                    <line x1="5" y1="12" x2="19" y2="12" />
                  </svg>
                </button>
              </div>
              {chatRows.length === 0 ? (
                <span className="project-threads-empty">No threads yet</span>
              ) : (
                <div className="project-thread-list">
                  {chatRows.map((row) => {
                    const isSelected = row.thread?.id === activeThreadId;
                    const terminalSession = row.session
                      ?? (row.task?.assignedSessionId != null ? sessionById.get(row.task.assignedSessionId) ?? null : null);
                    return (
                      <div key={row.id} className={`project-thread-row-wrap${isSelected ? ' selected' : ''}`}>
                        <button
                          type="button"
                          className={`project-thread-row status-${row.status}`}
                          onClick={() => void openChatThread(p.workspaceId, p.path, row)}
                          title={`${row.title} — ${chatStatusLabel(row.status)}`}
                        >
                          <span className="project-thread-status" aria-hidden="true" />
                          <span className="project-thread-copy">
                            <strong>{row.agentName}</strong>
                            <span>{row.title}</span>
                          </span>
                          <span className="project-thread-provider">{row.provider}</span>
                          {row.unreadCount > 0 && <span className="project-thread-unread" title={`${row.unreadCount} unread`} />}
                          <span className="project-thread-state">{chatStatusLabel(row.status)}</span>
                        </button>
                        {terminalSession && (
                          <button
                            type="button"
                            className="project-thread-terminal-btn"
                            onClick={() => void openRoom(p.workspaceId, p.path, `agent:${terminalSession.id}`)}
                            title="Open agent terminal"
                            aria-label={`Open terminal for ${row.agentName}`}
                          >
                            <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                              <polyline points="4 17 10 11 4 5" />
                              <line x1="12" y1="19" x2="20" y2="19" />
                            </svg>
                          </button>
                        )}
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
            {projectSessions.length > 0 && (
              <div className="project-contents-section">
                <div className="project-contents-label">Running</div>
                {projectSessions.map((session) => {
                  const isAgent = isAgentSession(session);
                  const name = isAgent ? getSessionPromptTargetLabel(session, projectSessions) : session.title;
                  const detail = getSessionPaneDisplayTitle(session, projectSessions);
                  return (
                    <button
                      key={session.id}
                      type="button"
                      className="project-process-row"
                      onClick={() =>
                        openRoom(p.workspaceId, p.path, isAgent ? `agent:${session.id}` : 'terminal').catch(
                          console.error
                        )
                      }
                      title={session.isExecuting ? `${name} — working` : `${name} — running`}
                    >
                      <span className={`hud-status-dot${session.isExecuting ? ' working' : ''}`} aria-hidden="true" />
                      <span className="project-process-name">{name}</span>
                      {detail && detail !== name && <span className="project-process-detail">{detail}</span>}
                    </button>
                  );
                })}
              </div>
            )}

            {projectTasks.length > 0 && (
              <div className="project-contents-section">
                <div className="project-contents-label">Recent tasks</div>
                <div className="project-task-list">
                  {projectTasks.map((task) => {
                    const liveSession = task.assignedSessionId != null
                      ? projectSessions.find((session) => session.id === task.assignedSessionId && session.isRunning)
                      : undefined;
                    return (
                      <button
                        key={task.id}
                        type="button"
                        className={`project-task-row status-${task.status}`}
                        onClick={() => {
                          if (liveSession) {
                            void openRoom(p.workspaceId, p.path, `agent:${liveSession.id}`);
                          } else {
                            focusRoomAfterSwitch('fleet');
                            void handleOpen(p.workspaceId, p.path);
                          }
                        }}
                        title={`${task.title} — ${TASK_STATUS_LABELS[task.status]}`}
                      >
                        <span className="project-task-status" aria-hidden="true">
                          {task.status === 'complete' ? '✓' : task.status === 'failed' || task.status === 'cancelled' ? '!' : task.status === 'blocked' ? '?' : '·'}
                        </span>
                        <span className="project-task-title">{task.title}</span>
                        <span className="project-task-state">{TASK_STATUS_LABELS[task.status]}</span>
                      </button>
                    );
                  })}
                </div>
                {allProjectTasks.length > projectTasks.length && (
                  <span className="project-task-more">+{allProjectTasks.length - projectTasks.length} older</span>
                )}
              </div>
            )}

            {projectRooms.length > 0 && (
              <div className="project-contents-section">
                <div className="project-contents-label">Rooms</div>
                <div className="project-room-chips">
                  {projectRooms.map((room) => (
                    <button
                      key={room}
                      type="button"
                      className="project-room-chip"
                      onClick={() => openRoom(p.workspaceId, p.path, room).catch(console.error)}
                      title={`Open ${ROOM_LABELS[room] ?? room}`}
                    >
                      {ROOM_LABELS[room] ?? room}
                    </button>
                  ))}
                </div>
              </div>
            )}
          </div>
        )}
      </div>
    );
  }

  return (
    <div className="projects-sidebar-panel">
      {/* Top Header Toolbar */}
      <div className="projects-panel-header">
        <span className="projects-panel-title">Projects</span>
        <div className="projects-header-actions">
          <button
            type="button"
            className="projects-header-btn"
            onClick={() => void openProject()}
            title="Open Project Folder... (Ctrl+O)"
            aria-label="Open Project Folder"
          >
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z" />
            </svg>
          </button>
          <button
            type="button"
            className="projects-header-btn"
            onClick={() => newFolderPromptOpen.set(true)}
            title="New Project Folder... (Ctrl+N)"
            aria-label="New Project Folder"
          >
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z" />
              <line x1="12" y1="11" x2="12" y2="17" />
              <line x1="9" y1="14" x2="15" y2="14" />
            </svg>
          </button>
          <button
            type="button"
            className="projects-header-btn"
            onClick={() => {
              setShowNewWs(true);
              setTimeout(() => newWsInputRef.current?.focus(), 50);
            }}
            title="Create New Workspace..."
            aria-label="Create New Workspace"
          >
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
              <rect x="3" y="3" width="7" height="7" />
              <rect x="14" y="3" width="7" height="7" />
              <rect x="14" y="14" width="7" height="7" />
              <rect x="3" y="14" width="7" height="7" />
            </svg>
          </button>
          <button
            type="button"
            className="projects-header-btn"
            onClick={() => cloneRepoPromptOpen.set(true)}
            title="Clone Git Repository..."
            aria-label="Clone Git Repository"
          >
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
              <circle cx="18" cy="18" r="3" />
              <circle cx="6" cy="6" r="3" />
              <circle cx="6" cy="18" r="3" />
              <path d="M18 15V9a4 4 0 0 0-4-4H9" />
              <line x1="6" y1="9" x2="6" y2="15" />
            </svg>
          </button>
        </div>
      </div>

      {/* Filter / Search Bar */}
      <div className="projects-search-section">
        <div className="projects-search-field">
          <svg className="projects-search-icon" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
            <circle cx="11" cy="11" r="8" />
            <line x1="21" y1="21" x2="16.65" y2="16.65" />
          </svg>
          <input
            ref={inputRef}
            type="text"
            className="projects-search-input"
            placeholder="Filter projects & workspaces…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
          {search && (
            <button
              type="button"
              className="projects-search-clear"
              onClick={() => setSearch('')}
              title="Clear search"
              aria-label="Clear search"
            >
              <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                <line x1="18" y1="6" x2="6" y2="18" />
                <line x1="6" y1="6" x2="18" y2="18" />
              </svg>
            </button>
          )}
        </div>
      </div>

      {/* Inline New Workspace Form */}
      {showNewWs && (
        <form className="projects-new-ws-inline" onSubmit={handleCreateWorkspace}>
          <input
            ref={newWsInputRef}
            type="text"
            className="projects-inline-input"
            placeholder="Workspace name…"
            value={newWsName}
            onChange={(e) => setNewWsName(e.target.value)}
            onKeyDown={(e) => e.key === 'Escape' && setShowNewWs(false)}
          />
          <button type="submit" className="projects-inline-btn primary" disabled={!newWsName.trim()}>
            Create
          </button>
          <button type="button" className="projects-inline-btn" onClick={() => setShowNewWs(false)}>
            Cancel
          </button>
        </form>
      )}

      {/* Main Scrollable Body */}
      <div className="projects-panel-body scrollable">
        {/* Section 1: Standalone Projects */}
        <div className="projects-section-group projects-projects-group">
          <div className="projects-section-header">
            <span className="projects-section-title">Projects</span>
            <span className="projects-section-count">{filteredStandalones.length}</span>
          </div>

          <div className="projects-section-list">
            {filteredStandalones.map((p) => renderProjectCard(p))}
            {filteredStandalones.length === 0 && !search && (
              <div className="projects-section-empty-hint">
                No standalone projects. Open a folder to begin.
              </div>
            )}
          </div>
        </div>

        {/* Section 2: Workspaces */}
        <div className="projects-section-group projects-workspaces-group">
          <div className="projects-section-header">
            <span className="projects-section-title">Workspaces</span>
            <div className="projects-section-header-right">
              <span className="projects-section-count">{filteredWorkspaces.length}</span>
              <button
                type="button"
                className="projects-header-btn mini"
                onClick={() => {
                  setShowNewWs(true);
                  setTimeout(() => newWsInputRef.current?.focus(), 50);
                }}
                title="Create Workspace"
                aria-label="Create Workspace"
              >
                <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
                  <line x1="12" y1="5" x2="12" y2="19" />
                  <line x1="5" y1="12" x2="19" y2="12" />
                </svg>
              </button>
            </div>
          </div>

          <div className="projects-section-list">
            {filteredWorkspaces.map((ws) => {
              const isCollapsed = collapsedWorkspaces.has(ws.id);
              const paths = ws.project_paths || [];
              const wsProjects: ProjectItem[] = paths.map((p) => ({
                workspaceId: ws.id,
                name: getFilename(p),
                path: p,
                isActive: activeWsId === ws.id && activeProjPath === p,
                isInsideWorkspace: true,
              }));

              return (
                <div key={ws.id} className="projects-workspace-card">
                  <div
                    className={`projects-workspace-header${activeWsId === ws.id ? ' active' : ''}`}
                    onClick={() => {
                      if (activeWsId !== ws.id) void openWorkspace(ws.id);
                      else toggleWorkspaceCollapse(ws.id);
                    }}
                    title={activeWsId === ws.id ? 'Collapse workspace' : `Switch to ${ws.name}`}
                  >
                    <button
                      type="button"
                      className={`projects-workspace-chevron${isCollapsed ? ' collapsed' : ''}`}
                      onClick={(e) => {
                        e.stopPropagation();
                        toggleWorkspaceCollapse(ws.id);
                      }}
                      aria-label={isCollapsed ? 'Expand workspace' : 'Collapse workspace'}
                    >
                      <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                        <polyline points="6 9 12 15 18 9" />
                      </svg>
                    </button>

                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="projects-workspace-icon">
                      <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z" />
                    </svg>

                    <span className="projects-workspace-name">{ws.name}</span>
                    <span className="projects-workspace-count">({paths.length})</span>

                    <div className="projects-workspace-actions" onClick={(e) => e.stopPropagation()}>
                      <button
                        type="button"
                        className="hud-card-action-btn"
                        onClick={() => void addProjectToWorkspace(ws.id)}
                        title="Add project to workspace..."
                        aria-label="Add project"
                      >
                        <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
                          <line x1="12" y1="5" x2="12" y2="19" />
                          <line x1="5" y1="12" x2="19" y2="12" />
                        </svg>
                      </button>
                      <button
                        type="button"
                        className="hud-card-action-btn hover-danger"
                        onClick={() => void handleDeleteWorkspace(ws.id, ws.name)}
                        title="Delete workspace"
                        aria-label="Delete workspace"
                      >
                        <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                          <polyline points="3 6 5 6 21 6" />
                          <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
                        </svg>
                      </button>
                    </div>
                  </div>

                  {!isCollapsed && (
                    <div className="projects-workspace-body">
                      {wsProjects.map((p) => renderProjectCard(p, ws.id))}
                      {wsProjects.length === 0 && (
                        <div className="projects-workspace-empty">
                          <span>No projects yet. Click + to add a project.</span>
                        </div>
                      )}
                    </div>
                  )}
                </div>
              );
            })}

            {filteredWorkspaces.length === 0 && !search && (
              <div className="projects-section-empty-hint">
                No workspaces. Create one to group related projects together.
              </div>
            )}
          </div>
        </div>

        {/* Global Empty Search State */}
        {search && filteredStandalones.length === 0 && filteredWorkspaces.length === 0 && (
          <div className="projects-empty-state">
            <p className="projects-empty-title">No projects match "{search}"</p>
            <button type="button" className="projects-empty-action-btn" onClick={() => setSearch('')}>
              Clear Search
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
