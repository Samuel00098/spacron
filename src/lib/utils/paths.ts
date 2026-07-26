// Pure path helpers for deciding which directory a shell should start in.
// Deliberately dependency-free (no Tauri, no stores) so the rules below are
// unit-testable in isolation.

/** Normalise for comparison: single forward slashes, no trailing slash. */
function normalize(path: string): string {
  return path.replace(/[\\/]+/g, '/').replace(/\/+$/, '');
}

/**
 * Convert an LSP `file://` URI to a filesystem path.
 *
 * Language servers hand back URIs; everything else in the app (the editor,
 * `fs_read_file`, the explorer) speaks paths. Returns forward-slash form, which
 * Tauri accepts on Windows too — deliberately NOT converting to backslashes, so
 * a value read straight from a server compares cleanly against normalised paths.
 */
export function fileUriToPath(uri: string): string {
  if (!uri.startsWith('file://')) return uri;
  // Drop the scheme and any (always-empty in practice) authority.
  let path = uri.slice('file://'.length).replace(/^[^/]*/, '');
  try {
    path = decodeURIComponent(path);
  } catch {
    /* leave percent-encoding in place rather than throwing on a malformed URI */
  }
  // Windows drive paths arrive as `/C:/x` — strip the leading slash.
  if (/^\/[a-zA-Z]:/.test(path)) path = path.slice(1);
  return path;
}

/** True when two paths refer to the same file, ignoring separators and case. */
export function samePath(a: string | null | undefined, b: string | null | undefined): boolean {
  if (!a || !b) return false;
  return normalize(a).toLowerCase() === normalize(b).toLowerCase();
}

/**
 * True when `filePath` is `root` or sits underneath it.
 *
 * Compared component-wise, so a sibling directory that merely shares a prefix
 * (`/work/proj-evil` against root `/work/proj`) does NOT match. Case-insensitive
 * because Windows paths reach us with inconsistent drive/segment casing and a
 * case-sensitive check there produces false negatives.
 */
export function isInsideRoot(filePath: string | null | undefined, root: string | null | undefined): boolean {
  if (!filePath || !root) return false;
  const file = normalize(filePath).toLowerCase();
  const base = normalize(root).toLowerCase();
  if (!base) return false;
  return file === base || file.startsWith(`${base}/`);
}

/**
 * Directory a new shell should open in for a project.
 *
 * Follows the active file's directory as a convenience, but ONLY when that file
 * belongs to this project. `activeFile` is a single global slot shared by every
 * project (and repopulated from persisted per-project state on launch), so
 * following it unconditionally opened terminals in whichever project happened to
 * be focused last. Falls back to the project root, and returns undefined when
 * the root isn't known yet — callers must treat that as "not ready" rather than
 * spawning a shell with no cwd, because the backend then errors out.
 */
export function resolveStartingCwd(
  activeFile: string | null | undefined,
  projectRoot: string | null | undefined,
): string | undefined {
  const root = projectRoot?.trim() || undefined;
  if (!root) return undefined;
  if (!isInsideRoot(activeFile, root)) return root;

  const file = activeFile!;
  const lastSep = Math.max(file.lastIndexOf('/'), file.lastIndexOf('\\'));
  if (lastSep === -1) return root;
  const dir = file.slice(0, lastSep);
  // A file directly at the root has the root itself as its directory.
  return dir || root;
}
