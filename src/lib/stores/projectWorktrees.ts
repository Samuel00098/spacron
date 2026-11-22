import { writable, get } from '$lib/stores/storeCompat';
import {
  isPathInside,
  listProjectWorktrees,
  worktreeForPath,
  type ProjectWorktree,
} from '$lib/services/project-worktrees';

/**
 * Which worktree each project is "in" â€” Orca's selected workspace row.
 *
 * New agents, terminals and chat threads for a project start in its active
 * worktree. No entry (or the main checkout) means the project root, which is
 * exactly how things behaved before worktrees existed, so nothing changes for a
 * project until the user creates and selects a worktree.
 *
 * Keyed by project id, which is stable (a v5 UUID of the root path).
 */

const ACTIVE_KEY = 'spacron.activeWorktreeByProject';

function loadActive(): Record<string, string> {
  try {
    const raw = localStorage.getItem(ACTIVE_KEY);
    const parsed = raw ? JSON.parse(raw) : {};
    if (!parsed || typeof parsed !== 'object') return {};
    const out: Record<string, string> = {};
    for (const [k, v] of Object.entries(parsed)) {
      if (typeof v === 'string' && v.trim()) out[k] = v;
    }
    return out;
  } catch {
    return {};
  }
}

function saveActive(value: Record<string, string>) {
  try {
    localStorage.setItem(ACTIVE_KEY, JSON.stringify(value));
  } catch {
    // Storage unavailable: the choice lasts for this session only.
  }
}

/** Worktree list per project id. Absent = not loaded yet. */
export const worktreesByProject = writable<Record<string, ProjectWorktree[]>>({});

/** Active (non-main) worktree path per project id. */
export const activeWorktreeByProject = writable<Record<string, string>>(loadActive());

export interface WorktreeIssue {
  id: string;
  identifier: string;
  title: string;
  url: string;
  description: string | null;
}

/** The Create worktree dialog's target, or null when it is closed. */
export const createWorktreeRequest = writable<{
  projectId: string;
  project?: { id: string; name: string; root_path: string };
  parent?: string | null;
  issue?: WorktreeIssue;
} | null>(null);

export function openCreateWorktree(projectId: string, parent?: string | null, issue?: WorktreeIssue, project?: { id: string; name: string; root_path: string }) {
  createWorktreeRequest.set({ projectId, project, parent: parent ?? null, ...(issue ? { issue } : {}) });
}

export function closeCreateWorktree() {
  createWorktreeRequest.set(null);
}

const inFlight = new Map<string, Promise<ProjectWorktree[]>>();
/** Each project's root, remembered from the first refresh that knew it, so a
 *  later refresh without it still falls back to the master row. */
const rootByProject = new Map<string, string>();

/** The master row for a project git cannot list (not a repo, or a remote
 *  backend without the command): every project has one, so its agents and
 *  terminals always have a home in the sidebar. */
export function mainWorktreeRow(rootPath: string): ProjectWorktree {
  return {
    path: rootPath,
    branch: null,
    head: '',
    is_main: true,
    name: 'master',
    note: null,
    parent: null,
    base_ref: null,
    created_at: null,
    missing: false,
  };
}

/** Reload a project's worktrees from git. Never throws. With a known root, a
 *  project git cannot list still gets its master row. */
export function refreshProjectWorktrees(projectId: string, rootPath?: string | null): Promise<ProjectWorktree[]> {
  if (rootPath) rootByProject.set(projectId, rootPath);
  const pending = inFlight.get(projectId);
  if (pending) return pending;
  const run = listProjectWorktrees(projectId)
    .catch(() => [] as ProjectWorktree[])
    .then((list) => {
      const root = rootByProject.get(projectId);
      const listed = Array.isArray(list) ? list : [];
      const safe = listed.length === 0 && root ? [mainWorktreeRow(root)] : listed;
      worktreesByProject.update((all) => ({ ...all, [projectId]: safe }));
      // Forget a selection whose worktree is gone, so new work does not try to
      // start in a deleted folder.
      const active = get(activeWorktreeByProject)[projectId];
      if (active && !safe.some((w) => !w.is_main && !w.missing && samePath(w.path, active))) {
        setActiveWorktree(projectId, null);
      }
      return safe;
    })
    .finally(() => inFlight.delete(projectId));
  inFlight.set(projectId, run);
  return run;
}

function samePath(a: string, b: string): boolean {
  return isPathInside(a, b) && isPathInside(b, a);
}

/** Select a worktree for a project. `null` (or the main checkout) selects the
 *  project root. */
export function setActiveWorktree(projectId: string, path: string | null) {
  const list = get(worktreesByProject)[projectId];
  const isMain = path != null && list?.some((w) => w.is_main && samePath(w.path, path));
  activeWorktreeByProject.update((all) => {
    const next = { ...all };
    if (!path || isMain) delete next[projectId];
    else next[projectId] = path;
    saveActive(next);
    return next;
  });
}

/**
 * Where new work for this project should start: the active worktree's folder,
 * or null for the project root.
 *
 * Before the list has loaded, the saved choice is trusted â€” it was valid when
 * it was made, and the first refresh clears it if the worktree has since gone.
 */
export function getActiveWorktreePath(projectId: string | null | undefined): string | null {
  if (!projectId) return null;
  const active = get(activeWorktreeByProject)[projectId];
  if (!active) return null;
  const list = get(worktreesByProject)[projectId];
  if (!list) return active;
  const match = list.find((w) => !w.is_main && !w.missing && samePath(w.path, active));
  return match ? match.path : null;
}

/**
 * The worktree a new agent joins when it is started from another agent's
 * folder (the "+" on that agent's room): that folder's worktree path, `null`
 * for the main checkout, or `undefined` when the list is not loaded (the caller
 * then falls back to the active worktree).
 */
export function launchWorktreeFor(projectId: string | null | undefined, folder: string | null | undefined): string | null | undefined {
  if (!projectId) return undefined;
  const list = get(worktreesByProject)[projectId];
  if (!list || list.length === 0) return undefined;
  const owner = worktreeForPath(list, folder);
  if (!owner || owner.is_main || owner.missing) return null;
  return owner.path;
}

/** The folder new work should start in: the active worktree, else `root`. */
export function workingRootFor(projectId: string | null | undefined, root: string): string;
export function workingRootFor(projectId: string | null | undefined, root: string | null | undefined): string | undefined;
export function workingRootFor(projectId: string | null | undefined, root: string | null | undefined): string | undefined {
  return getActiveWorktreePath(projectId) ?? root ?? undefined;
}
