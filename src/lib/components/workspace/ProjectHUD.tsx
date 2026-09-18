import { useEffect, useMemo, useRef, useState } from 'react';
import { useWorkspaceStore } from '$lib/stores/zustand/workspace';
import { useStore } from '$lib/react/useStore';
import {
  recentWorkspaces,
  renameProject,
  renameWorkspace,
  reorderRecentWorkspaces,
  reorderWorkspaceProject,
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
import { interactionMode, setInteractionMode } from '$lib/stores/interactionMode';
import {
  chatThreadState,
  createChatThread,
  deleteChatThread,
  selectChatThread,
  toggleChatThreadPinned,
  type ChatThread,
  type ChatThreadStatus,
} from '$lib/stores/chatThreads';
import { getAgentDisplayName } from '$lib/stores/terminal';
import { aiProviders, getProviderDef, type AiProviderId } from '$lib/stores/settings';
import { requestRoomControl } from '$lib/stores/layoutControl';
import './ProjectHUD.css';

function getFilename(path: string): string {
  const normalized = path.replace(/\\/g, '/');
  const parts = normalized.split('/');
  return parts[parts.length - 1] || path;
}

const COLLAPSED_WORKSPACES_KEY = 'spacron.hud.collapsedWorkspaces';
const EXPANDED_PROJECTS_KEY = 'spacron.hud.expandedProjects';
const COLLAPSED_SECTIONS_KEY = 'spacron.hud.collapsedSections';
const PROJECT_SORT_KEY = 'spacron.hud.projectSort';
const WORKSPACE_SORT_KEY = 'spacron.hud.workspaceSort';
const DOUBLE_TAP_MS = 400;

export type SortMode = 'custom' | 'az' | 'za' | 'recent' | 'time';

function sortItems<T extends { name: string; last_opened?: string; id?: string; workspaceId?: string }>(
  items: T[],
  mode: SortMode,
): T[] {
  if (mode === 'custom') return items;
  const copy = [...items];
  if (mode === 'az') {
    copy.sort((a, b) => (a.name || '').localeCompare(b.name || '', undefined, { numeric: true, sensitivity: 'base' }));
  } else if (mode === 'za') {
    copy.sort((a, b) => (b.name || '').localeCompare(a.name || '', undefined, { numeric: true, sensitivity: 'base' }));
  } else if (mode === 'recent') {
    copy.sort((a, b) => {
      const aTime = Number(a.last_opened || 0);
      const bTime = Number(b.last_opened || 0);
      return bTime - aTime;
    });
  } else if (mode === 'time') {
    copy.sort((a, b) => {
      const aId = a.id || a.workspaceId || '';
      const bId = b.id || b.workspaceId || '';
      const aNum = parseInt(aId.replace(/\D/g, '') || '0', 10);
      const bNum = parseInt(bId.replace(/\D/g, '') || '0', 10);
      if (aNum !== bNum) return bNum - aNum;
      return 0;
    });
  }
  return copy;
}

const ROOM_LABELS: Record<string, string> = {
  terminal: 'Terminal',
  editor: 'Editor',
  preview: 'Preview',
  review: 'Review',
  tasks: 'Tasks',
  sketch: 'Sketch',
};

interface ProjectItem {
  workspaceId: string;
  name: string;
  path: string;
  isActive: boolean;
  isInsideWorkspace?: boolean;
  last_opened?: string;
  id?: string;
}

interface ChatSidebarRow {
  id: string;
  projectId: string;
  title: string;
  agentName: string;
  provider: string;
  model: string;
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

  const [search, setSearch] = useState('');
  const [showNewWs, setShowNewWs] = useState(false);
  const [newWsName, setNewWsName] = useState('');
  const [activeMenuKey, setActiveMenuKey] = useState<string | null>(null);
  const [showMoveSubmenu, setShowMoveSubmenu] = useState(false);
  const [threadMenuId, setThreadMenuId] = useState<string | null>(null);
  const [renamingProjectPath, setRenamingProjectPath] = useState<string | null>(null);
  const [renamingProjectName, setRenamingProjectName] = useState('');
  const [renamingWorkspaceId, setRenamingWorkspaceId] = useState<string | null>(null);
  const [renamingWorkspaceName, setRenamingWorkspaceName] = useState('');

  const [collapsedSections, setCollapsedSections] = useState<Set<string>>(() => {
    try {
      const raw = localStorage.getItem(COLLAPSED_SECTIONS_KEY);
      return new Set<string>(raw ? (JSON.parse(raw) as string[]) : []);
    } catch {
      return new Set<string>();
    }
  });

  const [projectSort, setProjectSort] = useState<SortMode>(() => {
    try {
      const raw = localStorage.getItem(PROJECT_SORT_KEY);
      if (raw === 'az' || raw === 'za' || raw === 'recent' || raw === 'time' || raw === 'custom') return raw;
    } catch {}
    return 'custom';
  });

  const [workspaceSort, setWorkspaceSort] = useState<SortMode>(() => {
    try {
      const raw = localStorage.getItem(WORKSPACE_SORT_KEY);
      if (raw === 'az' || raw === 'za' || raw === 'recent' || raw === 'time' || raw === 'custom') return raw;
    } catch {}
    return 'custom';
  });

  function changeProjectSort(mode: SortMode) {
    setProjectSort(mode);
    try {
      localStorage.setItem(PROJECT_SORT_KEY, mode);
    } catch {}
  }

  function changeWorkspaceSort(mode: SortMode) {
    setWorkspaceSort(mode);
    try {
      localStorage.setItem(WORKSPACE_SORT_KEY, mode);
    } catch {}
  }

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
  const projectRenameInputRef = useRef<HTMLInputElement | null>(null);
  const workspaceRenameInputRef = useRef<HTMLInputElement | null>(null);
  const lastCardClickRef = useRef<{ path: string; at: number }>({ path: '', at: 0 });

  const crossProjectSessions = useStore(allProjectSessions);
  const liveOrchestratorTasks = useStore(orchestratorTasks);
  const openRoomsByProject = useStore(projectOpenRooms);
  const allChatThreads = useStore(chatThreadState);
  const currentInteractionMode = useStore(interactionMode);
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
          name: pPath ? (ws.name || getFilename(pPath)) : ws.name,
          path: pPath,
          isActive: activeWsId === ws.id && (activeProjPath === pPath || !activeProjPath),
          isInsideWorkspace: false,
          last_opened: ws.last_opened,
          id: ws.id,
        });
      }
    }
    return { standaloneProjects: standalones, workspaceGroups: groups };
  }, [rawWorkspaces, activeWsId, activeProjPath]);

  // Filtered and sorted lists
  const query = search.toLowerCase().trim();

  const filteredStandalones = useMemo(() => {
    let list = standaloneProjects;
    if (query) {
      list = list.filter(
        (p) => p.name.toLowerCase().includes(query) || p.path.toLowerCase().includes(query)
      );
    }
    return sortItems(list, projectSort);
  }, [standaloneProjects, query, projectSort]);

  const filteredWorkspaces = useMemo(() => {
    let list = workspaceGroups;
    if (query) {
      list = list.filter((ws) => {
        if (ws.name.toLowerCase().includes(query)) return true;
        return (ws.project_paths || []).some((p) =>
          getFilename(p).toLowerCase().includes(query) || p.toLowerCase().includes(query)
        );
      });
    }
    return sortItems(list, workspaceSort);
  }, [workspaceGroups, query, workspaceSort]);

  // Popovers stay open only while the user is interacting with that popover.
  useEffect(() => {
    if (!activeMenuKey && !threadMenuId) return;
    const handler = (event: PointerEvent) => {
      const target = event.target;
      if (!(target instanceof Element)) {
        setActiveMenuKey(null);
        setShowMoveSubmenu(false);
        setThreadMenuId(null);
        return;
      }
      if (!target.closest('.hud-menu-container')) {
        setActiveMenuKey(null);
        setShowMoveSubmenu(false);
      }
      if (!target.closest('.project-thread-actions')) setThreadMenuId(null);
    };
    window.addEventListener('pointerdown', handler);
    return () => window.removeEventListener('pointerdown', handler);
  }, [activeMenuKey, threadMenuId]);

  function beginProjectRename(project: ProjectItem) {
    setActiveMenuKey(null);
    setShowMoveSubmenu(false);
    setRenamingProjectPath(project.path);
    setRenamingProjectName(project.name);
    window.setTimeout(() => projectRenameInputRef.current?.select(), 0);
  }

  async function saveProjectRename(projectPath: string, value: string) {
    const name = value.trim();
    setRenamingProjectPath(null);
    setRenamingProjectName('');
    if (!name) return;
    try {
      await renameProject(projectPath, name);
    } catch (error) {
      const { showToast } = await import('$lib/stores/notification');
      showToast(error instanceof Error ? error.message : String(error), 'error', 5000);
    }
  }

  function beginWorkspaceRename(ws: { id: string; name: string }) {
    setActiveMenuKey(null);
    setShowMoveSubmenu(false);
    setRenamingWorkspaceId(ws.id);
    setRenamingWorkspaceName(ws.name);
    window.setTimeout(() => workspaceRenameInputRef.current?.select(), 0);
  }

  function saveWorkspaceRename(workspaceId: string, value: string) {
    const name = value.trim();
    setRenamingWorkspaceId(null);
    setRenamingWorkspaceName('');
    if (!name) return;
    renameWorkspace(workspaceId, name);
  }

  function toggleSectionCollapse(sectionKey: string) {
    setCollapsedSections((prev) => {
      const next = new Set(prev);
      if (next.has(sectionKey)) next.delete(sectionKey);
      else next.add(sectionKey);
      try {
        localStorage.setItem(COLLAPSED_SECTIONS_KEY, JSON.stringify(Array.from(next)));
      } catch {}
      return next;
    });
  }

  function handleMoveStandalone(p: ProjectItem, direction: 'up' | 'down') {
    const currentIndex = standaloneProjects.findIndex((item) => item.workspaceId === p.workspaceId);
    if (currentIndex < 0) return;
    const targetIndex = direction === 'up' ? currentIndex - 1 : currentIndex + 1;
    if (targetIndex < 0 || targetIndex >= standaloneProjects.length) return;

    const currentWsId = standaloneProjects[currentIndex].workspaceId;
    const targetWsId = standaloneProjects[targetIndex].workspaceId;

    const rawCurrentIdx = rawWorkspaces.findIndex((w) => w.id === currentWsId);
    const rawTargetIdx = rawWorkspaces.findIndex((w) => w.id === targetWsId);

    if (rawCurrentIdx >= 0 && rawTargetIdx >= 0) {
      changeProjectSort('custom');
      reorderRecentWorkspaces(rawCurrentIdx, rawTargetIdx);
    }
  }

  function handleMoveWorkspace(wsId: string, direction: 'up' | 'down') {
    const currentIndex = workspaceGroups.findIndex((w) => w.id === wsId);
    if (currentIndex < 0) return;
    const targetIndex = direction === 'up' ? currentIndex - 1 : currentIndex + 1;
    if (targetIndex < 0 || targetIndex >= workspaceGroups.length) return;

    const currentWsId = workspaceGroups[currentIndex].id;
    const targetWsId = workspaceGroups[targetIndex].id;

    const rawCurrentIdx = rawWorkspaces.findIndex((w) => w.id === currentWsId);
    const rawTargetIdx = rawWorkspaces.findIndex((w) => w.id === targetWsId);

    if (rawCurrentIdx >= 0 && rawTargetIdx >= 0) {
      changeWorkspaceSort('custom');
      reorderRecentWorkspaces(rawCurrentIdx, rawTargetIdx);
    }
  }

  function handleMoveWorkspaceProject(wsId: string, projectPath: string, direction: 'up' | 'down') {
    const ws = workspaceGroups.find((w) => w.id === wsId);
    if (!ws || !ws.project_paths) return;
    const currentIndex = ws.project_paths.indexOf(projectPath);
    if (currentIndex < 0) return;
    const targetIndex = direction === 'up' ? currentIndex - 1 : currentIndex + 1;
    if (targetIndex < 0 || targetIndex >= ws.project_paths.length) return;

    changeProjectSort('custom');
    reorderWorkspaceProject(wsId, currentIndex, targetIndex);
  }

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
    const projectId = p.path ? projectIdByPath.get(p.path) ?? null : null;
    const projectSessions = projectId ? sessionsByProject.get(projectId) ?? [] : [];
    const projectRooms = projectId ? openRoomsByProject.get(projectId) ?? [] : [];
    const allProjectTasks = projectId ? tasksByProject.get(projectId) ?? [] : [];
    const storedThreads = projectId ? allChatThreads.threadsByProject[projectId] ?? [] : [];
    const activeThreadId = projectId ? allChatThreads.activeThreadByProject[projectId] ?? null : null;
    const taskById = new Map(allProjectTasks.map((task) => [task.id, task]));
    const sessionById = new Map(projectSessions.map((session) => [session.id, session]));
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
      const brainProvider = thread.provider && aiProviders.some((provider) => provider.id === thread.provider)
        ? getProviderDef(thread.provider as AiProviderId)
        : null;
      const agentName = thread.agentName
        ?? task?.name
        ?? (session ? getSessionPromptTargetLabel(session, projectSessions) : null)
        ?? getAgentDisplayName(agentPreset)
        ?? 'Spacron';
      return {
        id: thread.id,
        projectId: thread.projectId,
        title: thread.title,
        agentName,
        provider: brainProvider?.label ?? getAgentDisplayName(agentPreset) ?? agentPreset ?? 'Spacron',
        model: thread.model?.trim() || brainProvider?.defaultModel || 'Default model',
        status,
        unreadCount: thread.unreadCount,
        thread,
        task,
        session,
      };
    });
    chatRows.sort((a, b) => {
      const pinnedRank = Number(Boolean(b.thread?.pinned)) - Number(Boolean(a.thread?.pinned));
      if (pinnedRank !== 0) return pinnedRank;
      const rank = chatStatusRank(a.status) - chatStatusRank(b.status);
      if (rank !== 0) return rank;
      const aActivity = a.thread?.lastActivityAt ?? a.task?.completedAt ?? a.task?.startedAt ?? a.task?.createdAt ?? a.session?.lastActivatedAt ?? 0;
      const bActivity = b.thread?.lastActivityAt ?? b.task?.completedAt ?? b.task?.startedAt ?? b.task?.createdAt ?? b.session?.lastActivatedAt ?? 0;
      return bActivity - aActivity;
    });
    const hasOpenContents = projectSessions.length > 0 || projectRooms.length > 0 || allProjectTasks.length > 0;
    const hasContents = hasOpenContents || chatRows.length > 0 || Boolean(p.path);
    const isExpanded = p.path ? expandedProjects.has(p.path) : false;
    const parentWs = parentWorkspaceId ? workspaceGroups.find((w) => w.id === parentWorkspaceId) : null;
    const projIndex = parentWs?.project_paths ? parentWs.project_paths.indexOf(p.path) : -1;
    const standaloneIndex = !parentWorkspaceId ? standaloneProjects.findIndex((item) => item.workspaceId === p.workspaceId) : -1;

    const canMoveUp = parentWorkspaceId ? projIndex > 0 : standaloneIndex > 0;
    const canMoveDown = parentWorkspaceId
      ? parentWs?.project_paths != null && projIndex >= 0 && projIndex < parentWs.project_paths.length - 1
      : standaloneIndex >= 0 && standaloneIndex < standaloneProjects.length - 1;

    const projectMenuKey = `proj-menu:${parentWorkspaceId ?? 'root'}:${p.path}`;
    const showOptionsMenu = activeMenuKey === projectMenuKey;

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
            <svg width="21" height="21" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" className="project-code-icon" aria-hidden="true">
              <path d="m6 14 1.5-2.9A2 2 0 0 1 9.24 10H20a2 2 0 0 1 1.94 2.5l-1.54 6a2 2 0 0 1-1.95 1.5H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h3.9a2 2 0 0 1 1.69.9l.81 1.2a2 2 0 0 0 1.67.9H18a2 2 0 0 1 2 2v2" />
            </svg>
          </div>

          <div className="project-sidebar-card-info">
            <div className="project-sidebar-card-name-row">
              {renamingProjectPath === p.path ? (
                <input
                  ref={projectRenameInputRef}
                  className="project-sidebar-card-name-input"
                  value={renamingProjectName}
                  maxLength={255}
                  aria-label={`Rename ${p.name}`}
                  onClick={(event) => event.stopPropagation()}
                  onChange={(event) => setRenamingProjectName(event.target.value)}
                  onBlur={(event) => void saveProjectRename(p.path, event.currentTarget.value)}
                  onKeyDown={(event) => {
                    event.stopPropagation();
                    if (event.key === 'Enter') event.currentTarget.blur();
                    if (event.key === 'Escape') {
                      setRenamingProjectPath(null);
                      setRenamingProjectName('');
                    }
                  }}
                />
              ) : (
                <span className="project-sidebar-card-name" title={p.name}>{p.name}</span>
              )}
              {p.isActive && (
                <span className="project-active-badge">
                  <span className="project-active-dot" />
                  Active
                </span>
              )}
            </div>

          </div>

          {/* Action Buttons: Three Dots Menu */}
          <div className={`project-card-actions hud-menu-container${showOptionsMenu ? ' has-active-menu' : ''}`} onClick={(e) => e.stopPropagation()}>
            <button
              type="button"
              className="hud-card-action-btn hud-options-trigger"
              onClick={() => {
                setShowMoveSubmenu(false);
                setActiveMenuKey(showOptionsMenu ? null : projectMenuKey);
              }}
              title="Project actions"
              aria-label={`Actions for ${p.name}`}
              aria-expanded={showOptionsMenu}
            >
              <svg width="13" height="13" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
                <circle cx="12" cy="5" r="2" />
                <circle cx="12" cy="12" r="2" />
                <circle cx="12" cy="19" r="2" />
              </svg>
            </button>

            {showOptionsMenu && (
              <div className="hud-options-menu" role="menu">
                {showMoveSubmenu ? (
                  <div className="hud-submenu">
                    <div className="hud-submenu-header">
                      <button
                        type="button"
                        className="hud-submenu-back-btn"
                        onClick={() => setShowMoveSubmenu(false)}
                        title="Back to options"
                      >
                        <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                          <polyline points="15 18 9 12 15 6" />
                        </svg>
                        <span>Back</span>
                      </button>
                      <span className="hud-submenu-title">Move to</span>
                    </div>
                    {workspaceGroups
                      .filter((ws) => ws.id !== parentWorkspaceId)
                      .map((ws) => (
                        <button
                          key={ws.id}
                          type="button"
                          className="hud-options-menu-item"
                          onClick={() => {
                            moveProjectToWorkspace(p.path, ws.id);
                            setActiveMenuKey(null);
                            setShowMoveSubmenu(false);
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
                        className="hud-options-menu-item"
                        onClick={() => {
                          moveProjectToStandalone(p.path, parentWorkspaceId);
                          setActiveMenuKey(null);
                          setShowMoveSubmenu(false);
                        }}
                      >
                        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                          <path d="m6 14 1.5-2.9A2 2 0 0 1 9.24 10H20a2 2 0 0 1 1.94 2.5l-1.54 6a2 2 0 0 1-1.95 1.5H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h3.9a2 2 0 0 1 1.69.9l.81 1.2a2 2 0 0 0 1.67.9H18a2 2 0 0 1 2 2v2" />
                        </svg>
                        <span>Move to Standalone</span>
                      </button>
                    )}

                    {workspaceGroups.length === 0 && !parentWorkspaceId && (
                      <div className="hud-options-menu-empty">No workspaces created yet</div>
                    )}
                  </div>
                ) : (
                  <>
                    <button
                      type="button"
                      className="hud-options-menu-item"
                      role="menuitem"
                      disabled={!canMoveUp}
                      onClick={() => {
                        if (parentWorkspaceId) {
                          handleMoveWorkspaceProject(parentWorkspaceId, p.path, 'up');
                        } else {
                          handleMoveStandalone(p, 'up');
                        }
                        setActiveMenuKey(null);
                      }}
                    >
                      <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                        <line x1="12" y1="19" x2="12" y2="5" />
                        <polyline points="5 12 12 5 19 12" />
                      </svg>
                      <span>Move Up</span>
                    </button>

                    <button
                      type="button"
                      className="hud-options-menu-item"
                      role="menuitem"
                      disabled={!canMoveDown}
                      onClick={() => {
                        if (parentWorkspaceId) {
                          handleMoveWorkspaceProject(parentWorkspaceId, p.path, 'down');
                        } else {
                          handleMoveStandalone(p, 'down');
                        }
                        setActiveMenuKey(null);
                      }}
                    >
                      <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                        <line x1="12" y1="5" x2="12" y2="19" />
                        <polyline points="19 12 12 19 5 12" />
                      </svg>
                      <span>Move Down</span>
                    </button>

                    <div className="hud-options-menu-divider" />

                    <button
                      type="button"
                      className="hud-options-menu-item"
                      role="menuitem"
                      onClick={() => setShowMoveSubmenu(true)}
                    >
                      <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                        <path d="M3 7h7l2 2h9v10a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2Z" />
                        <path d="m10 13 2 2 2-2M12 15v-5" />
                      </svg>
                      <span>Move to Workspace...</span>
                    </button>

                    <button
                      type="button"
                      className="hud-options-menu-item"
                      role="menuitem"
                      onClick={() => {
                        setActiveMenuKey(null);
                        beginProjectRename(p);
                      }}
                    >
                      <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                        <path d="M12 20h9" />
                        <path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L8 18l-4 1 1-4Z" />
                      </svg>
                      <span>Rename Project</span>
                    </button>

                    <div className="hud-options-menu-divider" />

                    <button
                      type="button"
                      className="hud-options-menu-item danger"
                      role="menuitem"
                      onClick={() => {
                        setActiveMenuKey(null);
                        if (parentWorkspaceId) {
                          void removeProjectFromCollection(parentWorkspaceId, p.path);
                        } else {
                          void handleRemoveStandalone(p.workspaceId, p.name);
                        }
                      }}
                    >
                      <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                        <polyline points="3 6 5 6 21 6" />
                        <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
                      </svg>
                      <span>{parentWorkspaceId ? 'Remove from Workspace' : 'Remove from Project List'}</span>
                    </button>
                  </>
                )}
              </div>
            )}
          </div>
        </div>

        {/* Expanded Contents */}
        {isExpanded && p.path && (
          <div className="project-contents">
            {currentInteractionMode === 'chat' && (
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
                          title={`${row.title} · ${row.provider} · ${row.model} · ${chatStatusLabel(row.status)}`}
                        >
                          <span className="project-thread-copy">
                            <span className="project-thread-title-line">
                              <strong>{row.title || 'New conversation'}</strong>
                              {row.thread?.pinned && (
                                <svg className="project-thread-pin" width="12" height="12" viewBox="0 0 24 24" fill="currentColor" aria-label="Pinned thread" role="img">
                                  <path d="M16 9V4h1V2H7v2h1v5c0 1.66-1.34 3-3 3v2h5v8h2v-8h5v-2c-1.66 0-3-1.34-3-3Z" />
                                </svg>
                              )}
                            </span>
                            <span className="project-thread-meta">
                              <span className="project-thread-status" aria-hidden="true" />
                              <span className="project-thread-provider" title={`${row.provider} · ${row.model}`}>
                                {row.provider} · {row.model}
                              </span>
                              <span className="project-thread-meta-sep" aria-hidden="true">·</span>
                              <span className="project-thread-state">{chatStatusLabel(row.status)}</span>
                            </span>
                          </span>
                          {row.unreadCount > 0 && <span className="project-thread-unread" title={`${row.unreadCount} unread`} />}
                        </button>
                        {row.thread && (
                          <div className="project-thread-actions">
                            <button
                              type="button"
                              className="project-thread-action-btn"
                              onClick={(event) => {
                                event.stopPropagation();
                                setThreadMenuId((current) => current === row.thread?.id ? null : row.thread?.id ?? null);
                              }}
                              title="Thread actions"
                              aria-label={`Actions for ${row.title}`}
                              aria-expanded={threadMenuId === row.thread.id}
                            >
                              <svg width="13" height="13" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
                                <circle cx="12" cy="5" r="2" />
                                <circle cx="12" cy="12" r="2" />
                                <circle cx="12" cy="19" r="2" />
                              </svg>
                            </button>
                            {threadMenuId === row.thread.id && (
                              <div className="project-thread-action-menu" role="menu">
                                <button
                                  type="button"
                                  role="menuitem"
                                  onClick={(event) => {
                                    event.stopPropagation();
                                    toggleChatThreadPinned(row.thread!.id);
                                    setThreadMenuId(null);
                                  }}
                                >
                                  {row.thread.pinned ? 'Unpin' : 'Pin'}
                                </button>
                                <button
                                  type="button"
                                  role="menuitem"
                                  className="danger"
                                  onClick={(event) => {
                                    event.stopPropagation();
                                    if (window.confirm(`Delete “${row.thread?.title ?? 'this thread'}”?`)) {
                                      deleteChatThread(row.thread!.id);
                                    }
                                    setThreadMenuId(null);
                                  }}
                                >
                                  Delete
                                </button>
                              </div>
                            )}
                          </div>
                        )}
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
            )}
            {currentInteractionMode === 'cli' && !hasOpenContents && (
              <div className="project-contents-empty">Nothing open in this project</div>
            )}
            {currentInteractionMode === 'cli' && <>
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
            </>}
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
        {/* WORKSPACES SECTION */}
        {(() => {
          const isWorkspacesCollapsed = collapsedSections.has('workspaces');
          const wsSortMenuKey = 'section-sort:workspaces';
          const isWsSortMenuOpen = activeMenuKey === wsSortMenuKey;

          return (
            <div key="workspaces" className="projects-section-group">
              <div
                className="projects-section-header"
                onClick={() => toggleSectionCollapse('workspaces')}
                title={isWorkspacesCollapsed ? 'Expand Workspaces section' : 'Collapse Workspaces section'}
              >
                <div className="projects-section-header-left">
                  <button
                    type="button"
                    className={`projects-section-chevron${isWorkspacesCollapsed ? ' collapsed' : ''}`}
                    onClick={(e) => {
                      e.stopPropagation();
                      toggleSectionCollapse('workspaces');
                    }}
                    aria-label={isWorkspacesCollapsed ? 'Expand Workspaces' : 'Collapse Workspaces'}
                  >
                    <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                      <polyline points="6 9 12 15 18 9" />
                    </svg>
                  </button>
                  <span className="projects-section-title">Workspaces</span>
                </div>

                <div className="projects-section-header-right" onClick={(e) => e.stopPropagation()}>
                  {/* Sort button & popover */}
                  <div className={`hud-menu-container${isWsSortMenuOpen ? ' has-active-menu' : ''}`} style={{ position: 'relative' }}>
                    <button
                      type="button"
                      className={`projects-header-btn mini hud-options-trigger${workspaceSort !== 'custom' ? ' active' : ''}`}
                      onClick={() => setActiveMenuKey(isWsSortMenuOpen ? null : wsSortMenuKey)}
                      title={`Sort Workspaces (${workspaceSort === 'az' ? 'A to Z' : workspaceSort === 'za' ? 'Z to A' : workspaceSort === 'recent' ? 'Recent works' : workspaceSort === 'time' ? 'By timing' : 'Custom'})`}
                      aria-label="Sort Workspaces"
                      aria-expanded={isWsSortMenuOpen}
                    >
                      <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
                        <line x1="4" y1="6" x2="20" y2="6" />
                        <line x1="4" y1="12" x2="14" y2="12" />
                        <line x1="4" y1="18" x2="8" y2="18" />
                      </svg>
                    </button>

                    {isWsSortMenuOpen && (
                      <div className="hud-options-menu" role="menu">
                        <div className="hud-options-menu-header">Sort Workspaces</div>
                        <button
                          type="button"
                          className={`hud-options-menu-item${workspaceSort === 'az' ? ' active' : ''}`}
                          role="menuitem"
                          onClick={() => {
                            changeWorkspaceSort('az');
                            setActiveMenuKey(null);
                          }}
                        >
                          <span>A to Z</span>
                          {workspaceSort === 'az' && (
                            <span className="hud-sort-check">
                              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
                                <polyline points="20 6 9 17 4 12" />
                              </svg>
                            </span>
                          )}
                        </button>
                        <button
                          type="button"
                          className={`hud-options-menu-item${workspaceSort === 'za' ? ' active' : ''}`}
                          role="menuitem"
                          onClick={() => {
                            changeWorkspaceSort('za');
                            setActiveMenuKey(null);
                          }}
                        >
                          <span>Z to A</span>
                          {workspaceSort === 'za' && (
                            <span className="hud-sort-check">
                              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
                                <polyline points="20 6 9 17 4 12" />
                              </svg>
                            </span>
                          )}
                        </button>
                        <button
                          type="button"
                          className={`hud-options-menu-item${workspaceSort === 'recent' ? ' active' : ''}`}
                          role="menuitem"
                          onClick={() => {
                            changeWorkspaceSort('recent');
                            setActiveMenuKey(null);
                          }}
                        >
                          <span>Recent works</span>
                          {workspaceSort === 'recent' && (
                            <span className="hud-sort-check">
                              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
                                <polyline points="20 6 9 17 4 12" />
                              </svg>
                            </span>
                          )}
                        </button>
                        <button
                          type="button"
                          className={`hud-options-menu-item${workspaceSort === 'time' ? ' active' : ''}`}
                          role="menuitem"
                          onClick={() => {
                            changeWorkspaceSort('time');
                            setActiveMenuKey(null);
                          }}
                        >
                          <span>By timing</span>
                          {workspaceSort === 'time' && (
                            <span className="hud-sort-check">
                              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
                                <polyline points="20 6 9 17 4 12" />
                              </svg>
                            </span>
                          )}
                        </button>
                      </div>
                    )}
                  </div>

                  {/* Create Workspace button */}
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

              {!isWorkspacesCollapsed && (
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

                    const wsIndex = workspaceGroups.findIndex((w) => w.id === ws.id);
                    const canWsMoveUp = wsIndex > 0;
                    const canWsMoveDown = wsIndex >= 0 && wsIndex < workspaceGroups.length - 1;
                    const wsMenuKey = `ws-menu:${ws.id}`;
                    const showWsMenu = activeMenuKey === wsMenuKey;

                    return (
                      <div key={ws.id} className="projects-workspace-card">
                        <div
                          className={`projects-workspace-header${activeWsId === ws.id ? ' active' : ''}`}
                          onClick={() => {
                            toggleWorkspaceCollapse(ws.id);
                            if (activeWsId !== ws.id) void openWorkspace(ws.id);
                          }}
                          title={isCollapsed ? `Expand ${ws.name}` : `Collapse ${ws.name}`}
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

                          {renamingWorkspaceId === ws.id ? (
                            <input
                              ref={workspaceRenameInputRef}
                              className="projects-workspace-rename-input"
                              value={renamingWorkspaceName}
                              maxLength={255}
                              aria-label={`Rename ${ws.name}`}
                              onClick={(e) => e.stopPropagation()}
                              onChange={(e) => setRenamingWorkspaceName(e.target.value)}
                              onBlur={(e) => void saveWorkspaceRename(ws.id, e.currentTarget.value)}
                              onKeyDown={(e) => {
                                e.stopPropagation();
                                if (e.key === 'Enter') e.currentTarget.blur();
                                if (e.key === 'Escape') {
                                  setRenamingWorkspaceId(null);
                                  setRenamingWorkspaceName('');
                                }
                              }}
                            />
                          ) : (
                            <span className="projects-workspace-name" title={ws.name}>{ws.name}</span>
                          )}

                          <span className="projects-workspace-count">({paths.length})</span>

                          <div className={`projects-workspace-actions hud-menu-container${showWsMenu ? ' has-active-menu' : ''}`} onClick={(e) => e.stopPropagation()}>
                            <button
                              type="button"
                              className="hud-card-action-btn hud-options-trigger"
                              onClick={() => setActiveMenuKey(showWsMenu ? null : wsMenuKey)}
                              title="Workspace actions"
                              aria-label={`Actions for ${ws.name}`}
                              aria-expanded={showWsMenu}
                            >
                              <svg width="13" height="13" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
                                <circle cx="12" cy="5" r="2" />
                                <circle cx="12" cy="12" r="2" />
                                <circle cx="12" cy="19" r="2" />
                              </svg>
                            </button>

                            {showWsMenu && (
                              <div className="hud-options-menu" role="menu">
                                <button
                                  type="button"
                                  className="hud-options-menu-item"
                                  role="menuitem"
                                  disabled={!canWsMoveUp}
                                  onClick={() => {
                                    handleMoveWorkspace(ws.id, 'up');
                                    setActiveMenuKey(null);
                                  }}
                                >
                                  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                                    <line x1="12" y1="19" x2="12" y2="5" />
                                    <polyline points="5 12 12 5 19 12" />
                                  </svg>
                                  <span>Move Up</span>
                                </button>

                                <button
                                  type="button"
                                  className="hud-options-menu-item"
                                  role="menuitem"
                                  disabled={!canWsMoveDown}
                                  onClick={() => {
                                    handleMoveWorkspace(ws.id, 'down');
                                    setActiveMenuKey(null);
                                  }}
                                >
                                  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                                    <line x1="12" y1="5" x2="12" y2="19" />
                                    <polyline points="19 12 12 19 5 12" />
                                  </svg>
                                  <span>Move Down</span>
                                </button>

                                <div className="hud-options-menu-divider" />

                                <button
                                  type="button"
                                  className="hud-options-menu-item"
                                  role="menuitem"
                                  onClick={() => {
                                    setActiveMenuKey(null);
                                    void addProjectToWorkspace(ws.id);
                                  }}
                                >
                                  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
                                    <line x1="12" y1="5" x2="12" y2="19" />
                                    <line x1="5" y1="12" x2="19" y2="12" />
                                  </svg>
                                  <span>Add Project...</span>
                                </button>

                                <button
                                  type="button"
                                  className="hud-options-menu-item"
                                  role="menuitem"
                                  onClick={() => {
                                    setActiveMenuKey(null);
                                    beginWorkspaceRename(ws);
                                  }}
                                >
                                  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                                    <path d="M12 20h9" />
                                    <path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L8 18l-4 1 1-4Z" />
                                  </svg>
                                  <span>Rename Workspace</span>
                                </button>

                                <div className="hud-options-menu-divider" />

                                <button
                                  type="button"
                                  className="hud-options-menu-item danger"
                                  role="menuitem"
                                  onClick={() => {
                                    setActiveMenuKey(null);
                                    void handleDeleteWorkspace(ws.id, ws.name);
                                  }}
                                >
                                  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                                    <polyline points="3 6 5 6 21 6" />
                                    <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
                                  </svg>
                                  <span>Delete Workspace</span>
                                </button>
                              </div>
                            )}
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
              )}
            </div>
          );
        })()}

        {/* PROJECTS SECTION */}
        {(() => {
          const isProjectsCollapsed = collapsedSections.has('projects');
          const projSortMenuKey = 'section-sort:projects';
          const isProjSortMenuOpen = activeMenuKey === projSortMenuKey;

          return (
            <div key="projects" className="projects-section-group">
              <div
                className="projects-section-header"
                onClick={() => toggleSectionCollapse('projects')}
                title={isProjectsCollapsed ? 'Expand Projects section' : 'Collapse Projects section'}
              >
                <div className="projects-section-header-left">
                  <button
                    type="button"
                    className={`projects-section-chevron${isProjectsCollapsed ? ' collapsed' : ''}`}
                    onClick={(e) => {
                      e.stopPropagation();
                      toggleSectionCollapse('projects');
                    }}
                    aria-label={isProjectsCollapsed ? 'Expand Projects' : 'Collapse Projects'}
                  >
                    <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                      <polyline points="6 9 12 15 18 9" />
                    </svg>
                  </button>
                  <span className="projects-section-title">Projects</span>
                </div>

                <div className="projects-section-header-right" onClick={(e) => e.stopPropagation()}>
                  {/* Sort button & popover */}
                  <div className={`hud-menu-container${isProjSortMenuOpen ? ' has-active-menu' : ''}`} style={{ position: 'relative' }}>
                    <button
                      type="button"
                      className={`projects-header-btn mini hud-options-trigger${projectSort !== 'custom' ? ' active' : ''}`}
                      onClick={() => setActiveMenuKey(isProjSortMenuOpen ? null : projSortMenuKey)}
                      title={`Sort Projects (${projectSort === 'az' ? 'A to Z' : projectSort === 'za' ? 'Z to A' : projectSort === 'recent' ? 'Recent works' : projectSort === 'time' ? 'By timing' : 'Custom'})`}
                      aria-label="Sort Projects"
                      aria-expanded={isProjSortMenuOpen}
                    >
                      <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
                        <line x1="4" y1="6" x2="20" y2="6" />
                        <line x1="4" y1="12" x2="14" y2="12" />
                        <line x1="4" y1="18" x2="8" y2="18" />
                      </svg>
                    </button>

                    {isProjSortMenuOpen && (
                      <div className="hud-options-menu" role="menu">
                        <div className="hud-options-menu-header">Sort Projects</div>
                        <button
                          type="button"
                          className={`hud-options-menu-item${projectSort === 'az' ? ' active' : ''}`}
                          role="menuitem"
                          onClick={() => {
                            changeProjectSort('az');
                            setActiveMenuKey(null);
                          }}
                        >
                          <span>A to Z</span>
                          {projectSort === 'az' && (
                            <span className="hud-sort-check">
                              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
                                <polyline points="20 6 9 17 4 12" />
                              </svg>
                            </span>
                          )}
                        </button>
                        <button
                          type="button"
                          className={`hud-options-menu-item${projectSort === 'za' ? ' active' : ''}`}
                          role="menuitem"
                          onClick={() => {
                            changeProjectSort('za');
                            setActiveMenuKey(null);
                          }}
                        >
                          <span>Z to A</span>
                          {projectSort === 'za' && (
                            <span className="hud-sort-check">
                              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
                                <polyline points="20 6 9 17 4 12" />
                              </svg>
                            </span>
                          )}
                        </button>
                        <button
                          type="button"
                          className={`hud-options-menu-item${projectSort === 'recent' ? ' active' : ''}`}
                          role="menuitem"
                          onClick={() => {
                            changeProjectSort('recent');
                            setActiveMenuKey(null);
                          }}
                        >
                          <span>Recent works</span>
                          {projectSort === 'recent' && (
                            <span className="hud-sort-check">
                              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
                                <polyline points="20 6 9 17 4 12" />
                              </svg>
                            </span>
                          )}
                        </button>
                        <button
                          type="button"
                          className={`hud-options-menu-item${projectSort === 'time' ? ' active' : ''}`}
                          role="menuitem"
                          onClick={() => {
                            changeProjectSort('time');
                            setActiveMenuKey(null);
                          }}
                        >
                          <span>By timing</span>
                          {projectSort === 'time' && (
                            <span className="hud-sort-check">
                              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
                                <polyline points="20 6 9 17 4 12" />
                              </svg>
                            </span>
                          )}
                        </button>
                      </div>
                    )}
                  </div>
                </div>
              </div>

              {!isProjectsCollapsed && (
                <div className="projects-section-list">
                  {filteredStandalones.map((p) => renderProjectCard(p))}
                  {filteredStandalones.length === 0 && !search && (
                    <div className="projects-section-empty-hint">
                      No standalone projects. Open a folder to begin.
                    </div>
                  )}
                </div>
              )}
            </div>
          );
        })()}

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
