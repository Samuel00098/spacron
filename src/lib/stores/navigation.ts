import { writable, get } from '$lib/stores/storeCompat';
import { activeWorkspaceId, activeProjectId, openWorkspace, switchToProject } from './workspace';
import { layout, setActiveView } from './layout';
import { activeFile, openFile } from './editor';
import type { ActiveView } from '$lib/types/layout';
import { useNavigationStore } from './zustand/navigation';
import { layoutSnapshot, requestStageExpansion } from './layoutControl';

function syncWritable<T>(key: string, defaultValue: T): import('$lib/stores/storeCompat').Writable<T> {
  const zustandVal = (useNavigationStore.getState() as any)[key];
  const initial = zustandVal !== undefined ? zustandVal as T : defaultValue;
  const store = writable<T>(initial);
  void useNavigationStore.subscribe((state) => {
    const next = (state as any)[key] as T | undefined;
    if (next !== undefined) store.set(next);
  });
  return {
    subscribe: store.subscribe,
    set(value: T) { (useNavigationStore.getState() as any).__set(key, value); },
    update(fn: (val: T) => T) {
      const current = (useNavigationStore.getState() as any)[key] as T;
      (useNavigationStore.getState() as any).__set(key, fn(current));
    },
  };
}

interface NavState {
  workspaceId: string | null;
  projectId: string | null;
  activeView: ActiveView;
  activeFile: string | null;
  /** The panel zoomed to the full stage, or null when the stage is a grid. */
  expandedRoom: string | null;
}

/** Deepest back stack kept. Beyond this the oldest entries are dropped. */
const MAX_HISTORY = 200;

/**
 * How long after a workspace/project switch an expanded-panel change still counts
 * as part of that switch. Opening a project restores its own saved stage through
 * the AppShell command bus a moment later; recording that as a step of its own
 * would make Back need two presses to leave the project.
 */
const CONTEXT_SETTLE_MS = 1000;

let history: NavState[] = [];
let currentIndex = -1;
let isNavigatingHistory = false;

// Stores for UI state
export const canGoBack = syncWritable<boolean>('canGoBack', false);
export const canGoForward = syncWritable<boolean>('canGoForward', false);

function updateCanNav() {
  canGoBack.set(currentIndex > 0);
  canGoForward.set(currentIndex < history.length - 1);
}

export function recordNavigation(state: NavState) {
  if (isNavigatingHistory) return;

  const current = history[currentIndex];
  if (current && 
      current.workspaceId === state.workspaceId && 
      current.projectId === state.projectId && 
      current.activeView === state.activeView && 
      current.activeFile === state.activeFile &&
      current.expandedRoom === state.expandedRoom) {
    return;
  }

  // Clear any forward history since we are branching
  history = history.slice(0, currentIndex + 1);
  history.push(state);
  // Cap the back stack. This grew without limit, so a long-lived window
  // accumulated an entry for every navigation it had ever made — nobody walks
  // back further than this, and dropping the oldest keeps the index honest.
  if (history.length > MAX_HISTORY) {
    history = history.slice(history.length - MAX_HISTORY);
  }
  currentIndex = history.length - 1;
  updateCanNav();
}

/** Fold a change into the current entry instead of adding a step for it. */
function amendCurrentNavigation(state: NavState) {
  if (isNavigatingHistory || currentIndex < 0) return;
  history[currentIndex] = state;
}

async function applyState(state: NavState) {
  isNavigatingHistory = true;
  // A project switch brings back that project's own stage, expanded panel and
  // all, so the expansion is only driven here when the step stays in place.
  const sameContext =
    get(activeWorkspaceId) === state.workspaceId && get(activeProjectId) === state.projectId;
  try {
    // 1. Restore Workspace
    if (get(activeWorkspaceId) !== state.workspaceId) {
      if (state.workspaceId) {
        await openWorkspace(state.workspaceId);
      } else {
        activeWorkspaceId.set(null);
      }
    }

    // 2. Restore Project/Folder
    if (get(activeProjectId) !== state.projectId) {
      if (state.projectId) {
        switchToProject(state.projectId);
      } else {
        activeProjectId.set(null);
      }
    }

    // 3. Restore View
    if (get(layout).activeView !== state.activeView) {
      setActiveView(state.activeView);
    }

    // 4. Restore File
    if (get(activeFile) !== state.activeFile) {
      if (state.activeFile) {
        await openFile(state.activeFile);
      } else {
        activeFile.set(null);
      }
    }

    // 5. Restore the expanded panel. AppShell applies it asynchronously; when
    // its snapshot catches up it matches this entry, so no new step is recorded.
    if (sameContext && (get(layoutSnapshot).expandedRoom ?? null) !== state.expandedRoom) {
      requestStageExpansion(state.expandedRoom);
    }
  } catch (e) {
    console.error('Failed to apply navigation state:', e);
  } finally {
    isNavigatingHistory = false;
  }
}

export async function navigateBack() {
  if (currentIndex > 0) {
    currentIndex--;
    await applyState(history[currentIndex]);
    updateCanNav();
  }
}

export async function navigateForward() {
  if (currentIndex < history.length - 1) {
    currentIndex++;
    await applyState(history[currentIndex]);
    updateCanNav();
  }
}

// Automatically subscribe to active stores
export function initNavigationHistory() {
  if (typeof window === 'undefined') return;

  setTimeout(() => {
    let lastWorkspaceId = get(activeWorkspaceId);
    let lastProjectId = get(activeProjectId);
    let lastView = get(layout).activeView;
    let lastFile = get(activeFile);
    let lastExpandedRoom = get(layoutSnapshot).expandedRoom ?? null;
    let lastContextChangeAt = 0;

    // Record initial state
    recordNavigation({
      workspaceId: lastWorkspaceId,
      projectId: lastProjectId,
      activeView: lastView,
      activeFile: lastFile,
      expandedRoom: lastExpandedRoom
    });

    activeWorkspaceId.subscribe((wsId) => {
      if (wsId !== lastWorkspaceId) {
        lastWorkspaceId = wsId;
        lastContextChangeAt = Date.now();
        triggerRecord();
      }
    });

    activeProjectId.subscribe((pId) => {
      if (pId !== lastProjectId) {
        lastProjectId = pId;
        lastContextChangeAt = Date.now();
        triggerRecord();
      }
    });

    layout.subscribe((l) => {
      if (l.activeView !== lastView) {
        lastView = l.activeView;
        triggerRecord();
      }
    });

    activeFile.subscribe((file) => {
      if (file !== lastFile) {
        lastFile = file;
        triggerRecord();
      }
    });

    // Expanding a panel, switching which panel is expanded, and collapsing
    // back to the grid are each a step, so Back/Forward walk between them.
    layoutSnapshot.subscribe((snapshot) => {
      const room = snapshot.expandedRoom ?? null;
      if (room === lastExpandedRoom) return;
      lastExpandedRoom = room;
      if (Date.now() - lastContextChangeAt < CONTEXT_SETTLE_MS) {
        amendCurrentNavigation(currentState());
      } else {
        triggerRecord();
      }
    });

    function currentState(): NavState {
      return {
        workspaceId: lastWorkspaceId,
        projectId: lastProjectId,
        activeView: lastView,
        activeFile: lastFile,
        expandedRoom: lastExpandedRoom
      };
    }

    function triggerRecord() {
      recordNavigation(currentState());
    }
  }, 100);
}
