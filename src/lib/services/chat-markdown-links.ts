/**
 * Helpers for turning Markdown links in agent chat replies into local file
 * targets while keeping DOMPurify's XSS protections intact.
 */

/**
 * Extends DOMPurify's default URI allowlist with:
 * - `file:` URIs (`file:///C:/...`, `file:///home/...`)
 * - Windows drive-letter paths (`C:/...`, `C:\...`)
 * - Single-segment filenames carrying a `:line` or `:line:col` suffix (`release.yml:42`)
 *
 * Unsafe schemes (`javascript:`, `vbscript:`, `data:`, etc.) remain blocked.
 */
export const CHAT_MARKDOWN_URI_REGEXP =
  /^(?:(?:(?:f|ht)tps?|file|mailto|tel|callto|sms|cid|xmpp|matrix):|[a-z]:[\\/]|[a-z0-9._-]+\.[a-z0-9]+:\d+(?::\d+)?$|[^a-z]|[a-z+.\-]+(?:[^a-z+.\-:]|$))/i;

export interface ParsedChatFileLink {
  path: string;
  line?: number;
}

/**
 * Parse a Markdown link `href` into a local file path (and optional 1-based line
 * number). Returns `null` for web/mail/other URI schemes or pure `#anchor` links.
 */
export function parseChatFileLink(href: string): ParsedChatFileLink | null {
  const raw = href.trim();
  if (!raw || raw.startsWith('#')) return null;

  let candidate = raw;
  const schemeMatch = /^([a-zA-Z][a-zA-Z0-9+.-]*):/.exec(raw);

  if (schemeMatch) {
    const scheme = schemeMatch[1].toLowerCase();
    if (scheme === 'file') {
      if (/^file:\/\/([a-zA-Z]:[\\/].*)$/i.test(raw)) {
        // Two-slash Windows form some agents emit: `file://C:/path/to/file`
        candidate = raw.slice('file://'.length);
      } else if (/^file:\/\/\/?/i.test(raw)) {
        // Standard `file:///path` or `file://localhost/path`
        candidate = raw.slice('file://'.length).replace(/^[^/]*/, '');
      } else if (/^file:\//i.test(raw)) {
        // Single-slash form: `file:/C:/path` or `file:/home/path`
        candidate = raw.slice('file:'.length);
      } else {
        return null;
      }
    } else if (/^[a-zA-Z]:[\\/]/.test(raw)) {
      // Bare Windows drive path: `C:/...` or `C:\...`
      candidate = raw;
    } else if (/^[a-zA-Z0-9._-]+\.[a-zA-Z0-9]+:\d+(?::\d+)?(?:$|[?#])/.test(raw)) {
      // Bare filename with line/column suffix: `release.yml:42` or `app.ts:10:5`
      candidate = raw;
    } else {
      // Web (`http:`, `https:`), `mailto:`, `tel:`, `javascript:`, etc.
      return null;
    }
  }

  // Split fragment and query before decoding so `%23` in filenames stays literal.
  let fragment = '';
  const hashIndex = candidate.indexOf('#');
  if (hashIndex >= 0) {
    fragment = candidate.slice(hashIndex + 1);
    candidate = candidate.slice(0, hashIndex);
  }
  const queryIndex = candidate.indexOf('?');
  if (queryIndex >= 0) {
    candidate = candidate.slice(0, queryIndex);
  }

  let decoded = candidate;
  try {
    decoded = decodeURIComponent(candidate);
  } catch {
    // Keep the literal string if a filename contains an unescaped `%`.
  }

  // `file:///C:/foo` or `file:///C%3A/foo` leaves a leading slash before the drive letter.
  if (/^\/[a-zA-Z]:[\\/]/.test(decoded)) {
    decoded = decoded.slice(1);
  }

  let line: number | undefined;
  if (fragment) {
    const lineMatch = /^(?:L(\d+)(?:-L?\d+)?|line=(\d+)|(\d+)(?:-\d+)?)$/i.exec(fragment);
    const parsed = lineMatch ? Number(lineMatch[1] ?? lineMatch[2] ?? lineMatch[3]) : NaN;
    if (Number.isInteger(parsed) && parsed > 0) line = parsed;
  }

  // Trailing `:line` or `:line:col` suffix on the path itself (e.g. `src/a.ts:42:5`).
  const suffixMatch = /^(.+?):(\d+)(?::\d+)?$/.exec(decoded);
  if (suffixMatch && suffixMatch[1]) {
    decoded = suffixMatch[1];
    if (line === undefined) {
      const parsed = Number(suffixMatch[2]);
      if (Number.isInteger(parsed) && parsed > 0) line = parsed;
    }
  }

  decoded = decoded.trim();
  if (!decoded) return null;

  return line !== undefined ? { path: decoded, line } : { path: decoded };
}

/**
 * Resolve a local file path against a session root folder.
 * On Windows, a leading single `/` (like `/.github/workflows/release.yml`) is
 * treated as repo-root-relative rather than drive-root-absolute.
 */
export function resolveChatFilePath(root: string | null, path: string): string {
  if (!root) return path;
  if (/^[a-zA-Z]:[\\/]/.test(path) || /^(\/\/|\\\\)/.test(path)) return path;
  if (path.startsWith('/')) {
    if (/^[a-zA-Z]:[\\/]/.test(root)) {
      return `${root.replace(/[\\/]+$/, '')}/${path.slice(1)}`;
    }
    return path;
  }
  return `${root.replace(/[\\/]+$/, '')}/${path.replace(/^\.\//, '')}`;
}
