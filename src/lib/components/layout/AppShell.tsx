import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { flushSync } from 'react-dom';
import { isWebkitGtk, viewTransitionsReliable } from '$lib/utils/tauri';
import TitleBar from './TitleBar.tsx';
import UpdateBanner from '$lib/components/shared/UpdateBanner.tsx';
import { useAction } from '$lib/react/useAction';
import { useStore } from '$lib/react/useStore';
import { get } from '$lib/stores/storeCompat';
import { useWorkspaceStore } from '$lib/stores/zustand/workspace';
import FileExplorer from '$lib/components/explorer/FileExplorer.tsx';
import ReviewSidebarPanel from '$lib/components/review/ReviewSidebarPanel.tsx';
import SearchPanel from '$lib/components/explorer/SearchPanel.tsx';
import SourceControl from '$lib/components/explorer/SourceControl.tsx';
import SnapshotsPanel from './SnapshotsPanel.tsx';
import TerminalSnippetsPanel from '$lib/components/explorer/TerminalSnippetsPanel.tsx';

import TerminalPanel from '$lib/components/terminal/TerminalPanel.tsx';
import TerminalPane from '$lib/components/terminal/TerminalPane.tsx';
import WelcomeScreen from '$lib/components/workspace/WelcomeScreen.tsx';
import FloatingPromptBar from '$lib/components/terminal/FloatingPromptBar.tsx';

import { AgentBrandMark } from '$lib/components/shared/useAgentBrand.tsx';
import AgentWorktreeBadge from '$lib/components/orchestrator/AgentWorktreeBadge.tsx';
import AgentPanelImages from '$lib/components/orchestrator/AgentPanelImages.tsx';
import ContainersPanel from '$lib/components/containers/ContainersPanelLazy.tsx';
import DbExplorerPanel from '$lib/components/db/DbExplorerPanelLazy.tsx';
import HttpClientPanel from '$lib/components/http/HttpClientPanelLazy.tsx';
import ReviewPanel from '$lib/components/review/ReviewPanelLazy.tsx';
import ToolboxPanel from '$lib/components/toolbox/ToolboxPanelLazy.tsx';
import TasksPanel from '$lib/components/workspace/TasksPanelLazy.tsx';
import PreviewPanel from '$lib/components/preview/PreviewPanelLazy.tsx';
import YouTubePanel from '$lib/components/youtube/YouTubePanelLazy.tsx';
import FloatingYouTube from '$lib/components/youtube/FloatingYouTube.tsx';
import { useLayoutStore } from '$lib/stores/zustand/layout';
import { useEditorStore } from '$lib/stores/zustand/editor';
import {
  toggleSidebar,
  setActiveView,
  openSettings,
  toggleSidebarTab,
  toggleEditorVisible,
  togglePreviewVisible,
  toggleTerminal,
  toggleReviewVisible,
  toggleHttpVisible,
  toggleTasksVisible,
  toggleDbVisible,
  toggleContainersVisible,
  toggleToolboxVisible,
  RIGHT_DRAWER_TOOLS,
  toggleYoutubeVisible,
  openQuickCapture,
  openAgentSpawn,
  closeAgentSpawn,
  openEnvManager,
  terminalRoomOpen as terminalRoomOpenStore,
  homeScreenOpen,
} from '$lib/stores/layout';
import { openProject, toggleProjectHUD } from '$lib/stores/workspace';
import { toggleCommandPalette } from '$lib/stores/commandpalette';
import { saveActiveFile, formatActiveFile } from '$lib/stores/editor';
import { startProxy, stopProxy, createPreviewBrowserTab, ensureProxyRunning } from '$lib/stores/preview';
import { useSettingsStore } from '$lib/stores/zustand/settings';
import { matchShortcut } from '$lib/stores/settings';
import { toggleFloatingSearch } from '$lib/stores/projectsearch';
import {
  createTerminalSession,
  launchPromptBarVoiceMode,
  activeSessionId,
  devActiveSessionId,
  getSessionPromptTargetLabel,
  isAgentSession,
  killSession,
  paneAssignments,
  setActiveSession,
  sessions as terminalSessions,
  allProjectSessions,
  commandHistory,
} from '$lib/stores/terminal';

import { useUpdaterStore } from '$lib/stores/zustand/updater';
import { clampHorizontalScroll } from '$lib/actions/clampHorizontalScroll';
import type { ActiveView, SidebarTab } from '$lib/types/layout';
import type { RightDrawerTool } from '$lib/stores/layout';
import { layoutControlCommand, publishLayoutSnapshot } from '$lib/stores/layoutControl';
// openDailyNote removed
// toggleSketch removed
import './AppShell.css';

type AuxPanelId =
  | 'editor'
  | 'preview'
  | 'review'
  | 'http'
  | 'tasks'
  | 'db'
  | 'containers'
  | 'toolbox'
  | 'youtube'
  | 'env';

type AgentRoomId = `agent:${number}`;
type RoomId = 'workspace' | 'terminal' | 'dev-terminal' | AuxPanelId | AgentRoomId;
type AmbientLayout = 'focus' | 'development' | 'gallery' | 'vibe' | 'preview';

type ActivityItem = {
  id: string;
  title: string;
  active: boolean;
  onClick: () => void;
  icon: React.ReactNode;
};

const ROOM_TITLES: Record<Exclude<RoomId, AgentRoomId>, string> = {
  workspace: 'Workspace',
  terminal: 'Terminal',
  'dev-terminal': 'Terminal',
  editor: 'Editor',
  preview: 'Preview',
  review: 'Review',
  http: 'HTTP',
  tasks: 'Tasks',
  db: 'Database',
  containers: 'Containers',
  toolbox: 'Toolbox',
  youtube: 'Media Player',
  env: 'Environment',
};

function isAgentRoomId(id: RoomId): id is AgentRoomId {
  return id.startsWith('agent:');
}

function getAgentRoomSessionId(id: AgentRoomId): number {
  return Number(id.slice('agent:'.length));
}

// Rooms whose live body (an xterm) must persist across focus switches: the
// personal terminal, the dev terminal, and every running agent. They're kept
// mounted in the stage and toggled by visibility rather than unmounted.
function isPersistentRoomId(id: RoomId): boolean {
  return id === 'terminal' || id === 'dev-terminal' || isAgentRoomId(id);
}

const PANEL_VISIBILITY_KEYS: Record<AuxPanelId, keyof ReturnType<typeof useLayoutStore.getState>> = {
  editor: 'editorVisible',
  preview: 'previewVisible',
  review: 'reviewVisible',
  http: 'httpVisible',
  tasks: 'tasksVisible',
  db: 'dbVisible',
  containers: 'containersVisible',
  toolbox: 'toolboxVisible',
  youtube: 'youtubeVisible',
  env: 'envVisible',
};



const EditorPanel = lazy(() => import('$lib/components/editor/EditorPanel.tsx'));
const EnvManager = lazy(() => import('$lib/components/shared/EnvManager.tsx'));

function Icon({ children }: { children: React.ReactNode }) {
  return (
    <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      {children}
    </svg>
  );
}

// Title + icon for each right-utility-drawer tool, used by the drawer's tab
// strip. Icons mirror the dock buttons so the same tool reads identically in
// both places.
const DRAWER_TOOL_META: Record<RightDrawerTool, { title: string; icon: React.ReactNode }> = {
  toolbox: {
    title: 'Dev Toolbox',
    icon: <Icon><path d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.76 3.76z" /></Icon>,
  },
  http: {
    title: 'HTTP Client',
    icon: <Icon><path d="M22 12h-4l-3 9L9 3l-3 9H2" /></Icon>,
  },
  db: {
    title: 'Database',
    icon: <Icon><ellipse cx="12" cy="5" rx="9" ry="3" /><path d="M3 5v14c0 1.66 4 3 9 3s9-1.34 9-3V5" /><path d="M3 12c0 1.66 4 3 9 3s9-1.34 9-3" /></Icon>,
  },
  containers: {
    title: 'Containers',
    icon: <Icon><path d="M4 7.5 12 3l8 4.5-8 4.5-8-4.5Z" /><path d="M4 12.5 12 17l8-4.5" /><path d="M4 17.5 12 22l8-4.5" /></Icon>,
  },
  env: {
    title: 'Environment',
    icon: <Icon><rect x="3" y="11" width="18" height="11" rx="2" /><path d="M7 11V7a5 5 0 0 1 10 0v4" /></Icon>,
  },
};

// Tools hosted in the LEFT utility drawer — the sidebar-content tabs, backed by
// `sidebarTab`. Order = tab-strip / dock order.
const LEFT_DRAWER_TOOLS = ['files', 'git', 'snapshots', 'snippets', 'review'] as const;
type LeftDrawerTool = (typeof LEFT_DRAWER_TOOLS)[number];
const LEFT_TOOL_META: Record<LeftDrawerTool, { title: string; icon: React.ReactNode }> = {
  files: { title: 'Files', icon: <Icon><path d="M3 7a2 2 0 0 1 2-2h3.586a2 2 0 0 1 1.414.586L11.414 7H19a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7z" /></Icon> },
  git: { title: 'Source Control', icon: <Icon><circle cx="18" cy="18" r="3" /><circle cx="6" cy="6" r="3" /><circle cx="6" cy="18" r="3" /><path d="M18 15V9a4 4 0 0 0-4-4H9" /><line x1="6" y1="9" x2="6" y2="15" /></Icon> },
  snapshots: { title: 'Workspace Snapshots', icon: <Icon><rect x="2" y="3" width="20" height="14" rx="2" /><path d="M8 21h8M12 17v4" /><circle cx="12" cy="10" r="3" /></Icon> },
  snippets: { title: 'Shell Snippets', icon: <Icon><path d="M4 17l6-6-6-6M12 19h8" /></Icon> },

  review: { title: 'Code Review', icon: <Icon><circle cx="18" cy="18" r="3" /><circle cx="6" cy="6" r="3" /><path d="M13 6h3a2 2 0 0 1 2 2v7" /><path d="M11 18H8a2 2 0 0 1-2-2V9" /></Icon> },
};

// The RIGHT drawer hosts the layout-backed tools (RIGHT_DRAWER_TOOLS: Toolbox /
// HTTP / DB / Containers / Env).
type RightTool = RightDrawerTool;
const RIGHT_TOOLS_ALL: RightTool[] = [...RIGHT_DRAWER_TOOLS];
const RIGHT_TOOL_META: Record<RightTool, { title: string; icon: React.ReactNode }> = {
  ...DRAWER_TOOL_META,
};

function XIcon() {
  return (
    <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
      <line x1="18" y1="6" x2="6" y2="18" />
      <line x1="6" y1="6" x2="18" y2="18" />
    </svg>
  );
}

function ActivityButton({ item }: { item: ActivityItem }) {
  return (
    <button
      className={`svt-btn${item.active ? ' svt-active' : ''}`}
      onClick={item.onClick}
      title={item.title}
      aria-label={item.title}
    >
      {item.icon}
    </button>
  );
}

function AuxTab({
  id,
  active,
  title,
  children,
}: {
  id: ActiveView;
  active: boolean;
  title: string;
  children: React.ReactNode;
}) {
  return (
    <button className={`aux-tab${active ? ' active' : ''}`} onClick={() => setActiveView(id)} title={title}>
      {children}
    </button>
  );
}

function PanelHost({ id }: { id: AuxPanelId }) {
  if (id === 'editor') {
    return (
      <Suspense fallback={null}>
        <EditorPanel />
      </Suspense>
    );
  }

  if (id === 'containers') return <ContainersPanel />;
  if (id === 'db') return <DbExplorerPanel />;
  if (id === 'http') return <HttpClientPanel />;
  if (id === 'review') return <ReviewPanel />;
  if (id === 'toolbox') return <ToolboxPanel />;
  if (id === 'tasks') return <TasksPanel />;
  if (id === 'preview') return <PreviewPanel />;
  if (id === 'youtube') return <YouTubePanel />;
  if (id === 'env') {
    return (
      <Suspense fallback={null}>
        <EnvManager embedded />
      </Suspense>
    );
  }

  return null;
}

function SidebarContent({ tab }: { tab: SidebarTab }) {
  if (tab === 'search') return <SearchPanel />;
  if (tab === 'git') return <SourceControl />;
  if (tab === 'snapshots') return <SnapshotsPanel />;
  if (tab === 'snippets') return <TerminalSnippetsPanel />;

  if (tab === 'review') return <ReviewSidebarPanel />;
  return <FileExplorer />;
}

import { useGlobalTooltips } from '$lib/react/useGlobalTooltips.ts';

export default function AppShell() {
  useGlobalTooltips();

  function withTransition(action: () => void) {
    const startViewTransition = (document as Document & {
      startViewTransition?: (callback: () => void) => { finished?: Promise<unknown> };
    }).startViewTransition;

    if (
      startViewTransition &&
      viewTransitionsReliable() &&
      !window.matchMedia('(prefers-reduced-motion: reduce)').matches &&
      !(window as any).__spacron_transitioning
    ) {
      (window as any).__spacron_transitioning = true;
      try {
        const transition = startViewTransition.call(document, () => {
          flushSync(action);
        });
        transition.finished?.finally(() => {
          (window as any).__spacron_transitioning = false;
        }).catch(() => {
          (window as any).__spacron_transitioning = false;
        });
        setTimeout(() => {
          (window as any).__spacron_transitioning = false;
        }, 1000);
      } catch (e) {
        (window as any).__spacron_transitioning = false;
        action();
      }
    } else {
      action();
    }
  }

  // Tell terminal panes to refit once a room focus / layout transition has
  // settled. An agent's full-screen TUI (xterm) only redraws when its size
  // actually changes, so without this an agent promoted into the focus screen
  // keeps the size it had as a small side card and leaves an empty band. The
  // double rAF lets the new DOM settle before TerminalPane re-measures.
  function notifyPanesResized() {
    requestAnimationFrame(() =>
      requestAnimationFrame(() => {
        document.dispatchEvent(new CustomEvent('pane-resize-end'));
      }),
    );
  }

  function withRoomTransition(action: () => void) {
    withTransition(action);
    notifyPanesResized();
  }

  const layoutState = useLayoutStore();
  const workspaceId = useWorkspaceStore((s) => s.activeWorkspaceId);
  // Home is an overlay on top of the still-mounted workspace (see
  // `homeScreenOpen`). With no workspace open at all there is nothing behind it,
  // so it is the only thing rendered.
  const homeOpen = useStore(homeScreenOpen);
  const showWelcome = !workspaceId || homeOpen;
  const project = useWorkspaceStore((s) => (s.activeProjectId ? s.projects.get(s.activeProjectId) ?? null : null));
  const projectSwitching = useWorkspaceStore((s) => s.isProjectSwitching);
  const openProjectIdList = useWorkspaceStore((s) => s.openProjectIds);
  const activeProjectIdValue = useWorkspaceStore((s) => s.activeProjectId);
  // Stable order so a panel never changes position (and gets re-parented) as
  // projects come and go; the active project is always included even if
  // `openProjectIds` hasn't caught up mid-switch.
  const terminalHostProjectIds = useMemo(() => {
    const ids = [...openProjectIdList];
    if (activeProjectIdValue && !ids.includes(activeProjectIdValue)) ids.push(activeProjectIdValue);
    return ids;
  }, [openProjectIdList, activeProjectIdValue]);
  const shortcuts = useSettingsStore((s) => s.userShortcuts);
  const currentActiveSessionId = useStore(activeSessionId);
  const activeSessionIdRef = useRef(currentActiveSessionId);
  useEffect(() => {
    activeSessionIdRef.current = currentActiveSessionId;
  }, [currentActiveSessionId]);

  const currentDevActiveSessionId = useStore(devActiveSessionId);
  const devActiveSessionIdRef = useRef(currentDevActiveSessionId);
  useEffect(() => {
    devActiveSessionIdRef.current = currentDevActiveSessionId;
  }, [currentDevActiveSessionId]);
  const zoom = useSettingsStore((s) => s.uiZoom);
  const showSnapshotsTab = useSettingsStore((s) => s.showSnapshotsTab);

  useEffect(() => {
    if (!showSnapshotsTab && layoutState.sidebarTab === 'snapshots') {
      toggleSidebarTab('files');
    }
  }, [showSnapshotsTab, layoutState.sidebarTab]);

  const activeFile = useEditorStore((s) => s.activeFile);
  const auxTabsRef = useAction<HTMLDivElement>(clampHorizontalScroll);
  const layoutCommand = useStore(layoutControlCommand);

  const [windowWidth, setWindowWidth] = useState(() => window.innerWidth);
  const [sidebarResizing, setSidebarResizing] = useState(false);
  const [leftPanelResizing, setLeftPanelResizing] = useState(false);
  const [rightDrawerResizing, setRightDrawerResizing] = useState(false);
  const [auxResizing, setAuxResizing] = useState(false);
  const [auxRowResizing, setAuxRowResizing] = useState(false);
  const [auxPanelWidth, setAuxPanelWidth] = useState(layoutState.auxPanelWidth);
  const [auxEditorHeight, setAuxEditorHeight] = useState(layoutState.auxEditorHeight);
  const [focusedRoom, setFocusedRoom] = useState<RoomId | null>('terminal');
  const [minimizedRooms, setMinimizedRooms] = useState<Set<RoomId>>(() => new Set());
  const [ambientLayout, setAmbientLayout] = useState<AmbientLayout>('gallery');
  // Each ambient layout keeps its own minimize/focus state so switching modes
  // never pollutes another mode's arrangement.
  const perLayoutState = useRef<Record<AmbientLayout, { focused: RoomId | null; minimized: Set<RoomId> }>>({
    focus: { focused: 'terminal', minimized: new Set() },
    development: { focused: 'terminal', minimized: new Set() },
    gallery: { focused: 'terminal', minimized: new Set() },
    vibe: { focused: null, minimized: new Set() },
    preview: { focused: 'preview', minimized: new Set(['terminal']) },
  });
  const [layoutSwitching, setLayoutSwitching] = useState(false);
  const terminalRoomOpen = useStore(terminalRoomOpenStore);
  const setTerminalRoomOpen = (val: boolean) => terminalRoomOpenStore.set(val);
  const [devTerminalRoomOpen, setDevTerminalRoomOpen] = useState(false);
  const [roomOrder, setRoomOrder] = useState<RoomId[]>(['workspace', 'terminal']);
  const [secondaryRoom, setSecondaryRoom] = useState<RoomId | null>(null);
  const lastActiveRoomRef = useRef<RoomId | null>(null);

  const sidebarResizeRef = useRef({ startX: 0, startWidth: 0 });
  const leftPanelResizeRef = useRef({ startX: 0, startWidth: 0 });
  const rightDrawerResizeRef = useRef({ startX: 0, startWidth: 0 });
  const auxResizeRef = useRef({ startX: 0, startWidth: 0 });
  const auxRowResizeRef = useRef({ startY: 0, startHeight: 0 });
  const layoutSwitchTimerRef = useRef<number | null>(null);
  const lastLayoutCommandNonce = useRef(0);

  const roomsTableRef = useRef<HTMLElement | null>(null);
  const overlaysRef = useRef<HTMLDivElement | null>(null);
  const [overlaysHeight, setOverlaysHeight] = useState(128);

  useEffect(() => {
    const el = overlaysRef.current;
    if (!el) return;
    const observer = new ResizeObserver((entries) => {
      for (const entry of entries) {
        setOverlaysHeight(Math.ceil(entry.contentRect.height));
      }
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, [workspaceId]);

  // Visibility guarantee for the dock (.room-dock) and floating prompt bar
  // (.composer-strip) on WebKitGTK (Linux). Even at opacity:1 these are regularly
  // left *present but unpainted* after a first paint or a layout switch — either an
  // entrance animation stuck at its 0% frame, or an uncomposited GPU layer. The CSS
  // override handles the animation/opacity case; here we additionally force a hard
  // repaint (a display flush) to re-composite a stale layer, which a plain opacity
  // fix can't do. Runs on mount and on every ambient-layout change (opening an agent
  // that promotes the Development layout was a reported trigger). No-op off Linux.
  useEffect(() => {
    if (!workspaceId || !isWebkitGtk()) return;
    const el = overlaysRef.current;
    if (!el) return;

    const forceVisible = () => {
      el.querySelectorAll<HTMLElement>('.room-dock, .composer-strip').forEach((node) => {
        node.style.animation = 'none';
        node.style.visibility = 'visible';
        node.style.opacity = '1';
        node.style.transform = 'none';
        node.style.willChange = 'transform';
        // Force a GPU compositor layer flush without toggling display (which
        // causes visible flicker). Setting opacity to a near-1 value and back
        // in the same synchronous block forces WebKitGTK to repaint the stale
        // layer while the user sees no perceptible change.
        node.style.opacity = '0.999';
        void node.offsetHeight;
        node.style.opacity = '1';
      });
    };

    const raf = requestAnimationFrame(forceVisible);
    const t1 = window.setTimeout(forceVisible, 250);
    const t2 = window.setTimeout(forceVisible, 700);
    return () => {
      cancelAnimationFrame(raf);
      window.clearTimeout(t1);
      window.clearTimeout(t2);
    };
  }, [workspaceId, ambientLayout]);
  const allTerminalSessions = useStore(terminalSessions);
  // Sessions across EVERY project, not just the active one — the stage mounts
  // background projects' agent panes from this so switching projects hides them
  // instead of disposing their xterms.
  const crossProjectSessions = useStore(allProjectSessions);
  const terminalPaneAssignments = useStore(paneAssignments);
  const history = useStore(commandHistory);

  useEffect(() => () => {
    if (layoutSwitchTimerRef.current !== null) window.clearTimeout(layoutSwitchTimerRef.current);
  }, []);



  const visiblePanels = useMemo(
    () =>
      [
        { id: 'editor' as const, visible: layoutState.editorVisible },
        { id: 'preview' as const, visible: layoutState.previewVisible },
        { id: 'review' as const, visible: layoutState.reviewVisible },
        { id: 'tasks' as const, visible: layoutState.tasksVisible },
        // Right utility drawer: http/db/containers/toolbox/env + orchestrator.
        // Left drawer: the nav tabs. YouTube: free-floating pop-up. None of
        // those are rooms in the ambient grid.
      ].filter((panel) => panel.visible),
    [layoutState],
  );

  const agentSessions = useMemo(
    () => allTerminalSessions.filter((session) => session.isRunning && isAgentSession(session)),
    [allTerminalSessions],
  );
  const agentRoomIds = useMemo<AgentRoomId[]>(
    () => agentSessions.map((session) => `agent:${session.id}` as AgentRoomId),
    [agentSessions],
  );

  // Agent rooms for every project, including the ones you are not currently in.
  // These are NOT user-facing rooms (they never reach the dock, the room stack or
  // `activeRoom`) — they exist purely so the stage can keep a background
  // project's agent pane mounted-but-hidden. Disposing it instead would tear
  // down its xterm, and rebuilding one replays the raw scrollback into a fresh
  // terminal, which is what leaves an agent TUI drawing garbage.
  // Bounded to the projects currently open in this workspace. Terminal state
  // outlives a workspace switch (the pty map is process-global), so without this
  // the stage would keep mounting panes for a workspace the user has left.
  const mountedAgentRoomIds = useMemo<AgentRoomId[]>(
    () => {
      const open = new Set(openProjectIdList);
      return crossProjectSessions
        .filter((session) => session.isRunning && isAgentSession(session))
        .filter((session) => !session.projectId || open.has(session.projectId))
        .map((session) => `agent:${session.id}` as AgentRoomId);
    },
    [crossProjectSessions, openProjectIdList],
  );

  // Auto-focus a freshly spawned agent so it opens in the focus screen. The
  // first run only records the current agents, so restored/pre-existing agents
  // on app startup don't steal focus from the default room.
  const prevAgentRoomIdsRef = useRef<AgentRoomId[]>([]);
  const agentFocusInitRef = useRef(false);
  useEffect(() => {
    if (!agentFocusInitRef.current) {
      agentFocusInitRef.current = true;
      prevAgentRoomIdsRef.current = agentRoomIds;
      return;
    }
    const prev = prevAgentRoomIdsRef.current;
    prevAgentRoomIdsRef.current = agentRoomIds;
    const added = agentRoomIds.filter((id) => !prev.includes(id));
    if (added.length === 0) return;
    focusRoom(added[added.length - 1]);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [agentRoomIds]);

  // Panes now survive a project switch hidden rather than being rebuilt, so
  // nothing repaints them on the way back: their size is unchanged (hidden with
  // visibility, so they stay laid out), and only the newly-active pane redraws
  // on its own. A canvas/WebGL glyph atlas can go stale while a pane sits
  // hidden, so kick the same refit+repaint pass a layout switch uses once the
  // switch settles.
  const prevProjectSwitchingRef = useRef(projectSwitching);
  useEffect(() => {
    const wasSwitching = prevProjectSwitchingRef.current;
    prevProjectSwitchingRef.current = projectSwitching;
    if (wasSwitching && !projectSwitching) notifyPanesResized();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectSwitching]);

  const openRooms = useMemo<RoomId[]>(
    () => {
      const list = [
        // 'workspace' is no longer a center room — its content
        // renders in the LEFT utility drawer (Files/Search/…).
        ...(terminalRoomOpen ? (['terminal'] as RoomId[]) : []),
        ...(devTerminalRoomOpen ? (['dev-terminal'] as RoomId[]) : []),
        ...agentRoomIds,
        ...visiblePanels.map((panel) => panel.id),
      ];
      return list;
    },
    [agentRoomIds, terminalRoomOpen, devTerminalRoomOpen, visiblePanels, ambientLayout],
  );

  const visibleRooms = useMemo(
    () => openRooms.filter((room) => !minimizedRooms.has(room)),
    [minimizedRooms, openRooms],
  );

  const orderedVisibleRooms = useMemo(
    () => roomOrder.filter((room) => visibleRooms.includes(room)),
    [roomOrder, visibleRooms],
  );

  const activeRoom = focusedRoom && visibleRooms.includes(focusedRoom)
    ? focusedRoom
    : (visibleRooms[0] ?? null);
  if (activeRoom) {
    lastActiveRoomRef.current = activeRoom;
  }
  const sideRooms = activeRoom ? visibleRooms.filter((room) => room !== activeRoom) : visibleRooms;
  const splitRoom = activeRoom ? ((secondaryRoom && sideRooms.includes(secondaryRoom)) ? secondaryRoom : (sideRooms[0] ?? null)) : null;
  const stackedRooms = sideRooms;

  // WebKitGTK (Linux) leaves stale compositor pixels — a "ghost" of the closed
  // room — behind when a room/panel closes and the grid re-tiles to fill the gap.
  // When a room is actually removed, force a genuine repaint of the rooms container
  // so those stale pixels are overwritten. A sub-1 opacity for a single frame forces
  // WebKitGTK to re-composite the subtree; it's visually imperceptible (≈1, no
  // movement) and leaves layout size unchanged, so the terminal panes never refit.
  // Linux-only; Windows/macOS repaint correctly on their own.
  const prevVisibleRoomsRef = useRef<RoomId[]>([]);
  useEffect(() => {
    const prev = prevVisibleRoomsRef.current;
    prevVisibleRoomsRef.current = visibleRooms;
    if (!isWebkitGtk()) return;
    const roomClosed = prev.some((room) => !visibleRooms.includes(room));
    if (!roomClosed) return;
    const el = roomsTableRef.current;
    if (!el) return;
    let raf2 = 0;
    const raf1 = requestAnimationFrame(() => {
      el.style.opacity = '0.999';
      raf2 = requestAnimationFrame(() => { el.style.opacity = ''; });
    });
    return () => {
      cancelAnimationFrame(raf1);
      cancelAnimationFrame(raf2);
      el.style.opacity = '';
    };
  }, [visibleRooms]);

  // Apply layout commands from the orchestrator (or any other controller). The
  // nonce guard makes a repeated identical command (e.g. "focus terminal" twice)
  // still fire, while ensuring each command is applied exactly once.
  useEffect(() => {
    if (!layoutCommand || layoutCommand.nonce === lastLayoutCommandNonce.current) return;
    lastLayoutCommandNonce.current = layoutCommand.nonce;

    if (layoutCommand.type === 'ambient') {
      switchAmbientLayout(layoutCommand.mode);
      return;
    }

    if (layoutCommand.type !== 'room') return;

    const wanted = layoutCommand.room.trim().toLowerCase();
    const resolveRoom = (): RoomId | null => {
      if (!wanted) return null;
      if (['last', 'it', 'that', 'that one', 'focused', 'active', 'current'].includes(wanted)) {
        return activeRoom;
      }
      const isDevLayout = ambientLayout === 'development';
      const targetTerminalId: RoomId = isDevLayout ? 'dev-terminal' : 'terminal';

      const direct = openRooms.find((id) => id.toLowerCase() === wanted);
      if (direct) return direct;
      const synonyms: Record<string, RoomId> = {
        files: 'workspace', sidebar: 'workspace', explorer: 'workspace',
        console: targetTerminalId, shell: targetTerminalId, terminal: targetTerminalId,
      };
      if (synonyms[wanted]) return synonyms[wanted];
      return (
        openRooms.find((id) => {
          const labels = [roomTitle(id), roomKind(id), id].map((label) => label.toLowerCase());
          return labels.some((label) => label === wanted || label.includes(wanted) || wanted.includes(label));
        }) ?? null
      );
    };

    const room = resolveRoom();
    if (!room) return;
    switch (layoutCommand.op) {
      case 'focus':
        // In gallery (split) mode with other rooms visible, show the
        // preview in the secondary (right) pane instead of the primary
        // (left) — "agent on the left, preview on the right".
        if (room === 'preview' && ambientLayout === 'gallery') {
          const otherRooms = visibleRooms.filter((r) => r !== 'preview');
          if (otherRooms.length > 0) {
            showRoomInSecondary('preview');
            break;
          }
        }
        focusRoom(room);
        break;
      case 'minimize': minimizeRoom(room); break;
      case 'restore': restoreRoom(room); break;
      case 'close': closeRoom(room); break;
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [layoutCommand]);

  // Publish the live layout back so the orchestrator brain can see and reason
  // about the current arrangement (ambient mode + which rooms are open/focused).
  useEffect(() => {
    publishLayoutSnapshot({
      ambient: ambientLayout,
      rooms: openRooms.map((id) => ({
        id,
        title: roomTitle(id),
        focused: id === activeRoom,
        minimized: minimizedRooms.has(id),
      })),
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ambientLayout, openRooms, activeRoom, minimizedRooms, allTerminalSessions]);

  // Preview mode is built around the preview browser; if it gets closed (its X),
  // the mode has nothing to show, so fall back to Focus.
  useEffect(() => {
    if (ambientLayout === 'preview' && !layoutState.previewVisible) {
      switchAmbientLayout('focus');
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ambientLayout, layoutState.previewVisible]);

  const auxTabsNarrow = auxPanelWidth < 300;
  const resizing = sidebarResizing || leftPanelResizing || auxResizing || auxRowResizing || rightDrawerResizing;

  // Auto-refit the terminal on entering / switching a workspace. The terminal can
  // mount before the layout reaches its final size, which otherwise leaves an
  // empty band (a stale fit) until the next manual resize. Firing the existing
  // `pane-resize-end` signal a couple of times after settle fixes startup sizing.
  useEffect(() => {
    if (!workspaceId) return;
    const t1 = window.setTimeout(() => notifyPanesResized(), 120);
    const t2 = window.setTimeout(() => notifyPanesResized(), 500);
    return () => {
      window.clearTimeout(t1);
      window.clearTimeout(t2);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [workspaceId]);

  // Trailing refit after a layout/focus change settles. A room panel grows into
  // place via the ~0.32s grid transition; the immediate refit from
  // withRoomTransition fits the terminal to the mid-transition (smaller) size,
  // which leaves it too narrow with an empty band on the right. Re-fire once the
  // transition has finished so the terminal fills the final panel width.
  useEffect(() => {
    const t = window.setTimeout(() => notifyPanesResized(), 400);
    return () => window.clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ambientLayout, activeRoom, visibleRooms]);

  function auxMaxWidth(width = windowWidth) {
    const sidebar = 48; // Sidebar is a pop-up and doesn't push panels anymore
    return width / (zoom / 100) - sidebar - 250 - 60;
  }

  useEffect(() => {
    setAuxPanelWidth(layoutState.auxPanelWidth);
    setAuxEditorHeight(layoutState.auxEditorHeight);
  }, [layoutState.auxEditorHeight, layoutState.auxPanelWidth]);

  useEffect(() => {
    const handleResize = () => setWindowWidth(window.innerWidth);
    window.addEventListener('resize', handleResize);
    return () => window.removeEventListener('resize', handleResize);
  }, []);

  useEffect(() => {
    if (windowWidth < 500 || document.hidden) return;
    const effectiveWindowWidth = windowWidth / (zoom / 100);
    if (effectiveWindowWidth < 640) {
      if (layoutState.sidebarVisible) {
        useLayoutStore.setState({ sidebarVisible: false });
      }
      return;
    }

    const maxAllowedWidth = Math.min(600, effectiveWindowWidth - 250 - 48);
    if (layoutState.sidebarWidth > maxAllowedWidth) {
      useLayoutStore.setState({ sidebarWidth: Math.max(180, maxAllowedWidth) });
    }
  }, [layoutState.sidebarVisible, layoutState.sidebarWidth, windowWidth, zoom]);

  useEffect(() => {
    if (windowWidth < 500 || document.hidden) return;
    if (visiblePanels.length > 0 && auxPanelWidth > auxMaxWidth()) {
      setAuxPanelWidth(Math.max(200, auxMaxWidth()));
    }
  }, [auxPanelWidth, layoutState.sidebarVisible, layoutState.sidebarWidth, visiblePanels.length, windowWidth, zoom]);

  useEffect(() => {
    if (focusedRoom && !openRooms.includes(focusedRoom)) {
      setFocusedRoom(ambientLayout === 'focus' ? null : (openRooms[0] ?? null));
    }

    setMinimizedRooms((current) => {
      const open = new Set(openRooms);
      const next = new Set(Array.from(current).filter((room) => open.has(room)));
      return next.size === current.size ? current : next;
    });

    setSecondaryRoom((current) => {
      if (!current || !openRooms.includes(current) || current === focusedRoom) return null;
      return current;
    });
  }, [ambientLayout, focusedRoom, openRooms]);

  // When the editor panel becomes visible or the active file changes, focus
  // the editor room so it appears in the primary position. This handles both
  // the initial open and subsequent file clicks while the editor is already
  // visible (where editorVisible stays true but activeFile changes).
  useEffect(() => {
    if (layoutState.editorVisible && activeFile) {
      setFocusedRoom('editor');
    }
  }, [layoutState.editorVisible, activeFile]);

  useEffect(() => {
    setRoomOrder((current) => {
      const currentOpen = current.filter((room) => openRooms.includes(room));
      const additions = openRooms.filter((room) => !currentOpen.includes(room));
      const next = [...currentOpen, ...additions];
      return next.length === current.length && next.every((room, index) => room === current[index])
        ? current
        : next;
    });
  }, [openRooms]);





  useEffect(() => {
    const timer = setTimeout(() => {
      void useUpdaterStore.getState().checkForUpdate().catch(() => {});
    }, 5000);
    return () => clearTimeout(timer);
  }, []);

  useEffect(() => {
    function handleMouseMove(event: MouseEvent) {
      const scale = zoom / 100;
      if (sidebarResizing) {
        const delta = (event.clientX - sidebarResizeRef.current.startX) / scale;
        const maxAllowedWidth = Math.min(600, windowWidth / scale - 250 - 48);
        useLayoutStore.setState({
          sidebarWidth: Math.max(180, Math.min(maxAllowedWidth, sidebarResizeRef.current.startWidth + delta)),
        });
      } else if (leftPanelResizing) {
        const delta = (event.clientX - leftPanelResizeRef.current.startX) / scale;
        const maxAllowedWidth = Math.min(600, windowWidth / scale - 250 - 48);
        useLayoutStore.setState({
          leftPanelWidth: Math.max(180, Math.min(maxAllowedWidth, leftPanelResizeRef.current.startWidth + delta)),
        });
      } else if (rightDrawerResizing) {
        // Drawer is anchored to the right edge, so dragging its left handle
        // leftwards (negative deltaX) widens it.
        const delta = (rightDrawerResizeRef.current.startX - event.clientX) / scale;
        const maxAllowedWidth = Math.min(720, windowWidth / scale - 250 - 48);
        useLayoutStore.setState({
          rightDrawerWidth: Math.max(280, Math.min(maxAllowedWidth, rightDrawerResizeRef.current.startWidth + delta)),
        });
      } else if (auxResizing) {
        const delta = (event.clientX - auxResizeRef.current.startX) / scale;
        const nextWidth = auxResizeRef.current.startWidth - delta;
        setAuxPanelWidth(Math.max(200, Math.min(auxMaxWidth(), nextWidth)));
      } else if (auxRowResizing) {
        const deltaY = (event.clientY - auxRowResizeRef.current.startY) / scale;
        const container = document.querySelector('.auxiliary-panel');
        if (!container) return;
        const totalHeight = container.clientHeight;
        if (totalHeight <= 0) return;
        const deltaPercent = (deltaY / totalHeight) * 100;
        setAuxEditorHeight(Math.max(10, Math.min(90, auxRowResizeRef.current.startHeight + deltaPercent)));
      }
    }

    function handleMouseUp() {
      const wasAuxResize = auxResizing || auxRowResizing;
      const wasRightDrawerResize = rightDrawerResizing;
      setSidebarResizing(false);
      setLeftPanelResizing(false);
      setRightDrawerResizing(false);
      setAuxResizing(false);
      setAuxRowResizing(false);
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
      if (wasAuxResize) {
        useLayoutStore.setState({ auxPanelWidth, auxEditorHeight });
      }
      if (wasRightDrawerResize) {
        // Persist the final width (the live drag wrote straight to the store).
        useLayoutStore.getState().setRightDrawerWidth(useLayoutStore.getState().rightDrawerWidth);
      }
    }

    window.addEventListener('mousemove', handleMouseMove);
    window.addEventListener('mouseup', handleMouseUp);
    return () => {
      window.removeEventListener('mousemove', handleMouseMove);
      window.removeEventListener('mouseup', handleMouseUp);
    };
  }, [auxEditorHeight, auxPanelWidth, auxResizing, auxRowResizing, sidebarResizing, leftPanelResizing, rightDrawerResizing, windowWidth, zoom]);

  useEffect(() => {
    function handleKeyDown(event: KeyboardEvent) {
      const matched = (shortcuts || []).find((shortcut) => shortcut && matchShortcut(event, shortcut.keys));
      if (!matched) return;

      // Built-in shortcuts dispatch by their own id; custom shortcuts point at an
      // app action via `action`, so we drive the same switch through that id.
      const actionId = matched.id.startsWith('custom_') ? matched.action : matched.id;
      if (!actionId) return;

      event.preventDefault();

      switch (actionId) {
        case 'toggleProjectHUD':
          toggleProjectHUD();
          break;
        case 'commandPalette':
          toggleCommandPalette();
          break;
        case 'openSettings':
          openSettings();
          break;
        case 'toggleSidebar':
          toggleSidebar();
          break;
        case 'newWorkspace':
          withTransition(() => {
            useWorkspaceStore.getState().__set('newWorkspacePromptOpen', true);
          });
          break;
        case 'goToTerminal':
          setActiveView('terminal');
          setTerminalRoomOpen(true);
          setFocusedRoom('terminal');
          break;
        case 'goToEditor':
          setActiveView('editor');
          setFocusedRoom('editor');
          break;
        case 'goToPreview':
          setActiveView('preview');
          setFocusedRoom('preview');
          break;
        // goToOrchestrator removed — Orchestrator panel no longer exists
        case 'goToReview':
          toggleReviewVisible();
          break;
        case 'goToHttp':
          toggleHttpVisible();
          break;
        case 'goToTasks':
          toggleTasksVisible();
          break;
        case 'goToDb':
          toggleDbVisible();
          break;
        case 'goToContainers':
          toggleContainersVisible();
          break;
        case 'goToToolbox':
          toggleToolboxVisible();
          break;
        case 'goToYoutube':
          toggleYoutubeVisible();
          break;
        case 'openSearch':
          toggleFloatingSearch();
          break;
        case 'openEnvManager':
          openEnvManager();
          break;
        case 'saveFile':
          saveActiveFile();
          break;
        case 'openFolder':
          openProject();
          break;
        case 'newTerminal': {
          const isDev = ambientLayout === 'development';
          if (isDev) {
            setDevTerminalRoomOpen(true);
            setFocusedRoom('dev-terminal');
            createTerminalSession(undefined, undefined, undefined, { isDev: true });
          } else {
            setActiveView('terminal');
            setTerminalRoomOpen(true);
            setFocusedRoom('terminal');
            createTerminalSession();
          }
          break;
        }
        case 'formatDocument':
          formatActiveFile();
          break;
        case 'startProxy':
          startProxy();
          break;
        case 'stopProxy':
          stopProxy();
          break;
        case 'quickCapture':
          openQuickCapture();
          break;
        case 'spawnAgent':
          openAgentSpawn();
          break;
        // openDailyNote removed
        // toggleSketch removed
        case 'launchVoiceMode':
          launchPromptBarVoiceMode();
          break;
        case 'cycleAmbientLayout': {
          // Cycle through the three reachable arrangements: Focus → Split → Fleet.
          const cycle: AmbientLayout[] = ['focus', 'gallery', 'vibe'];
          const idx = cycle.indexOf(ambientLayout);
          switchAmbientLayout(cycle[(idx + 1) % cycle.length] ?? 'focus');
          break;
        }
      }
    }

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [project, shortcuts, ambientLayout]);

  function startSidebarResize(event: React.MouseEvent) {
    setSidebarResizing(true);
    sidebarResizeRef.current = { startX: event.clientX, startWidth: layoutState.sidebarWidth };
    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';
  }

  function startLeftPanelResize(event: React.MouseEvent) {
    event.preventDefault();
    setLeftPanelResizing(true);
    leftPanelResizeRef.current = { startX: event.clientX, startWidth: layoutState.leftPanelWidth };
    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';
  }

  function startRightDrawerResize(event: React.MouseEvent) {
    event.preventDefault();
    setRightDrawerResizing(true);
    rightDrawerResizeRef.current = { startX: event.clientX, startWidth: layoutState.rightDrawerWidth };
    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';
  }

  // --- LEFT utility drawer (workspace navigation) -------------------------
  // Sidebar-content tabs only. Open == sidebarVisible; switching tabs only swaps
  // the body (the frame stays mounted), so there's no close/reopen glitch.
  const leftDrawerOpen = layoutState.sidebarVisible;
  const leftActiveTool: LeftDrawerTool | null =
    layoutState.sidebarVisible && (LEFT_DRAWER_TOOLS as readonly string[]).includes(layoutState.sidebarTab)
      ? (layoutState.sidebarTab as LeftDrawerTool)
      : null;
  // If the stored sidebarTab is 'review', silently reset it so the drawer doesn't show a stale tab
  const leftDrawerTools = LEFT_DRAWER_TOOLS.filter((t) => t !== 'snapshots' || showSnapshotsTab);

  function selectLeftTool(tool: LeftDrawerTool) {
    persistLayoutPatch({ sidebarVisible: true, sidebarTab: tool as SidebarTab });
  }
  function closeLeftDrawer() {
    persistLayoutPatch({ sidebarVisible: false });
  }
  function toggleLeftTool(tool: LeftDrawerTool) {
    if (leftActiveTool === tool) closeLeftDrawer();
    else selectLeftTool(tool);
  }

  function renderLeftUtilityPanel() {
    if (!leftDrawerOpen) return null;
    return (
      <aside
        className="left-utility-panel bento-card"
        style={{ width: layoutState.leftPanelWidth }}
        aria-label="Workspace navigation"
      >
        <div
          className="left-drawer-resize-handle"
          onMouseDown={startLeftPanelResize}
          role="separator"
          aria-orientation="vertical"
        />
        <header className="drawer-header">
          <div className="drawer-tabs">
            {leftDrawerTools.map((tool) => (
              <button
                key={tool}
                className={`drawer-tab-btn${leftActiveTool === tool ? ' active' : ''}`}
                onClick={() => selectLeftTool(tool)}
                title={LEFT_TOOL_META[tool].title}
                aria-label={LEFT_TOOL_META[tool].title}
              >
                {LEFT_TOOL_META[tool].icon}
              </button>
            ))}
          </div>
          <button
            className="drawer-close-btn"
            onClick={() => closeLeftDrawer()}
            title="Close panel"
            aria-label="Close panel"
          >
            <XIcon />
          </button>
        </header>
        <div className="drawer-body">
          <SidebarContent tab={layoutState.sidebarTab} />
        </div>
      </aside>
    );
  }

  // --- RIGHT utility drawer (summoned tools) ------------------------------
  // The layout-backed tools (Toolbox/HTTP/DB/Containers/Env). One derived
  // "active tool" + one selection handler that updates every backing flag
  // together (React batches them) → switching only swaps the body, no glitch.
  const rightActiveTool: RightTool | null = layoutState.toolboxVisible
    ? 'toolbox'
    : layoutState.httpVisible
      ? 'http'
      : layoutState.dbVisible
        ? 'db'
        : layoutState.containersVisible
          ? 'containers'
          : layoutState.envManagerOpen
            ? 'env'
            : null;
  const rightDrawerOpen = rightActiveTool !== null;

  function selectRightTool(tool: RightTool) {
    useLayoutStore.getState().setRightDrawerTool(tool);
  }
  function closeRightDrawer() {
    useLayoutStore.getState().setRightDrawerTool(null);
  }
  function toggleRightTool(tool: RightTool) {
    if (rightActiveTool === tool) closeRightDrawer();
    else selectRightTool(tool);
  }

  function renderRightUtilityPanel() {
    if (!rightDrawerOpen || !rightActiveTool) return null;
    return (
      <aside
        className="right-utility-panel bento-card"
        style={{ width: layoutState.rightDrawerWidth }}
        aria-label="Tools"
      >
        <div
          className="right-drawer-resize-handle"
          onMouseDown={startRightDrawerResize}
          role="separator"
          aria-orientation="vertical"
        />
        <header className="drawer-header">
          <div className="drawer-tabs">
            {RIGHT_TOOLS_ALL.map((tool) => (
              <button
                key={tool}
                className={`drawer-tab-btn${rightActiveTool === tool ? ' active' : ''}`}
                onClick={() => selectRightTool(tool)}
                title={RIGHT_TOOL_META[tool].title}
                aria-label={RIGHT_TOOL_META[tool].title}
              >
                {RIGHT_TOOL_META[tool].icon}
              </button>
            ))}
          </div>
          <button
            className="drawer-close-btn"
            onClick={() => closeRightDrawer()}
            title="Close panel"
            aria-label="Close panel"
          >
            <XIcon />
          </button>
        </header>
        <div className="drawer-body">
          <PanelHost id={rightActiveTool} />
        </div>
      </aside>
    );
  }

  function startAuxResize(event: React.MouseEvent) {
    setAuxResizing(true);
    auxResizeRef.current = { startX: event.clientX, startWidth: auxPanelWidth };
    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';
  }

  function startAuxRowResize(event: React.MouseEvent) {
    setAuxRowResizing(true);
    auxRowResizeRef.current = { startY: event.clientY, startHeight: auxEditorHeight };
    document.body.style.cursor = 'row-resize';
    document.body.style.userSelect = 'none';
  }

  function persistLayoutPatch(patch: Partial<ReturnType<typeof useLayoutStore.getState>>) {
    useLayoutStore.setState((state) => {
      const next = { ...state, ...patch };
      if (typeof window !== 'undefined') {
        localStorage.setItem('spacron_layout', JSON.stringify(next));
      }
      return next;
    });
  }

  function setPanelRoomOpen(id: AuxPanelId, open: boolean) {
    withRoomTransition(() => {
      const key = PANEL_VISIBILITY_KEYS[id];
      persistLayoutPatch({
        [key]: open,
        activeView: open ? id : 'terminal',
        lastAuxView: id,
        editorSplitPreview: false,
      });

      setMinimizedRooms((current) => {
        const next = new Set(current);
        next.delete(id);
        return next;
      });

      if (open) {
        setFocusedRoom(id);
      } else if (focusedRoom === id) {
        setFocusedRoom(nextVisibleRoom(id));
      }
    });
  }

  function togglePanelRoom(id: AuxPanelId) {
    const isOpen = Boolean(layoutState[PANEL_VISIBILITY_KEYS[id]]);
    if (isOpen && activeRoom !== id) {
      focusRoom(id);
      return;
    }
    setPanelRoomOpen(id, !isOpen);
  }

  function nextVisibleRoom(excluding: RoomId, minimized = minimizedRooms) {
    return openRooms.find((room) => room !== excluding && !minimized.has(room)) ?? null;
  }

  function focusRoom(id: RoomId) {
    withRoomTransition(() => {
      setMinimizedRooms((current) => {
        const next = new Set(current);
        next.delete(id);
        return next;
      });
      setFocusedRoom(id);
      if (id === 'terminal') setTerminalRoomOpen(true);
      if (id === 'dev-terminal') setDevTerminalRoomOpen(true);
    });
  }

  function showRoomInPrimary(id: RoomId) {
    if (id === activeRoom) return;
    withRoomTransition(() => {
      setMinimizedRooms((current) => {
        const next = new Set(current);
        next.delete(id);
        return next;
      });
      if (id === 'terminal') setTerminalRoomOpen(true);
      if (id === 'dev-terminal') setDevTerminalRoomOpen(true);
      if (id === splitRoom) {
        // Clicked the room already on the right → swap sides: the old left
        // room moves over to the right.
        setSecondaryRoom(activeRoom);
      } else {
        // Clicked a room that isn't displayed → replace the left pane only,
        // pinning whatever is on the right so it stays put.
        setSecondaryRoom(splitRoom);
      }
      setFocusedRoom(id);
    });
  }

  function showRoomInSecondary(id: RoomId) {
    withRoomTransition(() => {
      setMinimizedRooms((current) => {
        const next = new Set(current);
        next.delete(id);
        return next;
      });
      if (id === 'terminal') setTerminalRoomOpen(true);
      if (id === 'dev-terminal') setDevTerminalRoomOpen(true);
      if (id === activeRoom) {
        if (splitRoom) {
          setFocusedRoom(splitRoom);
          setSecondaryRoom(id);
        }
        return;
      }
      setSecondaryRoom(id);
    });
  }



  function minimizeRoom(id: RoomId) {
    withRoomTransition(() => {
      setMinimizedRooms((current) => {
        const next = new Set(current);
        next.add(id);
        return next;
      });
      if (focusedRoom === id) {
        setFocusedRoom(nextVisibleRoom(id));
      }
    });
  }

  function restoreRoom(id: RoomId) {
    withRoomTransition(() => {
      setMinimizedRooms((current) => {
        const next = new Set(current);
        next.delete(id);
        return next;
      });
      setFocusedRoom(id);
    });
  }

  function focusRoomMode(id: RoomId) {
    if (id === 'terminal') setTerminalRoomOpen(true);
    const focusSaved = perLayoutState.current['focus'];
    const minimized = new Set(focusSaved.minimized);
    minimized.delete(id);
    perLayoutState.current['focus'] = { focused: id, minimized };
    switchAmbientLayout('focus');
  }

  function closeRoom(id: RoomId) {
    withRoomTransition(() => {
      if (id === 'workspace') {
        toggleSidebar();
        if (focusedRoom === id) setFocusedRoom(nextVisibleRoom(id));
        return;
      }
      if (id === 'terminal') {
        setTerminalRoomOpen(false);
        if (focusedRoom === id) setFocusedRoom(nextVisibleRoom(id));
        return;
      }
      if (id === 'dev-terminal') {
        setDevTerminalRoomOpen(false);
        if (focusedRoom === id) setFocusedRoom(nextVisibleRoom(id));
        return;
      }

      if (isAgentRoomId(id)) {
        void killSession(getAgentRoomSessionId(id));
        if (focusedRoom === id) setFocusedRoom(nextVisibleRoom(id));
        return;
      }
      setPanelRoomOpen(id, false);
    });
  }

  // The left-bar nav launchers now come from `leftNavDockItems` (built from
  // LEFT_DRAWER_TOOLS); the center-room launchers live in `panelItems` below.
  const panelItems: ActivityItem[] = [
    {
      id: 'editor',
      title: 'Editor',
      active: layoutState.editorVisible,
      onClick: () => togglePanelRoom('editor'),
      icon: <Icon><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7" /><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z" /></Icon>,
    },
    {
      id: 'terminal',
      title: 'Terminal',
      active: terminalRoomOpen && activeRoom === 'terminal',
      onClick: () => {
        setTerminalRoomOpen(true);
        focusRoom('terminal');
        // Auto-create a shell session if the terminal grid is empty
        const pa = get(paneAssignments);
        if (pa.every((id) => id === null)) {
          createTerminalSession();
        }
      },
      icon: <Icon><rect x="2" y="3" width="20" height="18" rx="3" /><polyline points="8,9 4,12 8,15" /><line x1="12" y1="15" x2="20" y2="15" /></Icon>,
    },
    {
      id: 'preview',
      title: 'Preview',
      active: layoutState.previewVisible,
      onClick: () => togglePanelRoom('preview'),
      icon: <Icon><circle cx="12" cy="12" r="10" /><path d="M12 2a14.5 14.5 0 0 0 0 20 14.5 14.5 0 0 0 0-20" /><path d="M2 12h20" /></Icon>,
    },
    {
      id: 'http',
      title: 'HTTP Client',
      active: layoutState.httpVisible,
      onClick: () => toggleHttpVisible(),
      icon: <Icon><path d="M22 12h-4l-3 9L9 3l-3 9H2" /></Icon>,
    },
    {
      id: 'tasks',
      title: 'Tasks',
      active: layoutState.tasksVisible,
      onClick: () => togglePanelRoom('tasks'),
      icon: <Icon><rect x="3" y="3" width="5" height="18" rx="1" /><rect x="10" y="3" width="5" height="12" rx="1" /><rect x="17" y="3" width="5" height="8" rx="1" /></Icon>,
    },
    {
      id: 'db',
      title: 'Database Explorer',
      active: layoutState.dbVisible,
      onClick: () => toggleDbVisible(),
      icon: <Icon><ellipse cx="12" cy="5" rx="9" ry="3" /><path d="M3 5v14c0 1.66 4 3 9 3s9-1.34 9-3V5" /><path d="M3 12c0 1.66 4 3 9 3s9-1.34 9-3" /></Icon>,
    },
    {
      id: 'containers',
      title: 'Containers',
      active: layoutState.containersVisible,
      onClick: () => toggleContainersVisible(),
      icon: <Icon><path d="M4 7.5 12 3l8 4.5-8 4.5-8-4.5Z" /><path d="M4 12.5 12 17l8-4.5" /><path d="M4 17.5 12 22l8-4.5" /></Icon>,
    },
    {
      id: 'toolbox',
      title: 'Dev Toolbox',
      active: layoutState.toolboxVisible,
      onClick: () => toggleToolboxVisible(),
      icon: <Icon><path d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.76 3.76z" /></Icon>,
    },
    {
      id: 'youtube',
      title: 'Media Player',
      active: layoutState.youtubeVisible,
      // Pops up the free-floating window rather than opening a tiled room.
      onClick: () => toggleYoutubeVisible(),
      icon: <Icon><rect x="2" y="5" width="20" height="14" rx="4" /><path d="m10 9 5 3-5 3z" fill="currentColor" stroke="none" /></Icon>,
    },
  ];

  const bottomItems: ActivityItem[] = [
    {
      id: 'spawnAgent',
      title: 'Spawn Agents',
      active: layoutState.agentSpawnOpen,
      onClick: () => {
        if (layoutState.agentSpawnOpen) closeAgentSpawn();
        else openAgentSpawn();
      },
      icon: <Icon><path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2" /><circle cx="9" cy="7" r="4" /><line x1="19" y1="8" x2="19" y2="14" /><line x1="16" y1="11" x2="22" y2="11" /></Icon>,
    },
    {
      id: 'excalidraw',
      title: 'Sketch (Excalidraw)',
      active: false,
      onClick: () => {
        // Start the embedding proxy first — excalidraw.com only renders through
        // it, so creating the tab before the proxy is up leaves a blank frame.
        void ensureProxyRunning();
        createPreviewBrowserTab('https://excalidraw.com');
        setPanelRoomOpen('preview', true);
      },
      icon: <Icon><path d="M12 20h9" /><path d="M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4 9.5-9.5z" /></Icon>,
    },
  ];

  // Launcher buttons for the LEFT utility drawer's tools, grouped at the left
  // end of the dock (mirror of the right tools group). Toggling re-uses the
  // unified left-drawer selection so it never closes/reopens the frame.
  const leftNavDockItems: ActivityItem[] = leftDrawerTools.map((tool) => ({
    id: tool,
    title: LEFT_TOOL_META[tool].title,
    active: leftActiveTool === tool,
    onClick: () => toggleLeftTool(tool),
    icon: LEFT_TOOL_META[tool].icon,
  }));

  // Launcher buttons for the right utility drawer's tools (incl. Orchestrator),
  // grouped together at the right end of the dock.
  const drawerToolItems: ActivityItem[] = RIGHT_TOOLS_ALL.map((tool) => ({
    id: tool,
    title: RIGHT_TOOL_META[tool].title,
    active: rightActiveTool === tool,
    onClick: () => toggleRightTool(tool),
    icon: RIGHT_TOOL_META[tool].icon,
  }));
  const drawerToolIds = new Set<string>(RIGHT_DRAWER_TOOLS);
  // The remaining dock buttons launch center rooms; the drawer tools are pulled
  // out into their own right-aligned group.
  const roomLauncherItems = panelItems.filter((item) => !drawerToolIds.has(item.id));

  function renderAuxPanes() {
    if (visiblePanels.length === 3) {
      return (
        <>
          <div className="aux-pane split-pane-third" style={{ height: '33.3%', minHeight: '10%' }}>
            <PanelHost id={visiblePanels[0].id} />
          </div>
          <div className="aux-separator-line" />
          <div className="aux-pane split-pane-third" style={{ height: '33.3%', minHeight: '10%' }}>
            <PanelHost id={visiblePanels[1].id} />
          </div>
          <div className="aux-separator-line" />
          <div className="aux-pane split-pane-third" style={{ height: '33.4%', minHeight: '10%' }}>
            <PanelHost id={visiblePanels[2].id} />
          </div>
        </>
      );
    }

    if (visiblePanels.length === 2) {
      return (
        <>
          <div className="aux-pane split-pane-top" style={{ height: `${auxEditorHeight}%`, minHeight: '10%' }}>
            <PanelHost id={visiblePanels[0].id} />
          </div>
          <div
            className={`aux-row-resize-handle${auxRowResizing ? ' resizing' : ''}`}
            onMouseDown={startAuxRowResize}
            role="separator"
            aria-label="Resize panels"
          />
          <div className="aux-pane split-pane-bottom" style={{ height: `${100 - auxEditorHeight}%`, minHeight: '10%' }}>
            <PanelHost id={visiblePanels[1].id} />
          </div>
        </>
      );
    }

    if (visiblePanels.length === 1) {
      return (
        <div className="aux-pane full-pane">
          <PanelHost id={visiblePanels[0].id} />
        </div>
      );
    }

    return null;
  }

  // Falls back to the cross-project list so a background project's agent pane —
  // mounted but hidden — still resolves its title and preset instead of
  // rendering as a nameless "Agent".
  function getAgentSessionForRoom(id: AgentRoomId) {
    const sessionId = getAgentRoomSessionId(id);
    return (
      allTerminalSessions.find((session) => session.id === sessionId)
      ?? crossProjectSessions.find((session) => session.id === sessionId)
      ?? null
    );
  }

  function roomTitle(id: RoomId) {
    if (isAgentRoomId(id)) {
      const session = getAgentSessionForRoom(id);
      if (!session) return 'Agent';
      // Disambiguate against the session's OWN project's siblings.
      const siblings = allTerminalSessions.some((entry) => entry.id === session.id)
        ? allTerminalSessions
        : crossProjectSessions.filter((entry) => entry.projectId === session.projectId);
      return getSessionPromptTargetLabel(session, siblings);
    }
    if (id === 'dev-terminal') return 'Terminal';
    if (id === 'workspace') {
      const tab = layoutState.sidebarTab;
      if (tab === 'git') return 'Source Control';
      if (tab === 'files') return 'Explorer';
      if (tab === 'search') return 'Search';
      if (tab === 'snapshots') return 'Snapshots';
      if (tab === 'history') return 'History';
      if (tab === 'snippets') return 'Snippets';

      return 'Explorer';
    }
    return ROOM_TITLES[id];
  }

  function roomKind(id: RoomId) {
    if (isAgentRoomId(id)) {
      const session = getAgentSessionForRoom(id);
      return session?.agentPreset ?? 'agent';
    }
    if (id === 'terminal' || id === 'dev-terminal') return 'terminal';
    if (id === 'workspace') return layoutState.sidebarTab;
    return 'tool';
  }

  function roomIcon(id: RoomId) {
    if (isAgentRoomId(id)) {
      // Each agent room shows its CLI's real logo (Claude, Codex, Cursor, …)
      // instead of a generic robot — matched by the session's launch command,
      // with a web-fetched or letter fallback for unknown agents.
      const session = getAgentSessionForRoom(id);
      return <AgentBrandMark command={session?.agentPreset ?? null} name={roomTitle(id)} />;
    }
    switch (id) {
      case 'workspace':
        return <Icon><path d="M3 7a2 2 0 0 1 2-2h3.586a2 2 0 0 1 1.414.586L11.414 7H19a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7z" /></Icon>;
      case 'terminal':
      case 'dev-terminal':
        return <Icon><rect x="2" y="3" width="20" height="18" rx="3" /><polyline points="8,9 4,12 8,15" /><line x1="12" y1="15" x2="20" y2="15" /></Icon>;
      case 'editor':
        return <Icon><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7" /><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z" /></Icon>;
      case 'preview':
        return <Icon><circle cx="12" cy="12" r="10" /><path d="M12 2a14.5 14.5 0 0 0 0 20 14.5 14.5 0 0 0 0-20" /><path d="M2 12h20" /></Icon>;
      case 'review':
        return <Icon><circle cx="18" cy="18" r="3" /><circle cx="6" cy="6" r="3" /><path d="M13 6h3a2 2 0 0 1 2 2v7" /><path d="M11 18H8a2 2 0 0 1-2-2V9" /></Icon>;
      case 'http':
        return <Icon><path d="M22 12h-4l-3 9L9 3l-3 9H2" /></Icon>;
      case 'tasks':
        return <Icon><rect x="3" y="3" width="5" height="18" rx="1" /><rect x="10" y="3" width="5" height="12" rx="1" /><rect x="17" y="3" width="5" height="8" rx="1" /></Icon>;
      case 'db':
        return <Icon><ellipse cx="12" cy="5" rx="9" ry="3" /><path d="M3 5v14c0 1.66 4 3 9 3s9-1.34 9-3V5" /><path d="M3 12c0 1.66 4 3 9 3s9-1.34 9-3" /></Icon>;
      case 'containers':
        return <Icon><path d="M4 7.5 12 3l8 4.5-8 4.5-8-4.5Z" /><path d="M4 12.5 12 17l8-4.5" /><path d="M4 17.5 12 22l8-4.5" /></Icon>;
    case 'toolbox':
      return <Icon><path d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.76 3.76z" /></Icon>;
    default:
      return null;
    }
  }

  function renderRoomContent(id: RoomId) {
    if (id === 'workspace') return <SidebarContent tab={layoutState.sidebarTab} />;
    if (isAgentRoomId(id)) {
      const sessionId = getAgentRoomSessionId(id);
      // Cross-project lookup: a background project's agent stays mounted here
      // (hidden), and resolving only against the active project's sessions would
      // swap its TerminalPane for this placeholder — unmounting the xterm, which
      // is exactly what we keep the pane around to avoid.
      const session = getAgentSessionForRoom(id);
      if (!session) {
        return <div className="agent-panel-empty">Agent session closed</div>;
      }
      return (
        <div className="agent-terminal-room">
          <AgentWorktreeBadge sessionId={sessionId} />
          <AgentPanelImages sessionId={sessionId} />
          <TerminalPane
            sessionId={sessionId}
            paneIndex={terminalPaneAssignments.indexOf(sessionId)}
            isActive={currentActiveSessionId === sessionId}
            onActivate={() => setActiveSession(sessionId)}
            onClose={() => void killSession(sessionId)}
            onMaximize={() => focusRoom(id)}
          />
        </div>
      );
    }
    if (id === 'terminal') {
      // The terminal room is the user's personal terminal only. Agents never
      // surface here — each runs in its own `agent:N` room (reachable from the
      // room dock / stack), keeping this grid free of agent panes and churn.
      //
      // One panel per OPEN PROJECT, with the inactive ones parked (hidden, but
      // mounted and laid out at full size). A single panel would have to re-map
      // its cells to the incoming project's sessions on every switch, which
      // unmounts each pane's xterm and rebuilds it from replayed scrollback.
      // Parked panels are display-only — see `isActiveProject` in TerminalPanel.
      return (
        <div className="terminal-room-body">
          {terminalHostProjectIds.length > 0 ? (
            terminalHostProjectIds.map((pid) => (
              <div
                key={pid}
                className={`terminal-project-layer${pid === activeProjectIdValue ? '' : ' parked'}`}
                inert={pid !== activeProjectIdValue}
              >
                <TerminalPanel projectId={pid} isActiveProject={pid === activeProjectIdValue} />
              </div>
            ))
          ) : (
            <div className="terminal-project-layer">
              <TerminalPanel />
            </div>
          )}
          {projectSwitching && <div className="project-switch-overlay" />}
        </div>
      );
    }
    if (id === 'dev-terminal') {
      return (
        <div className="terminal-room-body dev-terminal">
          <TerminalPanel devMode={true} />
          {projectSwitching && <div className="project-switch-overlay" />}
        </div>
      );
    }
    return <PanelHost id={id} />;
  }

  // Rendered as a plain function call (not <RoomFrame/>), so its identity never
  // changes between AppShell re-renders. Defining it as a component and using it
  // as a JSX element remounts the whole room subtree — including the xterm
  // terminal — on every store-driven re-render, which caused the click flicker
  // and terminal churn.
  function renderRoomFrame(id: RoomId, featured = false) {
    const title = roomTitle(id);
    // Agent rooms carry their CLI's real logo to the left of the title.
    const agentSession = isAgentRoomId(id) ? getAgentSessionForRoom(id) : null;
    return (
      <section
        key={id}
        className={`room-panel bento-card${featured ? ' featured active-glow' : ''}`}
        data-room-id={id}
        style={{ viewTransitionName: `spacron-room-${id.replace(/[^a-zA-Z0-9_-]/g, '-')}` } as React.CSSProperties}
      >
        <header className="room-header">
          <button
            className={`room-title${agentSession ? ' has-brand' : ''}`}
            onClick={() => focusRoom(id)}
            title={`Focus ${title}`}
          >
            {agentSession && (
              <AgentBrandMark
                command={agentSession.agentPreset ?? null}
                name={title}
                className="room-title-brand"
              />
            )}
            <span className="room-kind">{roomKind(id)}</span>
            <span className="room-name">{title}</span>
          </button>
          <div className="room-actions">
            <button className="room-action" onClick={() => minimizeRoom(id)} title="Minimize" aria-label={`Minimize ${title}`}>
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round">
                <path d="M5 12h14" />
              </svg>
            </button>
            <button className="room-action danger" onClick={() => closeRoom(id)} title="Close" aria-label={`Close ${title}`}>
              <XIcon />
            </button>
          </div>
        </header>
        <div className="room-content">{renderRoomContent(id)}</div>
      </section>
    );
  }

  function getRoomPreview(id: RoomId) {
    if (id === 'editor') {
      const editorStore = useEditorStore.getState();
      const fileEntry = activeFile ? editorStore.fileCache.get(activeFile) : null;
      const fileLines = fileEntry?.kind === 'text' && fileEntry.content
        ? fileEntry.content.split('\n').filter(line => line.trim().length > 0).slice(0, 3)
        : [];
      return (
        <div className="room-card-preview">
          {fileLines.length > 0 ? (
            <pre className="room-card-code-snippet">
              {fileLines.join('\n')}
            </pre>
          ) : (
            <span className="room-card-empty-snippet">
              {activeFile ? activeFile.split(/[/\\]/).pop() : 'No active file'}
            </span>
          )}
        </div>
      );
    }
    if (id === 'terminal') {
      const lastCommands = (history || []).slice(0, 2);
      return (
        <div className="room-card-preview">
          {lastCommands.length > 0 ? (
            <div className="room-card-terminal-snippet">
              {lastCommands.map((cmd, i) => (
                <div key={i} className="terminal-cmd-line">
                  <span className="terminal-prompt">$</span> {cmd}
                </div>
              ))}
            </div>
          ) : (
            <span className="room-card-empty-snippet">
              {allTerminalSessions.length > 0
                ? `${allTerminalSessions.length} active session${allTerminalSessions.length > 1 ? 's' : ''}`
                : 'No active shells'}
            </span>
          )}
        </div>
      );
    }
    if (id === 'workspace') {
      const openFilesList = useEditorStore.getState().openFiles || [];
      const openFilesPreview = openFilesList.slice(0, 2);
      return (
        <div className="room-card-preview">
          <div className="room-card-workspace-snippet">
            <div className="workspace-project-title">{project ? project.name : 'Empty workspace'}</div>
            {openFilesPreview.length > 0 && (
              <div className="workspace-open-files">
                {openFilesPreview.map(f => (
                  <div key={f} className="workspace-file-item">• {f.split(/[/\\]/).pop()}</div>
                ))}
              </div>
            )}
          </div>
        </div>
      );
    }

    if (id === 'preview') {
      return <div className="room-card-preview">Live markdown & web preview</div>;
    }
    if (id === 'review') {
      return <div className="room-card-preview">Code review & diff viewer</div>;
    }
    if (id === 'tasks') {
      return <div className="room-card-preview">View & run task checklist</div>;
    }
    if (id === 'http') {
      return <div className="room-card-preview">Compose REST HTTP requests</div>;
    }
    if (id === 'db') {
      return <div className="room-card-preview">Explore connected databases</div>;
    }
    if (id === 'containers') {
      return <div className="room-card-preview">Docker containers & images</div>;
    }
    if (id === 'toolbox') {
      return <div className="room-card-preview">Dev utility toolbox</div>;
    }
    return null;
  }

  function renderRoomCard(id: RoomId) {
    return (
      <button key={id} className="room-card bento-card" onClick={() => focusRoom(id)} title={`Open ${roomTitle(id)}`}>
        <div className="room-card-header">
          <span className="room-card-icon">{roomIcon(id)}</span>
          <span className="room-card-kind">{roomKind(id)}</span>
        </div>
        <span className="room-card-name">{roomTitle(id)}</span>
        {getRoomPreview(id)}
      </button>
    );
  }

  function renderMinimizedRooms() {
    if (minimizedRooms.size === 0) return null;
    const orderedMinimized = [
      ...roomOrder.filter((room) => minimizedRooms.has(room)),
      ...Array.from(minimizedRooms).filter((room) => !roomOrder.includes(room)),
    ];
    return (
      <div className="minimized-room-stack" aria-label="Minimized rooms">
        {orderedMinimized.map((room) => (
          <button
            key={room}
            className="minimized-room"
            onClick={() => restoreRoom(room)}
            title={`Restore ${roomTitle(room)}`}
            aria-label={`Restore ${roomTitle(room)}`}
          >
            <span className="minimized-room-icon" aria-hidden="true">{roomIcon(room)}</span>
            <span className="minimized-room-label">{roomTitle(room)}</span>
          </button>
        ))}
      </div>
    );
  }

  function finishLayoutSwitch() {
    if (layoutSwitchTimerRef.current !== null) {
      window.clearTimeout(layoutSwitchTimerRef.current);
      layoutSwitchTimerRef.current = null;
    }
    setLayoutSwitching(false);
    notifyPanesResized();
  }

  function switchAmbientLayout(requested: AmbientLayout) {
    // One-window shell: only `focus` (the single terminal/agent screen), `vibe`
    // (the optional Fleet grid) and `gallery` (the Split view — two rooms side by
    // side) are reachable. Any request for development/preview collapses to
    // focus. The right-drawer tools no longer request a layout at all — the
    // drawer is a side panel that works in every layout, so opening Toolbox/
    // HTTP/DB/Containers/Env can't pull you out of Split or Fleet. `gallery` is
    // only ever requested by an explicit user action (the Split toggle / cycle
    // shortcut), so entering the Split view always stays intentional.
    const nextLayout: AmbientLayout =
      requested === 'vibe' ? 'vibe' : requested === 'gallery' ? 'gallery' : 'focus';
    if (nextLayout === ambientLayout) return;

    // Save current mode's state before switching
    perLayoutState.current[ambientLayout] = { focused: focusedRoom, minimized: minimizedRooms };

    // Fleet (vibe) shows running agents; keep the terminal session open behind it
    // so returning to the workspace lands you back on a live terminal.
    if (nextLayout === 'vibe') {
      setTerminalRoomOpen(true);
    }

    // Restore target mode's own minimize/focus state (independent per layout)
    const saved = perLayoutState.current[nextLayout];
    setFocusedRoom(saved.focused);
    setMinimizedRooms(saved.minimized);

    const prefersReducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    if (layoutSwitchTimerRef.current !== null) window.clearTimeout(layoutSwitchTimerRef.current);

    // Animate the switch by letting the new (live) DOM settle in via the
    // `.layout-switching` CSS pass, NOT the View Transition API. View
    // transitions froze a bitmap of the previous layout; when a second switch
    // landed while one was mid-flight, that frozen snapshot of the old panels
    // stayed ghosting on screen. The settle pass only ever touches elements that
    // are actually in the new layout, so nothing from the former mode can linger.
    // Defer the flushSync update to a microtask if we are currently rendering to
    // avoid React lifecycle flushSync warnings.
    queueMicrotask(() => {
      flushSync(() => {
        setLayoutSwitching(!prefersReducedMotion);
        setAmbientLayout(nextLayout);
      });

      if (prefersReducedMotion) {
        setLayoutSwitching(false);
        return;
      }

      layoutSwitchTimerRef.current = window.setTimeout(finishLayoutSwitch, 360);
    });
  }

  function renderSplitSwitcher() {
    return (
      <aside className="split-switcher" aria-label="Switch split rooms">
        <div className="split-switcher-rooms">
          {visibleRooms.map((room) => {
            const isPrimary = room === activeRoom;
            const isSecondary = room === splitRoom;
            return (
              <div
                key={room}
                className={`split-switch-item${isPrimary ? ' primary' : ''}${isSecondary ? ' secondary' : ''}`}
              >
                <span className="split-switch-summary">
                  <span className="split-switch-icon" aria-hidden="true">{roomIcon(room)}</span>
                  <span className="split-switch-copy">
                    <span className="split-switch-name">{roomTitle(room)}</span>
                    <span className="split-switch-role">
                      {isPrimary ? 'Primary' : isSecondary ? 'Secondary' : roomKind(room)}
                    </span>
                  </span>
                </span>
                <span className="split-target-actions">
                  <button
                    type="button"
                    className={`split-target-btn${isPrimary ? ' active' : ''}`}
                    onClick={() => showRoomInPrimary(room)}
                    title={`Show ${roomTitle(room)} on the left`}
                    aria-label={`Show ${roomTitle(room)} on the left`}
                  >
                    Left
                  </button>
                  <button
                    type="button"
                    className={`split-target-btn${isSecondary ? ' active' : ''}`}
                    onClick={() => showRoomInSecondary(room)}
                    title={`Show ${roomTitle(room)} on the right`}
                    aria-label={`Show ${roomTitle(room)} on the right`}
                  >
                    Right
                  </button>
                </span>
              </div>
            );
          })}
        </div>
      </aside>
    );
  }

  function renderAmbientLayout() {
    if (ambientLayout === 'preview') {
      // The live app preview is the stage; other open and non-minimized panels
      // (like the terminal and running agents) stack alongside.
      const secondaryRooms = visibleRooms.filter((room) => room === 'terminal' || isAgentRoomId(room));
      return (
        <>
          <div className="focused-room">
            {renderRoomFrame('preview', true)}
          </div>
          {secondaryRooms.length > 0 && (
            <div className="ambient-secondary-container">
              {secondaryRooms.map((room) => (
                <div key={room} className="ambient-secondary-room">
                  {renderRoomFrame(room, true)}
                </div>
              ))}
            </div>
          )}
          {renderMinimizedRooms()}
        </>
      );
    }

    if (ambientLayout === 'development') {
      const devTool = ['toolbox', 'http', 'db', 'containers', 'env'].includes(layoutState.activeView)
        ? layoutState.activeView
        : (layoutState.lastAuxView && ['toolbox', 'http', 'db', 'containers', 'env'].includes(layoutState.lastAuxView) ? layoutState.lastAuxView : 'toolbox');
      
      const secondaryRooms = visibleRooms.filter((room) => room === 'dev-terminal' || isAgentRoomId(room));
      
      return (
        <>
          <div className="focused-room">
            {renderRoomFrame(devTool as RoomId, true)}
          </div>
          {secondaryRooms.length > 0 && (
            <div className="ambient-secondary-container">
              {secondaryRooms.map((room) => (
                <div key={room} className="ambient-secondary-room">
                  {renderRoomFrame(room, true)}
                </div>
              ))}
            </div>
          )}
          {renderMinimizedRooms()}
        </>
      );
    }

    // VS Code-style persistence: every open terminal/agent keeps its xterm
    // mounted at all times. Focus LAYERS them (only the active one visible);
    // Split (gallery) re-flows the SAME live panes into two side-by-side columns;
    // Fleet (vibe) re-flows them into a grid. All three modes render the identical
    // keyed `.stage-layers` container + `.stage-pane` children, so switching
    // between them only swaps CSS classes and each pane's `order` — React never
    // unmounts an xterm, so the PTY view is never disposed/rebuilt (no lost
    // scrollback, no corrupted WebGL atlas) and the panes just resize into place
    // (their ResizeObserver refits the terminal). Non-terminal rooms
    // (editor/preview/…) are mounted as their own keyed pane; `isVibe`/`isSplit`
    // decide which panes are visible and how they lay out.
    const isVibe = ambientLayout === 'vibe';
    const isSplit = ambientLayout === 'gallery';
    // What gets MOUNTED, which is deliberately wider than what gets shown:
    //   • `openRooms`, not `visibleRooms` — a minimized room is still open, so it
    //     keeps its xterm (just hidden). Minimizing, and any layout switch that
    //     swaps in another mode's minimized set, used to unmount the pane.
    //   • plus every other project's agent rooms, so switching projects hides
    //     their panes instead of disposing them.
    // Everything not on `stageRooms` renders with `.stage-hidden`.
    //
    // Ordered deterministically (shells first, then agents by session id — which
    // is monotonic, so it's creation order) rather than by whichever list a room
    // came from. An agent moves between those two lists as you switch projects,
    // and letting that reorder the children would make React re-parent a live
    // pane's DOM on every switch.
    const persistentStageRooms: RoomId[] = [
      ...(['terminal', 'dev-terminal'] as RoomId[]).filter((room) => openRooms.includes(room)),
      ...Array.from(new Set([...openRooms.filter(isAgentRoomId), ...mountedAgentRoomIds])).sort(
        (a, b) => getAgentRoomSessionId(a) - getAgentRoomSessionId(b),
      ),
    ];
    const visibleStageRooms = visibleRooms.filter(isPersistentRoomId);
    const hasAgents = visibleStageRooms.some(isAgentRoomId);

    // Which rooms occupy the stage right now:
    //   focus → the active room only
    //   split → primary (active) + secondary (split), side by side
    //   vibe  → every running agent
    const stageRooms: RoomId[] = isVibe
      ? visibleStageRooms.filter(isAgentRoomId)
      : isSplit
        ? ([activeRoom, splitRoom].filter((room): room is RoomId => room !== null))
        : activeRoom
          ? [activeRoom]
          : [];
    const stageRoomSet = new Set(stageRooms);
    // Non-terminal rooms that must be mounted as their own pane (editor/preview/…).
    const nonPersistentStageRooms = stageRooms.filter((room) => !isPersistentRoomId(room));

    // Empty states (Fleet with no agents / no active room) must NOT short-circuit
    // past the stage: returning a bare placeholder here unmounts every mounted
    // pane, so flipping to Fleet with only a personal terminal open would dispose
    // that terminal. `stageRooms` is already empty in both cases, so the stage
    // renders with every pane hidden — the message just layers on top of it.
    const emptyStageMessage = isVibe && !hasAgents
      ? 'Open an agent to see it here'
      : (!isVibe && !activeRoom ? '' : null);

    const stageModifier = isVibe ? ' vibe-grid' : isSplit ? ' split-grid' : '';
    // In Split, force the primary room to the left column and the secondary to the
    // right, regardless of DOM order (a terminal is mapped before an editor even
    // when the editor is the primary/left pane).
    const paneOrder = (room: RoomId): React.CSSProperties | undefined =>
      isSplit ? { order: room === activeRoom ? 0 : 1 } : undefined;

    return (
      <>
        <div
          className={`focused-room stage-layers${stageModifier}`}
          style={isSplit ? ({ '--split-cols': stageRooms.length } as React.CSSProperties) : undefined}
          aria-label={emptyStageMessage ? 'No agents running' : undefined}
        >
          {emptyStageMessage !== null && (
            <p className="vibe-empty-msg stage-empty-msg">{emptyStageMessage}</p>
          )}
          {persistentStageRooms.map((room) => {
            // Focus: only the active pane is visible. Split: the primary+secondary
            // panes. Fleet: every agent pane. Off-stage terminals stay mounted but
            // hidden (visibility, not unmount) so returning is instant and clean.
            const hidden = !stageRoomSet.has(room);
            return (
              <div
                key={room}
                className={`stage-pane${hidden ? ' stage-hidden' : ''}`}
                style={hidden ? undefined : paneOrder(room)}
              >
                {renderRoomFrame(room, true)}
              </div>
            );
          })}
          {nonPersistentStageRooms.map((room) => (
            <div key={room} className="stage-pane" style={paneOrder(room)}>
              {renderRoomFrame(room, true)}
            </div>
          ))}
        </div>
        {isSplit
          ? visibleRooms.length > 0 && renderSplitSwitcher()
          : !isVibe && stackedRooms.length > 0 && (
              <aside className="room-stack" aria-label="Open rooms">
                <div className="room-cards-row">
                  {stackedRooms.map((room) => renderRoomCard(room))}
                </div>
              </aside>
            )}
        {renderMinimizedRooms()}
      </>
    );
  }

  return (
    <div className="app-shell">
      <TitleBar />
      <UpdateBanner />

      <div className="zoom-wrapper">
        {/* The workspace stays MOUNTED whenever one is open — the Home screen
            below layers over it rather than replacing it. Unmounting this
            subtree disposes every xterm, so a trip home would kill each
            terminal's view and force a reattach-by-replay on return (which is
            what broke running agents' rendering). `home-hidden` hides it with
            visibility, never display, so the panes keep their measured size and
            are instantly correct when Home closes. */}
        <div className="zoom-content">
        {workspaceId && (
          <div className={`workspace-layer${homeOpen ? ' home-hidden' : ''}`} inert={homeOpen}>
            {projectSwitching && <div className="project-switching-overlay" />}
            <div
              className={`app-body rooms-workspace${resizing ? ' resizing' : ''}`}
              style={{
                '--overlay-clear': `${overlaysHeight + 12}px`,
              } as React.CSSProperties}
            >
              {resizing && <div className={`resize-overlay${auxRowResizing ? ' row-resize' : ''}`} />}

              <div className="rooms-content-horizontal">
                {renderLeftUtilityPanel()}

                <main ref={roomsTableRef} className={`rooms-table ambient-${ambientLayout}${layoutSwitching ? ' layout-switching' : ''}${
                  (ambientLayout === 'preview' && visibleRooms.filter((room) => room === 'terminal' || isAgentRoomId(room)).length === 0) ||
                  (ambientLayout === 'development' && visibleRooms.filter((room) => room === 'dev-terminal' || isAgentRoomId(room)).length === 0)
                    ? ` ${ambientLayout}-solo`
                    : ''
                }`} aria-label="Spacron ambient layout">
                  {renderAmbientLayout()}
                </main>

                {renderRightUtilityPanel()}
              </div>

              <div ref={overlaysRef} className="workspace-overlays">
              <nav className="room-dock bento-card" aria-label="Room launcher">
                {/* Single unified dock (the 5-mode `development` branch is gone).
                    Left→right: workspace nav · room launchers · dev tools (open
                    the docked overlay) · actions + Fleet. */}
                <div className="room-dock-group nav">
                  {leftNavDockItems.map((item) => <ActivityButton key={item.id} item={item} />)}
                </div>
                <div className="room-dock-separator" />
                <div className="room-dock-group tools">
                  {roomLauncherItems.map((item) => <ActivityButton key={item.id} item={item} />)}
                </div>
                <div className="room-dock-separator" />
                <div className="room-dock-group utilities">
                  {drawerToolItems.map((item) => <ActivityButton key={item.id} item={item} />)}
                </div>
                <div className="room-dock-separator" />
                <div className="room-dock-group">
                  {bottomItems.map((item) => <ActivityButton key={item.id} item={item} />)}
                  <ActivityButton
                    item={{
                      id: 'focus',
                      title: ambientLayout === 'focus' ? 'Back to split' : 'Focus — single panel',
                      active: ambientLayout === 'focus',
                      onClick: () => switchAmbientLayout(ambientLayout === 'focus' ? 'gallery' : 'focus'),
                      icon: <Icon><rect x="4" y="4" width="16" height="16" rx="1.5" /></Icon>,
                    }}
                  />
                  <ActivityButton
                    item={{
                      id: 'split',
                      title: ambientLayout === 'gallery' ? 'Back to split' : 'Split — two panels',
                      active: ambientLayout === 'gallery',
                      onClick: () => switchAmbientLayout(ambientLayout === 'gallery' ? 'gallery' : 'gallery'),
                      icon: <Icon><rect x="3" y="4" width="7.5" height="16" rx="1.3" /><rect x="13.5" y="4" width="7.5" height="16" rx="1.3" /></Icon>,
                    }}
                  />
                  <ActivityButton
                    item={{
                      id: 'fleet',
                      title: ambientLayout === 'vibe' ? 'Back to split' : 'Fleet — all agents',
                      active: ambientLayout === 'vibe',
                      onClick: () => switchAmbientLayout(ambientLayout === 'vibe' ? 'gallery' : 'vibe'),
                      icon: <Icon><rect x="3" y="3" width="7" height="7" rx="1" /><rect x="14" y="3" width="7" height="7" rx="1" /><rect x="3" y="14" width="7" height="7" rx="1" /><rect x="14" y="14" width="7" height="7" rx="1" /></Icon>,
                    }}
                  />
                </div>
              </nav>
              <div className="composer-strip">
                <FloatingPromptBar />
              </div>
              </div>
            </div>
          </div>
        )}

        {showWelcome && (
          <div className={`welcome-fullpage${workspaceId ? ' over-workspace' : ''}`}>
            <div className="welcome-main">
              <WelcomeScreen />
            </div>
          </div>
        )}
        </div>

        {/* Free-floating YouTube pop-up. Mounted at the app root (outside the
            ambient rooms grid) so it overlays any page and survives Focus /
            Split / Canvas switches without unmounting. */}
        {layoutState.youtubeVisible && <FloatingYouTube onClose={() => toggleYoutubeVisible()} />}
      </div>
    </div>
  );
}
