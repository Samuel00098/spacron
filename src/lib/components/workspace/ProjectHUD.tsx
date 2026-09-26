import { Fragment, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { useWorkspaceStore } from '$lib/stores/zustand/workspace';
import { useStore } from '$lib/react/useStore';
import {
  recentWorkspaces,
  renameProject,
  reorderRecentWorkspaces,
  reorderWorkspaceProject,
  openWorkspace,
  switchToProject,
  deleteCollection,
  removeProjectFromCollection,
  projectOpenRooms,
  isProjectSwitching,
  seedProjectRoomsFromStorage,
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
  closeChatThread,
  createChatThread,
  selectChatThread,
  setChatThreadArchived,
  toggleChatThreadPinned,
  type ChatThread,
  type ChatThreadStatus,
} from '$lib/stores/chatThreads';
import { getAgentDisplayName } from '$lib/stores/terminal';
import { aiProviders, getProviderDef, type AiProviderId } from '$lib/stores/settings';
import { hoveredStageRoom, layoutSnapshot, requestRoomControl, type RoomOp } from '$lib/stores/layoutControl';
import { isFullscreenRoom } from '$lib/components/layout/fullscreenRooms';
import { deepSeekAgentName, deepSeekPanelRoot, deepSeekPlacements } from '$lib/services/deepseek-harness';
import { AgentBrandMark } from '$lib/components/shared/useAgentBrand';
import {
  HIDDEN_PROJECTS_KEY,
  PINNED_PROJECTS_KEY,
  applyProjectPrefs,
  loadPathSet,
  normalizeProjectPath,
  savePathSet,
  togglePath,
} from './projectListPrefs';
import './ProjectHUD.css';
import PinIcon from '$lib/components/shared/PinIcon';

function getFilename(path: string): string {
  const normalized = path.replace(/\\/g, '/');
  const parts = normalized.split('/');
  return parts[parts.length - 1] || path;
}

const EXPANDED_PROJECTS_KEY = 'spacron.hud.expandedProjects';

interface KnownProject {
  id: string;
  root_path: string;
}

function mergeKnownProjects(prev: Map<string, KnownProject>, incoming: Iterable<KnownProject>): Map<string, KnownProject> {
  let next: Map<string, KnownProject> | null = null;
  for (const project of incoming) {
    const current = (next ?? prev).get(project.id);
    if (current && current.root_path === project.root_path) continue;
    next ??= new Map(prev);
    next.set(project.id, { id: project.id, root_path: project.root_path });
  }
  return next ?? prev;
}
const COLLAPSED_SECTIONS_KEY = 'spacron.hud.collapsedSections';
const PROJECT_SORT_KEY = 'spacron.hud.projectSort';
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

// A room's mark, at the 12px the Running rows give it. The paths are copied from
// AppShell's `roomIcon`, so a tool reads as the same mark in the tree as in its
// own room header.
function Glyph({ children }: { children: ReactNode }) {
  return (
    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      {children}
    </svg>
  );
}

const ROOM_GLYPHS: Record<string, ReactNode> = {
  terminal: (
    <Glyph>
      <rect x="2" y="3" width="20" height="18" rx="3" />
      <polyline points="8,9 4,12 8,15" />
      <line x1="12" y1="15" x2="20" y2="15" />
    </Glyph>
  ),
  editor: (
    <Glyph>
      <path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7" />
      <path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z" />
    </Glyph>
  ),
  preview: (
    <Glyph>
      <rect x="3" y="4" width="18" height="13" rx="2" />
      <path d="M8 21h8M12 17v4" />
    </Glyph>
  ),
  tasks: (
    <Glyph>
      <rect x="3" y="3" width="5" height="18" rx="1" />
      <rect x="10" y="3" width="5" height="12" rx="1" />
      <rect x="17" y="3" width="5" height="8" rx="1" />
    </Glyph>
  ),
  sketch: (
    <Glyph>
      <path d="M12 20h9" />
      <path d="M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4 9.5-9.5z" />
    </Glyph>
  ),
};

// Anything the room list can carry that has no glyph of its own still gets a row
// (a bare panel) rather than vanishing from the list.
const DEFAULT_ROOM_GLYPH = (
  <Glyph>
    <rect x="3" y="4" width="18" height="16" rx="2" />
  </Glyph>
);

// Rooms with a richer row of their own above the generic ones: preview says what
// state it is in, DeepSeek shows its assistant name and whether it is isolated.
const ROOMS_WITH_OWN_ROW = new Set(['preview', 'editor', 'deepseek']);

const TOOL_ROW_LABELS: Record<string, string> = {
  terminal: 'Terminal',
  tasks: 'Tasks',
  sketch: 'Sketch',
};

interface ProjectItem {
  // Id of the recents entry that stores this project. It is the handle every
  // store call needs; the sidebar itself only ever shows a flat project list.
  workspaceId: string;
  name: string;
  path: string;
  isActive: boolean;
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
  const [projectSearchOpen, setProjectSearchOpen] = useState(false);
  const [activeMenuKey, setActiveMenuKey] = useState<string | null>(null);
  const [threadMenuId, setThreadMenuId] = useState<string | null>(null);
  const [renamingProjectPath, setRenamingProjectPath] = useState<string | null>(null);
  const [renamingProjectName, setRenamingProjectName] = useState('');

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

  function changeProjectSort(mode: SortMode) {
    setProjectSort(mode);
    try {
      localStorage.setItem(PROJECT_SORT_KEY, mode);
    } catch {}
  }

  const [expandedProjects, setExpandedProjects] = useState<Set<string>>(() => {
    try {
      const raw = localStorage.getItem(EXPANDED_PROJECTS_KEY);
      return new Set<string>(raw ? (JSON.parse(raw) as string[]) : []);
    } catch {
      return new Set<string>();
    }
  });

  const [hiddenProjects, setHiddenProjects] = useState<Set<string>>(() => loadPathSet(HIDDEN_PROJECTS_KEY));
  const [pinnedProjects, setPinnedProjects] = useState<Set<string>>(() => loadPathSet(PINNED_PROJECTS_KEY));
  // Per-project "Archived" thread group; collapsed unless opened this session.
  const [openArchivedGroups, setOpenArchivedGroups] = useState<Set<string>>(new Set());

  function setProjectHidden(path: string, hidden: boolean) {
    setHiddenProjects((prev) => {
      const next = togglePath(prev, path, hidden);
      savePathSet(HIDDEN_PROJECTS_KEY, next);
      return next;
    });
  }

  function unhideAllProjects() {
    const next = new Set<string>();
    savePathSet(HIDDEN_PROJECTS_KEY, next);
    setHiddenProjects(next);
  }

  function setProjectPinned(path: string, pinned: boolean) {
    setPinnedProjects((prev) => {
      const next = togglePath(prev, path, pinned);
      savePathSet(PINNED_PROJECTS_KEY, next);
      return next;
    });
  }

  function toggleArchivedGroup(path: string) {
    setOpenArchivedGroups((prev) => {
      const next = new Set(prev);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
  }

  const inputRef = useRef<HTMLInputElement | null>(null);
  const projectRenameInputRef = useRef<HTMLInputElement | null>(null);
  const lastCardClickRef = useRef<{ path: string; at: number }>({ path: '', at: 0 });

  const crossProjectSessions = useStore(allProjectSessions);
  const liveOrchestratorTasks = useStore(orchestratorTasks);
  const openRoomsByProject = useStore(projectOpenRooms);
  const currentLayout = useStore(layoutSnapshot);
  const hoveredRoom = useStore(hoveredStageRoom);
  const deepSeekPlacementState = useStore(deepSeekPlacements);
  const allChatThreads = useStore(chatThreadState);
  const currentInteractionMode = useStore(interactionMode);
  const [persistedTasksByProject, setPersistedTasksByProject] = useState<Map<string, OrchestratorTask>>(new Map());

  // `projectsMap` only holds the ACTIVE workspace's projects and is emptied on
  // every workspace switch, yet each row here is usually its own recents entry.
  // Resolve the other rows' ids from the backend's recent-project records (ids
  // are path-stable), and keep every id seen this session, so a background
  // project still lists its live sessions, rooms and tasks.
  const [knownProjects, setKnownProjects] = useState<Map<string, KnownProject>>(new Map());

  useEffect(() => {
    setKnownProjects((prev) => mergeKnownProjects(prev, projectsMap.values()));
  }, [projectsMap]);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const { invoke } = await import('@tauri-apps/api/core');
        const recents = await invoke<KnownProject[]>('workspace_get_recent');
        if (!cancelled) setKnownProjects((prev) => mergeKnownProjects(prev, recents));
      } catch {
        /* backend unavailable — the active workspace's projects still resolve */
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [rawWorkspaces]);

  const projectIdByPath = useMemo(() => {
    const byPath = new Map<string, string>();
    for (const project of knownProjects.values()) byPath.set(normalizeProjectPath(project.root_path), project.id);
    // The active workspace's live projects win over any stale record.
    for (const project of projectsMap.values()) byPath.set(normalizeProjectPath(project.root_path), project.id);
    return {
      get: (path: string) => byPath.get(normalizeProjectPath(path)),
    };
  }, [knownProjects, projectsMap]);

  useEffect(() => {
    seedProjectRoomsFromStorage(knownProjects.keys());
  }, [knownProjects]);

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
  // lightweight history for the other projects as well, so a project switch
  // does not make their completed work disappear from the project tree.
  useEffect(() => {
    let cancelled = false;
    void Promise.all(
      Array.from(knownProjects.values()).map(async (project) => {
        const tasks = await readProjectOrchestratorTaskSummaries(project).catch(() => []);
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
  }, [knownProjects]);

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

  // One flat project list. A recents entry may still hold more than one path
  // (older saved groups do), so every path it carries becomes its own project
  // row rather than a folder the user has to open first.
  const projectItems = useMemo(() => {
    const items: ProjectItem[] = [];

    for (const ws of rawWorkspaces) {
      const paths = ws.project_paths ?? [];
      if (paths.length === 0) {
        items.push({
          workspaceId: ws.id,
          name: ws.name,
          path: '',
          isActive: activeWsId === ws.id && !activeProjPath,
          last_opened: ws.last_opened,
          id: ws.id,
        });
        continue;
      }
      for (const path of paths) {
        items.push({
          workspaceId: ws.id,
          name: paths.length > 1 ? getFilename(path) : (ws.name || getFilename(path)),
          path,
          isActive:
            activeWsId === ws.id && (activeProjPath === path || (!activeProjPath && paths.length === 1)),
          last_opened: ws.last_opened,
          id: ws.id,
        });
      }
    }
    return items;
  }, [rawWorkspaces, activeWsId, activeProjPath]);

  // Filtered and sorted list
  const query = search.toLowerCase().trim();

  const filteredProjects = useMemo(() => {
    let list = projectItems;
    if (query) {
      list = list.filter(
        (p) => p.name.toLowerCase().includes(query) || p.path.toLowerCase().includes(query)
      );
    }
    return applyProjectPrefs(sortItems(list, projectSort), hiddenProjects, pinnedProjects);
  }, [projectItems, query, projectSort, hiddenProjects, pinnedProjects]);

  // Hidden projects that are still in the list, for the Projects menu's
  // "Hidden Projects" section. A hidden path since removed from the list simply
  // has nothing to show.
  const hiddenProjectItems = useMemo(
    () => projectItems.filter((item) => item.path && hiddenProjects.has(normalizeProjectPath(item.path))),
    [projectItems, hiddenProjects],
  );

  // Popovers stay open only while the user is interacting with that popover.
  useEffect(() => {
    if (!activeMenuKey && !threadMenuId) return;
    const handler = (event: PointerEvent) => {
      const target = event.target;
      if (!(target instanceof Element)) {
        setActiveMenuKey(null);
        setThreadMenuId(null);
        return;
      }
      if (!target.closest('.hud-menu-container')) {
        setActiveMenuKey(null);
      }
      if (!target.closest('.project-thread-actions')) setThreadMenuId(null);
    };
    window.addEventListener('pointerdown', handler);
    return () => window.removeEventListener('pointerdown', handler);
  }, [activeMenuKey, threadMenuId]);

  function beginProjectRename(project: ProjectItem) {
    setActiveMenuKey(null);
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

  // Move a project one row up or down the flat list. Neighbours usually live in
  // separate recents entries, so the reorder happens between entries; when two
  // rows come from the same entry it has to happen inside that entry instead.
  function handleMoveProject(p: ProjectItem, direction: 'up' | 'down') {
    const currentIndex = projectItems.findIndex(
      (item) => item.workspaceId === p.workspaceId && item.path === p.path,
    );
    if (currentIndex < 0) return;
    const targetIndex = direction === 'up' ? currentIndex - 1 : currentIndex + 1;
    if (targetIndex < 0 || targetIndex >= projectItems.length) return;
    const target = projectItems[targetIndex];

    if (target.workspaceId === p.workspaceId) {
      const paths = rawWorkspaces.find((w) => w.id === p.workspaceId)?.project_paths ?? [];
      const from = paths.indexOf(p.path);
      const to = paths.indexOf(target.path);
      if (from < 0 || to < 0) return;
      changeProjectSort('custom');
      reorderWorkspaceProject(p.workspaceId, from, to);
      return;
    }

    const rawCurrentIdx = rawWorkspaces.findIndex((w) => w.id === p.workspaceId);
    const rawTargetIdx = rawWorkspaces.findIndex((w) => w.id === target.workspaceId);
    if (rawCurrentIdx >= 0 && rawTargetIdx >= 0) {
      changeProjectSort('custom');
      reorderRecentWorkspaces(rawCurrentIdx, rawTargetIdx);
    }
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

  // Handle remove project from the list. A recents entry that holds several
  // paths only loses this one; an entry that holds just this project goes away.
  async function handleRemoveProject(p: ProjectItem) {
    if (!confirm(`Remove "${p.name}" from project list? (Your files on disk will not be deleted)`)) return;
    const paths = rawWorkspaces.find((w) => w.id === p.workspaceId)?.project_paths ?? [];
    if (paths.length > 1) await removeProjectFromCollection(p.workspaceId, p.path);
    else await deleteCollection(p.workspaceId);
  }

  // Room jump
  const pendingFocusRef = useRef<(() => void) | null>(null);

  function controlRoomAfterSwitch(room: string, op: RoomOp, projectId: string) {
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
      if (useWorkspaceStore.getState().activeProjectId !== projectId) return;
      requestRoomControl(op, room);
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

  async function openRoom(wsId: string, path: string, room: string, op: RoomOp = 'focus') {
    const projectId = projectIdByPath.get(path);
    if (!projectId) return;
    if (activeProjId === projectId) {
      requestRoomControl(op, room);
      return;
    }
    controlRoomAfterSwitch(room, op, projectId);
    try {
      await handleOpen(wsId, path);
    } catch (error) {
      pendingFocusRef.current?.();
      throw error;
    }
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
  function renderProjectCard(p: ProjectItem) {
    const projectId = p.path ? projectIdByPath.get(p.path) ?? null : null;
    const projectSessions = projectId ? sessionsByProject.get(projectId) ?? [] : [];
    const projectRooms = projectId ? openRoomsByProject.get(projectId) ?? [] : [];
    const previewIsRunning = projectRooms.includes('preview');
    const editorIsRunning = projectRooms.includes('editor');
    const deepSeekIsRunning = projectRooms.includes('deepseek');
    // Rooms that already have a row of their own in the list — either a bespoke
    // one above, or one per session below. The terminal room is the shells'
    // container: while it holds a session, that session IS the row, and a
    // separate "Terminal" entry beside it just reads as a second terminal. With
    // the room open and empty, the room row is the only thing left to show.
    const coveredRooms = new Set(ROOMS_WITH_OWN_ROW);
    if (projectSessions.length > 0) coveredRooms.add('terminal');
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
    const liveChatRows = chatRows.filter((row) => !row.thread?.archived);
    const archivedChatRows = chatRows.filter((row) => row.thread?.archived);
    const archivedOpen = openArchivedGroups.has(p.path);
    const isPinnedProject = Boolean(p.path) && pinnedProjects.has(normalizeProjectPath(p.path));
    const hasOpenContents = projectSessions.length > 0 || projectRooms.length > 0 || allProjectTasks.length > 0;
    const hasContents = hasOpenContents || chatRows.length > 0 || Boolean(p.path);
    const isExpanded = p.path ? expandedProjects.has(p.path) : false;
    const itemIndex = projectItems.findIndex(
      (item) => item.workspaceId === p.workspaceId && item.path === p.path,
    );
    const canMoveUp = itemIndex > 0;
    const canMoveDown = itemIndex >= 0 && itemIndex < projectItems.length - 1;

    const projectMenuKey = `proj-menu:${p.workspaceId}:${p.path}`;
    const showOptionsMenu = activeMenuKey === projectMenuKey;

    const renderOpenRoomRow = (
      room: string,
      label: string,
      icon: ReactNode,
      detail?: string | null,
      hover = `${label}: open`,
      key = room,
      busy = false,
    ) => {
      const roomState = projectId === activeProjId ? currentLayout.rooms.find((item) => item.id === room) : null;
      const minimized = roomState?.minimized ?? false;
      const hovered = projectId === activeProjId && hoveredRoom === room;
      const expanded = projectId === activeProjId && currentLayout.expandedRoom === room;
      const minimizeOp: RoomOp = minimized ? 'restore' : 'minimize';
      return (
        <div key={key} className={`project-process-entry${hovered ? ' is-hovered-room' : ''}`}>
          <button
            type="button"
            className="project-process-row"
            onClick={() => openRoom(p.workspaceId, p.path, room).catch(console.error)}
            title={hover}
          >
            <span className={`project-process-icon${busy ? ' busy' : ''}`} aria-hidden="true">{icon}</span>
            <span className="project-process-name">{label}</span>
            {detail && <span className="project-process-detail">{detail}</span>}
          </button>
          <div className="project-process-actions">
            {!isFullscreenRoom(room) && (
              <button
                type="button"
                className="project-process-action"
                onClick={() => openRoom(p.workspaceId, p.path, room, expanded ? 'collapse' : 'expand').catch(console.error)}
                title={expanded ? `Restore ${label} to the split grid` : `Expand ${label} to the full stage`}
                aria-label={expanded ? `Restore ${label} to the split grid` : `Expand ${label} to the full stage`}
              >
                <Glyph>
                  {expanded ? (
                    <>
                      <path d="M4 14h6v6M20 10h-6V4" />
                      <path d="m10 14-7 7m11-11 7-7" />
                    </>
                  ) : (
                    <>
                      <path d="M15 3h6v6M9 21H3v-6" />
                      <path d="m21 3-7 7M3 21l7-7" />
                    </>
                  )}
                </Glyph>
              </button>
            )}
            <button
              type="button"
              className="project-process-action"
              onClick={() => openRoom(p.workspaceId, p.path, room, minimizeOp).catch(console.error)}
              title={`${minimized ? 'Restore' : 'Minimize'} ${label}`}
              aria-label={`${minimized ? 'Restore' : 'Minimize'} ${label}`}
            >
              <Glyph>{minimized ? <rect x="5" y="5" width="14" height="14" rx="2" /> : <path d="M5 12h14" />}</Glyph>
            </button>
            <button
              type="button"
              className="project-process-action danger"
              onClick={() => openRoom(p.workspaceId, p.path, room, 'close').catch(console.error)}
              title={`Close ${label}`}
              aria-label={`Close ${label}`}
            >
              <Glyph><path d="M5 5l14 14M19 5L5 19" /></Glyph>
            </button>
          </div>
        </div>
      );
    };

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
              {isPinnedProject && (
                <PinIcon variant="mark" size={12} className="project-pin-mark" label="Pinned project" />
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
              onClick={() => setActiveMenuKey(showOptionsMenu ? null : projectMenuKey)}
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
                <button
                  type="button"
                  className="hud-options-menu-item"
                  role="menuitem"
                  disabled={!canMoveUp}
                  onClick={() => {
                    handleMoveProject(p, 'up');
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
                    handleMoveProject(p, 'down');
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
                    beginProjectRename(p);
                  }}
                >
                  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M12 20h9" />
                    <path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L8 18l-4 1 1-4Z" />
                  </svg>
                  <span>Rename Project</span>
                </button>

                {p.path && (
                  <>
                    <button
                      type="button"
                      className="hud-options-menu-item"
                      role="menuitem"
                      onClick={() => {
                        setActiveMenuKey(null);
                        setProjectPinned(p.path, !isPinnedProject);
                      }}
                    >
                      <PinIcon variant={isPinnedProject ? 'off' : 'plain'} size={12} />
                      <span>{isPinnedProject ? 'Unpin Project' : 'Pin to Top'}</span>
                    </button>

                    <button
                      type="button"
                      className="hud-options-menu-item"
                      role="menuitem"
                      title="Hide from the list. Unhide it from the Projects menu."
                      onClick={() => {
                        setActiveMenuKey(null);
                        setProjectHidden(p.path, true);
                      }}
                    >
                      <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                        <path d="M9.9 4.24A9.1 9.1 0 0 1 12 4c7 0 10 8 10 8a13.2 13.2 0 0 1-1.67 2.68" />
                        <path d="M6.61 6.61A13.5 13.5 0 0 0 2 12s3 8 10 8a9.7 9.7 0 0 0 5.39-1.61" />
                        <path d="M14.12 14.12a3 3 0 1 1-4.24-4.24" />
                        <line x1="2" y1="2" x2="22" y2="22" />
                      </svg>
                      <span>Hide Project</span>
                    </button>
                  </>
                )}

                <div className="hud-options-menu-divider" />

                <button
                  type="button"
                  className="hud-options-menu-item danger"
                  role="menuitem"
                  onClick={() => {
                    setActiveMenuKey(null);
                    void handleRemoveProject(p);
                  }}
                >
                  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <polyline points="3 6 5 6 21 6" />
                    <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
                  </svg>
                  <span>Remove from Project List</span>
                </button>
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
                  {liveChatRows.length === 0 && (
                    <span className="project-threads-empty">No active threads</span>
                  )}
                  {[...liveChatRows, ...(archivedOpen ? archivedChatRows : [])].map((row, rowIndex) => {
                    const isSelected = row.thread?.id === activeThreadId;
                    const terminalSession = row.session
                      ?? (row.task?.assignedSessionId != null ? sessionById.get(row.task.assignedSessionId) ?? null : null);
                    return (
                      <Fragment key={row.id}>
                      {rowIndex === liveChatRows.length && (
                        <div className="project-threads-archived-label">Archived</div>
                      )}
                      <div className={`project-thread-row-wrap${isSelected ? ' selected' : ''}${row.thread?.archived ? ' archived' : ''}`}>
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
                                <PinIcon variant="mark" size={11} className="project-thread-pin" label="Pinned thread" />
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
                                  onClick={(event) => {
                                    event.stopPropagation();
                                    setChatThreadArchived(row.thread!.id, !row.thread!.archived);
                                    setThreadMenuId(null);
                                  }}
                                >
                                  {row.thread.archived ? 'Unarchive' : 'Archive'}
                                </button>
                                <button
                                  type="button"
                                  role="menuitem"
                                  className="danger"
                                  onClick={(event) => {
                                    event.stopPropagation();
                                    if (window.confirm(`Delete “${row.thread?.title ?? 'this thread'}”?`)) {
                                      closeChatThread(row.thread!.id);
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
                      </Fragment>
                    );
                  })}
                  {archivedChatRows.length > 0 && (
                    <button
                      type="button"
                      className={`project-threads-archived-toggle${archivedOpen ? ' open' : ''}`}
                      onClick={() => toggleArchivedGroup(p.path)}
                      aria-expanded={archivedOpen}
                    >
                      <svg width="9" height="9" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                        <polyline points="9 6 15 12 9 18" />
                      </svg>
                      <span>{archivedOpen ? 'Hide archived' : `Archived (${archivedChatRows.length})`}</span>
                    </button>
                  )}
                </div>
              )}
            </div>
            )}
            {/* The CLI view lists rooms and sessions only, so tasks alone must
                not hide the empty state and leave a blank box. */}
            {currentInteractionMode === 'cli' && projectRooms.length === 0 && projectSessions.length === 0 && (
              <div className="project-contents-empty">Nothing open in this project</div>
            )}
            {currentInteractionMode === 'cli' && <>
            {(projectRooms.length > 0 || projectSessions.length > 0) && (
              <div className="project-contents-section">
                {/* Covers both senses: a panel that is open, and a process
                    that is actually running inside one. */}
                <div className="project-contents-label">Active</div>
                {previewIsRunning && renderOpenRoomRow('preview', 'Preview', ROOM_GLYPHS.preview, 'active', 'Preview: running')}
                {editorIsRunning && renderOpenRoomRow('editor', 'Editor', ROOM_GLYPHS.editor)}
                {deepSeekIsRunning && p.path && (() => {
                  // Listed like an agent: its assistant name, the product beside it.
                  const dsRoot = deepSeekPanelRoot(deepSeekPlacementState, projectId, p.path);
                  const isolated = dsRoot !== p.path;
                  const name = deepSeekAgentName(dsRoot, projectSessions.map((s) => s.agentName ?? '').filter(Boolean));
                  return renderOpenRoomRow(
                    'deepseek', name, <AgentBrandMark command="dsh" name="DeepSeek Harness" />,
                    isolated ? 'DeepSeek Harness · worktree' : 'DeepSeek Harness',
                    `${name}: DeepSeek Harness, running`,
                  );
                })()}
                {/* Every other open room. The list is the project's one answer to
                    "what is open here?" now that the Rooms chips are gone. */}
                {projectRooms
                  .filter((room) => !coveredRooms.has(room))
                  .map((room) => renderOpenRoomRow(
                    room, TOOL_ROW_LABELS[room] ?? room, ROOM_GLYPHS[room] ?? DEFAULT_ROOM_GLYPH,
                  ))}
                {projectSessions.map((session) => {
                  const isAgent = isAgentSession(session);
                  const name = isAgent ? getSessionPromptTargetLabel(session, projectSessions) : session.title;
                  const task = getSessionPaneDisplayTitle(session, projectSessions);
                  // An agent is listed like the DeepSeek row: its name, then what it
                  // is. The task it is on moves to the hover text.
                  const agentType = isAgent ? getAgentDisplayName(session.agentPreset) : null;
                  const detail = agentType ?? task;
                  const state = session.isExecuting ? 'working' : 'running';
                  const hover = [name, agentType, task && task !== name ? task : null, state]
                    .filter(Boolean)
                    .join(': ');
                  return renderOpenRoomRow(
                    isAgent ? `agent:${session.id}` : 'terminal', name,
                    isAgent ? <AgentBrandMark command={session.agentPreset} name={name} /> : ROOM_GLYPHS.terminal,
                    detail !== name ? detail : null, hover, String(session.id), session.isExecuting,
                  );
                })}
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
      {/* Main Scrollable Body */}
      <div className="projects-panel-body scrollable">
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
                    className={`projects-search-toggle${projectSearchOpen || search ? ' active' : ''}`}
                    onClick={(e) => {
                      e.stopPropagation();
                      if (projectSearchOpen) {
                        setProjectSearchOpen(false);
                        setSearch('');
                      } else {
                        if (isProjectsCollapsed) toggleSectionCollapse('projects');
                        setProjectSearchOpen(true);
                      }
                    }}
                    title={projectSearchOpen ? 'Close project search' : 'Search projects'}
                    aria-label={projectSearchOpen ? 'Close project search' : 'Search projects'}
                    aria-expanded={projectSearchOpen}
                  >
                    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                      <circle cx="11" cy="11" r="7" />
                      <path d="m20 20-4-4" />
                    </svg>
                  </button>
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
                        {hiddenProjectItems.length > 0 && (
                          <>
                            <div className="hud-options-menu-divider" />
                            <div className="hud-options-menu-header">Hidden Projects</div>
                            {hiddenProjectItems.map((hiddenProject) => (
                              <button
                                key={`${hiddenProject.workspaceId}-${hiddenProject.path}`}
                                type="button"
                                className="hud-options-menu-item"
                                role="menuitem"
                                title={`Unhide ${hiddenProject.path}`}
                                onClick={() => setProjectHidden(hiddenProject.path, false)}
                              >
                                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                                  <path d="M2 12s3-8 10-8 10 8 10 8-3 8-10 8-10-8-10-8Z" />
                                  <circle cx="12" cy="12" r="3" />
                                </svg>
                                <span>Unhide {hiddenProject.name}</span>
                              </button>
                            ))}
                            {hiddenProjectItems.length > 1 && (
                              <button
                                type="button"
                                className="hud-options-menu-item"
                                role="menuitem"
                                onClick={() => {
                                  unhideAllProjects();
                                  setActiveMenuKey(null);
                                }}
                              >
                                <span>Unhide All</span>
                              </button>
                            )}
                          </>
                        )}
                      </div>
                    )}
                  </div>
                </div>
              </div>

              {!isProjectsCollapsed && (
                <>
                  {projectSearchOpen && (
                    <div className="projects-search-section">
                      <div className="projects-search-field">
                        <svg className="projects-search-icon" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2">
                          <circle cx="11" cy="11" r="8" />
                          <line x1="21" y1="21" x2="16.65" y2="16.65" />
                        </svg>
                        <input
                          ref={inputRef}
                          autoFocus
                          type="text"
                          className="projects-search-input"
                          placeholder="Filter projects…"
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
                  )}
                  <div className="projects-section-list">
                    {filteredProjects.map((p) => renderProjectCard(p))}
                    {filteredProjects.length === 0 && !search && (
                      <div className="projects-section-empty-hint">
                        {hiddenProjectItems.length > 0
                          ? 'Every project is hidden. Unhide them from the Projects menu.'
                          : 'No projects yet. Open a folder to begin.'}
                      </div>
                    )}
                  </div>
                </>
              )}
            </div>
          );
        })()}

        {/* Global Empty Search State */}
        {search && filteredProjects.length === 0 && (
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
