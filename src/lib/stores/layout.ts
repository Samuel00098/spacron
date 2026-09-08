import { flushSync } from 'react-dom';
import { viewTransitionsReliable } from '$lib/utils/tauri';
import { get, writable, type Writable } from '$lib/stores/storeCompat';
import type { LayoutState, ActiveView, SidebarTab } from '$lib/types/layout';
import {
  RIGHT_DRAWER_TOOLS,
  useLayoutStore,
  rightDrawerToolOf as rightDrawerToolOfState,
  type RightDrawerTool,
} from './zustand/layout';

export type { ActiveView, SidebarTab };

export { sanitiseActiveView, sanitiseSidebarTab, RIGHT_DRAWER_TOOLS, rightDrawerToolOf, sanitiseRightDrawerTool } from './zustand/layout';
export type { RightDrawerTool } from './zustand/layout';

function withTransition(fn: () => void) {
  const startViewTransition = (document as any).startViewTransition;
  if (
    startViewTransition &&
    viewTransitionsReliable() &&
    !window.matchMedia('(prefers-reduced-motion: reduce)').matches &&
    !(window as any).__spacron_transitioning
  ) {
    (window as any).__spacron_transitioning = true;
    try {
      const transition = startViewTransition.call(document, () => {
        flushSync(fn);
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
      fn();
    }
  } else {
    fn();
  }
}

// A TWO-WAY binding onto the Zustand layout store. Reading reflects the live
// store; `set`/`update` write back into Zustand (via applyLayoutState) so the
// React UI — which reads `useLayoutStore` directly — actually re-renders. This
// is what makes project-switch restore (workspace.ts) and snapshots
// (snapshot.ts) drive the visible layout. A plain mirror writable would swallow
// those writes silently.
export const layout: Writable<LayoutState> = {
  subscribe(run) {
    run(useLayoutStore.getState());
    return useLayoutStore.subscribe((state) => run(state));
  },
  set(value) {
    useLayoutStore.getState().applyLayoutState(value);
  },
  update(fn) {
    useLayoutStore.getState().applyLayoutState(fn(useLayoutStore.getState()));
  },
};

export const settingsOpen = writable(false);
export const quickCaptureOpen = writable(false);
export const envManagerOpen = writable(false);
export const agentSpawnOpen = writable(false);
export const terminalRoomOpen = writable(false);
/** Whether the unified right-hand tools sidebar is mounted. */
export const rightSidebarVisible = writable(true);
export const RIGHT_SIDEBAR_NAVIGATOR_TABS = ['files', 'search', 'git', 'problems', 'snapshots', 'snippets'] as const;
export type RightSidebarNavigatorTab = (typeof RIGHT_SIDEBAR_NAVIGATOR_TABS)[number];
export type RightSidebarTab = RightSidebarNavigatorTab | RightDrawerTool;
/** The last selected tab in the unified right sidebar, preserved while closed. */
export const rightSidebarTab = writable<RightSidebarTab>('files');

// The Home (welcome) screen is an OVERLAY, not a route. Navigating home used to
// null `activeWorkspaceId`, which unmounted the whole workspace tree — every
// xterm was disposed and had to reattach-by-replay on the way back, which is
// what killed a running agent's rendering. Keeping the workspace mounted behind
// this flag means going home and coming back is a pure visibility toggle: the
// PTY view is never rebuilt.
export const homeScreenOpen = writable(false);

// Mirror the modal flags out of Zustand for non-React (writable) consumers.
useLayoutStore.subscribe((state) => {
  settingsOpen.set(state.settingsOpen);
  quickCaptureOpen.set(state.quickCaptureOpen);
  envManagerOpen.set(state.envManagerOpen);
  agentSpawnOpen.set(state.agentSpawnOpen);
});

// Settings open/close intentionally skips the page-wide view transition. The
// transition snapshots the entire app (terminals, editors, …) before the modal
// can show, which made opening Settings feel laggy. The modal animates itself
// in via the `settingsScaleUp` CSS animation, so it appears instantly and still
// looks smooth.
export function openSettings(tab?: import('$lib/types/layout').SettingsTab) { useLayoutStore.getState().openSettings(tab); }
export function closeSettings() { useLayoutStore.getState().closeSettings(); }
export function openQuickCapture() { useLayoutStore.getState().openQuickCapture(); }
export function closeQuickCapture() { useLayoutStore.getState().closeQuickCapture(); }
export function openAgentSpawn() { useLayoutStore.getState().openAgentSpawn(); }
export function closeAgentSpawn() { useLayoutStore.getState().closeAgentSpawn(); }
export function openEnvManager() { withTransition(() => { useLayoutStore.getState().openEnvManager(); }); }
export function closeEnvManager() { withTransition(() => { useLayoutStore.getState().closeEnvManager(); }); }
export function toggleSidebar() { withTransition(() => { useLayoutStore.getState().toggleSidebar(); }); }
export function setSidebarVisible(visible: boolean) { withTransition(() => { useLayoutStore.getState().setSidebarVisible(visible); }); }
export function setRightSidebarVisible(visible: boolean) { rightSidebarVisible.set(visible); }
export function toggleRightSidebar() { rightSidebarVisible.update((visible) => !visible); }
export function setRightSidebarTab(tab: RightSidebarTab) { rightSidebarTab.set(tab); }
export function openRightSidebar() {
  rightSidebarVisible.set(true);
  const tab = get(rightSidebarTab);
  if ((RIGHT_DRAWER_TOOLS as readonly string[]).includes(tab)) {
    useLayoutStore.getState().setRightDrawerTool(tab as RightDrawerTool);
  } else {
    useLayoutStore.getState().setRightDrawerTool(null);
  }
}
export function setActiveView(view: ActiveView) {
  withTransition(() => {
    if (view === 'review') rightSidebarVisible.set(true);
    useLayoutStore.getState().setActiveView(view);
  });
}
export function showTerminal() { withTransition(() => { useLayoutStore.getState().showTerminal(); }); }
export function toggleEditorVisible() { withTransition(() => { useLayoutStore.getState().toggleEditorVisible(); }); }
export function togglePreviewVisible() { withTransition(() => { useLayoutStore.getState().togglePreviewVisible(); }); }
export function toggleReviewVisible() {
  withTransition(() => {
    // Code Review is a right-sidebar utility now. Make sure a command or
    // shortcut can reveal the unified sidebar even when it was previously
    // closed.
    if (!useLayoutStore.getState().reviewVisible) rightSidebarVisible.set(true);
    useLayoutStore.getState().toggleReviewVisible();
  });
}
export function toggleHttpVisible() { withTransition(() => { useLayoutStore.getState().toggleHttpVisible(); }); }
export function toggleTasksVisible() { withTransition(() => { useLayoutStore.getState().toggleTasksVisible(); }); }
export function toggleFleetVisible() { withTransition(() => { useLayoutStore.getState().toggleFleetVisible(); }); }
export function toggleDbVisible() { withTransition(() => { useLayoutStore.getState().toggleDbVisible(); }); }
export function toggleContainersVisible() { withTransition(() => { useLayoutStore.getState().toggleContainersVisible(); }); }
export function toggleToolboxVisible() { withTransition(() => { useLayoutStore.getState().toggleToolboxVisible(); }); }
export function setRightDrawerTool(tool: import('./zustand/layout').RightDrawerTool | null) { withTransition(() => { useLayoutStore.getState().setRightDrawerTool(tool); }); }
/** The right drawer's currently-showing tool, read straight off the live store.
 *  Goes through the store rather than the `layout` compat writable because the
 *  `env` tool's open state (`envManagerOpen`) is not part of `LayoutState`. */
export function currentRightDrawerTool(): import('./zustand/layout').RightDrawerTool | null {
  return rightDrawerToolOfState(useLayoutStore.getState());
}
/** Per-project restore: put the drawer back without moving the stage. No
 *  `withTransition` — a project switch runs its own. */
export function applyRightDrawerTool(tool: import('./zustand/layout').RightDrawerTool | null) { useLayoutStore.getState().applyRightDrawerTool(tool); }
export function setRightDrawerWidth(width: number) { useLayoutStore.getState().setRightDrawerWidth(width); }
export function toggleYoutubeVisible() { withTransition(() => { useLayoutStore.getState().toggleYoutubeVisible(); }); }
export function toggleOrchestratorVisible() { withTransition(() => { useLayoutStore.getState().toggleOrchestratorVisible(); }); }
export function toggleMobileVisible() { withTransition(() => { useLayoutStore.getState().toggleMobileVisible(); }); }
export function toggleTerminal() { withTransition(() => { useLayoutStore.getState().toggleTerminal(); }); }
export function setSidebarTab(tab: SidebarTab) { withTransition(() => { useLayoutStore.getState().setSidebarTab(tab); }); }
export function toggleSidebarTab(tab: SidebarTab) { withTransition(() => { useLayoutStore.getState().toggleSidebarTab(tab); }); }
export function toggleEditorSplitPreview() { withTransition(() => { useLayoutStore.getState().toggleEditorSplitPreview(); }); }
export function setSidebarWidth(width: number) { useLayoutStore.getState().setSidebarWidth(width); }
export function resetLayoutToDefault() { withTransition(() => { useLayoutStore.getState().resetLayoutToDefault(); }); }
