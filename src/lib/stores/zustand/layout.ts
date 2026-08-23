import { create } from 'zustand';
import type { LayoutState, ActiveView, SidebarTab, SettingsTab } from '$lib/types/layout';
import { loadJson } from '$lib/utils/storage';
import { requestRoomControl } from '../layoutControl';

export type { ActiveView, SidebarTab };

const VALID_ACTIVE_VIEWS = new Set<ActiveView>(['editor', 'terminal', 'preview', 'settings', 'review', 'http', 'tasks', 'orchestrator', 'db', 'containers', 'toolbox', 'youtube', 'env', 'fleet', 'mobile']);
// No 'review': a persisted 'review' tab from an older build fails this check and
// falls back, which is exactly the migration we want.
const VALID_SIDEBAR_TABS = new Set<SidebarTab>(['projects', 'files', 'search', 'git', 'snapshots', 'history', 'snippets', 'problems']);

export function sanitiseActiveView(v: unknown, fallback: ActiveView = 'terminal'): ActiveView {
  return VALID_ACTIVE_VIEWS.has(v as ActiveView) ? (v as ActiveView) : fallback;
}

export function sanitiseSidebarTab(v: unknown, fallback: SidebarTab = 'files'): SidebarTab {
  return VALID_SIDEBAR_TABS.has(v as SidebarTab) ? (v as SidebarTab) : fallback;
}

const LAYOUT_KEY = 'spacron_layout';

const defaultLayout: LayoutState = {
  sidebarVisible: true,
  sidebarWidth: 310,
  activeView: 'terminal',
  lastAuxView: 'preview',
  editorSplitPreview: false,
  sidebarTab: 'files',
  editorVisible: false,
  previewVisible: false,
  reviewVisible: false,
  httpVisible: false,
  tasksVisible: false,
  fleetVisible: false,
  orchestratorVisible: false,
  dbVisible: false,
  containersVisible: false,
  toolboxVisible: false,
  envVisible: false,
  youtubeVisible: false,
  mobileVisible: false,
  sketchVisible: false,
  auxPanelWidth: 550,
  auxEditorHeight: 50,
  leftPanelWidth: 310,
  rightDrawerWidth: 380,
};

// The right utility drawer hosts the "summoned tool" panels. They are mutually
// exclusive among themselves (one drawer body at a time) but, unlike the aux
// rooms, opening one does NOT disturb the main rooms (editor/preview/etc.) or
// the active view — the drawer is a right-edge overlay you pop open and dismiss.
// Order here is the drawer's TAB order, not its precedence — Fleet leads because
// it is the panel you keep open while agents run.
export const RIGHT_DRAWER_TOOLS = ['fleet', 'toolbox', 'http', 'db', 'containers', 'env', 'mobile'] as const;
export type RightDrawerTool = (typeof RIGHT_DRAWER_TOOLS)[number];

// The tools whose open state is a persisted aux flag on LayoutState. 'env' is
// handled separately — its open state is the transient `envManagerOpen` flag
// (kept in sync below so the drawer stays single-body).
const AUX_DRAWER_FLAGS: Record<Exclude<RightDrawerTool, 'env'>, keyof LayoutState> = {
  fleet: 'fleetVisible',
  toolbox: 'toolboxVisible',
  http: 'httpVisible',
  db: 'dbVisible',
  containers: 'containersVisible',
  mobile: 'mobileVisible',
};

/** Show exactly one right-drawer tool (or none), clearing every other one.
 *  Touches ONLY the drawer's backing flags — `activeView` is deliberately left
 *  alone so this can restore a project's drawer without also dictating which
 *  room is on stage (see `applyRightDrawerTool`). */
function showRightDrawerTool(l: LayoutState, tool: RightDrawerTool | null): LayoutState {
  const next: LayoutState = { ...l };
  for (const t of Object.keys(AUX_DRAWER_FLAGS) as Array<Exclude<RightDrawerTool, 'env'>>) {
    (next as unknown as Record<string, boolean>)[AUX_DRAWER_FLAGS[t]] = t === tool;
  }
  // `env` carries TWO flags that must move together — `envManagerOpen` is what
  // the drawer body reads, `envVisible` is its aux-room flag. Setting one and
  // not the other is the desync that leaves a ghost Env panel behind.
  next.envVisible = tool === 'env';
  (next as unknown as Record<string, boolean>).envManagerOpen = tool === 'env';
  if (tool && tool !== 'env') next.lastAuxView = tool;
  return next;
}

/**
 * Which right-drawer tool is currently showing, or null. THE single definition
 * of that precedence — the drawer UI, per-project save and per-project restore
 * all read it here, so a tool can never be persisted as closed while the drawer
 * still paints it (or the reverse).
 */
export function rightDrawerToolOf(l: {
  toolboxVisible: boolean;
  httpVisible: boolean;
  dbVisible: boolean;
  containersVisible: boolean;
  envManagerOpen: boolean;
  mobileVisible: boolean;
  fleetVisible: boolean;
}): RightDrawerTool | null {
  if (l.toolboxVisible) return 'toolbox';
  if (l.httpVisible) return 'http';
  if (l.dbVisible) return 'db';
  if (l.containersVisible) return 'containers';
  if (l.envManagerOpen) return 'env';
  if (l.mobileVisible) return 'mobile';
  // Last on purpose. `fleetVisible` is opened by things other than the drawer's
  // own tab strip (tiling all agents), so ranking it above the tools would let a
  // leftover flag shadow the tool the user just clicked.
  if (l.fleetVisible) return 'fleet';
  return null;
}

/** Narrow the loose string a persisted project state carries back to a tool. */
export function sanitiseRightDrawerTool(v: unknown): RightDrawerTool | null {
  return typeof v === 'string' && (RIGHT_DRAWER_TOOLS as readonly string[]).includes(v)
    ? (v as RightDrawerTool)
    : null;
}

function loadLayout(): LayoutState {
  if (typeof window === 'undefined') return defaultLayout;
  try {
    const stored = loadJson<LayoutState | null>(LAYOUT_KEY, null);
    if (!stored) return defaultLayout;
    const parsed = { ...defaultLayout, ...stored } as LayoutState;
    if ((parsed.sidebarTab as string) === 'notes') parsed.sidebarTab = 'files';
    if ((parsed.sidebarTab as string) === 'http') parsed.sidebarTab = 'files';
    if ((parsed.sidebarTab as string) === 'tasks') parsed.sidebarTab = 'files';
    if ((parsed.sidebarTab as string) === 'runs') parsed.sidebarTab = 'files';
    if (parsed.auxPanelWidth < 180) parsed.auxPanelWidth = 180;
    return parsed;
  } catch {
    return defaultLayout;
  }
}

function persistLayout(val: LayoutState) {
  if (typeof window !== 'undefined') {
    localStorage.setItem(LAYOUT_KEY, JSON.stringify(val));
  }
}

interface LayoutActions {
  setActiveView: (view: ActiveView) => void;
  showTerminal: () => void;
  toggleSidebar: () => void;
  setSidebarVisible: (visible: boolean) => void;
  toggleEditorVisible: () => void;
  togglePreviewVisible: () => void;
  toggleReviewVisible: () => void;
  toggleHttpVisible: () => void;
  toggleTasksVisible: () => void;
  toggleFleetVisible: () => void;
  toggleDbVisible: () => void;
  toggleContainersVisible: () => void;
  toggleToolboxVisible: () => void;
  setRightDrawerTool: (tool: RightDrawerTool | null) => void;
  setLeftPanelWidth: (width: number) => void;
  setRightDrawerWidth: (width: number) => void;
  toggleYoutubeVisible: () => void;
  toggleOrchestratorVisible: () => void;
  toggleMobileVisible: () => void;
  toggleTerminal: () => void;
  setSidebarTab: (tab: SidebarTab) => void;
  toggleSidebarTab: (tab: SidebarTab) => void;
  toggleEditorSplitPreview: () => void;
  revealPreview: () => void;
  setSidebarWidth: (width: number) => void;
  resetLayoutToDefault: () => void;
  /** Merge a partial layout patch into the store and persist it. Used to
   *  restore a project's saved view/panels when switching projects. */
  applyLayoutState: (patch: Partial<LayoutState>) => void;
  /** Restore the right drawer to `tool` (or closed) WITHOUT touching
   *  `activeView`. `setRightDrawerTool` forces the stage to the tool's room (or
   *  back to the terminal), which is right for a click but wrong for a project
   *  switch — there the stage comes from the project's own saved arrangement. */
  applyRightDrawerTool: (tool: RightDrawerTool | null) => void;
  openSettings: (tab?: SettingsTab) => void;
  closeSettings: () => void;
  openQuickCapture: () => void;
  closeQuickCapture: () => void;
  openEnvManager: () => void;
  closeEnvManager: () => void;
  openAgentSpawn: () => void;
  closeAgentSpawn: () => void;
  settingsOpen: boolean;
  /** Section to open Settings on; null means "wherever it was last left". */
  settingsInitialTab: SettingsTab | null;
  quickCaptureOpen: boolean;
  envManagerOpen: boolean;
  agentSpawnOpen: boolean;
}

// Maps each aux ActiveView to its visibility flag. Adding a panel here wires it
// into restore (toggleTerminal), single-panel clearing, and lastAuxView handling.
const AUX_VIEW_FLAGS = {
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
  // NOTE: `youtube` is intentionally NOT listed here. It is a free-floating
  // pop-up window (see FloatingYouTube), not an aux room — keeping it out of the
  // aux-flag system means opening another panel never force-closes it, and the
  // window survives ambient mode switches. Its `youtubeVisible` flag is toggled
  // independently by `toggleYoutubeVisible`.
  mobile: 'mobileVisible',
  sketch: 'sketchVisible',
} as const satisfies Partial<Record<ActiveView, keyof LayoutState>>;

type AuxView = keyof typeof AUX_VIEW_FLAGS;
const AUX_FLAGS = Object.values(AUX_VIEW_FLAGS) as (keyof LayoutState)[];

/** All aux-panel flags cleared to false — spread before setting the one you want. */
function clearedAuxFlags(): Record<string, boolean> {
  const out: Record<string, boolean> = {};
  for (const flag of AUX_FLAGS) out[flag] = false;
  return out;
}

/** Make exactly `view`'s aux panel visible, clearing every other aux panel. */
function showOnlyAux(l: LayoutState, view: AuxView): LayoutState {
  return {
    ...l,
    ...clearedAuxFlags(),
    [AUX_VIEW_FLAGS[view]]: true,
    activeView: view,
    lastAuxView: view,
    sidebarVisible: l.sidebarVisible,
    editorSplitPreview: false,
  };
}

function restoreLastAuxView(l: LayoutState): LayoutState {
  const view = (l.lastAuxView in AUX_VIEW_FLAGS ? l.lastAuxView : 'editor') as AuxView;
  return showOnlyAux(l, view);
}

export const useLayoutStore = create<LayoutState & LayoutActions>((set, getState) => ({
  ...loadLayout(),
  settingsOpen: false,
  settingsInitialTab: null,
  quickCaptureOpen: false,
  envManagerOpen: false,
  agentSpawnOpen: false,

  // `tab` deep-links a section, so a caller like the palette's "Customize
  // Theme…" opens Settings where the user asked to go rather than on General.
  openSettings: (tab) => set({ settingsOpen: true, settingsInitialTab: tab ?? null }),
  closeSettings: () => set({ settingsOpen: false, settingsInitialTab: null }),

  openQuickCapture: () => set({ quickCaptureOpen: true }),
  closeQuickCapture: () => set({ quickCaptureOpen: false }),

  openAgentSpawn: () => set({ agentSpawnOpen: true }),
  closeAgentSpawn: () => set({ agentSpawnOpen: false }),

  openEnvManager: () => {
    set((l) => {
      const next = { ...l, activeView: 'env' as const, lastAuxView: 'env' as const, envVisible: true, envManagerOpen: true, httpVisible: false, dbVisible: false, containersVisible: false, toolboxVisible: false, fleetVisible: false };
      persistLayout(next);
      return next;
    });
  },
  closeEnvManager: () => {
    set((l) => {
      const next = { ...l, activeView: 'terminal' as const, envVisible: false, envManagerOpen: false };
      persistLayout(next);
      return next;
    });
  },

  toggleSidebar: () => {
    set((s) => {
      const next: LayoutState = { ...s, sidebarVisible: !s.sidebarVisible };
      persistLayout(next);
      return next;
    });
  },

  setSidebarVisible: (visible: boolean) => {
    set((s) => {
      if (s.sidebarVisible === visible) return s;
      const next: LayoutState = { ...s, sidebarVisible: visible };
      persistLayout(next);
      return next;
    });
  },

  setActiveView: (view: ActiveView) => {
    set((l) => {
      if (view === 'terminal') {
        const next: LayoutState = { ...l, activeView: 'terminal' as const };
        persistLayout(next);
        return next;
      }
      if (view === 'editor') {
        const next: LayoutState = { ...l, activeView: 'editor' as const, lastAuxView: 'editor' as const, editorVisible: true };
        persistLayout(next);
        return next;
      }
      if (view === 'preview') {
        const next: LayoutState = { ...l, activeView: 'preview' as const, lastAuxView: 'preview' as const, previewVisible: true };
        persistLayout(next);
        return next;
      }
      if (view === 'review') {
        const next: LayoutState = { ...l, activeView: 'review' as const, lastAuxView: 'review' as const, reviewVisible: true };
        persistLayout(next);
        return next;
      }
      if (view === 'http') {
        const next: LayoutState = { ...l, activeView: 'http' as const, lastAuxView: 'http' as const, httpVisible: true, dbVisible: false, containersVisible: false, toolboxVisible: false, envVisible: false, fleetVisible: false };
        persistLayout(next);
        return next;
      }
      if (view === 'tasks') {
        const next: LayoutState = { ...l, activeView: 'tasks' as const, lastAuxView: 'tasks' as const, tasksVisible: true };
        persistLayout(next);
        return next;
      }
      if (view === 'fleet') {
        // Fleet is a right-drawer tool (like Toolbox/HTTP/DB), so opening it
        // clears the other drawer flags to keep the drawer single-body.
        const next = { ...l, activeView: 'fleet' as const, lastAuxView: 'fleet' as const, fleetVisible: true, httpVisible: false, dbVisible: false, containersVisible: false, toolboxVisible: false, envVisible: false, envManagerOpen: false, mobileVisible: false };
        persistLayout(next);
        return next;
      }
      if (view === 'db') {
        const next: LayoutState = { ...l, activeView: 'db' as const, lastAuxView: 'db' as const, dbVisible: true, httpVisible: false, containersVisible: false, toolboxVisible: false, envVisible: false, fleetVisible: false };
        persistLayout(next);
        return next;
      }
      if (view === 'containers') {
        const next: LayoutState = { ...l, activeView: 'containers' as const, lastAuxView: 'containers' as const, containersVisible: true, httpVisible: false, dbVisible: false, toolboxVisible: false, envVisible: false, fleetVisible: false };
        persistLayout(next);
        return next;
      }
      if (view === 'toolbox') {
        const next: LayoutState = { ...l, activeView: 'toolbox' as const, lastAuxView: 'toolbox' as const, toolboxVisible: true, httpVisible: false, dbVisible: false, containersVisible: false, envVisible: false, fleetVisible: false };
        persistLayout(next);
        return next;
      }
      if (view === 'env') {
        const next = { ...l, activeView: 'env' as const, lastAuxView: 'env' as const, envVisible: true, envManagerOpen: true, httpVisible: false, dbVisible: false, containersVisible: false, toolboxVisible: false, fleetVisible: false };
        persistLayout(next);
        return next;
      }
      if (view === 'youtube') {
        // YouTube is a floating pop-up, not a view to switch to: just open the
        // window and leave the current active view in place.
        const next: LayoutState = { ...l, youtubeVisible: true };
        persistLayout(next);
        return next;
      }
      if (view === 'mobile') {
        // Mobile is a right-drawer tool (like Toolbox/HTTP/DB), so opening it
        // clears the other drawer flags to keep the drawer single-body.
        const next = { ...l, activeView: 'mobile' as const, lastAuxView: 'mobile' as const, mobileVisible: true, httpVisible: false, dbVisible: false, containersVisible: false, toolboxVisible: false, envVisible: false, envManagerOpen: false, fleetVisible: false };
        persistLayout(next);
        return next;
      }
      if (view === 'orchestrator') {
        const next: LayoutState = { ...l, orchestratorVisible: true };
        persistLayout(next);
        return next;
      }
      const next: LayoutState = { ...l, activeView: view };
      persistLayout(next);
      return next;
    });

    // The editor is a ROOM, not just a visibility flag. Setting `editorVisible`
    // puts it in the room list but leaves it wherever it was — off stage, or
    // minimized — so "open this file" while another room is focused changed
    // nothing on screen. The view transition still played, which is the flash
    // with no navigation. Ask the room system to bring it on stage instead,
    // exactly as `revealPreview` does for the preview room.
    //
    // Going through the command bus matters twice over: `focusRoom` un-minimizes
    // the room and honours the Split slot rule (see
    // `.spacron/memory/split-room-slots.md`), which a bare `setFocusedRoom`
    // does not; and the command carries a nonce, so re-opening the file that is
    // already active re-fires rather than being swallowed as a no-op.
    if (view === 'editor') requestRoomControl('focus', 'editor');
  },

  showTerminal: () => {
    set((l) => {
      const next: LayoutState = { ...l, activeView: 'terminal' as const };
      persistLayout(next);
      return next;
    });
  },

  toggleEditorVisible: () => {
    set((l) => {
      const next: LayoutState = l.editorVisible
        ? { ...l, editorVisible: false, editorSplitPreview: false, activeView: 'terminal' as const }
        : { ...l, editorVisible: true, lastAuxView: 'editor' as const, previewVisible: false, reviewVisible: false, httpVisible: false, tasksVisible: false, dbVisible: false, containersVisible: false, toolboxVisible: false, editorSplitPreview: false, activeView: 'editor' as const };
      persistLayout(next);
      return next;
    });
  },

  togglePreviewVisible: () => {
    set((l) => {
      const next: LayoutState = l.previewVisible
        ? { ...l, previewVisible: false, editorSplitPreview: false, activeView: 'terminal' as const }
        : { ...l, previewVisible: true, lastAuxView: 'preview' as const, editorVisible: false, reviewVisible: false, httpVisible: false, tasksVisible: false, dbVisible: false, containersVisible: false, toolboxVisible: false, editorSplitPreview: false, activeView: 'preview' as const };
      persistLayout(next);
      return next;
    });
  },

  toggleReviewVisible: () => {
    set((l) => {
      const next: LayoutState = l.reviewVisible
        ? { ...l, reviewVisible: false, activeView: 'terminal' as const }
        : { ...l, reviewVisible: true, lastAuxView: 'review' as const, editorVisible: false, previewVisible: false, httpVisible: false, tasksVisible: false, dbVisible: false, containersVisible: false, toolboxVisible: false, editorSplitPreview: false, activeView: 'review' as const };
      persistLayout(next);
      return next;
    });
  },

  toggleHttpVisible: () => {
    const active = getState().activeView === 'http';
    if (active) {
      set((l) => {
        const next = { ...l, activeView: 'terminal' as const, httpVisible: false };
        persistLayout(next);
        return next;
      });
    } else {
      set((l) => {
        const next = { ...l, activeView: 'http' as const, lastAuxView: 'http' as const, httpVisible: true, dbVisible: false, containersVisible: false, toolboxVisible: false, envVisible: false, fleetVisible: false };
        persistLayout(next);
        return next;
      });
    }
  },

  toggleTasksVisible: () => {
    set((l) => {
      const next: LayoutState = l.tasksVisible
        ? { ...l, tasksVisible: false, activeView: 'terminal' as const }
        : { ...l, tasksVisible: true, lastAuxView: 'tasks' as const, editorVisible: false, previewVisible: false, reviewVisible: false, httpVisible: false, dbVisible: false, containersVisible: false, toolboxVisible: false, envVisible: false, editorSplitPreview: false, activeView: 'tasks' as const };
      persistLayout(next);
      return next;
    });
  },

  // Agent Fleet lives in the right utility drawer now, not in a centre room, so
  // its shortcut has to move the drawer. Flipping `fleetVisible` on its own
  // would set a flag nothing paints.
  toggleFleetVisible: () => {
    getState().setRightDrawerTool(getState().fleetVisible ? null : 'fleet');
  },

  toggleDbVisible: () => {
    const active = getState().activeView === 'db';
    if (active) {
      set((l) => {
        const next = { ...l, activeView: 'terminal' as const, dbVisible: false };
        persistLayout(next);
        return next;
      });
    } else {
      set((l) => {
        const next = { ...l, activeView: 'db' as const, lastAuxView: 'db' as const, dbVisible: true, httpVisible: false, containersVisible: false, toolboxVisible: false, envVisible: false, fleetVisible: false };
        persistLayout(next);
        return next;
      });
    }
  },

  toggleContainersVisible: () => {
    const active = getState().activeView === 'containers';
    if (active) {
      set((l) => {
        const next = { ...l, activeView: 'terminal' as const, containersVisible: false };
        persistLayout(next);
        return next;
      });
    } else {
      set((l) => {
        const next = { ...l, activeView: 'containers' as const, lastAuxView: 'containers' as const, containersVisible: true, httpVisible: false, dbVisible: false, toolboxVisible: false, envVisible: false, fleetVisible: false };
        persistLayout(next);
        return next;
      });
    }
  },

  toggleToolboxVisible: () => {
    const active = getState().activeView === 'toolbox';
    if (active) {
      set((l) => {
        const next = { ...l, activeView: 'terminal' as const, toolboxVisible: false };
        persistLayout(next);
        return next;
      });
    } else {
      set((l) => {
        const next = { ...l, activeView: 'toolbox' as const, lastAuxView: 'toolbox' as const, toolboxVisible: true, httpVisible: false, dbVisible: false, containersVisible: false, envVisible: false, fleetVisible: false };
        persistLayout(next);
        return next;
      });
    }
  },

  // Force the drawer to a specific tool (used by the drawer's own tab strip), or
  // null to close it. Unlike the toggles, selecting the active tab does not close.
  setRightDrawerTool: (tool: RightDrawerTool | null) => {
    if (tool === null) {
      set((l) => {
        const next = { ...l, activeView: 'terminal' as const, httpVisible: false, dbVisible: false, containersVisible: false, toolboxVisible: false, envVisible: false, envManagerOpen: false, mobileVisible: false, fleetVisible: false };
        persistLayout(next);
        return next;
      });
    } else {
      set((l) => {
        const next = {
          ...l,
          activeView: tool as ActiveView,
          lastAuxView: tool as ActiveView,
          httpVisible: tool === 'http',
          dbVisible: tool === 'db',
          containersVisible: tool === 'containers',
          toolboxVisible: tool === 'toolbox',
          envVisible: tool === 'env',
          envManagerOpen: tool === 'env',
          mobileVisible: tool === 'mobile',
          fleetVisible: tool === 'fleet'
        };
        persistLayout(next);
        return next;
      });
    }
  },

  setLeftPanelWidth: (width: number) => {
    set((l) => {
      const next: LayoutState = { ...l, leftPanelWidth: Math.max(180, Math.min(600, width)) };
      persistLayout(next);
      return next;
    });
  },

  setRightDrawerWidth: (width: number) => {
    set((l) => {
      const next: LayoutState = { ...l, rightDrawerWidth: Math.max(280, Math.min(720, width)) };
      persistLayout(next);
      return next;
    });
  },

  toggleMobileVisible: () => {
    const active = getState().activeView === 'mobile';
    if (active) {
      set((l) => {
        const next = { ...l, activeView: 'terminal' as const, mobileVisible: false };
        persistLayout(next);
        return next;
      });
    } else {
      set((l) => {
        const next = { ...l, activeView: 'mobile' as const, lastAuxView: 'mobile' as const, mobileVisible: true, editorVisible: false, previewVisible: false, reviewVisible: false, httpVisible: false, dbVisible: false, containersVisible: false, toolboxVisible: false, envVisible: false, envManagerOpen: false, fleetVisible: false, editorSplitPreview: false };
        persistLayout(next);
        return next;
      });
    }
  },

  toggleYoutubeVisible: () => {
    if (getState().youtubeVisible) {
      try {
        const raw = localStorage.getItem('spacron_youtube_window');
        if (raw) {
          const parsed = JSON.parse(raw);
          if (parsed.minimized) {
            window.dispatchEvent(new CustomEvent('spacron-youtube-restore'));
            return;
          }
        }
      } catch {
        // ignore
      }
    }
    set((l) => {
      const next: LayoutState = { ...l, youtubeVisible: !l.youtubeVisible };
      persistLayout(next);
      return next;
    });
  },

  toggleOrchestratorVisible: () => {
    set((l) => {
      const next: LayoutState = { ...l, orchestratorVisible: !l.orchestratorVisible };
      persistLayout(next);
      return next;
    });
  },

  toggleTerminal: () => {
    set((l) => {
      const anyAuxVisible = AUX_FLAGS.some((flag) => l[flag]);
      const next: LayoutState = anyAuxVisible
        ? { ...l, ...(clearedAuxFlags() as unknown as Partial<LayoutState>), editorSplitPreview: false, activeView: 'terminal' as const }
        : restoreLastAuxView(l);
      persistLayout(next);
      return next;
    });
  },

  setSidebarTab: (tab: SidebarTab) => {
    set((l) => {
      const next: LayoutState = { ...l, sidebarTab: tab, sidebarVisible: true };
      persistLayout(next);
      return next;
    });
  },

  toggleSidebarTab: (tab: SidebarTab) => {
    set((l) => {
      const next: LayoutState = l.sidebarVisible && l.sidebarTab === tab
        ? { ...l, sidebarVisible: false }
        : { ...l, sidebarVisible: true, sidebarTab: tab };
      persistLayout(next);
      return next;
    });
  },

  toggleEditorSplitPreview: () => {
    set((l) => {
      const nextSplit = !l.editorSplitPreview;
      const next: LayoutState = { ...l, editorSplitPreview: nextSplit, editorVisible: true, previewVisible: nextSplit, reviewVisible: false, httpVisible: false, containersVisible: false, activeView: (nextSplit ? 'preview' : 'editor') as ActiveView };
      persistLayout(next);
      return next;
    });
  },

  // Make the preview panel visible without tearing down what the user is
  // looking at. Used when something navigates the preview programmatically
  // (e.g. "Preview" on an HTML file) — navigating an invisible panel reads as
  // "nothing happened". If the editor is showing, open the editor+preview
  // split so the file stays editable next to its preview; otherwise switch to
  // the preview view. Already-visible preview is left untouched.
  revealPreview: () => {
    set((l) => {
      if (l.previewVisible) return l;
      const next: LayoutState = l.editorVisible
        ? { ...l, editorSplitPreview: true, previewVisible: true, lastAuxView: 'preview' as const, activeView: 'preview' as const }
        : { ...l, previewVisible: true, lastAuxView: 'preview' as const, activeView: 'preview' as const };
      persistLayout(next);
      return next;
    });
    // Ask the room system to focus the preview room so it appears in-view
    // (not just added to the room list in the background).
    requestRoomControl('focus', 'preview');
  },

  setSidebarWidth: (width: number) => {
    set((l) => {
      const next: LayoutState = { ...l, sidebarWidth: Math.max(100, Math.min(600, width)) };
      persistLayout(next);
      return next;
    });
  },

  resetLayoutToDefault: () => {
    if (typeof window !== 'undefined') {
      localStorage.removeItem(LAYOUT_KEY);
    }
    set({ ...defaultLayout });
  },

  applyLayoutState: (patch: Partial<LayoutState>) => {
    set((l) => {
      const next = { ...l, ...patch };
      persistLayout(next);
      return next;
    });
  },

  applyRightDrawerTool: (tool: RightDrawerTool | null) => {
    set((l) => {
      const next = showRightDrawerTool(l, tool);
      persistLayout(next);
      return next;
    });
  },
}));
