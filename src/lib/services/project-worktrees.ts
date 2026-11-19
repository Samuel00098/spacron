import { backendInvoke } from '$lib/services/backend';

/**
 * Project worktrees, Orca-style: a project lists its main checkout plus every
 * worktree the user created for it, and any number of agents and terminals can
 * share one. Backed by `src-tauri/src/commands/project_worktrees.rs`, which
 * keeps them in `<project>/.spacron/trees/` — outside the orchestrator's
 * agent-worktree area, whose orphan sweep would otherwise delete them.
 *
 * Agent-isolated worktrees (`.spacron/worktrees/`, see
 * `orchestrator/worktree-manager.ts`) are a different thing and never appear here.
 */

export interface ProjectWorktree {
  path: string;
  /** Checked-out branch; null when HEAD is detached. */
  branch: string | null;
  head: string;
  /** The project's own checkout — the 🏠 row. */
  is_main: boolean;
  name: string;
  note: string | null;
  /** Path of the worktree this one nests under in the sidebar. */
  parent: string | null;
  base_ref: string | null;
  created_at: number | null;
  /** Registered with git but the folder is gone. */
  missing: boolean;
}

export interface WorktreeBases {
  default_base: string;
  /** Remote and local refs, default first. */
  refs: string[];
  /** Local branches — the ones an existing-branch worktree can open. */
  local: string[];
}

export interface CreateWorktreeArgs {
  projectId: string;
  name: string;
  branch?: string | null;
  baseRef?: string | null;
  note?: string | null;
  parent?: string | null;
}

/** Prefix the backend puts on a delete refused because of uncommitted changes. */
const DIRTY_PREFIX = 'DIRTY:';

function message(error: unknown): string {
  if (typeof error === 'string') return error;
  if (error instanceof Error) return error.message;
  return String(error);
}

export function listProjectWorktrees(projectId: string): Promise<ProjectWorktree[]> {
  return backendInvoke<ProjectWorktree[]>('project_worktree_list', { projectId });
}

export function getWorktreeBases(projectId: string): Promise<WorktreeBases> {
  return backendInvoke<WorktreeBases>('project_worktree_bases', { projectId });
}

export function createProjectWorktree(
  args: CreateWorktreeArgs,
): Promise<{ worktree: ProjectWorktree; warning: string | null }> {
  return backendInvoke('project_worktree_create', {
    projectId: args.projectId,
    name: args.name,
    branch: args.branch?.trim() || null,
    baseRef: args.baseRef?.trim() || null,
    note: args.note?.trim() || null,
    parent: args.parent || null,
  });
}

export type DeleteWorktreeResult =
  | { ok: true; preservedBranch: string | null }
  | { ok: false; dirty: boolean; error: string };

/** Delete a worktree. Without `force`, uncommitted changes come back as `dirty`
 *  so the caller can ask before discarding them. */
export async function deleteProjectWorktree(
  projectId: string,
  worktreePath: string,
  force = false,
): Promise<DeleteWorktreeResult> {
  try {
    const result = await backendInvoke<{ preserved_branch: string | null }>('project_worktree_delete', {
      projectId,
      worktreePath,
      force,
    });
    return { ok: true, preservedBranch: result?.preserved_branch ?? null };
  } catch (error) {
    const text = message(error);
    const dirty = text.startsWith(DIRTY_PREFIX);
    return { ok: false, dirty, error: dirty ? text.slice(DIRTY_PREFIX.length).trim() : text };
  }
}

export function updateProjectWorktree(args: {
  projectId: string;
  worktreePath: string;
  name?: string;
  note?: string;
  parent?: string | null;
}): Promise<void> {
  return backendInvoke('project_worktree_update', {
    projectId: args.projectId,
    worktreePath: args.worktreePath,
    name: args.name ?? null,
    note: args.note ?? null,
    parent: args.parent ?? null,
    clearParent: args.parent === null,
  });
}

function normalize(path: string): string {
  return path.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
}

/** True when `path` is `root` or inside it (case- and separator-insensitive). */
export function isPathInside(path: string | null | undefined, root: string): boolean {
  if (!path) return false;
  const p = normalize(path);
  const r = normalize(root);
  return p === r || p.startsWith(`${r}/`);
}

/**
 * The worktree a folder belongs to: the deepest non-main worktree containing it,
 * else the main checkout. User worktrees live inside the project root, so the
 * main checkout contains them all and must lose every tie.
 */
export function worktreeForPath(
  worktrees: ProjectWorktree[],
  path: string | null | undefined,
): ProjectWorktree | null {
  const main = worktrees.find((w) => w.is_main) ?? null;
  if (!path) return main;
  let best: ProjectWorktree | null = null;
  for (const w of worktrees) {
    if (w.is_main || !isPathInside(path, w.path)) continue;
    if (!best || w.path.length > best.path.length) best = w;
  }
  return best ?? main;
}

/** Sidebar order: each worktree followed by its children, depth-first. Rows whose
 *  parent no longer exists are shown at the top level. */
export function orderWorktreeTree(worktrees: ProjectWorktree[]): Array<{ worktree: ProjectWorktree; depth: number }> {
  const known = new Set(worktrees.map((w) => normalize(w.path)));
  const childrenOf = new Map<string, ProjectWorktree[]>();
  const roots: ProjectWorktree[] = [];
  for (const w of worktrees) {
    const parent = !w.is_main && w.parent && known.has(normalize(w.parent)) && normalize(w.parent) !== normalize(w.path)
      ? normalize(w.parent)
      : null;
    if (parent) {
      const list = childrenOf.get(parent);
      if (list) list.push(w);
      else childrenOf.set(parent, [w]);
    } else {
      roots.push(w);
    }
  }
  const out: Array<{ worktree: ProjectWorktree; depth: number }> = [];
  const seen = new Set<string>();
  const visit = (w: ProjectWorktree, depth: number) => {
    const key = normalize(w.path);
    if (seen.has(key)) return;
    seen.add(key);
    out.push({ worktree: w, depth });
    for (const child of childrenOf.get(key) ?? []) visit(child, depth + 1);
  };
  for (const w of roots) visit(w, 0);
  // A parent cycle leaves rows unvisited; show them rather than lose them.
  for (const w of worktrees) visit(w, 0);
  return out;
}
