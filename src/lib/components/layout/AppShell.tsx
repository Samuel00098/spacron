import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createPortal, flushSync } from 'react-dom';
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
import FloatingPromptBar from '$lib/components/terminal/FloatingPromptBar.tsx';
import { type ToolMenuGroup } from '$lib/components/layout/ToolsMenu.tsx';
import AgentQuickAdd, { type LauncherItem } from '$lib/components/shared/AgentQuickAdd';
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
import Dropdown from '$lib/components/shared/Dropdown.tsx';

import { AgentBrandMark } from '$lib/components/shared/useAgentBrand.tsx';
import AgentWorktreeBadge from '$lib/components/orchestrator/AgentWorktreeBadge.tsx';
import AgentPanelImages from '$lib/components/orchestrator/AgentPanelImages.tsx';
import UsageCounter from '$lib/components/usage/UsageCounter.tsx';
import UsagePanel from '$lib/components/usage/UsagePanel.tsx';
import ContainersPanel from '$lib/components/containers/ContainersPanelLazy.tsx';
import DbExplorerPanel from '$lib/components/db/DbExplorerPanelLazy.tsx';
import HttpClientPanel from '$lib/components/http/HttpClientPanelLazy.tsx';
import ReviewPanel from '$lib/components/review/ReviewPanelLazy.tsx';
import ToolboxPanel from '$lib/components/toolbox/ToolboxPanelLazy.tsx';
import TasksPanel from '$lib/components/workspace/TasksPanelLazy.tsx';
import ChatModePanel from '$lib/components/workspace/ChatModePanel.tsx';
import PreviewPanel from '$lib/components/preview/PreviewPanelLazy.tsx';
import MobilePanel from '$lib/components/mobile/MobilePanelLazy.tsx';
import { useShallow } from 'zustand/react/shallow';
import {
  useLayoutStore,
  rightDrawerToolOf,
  clampRightDrawerWidth,
  RIGHT_DRAWER_MAX_WIDTH,
  LEFT_PANEL_MIN_WIDTH,
  LEFT_PANEL_MAX_WIDTH,
  fitDrawerWidths,
} from '$lib/stores/zustand/layout';
import { useEditorStore } from '$lib/stores/zustand/editor';
import {
  toggleSidebar,
  setActiveView,
  openSettings,
  toggleSidebarTab,
  toggleEditorVisible,
  togglePreviewVisible,
  setPreviewDocked,
  toggleTerminal,
  toggleReviewVisible,
  toggleHttpVisible,
  toggleTasksVisible,
  toggleFleetVisible,
  toggleDbVisible,
  toggleContainersVisible,
  toggleToolboxVisible,
  RIGHT_DRAWER_TOOLS,
  rightSidebarVisible,
  rightSidebarTab as rightSidebarTabStore,
  openAgentSpawn,
  closeAgentSpawn,
  openEnvManager,
  terminalRoomOpen as terminalRoomOpenStore,
  homeScreenOpen,
} from '$lib/stores/layout';
import {
  openProject,
  toggleProjectHUD,
  newFolderPromptOpen,
  cloneRepoPromptOpen,
} from '$lib/stores/workspace';
import { toggleCommandPalette, registerCommand } from '$lib/stores/commandpalette';
import { showToast } from '$lib/stores/notification';
import { saveActiveFile, formatActiveFile } from '$lib/stores/editor';
import { startProxy, stopProxy, previewTabs, activePreviewTabId, createBlankPreviewBrowserTab, selectPreviewBrowserTab, closePreviewBrowserTab } from '$lib/stores/preview';
import { useSettingsStore } from '$lib/stores/zustand/settings';
import { appearance, matchShortcut } from '$lib/stores/settings';
import { toggleFloatingSearch } from '$lib/stores/projectsearch';
import { closeUsagePanel } from '$lib/stores/usage';
import { interactionMode } from '$lib/stores/interactionMode';
import {
  claimStartupShell,
  releaseStartupShellClaim,
  createTerminalSession,
  activeSessionId,
  devActiveSessionId,
  getSessionPromptTargetLabel,
  getAgentDisplayName,
  isAgentSession,
  killSession,
  paneAssignments,
  setActiveSession,
  sessions as terminalSessions,
  devSessions as devTerminalSessions,
  allProjectSessions,
  projectTerminalStates,
  devProjectTerminalStates,
  commandHistory,
} from '$lib/stores/terminal';
import { toggleChatModeTranscription, toggleTerminalTranscription } from '$lib/services/transcription-hotkey';

import { useUpdaterStore } from '$lib/stores/zustand/updater';
import { clampHorizontalScroll } from '$lib/actions/clampHorizontalScroll';
import ConfirmDialog from '$lib/components/shared/ConfirmDialog.tsx';
import type { ActiveView, LayoutState, SettingsTab, SidebarTab } from '$lib/types/layout';
import type { TerminalSessionInfo } from '$lib/stores/terminal';
import { toggleActiveTerminalChatView } from '$lib/services/terminal-chat';
import type { RightDrawerTool } from '$lib/stores/layout';
import { hoveredStageRoom, layoutControlCommand, publishLayoutSnapshot } from '$lib/stores/layoutControl';
import { isFullscreenRoom, resolveStageExpansion } from './fullscreenRooms.ts';
import { deepSeekAgentName, deepSeekPanelRoot, deepSeekPlacements } from '$lib/services/deepseek-harness';
// openDailyNote removed
// toggleSketch removed
import { startAgentUpdateChecks } from '$lib/stores/agentUpdates';
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
  | 'env'
  | 'mobile'
  | 'sketch'
  | 'library'
  | 'deepseek';

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
  env: 'Environment',
  mobile: 'Mobile',
  sketch: 'Sketch',
  library: 'Library',
  deepseek: 'DeepSeek Harness',
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

// Project switch veil. SETTLE covers the double-rAF refit, the 80 ms atlas
// repaint and a full-screen TUI answering its SIGWINCH, so the stage is final
// before it shows. REVEAL must match `project-stage-in` in AppShell.css.
const PROJECT_SETTLE_MS = 150;
const PROJECT_REVEAL_MS = 200;

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
  // Sketch owns an in-memory canvas document. Minimizing is only a visibility
  // change, so keep it mounted just like Preview; unmounting here used to
  // reconstruct the panel from an older delayed localStorage snapshot.
  // DeepSeek Harness is an iframe onto a live conversation, so the same rule
  // applies: hiding its room must not reload the page.
  return id === 'terminal' || id === 'dev-terminal' || id === 'preview' || id === 'sketch' || id === 'deepseek' || isAgentRoomId(id);
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
  | 'mobileVisible'
  | 'sketchVisible'
  | 'libraryVisible'
  | 'deepseekVisible'
  | 'agentSpawnOpen'
  | 'envManagerOpen'
  | 'auxPanelWidth'
  | 'auxEditorHeight'
  | 'leftPanelWidth'
  | 'rightDrawerWidth'
  | 'previewDocked'
  | 'previewDrawerWidth';

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
  env: 'envVisible',
  mobile: 'mobileVisible',
  sketch: 'sketchVisible',
  library: 'libraryVisible',
  deepseek: 'deepseekVisible',
};



const EditorPanel = lazy(() => import('$lib/components/editor/EditorPanel.tsx'));
const FleetDashboard = lazy(() => import('$lib/components/orchestrator/FleetDashboard.tsx'));
const EnvManager = lazy(() => import('$lib/components/shared/EnvManager.tsx'));
// Code-split: the sketch canvas is a large, self-contained surface, so it
// should not sit in the shell's initial bundle.
const SketchPanel = lazy(() => import('$lib/components/sketch/SketchPanel.tsx'));
const DeepSeekPanel = lazy(() => import('$lib/components/deepseek/DeepSeekPanel.tsx'));
const LibraryPanel = lazy(() => import('$lib/components/library/LibraryPanel.tsx'));

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
    title: 'Device',
    icon: <Icon><rect x="6" y="2" width="12" height="20" rx="2.5" /><path d="M10.5 18.5h3" /></Icon>,
  },
  review: {
    title: 'Diff',
    icon: <Icon><circle cx="18" cy="18" r="3" /><circle cx="6" cy="6" r="3" /><path d="M13 6h3a2 2 0 0 1 2 2v7" /><path d="M11 18H8a2 2 0 0 1-2-2V9" /></Icon>,
  },
};

// The left rail intentionally stays small: the project list plus the global
// Task and Sketch rooms. The file/navigation tools live in the right sidebar.
const LEFT_DRAWER_TOOLS = ['projects', 'files', 'search', 'git', 'problems', 'snapshots', 'snippets'] as const;
type LeftDrawerTool = (typeof LEFT_DRAWER_TOOLS)[number];
const LEFT_TOOL_META: Record<LeftDrawerTool, { title: string; icon: React.ReactNode }> = {
  projects: { title: 'Projects', icon: <Icon><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z" /></Icon> },
  files: { title: 'Files', icon: <Icon><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" /><polyline points="14 2 14 8 20 8" /><line x1="16" y1="13" x2="8" y2="13" /><line x1="16" y1="17" x2="8" y2="17" /><line x1="10" y1="9" x2="8" y2="9" /></Icon> },
  search: { title: 'Search files', icon: <Icon><circle cx="11" cy="11" r="7" /><path d="M21 21l-4.3-4.3" /></Icon> },
  git: { title: 'Source Control', icon: <Icon><circle cx="18" cy="18" r="3" /><circle cx="6" cy="6" r="3" /><circle cx="6" cy="18" r="3" /><path d="M18 15V9a4 4 0 0 0-4-4H9" /><line x1="6" y1="9" x2="6" y2="15" /></Icon> },
  snapshots: { title: 'Project Snapshots', icon: <Icon><rect x="2" y="3" width="20" height="14" rx="2" /><path d="M8 21h8M12 17v4" /><circle cx="12" cy="10" r="3" /></Icon> },
  snippets: { title: 'Shell Snippets', icon: <Icon><path d="M4 17l6-6-6-6M12 19h8" /></Icon> },
  problems: { title: 'Problems', icon: <Icon><circle cx="12" cy="12" r="9" /><line x1="12" y1="8" x2="12" y2="13" /><line x1="12" y1="16.5" x2="12.01" y2="16.5" /></Icon> },
  // Code Review is a right-sidebar utility. Source Control's inline
  // HunkDiffView covers the drawer-sized case for individual hunks.
};

// The first group in the right sidebar is the workspace navigator. The
// existing utility tools follow it in the same sidebar.
// Search lives inside Files (its search box), so it is not a surface of its own.
const RIGHT_NAVIGATOR_TOOLS = ['files', 'git', 'problems', 'snapshots', 'snippets'] as const;
type RightNavigatorTool = (typeof RIGHT_NAVIGATOR_TOOLS)[number];

// The RIGHT drawer hosts the layout-backed tools (including Code Review).
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
  // Sketch's window key handler retains its callback between renders. Keep it
  // stable while forwarding to the current Chat/Code close action.
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;
  const handleClose = useCallback(() => onCloseRef.current?.(), []);
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
  if (id === 'mobile') return <MobilePanel />;
  if (id === 'sketch') {
    return (
      <Suspense fallback={null}>
        <SketchPanel onClose={handleClose} />
      </Suspense>
    );
  }
  if (id === 'library') {
    return (
      <Suspense fallback={null}>
        <LibraryPanel />
      </Suspense>
    );
  }
  if (id === 'deepseek') {
    return (
      <Suspense fallback={null}>
        <DeepSeekPanel />
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
  // Files and Search are one surface: a search box over the file tree.
  return <SearchPanel idle={<FileExplorer />} autoFocus={false} />;
}

import { useGlobalTooltips } from '$lib/react/useGlobalTooltips.ts';

export default function AppShell() {
  useGlobalTooltips();
  const isSettingsOpen = useLayoutStore((s) => s.settingsOpen);

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
  function notifyPanesResized(forcePtyResize = false) {
    requestAnimationFrame(() =>
      requestAnimationFrame(() => {
        document.dispatchEvent(new CustomEvent('pane-resize-end', {
          detail: { forcePtyResize },
        }));
      }),
    );
  }

  function withRoomTransition(action: () => void) {
    // Wait for the view transition's update callback before measuring. Firing
    // `notifyPanesResized` synchronously here raced the DOM update and the double
    // rAF regularly landed on the OLD layout, so the panes refit to the size they
    // were leaving and then held stale, wrongly-fitted pixels until something
    // else happened to resize them.
    void withTransition(action).then(() => notifyPanesResized(true));
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
    notifyPanesResized(true);
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
        mobileVisible: s.mobileVisible,
        sketchVisible: s.sketchVisible,
        libraryVisible: s.libraryVisible,
        deepseekVisible: s.deepseekVisible,
        agentSpawnOpen: s.agentSpawnOpen,
        envManagerOpen: s.envManagerOpen,
        auxPanelWidth: s.auxPanelWidth,
        auxEditorHeight: s.auxEditorHeight,
        leftPanelWidth: s.leftPanelWidth,
        rightDrawerWidth: s.rightDrawerWidth,
        previewDocked: s.previewDocked,
        previewDrawerWidth: s.previewDrawerWidth,
      }),
    ),
  );
  const currentInteractionMode = useStore(interactionMode);
  const workspaceId = useWorkspaceStore((s) => s.activeWorkspaceId);
  // Home is an overlay on top of the still-mounted workspace (see
  // `homeScreenOpen`). With no workspace open at all there is nothing behind it,
  // so it is the only thing rendered.
  const homeOpen = useStore(homeScreenOpen);
    const project = useWorkspaceStore((s) => (s.activeProjectId ? s.projects.get(s.activeProjectId) ?? null : null));
  const currentAppearance = useStore(appearance);
  const projectSwitching = useWorkspaceStore((s) => s.isProjectSwitching);
  const switchingPhase = useWorkspaceStore((s) => s.switchingPhase);
  const openProjectIdList = useWorkspaceStore((s) => s.openProjectIds);
  const activeProjectIdValue = useWorkspaceStore((s) => s.activeProjectId);
  // The open flags are shared with Code. This only remembers which tool is
  // covering Chat; the return arrow dismisses that cover without closing it.
  const [chatPanelRoom, setChatPanelRoom] = useState<'tasks' | 'sketch' | 'library' | null>(null);
  const activeChatPanel = currentInteractionMode === 'chat' && chatPanelRoom && layoutState[PANEL_VISIBILITY_KEYS[chatPanelRoom]]
    ? chatPanelRoom
    : null;
  useEffect(() => {
    setChatPanelRoom(null);
  }, [activeProjectIdValue, workspaceId]);
  useEffect(() => {
    hoveredStageRoom.set(null);
    return () => hoveredStageRoom.set(null);
  }, [activeProjectIdValue]);
  const shellProjectStates = useStore(projectTerminalStates);
  const devShellProjectStates = useStore(devProjectTerminalStates);
  // Every project that gets a (possibly parked) terminal panel: the open ones,
  // the active one even if `openProjectIds` hasn't caught up mid-switch, and any
  // project that still has a live shell. That last set is what keeps a project's
  // terminals mounted after you leave it through the Projects sidebar — that is
  // usually a workspace switch, which empties `openProjectIds`, and dropping the
  // panel there disposed every xterm so the way back replayed scrollback into
  // fresh ones. See `.spacron/memory/agent-pane-survival.md`.
  //
  // Order is sticky: a project keeps its slot for as long as it is listed, so a
  // panel never moves (and gets re-parented) when the open list is rebuilt.
  const terminalHostOrderRef = useRef<string[]>([]);
  // Projects other than the active one with a live personal shell, per room.
  const backgroundShellProjects = useMemo(() => {
    const collect = (states: Map<string, { sessions: TerminalSessionInfo[] }>) =>
      [...states]
        .filter(([pid, state]) =>
          pid !== activeProjectIdValue &&
          state.sessions.some((session) => session.isRunning && !session.hidden && !isAgentSession(session)),
        )
        .map(([pid]) => pid);
    return { terminal: collect(shellProjectStates), dev: collect(devShellProjectStates) };
  }, [shellProjectStates, devShellProjectStates, activeProjectIdValue]);
  const terminalHostProjectIds = useMemo(() => {
    const wanted = new Set(openProjectIdList);
    if (activeProjectIdValue) wanted.add(activeProjectIdValue);
    for (const pid of [...backgroundShellProjects.terminal, ...backgroundShellProjects.dev]) wanted.add(pid);
    const kept = terminalHostOrderRef.current.filter((pid) => wanted.has(pid));
    const next = [...kept, ...[...wanted].filter((pid) => !kept.includes(pid))];
    terminalHostOrderRef.current = next;
    return next;
  }, [openProjectIdList, activeProjectIdValue, backgroundShellProjects]);

  const nextAppearance = currentAppearance === 'light'
    ? 'dark'
    : currentAppearance === 'dark'
    ? 'system'
    : 'light';

  function cycleAppearance() {
    appearance.set(nextAppearance);
  }
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
  // Agent CLI update checks: app-wide, a few registry requests every 6 hours.
  useEffect(() => startAgentUpdateChecks(), []);

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
  const [stageExpansionMotion, setStageExpansionMotion] = useState<'expanding' | 'collapsing' | null>(null);
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
  const [draggingRoom, setDraggingRoom] = useState<RoomId | null>(null);
  const [dragOverRoom, setDragOverRoom] = useState<RoomId | null>(null);
  const roomDragRef = useRef<{
    id: RoomId;
    pointerId: number;
    startX: number;
    startY: number;
    moved: boolean;
    overRoom: RoomId | null;
  } | null>(null);
  const roomDragClickGuardRef = useRef(false);
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
  // The Split/expanded layout control renders from the stage but paints in the
  // bottom-right of the overlay row, beside the prompt bar, so the stage can
  // start directly under the title bar.
  const [layoutControlHost, setLayoutControlHost] = useState<HTMLDivElement | null>(null);
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
  const deepSeekPlacementState = useStore(deepSeekPlacements);
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
        // A docked Preview lives in the right sidebar, not on the stage.
        { id: 'preview' as const, visible: layoutState.previewVisible && !layoutState.previewDocked },
        { id: 'tasks' as const, visible: layoutState.tasksVisible },
        { id: 'sketch' as const, visible: layoutState.sketchVisible },
        { id: 'library' as const, visible: layoutState.libraryVisible },
        { id: 'deepseek' as const, visible: layoutState.deepseekVisible },
        // Right utility drawer: review/fleet/toolbox/http/db/containers/env/mobile +
        // orchestrator. Left drawer: the nav tabs. None of those are rooms in
        // the ambient grid.
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
  // NOT bounded to the projects open in this workspace. Most project switches
  // from the Projects sidebar are workspace switches (a standalone project is
  // its own recents entry), and `openWorkspace` empties `openProjectIds` — so a
  // bound here unmounted every agent pane of the project you just left while
  // its agent kept running, and coming back replayed the TUI into a fresh
  // xterm, blank or garbled. A running agent is always mounted; closing its
  // project kills it, which is what takes the pane away.
  const mountedAgentRoomIds = useMemo<AgentRoomId[]>(
    () =>
      crossProjectSessions
        .filter((session) => session.isRunning && isAgentSession(session))
        .map((session) => `agent:${session.id}` as AgentRoomId),
    [crossProjectSessions],
  );

  // Auto-focus a freshly spawned agent so it opens in the focus screen. The
  // first run only records the current agents, so restored/pre-existing agents
  // on app startup don't steal focus from the default room.
  //
  // `agentRoomIds` follows the ACTIVE project, so switching projects swaps the
  // whole list and every agent of the project you land on looks "added". Those
  // are not spawns: focusing one overrode the arrangement the project is being
  // restored to and, in Focus, ran a view transition mid-switch — a bitmap of
  // the previous project cross-faded over the new one. Agents that appear while
  // a restore is in flight (a cold start relaunching them) are the same case.
  const prevAgentRoomIdsRef = useRef<AgentRoomId[]>([]);
  const agentFocusProjectRef = useRef(activeProjectIdValue);
  const agentFocusInitRef = useRef(false);
  useEffect(() => {
    if (!agentFocusInitRef.current) {
      agentFocusInitRef.current = true;
      prevAgentRoomIdsRef.current = agentRoomIds;
      return;
    }
    const prev = prevAgentRoomIdsRef.current;
    prevAgentRoomIdsRef.current = agentRoomIds;
    const projectChanged = agentFocusProjectRef.current !== activeProjectIdValue;
    agentFocusProjectRef.current = activeProjectIdValue;
    if (projectChanged || projectSwitching) return;
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
  //
  // A switch is also not one state change but several, spread across backend
  // round-trips: the new project's agents appear under the old arrangement, then
  // every store is cleared, then the saved layout lands, then the panes refit.
  // Painting each of those is the flicker, the half-drawn panes and the "No open
  // panes" flash. So the stage is veiled for the whole restore (see
  // `.project-veiled` in AppShell.css), held a beat after it ends so the refit
  // and each TUI's SIGWINCH redraw land while still hidden, and then faded in —
  // the user only ever sees the finished stage.
  const [projectVeil, setProjectVeil] = useState<'none' | 'hold' | 'reveal'>('none');
  const prevProjectSwitchingRef = useRef(projectSwitching);
  useEffect(() => {
    const wasSwitching = prevProjectSwitchingRef.current;
    prevProjectSwitchingRef.current = projectSwitching;
    if (projectSwitching) {
      setProjectVeil('hold');
      return;
    }
    if (!wasSwitching) return;
    notifyPanesResized(true);
    let revealTimer = window.setTimeout(() => {
      setProjectVeil('reveal');
      revealTimer = window.setTimeout(() => setProjectVeil('none'), PROJECT_REVEAL_MS);
    }, PROJECT_SETTLE_MS);
    return () => window.clearTimeout(revealTimer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectSwitching]);
  // Read straight off the store as well as the state, so the veil is up on the
  // very render the switch starts rather than one commit later.
  const projectVeiled = projectSwitching || projectVeil === 'hold';

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

  // A project opens on a terminal, never on the empty "Start with agents"
  // stage. Once per project open: after its restore has finished (and a beat
  // more, for agent rooms that come back a render or two later), an empty
  // stage gets the Terminal room. TerminalPanel's own auto-open then starts
  // the shell. Closing everything afterwards still leaves the stage empty.
  const openRoomsRef = useRef(openRooms);
  openRoomsRef.current = openRooms;
  const terminalOpenedForProjectRef = useRef<string | null>(null);
  useEffect(() => {
    if (!project || projectSwitching || currentInteractionMode !== 'cli') return;
    const projectKey = activeProjectIdValue ?? project.root_path ?? '';
    if (terminalOpenedForProjectRef.current === projectKey) return;
    const timer = window.setTimeout(() => {
      terminalOpenedForProjectRef.current = projectKey;
      if (openRoomsRef.current.length === 0) terminalRoomOpenStore.set(true);
    }, 300);
    return () => window.clearTimeout(timer);
  }, [project, projectSwitching, activeProjectIdValue, currentInteractionMode]);

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
    // A full-stage-only room never takes a tile. It can still be `activeRoom`
    // (and is spliced in below), but then the stage renders it expanded and this
    // list is not read at all — so the filter only ever drops it from the
    // *other* slots, where it would have been tiled behind whatever is active.
    const arranged = splitSlots.filter(
      (room, index) =>
        visibleRooms.includes(room) &&
        splitSlots.indexOf(room) === index &&
        !isFullscreenRoom(room),
    );
    if (arranged.length === 0) {
      // Unarranged: today's default — the active room plus the next one open.
      return [activeRoom, ...sideRooms.filter((room) => !isFullscreenRoom(room)).slice(0, 1)];
    }
    const withActive = arranged.includes(activeRoom) ? arranged : [activeRoom, ...arranged];
    return withActive.slice(0, SPLIT_MAX_PANES);
  }, [activeRoom, sideRooms, splitSlots, visibleRooms]);

  /**
   * The pane the *user* zoomed to the full stage, or null.
   *
   * Same test four render paths were each spelling out for themselves — the
   * stage, the switcher, the prompt-bar Split button and the pane header. They
   * agreed, but nothing made them agree, and every new read of `expandedRoom`
   * was a chance to check it without the "is that room still on stage?" half.
   *
   * Read this only where the difference from a forced full-stage room matters
   * (dismissing, and carrying the zoom across a focus change). Everything that
   * just asks "is one pane filling the stage?" wants `stageExpandedRoom`.
   */
  const zoomedRoom =
    expandedRoom !== null && visibleRooms.includes(expandedRoom) ? expandedRoom : null;

  // Which room fills the stage, and whether it does so because the user zoomed
  // it or because of what it is (Tasks/Sketch). See `fullscreenRooms.ts` — the
  // distinction matters everywhere the expansion can be *left*.
  const stageExpansion = resolveStageExpansion(activeRoom, zoomedRoom);
  const stageExpandedRoom = stageExpansion.room as RoomId | null;
  const forcedFullscreenRoom = stageExpansion.forced ? stageExpandedRoom : null;

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
    setStageExpansionMotion(next === null ? 'collapsing' : 'expanding');
    withStageRetile(() => setExpandedRoom(next));
  }

  // Let the short visual settle finish before removing its class. Keeping the
  // retile itself immediate preserves the terminal refit invariant above; the
  // motion is only a paint-layer treatment on the newly arranged stage.
  useEffect(() => {
    if (stageExpansionMotion === null) return;
    const timer = window.setTimeout(() => setStageExpansionMotion(null), 320);
    return () => window.clearTimeout(timer);
  }, [stageExpansionMotion]);

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

    // Title-bar Back/Forward stepping between expanded panels. A room that has
    // been closed since the history entry was made is skipped, not reopened.
    if (layoutCommand.type === 'expand') {
      const target = layoutCommand.room;
      if (target === null) {
        if (zoomedRoom !== null) setStageExpansion(null);
      } else if (isKnownRoomId(target) && visibleRooms.includes(target) && target !== zoomedRoom) {
        focusRoomMode(target);
      }
      return;
    }

    if (layoutCommand.type !== 'room') return;

    const wanted = layoutCommand.room.trim().toLowerCase();
    // A docked Preview is not a room, so the resolver below would not find it.
    // "Focus preview" (an agent, a terminal link, revealPreview) means "show it"
    // wherever it lives.
    if (wanted === 'preview' && layoutState.previewVisible && layoutState.previewDocked) {
      if (layoutCommand.op === 'close') togglePreviewVisible();
      else if (layoutCommand.op === 'focus' || layoutCommand.op === 'expand' || layoutCommand.op === 'restore') showDockedPreview();
      return;
    }
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
          // The raw launch command too: `roomKind` shows the product name now,
          // and "focus claude" must still find the Claude Code room.
          const command = isAgentRoomId(id) ? getAgentSessionForRoom(id)?.agentPreset ?? '' : '';
          const labels = [roomTitle(id), roomKind(id), id, command].filter(Boolean).map((label) => label.toLowerCase());
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
        // Not while a pane is zoomed: `addRoomToSplit` clears the zoom, so the
        // stage fell back to the grid — `focusRoom` carries it instead, the
        // same as every other room.
        if (room === 'preview' && ambientLayout === 'gallery' && zoomedRoom === null) {
          const otherRooms = visibleRooms.filter((r) => r !== 'preview');
          if (otherRooms.length > 0) {
            addRoomToSplit('preview');
            break;
          }
        }
        focusRoom(room);
        break;
      case 'expand':
        setMinimizedRooms((current) => {
          if (!current.has(room)) return current;
          const next = new Set(current);
          next.delete(room);
          return next;
        });
        focusRoomMode(room);
        break;
      case 'collapse':
        if (zoomedRoom === room) setStageExpansion(null);
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

  // Keep the left navigator available at narrow widths. It is a user-owned
  // choice now: the close button/title-bar toggle can hide it, but resizing the
  // window must not silently change that choice underneath them.
  useEffect(() => {
    if (windowWidth < 500 || document.hidden) return;
    const effectiveWindowWidth = windowWidth / (zoom / 100);
    if (effectiveWindowWidth < 640) {
      return;
    }

    const maxAllowedWidth = Math.min(LEFT_PANEL_MAX_WIDTH, effectiveWindowWidth - 250 - 48);
    if (layoutState.leftPanelWidth > maxAllowedWidth) {
      useLayoutStore.setState({ leftPanelWidth: Math.max(LEFT_PANEL_MIN_WIDTH, maxAllowedWidth) });
    }
  }, [layoutState.leftPanelWidth, layoutState.sidebarVisible, windowWidth, zoom]);

  useEffect(() => {
    if (windowWidth < 500 || document.hidden) return;
    if (visiblePanels.length > 0 && auxPanelWidth > auxMaxWidth()) {
      setAuxPanelWidth(Math.max(200, auxMaxWidth()));
    }
  }, [auxPanelWidth, layoutState.sidebarVisible, layoutState.leftPanelWidth, visiblePanels.length, windowWidth, zoom]);

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
        const maxAllowedWidth = Math.min(LEFT_PANEL_MAX_WIDTH, windowWidth / scale - 250 - 48);
        useLayoutStore.setState({
          leftPanelWidth: Math.max(
            LEFT_PANEL_MIN_WIDTH,
            Math.min(maxAllowedWidth, leftPanelResizeRef.current.startWidth + delta),
          ),
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
        case 'toggleInteractionMode':
          // Same id so saved key bindings carry over; it now flips the focused
          // agent pane between Terminal and Chat instead of the whole window.
          if (!event.repeat) toggleActiveTerminalChatView();
          break;
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
            newFolderPromptOpen.set(true);
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
        case 'spawnAgent':
          openAgentSpawn();
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
     * Task Editor, Clone Repo, Create Project, Agent Spawn,
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
      // The dictation hotkey is mode-routed: in conversational mode it must aim
      // at the chat composer (force-focusing it, so the capture can never fall
      // back to a hidden CLI terminal) — in CLI mode it goes to the caret's
      // field or the terminal the user is in.
      if (get(interactionMode) === 'chat') {
        toggleChatModeTranscription();
      } else {
        toggleTerminalTranscription();
      }
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
    leftPanelResizeRef.current = { startX: event.clientX, startWidth: leftPanelWidthFit };
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
      startWidth: rightDrawerWidthFit,
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
    const width = clampRightDrawerWidth(
      Math.min(maxAllowedWidth, rightDrawerResizeRef.current.startWidth + delta),
    );
    useLayoutStore.setState(showingDockedPreview ? { previewDrawerWidth: width } : { rightDrawerWidth: width });
  }

  function endRightDrawerResize() {
    if (!rightDrawerResizeRef.current.active) return;
    rightDrawerResizeRef.current.active = false;
    setRightDrawerResizing(false);
    document.body.style.cursor = '';
    document.body.style.userSelect = '';
    // Persist the final width — the live drag wrote straight to the store, which
    // does not touch storage. This is the only place the new width is saved.
    const state = useLayoutStore.getState();
    if (showingDockedPreview) state.setPreviewDrawerWidth(state.previewDrawerWidth);
    else state.setRightDrawerWidth(state.rightDrawerWidth);
  }

  // --- LEFT workspace rail -------------------------------------------------
  // The left rail is deliberately limited to the project list and the two global
  // room launchers. File/navigation panels live in the right sidebar.
  const leftDrawerOpen = layoutState.sidebarVisible;
  useEffect(() => {
    if (!leftDrawerOpen) closeUsagePanel();
  }, [leftDrawerOpen]);
  const leftActiveTool: LeftDrawerTool | null = leftDrawerOpen ? 'projects' : null;
  const leftDrawerTools: readonly LeftDrawerTool[] = ['projects'];
  const rightSidebarTab = useStore(rightSidebarTabStore);
  const rightNavigatorTool: RightNavigatorTool = (RIGHT_NAVIGATOR_TOOLS as readonly string[]).includes(rightSidebarTab)
    ? rightSidebarTab as RightNavigatorTool
    : 'files';
  const rightNavigatorTools: readonly RightNavigatorTool[] = RIGHT_NAVIGATOR_TOOLS.filter(
    (tool) => tool !== 'snapshots' || showSnapshotsTab,
  );
  const rightSidebarOpen = useStore(rightSidebarVisible);
  // Preview can be docked in this sidebar instead of being a stage room. It
  // stays mounted while another tab is showing — hiding it is a visibility
  // change, so the page inside never reloads (the same rule the stage applies
  // through `isPersistentRoomId`).
  const previewDockedOpen = layoutState.previewVisible && layoutState.previewDocked;
  const showingDockedPreview =
    previewDockedOpen && rightSidebarTab === 'preview' && rightDrawerToolOf(layoutState) === null;
  // The docked Preview keeps its own, wider width. See `previewDrawerWidth`.
  const rightSidebarWidth = showingDockedPreview ? layoutState.previewDrawerWidth : layoutState.rightDrawerWidth;

  function showDockedPreview() {
    chooseRightSurface();
    rightSidebarVisible.set(true);
    rightSidebarTabStore.set('preview');
    // `apply…`, not `setRightDrawerTool`: closing a utility to make room for
    // the Preview tab must not also move the stage.
    if (rightDrawerToolOf(useLayoutStore.getState()) !== null) {
      useLayoutStore.getState().applyRightDrawerTool(null);
    }
  }

  // Bring the sidebar up on the Preview tab whenever Preview newly opens there,
  // whichever path opened it (dock button, shortcut, an agent, a dev server).
  // Not when a project switch restored it: that project's own sidebar state
  // was restored with it, and forcing the sidebar open would override it. The
  // restore is async and lands across several renders, so the id check alone
  // misses it; `projectSwitching` covers the whole restore.
  const prevPreviewDockedOpenRef = useRef({ open: previewDockedOpen, projectId: activeProjectIdValue });
  useEffect(() => {
    const was = prevPreviewDockedOpenRef.current;
    prevPreviewDockedOpenRef.current = { open: previewDockedOpen, projectId: activeProjectIdValue };
    if (projectSwitching || was.projectId !== activeProjectIdValue) return;
    if (previewDockedOpen && !was.open) showDockedPreview();
  }, [previewDockedOpen, activeProjectIdValue, projectSwitching]);

  // Drawer widths as rendered: the saved widths, squeezed only when the window
  // is too narrow to also give the stage a usable width. Gutters are the 20px
  // outer margin beside each open drawer plus the stage's 8px on each side.
  const { left: leftPanelWidthFit, right: rightDrawerWidthFit } = fitDrawerWidths({
    available:
      windowWidth / (zoom / 100) - 16 - (leftDrawerOpen ? 20 : 0) - (rightSidebarOpen ? 20 : 0),
    left: layoutState.leftPanelWidth,
    right: rightSidebarWidth,
    leftOpen: leftDrawerOpen,
    rightOpen: rightSidebarOpen,
  });

  useEffect(() => {
    if (!showSnapshotsTab && rightNavigatorTool === 'snapshots') {
      rightSidebarTabStore.set('files');
    }
  }, [rightNavigatorTool, showSnapshotsTab]);

  function selectLeftTool(tool: LeftDrawerTool) {
    persistLayoutPatch({ sidebarVisible: true, sidebarTab: tool as SidebarTab });
  }
  function closeLeftDrawer() {
    closeUsagePanel();
    persistLayoutPatch({ sidebarVisible: false });
  }
  function toggleLeftTool(tool: LeftDrawerTool) {
    if (leftActiveTool === tool) closeLeftDrawer();
    else selectLeftTool(tool);
  }

  function renderLeftUtilityPanel() {
    if (!leftDrawerOpen) return null;

    const renderRoomNavItem = (item: ActivityItem) => (
      <button
        key={item.id}
        type="button"
        className={`left-sidebar-nav-item${item.active ? ' active' : ''}`}
        onClick={item.onClick}
        aria-pressed={item.active}
      >
        <span className="left-sidebar-nav-icon" aria-hidden="true">{item.icon}</span>
        <span className="left-sidebar-nav-label">{item.title}</span>
      </button>
    );

    // The project-opening commands used to be a row of unlabelled icons on top
    // of the project list. They read as a list here, above the global rooms.
    const renderActionNavItem = (
      key: string,
      title: string,
      icon: React.ReactNode,
      onClick: () => void,
      hint?: string,
    ) => (
      <button
        key={key}
        type="button"
        className="left-sidebar-nav-item"
        onClick={onClick}
        title={hint ?? title}
      >
        <span className="left-sidebar-nav-icon" aria-hidden="true">{icon}</span>
        <span className="left-sidebar-nav-label">{title}</span>
      </button>
    );

    return (
      <aside
        className="left-utility-panel left-sidebar bento-card"
        // Below 240px the rail compacts its contents (see AppShell.css).
        data-narrow={leftPanelWidthFit < 240 ? '' : undefined}
        style={{
          width: 'var(--left-sidebar-width)',
          '--left-sidebar-width': `${leftPanelWidthFit}px`,
        } as React.CSSProperties}
        aria-label="Projects"
      >
        <div
          className="left-drawer-resize-handle"
          onMouseDown={startLeftPanelResize}
          role="separator"
          aria-orientation="vertical"
        />
        <header className="left-sidebar-header">
          <div className="left-sidebar-heading">
            <span className="left-sidebar-app-name" aria-label="Spacron">
              <span className="left-sidebar-app-logo" aria-hidden="true" />
              pacron
            </span>
          </div>
          <button
            className="left-sidebar-collapse-btn"
            onClick={() => closeLeftDrawer()}
            title="Hide left sidebar"
            aria-label="Hide left sidebar"
          >
            <Icon><path d="m15 18-6-6 6-6" /></Icon>
          </button>
        </header>

        <nav className="left-sidebar-nav" aria-label="Project actions and global views">
          {renderActionNavItem(
            'create-project',
            'Create Project',
            <Icon><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z" /><line x1="12" y1="11" x2="12" y2="17" /><line x1="9" y1="14" x2="15" y2="14" /></Icon>,
            () => newFolderPromptOpen.set(true),
            'Create Project… (Ctrl+N)',
          )}
          {renderActionNavItem(
            'open-project',
            'Open Project',
            <Icon><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z" /></Icon>,
            () => void openProject(),
            'Open Project Folder… (Ctrl+O)',
          )}
          {renderActionNavItem(
            'clone-repo',
            'Clone Repository',
            <Icon><circle cx="18" cy="18" r="3" /><circle cx="6" cy="6" r="3" /><circle cx="6" cy="18" r="3" /><path d="M18 15V9a4 4 0 0 0-4-4H9" /><line x1="6" y1="9" x2="6" y2="15" /></Icon>,
            () => cloneRepoPromptOpen.set(true),
            'Clone Git Repository…',
          )}
          <div className="left-sidebar-nav-divider" aria-hidden="true" />
          {[tasksItem, sketchItem, libraryItem].map(renderRoomNavItem)}
        </nav>

        <div className="drawer-body">
          <ProjectHUD />
        </div>

        <UsagePanel />
        <footer className="left-sidebar-footer">
          <UsageCounter />
          <button
            type="button"
            className="left-sidebar-theme-btn"
            onClick={cycleAppearance}
            title={`Appearance: ${currentAppearance}. Click to switch.`}
            aria-label={`Appearance: ${currentAppearance}. Click to switch.`}
          >
            <Icon>
              {currentAppearance === 'system' ? (
                <>
                  <rect x="3" y="4" width="18" height="12" rx="2" />
                  <path d="M8 20h8M12 16v4" />
                </>
              ) : currentAppearance === 'light' ? (
                <>
                  <circle cx="12" cy="12" r="4" />
                  <path d="M12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M2 12h2M20 12h2M4.93 19.07l-1.41 1.41M19.07 4.93l-1.41 1.41" />
                </>
              ) : (
                <path d="M21 12.8A8.5 8.5 0 1 1 11.2 3 6.7 6.7 0 0 0 21 12.8Z" />
              )}
            </Icon>
          </button>
          <button
            type="button"
            className="left-sidebar-settings-btn"
            onClick={() => openSettings()}
            title="Settings"
            aria-label="Settings"
          >
            <Icon><circle cx="12" cy="12" r="3" /><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" /></Icon>
          </button>
        </footer>
      </aside>
    );
  }

  // --- RIGHT workspace tools sidebar --------------------------------------
  // Files/search/source control/problems/snippets are the first group. The
  // existing layout-backed utilities follow them in the same sidebar.
  const rightActiveTool: RightTool | null = rightDrawerToolOf(layoutState);
  const rightDrawerOpen = rightActiveTool !== null;
  useEffect(() => {
    // Shortcuts and restored project state can open a utility without going
    // through this sidebar's tab button. Keep the shared last-tab memory in
    // sync with those paths too.
    if (rightActiveTool) rightSidebarTabStore.set(rightActiveTool);
  }, [rightActiveTool]);

  function selectRightNavigatorTool(tool: RightNavigatorTool) {
    chooseRightSurface();
    rightSidebarVisible.set(true);
    rightSidebarTabStore.set(tool);
    useLayoutStore.getState().setRightDrawerTool(null);
  }

  function selectRightTool(tool: RightTool) {
    chooseRightSurface();
    rightSidebarVisible.set(true);
    rightSidebarTabStore.set(tool);
    useLayoutStore.getState().setRightDrawerTool(tool);
  }
  function closeRightUtility() {
    useLayoutStore.getState().setRightDrawerTool(null);
  }
  function closeRightSidebar() {
    rightSidebarVisible.set(false);
    closeRightUtility();
  }
  function toggleRightTool(tool: RightTool) {
    if (rightActiveTool === tool) {
      closeRightUtility();
      rightSidebarTabStore.set('files');
    }
    else selectRightTool(tool);
  }

  // --- Right sidebar tabs ----------------------------------------------------
  // The sidebar holds a row of tabs, each one an instance of a surface; the
  // same surface may be open in several tabs. "+" opens the surface menu, and
  // with no tabs the body shows the centred "Open a surface" list instead.
  // Tabs are the view; the layout stores still say which surface is showing,
  // so shortcuts, agents and project restores keep working: when the stores
  // move to a surface on their own, the matching tab is selected (or added).
  type RightSurfaceId = 'preview' | RightNavigatorTool | RightTool;
  type RightSidebarTabItem = { id: string; surface: RightSurfaceId; previewTabId?: string };
  const [rightTabs, setRightTabs] = useState<RightSidebarTabItem[]>([]);
  const [activeRightTabId, setActiveRightTabId] = useState<string | null>(null);
  const activeRightTab = rightTabs.find((t) => t.id === activeRightTabId) ?? null;
  const [surfaceMenuAnchor, setSurfaceMenuAnchor] = useState<DOMRect | null>(null);
  const rightTabSeqRef = useRef(0);
  // Set when something opens a specific surface while the sidebar is closed,
  // so the open that follows shows that surface rather than the restored tab.
  const rightSurfaceChosenRef = useRef(false);
  const focusOnMount = useCallback((node: HTMLElement | null) => node?.focus({ preventScroll: true }), []);

  const storeRightSurface: RightSurfaceId = showingDockedPreview
    ? 'preview'
    : rightActiveTool ?? rightNavigatorTool;

  function chooseRightSurface() {
    if (!rightSidebarOpen) rightSurfaceChosenRef.current = true;
  }

  function newRightTab(surface: RightSurfaceId, previewTabId?: string): RightSidebarTabItem {
    rightTabSeqRef.current += 1;
    return { id: `rtab-${rightTabSeqRef.current}`, surface, previewTabId };
  }

  /** Point the layout stores at a tab's surface. */
  function applyRightTab(tab: RightSidebarTabItem) {
    if (tab.surface === 'preview') {
      if (tab.previewTabId && get(previewTabs).some((p) => p.id === tab.previewTabId)) {
        selectPreviewBrowserTab(tab.previewTabId);
      }
      if (previewDockedOpen) showDockedPreview();
      else setPreviewDocked(true);
    } else if ((RIGHT_NAVIGATOR_TOOLS as readonly string[]).includes(tab.surface)) {
      selectRightNavigatorTool(tab.surface as RightNavigatorTool);
    } else {
      selectRightTool(tab.surface as RightTool);
    }
  }

  function activateRightTab(tab: RightSidebarTabItem) {
    setActiveRightTabId(tab.id);
    applyRightTab(tab);
  }

  /** "+" menu / picker: always opens a new tab, even for a surface already open. */
  function openRightSurfaceTab(surface: RightSurfaceId) {
    setSurfaceMenuAnchor(null);
    let previewTabId: string | undefined;
    if (surface === 'preview') {
      // The first Browser tab shows the page already loaded; each further one
      // gets its own blank page.
      previewTabId = rightTabs.some((t) => t.surface === 'preview')
        ? createBlankPreviewBrowserTab()
        : get(activePreviewTabId);
    }
    const tab = newRightTab(surface, previewTabId);
    setRightTabs((tabs) => [...tabs, tab]);
    activateRightTab(tab);
  }

  function closeRightTab(tab: RightSidebarTabItem) {
    const index = rightTabs.findIndex((t) => t.id === tab.id);
    const remaining = rightTabs.filter((t) => t.id !== tab.id);
    setRightTabs(remaining);
    if (tab.surface === 'preview' && tab.previewTabId && remaining.some((t) => t.surface === 'preview')) {
      closePreviewBrowserTab(tab.previewTabId);
    }
    if (activeRightTabId !== tab.id) return;
    const next = remaining[Math.max(0, index - 1)] ?? null;
    if (next) activateRightTab(next);
    else {
      setActiveRightTabId(null);
      closeRightUtility();
    }
  }

  /** The stores moved to `surface` on their own: select or add its tab. */
  function followStoreSurface(surface: RightSurfaceId) {
    if (activeRightTab?.surface === surface) return;
    const previewId = surface === 'preview' ? get(activePreviewTabId) : undefined;
    const existing =
      (previewId ? rightTabs.find((t) => t.surface === 'preview' && t.previewTabId === previewId) : undefined)
      ?? rightTabs.find((t) => t.surface === surface);
    if (existing) {
      setActiveRightTabId(existing.id);
      return;
    }
    const tab = newRightTab(surface, previewId);
    setRightTabs((tabs) => [...tabs, tab]);
    setActiveRightTabId(tab.id);
  }

  const rightSyncRef = useRef({ open: rightSidebarOpen, surface: storeRightSurface });
  useEffect(() => {
    const prev = rightSyncRef.current;
    rightSyncRef.current = { open: rightSidebarOpen, surface: storeRightSurface };
    if (!rightSidebarOpen) {
      rightSurfaceChosenRef.current = false;
      return;
    }
    const opened = !prev.open;
    const chosen = rightSurfaceChosenRef.current;
    rightSurfaceChosenRef.current = false;
    if (opened && !chosen && !projectSwitching) {
      // Opened by hand: bring back the tab that was showing (or the list).
      if (activeRightTab) applyRightTab(activeRightTab);
      return;
    }
    if (opened || prev.surface !== storeRightSurface) followStoreSurface(storeRightSurface);
  }, [rightSidebarOpen, storeRightSurface]);

  type RightSurface = {
    id: RightSurfaceId;
    title: string;
    icon: React.ReactNode;
    shortcut: string;
    needsProject: boolean;
  };
  const browserIcon = <Icon><circle cx="12" cy="12" r="10" /><path d="M12 2a14.5 14.5 0 0 0 0 20 14.5 14.5 0 0 0 0-20" /><path d="M2 12h20" /></Icon>;
  const NAVIGATOR_SHORTCUTS: Record<RightNavigatorTool, string> = {
    files: 'F', git: 'G', problems: 'P', snapshots: 'N', snippets: 'I',
  };
  const TOOL_SHORTCUTS: Record<RightTool, string> = {
    review: 'D', fleet: 'A', toolbox: 'T', http: 'H', db: 'Q', containers: 'C', env: 'E', mobile: 'M',
  };
  const PROJECT_FREE_TOOLS: readonly RightTool[] = ['toolbox', 'http', 'db', 'mobile'];
  const rightSurfaces: RightSurface[] = [
    { id: 'preview', title: 'Browser', icon: browserIcon, shortcut: 'B', needsProject: false },
    ...rightNavigatorTools.map((tool): RightSurface => ({
      id: tool,
      title: LEFT_TOOL_META[tool].title,
      icon: LEFT_TOOL_META[tool].icon,
      shortcut: NAVIGATOR_SHORTCUTS[tool],
      needsProject: true,
    })),
    ...RIGHT_TOOLS_ALL.map((tool): RightSurface => ({
      id: tool,
      title: RIGHT_TOOL_META[tool].title,
      icon: RIGHT_TOOL_META[tool].icon,
      shortcut: TOOL_SHORTCUTS[tool],
      needsProject: !PROJECT_FREE_TOOLS.includes(tool),
    })),
  ];
  const surfaceMeta = (id: RightSurfaceId): { title: string; icon: React.ReactNode } =>
    id === 'preview'
      ? { title: 'Browser', icon: browserIcon }
      : (RIGHT_NAVIGATOR_TOOLS as readonly string[]).includes(id)
      ? LEFT_TOOL_META[id as RightNavigatorTool]
      : RIGHT_TOOL_META[id as RightTool];
  const surfaceAvailable = (surface: RightSurface) => !surface.needsProject || activeProjectIdValue != null;

  function handleSurfaceKey(event: React.KeyboardEvent) {
    if (event.key === 'Escape' && surfaceMenuAnchor) {
      event.preventDefault();
      event.stopPropagation();
      setSurfaceMenuAnchor(null);
      return;
    }
    if (event.ctrlKey || event.metaKey || event.altKey || event.key.length !== 1) return;
    const surface = rightSurfaces.find((s) => s.shortcut === event.key.toUpperCase());
    if (!surface || !surfaceAvailable(surface)) return;
    event.preventDefault();
    event.stopPropagation();
    openRightSurfaceTab(surface.id);
  }

  function renderSurfaceList(itemClass: string) {
    return rightSurfaces.map((surface) => {
      const available = surfaceAvailable(surface);
      return (
        <li key={surface.id} role="none">
          <button
            type="button"
            role="menuitem"
            className={itemClass}
            onClick={() => openRightSurfaceTab(surface.id)}
            disabled={!available}
            title={available ? `${surface.title} (${surface.shortcut})` : `${surface.title} — open a project first`}
            aria-keyshortcuts={surface.shortcut}
          >
            <span className="right-surface-icon" aria-hidden="true">{surface.icon}</span>
            <span className="right-surface-label">{surface.title}</span>
            <kbd className="right-surface-key" aria-hidden="true">{surface.shortcut}</kbd>
          </button>
        </li>
      );
    });
  }

  function renderRightSurfacePicker() {
    return (
      <div className="right-surface-picker" tabIndex={-1} ref={focusOnMount} onKeyDown={handleSurfaceKey}>
        <div className="right-surface-picker-title" id="right-surface-picker-title">Open a surface</div>
        <ul className="right-surface-list" role="menu" aria-labelledby="right-surface-picker-title">
          {renderSurfaceList('right-surface-item')}
        </ul>
      </div>
    );
  }

  // The "+" menu portals to <body>: the sidebar is a backdrop-filtered card,
  // which would otherwise become the containing block of a fixed element.
  function renderSurfaceMenu() {
    if (!surfaceMenuAnchor) return null;
    const width = 240;
    const left = Math.max(8, Math.min(surfaceMenuAnchor.left, window.innerWidth - width - 8));
    return createPortal(
      <>
        <div className="right-surface-menu-scrim" onPointerDown={() => setSurfaceMenuAnchor(null)} />
        <ul
          className="right-surface-menu"
          role="menu"
          aria-label="Open a surface"
          tabIndex={-1}
          ref={focusOnMount}
          onKeyDown={handleSurfaceKey}
          style={{ top: surfaceMenuAnchor.bottom + 4, left, width, maxHeight: window.innerHeight - surfaceMenuAnchor.bottom - 16 }}
        >
          {renderSurfaceList('right-surface-item right-surface-menu-item')}
        </ul>
      </>,
      document.body,
    );
  }

  function renderRightTabPane(tab: RightSidebarTabItem) {
    // The single docked PreviewPanel serves every Browser tab; each tab
    // points it at its own preview page.
    if (tab.surface === 'preview') return null;
    const content = (RIGHT_NAVIGATOR_TOOLS as readonly string[]).includes(tab.surface)
      ? <SidebarContent key={activeProjectIdValue ?? 'no-project'} tab={tab.surface as RightNavigatorTool} />
      : <PanelHost id={tab.surface as RightTool} onClose={() => closeRightTab(tab)} />;
    return (
      <div key={tab.id} className="right-sidebar-tab-pane" hidden={tab.id !== activeRightTabId}>
        {content}
      </div>
    );
  }

  function renderRightUtilityPanel() {
    if (!rightSidebarOpen) return null;
    const showingBrowserTab = activeRightTab?.surface === 'preview';
    return (
      <aside
        className="right-utility-panel right-sidebar bento-card"
        style={{ width: rightDrawerWidthFit }}
        aria-label="Project tools"
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
        <header className={`drawer-header right-sidebar-header${rightTabs.length === 0 ? ' is-picker' : ''}`}>
          <div className="right-sidebar-tabs" role="tablist" aria-label="Open surfaces">
            {rightTabs.map((tab) => {
              const meta = surfaceMeta(tab.surface);
              const active = tab.id === activeRightTabId;
              return (
                <div
                  key={tab.id}
                  className={`right-sidebar-tab${active ? ' active' : ''}`}
                >
                  <button
                    type="button"
                    role="tab"
                    aria-selected={active}
                    className="right-sidebar-tab-btn"
                    onClick={() => activateRightTab(tab)}
                    onAuxClick={(event) => { if (event.button === 1) closeRightTab(tab); }}
                    title={meta.title}
                  >
                    <span className="right-sidebar-tab-icon" aria-hidden="true">{meta.icon}</span>
                    <span className="right-sidebar-tab-title">{meta.title}</span>
                  </button>
                  <button
                    type="button"
                    className="right-sidebar-tab-close"
                    onClick={() => closeRightTab(tab)}
                    title={`Close ${meta.title}`}
                    aria-label={`Close ${meta.title}`}
                  >
                    <XIcon />
                  </button>
                </div>
              );
            })}
          </div>
          {rightTabs.length > 0 && (
            <button
              type="button"
              className="right-sidebar-add-tab"
              onClick={(event) => {
                const rect = event.currentTarget.getBoundingClientRect();
                setSurfaceMenuAnchor((current) => (current ? null : rect));
              }}
              title="Open a surface"
              aria-label="Open a surface"
              aria-haspopup="menu"
              aria-expanded={surfaceMenuAnchor !== null}
            >
              <Icon><path d="M12 5v14M5 12h14" /></Icon>
            </button>
          )}
          <button
            className="drawer-close-btn"
            onClick={() => closeRightSidebar()}
            title="Close right sidebar"
            aria-label="Close right sidebar"
          >
            <XIcon />
          </button>
        </header>
        {renderSurfaceMenu()}
        <div className="drawer-body">
          {previewDockedOpen && (
            <div className="right-sidebar-preview" hidden={!showingBrowserTab}>
              <PreviewPanel />
            </div>
          )}
          {projectSwitching
            ? <div role="status">Loading project tools…</div>
            : rightTabs.length === 0
            ? renderRightSurfacePicker()
            : rightTabs.map(renderRightTabPane)}
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
    // Opening a panel while a pane is zoomed carries the zoom onto it, as
    // `focusRoom` does — otherwise Preview/Editor opened from the Tools menu
    // took a Split slot hidden behind the zoomed pane, or came up small.
    const carryZoom = open && zoomedRoom !== null && zoomedRoom !== id;
    const run = open && (carryZoom || willRetileSplit(id)) ? withStageRetile : withRoomTransition;
    run(() => {
      if (id === 'tasks' || id === 'sketch' || id === 'library') {
        setChatPanelRoom((current) => open ? id : current === id ? null : current);
      }
      const key = PANEL_VISIBILITY_KEYS[id];
      persistLayoutPatch({
        [key]: open,
        // This action opens a stage room. A closed sidebar Preview may retain
        // its old docking flag after the preference changes to Room.
        ...(id === 'preview' && open ? { previewDocked: false } : {}),
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
        if (carryZoom) setExpandedRoom(id);
        if (claimSplitSlot(id) || carryZoom) setFocusedRoom(id);
      } else if (focusedRoom === id) {
        setFocusedRoom(nextVisibleRoom(id));
      }
    });
  }

  function togglePanelRoom(id: AuxPanelId) {
    if (currentInteractionMode === 'chat' && (id === 'tasks' || id === 'sketch' || id === 'library')) {
      if (layoutState[PANEL_VISIBILITY_KEYS[id]] && activeChatPanel !== id) {
        setChatPanelRoom(id);
        focusRoom(id);
      } else {
        setPanelRoomOpen(id, activeChatPanel !== id);
      }
      return;
    }
    if (id === 'review') {
      toggleRightTool('review');
      return;
    }
    if (id === 'preview') {
      if (previewDockedOpen) {
        // Showing → close it; open but hidden behind another tab → show it.
        if (showingDockedPreview && rightSidebarOpen) {
          togglePreviewVisible();
          closeRightSidebar();
        }
        else showDockedPreview();
        return;
      }
      if (!layoutState.previewVisible && useSettingsStore.getState().previewPlacement === 'sidebar') {
        setPreviewDocked(true);
        return;
      }
    }
    const isOpen = Boolean(layoutState[PANEL_VISIBILITY_KEYS[id]]);
    if (isOpen && activeRoom !== id) {
      if (id === 'tasks' || id === 'sketch' || id === 'library') setChatPanelRoom(id);
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
    // Bringing a full-stage-only room on stage is the largest geometry change
    // there is — every other pane goes hidden and this one stretches over the
    // whole stage — so it takes the retile path in every mode, not just Split.
    if (isFullscreenRoom(id) && id !== forcedFullscreenRoom) return true;
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
      //
      // `zoomedRoom`, not `stageExpandedRoom`: only a zoom the user asked for is
      // carried. Tasks/Sketch are full-stage because of what they are, and
      // handing that on would make leaving Sketch for the terminal silently
      // zoom the terminal too — a mode the user never entered and would then
      // have to find their own way out of.
      if (zoomedRoom !== null && zoomedRoom !== id) setExpandedRoom(id);
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
    // A full-stage-only room takes no slot — it takes the whole stage. Letting
    // it into `splitSlots` would also evict a real pane at the cap to make room
    // for a tile that never renders.
    if (isFullscreenRoom(id)) return true;
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
      // "Show this too" cannot be honoured for a full-stage-only room — there is
      // no second pane to show it beside. It degrades to a plain focus, which
      // puts it on the stage whole.
      if (isFullscreenRoom(id)) {
        setFocusedRoom(id);
        return;
      }
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

  /**
   * Reconcile a remembered Split arrangement with rooms opened while another
   * layout was active. Focus and Agent/Fleet views can change the active room
   * without changing `splitSlots`, so restoring the old array alone can hide a
   * live agent that was opened in the meantime.
   */
  function reconcileSplitSlots(seed: RoomId[], focused: RoomId | null = focusedRoom): RoomId[] {
    const candidates = [
      ...(focused ? [focused] : []),
      ...openRooms.filter(isAgentRoomId),
      ...seed,
      ...openRooms,
    ];
    return Array.from(new Set(candidates))
      .filter((room) => openRooms.includes(room) && !isFullscreenRoom(room))
      .slice(0, SPLIT_MAX_PANES);
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
    // Restore the old arrangement, but merge in rooms opened while Agent mode
    // was active. Otherwise a newly opened agent remains live yet disappears
    // as soon as the previous Split slots are put back.
    const restoredSlots = reconcileSplitSlots(prev?.slots ?? [], prev?.focused ?? focusedRoom);
    withStageRetile(() => setSplitSlots(restoredSlots));
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

  /**
   * Split room arrangement is intentionally pointer-driven rather than HTML5
   * drag-and-drop. Tauri's WebView2 file-drop bridge disables the browser DnD
   * pipeline, while pointer capture keeps a room header draggable even when the
   * cursor crosses another pane or leaves the stage.
   */
  function findStagePane(room: RoomId): HTMLElement | null {
    const stage = roomsTableRef.current;
    if (!stage) return null;
    return Array.from(stage.querySelectorAll<HTMLElement>('.stage-pane[data-room-id]'))
      .find((pane) => pane.dataset.roomId === room) ?? null;
  }

  function beginRoomDrag(id: RoomId, event: React.PointerEvent<HTMLElement>) {
    if (
      event.button !== 0 ||
      activeChatPanel !== null ||
      ambientLayout !== 'gallery' ||
      stageExpandedRoom !== null ||
      splitRooms.length < 2 ||
      (event.target as HTMLElement).closest('.room-actions') ||
      // React bubbles events from a portal through its React parent, so a press
      // in a menu portaled out of the header (the "+" agent menu) lands here
      // too. Capturing it would steal the pointerup and the item's click.
      !event.currentTarget.contains(event.target as Node)
    ) {
      return;
    }

    roomDragClickGuardRef.current = false;
    roomDragRef.current = {
      id,
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      moved: false,
      overRoom: null,
    };
    event.currentTarget.setPointerCapture(event.pointerId);
    setDraggingRoom(id);
  }

  function moveRoomDrag(event: React.PointerEvent<HTMLElement>) {
    const drag = roomDragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;

    const deltaX = event.clientX - drag.startX;
    const deltaY = event.clientY - drag.startY;
    if (!drag.moved && Math.hypot(deltaX, deltaY) < 6) return;
    drag.moved = true;
    event.preventDefault();

    const pane = findStagePane(drag.id);
    if (pane) {
      pane.style.transform = `translate3d(${deltaX}px, ${deltaY}px, 0)`;
      pane.style.zIndex = '20';
    }

    const candidate = document.elementsFromPoint(event.clientX, event.clientY)
      .map((element) => element.closest<HTMLElement>('.stage-pane[data-room-id]'))
      .find((pane) => pane && pane.dataset.roomId !== drag.id)
      ?.dataset.roomId;
    const nextOver = candidate && candidate !== drag.id && isKnownRoomId(candidate) && splitRooms.includes(candidate)
      ? candidate
      : null;
    if (drag.overRoom !== nextOver) {
      drag.overRoom = nextOver;
      setDragOverRoom(nextOver);
    }
  }

  function endRoomDrag(event: React.PointerEvent<HTMLElement>) {
    const drag = roomDragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;

    const pane = findStagePane(drag.id);
    if (pane) {
      pane.style.transform = '';
      pane.style.zIndex = '';
    }

    if (drag.moved) {
      roomDragClickGuardRef.current = true;
      window.setTimeout(() => {
        roomDragClickGuardRef.current = false;
      }, 320);
    }

    if (drag.moved && drag.overRoom) {
      const from = splitRooms.indexOf(drag.id);
      const to = splitRooms.indexOf(drag.overRoom);
      if (from >= 0 && to >= 0 && from !== to) {
        const next = [...splitRooms];
        [next[from], next[to]] = [next[to], next[from]];
        withStageRetile(() => setSplitSlots(next));
      }
    }

    roomDragRef.current = null;
    setDraggingRoom(null);
    setDragOverRoom(null);
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
  }



  function minimizeRoom(id: RoomId) {
    if (activeChatPanel === id) {
      return;
    }
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
    if (currentInteractionMode === 'chat' && isFullscreenRoom(id) && activeChatPanel !== id) return;
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
  const tasksItem: ActivityItem = {
    id: 'tasks',
    title: 'Tasks',
    active: currentInteractionMode === 'chat' ? activeChatPanel === 'tasks' : layoutState.tasksVisible && activeRoom === 'tasks',
    onClick: () => togglePanelRoom('tasks'),
    icon: <Icon><rect x="3" y="3" width="5" height="18" rx="1" /><rect x="10" y="3" width="5" height="12" rx="1" /><rect x="17" y="3" width="5" height="8" rx="1" /></Icon>,
  };

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
      id: 'http',
      title: 'HTTP Client',
      active: layoutState.httpVisible,
      onClick: () => toggleHttpVisible(),
      icon: <Icon><path d="M22 12h-4l-3 9L9 3l-3 9H2" /></Icon>,
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


  // The "+" launcher's quick items, above the agent list: open the Editor,
  // or add a shell to the Terminal room. (The full Spawn Agents picker stays
  // reachable from the command palette.)
  const launcherItems: LauncherItem[] = [
    {
      id: 'editor',
      label: 'Editor',
      icon: <Icon><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7" /><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z" /></Icon>,
      onSelect: () => {
        if (layoutState.editorVisible) focusRoom('editor');
        else setPanelRoomOpen('editor', true);
      },
    },
    {
      id: 'terminal',
      label: 'Terminal',
      icon: <Icon><rect x="2" y="3" width="20" height="18" rx="3" /><polyline points="8,9 4,12 8,15" /><line x1="12" y1="15" x2="20" y2="15" /></Icon>,
      onSelect: () => {
        setTerminalRoomOpen(true);
        focusRoom('terminal');
        // Always a new shell. An empty grid goes through the same claim the
        // panel's own auto-open uses, so the two cannot both create one.
        const pa = get(paneAssignments);
        if (pa.some((id) => id !== null)) void createTerminalSession();
        else if (claimStartupShell(activeProjectIdValue)) void createTerminalSession();
      },
    },
  ];

  // Opens the in-app Sketch room. It used to load excalidraw.com in a Preview
  // browser tab through the embedding proxy; the drawing canvas is native now,
  // so it is an ordinary room launcher like every other entry in this group.
  const sketchItem: ActivityItem = {
    id: 'sketch',
    title: 'Sketch',
    active: currentInteractionMode === 'chat' ? activeChatPanel === 'sketch' : layoutState.sketchVisible && activeRoom === 'sketch',
    onClick: () => togglePanelRoom('sketch'),
    icon: <Icon><path d="M12 20h9" /><path d="M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4 9.5-9.5z" /></Icon>,
  };

  // The project's generated images (`<project>/generations`), each one
  // editable through an image provider, the chat, or a running agent.
  const libraryItem: ActivityItem = {
    id: 'library',
    title: 'Library',
    active: currentInteractionMode === 'chat' ? activeChatPanel === 'library' : layoutState.libraryVisible && activeRoom === 'library',
    onClick: () => togglePanelRoom('library'),
    icon: <Icon><rect x="3" y="3" width="18" height="18" rx="2" /><circle cx="8.5" cy="8.5" r="1.5" /><path d="m21 15-5-5L5 21" /></Icon>,
  };

  // Command-palette launchers for the left project rail.
  const leftNavDockItems: ActivityItem[] = leftDrawerTools.map((tool) => ({
    id: tool,
    title: LEFT_TOOL_META[tool].title,
    active: leftActiveTool === tool,
    onClick: () => toggleLeftTool(tool),
    icon: LEFT_TOOL_META[tool].icon,
  }));
  const rightNavigatorItems: ActivityItem[] = rightNavigatorTools.map((tool) => ({
    id: tool,
    title: LEFT_TOOL_META[tool].title,
    active: !rightDrawerOpen && rightNavigatorTool === tool,
    onClick: () => selectRightNavigatorTool(tool),
    icon: LEFT_TOOL_META[tool].icon,
  }));

  // Launcher entries for the right utility drawer's tools (incl. Orchestrator) —
  // the palette's Utilities group.
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

  // Room and utility launchers, grouped for the command palette.
  const toolMenuGroups: ToolMenuGroup[] = [
    { id: 'rooms', label: 'Rooms', items: roomLauncherItems },
    {
      id: 'utilities',
      label: 'Utilities',
      items: [...rightNavigatorItems, ...drawerToolItems],
    },
  ].filter((group) => group.items.length > 0);
  // Keep Editor, Terminal and Preview available directly from the prompt bar.
  // Preview uses the saved opening destination; utilities stay in the sidebar.
  const roomShortcutItems = panelItems.filter((item) => item.id === 'editor' || item.id === 'terminal' || item.id === 'preview');
  const paletteToolGroups: ToolMenuGroup[] = [
    { id: 'projects', label: 'Projects', items: leftNavDockItems },
    { id: 'workspace-tools', label: 'Project tools', items: rightNavigatorItems },
    ...toolMenuGroups,
  ];

  // Layout actions stay as bare icons in the prompt bar: they are pressed
  // constantly while arranging panes, so a popover round-trip would cost more
  // than the chrome they take up. Adding agents lives in the "+" launcher.
  const isExpanded = stageExpandedRoom !== null;
  const inSplit = ambientLayout === 'gallery';
  const layoutActionItems: ActivityItem[] = [
    {
      id: 'split',
      title: forcedFullscreenRoom
        ? `Leave ${roomTitle(forcedFullscreenRoom)} and go back to the panes`
        : isExpanded
          ? 'Restore split grid'
          : inSplit
            ? 'Split: add a pane'
            : 'Split: tile panels',
      active: inSplit && !isExpanded,
      onClick: () => {
        // Four states, and the button has to tell them apart. It used to
        // conflate the middle two: it only ever edited `splitSlots`, and Focus
        // renders the active room alone and ignores that list entirely — so
        // pressing Split outside Split re-tiled a stage nobody was looking at
        // and the screen did not move. Entering the mode is what makes it
        // "actually go to split", and it is what the old room dock did before
        // the Tools menu replaced it.
        //
        // The full-stage-only case has to be tested FIRST, and for the same
        // "screen did not move" reason. Tasks/Sketch are expanded by derivation,
        // so `setStageExpansion(null)` cannot dismiss them — it clears
        // `expandedRoom`, which they were never in. Leaving one of these rooms
        // means focusing a room that does tile.
        if (forcedFullscreenRoom) {
          const next = visibleRooms.find(
            (room) => room !== forcedFullscreenRoom && !isFullscreenRoom(room),
          );
          if (!next) {
            showToast('No other panes open', 'info');
            return;
          }
          focusRoom(next);
        } else if (isExpanded) {
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
    for (const group of paletteToolGroups) {
      for (const item of group.items) bridge[`tools.${group.id}.${item.id}`] = item.onClick;
    }
    for (const item of layoutActionItems) bridge[`layout.${item.id}`] = item.onClick;
  });

  // Re-register only when an id, title, or category actually changes — these
  // arrays are rebuilt every render, and rewriting the store each time would
  // churn every palette subscriber.
  const paletteSignature = [
    ...paletteToolGroups.flatMap((g) => g.items.map((i) => `${g.id}.${i.id}:${i.title}`)),
    ...layoutActionItems.map((i) => `layout.${i.id}:${i.title}`),
  ].join('|');

  useEffect(() => {
    for (const group of paletteToolGroups) {
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
      { tab: 'orchestrator', name: 'Settings: Orchestrator' },
      { tab: 'stats', name: 'Settings: Usage' },
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
    // The DeepSeek room reads like an agent room: its assistant name here,
    // the product in `roomKind` above it.
    if (id === 'deepseek' && project?.root_path) {
      return deepSeekAgentName(
        deepSeekPanelRoot(deepSeekPlacementState, project.id, project.root_path),
        allTerminalSessions.map((entry) => entry.agentName ?? '').filter(Boolean),
      );
    }
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
      // The product ("Claude Code", "Codex"), not the raw launch command.
      const session = getAgentSessionForRoom(id);
      return getAgentDisplayName(session?.agentPreset) ?? 'agent';
    }
    if (id === 'terminal' || id === 'dev-terminal') return 'terminal';
    if (id === 'workspace') return layoutState.sidebarTab;
    if (id === 'deepseek') return 'DeepSeek Harness';
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
      case 'library':
        return <Icon><rect x="3" y="3" width="18" height="18" rx="2" /><circle cx="8.5" cy="8.5" r="1.5" /><path d="m21 15-5-5L5 21" /></Icon>;
    case 'toolbox':
      return <Icon><path d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.76 3.76z" /></Icon>;
    case 'fleet':
      return <Icon><path d="M14 2H6.5A1.5 1.5 0 0 0 5 3.5v17A1.5 1.5 0 0 0 6.5 22h11a1.5 1.5 0 0 0 1.5-1.5V7Z" /><path d="M14 2v5h5" /><path d="M12 11.5v4" /><path d="M10 13.5h4" /><path d="M10 18.5h4" /></Icon>;
    case 'mobile':
      return <Icon><rect x="6" y="2" width="12" height="20" rx="2.5" /><path d="M10.5 18.5h3" /></Icon>;
    case 'env':
      return <Icon><path d="M12 2 4 6v6c0 5 3.4 8.3 8 10 4.6-1.7 8-5 8-10V6l-8-4z" /><path d="M9.5 12.2l1.8 1.8 3.4-3.6" /></Icon>;
    case 'deepseek':
      return <AgentBrandMark command="dsh" name="DeepSeek Harness" />;
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
                {/* A room kept mounted only for OTHER projects' shells parks the
                    active project's panel too, so a closed room never auto-opens
                    a shell. */}
                <TerminalPanel projectId={pid} isActiveProject={pid === activeProjectIdValue && terminalRoomOpen} />
              </div>
            ))
          ) : (
            <div className="terminal-project-layer">
              <TerminalPanel />
            </div>
          )}
        </div>
      );
    }
    if (id === 'dev-terminal') {
      return (
        <div className="terminal-room-body dev-terminal">
          {terminalHostProjectIds.length > 0 ? (
            terminalHostProjectIds.map((pid) => (
              <div
                key={pid}
                className={`terminal-project-layer${pid === activeProjectIdValue ? '' : ' parked'}`}
                inert={pid !== activeProjectIdValue}
              >
                <TerminalPanel
                  devMode={true}
                  projectId={pid}
                  isActiveProject={pid === activeProjectIdValue && devTerminalRoomOpen}
                />
              </div>
            ))
          ) : (
            <div className="terminal-project-layer">
              <TerminalPanel devMode={true} />
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
    const isThisExpanded = stageExpandedRoom === id || activeChatPanel === id;
    // Tasks and Sketch have no grid to restore to, so they get no zoom control
    // at all — a restore button that put the room back exactly where it already
    // was would read as broken. Minimize and Close still get you out.
    const isThisForcedFullscreen = forcedFullscreenRoom === id || activeChatPanel === id;
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
        }${draggingRoom === id ? ' room-dragging' : ''}`}
        data-room-id={id}
        style={{ viewTransitionName: `spacron-room-${id.replace(/[^a-zA-Z0-9_-]/g, '-')}` } as React.CSSProperties}
        // Capture phase, and a ref rather than state: this fires on every click
        // and focus inside a pane (xterm included), so it must not re-render the
        // room subtree — remounting a live TerminalPane is the bug documented in
        // `.spacron/memory/terminal-pane-lifetime.md`.
        onMouseDownCapture={() => { lastInteractedRoomRef.current = id; }}
        onFocusCapture={() => { lastInteractedRoomRef.current = id; }}
        onPointerEnter={() => hoveredStageRoom.set(id)}
        onPointerLeave={() => hoveredStageRoom.update((current) => current === id ? null : current)}
      >
        <header
          className="room-header"
          onPointerDown={(event) => beginRoomDrag(id, event)}
          onPointerMove={moveRoomDrag}
          onPointerUp={endRoomDrag}
          onPointerCancel={endRoomDrag}
        >
          {activeChatPanel === id && (
            <button
              type="button"
              className="room-action chat-panel-back"
              onClick={() => setChatPanelRoom(null)}
              title="Back to chat"
              aria-label="Back to chat"
            >
              <Icon><path d="m12 19-7-7 7-7" /><path d="M5 12h14" /></Icon>
            </button>
          )}
          <button
            className={`room-title${agentSession || roomGlyph ? ' has-brand' : ''}`}
            onClick={() => {
              if (roomDragClickGuardRef.current) {
                roomDragClickGuardRef.current = false;
                return;
              }
              if (activeChatPanel !== id) focusRoom(id);
            }}
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
            {/* DeepSeek Harness is an agent too, but its room is a web panel
                with no agent session behind it. */}
            {(agentSession || id === 'deepseek' || id === 'terminal' || id === 'dev-terminal') && (
              <AgentQuickAdd
                className="room-action"
                title={agentSession || id === 'deepseek' ? 'Add another agent' : 'Add an agent'}
                items={launcherItems}
                // An agent's "+" starts the new agent in that agent's worktree
                // (master, or the worktree it works in).
                launchFrom={agentSession ? agentSession.worktree?.path ?? agentSession.cwd ?? null : undefined}
              />
            )}
            {isThisForcedFullscreen ? null : isThisExpanded ? (
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
            {activeChatPanel !== id && <button className="room-action" onClick={() => minimizeRoom(id)} title="Minimize" aria-label={`Minimize ${title}`}>
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round">
                <path d="M5 12h14" />
              </svg>
            </button>}
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
    // The immediate switch signal already sends the PTY repaint kick. Keep
    // this trailing backstop refit-only so a 360 ms settle pass cannot make a
    // second visible SIGWINCH/flicker in a live agent TUI.
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
      if (nextLayout === 'gallery') {
        // Focus/agent mode can change the active room without touching the
        // Split arrangement. Reconcile here so returning to Split never loses
        // a panel that was opened while the user was focused on another one.
        // Agents get priority because they are the live rooms the agent view
        // is expected to carry across; the existing slot order remains the
        // stable order for everything else.
        setSplitSlots(reconcileSplitSlots(splitSlots, saved.focused));
      }
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
      notifyPanesResized(true);

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

  function renderAmbientLayout() {
    const isSplit = ambientLayout === 'gallery';
    const isExpanded = activeChatPanel !== null || stageExpandedRoom !== null;

    // The terminal rooms also stay mounted (hidden, off the stage) while another
    // project still has a live shell in them: the room is per project, and
    // unmounting it because the project you switched TO has it closed would
    // dispose every other project's parked xterm with it.
    const persistentStageRooms: RoomId[] = [
      ...(['terminal', 'dev-terminal', 'preview', 'sketch', 'deepseek'] as RoomId[]).filter((room) =>
        openRooms.includes(room) || activeChatPanel === room ||
        (room === 'terminal' && backgroundShellProjects.terminal.length > 0) ||
        (room === 'dev-terminal' && backgroundShellProjects.dev.length > 0),
      ),
      ...Array.from(new Set([...openRooms.filter(isAgentRoomId), ...mountedAgentRoomIds])).sort(
        (a, b) => getAgentRoomSessionId(a) - getAgentRoomSessionId(b),
      ),
    ];

    const stageRooms: RoomId[] = activeChatPanel
      ? [activeChatPanel]
      : stageExpandedRoom
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

    // Agent startup belongs to the active project. A workspace can exist as a
    // collection before it has a project, and that view must remain blank.
    const emptyStageMessage = stageRooms.length === 0 && project && !projectSwitching ? 'No open panes' : null;
    const stageIsVacant = stageRooms.length === 0;

    const activePreset = resolvePreset(splitPresets[stageRooms.length], stageRooms.length);
    const { className: stagePresetClass, style: stagePresetStyle } =
      !isExpanded && isSplit
        ? getSplitStageStyle(activePreset, stageRooms.length)
        : { className: '', style: undefined };

    const expandedRoomOptions = isExpanded
      ? visibleRooms.map((room) => ({
          value: room,
          label: roomTitle(room),
          sublabel: room === stageExpandedRoom ? 'Expanded' : roomKind(room),
        }))
      : [];

    const stageModifier = isExpanded
      ? ' stage-expanded'
      : isSplit
        ? ` ${stagePresetClass}`
        : '';
    const openAgentCount = openRooms.filter(isAgentRoomId).length;
    const isAgentMode = fleetArrangementActive && openAgentCount > 0;
    const layoutCountLabel = isAgentMode
      ? `${openAgentCount} agent${openAgentCount === 1 ? '' : 's'} open`
      : isExpanded
        ? `1 of ${visibleRooms.length} expanded`
        : `${stageRooms.length} of ${SPLIT_MAX_PANES} panels`;
    const layoutCountCompact = isAgentMode
      ? `${openAgentCount}`
      : isExpanded
        ? `1/${visibleRooms.length}`
        : `${stageRooms.length}/${SPLIT_MAX_PANES}`;

    function stagePaneProps(room: RoomId) {
      const hidden = !stageRoomSet.has(room);
      const index = stageRooms.indexOf(room);
      const paneStyle =
        !hidden && !isExpanded && isSplit
          ? getSplitPaneStyle(activePreset, index, stageRooms.length)
          : undefined;
      return {
        className: `stage-pane${hidden ? ' stage-hidden' : ''}${draggingRoom === room ? ' room-dragging' : ''}${dragOverRoom === room ? ' room-drag-over' : ''}`,
        style: hidden ? undefined : paneStyle,
      };
    }

    return (
      <>
        {((isExpanded || isSplit) && visibleRooms.length > 0) && layoutControlHost && createPortal(
          <div
            className={`split-layout-control${isExpanded ? ' expanded-layout-control' : ''}`}
            aria-label={isExpanded ? 'Expanded panel controls' : 'Split layout controls'}
          >
            <span className="split-layout-mode-label">{isAgentMode ? 'Agents' : isSplit ? 'Split' : 'Focus'}</span>
            <span className="split-layout-count" aria-label={isAgentMode ? layoutCountLabel : `${stageRooms.length} of ${SPLIT_MAX_PANES} panels open`}>
              <span className="split-layout-count-full">{layoutCountLabel}</span>
              <span className="split-layout-count-compact">
                {layoutCountCompact}
              </span>
            </span>
            {isExpanded ? (
              expandedRoomOptions.length > 1 && (
                <div className="split-expanded-room-picker">
                  <Dropdown
                    options={expandedRoomOptions}
                    value={stageExpandedRoom ?? ''}
                    onChange={(room) => focusRoom(room as RoomId)}
                    ariaLabel="Change expanded panel"
                    direction="up"
                  />
                </div>
              )
            ) : stageRooms.length >= 2 ? (
              <SplitLayoutPicker
                count={stageRooms.length}
                activePreset={activePreset}
                onSelectPreset={(presetId) => {
                  withStageRetile(() => {
                    setSplitPresets((prev) => ({
                      ...prev,
                      [stageRooms.length]: presetId,
                    }));
                  });
                }}
              />
            ) : null}
          </div>,
          layoutControlHost,
        )}
        <div
          className={`focused-room stage-layers${stageModifier}${stageExpansionMotion ? ` stage-${stageExpansionMotion}` : ''}${stageIsVacant ? ' empty-stage' : ''}`}
          style={!isExpanded && isSplit ? stagePresetStyle : undefined}
          aria-label={emptyStageMessage ?? undefined}
        >
          {projectVeiled && (
            <div className="project-switch-status" role="status">
              {switchingPhase ?? 'Opening project…'}
            </div>
          )}
          {/* A project's stage is simply empty once everything is closed (it
              opens on a terminal); only with no project is there a prompt. */}
          {stageIsVacant && !project && (
            <div className="stage-empty-cta">
              <strong className="stage-empty-title">Spacron</strong>
              <span className="stage-empty-copy">
                Open a project folder or select one from the left sidebar to start working.
              </span>
              <button
                type="button"
                className="stage-empty-agent-btn"
                onClick={() => void openProject()}
                aria-label="Open project"
              >
                <Icon><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z" /></Icon>
                <span>Open Project</span>
              </button>
            </div>
          )}
          {persistentStageRooms.map((room) => {
            const { className, style } = stagePaneProps(room);
            return (
              <div key={room} className={className} style={style} data-room-id={room}>
                {renderRoomFrame(room, true)}
              </div>
            );
          })}
          {nonPersistentStageRooms.map((room) => {
            const { className, style } = stagePaneProps(room);
            return (
              <div key={room} className={className} style={style} data-room-id={room}>
                {renderRoomFrame(room, true)}
              </div>
            );
          })}
        </div>
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
        {/* Keep every workspace pane mounted and measured while Settings covers
            it; inert prevents focus and interaction with the hidden workspace. */}
        <div className="zoom-content" inert={isSettingsOpen} aria-hidden={isSettingsOpen || undefined}>
        <div className={`workspace-layer${currentInteractionMode === 'chat' ? ' interaction-chat' : ''}`}>
            <div
              className={`app-body rooms-workspace${resizing ? ' resizing' : ''}`}
              style={{
                // Room left above the floating bar: its measured row plus a
                // small gap (10px between the panels and the bar).
                '--overlay-clear': `${overlaysHeight + 4}px`,
                '--left-nav-space': `${leftDrawerOpen ? leftPanelWidthFit + 20 : 0}px`,
                '--right-drawer-space': `${
                  rightSidebarOpen ? rightDrawerWidthFit + 20 : 0
                }px`,
              } as React.CSSProperties}
            >
              {resizing && <div className={`resize-overlay${auxRowResizing ? ' row-resize' : ''}`} />}

              <div className="rooms-content-horizontal">
                {renderLeftUtilityPanel()}

                <main ref={roomsTableRef} className={`rooms-table ambient-${ambientLayout}${layoutSwitching ? ' layout-switching' : ''}${projectVeiled ? ' project-veiled' : projectVeil === 'reveal' ? ' project-revealing' : ''}${currentInteractionMode === 'chat' ? ' interaction-chat' : ''}${activeChatPanel ? ' chat-tool-open' : ''}${
                  (ambientLayout === 'preview' && visibleRooms.filter((room) => room === 'terminal' || isAgentRoomId(room)).length === 0) ||
                  (ambientLayout === 'development' && visibleRooms.filter((room) => room === 'dev-terminal' || isAgentRoomId(room)).length === 0)
                    ? ` ${ambientLayout}-solo`
                    : ''
                }`} aria-label="Spacron ambient layout">
                  <div className="cli-mode-layer" inert={currentInteractionMode === 'chat' && !activeChatPanel} aria-hidden={currentInteractionMode === 'chat' && !activeChatPanel || undefined}>
                    {renderAmbientLayout()}
                  </div>
                  {currentInteractionMode === 'chat' && (
                    <div className="chat-mode-layer" inert={Boolean(activeChatPanel)} aria-hidden={Boolean(activeChatPanel) || undefined}>
                      <ChatModePanel />
                    </div>
                  )}
                </main>

                {renderRightUtilityPanel()}
              </div>

              {/* Minimalist room stack anchored at workspace level — independent of sidebar toggle */}
              {currentInteractionMode === 'cli' && renderMinimizedRooms()}

              <div ref={overlaysRef} className="workspace-overlays">
              {/* The room dock used to sit here as its own strip. Its layout
                  actions and the Editor/Terminal launchers now sit in the
                  prompt bar; the other launchers are right-sidebar tabs. */}
              <div ref={setLayoutControlHost} className="stage-layout-control-host" />
              <div className="composer-strip">
                <FloatingPromptBar
                  trailingControls={
                    <div className="prompt-trailing">
                      {layoutActionItems.map((item) => <ActivityButton key={item.id} item={item} />)}
                      <div className="prompt-trailing-separator" />
                      {roomShortcutItems.map((item) => <ActivityButton key={item.id} item={item} />)}
                    </div>
                  }
                />
              </div>
              </div>
            </div>
          </div>
        </div>

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

      </div>
    </div>
  );
}
