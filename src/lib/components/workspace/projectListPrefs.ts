// Which projects the sidebar hides and which it pins to the top. Both are
// display preferences for this machine, keyed by the project's normalized root
// path (the same identity the rest of the project tree uses), so they survive
// a project being removed and re-added.

export const HIDDEN_PROJECTS_KEY = 'spacron.hud.hiddenProjects';
export const PINNED_PROJECTS_KEY = 'spacron.hud.pinnedProjects';

/** Compare separator- and case-insensitively, so a Windows path spelled either
 *  way is the same project. */
export function normalizeProjectPath(path: string): string {
  return path.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
}

export function loadPathSet(key: string): Set<string> {
  try {
    const raw = localStorage.getItem(key);
    const parsed: unknown = raw ? JSON.parse(raw) : [];
    return new Set(Array.isArray(parsed) ? parsed.filter((entry): entry is string => typeof entry === 'string') : []);
  } catch {
    return new Set();
  }
}

export function savePathSet(key: string, paths: Set<string>): void {
  try {
    localStorage.setItem(key, JSON.stringify(Array.from(paths)));
  } catch {
    /* storage unavailable: the preference lasts for this session only */
  }
}

/** A copy of `paths` with `path` added or removed. */
export function togglePath(paths: Set<string>, path: string, on: boolean): Set<string> {
  const next = new Set(paths);
  const key = normalizeProjectPath(path);
  if (on) next.add(key);
  else next.delete(key);
  return next;
}

/** Drop hidden projects and float pinned ones to the top, keeping the order
 *  the list already had within each group. Rows without a path (an empty
 *  collection) can be neither. */
export function applyProjectPrefs<T extends { path: string }>(
  items: readonly T[],
  hidden: ReadonlySet<string>,
  pinned: ReadonlySet<string>,
): T[] {
  const visible = items.filter((item) => !item.path || !hidden.has(normalizeProjectPath(item.path)));
  const isPinned = (item: T) => Boolean(item.path) && pinned.has(normalizeProjectPath(item.path));
  return [...visible.filter(isPinned), ...visible.filter((item) => !isPinned(item))];
}
