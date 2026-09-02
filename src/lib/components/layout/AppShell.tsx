import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { flushSync } from 'react-dom';
import { isWebkitGtk, viewTransitionsReliable } from '$lib/utils/tauri';
import TitleBar from './TitleBar.tsx';
import UpdateBanner from '$lib/components/shared/UpdateBanner.tsx';
import { useAction } from '$lib/react/useAction';
import { useStore } from '$lib/react/useStore';
import { isModalOpen } from '$lib/react/useModalFocus';
import { get } from '$lib/stores/storeCompat';
import { useWorkspaceStore } from '$lib/stores/zustand/workspace';
import FileExplorer from '$lib/components/explorer/FileExplorer.tsx';
import ProblemsPanel from '$lib/components/problems/ProblemsPanelLazy.tsx';
import SearchPanel from '$lib/components/explorer/SearchPanel.tsx';
import SourceControl from '$lib/components/explorer/SourceControl.tsx';
import SnapshotsPanel from './SnapshotsPanel.tsx';
import TerminalSnippetsPanel from '$lib/components/explorer/TerminalSnippetsPanel.tsx';
import ProjectHUD from '$lib/components/workspace/ProjectHUD.tsx';

import TerminalPanel from '$lib/components/terminal/TerminalPanel.tsx';
import TerminalPane from '$lib/components/terminal/TerminalPane.tsx';
import WelcomeScreen from '$lib/components/workspace/WelcomeScreen.tsx';
import FloatingPromptBar from '$lib/components/terminal/FloatingPromptBar.tsx';
import ToolsMenu, { type ToolMenuGroup } from '$lib/components/layout/ToolsMenu.tsx';
import {
  getSplitPaneStyle,
  getSplitStageStyle,
  resolvePreset,
  splitColumnCount,
  splitPaneSpansRow,
  splitUsesTwoRows,
  type SplitPresetId,
} from '$lib/components/layout/split-layout';
import SplitLayoutPicker from '$lib/components/layout/SplitLayoutPicker.tsx';

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
import MobilePanel from '$lib/components/mobile/MobilePanelLazy.tsx';
import { useShallow } from 'zustand/react/shallow';
import {
  useLayoutStore,
  rightDrawerToolOf,
  clampRightDrawerWidth,
  RIGHT_DRAWER_MAX_WIDTH,
} from '$lib/stores/zustand/layout';
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
  toggleFleetVisible,
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
import { toggleCommandPalette, registerCommand } from '$lib/stores/commandpalette';
import { showToast } from '$lib/stores/notification';
import { saveActiveFile, formatActiveFile } from '$lib/stores/editor';
import { startProxy, stopProxy } from '$lib/stores/preview';
import { useSettingsStore } from '$lib/stores/zustand/settings';
import { matchShortcut } from '$lib/stores/settings';
import { toggleFloatingSearch } from '$lib/stores/projectsearch';
import {
  claimStartupShell,
  releaseStartupShellClaim,
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
  devSessions as devTerminalSessions,
  allProjectSessions,
  commandHistory,
} from '$lib/stores/terminal';
import { toggleTerminalTranscription } from '$lib/services/transcription-hotkey';
import TranscriptionIndicator from '$lib/components/terminal/TranscriptionIndicator.tsx';

import { useUpdaterStore } from '$lib/stores/zustand/updater';
import { clampHorizontalScroll } from '$lib/actions/clampHorizontalScroll';
import ConfirmDialog from '$lib/components/shared/ConfirmDialog.tsx';
import type { ActiveView, LayoutState, SettingsTab, SidebarTab } from '$lib/types/layout';
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
  | 'fleet'
  | 'db'
  | 'containers'
  | 'toolbox'
  | 'youtube'
  | 'env'
  | 'mobile'
  | 'sketch';

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
  fleet: 'Fleet',
  db: 'Database',
  containers: 'Containers',
  toolbox: 'Toolbox',
  youtube: 'Media Player',
  env: 'Environment',
  mobile: 'Mobile',
  sketch: 'Sketch',
};

function isAgentRoomId(id: RoomId): id is AgentRoomId {
  return id.startsWith('agent:');
}

/**
 * Narrow an arbitrary string to a `RoomId`. Restored arrangements come back from
 * localStorage, so the ids in them are untrusted and may also name a room this
 * build no longer has.
 *
 * A room that is valid but not currently open needs no filtering here — both
 * `splitRooms` and `activeRoom` already resolve against the open set, and the
 * effect that prunes closed rooms drops it on the next pass.
 */
function isKnownRoomId(id: string | null | undefined): id is RoomId {
  if (!id) return false;
  if (/^agent:\d{1,10}$/.test(id)) return true;
  return Object.prototype.hasOwnProperty.call(ROOM_TITLES, id);
}

// How many rooms Split will tile at once. Extra rooms stay open and reachable
// from the switcher, just not on stage. 12 rather than a smaller number because
// Split absorbed the Fleet grid, which had no cap — it wrapped and scrolled —
// so a hard ceiling here would be a regression for anyone running ten agents.
const SPLIT_MAX_PANES = 12;

// Up to this many panes are tiled to *fit* the viewport: exact column counts, no
// scrolling, every pane on screen. Past it the grid switches to a wrapping
// min-width track and scrolls vertically (what Fleet did), because forcing a
// dozen panes into one screen leaves each too short to read. The two regimes are
// different jobs — working in a few panes, versus watching many.
const SPLIT_FIT_PANES = 6;

function getAgentRoomSessionId(id: AgentRoomId): number {
  return Number(id.slice('agent:'.length));
}

// Rooms whose live body must persist across focus switches: the personal
// terminal, the dev terminal, every running agent, and the preview browser.
// They're kept mounted in the stage and toggled by visibility rather than
// unmounted. For the terminals that protects the xterm's fit; for the preview
// it protects the iframes — unmounting threw away the loaded page, so every
// visit to another room and back reloaded whatever the user was looking at
// (and dropped any unsaved state inside it).
function isPersistentRoomId(id: RoomId): boolean {
  return id === 'terminal' || id === 'dev-terminal' || id === 'preview' || isAgentRoomId(id);
}

// The layout fields AppShell reads. Kept as one named union so both the
// selector-narrowed subscription and PANEL_VISIBILITY_KEYS stay in lockstep —
// if a field is added to one and not the other, the index at the read site fails
// to typecheck instead of silently widening the subscription.
// `agentSpawnOpen`/`envManagerOpen` live on the store's actions (not LayoutState),
// so they're named here too.
type ShellLayoutKeys =
  | 'sidebarVisible'
  | 'sidebarWidth'
  | 'sidebarTab'
  | 'activeView'
  | 'lastAuxView'
  | 'editorVisible'
  | 'editorSplitPreview'
  | 'previewVisible'
  | 'reviewVisible'
  | 'httpVisible'
  | 'tasksVisible'
  | 'fleetVisible'
  | 'dbVisible'
  | 'containersVisible'
  | 'toolboxVisible'
  | 'envVisible'
  | 'youtubeVisible'
  | 'mobileVisible'
  | 'sketchVisible'
  | 'agentSpawnOpen'
  | 'envManagerOpen'
  | 'auxPanelWidth'
  | 'auxEditorHeight'
  | 'leftPanelWidth'
  | 'rightDrawerWidth';

type ShellLayoutState = Pick<LayoutState, Exclude<ShellLayoutKeys, 'agentSpawnOpen' | 'envManagerOpen'>> & {
  agentSpawnOpen: boolean;
  envManagerOpen: boolean;
};

const PANEL_VISIBILITY_KEYS: Record<AuxPanelId, keyof ShellLayoutState> = {
  editor: 'editorVisible',
  preview: 'previewVisible',
  review: 'reviewVisible',
  http: 'httpVisible',
  tasks: 'tasksVisible',
  fleet: 'fleetVisible',
  db: 'dbVisible',
  containers: 'containersVisible',
  toolbox: 'toolboxVisible',
  youtube: 'youtubeVisible',
  env: 'envVisible',
  mobile: 'mobileVisible',
  sketch: 'sketchVisible',
};



const EditorPanel = lazy(() => import('$lib/components/editor/EditorPanel.tsx'));
const FleetDashboard = lazy(() => import('$lib/components/orchestrator/FleetDashboard.tsx'));
const EnvManager = lazy(() => import('$lib/components/shared/EnvManager.tsx'));
// Code-split: the sketch canvas is a large, self-contained surface, so it
// should not sit in the shell's initial bundle.
const SketchPanel = lazy(() => import('$lib/components/sketch/SketchPanel.tsx'));

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
  fleet: {
    title: 'Agent Fleet',
    icon: <Icon><path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2" /><circle cx="9" cy="7" r="4" /><path d="M22 21v-2a4 4 0 0 0-3-3.87" /><path d="M16 3.13a4 4 0 0 1 0 7.75" /></Icon>,
  },
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
  mobile: {
    title: 'Mobile Emulator',
    icon: <Icon><rect x="6" y="2" width="12" height="20" rx="2.5" /><path d="M10.5 18.5h3" /></Icon>,
  },
};

// Tools hosted in the LEFT utility drawer — the sidebar-content tabs, backed by
// `sidebarTab`. Order = tab-strip / dock order.
const LEFT_DRAWER_TOOLS = ['projects', 'files', 'git', 'problems', 'snapshots', 'snippets'] as const;
type LeftDrawerTool = (typeof LEFT_DRAWER_TOOLS)[number];
const LEFT_TOOL_META: Record<LeftDrawerTool, { title: string; icon: React.ReactNode }> = {
  projects: { title: 'Projects', icon: <Icon><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z" /></Icon> },
  files: { title: 'Files', icon: <Icon><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" /><polyline points="14 2 14 8 20 8" /><line x1="16" y1="13" x2="8" y2="13" /><line x1="16" y1="17" x2="8" y2="17" /><line x1="10" y1="9" x2="8" y2="9" /></Icon> },
  git: { title: 'Source Control', icon: <Icon><circle cx="18" cy="18" r="3" /><circle cx="6" cy="6" r="3" /><circle cx="6" cy="18" r="3" /><path d="M18 15V9a4 4 0 0 0-4-4H9" /><line x1="6" y1="9" x2="6" y2="15" /></Icon> },
  snapshots: { title: 'Workspace Snapshots', icon: <Icon><rect x="2" y="3" width="20" height="14" rx="2" /><path d="M8 21h8M12 17v4" /><circle cx="12" cy="10" r="3" /></Icon> },
  snippets: { title: 'Shell Snippets', icon: <Icon><path d="M4 17l6-6-6-6M12 19h8" /></Icon> },
  problems: { title: 'Problems', icon: <Icon><circle cx="12" cy="12" r="9" /><line x1="12" y1="8" x2="12" y2="13" /><line x1="12" y1="16.5" x2="12.01" y2="16.5" /></Icon> },
  // No `review` here — Code Review is a center room, reachable from the room
  // dock. Source Control's inline HunkDiffView covers the drawer-sized case.
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

function PanelHost({ id, onClose }: { id: AuxPanelId; onClose?: () => void }) {
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
  if (id === 'fleet') {
    return (
      <Suspense fallback={null}>
        <FleetDashboard />
      </Suspense>
    );
  }
  if (id === 'preview') return <PreviewPanel />;
  if (id === 'youtube') return <YouTubePanel />;
  if (id === 'mobile') return <MobilePanel />;
  if (id === 'sketch') {
    return (
      <Suspense fallback={null}>
        <SketchPanel onClose={onClose} />
      </Suspense>
    );
  }
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
  if (tab === 'projects') return <ProjectHUD />;
  if (tab === 'search') return <SearchPanel />;
  if (tab === 'git') return <SourceControl />;
  if (tab === 'snapshots') return <SnapshotsPanel />;
  if (tab === 'snippets') return <TerminalSnippetsPanel />;

  if (tab === 'problems') return <ProblemsPanel />;
  return <FileExplorer />;
}

import { useGlobalTooltips } from '$lib/react/useGlobalTooltips.ts';

export default function AppShell() {
  useGlobalTooltips();

  function withTransition(action: () => void) {
    const startViewTransition = (document as Document & {
      startViewTransition?: (callback: () => void) => {
        finished?: Promise<unknown>;
        updateCallbackDone?: Promise<unknown>;
      };
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
        // Resolves once the DOM update callback above has actually run. Callers
        // that need to measure the NEW layout must wait for this: the callback is
        // invoked asynchronously (the browser snapshots the old frame first), so
        // anything scheduled straight after `startViewTransition` returns still
        // sees the OLD DOM.
        return transition.updateCallbackDone ?? Promise.resolve();
      } catch (e) {
        (window as any).__spacron_transitioning = false;
        action();
      }
    } else {
      action();
    }
    return Promise.resolve();
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
    // Wait for the view transition's update callback before measuring. Firing
    // `notifyPanesResized` synchronously here raced the DOM update and the double
    // rAF regularly landed on the OLD layout, so the panes refit to the size they
    // were leaving and then held stale, wrongly-fitted pixels until something
    // else happened to resize them.
    void withTransition(action).then(notifyPanesResized);
  }

  /**
   * Retiling the Split stage — adding, removing or reordering a pane.
   *
   * Deliberately does NOT use the View Transition API, unlike `withRoomTransition`.
   * A retile changes every pane's cell at once, and a view transition freezes a
   * bitmap of the OLD tiling and stretches it into each NEW cell while it
   * cross-fades. That stretched ghost of the previous arrangement, sitting over
   * panels that have already moved, is the "residue of the panels" — it is the
   * same failure `switchAmbientLayout` documents below and already avoids for
   * mode switches; the per-pane paths just never got the same treatment.
   *
   * Update straight away instead and refit the terminals once the new grid is
   * laid out. Note this intentionally does not raise `.layout-switching`: that
   * would replay the panel entrance and block input for 360 ms every time you
   * nudge a pane, which is its own kind of "not working".
   */
  function withStageRetile(action: () => void) {
    action();
    notifyPanesResized();
  }

  // Selector-narrowed subscription: return only the layout fields this shell
  // actually reads, and compare shallowly so unrelated layout changes (a
  // transient flag elsewhere in the store) don't re-render this entire shell
  // and every mounted room frame. Widths are included — resizing a divider
  // changes them and must re-render, but nothing else does.
  const layoutState = useLayoutStore(
    useShallow(
      (s): ShellLayoutState => ({
        sidebarVisible: s.sidebarVisible,
        sidebarWidth: s.sidebarWidth,
        sidebarTab: s.sidebarTab,
        activeView: s.activeView,
        lastAuxView: s.lastAuxView,
        editorVisible: s.editorVisible,
        editorSplitPreview: s.editorSplitPreview,
        previewVisible: s.previewVisible,
        reviewVisible: s.reviewVisible,
        httpVisible: s.httpVisible,
        tasksVisible: s.tasksVisible,
        fleetVisible: s.fleetVisible,
        dbVisible: s.dbVisible,
        containersVisible: s.containersVisible,
        toolboxVisible: s.toolboxVisible,
        envVisible: s.envVisible,
        youtubeVisible: s.youtubeVisible,
        mobileVisible: s.mobileVisible,
        sketchVisible: s.sketchVisible,
        agentSpawnOpen: s.agentSpawnOpen,
        envManagerOpen: s.envManagerOpen,
        auxPanelWidth: s.auxPanelWidth,
        auxEditorHeight: s.auxEditorHeight,
        leftPanelWidth: s.leftPanelWidth,
        rightDrawerWidth: s.rightDrawerWidth,
      }),
    ),
  );
  const workspaceId = useWorkspaceStore((s) => s.activeWorkspaceId);
  // Home is an overlay on top of the still-mounted workspace (see
  // `homeScreenOpen`). With no workspace open at all there is nothing behind it,
  // so it is the only thing rendered.
  const homeOpen = useStore(homeScreenOpen);
  const showWelcome = !workspaceId || homeOpen;
  const project = useWorkspaceStore((s) => (s.activeProjectId ? s.projects.get(s.activeProjectId) ?? null : null));
  const projectSwitching = useWorkspaceStore((s) => s.isProjectSwitching);
  const switchingPhase = useWorkspaceStore((s) => s.switchingPhase);
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
  /** Terminal-room close awaiting confirmation, because it will kill live shells. */
  const [pendingTerminalClose, setPendingTerminalClose] = useState<
    { room: 'terminal' | 'dev-terminal'; count: number } | null
  >(null);
  const [auxResizing, setAuxResizing] = useState(false);
  const [auxRowResizing, setAuxRowResizing] = useState(false);
  const [auxPanelWidth, setAuxPanelWidth] = useState(layoutState.auxPanelWidth);
  const [auxEditorHeight, setAuxEditorHeight] = useState(layoutState.auxEditorHeight);
  const [focusedRoom, setFocusedRoom] = useState<RoomId | null>('terminal');
  const [expandedRoom, setExpandedRoom] = useState<RoomId | null>(null);
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
  // Split (gallery) stage, in left→right / wrap order. Empty means "not yet
  // arranged" — `splitRooms` then falls back to the historical two-pane default
  // so entering Split still just works. Once the user arranges the stage this
  // list is authoritative, which is what stops the slot drift documented in
  // `.spacron/memory/split-room-slots.md`.
  const [splitSlots, setSplitSlots] = useState<RoomId[]>([]);
  const [splitPresets, setSplitPresets] = useState<Record<number, SplitPresetId>>({});
  const lastActiveRoomRef = useRef<RoomId | null>(null);
  // The room the user last actually touched — a click or a focus anywhere inside
  // its pane, not just a title-bar "focus this room" press. In Split this is what
  // "the terminal I'm working in" means, and it is the pane a tab click must
  // never evict. `focusedRoom` alone cannot answer this: typing into the right
  // pane never moves it, so it would still be pointing at the left one.
  const lastInteractedRoomRef = useRef<RoomId | null>(null);

  const sidebarResizeRef = useRef({ startX: 0, startWidth: 0 });
  const leftPanelResizeRef = useRef({ startX: 0, startWidth: 0 });
  const rightDrawerResizeRef = useRef({ startX: 0, startWidth: 0, active: false });
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

  // Visibility guarantee for the floating prompt bar (.composer-strip) on
  // WebKitGTK (Linux). Even at opacity:1 it is regularly
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
      el.querySelectorAll<HTMLElement>('.composer-strip').forEach((node) => {
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
  const allDevTerminalSessions = useStore(devTerminalSessions);
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
        { id: 'sketch' as const, visible: layoutState.sketchVisible },
        // Right utility drawer: fleet/toolbox/http/db/containers/env/mobile +
        // orchestrator. Left drawer: the nav tabs. YouTube: free-floating
        // pop-up. None of those are rooms in the ambient grid.
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

  // The rooms Split tiles, in slot order. `activeRoom` is always on stage (it is
  // what Focus would show, and what the room dock highlights), so it is spliced
  // in at the front when an arrangement doesn't already include it.
  const splitRooms = useMemo<RoomId[]>(() => {
    if (!activeRoom) return [];
    const arranged = splitSlots.filter(
      (room, index) => visibleRooms.includes(room) && splitSlots.indexOf(room) === index,
    );
    if (arranged.length === 0) {
      // Unarranged: today's default — the active room plus the next one open.
      return [activeRoom, ...sideRooms.slice(0, 1)];
    }
    const withActive = arranged.includes(activeRoom) ? arranged : [activeRoom, ...arranged];
    return withActive.slice(0, SPLIT_MAX_PANES);
  }, [activeRoom, sideRooms, splitSlots, visibleRooms]);

  /**
   * The pane that is actually zoomed to the full stage, or null.
   *
   * Same test four render paths were each spelling out for themselves — the
   * stage, the switcher, the prompt-bar Split button and the pane header. They
   * agreed, but nothing made them agree, and every new read of `expandedRoom`
   * was a chance to check it without the "is that room still on stage?" half.
   */
  const stageExpandedRoom =
    expandedRoom !== null && visibleRooms.includes(expandedRoom) ? expandedRoom : null;

  /**
   * Every "zoom this pane / go back to the grid" path.
   *
   * Goes through `withStageRetile` for the same reason adding or removing a pane
   * does: expanding hides every other pane and stretches this one across the
   * whole stage, which is the largest geometry change the stage can make. The
   * bare `setExpandedRoom` this replaces left it to each xterm's debounced
   * ResizeObserver, and per the atlas note in TerminalPane's `onResizeEnd` that
   * fit re-renders straight from a stale glyph atlas — so expanding a terminal
   * and dropping it back into the grid painted garbled leftovers of the size it
   * used to be until something else happened to resize it.
   */
  function setStageExpansion(next: RoomId | null) {
    withStageRetile(() => setExpandedRoom(next));
  }

  // What the stage looked like before "Tile all agents" took it over, so a
  // second press puts it back instead of stranding the user in a tiling they
  // never arranged. A ref, not state: nothing renders from it, and writing it
  // on the way into the arrangement must not re-render the room subtree.
  const preFleetLayoutRef = useRef<{
    ambient: AmbientLayout;
    slots: RoomId[];
    focused: RoomId | null;
    // The right drawer is part of the arrangement now — tiling the agents opens
    // Agent Fleet beside them, so untiling has to put back whatever was there.
    drawer: RightTool | null;
  } | null>(null);

  // Whether the Split stage is currently exactly "every running agent" — what
  // the old Fleet layout showed. Drives the dock button's lit state now that
  // Fleet is an arrangement rather than a mode of its own.
  const fleetArrangementActive = useMemo(() => {
    if (ambientLayout !== 'gallery') return false;
    const agents = visibleRooms.filter(isAgentRoomId);
    return (
      agents.length > 0 &&
      agents.length === splitRooms.length &&
      splitRooms.every(isAgentRoomId)
    );
  }, [ambientLayout, splitRooms, visibleRooms]);

  // WebKitGTK (Linux) leaves stale compositor pixels — a "ghost" of the closed
  // room — behind when a room/panel closes and the grid re-tiles to fill the gap.
  // When a room is actually removed, force a genuine repaint of the rooms container
  // so those stale pixels are overwritten. A sub-1 opacity for a single frame forces
  // WebKitGTK to re-composite the subtree; it's visually imperceptible (≈1, no
  // movement) and leaves layout size unchanged, so the terminal panes never refit.
  // Linux-only; Windows/macOS repaint correctly on their own.
  const prevVisibleRoomsRef = useRef<RoomId[]>([]);
  useEffect(() => {
    if (expandedRoom && !visibleRooms.includes(expandedRoom)) {
      setExpandedRoom(null);
    }
  }, [expandedRoom, visibleRooms]);

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

    if (layoutCommand.type === 'arrangement') {
      restoreRoomArrangement(
        layoutCommand.mode,
        layoutCommand.slots.filter(isKnownRoomId),
        isKnownRoomId(layoutCommand.focused) ? layoutCommand.focused : null,
        isKnownRoomId(layoutCommand.expanded) ? layoutCommand.expanded : null,
        layoutCommand.presets,
        layoutCommand.minimized?.filter(isKnownRoomId),
        layoutCommand.roomOrder?.filter(isKnownRoomId),
        layoutCommand.devTerminalOpen ?? false,
      );
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
        // In gallery (split) mode with other rooms visible, append the preview
        // rather than focusing it, so it lands in a trailing pane and leaves the
        // rooms already on stage where they are — "agent on the left, preview on
        // the right".
        if (room === 'preview' && ambientLayout === 'gallery') {
          const otherRooms = visibleRooms.filter((r) => r !== 'preview');
          if (otherRooms.length > 0) {
            addRoomToSplit('preview');
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
      // The raw slot list, not the derived `splitRooms`: empty means the user
      // has not arranged the stage, and saving what happens to be tiled right
      // now would pin that accident as a deliberate arrangement.
      splitSlots,
      expandedRoom,
      splitPresets,
      minimizedRooms: Array.from(minimizedRooms),
      roomOrder,
      devTerminalOpen: devTerminalRoomOpen,
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ambientLayout, openRooms, activeRoom, minimizedRooms, allTerminalSessions, splitSlots, expandedRoom, splitPresets, roomOrder, devTerminalRoomOpen]);

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

  // Home layers OVER the still-mounted workspace and hides it with `visibility`,
  // so closing it puts every pane back on screen without changing a single box —
  // no ResizeObserver fires, and nothing else in the layout effects below is
  // keyed on it. Panes skip their glyph-atlas flush while off screen (see
  // TerminalPane's visibilitychange handler), so this is the signal that repaints
  // them on the way back.
  useEffect(() => {
    if (homeOpen || !workspaceId) return;
    const t = window.setTimeout(() => notifyPanesResized(), 0);
    return () => window.clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [homeOpen]);

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

    // Drop closed rooms from the Split arrangement. Falling to empty is fine —
    // that is the "unarranged" sentinel and `splitRooms` re-derives the default.
    setSplitSlots((current) => {
      const next = current.filter((room) => openRooms.includes(room));
      return next.length === current.length ? current : next;
    });
  }, [ambientLayout, focusedRoom, openRooms]);

  // Backstop for the paths that make the editor visible without going through
  // `setActiveView('editor')` (a restored project layout, `toggleEditorVisible`).
  // The common "open this file" route now asks the room system directly, from
  // `setActiveView` — see the note there.
  //
  // Must be `focusRoom`, not a bare `setFocusedRoom`: a minimized editor is not
  // in `visibleRooms`, so `activeRoom` falls straight back to `visibleRooms[0]`
  // and the assignment is inert — while leaving `focusedRoom` pinned to a room
  // that never reaches the stage, which wedges every later attempt too.
  // `focusRoom` un-minimizes first, and routes through `claimSplitSlot` so this
  // cannot evict the pane being worked in (`.spacron/memory/split-room-slots.md`).
  useEffect(() => {
    if (layoutState.editorVisible && activeFile) {
      focusRoom('editor');
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
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
      setSidebarResizing(false);
      setLeftPanelResizing(false);
      setAuxResizing(false);
      setAuxRowResizing(false);
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
      if (wasAuxResize) {
        useLayoutStore.setState({ auxPanelWidth, auxEditorHeight });
      }
    }

    window.addEventListener('mousemove', handleMouseMove);
    window.addEventListener('mouseup', handleMouseUp);
    return () => {
      window.removeEventListener('mousemove', handleMouseMove);
      window.removeEventListener('mouseup', handleMouseUp);
    };
  }, [auxEditorHeight, auxPanelWidth, auxResizing, auxRowResizing, sidebarResizing, leftPanelResizing, windowWidth, zoom]);

  useEffect(() => {
    function handleKeyDown(event: KeyboardEvent) {
      // A modal dialog is open — its keys are the modal's, not the app's. A
      // shortcut firing behind Settings (e.g. Ctrl+` while choosing a shell)
      // is a real reported bug; the modal hook registers itself in the shared
      // counter so every global handler can stand down at once.
      if (isModalOpen()) return;
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
          // setActiveView already asks the room system to focus the editor —
          // a bare setFocusedRoom on top of it would skip claimSplitSlot.
          setActiveView('editor');
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
        case 'goToFleet':
          toggleFleetVisible();
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
          // Two reachable arrangements now that Fleet is an action rather than a
          // mode: Focus ↔ Split.
          switchAmbientLayout(ambientLayout === 'focus' ? 'gallery' : 'focus');
          break;
        }
      }
    }

    /**
     * The transcription hotkey gets its own CAPTURE-phase listener.
     *
     * `handleKeyDown` below runs in the bubble phase, which is too late when a
     * terminal has focus: xterm sees the key first and forwards anything it
     * doesn't claim straight to the shell, so the dictation key would also be
     * typed into whatever is running. Capturing at the window means we see it
     * before xterm and can stop it there — the whole point of a dictation key
     * is that it works from anywhere in the app, terminals included.
     *
     * Only this one action is handled here; everything else keeps the bubble
     * path so panes can still claim their own keys first.
     *
     * It also deliberately does NOT stand down for `isModalOpen()`. Every other
     * shortcut should: a dialog owns its keys. But dictation is an input method,
     * not navigation, and the modals ARE text-entry surfaces — Quick Capture,
     * Task Editor, Clone Repo, New Folder, Workspace Name, Agent Spawn,
     * Settings. Gating on the modal counter made the key dead in exactly the
     * places you most want to dictate into, leaving the terminal as the only
     * thing that ever worked.
     */
    function handleTranscriptionKeyDown(event: KeyboardEvent) {
      // A held key repeats. Without this, holding the hotkey for a moment fires
      // keydown over and over and every repeat reads as another tap — start,
      // send, start, send — which is how a single deliberate press ended up
      // delivering nothing.
      if (event.repeat) return;
      const binding = (shortcuts || []).find((shortcut) => {
        if (!shortcut) return false;
        const actionId = shortcut.id.startsWith('custom_') ? shortcut.action : shortcut.id;
        return actionId === 'transcribeToTerminal';
      });
      if (!binding || !matchShortcut(event, binding.keys)) return;
      event.preventDefault();
      event.stopPropagation();
      toggleTerminalTranscription();
    }

    window.addEventListener('keydown', handleTranscriptionKeyDown, true);
    window.addEventListener('keydown', handleKeyDown);
    return () => {
      window.removeEventListener('keydown', handleTranscriptionKeyDown, true);
      window.removeEventListener('keydown', handleKeyDown);
    };
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

  // The right drawer's resize runs on POINTER events with pointer capture, not
  // on the shared window mouse handlers the other panels use. The width is only
  // written back to storage when the drag ends, and a `mouseup` released outside
  // the Tauri window never arrives — so the drawer would look resized for the
  // rest of the session and open at the old width next time. Capture guarantees
  // both the moves and the release land on the handle, wherever the pointer is.
  // The live flag is a ref, not the `rightDrawerResizing` state, so a move that
  // arrives before React re-renders is not dropped; the state only drives the
  // `.resizing` class.
  function startRightDrawerResize(event: React.PointerEvent<HTMLDivElement>) {
    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    setRightDrawerResizing(true);
    rightDrawerResizeRef.current = {
      startX: event.clientX,
      startWidth: layoutState.rightDrawerWidth,
      active: true,
    };
    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';
  }

  function moveRightDrawerResize(event: React.PointerEvent<HTMLDivElement>) {
    if (!rightDrawerResizeRef.current.active) return;
    const scale = zoom / 100;
    // Drawer is anchored to the right edge, so dragging its left handle
    // leftwards (negative deltaX) widens it.
    const delta = (rightDrawerResizeRef.current.startX - event.clientX) / scale;
    const maxAllowedWidth = Math.min(RIGHT_DRAWER_MAX_WIDTH, windowWidth / scale - 250 - 48);
    useLayoutStore.setState({
      rightDrawerWidth: clampRightDrawerWidth(
        Math.min(maxAllowedWidth, rightDrawerResizeRef.current.startWidth + delta),
      ),
    });
  }

  function endRightDrawerResize() {
    if (!rightDrawerResizeRef.current.active) return;
    rightDrawerResizeRef.current.active = false;
    setRightDrawerResizing(false);
    document.body.style.cursor = '';
    document.body.style.userSelect = '';
    // Persist the final width — the live drag wrote straight to the store, which
    // does not touch storage. This is the only place the new width is saved.
    useLayoutStore.getState().setRightDrawerWidth(useLayoutStore.getState().rightDrawerWidth);
  }

  // --- LEFT utility drawer (workspace navigation) -------------------------
  // Sidebar-content tabs only. Open == sidebarVisible; switching tabs only swaps
  // the body (the frame stays mounted), so there's no close/reopen glitch.
  const leftDrawerOpen = layoutState.sidebarVisible;
  const leftActiveTool: LeftDrawerTool | null =
    layoutState.sidebarVisible && (LEFT_DRAWER_TOOLS as readonly string[]).includes(layoutState.sidebarTab)
      ? (layoutState.sidebarTab as LeftDrawerTool)
      : null;
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
  const rightActiveTool: RightTool | null = rightDrawerToolOf(layoutState);
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
          onPointerDown={startRightDrawerResize}
          onPointerMove={moveRightDrawerResize}
          onPointerUp={endRightDrawerResize}
          onPointerCancel={endRightDrawerResize}
          onLostPointerCapture={endRightDrawerResize}
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
          <PanelHost id={rightActiveTool} onClose={() => closeRoom(rightActiveTool)} />
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
    // Same rule as `focusRoom`: opening a panel that takes a new Split slot
    // re-tiles the stage, so it must not go through a view transition.
    const run = open && willRetileSplit(id) ? withStageRetile : withRoomTransition;
    run(() => {
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
        // Same Split rule as a tab click: opening a panel must not evict the
        // pane you are working in.
        if (claimSplitSlot(id)) setFocusedRoom(id);
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

  /**
   * Whether bringing `id` on stage will re-tile Split — i.e. it is about to take
   * a new slot rather than just take focus. Mirrors `claimSplitSlot`'s own guard;
   * keep the two in step.
   *
   * This is the difference between a change that moves every pane's box and one
   * that moves nothing, and it decides which wrapper a caller uses. A retile must
   * skip the View Transition API (see `withStageRetile`) — that is the case where
   * a frozen bitmap of the old tiling gets stretched over the new one.
   */
  function willRetileSplit(id: RoomId): boolean {
    return (
      ambientLayout === 'gallery' &&
      Boolean(activeRoom) &&
      id !== activeRoom &&
      !splitRooms.includes(id)
    );
  }

  function focusRoom(id: RoomId) {
    // In Split, never a view transition — for either of the two things this can
    // do there:
    //
    //   • it takes a new slot, and every existing pane shrinks to make room. A
    //     freshly spawned agent lands here, which is why opening an agent panel
    //     used to ghost — the transition painted the previous tiling over the
    //     result while the terminals were still fitted to their old boxes.
    //   • the room is already tiled, and *nothing on the stage moves at all*.
    //     Every pane is on screen either way; the only thing that changes is
    //     which pill in the rail reads "primary". Snapshotting the whole
    //     document and cross-fading it against a near-identical copy for that
    //     is what made clicking a pane's pill flash — the frosted surfaces and
    //     the live terminals do not survive the round trip cleanly, so a change
    //     the user cannot see arrives as a flash they can.
    //
    // Focus mode is the only place where this genuinely swaps what the stage
    // shows, so it is the only place that still transitions.
    const run = ambientLayout === 'gallery' ? withStageRetile : withRoomTransition;
    run(() => {
      setMinimizedRooms((current) => {
        const next = new Set(current);
        next.delete(id);
        return next;
      });
      if (id === 'terminal') setTerminalRoomOpen(true);
      if (id === 'dev-terminal') setDevTerminalRoomOpen(true);
      // While a pane is zoomed the stage shows exactly one room, so focusing a
      // different one used to change nothing you could see: the switcher pill
      // moved, a spawning agent took a slot, the orchestrator's "show me the
      // terminal" landed — and the stage kept the pane that was already there.
      // Carry the zoom to whatever just took focus instead; the way back to the
      // grid is the restore button, not a room that silently refuses to appear.
      if (stageExpandedRoom !== null && stageExpandedRoom !== id) setExpandedRoom(id);
      if (claimSplitSlot(id)) setFocusedRoom(id);
    });
  }

  /**
   * Split-mode guard for every "bring this room on stage" path.
   *
   * Appends the incoming room to the stage rather than swapping it for one
   * that is already there. Returns whether the caller should still take room
   * focus — `false` means the pane the user is working in kept it on purpose,
   * so their typing target doesn't jump to the room that just appeared.
   *
   * Why appending matters: Split used to hold exactly two rooms, one of which
   * (`splitRoom`) was *derived* and moved the moment the primary changed, so
   * bringing a third room on stage replaced both panes at once and the terminal
   * you were typing in vanished. With N slots nothing is displaced below the
   * cap, so that drift cannot happen. At the cap the oldest slot gives way —
   * never the active room, and never the one being worked in.
   *
   * A no-op outside Split, and for a room that is already on stage.
   */
  function claimSplitSlot(id: RoomId): boolean {
    if (ambientLayout !== 'gallery') return true;
    if (!activeRoom || id === activeRoom || splitRooms.includes(id)) return true;

    const working = lastInteractedRoomRef.current;
    setSplitSlots(() => {
      const next = [...splitRooms, id];
      if (next.length <= SPLIT_MAX_PANES) return next;
      // Full: evict the earliest slot that is neither the active room nor the
      // pane being worked in, so the incoming room always finds space.
      const victim = next.find((room) => room !== activeRoom && room !== working && room !== id);
      return victim ? next.filter((room) => room !== victim) : next.slice(0, SPLIT_MAX_PANES);
    });

    // Keep focus on the pane the user is actually in, if it's one on stage.
    return !(working && working !== id && splitRooms.includes(working));
  }

  // Bring a room on stage without disturbing what is already there — the
  // switcher's "show this too" path. Outside Split it behaves as a plain focus.
  function addRoomToSplit(id: RoomId) {
    withStageRetile(() => {
      // "Show this too" is a request to see two panes, so it takes the stage
      // out of zoom. Without this the room joined the tiling underneath a pane
      // still filling the stage, and the button read as broken.
      setExpandedRoom(null);
      setMinimizedRooms((current) => {
        const next = new Set(current);
        next.delete(id);
        return next;
      });
      if (id === 'terminal') setTerminalRoomOpen(true);
      if (id === 'dev-terminal') setDevTerminalRoomOpen(true);
      if (ambientLayout !== 'gallery') {
        setFocusedRoom(id);
        return;
      }
      if (splitRooms.includes(id)) {
        setFocusedRoom(id);
        return;
      }
      setSplitSlots(() => [...splitRooms, id].slice(0, SPLIT_MAX_PANES));
    });
  }

  // Take a room off the Split stage. It stays open and reachable — only its
  // slot goes away. Removing the active room hands focus to a remaining pane so
  // `splitRooms` doesn't just splice it straight back in at the front.
  function removeRoomFromSplit(id: RoomId) {
    if (splitRooms.length <= 1) return;
    withStageRetile(() => {
      const remaining = splitRooms.filter((room) => room !== id);
      setSplitSlots(remaining);
      if (id === activeRoom) setFocusedRoom(remaining[0] ?? null);
    });
  }

  /**
   * Dock button: gather every running agent onto the stage, and put things back
   * on the second press.
   *
   * Only the button toggles. `switchAmbientLayout('vibe')` stays one-way,
   * because the orchestrator and restored workspace layouts also send it — a
   * command meaning "show me all agents" must not mean "hide them" on the next
   * call.
   */
  function toggleFleetArrangement() {
    if (!fleetArrangementActive) {
      preFleetLayoutRef.current = {
        ambient: ambientLayout,
        slots: splitSlots,
        focused: focusedRoom,
        drawer: rightActiveTool,
      };
      switchAmbientLayout('vibe');
      return;
    }

    const prev = preFleetLayoutRef.current;
    preFleetLayoutRef.current = null;
    // Agent Fleet came up with the tiling, so it goes away with it — unless the
    // user had it open beforehand, or has since switched the drawer to another
    // tool, in which case leave their choice alone.
    if (rightActiveTool === 'fleet' && prev?.drawer !== 'fleet') {
      useLayoutStore.getState().applyRightDrawerTool(prev?.drawer ?? null);
    }
    // Falls back to `[]` — the unarranged sentinel — when there is nothing to
    // restore (a reload, or the stage happening to already be the agent set).
    withStageRetile(() => setSplitSlots(prev?.slots ?? []));
    if (prev && prev.ambient !== ambientLayout) {
      // Changing mode is enough on its own: switchAmbientLayout restores that
      // mode's own saved focus, which is exactly the room it was showing.
      switchAmbientLayout(prev.ambient);
    } else if (prev?.focused) {
      setFocusedRoom(prev.focused);
    }
  }

  // Dock button: tile one more of the open rooms. Cycles back to the two-pane
  // default once every room is on stage (or the cap is reached), so the button
  // always does something visible rather than dead-ending.
  function addNextRoomToSplit() {
    const next = visibleRooms.find((room) => !splitRooms.includes(room));
    if (!next || splitRooms.length >= SPLIT_MAX_PANES) {
      withStageRetile(() => setSplitSlots([]));
      return;
    }
    addRoomToSplit(next);
  }

  // Shuffle a room one slot earlier / later in the tiling order.
  function moveSplitSlot(id: RoomId, dir: -1 | 1) {
    const from = splitRooms.indexOf(id);
    const to = from + dir;
    if (from < 0 || to < 0 || to >= splitRooms.length) return;
    withStageRetile(() => {
      const next = [...splitRooms];
      [next[from], next[to]] = [next[to], next[from]];
      setSplitSlots(next);
    });
  }



  function minimizeRoom(id: RoomId) {
    withRoomTransition(() => {
      if (expandedRoom === id) {
        setExpandedRoom(null);
      }
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

  // Expand a room to 100% full stage on top of the split grid.
  function focusRoomMode(id: RoomId) {
    if (id === 'terminal') setTerminalRoomOpen(true);
    if (id === 'dev-terminal') setDevTerminalRoomOpen(true);
    setStageExpansion(id);
    setFocusedRoom(id);
  }

  /**
   * The shells a terminal room owns: the room's non-agent sessions that are
   * still running. Agent sessions have rooms of their own, so closing the
   * Terminal must never touch them.
   */
  function liveShellsOf(id: 'terminal' | 'dev-terminal') {
    const list = id === 'dev-terminal' ? allDevTerminalSessions : allTerminalSessions;
    return list.filter((session) => session.isRunning && !isAgentSession(session));
  }

  /**
   * Close a terminal room for real: kill the shells it owns, then hide it.
   *
   * Closing used to only hide the room and leave its shells running, which is
   * the state behind "the Projects panel says a terminal is running but nothing
   * is open" — a live process with no window onto it. An agent room has always
   * closed by killing its session (below); this makes the terminal rooms agree,
   * with a confirmation in front of it because a shell may be holding a build.
   */
  function closeTerminalRoomForReal(id: 'terminal' | 'dev-terminal') {
    for (const session of liveShellsOf(id)) void killSession(session.id);
    // The shells this project's claim was covering are gone, so the next open
    // must be allowed to make one. Without this, closing and reopening inside
    // the 5s claim window would leave both auto-openers declining and the room
    // would come up empty.
    releaseStartupShellClaim(activeProjectIdValue);
    withRoomTransition(() => {
      if (expandedRoom === id) setExpandedRoom(null);
      if (id === 'terminal') setTerminalRoomOpen(false);
      else setDevTerminalRoomOpen(false);
      if (focusedRoom === id) setFocusedRoom(nextVisibleRoom(id));
    });
  }

  function closeRoom(id: RoomId) {
    // Ask before killing live shells. Cancelling leaves the room open rather
    // than hiding it: a hidden room whose processes are still running is the
    // ghost state this whole path exists to remove.
    if (id === 'terminal' || id === 'dev-terminal') {
      const live = liveShellsOf(id);
      if (live.length > 0) {
        setPendingTerminalClose({ room: id, count: live.length });
        return;
      }
    }
    withRoomTransition(() => {
      if (expandedRoom === id) {
        setExpandedRoom(null);
      }
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
        // Auto-create a shell session if the terminal grid is empty. Through the
        // same synchronous claim `TerminalPanel`'s auto-open uses: opening the
        // room mounts that panel, whose effect runs 80ms later and cannot see an
        // in-flight async creation, so without the claim both fire and the room
        // opens with two shells. Only reachable once closing the room kills its
        // shells — before that the grid was never empty on a reopen.
        const pa = get(paneAssignments);
        if (pa.every((id) => id === null) && claimStartupShell(activeProjectIdValue)) {
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
      // Code Review had no launcher here while it was a left-drawer tab — the
      // tab was the way in. When the tab was removed (it became this center
      // room) the only entry point left was the Ctrl+Shift+R shortcut, so the
      // panel existed with no visible way to open it.
      id: 'review',
      title: 'Code Review',
      active: layoutState.reviewVisible,
      onClick: () => togglePanelRoom('review'),
      icon: <Icon><circle cx="18" cy="18" r="3" /><circle cx="6" cy="6" r="3" /><path d="M13 6h3a2 2 0 0 1 2 2v7" /><path d="M11 18H8a2 2 0 0 1-2-2V9" /></Icon>,
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
    // No 'fleet' entry: Agent Fleet is a right-drawer tool now, so its launcher
    // is generated from RIGHT_TOOLS_ALL into the Utilities group below.
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
  ];

  // The Media Player is NOT a room — it is a free-floating pop-up window that
  // collapses to a bar at the bottom-right. Its launcher therefore lives in the
  // Utilities group with the other summoned tools, not in Rooms. Toggling it
  // while it sits collapsed restores it rather than closing it.
  const mediaPlayerItem: ActivityItem = {
    id: 'youtube',
    title: 'Media Player',
    active: layoutState.youtubeVisible,
    onClick: () => toggleYoutubeVisible(),
    icon: <Icon><rect x="2" y="5" width="20" height="14" rx="4" /><path d="m10 9 5 3-5 3z" fill="currentColor" stroke="none" /></Icon>,
  };


  // Stays inline in the prompt bar rather than going into the Tools menu — it
  // is a one-press action, not a panel you toggle.
  const spawnAgentItem: ActivityItem = {
    id: 'spawnAgent',
    title: 'Spawn Agents',
    active: layoutState.agentSpawnOpen,
    onClick: () => {
      if (layoutState.agentSpawnOpen) closeAgentSpawn();
      else openAgentSpawn();
    },
    icon: <Icon><path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2" /><circle cx="9" cy="7" r="4" /><line x1="19" y1="8" x2="19" y2="14" /><line x1="16" y1="11" x2="22" y2="11" /></Icon>,
  };

  // Opens the in-app Sketch room. It used to load excalidraw.com in a Preview
  // browser tab through the embedding proxy; the drawing canvas is native now,
  // so it is an ordinary room launcher like every other entry in this group.
  const sketchItem: ActivityItem = {
    id: 'sketch',
    title: 'Sketch',
    active: layoutState.sketchVisible,
    onClick: () => togglePanelRoom('sketch'),
    icon: <Icon><path d="M12 20h9" /><path d="M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4 9.5-9.5z" /></Icon>,
  };

  // Launcher buttons for the LEFT utility drawer's tools — the Workspace group
  // of the Tools menu. Toggling re-uses the unified left-drawer selection so it
  // never closes/reopens the frame.
  const leftNavDockItems: ActivityItem[] = leftDrawerTools.map((tool) => ({
    id: tool,
    title: LEFT_TOOL_META[tool].title,
    active: leftActiveTool === tool,
    onClick: () => toggleLeftTool(tool),
    icon: LEFT_TOOL_META[tool].icon,
  }));

  // Launcher buttons for the right utility drawer's tools (incl. Orchestrator) —
  // the Utilities group of the Tools menu.
  const drawerToolItems: ActivityItem[] = RIGHT_TOOLS_ALL.map((tool) => ({
    id: tool,
    title: RIGHT_TOOL_META[tool].title,
    active: rightActiveTool === tool,
    onClick: () => toggleRightTool(tool),
    icon: RIGHT_TOOL_META[tool].icon,
  }));
  const drawerToolIds = new Set<string>(RIGHT_DRAWER_TOOLS);
  // The remaining launchers open center rooms; the drawer tools are pulled out
  // into their own group.
  const roomLauncherItems = panelItems.filter((item) => !drawerToolIds.has(item.id));

  // The Tools menu in the prompt bar is now the only launcher — it replaced the
  // `.room-dock` strip that used to sit above the composer. Same items, same
  // order, same lit-when-open state; just folded into one popover.
  const toolMenuGroups: ToolMenuGroup[] = [
    { id: 'workspace', label: 'Workspace', items: leftNavDockItems },
    { id: 'rooms', label: 'Rooms', items: [...roomLauncherItems, sketchItem] },
    { id: 'utilities', label: 'Utilities', items: [...drawerToolItems, mediaPlayerItem] },
  ].filter((group) => group.items.length > 0);

  // Layout actions stay as bare icons next to the Tools menu: they are pressed
  // constantly while arranging panes, so a popover round-trip would cost more
  // than the chrome they take up.
  const isExpanded = stageExpandedRoom !== null;
  const inSplit = ambientLayout === 'gallery';
  const layoutActionItems: ActivityItem[] = [
    spawnAgentItem,
    {
      id: 'split',
      title: isExpanded
        ? 'Restore split grid'
        : inSplit
          ? 'Split: add a pane'
          : 'Split: tile panels',
      active: inSplit && !isExpanded,
      onClick: () => {
        // Three states, and the button has to tell them apart. It used to
        // conflate the last two: it only ever edited `splitSlots`, and Focus
        // renders the active room alone and ignores that list entirely — so
        // pressing Split outside Split re-tiled a stage nobody was looking at
        // and the screen did not move. Entering the mode is what makes it
        // "actually go to split", and it is what the old room dock did before
        // the Tools menu replaced it.
        if (isExpanded) {
          setStageExpansion(null);
        } else if (!inSplit) {
          switchAmbientLayout('gallery');
        } else {
          addNextRoomToSplit();
        }
      },
      icon: <Icon><rect x="3" y="4" width="7.5" height="16" rx="1.3" /><rect x="13.5" y="4" width="7.5" height="16" rx="1.3" /></Icon>,
    },
    {
      id: 'fleet',
      title: fleetArrangementActive
        ? 'Untile agents and go back to your layout'
        : 'Tile all agents',
      active: fleetArrangementActive && !isExpanded,
      onClick: () => {
        if (isExpanded) setStageExpansion(null);
        toggleFleetArrangement();
      },
      icon: <Icon><rect x="3" y="3" width="7" height="7" rx="1" /><rect x="14" y="3" width="7" height="7" rx="1" /><rect x="3" y="14" width="7" height="7" rx="1" /><rect x="14" y="14" width="7" height="7" rx="1" /></Icon>,
    },
  ];

  // Every Tools-menu entry and layout action is also a command-palette command,
  // so the palette can launch anything the menu can. The registered actions
  // delegate through a ref that the first effect below refreshes on *every*
  // render: several of these onClicks read "is it open" from render scope, so
  // invoking a command must always run the closure the current render produced,
  // never one captured at registration time.
  const paletteBridgeRef = useRef<Record<string, () => void>>({});

  useEffect(() => {
    const bridge = paletteBridgeRef.current;
    for (const group of toolMenuGroups) {
      for (const item of group.items) bridge[`tools.${group.id}.${item.id}`] = item.onClick;
    }
    for (const item of layoutActionItems) bridge[`layout.${item.id}`] = item.onClick;
  });

  // Re-register only when an id, title, or category actually changes — these
  // arrays are rebuilt every render, and rewriting the store each time would
  // churn every palette subscriber.
  const paletteSignature = [
    ...toolMenuGroups.flatMap((g) => g.items.map((i) => `${g.id}.${i.id}:${i.title}`)),
    ...layoutActionItems.map((i) => `layout.${i.id}:${i.title}`),
  ].join('|');

  useEffect(() => {
    for (const group of toolMenuGroups) {
      for (const item of group.items) {
        registerCommand({
          id: `tools.${group.id}.${item.id}`,
          name: item.title,
          category: group.label,
          action: () => paletteBridgeRef.current[`tools.${group.id}.${item.id}`]?.(),
        });
      }
    }
    for (const item of layoutActionItems) {
      registerCommand({
        id: `layout.${item.id}`,
        name: item.title,
        category: 'Layout',
        action: () => paletteBridgeRef.current[`layout.${item.id}`]?.(),
      });
    }
    // Settings sections deep-link straight into their tab; no bridge needed —
    // openSettings is a pure store call.
    const settingsSections: { tab: SettingsTab; name: string }[] = [
      { tab: 'general', name: 'Settings: General' },
      { tab: 'appearance', name: 'Settings: Appearance' },
      { tab: 'models', name: 'Settings: AI Models' },
      { tab: 'voice', name: 'Settings: Voice' },
      { tab: 'terminal', name: 'Settings: Terminal' },
      { tab: 'agents', name: 'Settings: Agents' },
      { tab: 'stats', name: 'Settings: Stats' },
      { tab: 'shortcuts', name: 'Settings: Shortcuts' },
      { tab: 'about', name: 'Settings: About' },
    ];
    for (const section of settingsSections) {
      registerCommand({
        id: `settings.${section.tab}`,
        name: section.name,
        category: 'Settings',
        action: () => openSettings(section.tab),
      });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [paletteSignature]);

  function renderAuxPanes() {
    if (visiblePanels.length === 3) {
      return (
        <>
          <div className="aux-pane split-pane-third" style={{ height: '33.3%', minHeight: '10%' }}>
            <PanelHost id={visiblePanels[0].id} onClose={() => closeRoom(visiblePanels[0].id)} />
          </div>
          <div className="aux-separator-line" />
          <div className="aux-pane split-pane-third" style={{ height: '33.3%', minHeight: '10%' }}>
            <PanelHost id={visiblePanels[1].id} onClose={() => closeRoom(visiblePanels[1].id)} />
          </div>
          <div className="aux-separator-line" />
          <div className="aux-pane split-pane-third" style={{ height: '33.4%', minHeight: '10%' }}>
            <PanelHost id={visiblePanels[2].id} onClose={() => closeRoom(visiblePanels[2].id)} />
          </div>
        </>
      );
    }

    if (visiblePanels.length === 2) {
      return (
        <>
          <div className="aux-pane split-pane-top" style={{ height: `${auxEditorHeight}%`, minHeight: '10%' }}>
            <PanelHost id={visiblePanels[0].id} onClose={() => closeRoom(visiblePanels[0].id)} />
          </div>
          <div
            className={`aux-row-resize-handle${auxRowResizing ? ' resizing' : ''}`}
            onMouseDown={startAuxRowResize}
            role="separator"
            aria-label="Resize panels"
          />
          <div className="aux-pane split-pane-bottom" style={{ height: `${100 - auxEditorHeight}%`, minHeight: '10%' }}>
            <PanelHost id={visiblePanels[1].id} onClose={() => closeRoom(visiblePanels[1].id)} />
          </div>
        </>
      );
    }

    if (visiblePanels.length === 1) {
      return (
        <div className="aux-pane full-pane">
          <PanelHost id={visiblePanels[0].id} onClose={() => closeRoom(visiblePanels[0].id)} />
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
      case 'sketch':
        return <Icon><path d="M12 20h9" /><path d="M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4 9.5-9.5z" /></Icon>;
    case 'toolbox':
      return <Icon><path d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.76 3.76z" /></Icon>;
    case 'fleet':
      return <Icon><path d="M14 2H6.5A1.5 1.5 0 0 0 5 3.5v17A1.5 1.5 0 0 0 6.5 22h11a1.5 1.5 0 0 0 1.5-1.5V7Z" /><path d="M14 2v5h5" /><path d="M12 11.5v4" /><path d="M10 13.5h4" /><path d="M10 18.5h4" /></Icon>;
    case 'mobile':
      return <Icon><rect x="6" y="2" width="12" height="20" rx="2.5" /><path d="M10.5 18.5h3" /></Icon>;
    case 'youtube':
      return <Icon><rect x="2" y="4.5" width="20" height="15" rx="4" /><path d="M10 9.2 15 12l-5 2.8V9.2z" /></Icon>;
    case 'env':
      return <Icon><path d="M12 2 4 6v6c0 5 3.4 8.3 8 10 4.6-1.7 8-5 8-10V6l-8-4z" /><path d="M9.5 12.2l1.8 1.8 3.4-3.6" /></Icon>;
    default:
      return null;
    }
  }

  // Stable per-session callbacks so a memoized TerminalPane can skip re-renders
  // when the shell re-renders for an unrelated reason. One memoized factory per
  // action — the sessionId is captured, so each pane gets a stable identity.
  const onActivateSession = useCallback(
    (sessionId: number) => () => setActiveSession(sessionId),
    [],
  );
  const onCloseSession = useCallback(
    (sessionId: number) => () => {
      void killSession(sessionId);
    },
    [],
  );
  const onFocusRoom = useCallback((id: RoomId) => () => focusRoom(id), []);

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
            onActivate={onActivateSession(sessionId)}
            onClose={onCloseSession(sessionId)}
            onMaximize={onFocusRoom(id)}
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
          {projectSwitching && (
            <div className="project-switch-overlay">
              <div className="project-switch-progress">
                <span className="project-switch-spinner" aria-hidden="true" />
                <span className="project-switch-label">{switchingPhase ?? 'Switching project…'}</span>
              </div>
            </div>
          )}
        </div>
      );
    }
    if (id === 'dev-terminal') {
      return (
        <div className="terminal-room-body dev-terminal">
          <TerminalPanel devMode={true} />
          {projectSwitching && (
            <div className="project-switch-overlay">
              <div className="project-switch-progress">
                <span className="project-switch-spinner" aria-hidden="true" />
                <span className="project-switch-label">{switchingPhase ?? 'Switching project…'}</span>
              </div>
            </div>
          )}
        </div>
      );
    }
    return <PanelHost id={id} onClose={() => closeRoom(id)} />;
  }

  // Rendered as a plain function call (not <RoomFrame/>), so its identity never
  // changes between AppShell re-renders. Defining it as a component and using it
  // as a JSX element remounts the whole room subtree — including the xterm
  // terminal — on every store-driven re-render, which caused the click flicker
  // and terminal churn.
  //
  // `carded` marks a pane that is currently shrunk into a Focus rail card. It is
  // the same live panel, so it must keep rendering — but it stops being reachable:
  // `inert` keeps tab focus (and the terminal's hidden textarea, which would
  // otherwise swallow keystrokes aimed at the stage) out of a 200px-tall card.
  // The overlay button that opens the room is a SIBLING of this section, so it
  // stays clickable.
  function renderRoomFrame(id: RoomId, featured = false) {
    const title = roomTitle(id);
    const isThisExpanded = stageExpandedRoom === id;
    // Agent rooms carry their CLI's real logo to the left of the title.
    const agentSession = isAgentRoomId(id) ? getAgentSessionForRoom(id) : null;
    // The same active-work light belongs to every place terminal work can run,
    // not only agent rooms. Agent sessions have their own rooms and are excluded
    // from the personal/dev terminal rooms just as renderRoomContent excludes
    // them, so each executing session lights exactly the room that owns it.
    const isWorking =
      agentSession?.isExecuting ||
      ((id === 'terminal' || id === 'dev-terminal') &&
        (id === 'dev-terminal' ? allDevTerminalSessions : allTerminalSessions).some(
          (session) => session.isRunning && !isAgentSession(session) && session.isExecuting,
        ));
    // Every other room gets its own glyph in that same slot — the one the dock,
    // the Split switcher and the minimized stack already use for it, so a room
    // is the same mark wherever you meet it. `roomIcon` returns null for an id
    // it has no glyph for, and the header falls back to text-only for those.
    const roomGlyph = agentSession ? null : roomIcon(id);
    return (
      <section
        key={id}
        className={`room-panel bento-card${featured ? ' featured active-glow' : ''}${
          isWorking ? ' is-working' : ''
        }`}
        data-room-id={id}
        style={{ viewTransitionName: `spacron-room-${id.replace(/[^a-zA-Z0-9_-]/g, '-')}` } as React.CSSProperties}
        // Capture phase, and a ref rather than state: this fires on every click
        // and focus inside a pane (xterm included), so it must not re-render the
        // room subtree — remounting a live TerminalPane is the bug documented in
        // `.spacron/memory/terminal-pane-lifetime.md`.
        onMouseDownCapture={() => { lastInteractedRoomRef.current = id; }}
        onFocusCapture={() => { lastInteractedRoomRef.current = id; }}
      >
        <header className="room-header">
          <button
            className={`room-title${agentSession || roomGlyph ? ' has-brand' : ''}`}
            onClick={() => focusRoom(id)}
            title={
              isThisExpanded
                ? `${title} (expanded)`
                : `Make ${title} the primary pane`
            }
          >
            {agentSession && (
              <AgentBrandMark
                command={agentSession.agentPreset ?? null}
                name={title}
                className="room-title-brand"
              />
            )}
            {roomGlyph && (
              <span className="room-title-brand room-title-glyph" aria-hidden="true">
                {roomGlyph}
              </span>
            )}
            <span className="room-kind">{roomKind(id)}</span>
            <span className="room-name">{title}</span>
          </button>
          <div className="room-actions">
            {isThisExpanded ? (
              <button
                className="room-action"
                onClick={() => setStageExpansion(null)}
                title={`Restore ${title} to the split grid`}
                aria-label={`Restore ${title} to the split grid`}
              >
                <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
                  <polyline points="4 14 10 14 10 20" />
                  <polyline points="20 10 14 10 14 4" />
                  <line x1="14" y1="10" x2="21" y2="3" />
                  <line x1="3" y1="21" x2="10" y2="14" />
                </svg>
              </button>
            ) : (
              <button
                className="room-action"
                onClick={() => setStageExpansion(id)}
                title={`Expand ${title} to the full stage`}
                aria-label={`Expand ${title} to the full stage`}
              >
                <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
                  <polyline points="15 3 21 3 21 9" />
                  <polyline points="9 21 3 21 3 15" />
                  <line x1="21" y1="3" x2="14" y2="10" />
                  <line x1="3" y1="21" x2="10" y2="14" />
                </svg>
              </button>
            )}
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

  const handleMinimizedWheel = useCallback((e: WheelEvent) => {
    const target = e.currentTarget as HTMLElement | null;
    if (!target) return;
    if (Math.abs(e.deltaY) > Math.abs(e.deltaX) && target.scrollWidth > target.clientWidth) {
      e.preventDefault();
      target.scrollLeft += e.deltaY;
    }
  }, []);

  const minimizedStackRef = useCallback((node: HTMLDivElement | null) => {
    if (!node) return;
    node.addEventListener('wheel', handleMinimizedWheel, { passive: false });
    return () => node.removeEventListener('wheel', handleMinimizedWheel);
  }, [handleMinimizedWheel]);

  function renderMinimizedRooms() {
    if (minimizedRooms.size === 0) return null;
    const orderedMinimized = [
      ...roomOrder.filter((room) => minimizedRooms.has(room)),
      ...Array.from(minimizedRooms).filter((room) => !roomOrder.includes(room)),
    ];
    return (
      <div ref={minimizedStackRef} className="minimized-room-stack" aria-label="Minimized rooms">
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

  /**
   * Put the stage back the way a project left it — mode, Split tiling and focus
   * in one go. Driven by `restoreProjectState` when you switch projects.
   *
   * Ordering is the whole reason this is one function rather than three calls.
   * `switchAmbientLayout` re-applies the target mode's own remembered focus on
   * the way in, so setting focus first would simply be overwritten (the same
   * trap `focusRoomMode` works around). Seed that per-mode entry first, then let
   * the switch consume it.
   */
  function restoreRoomArrangement(
    mode: AmbientLayout,
    slots: RoomId[],
    focused: RoomId | null,
    expanded: RoomId | null = null,
    presets?: Record<number, string>,
    minimized: RoomId[] = [],
    savedRoomOrder: RoomId[] = [],
    devTerminalOpen = false,
  ) {
    // Collapse to the two modes that actually exist, mirroring the rule inside
    // `switchAmbientLayout`. Seeding `perLayoutState` under a name it will not
    // read back (`development`, or `vibe`, which re-tiles with the whole fleet
    // and would discard the arrangement we were handed) loses the focus.
    const target: AmbientLayout = mode === 'gallery' || mode === 'vibe' ? 'gallery' : 'focus';

    perLayoutState.current[target] = {
      focused,
      minimized: new Set(minimized),
    };
    // Kept even when landing in Focus: it is this project's Split arrangement,
    // and it should still be there when they switch back to Split.
    setSplitSlots(slots);
    if (presets) {
      const validated: Record<number, SplitPresetId> = {};
      for (const [k, v] of Object.entries(presets)) {
        const count = Number(k);
        if (!isNaN(count)) {
          validated[count] = resolvePreset(v, count);
        }
      }
      setSplitPresets(validated);
    }
    setMinimizedRooms(new Set(minimized));
    setRoomOrder(savedRoomOrder.length > 0 ? savedRoomOrder : ['workspace', 'terminal']);
    setDevTerminalRoomOpen(devTerminalOpen);
    setFocusedRoom(focused);
    // Only when the mode is really changing — `switchAmbientLayout` early-returns
    // on an unchanged one, which would leave the two setters above as the whole
    // restore. That is exactly right in that case.
    if (target !== ambientLayout) switchAmbientLayout(target);
    // AFTER the switch, never before: a mode change drops whatever pane was
    // zoomed (see the note there), and this project's saved zoom is the one
    // thing in the arrangement that must survive it.
    setExpandedRoom(expanded);
  }

  function switchAmbientLayout(requested: AmbientLayout) {
    // One-window shell: only `focus` (the single terminal/agent screen) and
    // `gallery` (the Split view) are real modes. Any request for
    // development/preview collapses to focus. The right-drawer tools no longer
    // request a layout at all — the drawer is a side panel that works in every
    // layout, so opening Toolbox/HTTP/DB/Containers/Env can't pull you out of
    // Split. `gallery` is only ever requested by an explicit user action (the
    // Split toggle / cycle shortcut), so entering it always stays intentional.
    //
    // `vibe` (Fleet) is no longer a mode. Its only differences from Split were
    // that membership was automatic and the grid wrapped — Split now does both,
    // so Fleet resolves to "Split, tiled with every running agent". It stays
    // accepted here because persisted workspace layouts and orchestrator
    // `ambient` commands still send it.
    const fleetRequested = requested === 'vibe';
    const nextLayout: AmbientLayout = requested === 'gallery' || fleetRequested ? 'gallery' : 'focus';

    // Agents to tile for a Fleet request. Read from `openRooms` (not
    // `visibleRooms`) and un-minimized below: asking for every agent means every
    // agent, including ones minimized earlier.
    const fleetAgents = fleetRequested
      ? openRooms.filter(isAgentRoomId).slice(0, SPLIT_MAX_PANES)
      : [];
    if (fleetRequested && fleetAgents.length === 0) {
      showToast('No agents running', 'info');
      return;
    }
    // A Fleet request re-tiles the stage even when already in Split, so it must
    // not early-return on an unchanged mode the way a plain toggle does.
    if (nextLayout === ambientLayout && !fleetRequested) return;

    // A zoomed pane belongs to the arrangement it was zoomed out of. Leaving it
    // set across a mode change is what stranded the shell in the state this
    // whole path exists to avoid: Focus pinned to a room that was no longer
    // active, and coming back to Split landing full-screen on a pane instead of
    // the grid the user left. A Fleet re-tile clears it for the same reason —
    // it is a brand new arrangement, and it has panes to show.
    setExpandedRoom(null);

    // Save current mode's state before switching
    perLayoutState.current[ambientLayout] = { focused: focusedRoom, minimized: minimizedRooms };

    // Fleet keeps the terminal session open behind it so returning to the
    // workspace lands you back on a live terminal.
    if (fleetRequested) {
      setTerminalRoomOpen(true);
      // Agent Fleet rides along on the right, so the tiled agents and the state
      // of what each one changed are on screen at the same time.
      // `applyRightDrawerTool`, not `setRightDrawerTool`: the drawer must not
      // steal `activeView` from the agent this switch is about to focus.
      useLayoutStore.getState().applyRightDrawerTool('fleet');
    }

    // Restore target mode's own minimize/focus state (independent per layout)
    const saved = perLayoutState.current[nextLayout];
    if (fleetAgents.length > 0) {
      const minimized = new Set(saved.minimized);
      fleetAgents.forEach((room) => minimized.delete(room));
      setMinimizedRooms(minimized);
      setFocusedRoom(fleetAgents[0]);
      setSplitSlots(fleetAgents);
    } else {
      setFocusedRoom(saved.focused);
      setMinimizedRooms(saved.minimized);
    }

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

      // Refit and repaint the terminals NOW, not when the settle window closes.
      // This is what "residue of the panels" actually was, and it is not a CSS
      // problem: the panes snap to their new geometry on this frame (grid track
      // counts change, so nothing about the box is interpolable — see the note
      // on `.rooms-table`'s transition in AppShell.css), but each xterm only
      // re-measures via its debounced ResizeObserver and only flushes its glyph
      // atlas on `pane-resize-end`. That event used to fire solely from
      // `finishLayoutSwitch`, 360 ms later, so for ~400 ms every pane painted
      // stale, wrongly-sized pixels from the PREVIOUS layout into its new box —
      // literal leftovers of the old panels. Worse, the debounced fit landed
      // first and, per the atlas note in TerminalPane's `onResizeEnd`, re-rendered
      // straight from the stale atlas, so the garbling was actively redrawn.
      //
      // `notifyPanesResized` already double-rAFs, so this measures after the
      // browser has laid the new grid out. Safe to run during the entrance: only
      // `opacity` animates, never geometry, so the box read here is final.
      notifyPanesResized();

      if (prefersReducedMotion) {
        setLayoutSwitching(false);
        return;
      }

      // Still fired again at the end of the settle window — that pass catches
      // anything that resolved late (a scrollbar appearing, fonts, a pane the
      // first fit raced). It is now a backstop, not the only fit.
      layoutSwitchTimerRef.current = window.setTimeout(finishLayoutSwitch, 360);
    });
  }

  function renderSplitSwitcher() {
    const isExpanded = stageExpandedRoom !== null;
    const atCap = splitRooms.length >= SPLIT_MAX_PANES;
    return (
      <aside className="split-switcher" aria-label="Arrange split panes">
        <div className="split-switcher-head">
          <span className="split-switcher-count">
            <span className="split-count-full">
              {isExpanded
                ? `1 of ${visibleRooms.length} (expanded)`
                : `${splitRooms.length} of ${SPLIT_MAX_PANES} panes`}
            </span>
            <span className="split-count-compact">
              {isExpanded
                ? `1/${visibleRooms.length} exp`
                : `${splitRooms.length}/${SPLIT_MAX_PANES}`}
            </span>
          </span>
          {!isExpanded && splitRooms.length >= 2 && (
            <SplitLayoutPicker
              count={splitRooms.length}
              activePreset={resolvePreset(splitPresets[splitRooms.length], splitRooms.length)}
              onSelectPreset={(presetId) => {
                withStageRetile(() => {
                  setSplitPresets((prev) => ({
                    ...prev,
                    [splitRooms.length]: presetId,
                  }));
                });
              }}
            />
          )}
        </div>
        <div className="split-switcher-rooms">
          {visibleRooms.map((room) => {
            const slot = splitRooms.indexOf(room);
            const onStage = slot >= 0;
            const isPrimary = isExpanded ? room === stageExpandedRoom : room === activeRoom;
            return (
              <div
                key={room}
                className={`split-switch-item${onStage ? ' on-stage' : ''}${isPrimary ? ' primary' : ''}`}
              >
                <button
                  type="button"
                  className="split-switch-summary"
                  onClick={() => {
                    if (isExpanded) {
                      if (room === stageExpandedRoom) {
                        setStageExpansion(null);
                      } else {
                        // `focusRoom` carries the expansion across on its own
                        // now, so this is a plain focus — setting both here
                        // would fight it (and refit every pane twice).
                        focusRoom(room);
                      }
                    } else {
                      if (onStage) focusRoom(room);
                      else addRoomToSplit(room);
                    }
                  }}
                  title={
                    isExpanded
                      ? isPrimary
                        ? `${roomTitle(room)} is currently expanded. Click to restore the split grid.`
                        : `Show ${roomTitle(room)} full stage`
                      : !onStage
                        ? `Add ${roomTitle(room)} to the split`
                        : isPrimary
                          ? `${roomTitle(room)} is the primary pane`
                          : `Make ${roomTitle(room)} the primary pane`
                  }
                >
                  <span className="split-switch-slot" aria-hidden="true">
                    {onStage ? slot + 1 : ''}
                  </span>
                  <span className="split-switch-icon" aria-hidden="true">{roomIcon(room)}</span>
                  <span className="split-switch-copy">
                    <span className="split-switch-name">{roomTitle(room)}</span>
                    <span className="split-switch-role">
                      {isExpanded && isPrimary
                        ? 'Expanded'
                        : onStage
                          ? (isPrimary ? `Pane ${slot + 1} · primary` : `Pane ${slot + 1}`)
                          : roomKind(room)}
                    </span>
                  </span>
                </button>
                <span className="split-target-actions">
                  {onStage ? (
                    <>
                      <button
                        type="button"
                        className="split-target-btn icon"
                        onClick={() => moveSplitSlot(room, -1)}
                        disabled={slot === 0}
                        title={`Move ${roomTitle(room)} earlier`}
                        aria-label={`Move ${roomTitle(room)} earlier`}
                      >
                        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                          <polyline points="15 18 9 12 15 6" />
                        </svg>
                      </button>
                      <button
                        type="button"
                        className="split-target-btn icon"
                        onClick={() => moveSplitSlot(room, 1)}
                        disabled={slot === splitRooms.length - 1}
                        title={`Move ${roomTitle(room)} later`}
                        aria-label={`Move ${roomTitle(room)} later`}
                      >
                        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                          <polyline points="9 18 15 12 9 6" />
                        </svg>
                      </button>
                      <button
                        type="button"
                        className="split-target-btn icon danger"
                        onClick={() => {
                          if (expandedRoom === room) setStageExpansion(null);
                          removeRoomFromSplit(room);
                        }}
                        disabled={splitRooms.length <= 1}
                        title={`Take ${roomTitle(room)} off the split`}
                        aria-label={`Take ${roomTitle(room)} off the split`}
                      >
                        <XIcon />
                      </button>
                    </>
                  ) : (
                    <button
                      type="button"
                      className="split-target-btn"
                      onClick={() => addRoomToSplit(room)}
                      disabled={atCap}
                      title={atCap ? `Split is full (${SPLIT_MAX_PANES} panes)` : `Add ${roomTitle(room)} to the split`}
                      aria-label={`Add ${roomTitle(room)} to the split`}
                    >
                      Add
                    </button>
                  )}
                </span>
              </div>
            );
          })}
        </div>
      </aside>
    );
  }

  function renderAmbientLayout() {
    const isSplit = ambientLayout === 'gallery';
    const isExpanded = stageExpandedRoom !== null;

    const persistentStageRooms: RoomId[] = [
      ...(['terminal', 'dev-terminal', 'preview'] as RoomId[]).filter((room) =>
        openRooms.includes(room),
      ),
      ...Array.from(new Set([...openRooms.filter(isAgentRoomId), ...mountedAgentRoomIds])).sort(
        (a, b) => getAgentRoomSessionId(a) - getAgentRoomSessionId(b),
      ),
    ];

    const stageRooms: RoomId[] = stageExpandedRoom
      ? [stageExpandedRoom]
      : isSplit
        ? splitRooms
        : activeRoom
          ? [activeRoom]
          : [];
    const stageRoomSet = new Set(stageRooms);
    const nonPersistentStageRooms = stageRooms.filter(
      (room) => !isPersistentRoomId(room),
    );

    const emptyStageMessage = stageRooms.length === 0 ? 'No open panes' : null;
    const stageIsVacant = stageRooms.length === 0;

    const activePreset = resolvePreset(splitPresets[stageRooms.length], stageRooms.length);
    const { className: stagePresetClass, style: stagePresetStyle } =
      !isExpanded && isSplit
        ? getSplitStageStyle(activePreset, stageRooms.length)
        : { className: '', style: undefined };

    const stageModifier = isExpanded
      ? ' stage-expanded'
      : isSplit
        ? ` ${stagePresetClass}`
        : '';

    function stagePaneProps(room: RoomId) {
      const hidden = !stageRoomSet.has(room);
      const index = stageRooms.indexOf(room);
      const paneStyle =
        !hidden && !isExpanded && isSplit
          ? getSplitPaneStyle(activePreset, index, stageRooms.length)
          : undefined;
      return {
        className: `stage-pane${hidden ? ' stage-hidden' : ''}`,
        style: hidden ? undefined : paneStyle,
      };
    }

    return (
      <>
        <div
          className={`focused-room stage-layers${stageModifier}${stageIsVacant ? ' empty-stage' : ''}`}
          style={!isExpanded && isSplit ? stagePresetStyle : undefined}
          aria-label={emptyStageMessage ?? undefined}
        >
          {emptyStageMessage !== null && (
            <p className="stage-empty-msg">{emptyStageMessage}</p>
          )}
          {persistentStageRooms.map((room) => {
            const { className, style } = stagePaneProps(room);
            return (
              <div key={room} className={className} style={style}>
                {renderRoomFrame(room, true)}
              </div>
            );
          })}
          {nonPersistentStageRooms.map((room) => {
            const { className, style } = stagePaneProps(room);
            return (
              <div key={room} className={className} style={style}>
                {renderRoomFrame(room, true)}
              </div>
            );
          })}
        </div>
        {(isSplit || isExpanded) && visibleRooms.length > 0 && renderSplitSwitcher()}
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

                <main ref={roomsTableRef} className={`rooms-table ambient-${ambientLayout}${
                  ((ambientLayout === 'gallery' || stageExpandedRoom !== null) && visibleRooms.length > 0)
                    ? ' has-room-switcher'
                    : ''
                }${layoutSwitching ? ' layout-switching' : ''}${
                  (ambientLayout === 'preview' && visibleRooms.filter((room) => room === 'terminal' || isAgentRoomId(room)).length === 0) ||
                  (ambientLayout === 'development' && visibleRooms.filter((room) => room === 'dev-terminal' || isAgentRoomId(room)).length === 0)
                    ? ` ${ambientLayout}-solo`
                    : ''
                }`} aria-label="Spacron ambient layout">
                  {renderAmbientLayout()}
                </main>

                {renderRightUtilityPanel()}
              </div>

              {/* Minimalist room stack anchored at workspace level — independent of sidebar toggle */}
              {renderMinimizedRooms()}

              <div ref={overlaysRef} className="workspace-overlays">
              {/* The room dock used to sit here as its own strip. Its launchers
                  now live in the prompt bar's Tools menu, and its layout
                  actions inline beside it. */}
              <div className="composer-strip">
                <FloatingPromptBar
                  trailingControls={
                    <div className="prompt-trailing">
                      {layoutActionItems.map((item) => <ActivityButton key={item.id} item={item} />)}
                      <div className="prompt-trailing-separator" />
                      <ToolsMenu groups={toolMenuGroups} />
                    </div>
                  }
                />
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

        {/* The Memory Graph, on exactly the same contract: a free-floating
            window driven by its own layout flag, surviving mode switches. */}

        {/* Rendered conditionally, never mounted-and-null: `useModalFocus` inside
            it pins the app-wide modal count for as long as it is mounted. */}
        {pendingTerminalClose && (
          <ConfirmDialog
            title={
              pendingTerminalClose.count === 1
                ? 'A shell is still running'
                : `${pendingTerminalClose.count} shells are still running`
            }
            body={
              <>
                Closing the {pendingTerminalClose.room === 'dev-terminal' ? 'Dev Terminal' : 'Terminal'}{' '}
                ends {pendingTerminalClose.count === 1 ? 'it' : 'them'} and anything{' '}
                {pendingTerminalClose.count === 1 ? 'it is' : 'they are'} running. Agent panes are not
                affected.
              </>
            }
            confirmLabel="Close and end"
            cancelLabel="Keep open"
            danger
            onConfirm={() => {
              const target = pendingTerminalClose.room;
              setPendingTerminalClose(null);
              closeTerminalRoomForReal(target);
            }}
            onCancel={() => setPendingTerminalClose(null)}
          />
        )}

        <TranscriptionIndicator />
      </div>
    </div>
  );
}
