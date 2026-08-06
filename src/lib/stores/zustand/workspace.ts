import { create } from 'zustand';
import type { Project, Workspace } from '$lib/types/workspace';

interface WorkspaceState {
  recentWorkspaces: Workspace[];
  activeWorkspaceId: string | null;
  projects: Map<string, Project>;
  activeProjectId: string | null;
  openProjectIds: string[];
  isLoading: boolean;
  isProjectSwitching: boolean;
  /** Short label for what the restore is doing right now, shown in the
   *  project-switch overlay so a multi-second restore reads as progress rather
   *  than a freeze. Cleared when the switch finishes. */
  switchingPhase: string | null;
  newWorkspacePromptOpen: boolean;
  newFolderPromptOpen: boolean;
  isProjectHUDOpen: boolean;
  __set: (key: string, value: unknown) => void;
  setSwitchingPhase: (phase: string | null) => void;
}

function loadPersisted<T>(key: string, fallback: T): T {
  if (typeof window === 'undefined') return fallback;
  try {
    const raw = localStorage.getItem(`spacron_ws_${key}`);
    return raw !== null ? (JSON.parse(raw) as T) : fallback;
  } catch { return fallback; }
}

function persist(key: string, value: unknown) {
  if (typeof window === 'undefined') return;
  try { localStorage.setItem(`spacron_ws_${key}`, JSON.stringify(value)); } catch {}
}

export const useWorkspaceStore = create<WorkspaceState>((set) => ({
  recentWorkspaces: loadPersisted<Workspace[]>('recentWorkspaces', []),
  activeWorkspaceId: loadPersisted<string | null>('activeWorkspaceId', null),
  projects: new Map(),
  activeProjectId: null,
  openProjectIds: [],
  isLoading: false,
  isProjectSwitching: false,
  switchingPhase: null,
  newWorkspacePromptOpen: false,
  newFolderPromptOpen: false,
  isProjectHUDOpen: false,

  __set: (key, value) => {
    if (key === 'recentWorkspaces' || key === 'activeWorkspaceId') {
      persist(key, value);
    }
    set({ [key]: value } as any);
  },

  setSwitchingPhase: (phase) => set({ switchingPhase: phase }),
}));
