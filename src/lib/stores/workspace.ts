import { writable, derived, get } from '$lib/stores/storeCompat';
import type { Project, Workspace } from '$lib/types/workspace';
import { openFiles, activeFile, fileCache, activeLine, activeColumn, restoreEditorFiles, resetEditorSession } from './editor';
import { sessions, activeSessionId, gridLayout, paneAssignments, activePaneIndex, createTerminalSession, attachTerminalSession, killSession, getTerminalProjectState, restoreTerminalProjectState, setActiveTerminalProject, setTerminalProjectRoot, applyRestoredSessionMetadata, relaunchRestoredAgentSession } from './terminal';
import { targetPort, proxyPort, proxyStarted, currentUrl, preferredLocalHost, parseLocalPreviewUrl, previewTabs, activePreviewTabId, restorePreviewTabsState, resetPreviewTabsState, setPreferredLocalHost, setTargetPort, type PreviewTab } from './preview';
import { expandedPaths, selectedPath, selectedPaths } from './explorer';
import { resetSettingsToDefault } from './settings';
import { resetLayoutToDefault, layout, sanitiseActiveView, sanitiseSidebarTab, sanitiseRightDrawerTool, currentRightDrawerTool, applyRightDrawerTool, terminalRoomOpen, homeScreenOpen, toggleSidebarTab, type RightDrawerTool } from './layout';
import { layoutSnapshot, requestRoomArrangement, focusedRoomOf, type AmbientLayout } from './layoutControl';
import { isSafePresetId } from '$lib/components/layout/split-layout';
import { isTauriRuntime } from '$lib/utils/tauri';
import { useWorkspaceStore } from './zustand/workspace';
import { backendInvoke } from '$lib/services/backend';
import type { RemoteConnection } from './remoteWorkspace';

function syncWritable<T>(key: string, defaultValue: T): import('$lib/stores/storeCompat').Writable<T> {
  const zustandVal = (useWorkspaceStore.getState() as any)[key];
  const initial = zustandVal !== undefined ? zustandVal as T : defaultValue;
  const store = writable<T>(initial);
  void useWorkspaceStore.subscribe((state) => {
    const next = (state as any)[key] as T | undefined;
    if (next !== undefined) store.set(next);
  });
  return {
    subscribe: store.subscribe,
    set(value: T) { (useWorkspaceStore.getState() as any).__set(key, value); },
    update(fn: (val: T) => T) {
      const current = (useWorkspaceStore.getState() as any)[key] as T;
      (useWorkspaceStore.getState() as any).__set(key, fn(current));
    },
  };
}

export const recentWorkspaces = syncWritable<Workspace[]>('recentWorkspaces', []);
export const activeWorkspaceId = syncWritable<string | null>('activeWorkspaceId', null);

export const activeWorkspace = derived(
  [recentWorkspaces, activeWorkspaceId],
  ([$recentWorkspaces, $activeWorkspaceId]) =>
    $activeWorkspaceId ? $recentWorkspaces.find((w) => w.id === $activeWorkspaceId) ?? null : null
);

// Treat this Map as immutable: every `update` must return a NEW Map. It is
// backed by zustand, so React consumers compare the selected value by
// reference — mutating in place and returning the same Map means the identity
// never changes, `useWorkspaceStore((s) => s.projects)` never re-renders, and
// anything memoised on it (the Projects panel derives path → id that way) stays
// frozen at whatever the map held on first render, which is usually empty.
export const projects = syncWritable<Map<string, Project>>('projects', new Map());

/**
 * Add or replace one project, returning a NEW Map — the only way the `projects`
 * store may be written. Exported as `__setProjectIn` for workspace.test.ts,
 * because the whole point is an identity change no call site can forget.
 */
function setProjectIn(map: Map<string, Project>, id: string, project: Project): Map<string, Project> {
  const next = new Map(map);
  next.set(id, project);
  return next;
}
export const __setProjectIn = setProjectIn;
export const activeProjectId = syncWritable<string | null>('activeProjectId', null);
export const openProjectIds = syncWritable<string[]>('openProjectIds', []); // ordered list of open project tabs
export const isLoading = syncWritable<boolean>('isLoading', false);

export const activeProject = derived(
  [projects, activeProjectId],
  ([$projects, $activeProjectId]) =>
    $activeProjectId ? $projects.get($activeProjectId) ?? null : null
);

// Keep the preview proxy's project root in sync with the active project across
// EVERY path that changes it — open folder, switch tab, session/workspace
// restore, close — not just `setActiveProject`. The proxy's `/local-file` route
// refuses to serve any file until this is set, so a missed update surfaces as a
// "No project open" error in the preview panel. Centralizing here means new
// call sites can't forget to notify the proxy. Deduped so unrelated `projects`
// map updates (metadata refreshes) don't spam the backend.
let lastPreviewProjectRoot: string | null | undefined;
activeProject.subscribe(($activeProject) => {
  const rootPath = $activeProject?.root_path ?? null;
  if (rootPath === lastPreviewProjectRoot) return;
  lastPreviewProjectRoot = rootPath;
  import('./preview').then(({ setPreviewProjectRoot }) => {
    setPreviewProjectRoot(rootPath);
  });
});

export const newWorkspacePromptOpen = syncWritable<boolean>('newWorkspacePromptOpen', false);
export const newFolderPromptOpen = syncWritable<boolean>('newFolderPromptOpen', false);
export const cloneRepoPromptOpen = syncWritable<boolean>('cloneRepoPromptOpen', false);
export const isProjectHUDOpen = syncWritable<boolean>('isProjectHUDOpen', false);

export function toggleProjectHUD() {
  toggleSidebarTab('projects');
}

export const openProjectsList = derived(
  [projects, openProjectIds],
  ([$projects, $openProjectIds]) =>
    $openProjectIds.map((id) => $projects.get(id)).filter(Boolean) as Project[]
);

/**
 * Which rooms each project has open, keyed by project id.
 *
 * The live room state (`layout`, `terminalRoomOpen`) only ever describes the
 * ACTIVE project, so anything that wants to show a background project's stage —
 * the Projects panel lists them under each project — needs a per-project
 * snapshot. This is that snapshot: `publishProjectRooms` refreshes the active
 * project's entry from the live stores on every save (the 150ms autosave keeps
 * it current) and `closeProject` drops it.
 *
 * Ids match AppShell's `RoomId` so a click here can be handed straight to
 * `requestRoomControl`.
 */
export const projectOpenRooms = writable<Map<string, string[]>>(new Map());

/** The open rooms of whichever project is active right now. */
function collectOpenRoomIds(): string[] {
  const l = get(layout);
  const rooms: string[] = [];
  if (get(terminalRoomOpen)) rooms.push('terminal');
  if (l.editorVisible) rooms.push('editor');
  if (l.previewVisible) rooms.push('preview');
  if (l.tasksVisible) rooms.push('tasks');
  // Sketch is app-global rather than per-project (see per-project-persistence),
  // so a background project keeps whatever it was left with — the same way the
  // rest of its saved stage behaves.
  if (l.sketchVisible) rooms.push('sketch');
  return rooms;
}

function setProjectRooms(projectId: string, rooms: string[]) {
  projectOpenRooms.update((map) => {
    const prev = map.get(projectId);
    // Same list → same Map reference, so `useSyncExternalStore` bails out and
    // the panel doesn't re-render on every autosave tick.
    if (prev && prev.length === rooms.length && prev.every((id, i) => id === rooms[i])) return map;
    const next = new Map(map);
    next.set(projectId, rooms);
    return next;
  });
}

function publishProjectRooms(projectId: string) {
  setProjectRooms(projectId, collectOpenRoomIds());
}

// Projects already seeded from disk. A project that has no persisted state yet
// still counts as seeded — re-reading localStorage on every `projects` update
// would be pure churn, and the live publish takes over the moment it is opened.
const seededProjectRooms = new Set<string>();

/**
 * A project that has not been active this session has published nothing, so on
 * a cold start every project but one would list no rooms. Seed those from the
 * stage they were last left on — which is exactly what they will come back to.
 */
projects.subscribe((map) => {
  for (const projectId of map.keys()) {
    if (seededProjectRooms.has(projectId)) continue;
    seededProjectRooms.add(projectId);
    if (get(projectOpenRooms).has(projectId)) continue;
    const l = loadProjectStateFromStorage(projectId)?.layout;
    if (!l) continue;
    const rooms: string[] = [];
    // Absent in state saved before the terminal room was per-project, and open
    // is what those builds always did.
    if (l.terminalRoomOpen !== false) rooms.push('terminal');
    if (l.editorVisible) rooms.push('editor');
    if (l.previewVisible) rooms.push('preview');
    if (l.tasksVisible) rooms.push('tasks');
    // No `sketch`: it is app-global, so a saved project never carried one.
    setProjectRooms(projectId, rooms);
  }
});

interface ProjectWorkspaceState {
  editor: {
    openFiles: string[];
    activeFile: string | null;
    fileCache: Map<string, any>;
    activeLine: number;
    activeColumn: number;
  };
  terminal: {
    sessions: any[];
    activeSessionId: number | null;
    gridLayout: any;
    paneAssignments: (number | null)[];
    activePaneIndex: number;
  };
  preview: {
    targetPort: number;
    proxyPort: number | null;
    proxyStarted: boolean;
    currentUrl: string;
    tabs: PreviewTab[];
    activeTabId: string | null;
  };
  explorer: {
    expandedPaths: Set<string>;
    selectedPath: string | null;
  };
  ambient: AmbientLayout;
  /** Split's tiling order. Empty means the project never arranged the stage. */
  splitSlots: string[];
  /** The room that was on top / primary when the project was left. */
  focusedRoom: string | null;
  /** The room that was expanded / maximized 100% on the stage, if any. */
  expandedRoom?: string | null;
  /** Active preset layouts mapped by pane count (2, 3, 4). */
  splitPresets?: Record<number, string>;
  /** Rooms minimized in the current arrangement. */
  minimizedRooms: string[];
  /** Room switcher order for this project. */
  roomOrder: string[];
  /** The development terminal is a shell-owned room, not a LayoutState flag. */
  devTerminalOpen: boolean;
  layout: {
    activeView: string;
    editorVisible: boolean;
    previewVisible: boolean;
    reviewVisible: boolean;
    httpVisible: boolean;
    tasksVisible: boolean;
    orchestratorVisible: boolean;
    dbVisible: boolean;
    toolboxVisible: boolean;
    fleetVisible: boolean;
    containersVisible: boolean;
    envVisible: boolean;
    youtubeVisible: boolean;
    mobileVisible: boolean;
    sketchVisible: boolean;
    /** The Terminal room's own open/closed state. Not part of `LayoutState` —
     *  it is its own store — but it is a room like any other, so it has to be
     *  saved per project or closing it can't survive a switch. */
    terminalRoomOpen: boolean;
    /** Which right-drawer tool this project had open, or null for closed. */
    rightDrawerTool: RightDrawerTool | null;
    lastAuxView: string;
    editorSplitPreview: boolean;
    auxPanelWidth: number;
    auxEditorHeight: number;
    sidebarVisible: boolean;
    sidebarWidth: number;
    sidebarTab: string;
    leftPanelWidth: number;
    rightDrawerWidth: number;
  };
}

const projectStateCache = new Map<string, ProjectWorkspaceState>();
let restoreProjectStateGeneration = 0;
let projectAutosaveTimer: ReturnType<typeof setTimeout> | null = null;
let isRestoringProjectState = false;
export const isProjectSwitching = syncWritable<boolean>('isProjectSwitching', false);

function cancelPendingProjectAutosave() {
  if (projectAutosaveTimer) {
    clearTimeout(projectAutosaveTimer);
    projectAutosaveTimer = null;
  }
}

function scheduleProjectAutosave() {
  if (isRestoringProjectState) return;
  if (typeof window === 'undefined') return;
  const projectId = get(activeProjectId);
  if (!projectId) return;

  if (projectAutosaveTimer) {
    clearTimeout(projectAutosaveTimer);
  }

  projectAutosaveTimer = setTimeout(() => {
    projectAutosaveTimer = null;
    const currentId = get(activeProjectId);
    if (!currentId || isRestoringProjectState) return;
    saveProjectState(currentId);
  }, 150);
}

function bindProjectAutosave() {
  const trackedStores = [
    openFiles,
    activeFile,
    fileCache,
    activeLine,
    activeColumn,
    sessions,
    activeSessionId,
    gridLayout,
    paneAssignments,
    activePaneIndex,
    targetPort,
    proxyPort,
    proxyStarted,
    currentUrl,
    previewTabs,
    activePreviewTabId,
    expandedPaths,
    selectedPath,
    layout,
    // The Terminal room's open/closed state is its own store, not a `layout`
    // field, so without it here closing the Terminal never scheduled a save —
    // and the per-project room list the Projects panel reads went stale.
    terminalRoomOpen,
    // The stage arrangement (mode, Split tiling, primary room). Without it only
    // a project switch would write it out — `saveCurrentProjectState` runs on
    // the way past — so rearranging panes and then quitting lost the layout,
    // which is the one case a restart is supposed to cover.
    layoutSnapshot,
  ];

  for (const store of trackedStores) {
    store.subscribe(() => {
      scheduleProjectAutosave();
    });
  }
}

bindProjectAutosave();

// ── Per-project localStorage persistence ──────────────────────────────────

/** An agent's isolated git worktree, as persisted alongside its pane. Mirrors
 *  `WorktreeInfo` in services/orchestrator/worktree-manager. */
interface PersistedWorktree {
  path: string;
  branch: string;
  baseBranch: string;
  baseCommit: string;
  createdAt: number;
}

interface PersistedTerminalPane {
  backendSessionId?: number | null;
  role: string | null;
  cwd: string | null;
  hasSession: boolean;
  title?: string | null;
  paneTitle?: string | null;
  agentName?: string | null;
  agentPreset?: string | null;
  taskSummary?: string | null;
  worktree?: PersistedWorktree | null;
}

interface PersistedProjectState {
  openFiles: string[];
  activeFile: string | null;
  expandedPaths: string[];
  /** Explorer's active (last-clicked) entry, restored after an app restart. */
  selectedPath?: string | null;
  terminalLayout?: string;
  terminalPanes?: PersistedTerminalPane[];
  /** The workspace's ambient room arrangement (Focus / Split / Gallery). */
  ambient?: AmbientLayout;
  /**
   * Split's tiling order, left→right, and the room that was primary. Together
   * with `ambient` these put the stage back exactly as the project was left.
   * Empty slots is the "never arranged" sentinel, not an empty stage.
   */
  splitSlots?: string[];
  focusedRoom?: string | null;
  expandedRoom?: string | null;
  splitPresets?: Record<number, string>;
  minimizedRooms?: string[];
  roomOrder?: string[];
  devTerminalOpen?: boolean;
  layout?: {
    activeView: string;
    editorVisible: boolean;
    previewVisible: boolean;
    reviewVisible: boolean;
    httpVisible: boolean;
    tasksVisible?: boolean;
    orchestratorVisible?: boolean;
    dbVisible?: boolean;
    toolboxVisible?: boolean;
    fleetVisible?: boolean;
    containersVisible?: boolean;
    envVisible?: boolean;
    youtubeVisible?: boolean;
    mobileVisible?: boolean;
    sketchVisible?: boolean;
    /** The Terminal room's open/closed state — see the note on the cache type.
     *  Absent in state saved before it was per-project; treated as open then,
     *  which is what that build always did. */
    terminalRoomOpen?: boolean;
    /**
     * The right utility drawer's open tool, or null/absent for closed. Stored as
     * the tool NAME rather than as its backing booleans: the drawer is one body
     * at a time, `env` needs two flags moved together, and a name round-trips
     * through `applyRightDrawerTool` as one coherent write. Without this the
     * drawer was pure app-global state and followed you between projects.
     */
    rightDrawerTool?: string | null;
    lastAuxView?: string;
    editorSplitPreview: boolean;
    auxPanelWidth: number;
    auxEditorHeight: number;
    sidebarVisible: boolean;
    sidebarWidth: number;
    sidebarTab: string;
    leftPanelWidth?: number;
    rightDrawerWidth?: number;
  };
  preview?: {
    tabs: PreviewTab[];
    activeTabId: string | null;
    targetPort?: number;
    proxyStarted?: boolean;
  };
}

function projectStorageKey(projectId: string) {
  return `spacron_project_${projectId}`;
}

/** Remote-workspace projects use a `remote:<id>` project id. Their state lives
 *  on the server and they're never auto-reopened locally, so we keep them out of
 *  localStorage to avoid orphaned per-project entries. */
function isRemoteProjectId(projectId: string): boolean {
  return projectId.startsWith('remote:');
}

function saveProjectStateToStorage(projectId: string) {
  if (typeof window === 'undefined') return;
  if (isRemoteProjectId(projectId)) return;
  const terminalState = getTerminalProjectState(projectId);
  const terminalPanes: PersistedTerminalPane[] = terminalState.sessions
    .filter((session) => session.isRunning && session.agentPreset)
    .map((session) => {
      return {
        backendSessionId: session.id,
        role: session.role ?? null,
        cwd: session.cwd ?? null,
        hasSession: Boolean(session),
        title: session.title ?? null,
        paneTitle: session.paneTitle ?? null,
        agentName: session.agentName ?? null,
        agentPreset: session.agentPreset ?? null,
        taskSummary: session.taskSummary ?? null,
        worktree: session.worktree
          ? {
              path: session.worktree.path,
              branch: session.worktree.branch,
              baseBranch: session.worktree.baseBranch,
              baseCommit: session.worktree.baseCommit,
              createdAt: session.worktree.createdAt,
            }
          : null,
      };
    });
  const currentLayout = get(layout);
  const state: PersistedProjectState = {
    openFiles: get(openFiles).slice(0, 100),
    activeFile: get(activeFile),
    expandedPaths: Array.from(get(expandedPaths)).slice(0, 500),
    selectedPath: get(selectedPath),
    terminalLayout: 'single',
    terminalPanes,
    ambient: get(layoutSnapshot).ambient,
    splitSlots: get(layoutSnapshot).splitSlots.slice(0, MAX_SPLIT_SLOTS),
    focusedRoom: focusedRoomOf(get(layoutSnapshot)),
    expandedRoom: get(layoutSnapshot).expandedRoom ?? null,
    splitPresets: get(layoutSnapshot).splitPresets,
    minimizedRooms: (get(layoutSnapshot).minimizedRooms ?? []).slice(0, MAX_SPLIT_SLOTS),
    roomOrder: (get(layoutSnapshot).roomOrder ?? []).slice(0, MAX_SPLIT_SLOTS + 16),
    devTerminalOpen: get(layoutSnapshot).devTerminalOpen ?? false,
    layout: {
      activeView: currentLayout.activeView,
      editorVisible: currentLayout.editorVisible,
      previewVisible: currentLayout.previewVisible,
      reviewVisible: currentLayout.reviewVisible,
      httpVisible: currentLayout.httpVisible,
      tasksVisible: currentLayout.tasksVisible,
      orchestratorVisible: currentLayout.orchestratorVisible,
      dbVisible: currentLayout.dbVisible,
      toolboxVisible: currentLayout.toolboxVisible,
      fleetVisible: currentLayout.fleetVisible,
      containersVisible: currentLayout.containersVisible,
      envVisible: currentLayout.envVisible,
      youtubeVisible: currentLayout.youtubeVisible,
      mobileVisible: currentLayout.mobileVisible,
      sketchVisible: currentLayout.sketchVisible,
      terminalRoomOpen: get(terminalRoomOpen),
      rightDrawerTool: currentRightDrawerTool(),
      lastAuxView: currentLayout.lastAuxView,
      editorSplitPreview: currentLayout.editorSplitPreview,
      auxPanelWidth: currentLayout.auxPanelWidth,
      auxEditorHeight: currentLayout.auxEditorHeight,
      sidebarVisible: currentLayout.sidebarVisible,
      sidebarWidth: currentLayout.sidebarWidth,
      sidebarTab: currentLayout.sidebarTab,
      leftPanelWidth: currentLayout.leftPanelWidth,
      rightDrawerWidth: currentLayout.rightDrawerWidth,
    },
    preview: {
      tabs: get(previewTabs),
      activeTabId: get(activePreviewTabId),
      targetPort: get(targetPort),
      proxyStarted: get(proxyStarted),
    },
  };
  try { localStorage.setItem(projectStorageKey(projectId), JSON.stringify(state)); } catch {
    // localStorage quota exceeded — persist a minimal state instead
    try { localStorage.setItem(projectStorageKey(projectId), JSON.stringify({ ...state, openFiles: state.openFiles.slice(0, 10), expandedPaths: [] })); } catch {}
  }
}

function isSafePath(v: unknown): v is string {
  return typeof v === 'string' && v.length > 0 && v.length < 4096 && !/[\0\x01-\x1f]/.test(v);
}

function isSafeLabel(v: unknown, maxLength = 512): v is string {
  return typeof v === 'string' && v.length > 0 && v.length <= maxLength && !/[\0\x01-\x1f]/.test(v);
}

/**
 * Room ids are a closed vocabulary — a fixed set of panel names, plus
 * `agent:<session id>`. Shape-check rather than name-check: this module has no
 * business knowing the shell's room list, and an id for a room this build no
 * longer has is dropped by the shell anyway (`isKnownRoomId` in `AppShell`).
 */
function isSafeRoomId(v: unknown): v is string {
  return typeof v === 'string' && /^(?:[a-z][a-z-]{0,23}|agent:\d{1,10})$/.test(v);
}

/** Matches `SPLIT_MAX_PANES` in AppShell — a persisted list can't exceed the stage. */
const MAX_SPLIT_SLOTS = 12;

/** Validate a persisted agent worktree. Branch names go straight into git
 *  commands on removal, so they're held to git's own naming rules rather than a
 *  generic label check; anything malformed drops the whole record. */
function sanitisePersistedWorktree(raw: unknown): PersistedWorktree | null {
  if (!raw || typeof raw !== 'object') return null;
  const w = raw as Record<string, unknown>;
  if (!isSafePath(w.path)) return null;
  const isBranch = (v: unknown): v is string =>
    typeof v === 'string' &&
    v.length > 0 &&
    v.length <= 255 &&
    /^[\w\-./]+$/.test(v) &&
    !v.startsWith('-') &&
    !v.startsWith('/') &&
    !v.endsWith('/') &&
    !v.includes('..');
  if (!isBranch(w.branch) || !isBranch(w.baseBranch)) return null;
  if (typeof w.baseCommit !== 'string' || !/^[0-9a-f]{7,64}$/i.test(w.baseCommit)) return null;
  const createdAt = typeof w.createdAt === 'number' && Number.isFinite(w.createdAt) ? w.createdAt : Date.now();
  return {
    path: w.path,
    branch: w.branch,
    baseBranch: w.baseBranch,
    baseCommit: w.baseCommit,
    createdAt,
  };
}

function sanitisePersistedProjectState(raw: unknown): PersistedProjectState | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;

  const openFiles = Array.isArray(r.openFiles)
    ? (r.openFiles as unknown[]).filter(isSafePath)
    : [];

  const activeFile = isSafePath(r.activeFile) ? r.activeFile : null;

  const expandedPaths = Array.isArray(r.expandedPaths)
    ? (r.expandedPaths as unknown[]).filter(isSafePath)
    : [];

  const selectedPath = isSafePath(r.selectedPath) ? r.selectedPath : null;

  // cwd: must be a safe path; role: alphanumeric + common separators only, no control chars
  const rawPanes = Array.isArray(r.terminalPanes) ? r.terminalPanes : [];
  const terminalPanes: PersistedTerminalPane[] = rawPanes.map((p: unknown) => {
    if (!p || typeof p !== 'object') return { role: null, cwd: null, hasSession: false };
    const pane = p as Record<string, unknown>;
    const cwd = isSafePath(pane.cwd) ? pane.cwd : null;
    const backendSessionId = typeof pane.backendSessionId === 'number' && Number.isInteger(pane.backendSessionId) && pane.backendSessionId > 0
      ? pane.backendSessionId
      : null;
    const role = typeof pane.role === 'string' && /^[\w\-. ]{0,63}$/.test(pane.role) ? pane.role : null;
    const title = isSafeLabel(pane.title, 128) ? pane.title : null;
    const paneTitle = isSafeLabel(pane.paneTitle, 256) ? pane.paneTitle : null;
    const agentName = isSafeLabel(pane.agentName, 80) ? pane.agentName : null;
    const agentPreset = isSafeLabel(pane.agentPreset, 128) && /^[\w\-./:@ ]{1,128}$/.test(pane.agentPreset) ? pane.agentPreset : null;
    const taskSummary = isSafeLabel(pane.taskSummary, 256) ? pane.taskSummary : null;
    const worktree = sanitisePersistedWorktree(pane.worktree);
    // Back-compat: entries persisted before hasSession existed are treated as
    // occupied panes so previously-saved terminals still get recreated.
    const hasSession = pane.hasSession === undefined ? true : Boolean(pane.hasSession);
    return { backendSessionId, role, cwd, hasSession, title, paneTitle, agentName, agentPreset, taskSummary, worktree };
  });

  const terminalLayout = typeof r.terminalLayout === 'string' ? r.terminalLayout : undefined;

  const ambient: AmbientLayout | undefined =
    r.ambient === 'focus' || r.ambient === 'development' || r.ambient === 'gallery' || r.ambient === 'preview' || r.ambient === 'vibe'
      ? r.ambient
      : (r.ambient === 'split' ? 'development' : undefined);

  const splitSlots = Array.isArray(r.splitSlots)
    ? (r.splitSlots as unknown[]).filter(isSafeRoomId).slice(0, MAX_SPLIT_SLOTS)
    : undefined;
  const focusedRoom = isSafeRoomId(r.focusedRoom) ? r.focusedRoom : null;
  const expandedRoom = isSafeRoomId(r.expandedRoom) ? r.expandedRoom : null;

  const minimizedRooms = Array.isArray(r.minimizedRooms)
    ? (r.minimizedRooms as unknown[]).filter(isSafeRoomId).slice(0, MAX_SPLIT_SLOTS)
    : undefined;
  const roomOrder = Array.isArray(r.roomOrder)
    ? (r.roomOrder as unknown[]).filter(isSafeRoomId).slice(0, MAX_SPLIT_SLOTS + 16)
    : undefined;
  const devTerminalOpen = r.devTerminalOpen === undefined ? undefined : Boolean(r.devTerminalOpen);

  let splitPresets: Record<number, string> | undefined;
  if (r.splitPresets && typeof r.splitPresets === 'object' && !Array.isArray(r.splitPresets)) {
    const entries = Object.entries(r.splitPresets as Record<string, unknown>)
      .filter(([k, v]) => !isNaN(Number(k)) && typeof v === 'string' && isSafePresetId(v))
      .map(([k, v]) => [Number(k), v as string]);
    if (entries.length > 0) {
      splitPresets = Object.fromEntries(entries);
    }
  }

  // Sanitise layout sub-object: clamp numerics, strip unknown view names
  let layout: PersistedProjectState['layout'] | undefined;
  if (r.layout && typeof r.layout === 'object') {
    const l = r.layout as Record<string, unknown>;
    layout = {
      activeView: typeof l.activeView === 'string' ? l.activeView : 'terminal',
      editorVisible: Boolean(l.editorVisible),
      previewVisible: Boolean(l.previewVisible),
      reviewVisible: Boolean(l.reviewVisible),
      httpVisible: Boolean(l.httpVisible),
      tasksVisible: Boolean(l.tasksVisible),
      orchestratorVisible: Boolean(l.orchestratorVisible),
      dbVisible: Boolean(l.dbVisible),
      toolboxVisible: Boolean(l.toolboxVisible),
      fleetVisible: Boolean(l.fleetVisible),
      containersVisible: Boolean(l.containersVisible),
      envVisible: Boolean(l.envVisible),
      youtubeVisible: Boolean(l.youtubeVisible),
      mobileVisible: Boolean(l.mobileVisible),
      sketchVisible: Boolean(l.sketchVisible),
      terminalRoomOpen: l.terminalRoomOpen === undefined ? true : Boolean(l.terminalRoomOpen),
      rightDrawerTool: sanitiseRightDrawerTool(l.rightDrawerTool),
      lastAuxView: typeof l.lastAuxView === 'string' ? l.lastAuxView : undefined,
      editorSplitPreview: Boolean(l.editorSplitPreview),
      auxPanelWidth: typeof l.auxPanelWidth === 'number' ? Math.max(180, Math.min(2000, l.auxPanelWidth)) : 550,
      auxEditorHeight: typeof l.auxEditorHeight === 'number' ? Math.max(10, Math.min(90, l.auxEditorHeight)) : 50,
      sidebarVisible: Boolean(l.sidebarVisible ?? true),
      sidebarWidth: typeof l.sidebarWidth === 'number' ? Math.max(100, Math.min(600, l.sidebarWidth)) : 310,
      sidebarTab: typeof l.sidebarTab === 'string' ? l.sidebarTab : 'files',
      leftPanelWidth: typeof l.leftPanelWidth === 'number' ? Math.max(180, Math.min(600, l.leftPanelWidth)) : 310,
      rightDrawerWidth: typeof l.rightDrawerWidth === 'number' ? Math.max(280, Math.min(720, l.rightDrawerWidth)) : 380,
    };
  }

  let preview: PersistedProjectState['preview'] | undefined;
  if (r.preview && typeof r.preview === 'object') {
    const p = r.preview as Record<string, unknown>;
    const rawTabs = Array.isArray(p.tabs) ? p.tabs : [];
    const tabs: PreviewTab[] = rawTabs.map((t: unknown): PreviewTab | null => {
      if (!t || typeof t !== 'object') return null;
      const tab = t as Record<string, unknown>;
      return {
        id: typeof tab.id === 'string' ? tab.id : '',
        title: typeof tab.title === 'string' ? tab.title : '',
        url: typeof tab.url === 'string' ? tab.url : '',
        loadUrl: typeof tab.loadUrl === 'string' ? tab.loadUrl : undefined,
        history: Array.isArray(tab.history) ? tab.history.filter((h): h is string => typeof h === 'string') : [],
        historyIndex: typeof tab.historyIndex === 'number' ? tab.historyIndex : 0,
        mediaPlaybackState: tab.mediaPlaybackState && typeof tab.mediaPlaybackState === 'object'
          ? {
              currentTime: typeof (tab.mediaPlaybackState as any).currentTime === 'number' ? (tab.mediaPlaybackState as any).currentTime : 0,
              paused: typeof (tab.mediaPlaybackState as any).paused === 'boolean' ? (tab.mediaPlaybackState as any).paused : true,
            }
          : undefined,
      };
    }).filter((t): t is PreviewTab => t !== null && t.url !== '');
    
    const activeTabId = typeof p.activeTabId === 'string' ? p.activeTabId : null;
    const targetPortVal = typeof p.targetPort === 'number' ? p.targetPort : undefined;
    const proxyStartedVal = typeof p.proxyStarted === 'boolean' ? p.proxyStarted : undefined;
    preview = { tabs, activeTabId, targetPort: targetPortVal, proxyStarted: proxyStartedVal };
  }

  return { openFiles, activeFile, expandedPaths, selectedPath, terminalPanes, terminalLayout, ambient, splitSlots, focusedRoom, expandedRoom, splitPresets, minimizedRooms, roomOrder, devTerminalOpen, layout, preview };
}

/**
 * Exposed for tests. A field that is saved but not taught to the sanitiser is
 * silently stripped on load — the failure mode this whole function invites, and
 * one nothing else would catch.
 */
export const __sanitisePersistedProjectState = sanitisePersistedProjectState;

function loadProjectStateFromStorage(projectId: string): PersistedProjectState | null {
  if (typeof window === 'undefined') return null;
  try {
    const stored = localStorage.getItem(projectStorageKey(projectId));
    if (!stored) return null;
    return sanitisePersistedProjectState(JSON.parse(stored));
  } catch {
    return null;
  }
}

// ─────────────────────────────────────────────────────────────────────────

export function saveProjectState(projectId: string) {
  // Shared stores are incomplete while a project is being restored.
  if (isRestoringProjectState) return;
  const terminalState = getTerminalProjectState(projectId);
  projectStateCache.set(projectId, {
    editor: {
      openFiles: get(openFiles),
      activeFile: get(activeFile),
      fileCache: new Map(get(fileCache)),
      activeLine: get(activeLine),
      activeColumn: get(activeColumn),
    },
    terminal: {
      sessions: terminalState.sessions,
      activeSessionId: terminalState.activeSessionId,
      gridLayout: terminalState.gridLayout,
      paneAssignments: terminalState.paneAssignments,
      activePaneIndex: terminalState.activePaneIndex,
    },
    preview: {
      targetPort: get(targetPort),
      proxyPort: get(proxyPort),
      proxyStarted: get(proxyStarted),
      currentUrl: get(currentUrl),
      tabs: get(previewTabs),
      activeTabId: get(activePreviewTabId),
    },
    explorer: {
      expandedPaths: new Set(get(expandedPaths)),
      selectedPath: get(selectedPath),
    },
    ambient: get(layoutSnapshot).ambient,
    splitSlots: get(layoutSnapshot).splitSlots,
    focusedRoom: focusedRoomOf(get(layoutSnapshot)),
    expandedRoom: get(layoutSnapshot).expandedRoom ?? null,
    splitPresets: get(layoutSnapshot).splitPresets,
    minimizedRooms: get(layoutSnapshot).minimizedRooms ?? [],
    roomOrder: get(layoutSnapshot).roomOrder ?? [],
    devTerminalOpen: get(layoutSnapshot).devTerminalOpen ?? false,
    layout: {
      activeView: get(layout).activeView,
      editorVisible: get(layout).editorVisible,
      previewVisible: get(layout).previewVisible,
      reviewVisible: get(layout).reviewVisible,
      httpVisible: get(layout).httpVisible,
      tasksVisible: get(layout).tasksVisible,
      orchestratorVisible: get(layout).orchestratorVisible,
      dbVisible: get(layout).dbVisible,
      toolboxVisible: get(layout).toolboxVisible,
      fleetVisible: get(layout).fleetVisible,
      containersVisible: get(layout).containersVisible,
      envVisible: get(layout).envVisible,
      youtubeVisible: get(layout).youtubeVisible,
      mobileVisible: get(layout).mobileVisible,
      sketchVisible: get(layout).sketchVisible,
      terminalRoomOpen: get(terminalRoomOpen),
      rightDrawerTool: currentRightDrawerTool(),
      lastAuxView: get(layout).lastAuxView,
      editorSplitPreview: get(layout).editorSplitPreview,
      auxPanelWidth: get(layout).auxPanelWidth,
      auxEditorHeight: get(layout).auxEditorHeight,
      sidebarVisible: get(layout).sidebarVisible,
      sidebarWidth: get(layout).sidebarWidth,
      sidebarTab: get(layout).sidebarTab,
      leftPanelWidth: get(layout).leftPanelWidth,
      rightDrawerWidth: get(layout).rightDrawerWidth,
    },
  });
  // Also persist to localStorage so state survives app close
  saveProjectStateToStorage(projectId);
  // `collectOpenRoomIds` reads the live stores, which only ever describe the
  // active project — so only the active project's entry may be rewritten here.
  if (get(activeProjectId) === projectId) publishProjectRooms(projectId);
}

function saveCurrentProjectState() {
  const currentId = get(activeProjectId);
  if (currentId) {
    saveProjectState(currentId);
  }
}

export async function restoreProjectState(projectId: string, rootPath: string) {
  const generation = ++restoreProjectStateGeneration;
  isRestoringProjectState = true;
  cancelPendingProjectAutosave();
  resetEditorSession();
  isProjectSwitching.set(true);
  useWorkspaceStore.getState().setSwitchingPhase('Restoring project…');
  try {
    const { invoke } = await import('@tauri-apps/api/core');
    if (generation !== restoreProjectStateGeneration) return;
    try {
      await invoke('workspace_set_active', { projectId });
    } catch (e) {
      console.error('Failed to notify backend of active project switch:', e);
    }
    if (generation !== restoreProjectStateGeneration) return;

    clearAllStores();
    setActiveTerminalProject(projectId);
    // Make this project's root available to the terminal store so agents typed
    // straight into a shell (no explicit cwd) can still be briefed via their
    // rules file (CLAUDE.md / AGENTS.md) instead of falling back to the paste.
    setTerminalProjectRoot(projectId, rootPath);

    // Write each CLI's MCP config immediately so any MCP-capable agent opened in
    // this project (even manually typed) discovers the Spacron MCP server.
    import('./mcpBridge').then(({ ensureMcpConfigs }) => ensureMcpConfigs(rootPath)).catch(() => {});

    // Whether this project actually had a saved layout to put back. A project
    // that did keeps exactly what it was left with; only one that did NOT falls
    // through to the default stage at the end of this function.
    let restoredLayout = false;

    const cached = projectStateCache.get(projectId);
    if (cached) {
      if (generation !== restoreProjectStateGeneration) return;
      openFiles.set(cached.editor.openFiles);
      activeFile.set(cached.editor.activeFile);
      fileCache.set(new Map(cached.editor.fileCache));
      activeLine.set(cached.editor.activeLine);
      activeColumn.set(cached.editor.activeColumn);

      const currentTerminalState = getTerminalProjectState(projectId);
      const hasLiveTerminalState =
        currentTerminalState.sessions.length > 0 ||
        currentTerminalState.activeSessionId !== null ||
        currentTerminalState.paneAssignments.some((value) => value !== null);
      if (!hasLiveTerminalState) {
        restoreTerminalProjectState(projectId, cached.terminal as any);
        setActiveTerminalProject(projectId);
      }

      const restoredUrl = cached.preview.currentUrl || '/';
      const localPreview = parseLocalPreviewUrl(restoredUrl);
      const restoredTargetPort = localPreview?.port ?? cached.preview.targetPort;

      // Point the shared preview proxy at THIS project's dev server BEFORE we
      // restore the tabs / show the panel. The proxy's target port is
      // process-global, so mounting this project's iframes (which immediately
      // hit the proxy) while the backend still targets the previous project's
      // port leaks that project's content into this preview — and it sticks,
      // because the iframe never re-requests once the port catches up.
      try {
        await setPreferredLocalHost(localPreview?.host ?? null);
        if (generation !== restoreProjectStateGeneration) return;
        await invoke('preview_set_target_port', { port: restoredTargetPort });
      } catch (e) {
        console.error('Failed to restore preview target port:', e);
      }
      if (generation !== restoreProjectStateGeneration) return;

      targetPort.set(restoredTargetPort);
      proxyPort.set(cached.preview.proxyPort);
      proxyStarted.set(cached.preview.proxyStarted);
      restorePreviewTabsState(cached.preview.tabs, cached.preview.activeTabId);
      preferredLocalHost.set(localPreview?.host || 'localhost');

      expandedPaths.set(new Set(cached.explorer.expandedPaths));
      selectedPath.set(cached.explorer.selectedPath);
      selectedPaths.set(new Set(cached.explorer.selectedPath ? [cached.explorer.selectedPath] : []));

      layout.update((l) => ({
        ...l,
        activeView: sanitiseActiveView(cached.layout.activeView, l.activeView),
        editorVisible: cached.layout.editorVisible,
        previewVisible: cached.layout.previewVisible,
        reviewVisible: cached.layout.reviewVisible,
        httpVisible: cached.layout.httpVisible,
        tasksVisible: cached.layout.tasksVisible,
        orchestratorVisible: cached.layout.orchestratorVisible,
        dbVisible: cached.layout.dbVisible,
        toolboxVisible: cached.layout.toolboxVisible,
        fleetVisible: cached.layout.fleetVisible,
        containersVisible: cached.layout.containersVisible,
        envVisible: cached.layout.envVisible,
        youtubeVisible: cached.layout.youtubeVisible,
        mobileVisible: cached.layout.mobileVisible,
        sketchVisible: cached.layout.sketchVisible,
        lastAuxView: sanitiseActiveView(cached.layout.lastAuxView, l.lastAuxView),
        editorSplitPreview: cached.layout.editorSplitPreview,
        auxPanelWidth: cached.layout.auxPanelWidth,
        auxEditorHeight: cached.layout.auxEditorHeight,
        sidebarVisible: cached.layout.sidebarVisible,
        sidebarWidth: cached.layout.sidebarWidth,
        sidebarTab: l.sidebarTab === 'projects' ? 'projects' : sanitiseSidebarTab(cached.layout.sidebarTab, l.sidebarTab),
        leftPanelWidth: cached.layout.leftPanelWidth,
        rightDrawerWidth: cached.layout.rightDrawerWidth,
      }));

      // The right utility drawer is per-project too: a tool opened over one
      // project must not still be open over the next. Applied AFTER the layout
      // patch above so it owns the drawer flags outright, and via
      // `applyRightDrawerTool` (not `setRightDrawerTool`) so closing the drawer
      // doesn't drag `activeView` back to the terminal.
      applyRightDrawerTool(cached.layout.rightDrawerTool ?? null);

      // The Terminal room is not a `LayoutState` flag, so the patch above can't
      // carry it — restore it on its own or closing it leaks across projects.
      terminalRoomOpen.set(cached.layout.terminalRoomOpen ?? true);
      restoredLayout = true;

      // Restore the workspace's stage for this project via the AppShell command
      // bus — mode, Split tiling and the primary room together, so switching
      // back lands on the panes that were open rather than on whatever the
      // project you came from was showing. Defaults to Split with no
      // arrangement, so a project that has none doesn't inherit the other's.
      requestRoomArrangement(
        cached.ambient ?? 'gallery',
        cached.splitSlots ?? [],
        cached.focusedRoom ?? null,
        cached.expandedRoom ?? null,
        cached.splitPresets,
        cached.minimizedRooms,
        cached.roomOrder,
        cached.devTerminalOpen,
      );
    } else {
      const persisted = loadProjectStateFromStorage(projectId);
      if (generation !== restoreProjectStateGeneration) return;

      if (!persisted?.preview) {
        try {
          const port = await invoke<number>('workspace_detect_port', { path: rootPath });
          if (generation !== restoreProjectStateGeneration) return;
          await setTargetPort(port, { silent: true });
        } catch (err) {
          console.error('Failed to auto-detect/set up preview for new project:', err);
        }
      }

      if (persisted) {
        const hadEditorFiles = persisted.openFiles.length > 0;
        if (hadEditorFiles) {
          if (generation !== restoreProjectStateGeneration) return;
          await restoreEditorFiles(persisted.openFiles, persisted.activeFile);
        }
        if (generation !== restoreProjectStateGeneration) return;
        expandedPaths.set(new Set(persisted.expandedPaths));
        selectedPath.set(persisted.selectedPath ?? null);
        selectedPaths.set(new Set(persisted.selectedPath ? [persisted.selectedPath] : []));

        if (persisted.preview) {
          if (generation !== restoreProjectStateGeneration) return;
          restorePreviewTabsState(persisted.preview.tabs, persisted.preview.activeTabId);
          if (persisted.preview.targetPort !== undefined) {
            targetPort.set(persisted.preview.targetPort);
            try {
              await invoke('preview_set_target_port', { port: persisted.preview.targetPort });
            } catch (e) {
              console.error('Failed to set target port during storage restore:', e);
            }
          }
          if (persisted.preview.proxyStarted !== undefined) {
            proxyStarted.set(persisted.preview.proxyStarted);
          }
        }

        const hadTerminalPanes = persisted.terminalPanes && persisted.terminalPanes.some((p) => p.hasSession);
        const toastLabel = hadEditorFiles || hadTerminalPanes ? 'Restored' : 'Started';
        const { showToast } = await import('./notification');
        if (generation !== restoreProjectStateGeneration) return;
        showToast(`${toastLabel} ${projectId.slice(0, 8)}`, 'info', 2000);
      }

      if (generation !== restoreProjectStateGeneration) return;
      if (!persisted?.layout) {
        // LayoutState is process-global, so a project with no saved layout must
        // not inherit panels, drawer widths, or sidebar choices from the
        // project we just left. A genuinely new project starts with an empty
        // stage; the user can open an agent, terminal, or editor explicitly.
        layout.update((l) => ({
          ...l,
          activeView: 'terminal',
          editorVisible: false,
          previewVisible: false,
          reviewVisible: false,
          httpVisible: false,
          tasksVisible: false,
          orchestratorVisible: false,
          dbVisible: false,
          toolboxVisible: false,
          fleetVisible: false,
          containersVisible: false,
          envVisible: false,
          youtubeVisible: false,
          mobileVisible: false,
          sketchVisible: false,
          lastAuxView: 'preview',
          editorSplitPreview: false,
          auxPanelWidth: 550,
          auxEditorHeight: 50,
          sidebarVisible: true,
          sidebarWidth: 310,
          sidebarTab: 'files',
          leftPanelWidth: 310,
          rightDrawerWidth: 380,
        }));
      } else {
        layout.update((l) => ({
          ...l,
          activeView: sanitiseActiveView(persisted.layout!.activeView, 'terminal'),
          editorVisible: persisted.layout!.editorVisible ?? false,
          previewVisible: persisted.layout!.previewVisible ?? false,
          reviewVisible: persisted.layout!.reviewVisible ?? false,
          httpVisible: persisted.layout!.httpVisible ?? false,
          tasksVisible: persisted.layout!.tasksVisible ?? false,
          orchestratorVisible: persisted.layout!.orchestratorVisible ?? false,
          dbVisible: persisted.layout!.dbVisible ?? false,
          toolboxVisible: persisted.layout!.toolboxVisible ?? false,
          fleetVisible: persisted.layout!.fleetVisible ?? false,
          containersVisible: persisted.layout!.containersVisible ?? false,
          envVisible: persisted.layout!.envVisible ?? false,
          youtubeVisible: persisted.layout!.youtubeVisible ?? false,
          mobileVisible: persisted.layout!.mobileVisible ?? false,
          sketchVisible: persisted.layout!.sketchVisible ?? false,
          lastAuxView: sanitiseActiveView(persisted.layout!.lastAuxView, l.lastAuxView),
          editorSplitPreview: persisted.layout!.editorSplitPreview ?? false,
          auxPanelWidth: persisted.layout!.auxPanelWidth ?? 550,
          auxEditorHeight: persisted.layout!.auxEditorHeight ?? 50,
          sidebarVisible: persisted.layout!.sidebarVisible ?? true,
          sidebarWidth: persisted.layout!.sidebarWidth ?? 310,
          sidebarTab: l.sidebarTab === 'projects' ? 'projects' : sanitiseSidebarTab(persisted.layout!.sidebarTab, 'files'),
          leftPanelWidth: persisted.layout!.leftPanelWidth ?? 310,
          rightDrawerWidth: persisted.layout!.rightDrawerWidth ?? 380,
        }));
        terminalRoomOpen.set(persisted.layout.terminalRoomOpen ?? true);
        restoredLayout = true;
      }

      // Unconditional, unlike the layout patch above: a project with no saved
      // state at all must still land with the drawer CLOSED rather than
      // inheriting whatever the project we came from had open.
      applyRightDrawerTool(sanitiseRightDrawerTool(persisted?.layout?.rightDrawerTool));

      // Restore (or default) this project's stage so each project keeps its own
      // mode, Split tiling and primary room. Cold-start path: the agent rooms
      // named in a saved arrangement belong to sessions from the previous run,
      // so most of these ids resolve to nothing — the shell drops what isn't
      // open and falls back to the default stage, which is the right outcome.
      requestRoomArrangement(
        persisted?.ambient ?? 'gallery',
        persisted?.splitSlots ?? [],
        persisted?.focusedRoom ?? null,
        persisted?.expandedRoom ?? null,
        persisted?.splitPresets,
        persisted?.minimizedRooms ?? [],
        persisted?.roomOrder ?? [],
        persisted?.devTerminalOpen ?? false,
      );

      const existingTerminalState = getTerminalProjectState(projectId);
      const hasLiveTerminalState =
        existingTerminalState.sessions.length > 0 ||
        existingTerminalState.activeSessionId !== null ||
        existingTerminalState.paneAssignments.some((id) => id !== null);

      if (!hasLiveTerminalState) {
        const occupiedPanes = persisted?.terminalPanes?.filter((pane) => pane.hasSession) ?? [];
        if (persisted?.terminalPanes && occupiedPanes.length > 0) {
          const { setGridLayout } = await import('./terminal');
          if (persisted.terminalLayout) {
            setGridLayout(persisted.terminalLayout as any);
          }
          useWorkspaceStore.getState().setSwitchingPhase('Restoring terminals…');
          const spawnedIds: number[] = [];
          // Recreate a session only for panes that actually held one, keeping
          // each session in its original pane slot and leaving empty panes empty.
          //
          // Panes are restored concurrently: each session's pane slot is fixed by
          // `targetPaneIndex`, and neither attach/create depends on another pane's
          // result, so serializing them only adds up to N IPC round-trips of
          // latency to every project switch. `relaunchRestoredAgentSession` awaits
          // its own freshly created session, so it stays per-pane — only the
          // cross-pane wait is removed.
          const restorePane = async (pane: PersistedTerminalPane, i: number) => {
            if (generation !== restoreProjectStateGeneration) return null;
            if (!pane.hasSession) return null;
            const metadata = {
              title: pane.title,
              paneTitle: pane.paneTitle,
              agentName: pane.agentName,
              agentPreset: pane.agentPreset,
              role: pane.role,
              taskSummary: pane.taskSummary,
              worktree: pane.worktree ?? null,
            };
            if (pane.agentPreset) {
              // Agents are their own rooms — they must NOT be slotted into the
              // user's terminal grid, or the mosaic renders their cell as an empty
              // "Agent is open as a panel" pane (the stray empty terminals seen on
              // reload). Restore them with assignPane:false so they surface as
              // rooms; if their backend PTY is gone (cold start), relaunch the CLI
              // into a fresh room rather than leaving a dead shell behind.
              const attachedId = pane.backendSessionId
                ? await attachTerminalSession(pane.backendSessionId, pane.cwd || rootPath, undefined, projectId, metadata, { assignPane: false })
                : null;
              if (attachedId !== null) {
                return attachedId;
              }
              const roomId = await createTerminalSession(pane.cwd || rootPath, undefined, projectId, { assignPane: false, agentPreset: pane.agentPreset });
              if (roomId !== null) {
                await relaunchRestoredAgentSession(roomId, pane.agentPreset, metadata);
                return roomId;
              }
              return null;
            }
            // Legacy plain-terminal panes (persisted before only agents were
            // saved): keep the original behaviour of restoring into the grid.
            const attachedId = pane.backendSessionId
              ? await attachTerminalSession(pane.backendSessionId, pane.cwd || rootPath, i, projectId, metadata)
              : null;
            // `projectId` is REQUIRED here. Without it the session is created in
            // whatever project is currently active, so restoring project B while
            // project A is on screen put B's shells into A — the terminal then
            // showed a path from a different project than the one you're in.
            const id = attachedId ?? await createTerminalSession(pane.cwd || rootPath, i, projectId);
            if (id !== null) {
              if (attachedId === null) {
                applyRestoredSessionMetadata(id, metadata);
              }
              return id;
            }
            return null;
          };

          const restored = await Promise.all(
            persisted.terminalPanes.map((pane, i) => restorePane(pane, i)),
          );
          for (const id of restored) {
            if (id !== null) spawnedIds.push(id);
          }
          const { showToast } = await import('./notification');
          if (generation !== restoreProjectStateGeneration) return;
          if (spawnedIds.length > 1) {
            showToast(`Restored ${spawnedIds.length} terminal sessions`, 'info', 3000);
          }
        }
      }
    }
    // Load this project's orchestrator state LAST, once its terminal sessions
    // are back. Order matters twice over: the loader reconciles persisted tasks
    // against live sessions (running it early resets every in-progress task to
    // todo), and it then sweeps worktrees that no task or session claims — so a
    // restored agent whose session isn't in the store yet would look orphaned
    // and have its worktree deleted out from under it.
    //
    // This is also the ONLY writer of the orchestrator's projectId → root_path
    // map, which its background flush and periodic worktree sweep both iterate.
    // Nothing else may call it, or those go quiet.
    if (generation !== restoreProjectStateGeneration) return;
    try {
      const { loadProjectOrchestratorTasks } = await import('./orchestrator');
      await loadProjectOrchestratorTasks({ id: projectId, root_path: rootPath });
    } catch (e) {
      console.error('Failed to load orchestrator state for project:', e);
    }

    // A project with NO saved layout is intentionally blank. Gated on
    // `restoredLayout` so an existing project's saved rooms remain untouched.
    if (generation !== restoreProjectStateGeneration) return;
    if (!restoredLayout) {
      terminalRoomOpen.set(false);
      layout.update((l) => ({ ...l, activeView: 'terminal', editorVisible: false }));
    }
  } finally {
    if (generation === restoreProjectStateGeneration) {
      isRestoringProjectState = false;
      isProjectSwitching.set(false);
      useWorkspaceStore.getState().setSwitchingPhase(null);
      // Autosave is muted for the whole restore, so nothing else publishes the
      // rooms this project just came back with. Skipped when a newer restore has
      // already taken over — the live stores describe that project by now.
      publishProjectRooms(projectId);
    }
  }
}

export function clearAllStores() {
  resetEditorSession();

  sessions.set([]);
  activeSessionId.set(null);
  gridLayout.set('single');
  paneAssignments.set([null]);
  activePaneIndex.set(0);

  targetPort.set(5173);
  proxyPort.set(null);
  proxyStarted.set(false);
  resetPreviewTabsState();
  currentUrl.set('/');
  preferredLocalHost.set('localhost');

  expandedPaths.set(new Set());
  selectedPath.set(null);
  selectedPaths.set(new Set());

  layout.update((l) => ({
    ...l,
    activeView: 'terminal',
    editorVisible: false,
    previewVisible: false,
    reviewVisible: false,
    httpVisible: false,
    tasksVisible: false,
    orchestratorVisible: false,
    dbVisible: false,
    toolboxVisible: false,
    editorSplitPreview: false,
    auxPanelWidth: 550,
    auxEditorHeight: 50,
    sidebarTab: l.sidebarTab === 'projects' ? 'projects' : 'files',
  }));
}

export function setActiveProject(project: Project) {
  saveCurrentProjectState();

  projects.update((p) => setProjectIn(p, project.id, project));

  // Add to open projects if not already there
  openProjectIds.update((ids) => {
    if (!ids.includes(project.id)) return [...ids, project.id];
    return ids;
  });

  activeProjectId.set(project.id);
  setActiveTerminalProject(project.id);

  // Tell the preview proxy which project root to serve local files from.
  import('./preview').then(({ setPreviewProjectRoot }) => {
    setPreviewProjectRoot(project.root_path);
  });

  // Update active workspace's active path
  const wsId = get(activeWorkspaceId);
  if (wsId) {
    recentWorkspaces.update((wsList) =>
      wsList.map((w) =>
        w.id === wsId ? { ...w, active_project_path: project.root_path } : w
      )
    );
  }

  restoreProjectState(project.id, project.root_path).catch((e) => console.error('restoreProjectState failed:', e));
}

export function clearActiveProject() {
  saveCurrentProjectState();
  activeProjectId.set(null);
  setActiveTerminalProject(null);
  import('./preview').then(({ setPreviewProjectRoot }) => {
    setPreviewProjectRoot(null);
  });
  clearAllStores();
  import('@tauri-apps/api/core').then(({ invoke }) => {
    invoke('workspace_set_active', { projectId: null }).catch((e) => {
      console.error('Failed to clear active project on backend:', e);
    });
  });
}

function getFilename(path: string): string {
  const normalized = path.replace(/\\/g, '/');
  const parts = normalized.split('/');
  return parts[parts.length - 1] || path;
}

export function createNewWorkspace(name?: string) {
  const id = `ws-${Date.now()}`;
  const newWorkspace: Workspace = {
    id,
    name: name?.trim() || 'New Workspace',
    project_paths: [],
    active_project_path: null,
    last_opened: Date.now().toString(),
  };

  recentWorkspaces.update((ws) => [newWorkspace, ...ws]);
  activeWorkspaceId.set(id);
  // Every entry point into a workspace closes the Home overlay (see homeScreenOpen).
  homeScreenOpen.set(false);

  // Clear current active project and folder list
  clearActiveProject();
  projects.set(new Map());
  openProjectIds.set([]);
}

export async function openWorkspace(workspaceId: string) {
  // Re-entering the workspace you are already in (the usual Home → back trip) is
  // a no-op beyond closing the Home overlay. The full path below clears every
  // store, re-opens each project from the backend and re-runs restoreProjectState
  // — for the SAME workspace that rebuilds state that is already live, and any
  // terminal pane that unmounted in the meantime has to reattach by replaying its
  // scrollback. Replaying a full-screen agent TUI's raw stream into a fresh xterm
  // is what left agents rendering garbage (or nothing) after a trip home.
  if (workspaceId === get(activeWorkspaceId) && get(projects).size > 0) {
    homeScreenOpen.set(false);
    return;
  }

  // Save the current project's state before leaving it so it can be restored later
  saveCurrentProjectState();
  // Drop any debounced autosave still queued from the outgoing project — the
  // clearAllStores() below mutates the tracked stores, and a stale timer firing
  // mid-switch would write transitional/cleared state under the wrong id.
  cancelPendingProjectAutosave();

  isProjectHUDOpen.set(false);

  // Set as active
  activeWorkspaceId.set(workspaceId);

  // Update last_opened timestamp and move to top of the list
  recentWorkspaces.update((list) => {
    const updated = list.map((w) => {
      if (w.id === workspaceId) {
        return { ...w, last_opened: Date.now().toString() };
      }
      return w;
    });
    const ws = updated.find((w) => w.id === workspaceId);
    if (ws) {
      return [ws, ...updated.filter((w) => w.id !== workspaceId)];
    }
    return updated;
  });

  const wsList = get(recentWorkspaces);
  const targetWs = wsList.find((w) => w.id === workspaceId);
  if (!targetWs) return;

  homeScreenOpen.set(false);

  // Clear current project stores
  clearAllStores();
  projects.set(new Map());
  openProjectIds.set([]);
  activeProjectId.set(null);
  setActiveTerminalProject(null);

  // Load all projects in the workspace
  if (targetWs.project_paths.length > 0) {
    for (const path of targetWs.project_paths) {
      try {
        const { invoke } = await import('@tauri-apps/api/core');
        const project = await invoke<Project>('workspace_open_project', { path });
        projects.update((p) => setProjectIn(p, project.id, project));
        openProjectIds.update((ids) => {
          if (!ids.includes(project.id)) return [...ids, project.id];
          return ids;
        });
      } catch (err) {
        console.error(`Failed to open project ${path} in workspace:`, err);
      }
    }

    // Restore active project
    if (targetWs.active_project_path) {
      const allProjects = get(projects);
      const activeProj = Array.from(allProjects.values()).find((p) => p.root_path === targetWs.active_project_path);
      if (activeProj) {
        activeProjectId.set(activeProj.id);
        setActiveTerminalProject(activeProj.id);
        restoreProjectState(activeProj.id, activeProj.root_path).catch((e) => console.error('restoreProjectState failed:', e));
      } else {
        const firstProjId = get(openProjectIds)[0];
        if (firstProjId) {
          const firstProj = allProjects.get(firstProjId);
          if (firstProj) {
            activeProjectId.set(firstProjId);
            setActiveTerminalProject(firstProjId);
            restoreProjectState(firstProjId, firstProj.root_path).catch((e) => console.error('restoreProjectState failed:', e));
          }
        }
      }
    } else {
      const firstProjId = get(openProjectIds)[0];
      if (firstProjId) {
        const firstProj = get(projects).get(firstProjId);
        if (firstProj) {
          activeProjectId.set(firstProjId);
          setActiveTerminalProject(firstProjId);
          restoreProjectState(firstProjId, firstProj.root_path).catch((e) => console.error('restoreProjectState failed:', e));
        }
      }
    }
  }
}

/** Register an already-opened project as the active project of the active
 *  workspace (creating a placeholder workspace if none is active). Shared by
 *  `addFolderToWorkspace` (open existing) and `createProjectFolder` (start fresh).
 *  `path` is the value recorded in the workspace's `project_paths` and reused to
 *  re-open the project later, so it must match what `workspace_open_project`
 *  accepts for that folder. */
async function attachProjectToActiveWorkspace(project: Project, path: string) {
  let wsId = get(activeWorkspaceId);
  if (!wsId) {
    createNewWorkspace();
    wsId = get(activeWorkspaceId);
  }
  if (!wsId) return;

  const currentActiveId = get(activeProjectId);
  if (currentActiveId) {
    saveProjectState(currentActiveId);
  }

  projects.update((p) => setProjectIn(p, project.id, project));

  openProjectIds.update((ids) => {
    if (!ids.includes(project.id)) return [...ids, project.id];
    return ids;
  });

  activeProjectId.set(project.id);
  setActiveTerminalProject(project.id);
  homeScreenOpen.set(false);
  await restoreProjectState(project.id, project.root_path);

  // Update active workspace
  recentWorkspaces.update((wsList) => {
    return wsList.map((w) => {
      if (w.id === wsId) {
        const paths = [...w.project_paths];
        if (!paths.includes(path)) {
          paths.push(path);
        }

        // Only auto-name a freshly-created (placeholder) workspace after its
        // first folder. Once a workspace has a real name, leave it untouched —
        // adding more projects must not rewrite the user's chosen name.
        let wsName = w.name;
        if (w.name === 'New Collection' || w.name === 'New Workspace' || w.name.trim() === '' || w.name === 'Empty Collection' || w.name === 'Empty Workspace') {
          wsName = getFilename(path);
        }

        return {
          ...w,
          name: wsName,
          project_paths: paths,
          active_project_path: path,
          last_opened: Date.now().toString(),
        };
      }
      return w;
    });
  });
}

export async function addFolderToWorkspace(path: string) {
  try {
    const { invoke } = await import('@tauri-apps/api/core');
    const project = await invoke<Project>('workspace_open_project', { path });
    await attachProjectToActiveWorkspace(project, path);
  } catch (err) {
    console.error('Failed to add folder to workspace:', err);
    throw err;
  }
}

/** Create a brand-new empty folder named `name` under `parentDir` on disk and open
 *  it as the active project — the "start fresh" flow. The backend creates the
 *  directory and registers it as a project root in one step; we then attach it to
 *  the active workspace exactly like opening an existing folder. */
export async function createProjectFolder(parentDir: string, name: string): Promise<Project> {
  const { invoke } = await import('@tauri-apps/api/core');
  const project = await invoke<Project>('workspace_create_project', { parent: parentDir, name });
  await attachProjectToActiveWorkspace(project, project.root_path);
  return project;
}

/** Clone a GitHub repo into `parentDir` and open the result as a project. The
 *  clone itself (network, auth, folder naming) is the backend's job — this only
 *  attaches the finished checkout, exactly as `createProjectFolder` does. */
export async function cloneRepository(url: string, parentDir: string): Promise<Project> {
  const { invoke } = await import('@tauri-apps/api/core');
  const project = await invoke<Project>('workspace_clone_repo', { url, parent: parentDir });
  await attachProjectToActiveWorkspace(project, project.root_path);
  return project;
}

export function closeProject(projectId: string) {
  // Reclaim this project's agent worktrees before the sessions that own them go
  // away — otherwise the checkouts sit in `.spacron/worktrees/` forever, which
  // is the bulk of what Spacron leaves on disk. Started BEFORE killSession so
  // `trackedWorktrees()` can still see the sessions; it stages each agent's work
  // onto its branch and keeps any checkout git says still holds something.
  //
  // Deliberately not awaited: closing a project must stay instant. A run cut
  // short by the app exiting is picked up by `sweepOrphanWorktrees` on the next
  // load of this project.
  void (async () => {
    try {
      const { reclaimProjectWorktrees } = await import('./orchestrator');
      const outcome = await reclaimProjectWorktrees(projectId);
      if (outcome.kept > 0) {
        const { showToast } = await import('./notification');
        const names = [...new Set(outcome.keptAgents)].join(', ');
        showToast(
          `Kept ${outcome.kept} agent worktree${outcome.kept === 1 ? '' : 's'} holding unmerged work (${names})`,
          'info',
          6000,
        );
      }
    } catch (e) {
      console.error('Worktree reclaim on project close failed:', e);
    }
  })();

  // Kill terminal sessions for this project
  const cached = projectStateCache.get(projectId);
  if (cached && cached.terminal && cached.terminal.sessions) {
    for (const session of cached.terminal.sessions) {
      killSession(session.id);
    }
  }

  const current = get(activeProjectId);
  if (current === projectId) {
    const currentSessions = get(sessions);
    for (const session of currentSessions) {
      killSession(session.id);
    }
  }

  // Remove from in-memory cache and localStorage
  projectStateCache.delete(projectId);
  projectOpenRooms.update((map) => {
    if (!map.has(projectId)) return map;
    const next = new Map(map);
    next.delete(projectId);
    return next;
  });
  if (typeof window !== 'undefined') localStorage.removeItem(projectStorageKey(projectId));

  const wsId = get(activeWorkspaceId);
  const p = get(projects).get(projectId);
  if (wsId && p) {
    recentWorkspaces.update((wsList) => {
      return wsList.map((w) => {
        if (w.id === wsId) {
          const paths = w.project_paths.filter((x) => x !== p.root_path);
          let activePath = w.active_project_path;
          if (activePath === p.root_path) {
            activePath = paths.length > 0 ? paths[paths.length - 1] : null;
          }

          // Keep the user's workspace name; closing a project must not rename it.
          return {
            ...w,
            project_paths: paths,
            active_project_path: activePath,
          };
        }
        return w;
      });
    });
  }

  if (current === projectId) {
    const ids = get(openProjectIds);
    const remainingIds = ids.filter((id) => id !== projectId);
    openProjectIds.set(remainingIds);

    const nextId = remainingIds.length > 0 ? remainingIds[remainingIds.length - 1] : null;
    activeProjectId.set(nextId);

    if (nextId) {
      const nextProject = get(projects).get(nextId);
      if (nextProject) {
        if (wsId) {
          recentWorkspaces.update((wsList) =>
            wsList.map((w) =>
              w.id === wsId ? { ...w, active_project_path: nextProject.root_path } : w
            )
          );
        }
        // Switch the visible terminal state to the fallback project synchronously,
        // BEFORE restoreProjectState. This keeps gridLayout updating in the same
        // effect flush as activeProject so TerminalPanel's layout effects stay
        // coordinated and the project's saved pane layout isn't clobbered by a
        // stale preset re-apply. Mirrors switchToProject / openProjectByPath.
        setActiveTerminalProject(nextId);
        restoreProjectState(nextId, nextProject.root_path).catch((e) => console.error('restoreProjectState failed:', e));
      }
    } else {
      setActiveTerminalProject(null);
      clearAllStores();
      import('@tauri-apps/api/core').then(({ invoke }) => {
        invoke('workspace_set_active', { projectId: null }).catch((e) => {
          console.error('Failed to clear active project on backend:', e);
        });
      });
    }
  } else {
    openProjectIds.update((ids) => ids.filter((id) => id !== projectId));
  }
}

export function switchToProject(projectId: string) {
  const current = get(activeProjectId);
  if (current === projectId) return; // already active

  if (current) {
    saveProjectState(current);
  }

  const p = get(projects).get(projectId);
  if (p) {
    isProjectHUDOpen.set(false);
    activeProjectId.set(projectId);
    setActiveTerminalProject(projectId);
    
    const wsId = get(activeWorkspaceId);
    if (wsId) {
      recentWorkspaces.update((wsList) =>
        wsList.map((w) =>
          w.id === wsId ? { ...w, active_project_path: p.root_path } : w
        )
      );
    }
    
    restoreProjectState(projectId, p.root_path).catch((e) => console.error('restoreProjectState failed:', e));
  }
}

export async function openProjectByPath(path: string) {
  await addFolderToWorkspace(path);
}

// ── Remote workspace root (Step 4 of docs/remote-workspace.md) ─────────────
// Connecting to a remote opens a project pointed at the server's `--workspace`
// root so the file tree + editor follow it. These files/terminals read/write
// through the `backendInvoke` seam, which routes to the server while a remote is
// active — so a `remote:<id>` project needs no local Tauri project registration.
// We keep this deliberately separate from the local `restoreProjectState` path
// (which does local-only Tauri work: port detection, preview proxy, persisted
// pane reattach) rather than thread remote-awareness through it.

/** The local project that was active before connecting, so disconnect can
 *  return to it. */
let previousLocalProjectId: string | null = null;

/**
 * Open the remote server's workspace root as the active project. Called after
 * the socket connects (so `workspace_info` routes over it).
 */
export async function openRemoteRoot(conn: RemoteConnection): Promise<void> {
  const info = await backendInvoke<{ root: string; name: string }>('workspace_info');

  // Remember and save the outgoing local project so disconnect can restore it.
  const current = get(activeProjectId);
  if (current && !current.startsWith('remote:')) {
    previousLocalProjectId = current;
    saveProjectState(current);
  }
  // A queued autosave from the outgoing project would otherwise fire mid-switch
  // and write transitional state under the wrong id.
  cancelPendingProjectAutosave();

  const id = `remote:${conn.id}`;
  const project: Project = {
    id,
    name: info.name || conn.name,
    root_path: info.root,
    state: { open_files: [], active_file: null, last_modified: Date.now().toString() },
  };

  projects.update((p) => setProjectIn(p, id, project));
  openProjectIds.update((ids) => (ids.includes(id) ? ids : [...ids, id]));
  activeProjectId.set(id);

  // Minimal restore, in the same order as restoreProjectState: clear the outgoing
  // project's stores first, then point the terminal at the remote root. The file
  // tree loads itself — FileExplorer reacts to the active project's root — and a
  // new remote project starts blank just like a local project.
  clearAllStores();
  setActiveTerminalProject(id);
  setTerminalProjectRoot(id, info.root);
  terminalRoomOpen.set(false);
  layout.update((l) => ({ ...l, activeView: 'terminal', editorVisible: false }));
}

/**
 * Return to Local: drop the remote project(s) and restore the local project that
 * was active before connecting. The caller (`disconnectRemote`) has already set
 * `activeRemoteId` to null, so the restore below reads local files again.
 */
export function leaveRemoteRoot(): void {
  cancelPendingProjectAutosave();

  const remoteIds = get(openProjectIds).filter((id) => id.startsWith('remote:'));
  if (remoteIds.length === 0) return;

  projects.update((p) => { const next = new Map(p); for (const id of remoteIds) next.delete(id); return next; });
  openProjectIds.update((ids) => ids.filter((id) => !id.startsWith('remote:')));

  const openIds = get(openProjectIds);
  const target =
    previousLocalProjectId && get(projects).has(previousLocalProjectId)
      ? previousLocalProjectId
      : openIds[openIds.length - 1] ?? null;
  previousLocalProjectId = null;

  if (target) {
    const proj = get(projects).get(target);
    activeProjectId.set(target);
    setActiveTerminalProject(target);
    if (proj) {
      restoreProjectState(target, proj.root_path).catch((e) =>
        console.error('restoreProjectState failed:', e),
      );
    }
  } else {
    activeProjectId.set(null);
    setActiveTerminalProject(null);
    clearAllStores();
  }
}

export async function openProject() {
  if (!isTauriRuntime()) return;
  const { open } = await import('@tauri-apps/plugin-dialog');
  const selected = await open({
    directory: true,
    multiple: false,
    title: 'Add Folder to Workspace',
  });
  if (selected) {
    await addFolderToWorkspace(selected);
  }
}

export async function clearRecentWorkspaces() {
  try {
    const { invoke } = await import('@tauri-apps/api/core');
    await invoke('workspace_clear_recent');
  } catch (err) {
    console.error('Failed to clear recent projects on backend:', err);
  }
  recentWorkspaces.set([]);
  activeWorkspaceId.set(null);
}

export async function resetAllApplicationState() {
  try {
    const { invoke } = await import('@tauri-apps/api/core');
    await invoke('workspace_clear_recent');
  } catch (err) {
    console.error('Failed to clear recent projects on backend:', err);
  }

  if (typeof window !== 'undefined') {
    const keysToRemove = Object.keys(localStorage).filter(
      (k) => k.startsWith('spacron_') || k.startsWith('forge_')
    );
    keysToRemove.forEach((k) => localStorage.removeItem(k));
  }

  resetSettingsToDefault();
  resetLayoutToDefault();
  setActiveTerminalProject(null);
  clearAllStores();
  recentWorkspaces.set([]);
  activeWorkspaceId.set(null);
}

export async function initializeWorkspaces() {
  const wsId = get(activeWorkspaceId);
  if (wsId) {
    await openWorkspace(wsId);
  }
}

export function renameWorkspace(workspaceId: string, newName: string) {
  recentWorkspaces.update((list) =>
    list.map((w) => (w.id === workspaceId ? { ...w, name: newName } : w))
  );
}

export function moveProjectToWorkspace(projectPath: string, targetWorkspaceId: string) {
  const currentWsId = get(activeWorkspaceId);
  if (!currentWsId || currentWsId === targetWorkspaceId) return;

  const folderName = getFilename(projectPath);

  recentWorkspaces.update((list) =>
    list.map((w) => {
      if (w.id === currentWsId) {
        // Source workspace keeps its name; only its project list changes.
        const paths = w.project_paths.filter((p) => p !== projectPath);
        return {
          ...w,
          project_paths: paths,
          active_project_path: w.active_project_path === projectPath ? (paths[0] ?? null) : w.active_project_path,
        };
      }
      if (w.id === targetWorkspaceId) {
        const paths = w.project_paths.includes(projectPath) ? w.project_paths : [...w.project_paths, projectPath];
        // Only auto-name the target if it's still an unnamed placeholder.
        let newName = w.name;
        if (w.name === 'New Collection' || w.name === 'New Workspace' || w.name === 'Empty Collection' || w.name === 'Empty Workspace' || w.name.trim() === '') {
          newName = folderName;
        }
        return { ...w, name: newName, project_paths: paths };
      }
      return w;
    })
  );

  // Close the project in the current workspace if it's open
  const currentProjects = get(projects);
  for (const [id, proj] of currentProjects) {
    if (proj.root_path === projectPath) {
      closeProject(id);
      break;
    }
  }
}

/**
 * Move a project into another collection, landing it before `beforePath` (or at
 * the end when that is null).
 *
 * Pure list surgery rather than a store write, because both ways of moving a
 * project — the card's "Move to collection" menu and dragging it onto another
 * collection — have to agree on the arithmetic, and a drop within one collection
 * is a reorder, where removing before inserting shifts the index the drop was
 * aimed at. Unlike `moveProjectToWorkspace` the source is explicit, so a project
 * can be moved out of a collection that is not the active one.
 */
export function moveProjectBetweenCollections(
  list: Workspace[],
  projectPath: string,
  sourceWorkspaceId: string,
  targetWorkspaceId: string,
  beforePath: string | null = null,
): Workspace[] {
  const insertInto = (paths: string[]): string[] => {
    const rest = paths.filter((p) => p !== projectPath);
    const at = beforePath === null ? -1 : rest.indexOf(beforePath);
    const next = [...rest];
    next.splice(at === -1 ? rest.length : at, 0, projectPath);
    return next;
  };

  return list.map((w) => {
    // A reorder inside one collection: the removal and the insert are one edit
    // on one list, not the two independent branches below.
    if (sourceWorkspaceId === targetWorkspaceId && w.id === targetWorkspaceId) {
      return { ...w, project_paths: insertInto(w.project_paths) };
    }
    if (w.id === sourceWorkspaceId) {
      const paths = w.project_paths.filter((p) => p !== projectPath);
      return {
        ...w,
        project_paths: paths,
        // The collection loses whatever it was pointing at, so it falls back to
        // whatever is left — or to nothing, when it is now empty.
        active_project_path:
          w.active_project_path === projectPath ? (paths[0] ?? null) : w.active_project_path,
      };
    }
    if (w.id === targetWorkspaceId) {
      return { ...w, project_paths: insertInto(w.project_paths) };
    }
    return w;
  });
}

export function removeProjectFromCollection(workspaceId: string, projectPath: string) {
  const activeWsId = get(activeWorkspaceId);
  const allProjects = get(projects);
  const activeProj = Array.from(allProjects.values()).find((p) => p.root_path === projectPath);

  if (workspaceId === activeWsId && activeProj) {
    closeProject(activeProj.id);
  } else {
    recentWorkspaces.update((wsList) =>
      wsList.map((w) => {
        if (w.id === workspaceId) {
          const paths = w.project_paths.filter((x) => x !== projectPath);
          return {
            ...w,
            project_paths: paths,
            active_project_path: w.active_project_path === projectPath ? (paths[0] ?? null) : w.active_project_path,
          };
        }
        return w;
      })
    );
  }
}

export function deleteCollection(workspaceId: string) {
  recentWorkspaces.update((wsList) => wsList.filter((w) => w.id !== workspaceId));
  if (get(activeWorkspaceId) === workspaceId) {
    activeWorkspaceId.set(null);
    clearAllStores();
    projects.set(new Map());
    openProjectIds.set([]);
  }
}
