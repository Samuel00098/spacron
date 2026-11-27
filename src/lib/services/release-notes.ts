/**
 * Turns one CHANGELOG release section into the few lines the title bar's
 * update card shows. The same text arrives two ways: as the update's notes
 * (`latest.json`, filled by the release workflow) and from the bundled
 * CHANGELOG for the version already installed.
 */

export interface ReleaseHeadline {
  title: string;
  text: string;
}

export interface ReleaseHighlights {
  items: ReleaseHeadline[];
  /** Bullets that did not fit in `items`. */
  more: number;
}

/** What every release published before its notes were sent with it. */
const PLACEHOLDER = /^see the changelog\b/i;

function plain(text: string): string {
  return text
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/\*\*|`/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/** The body under `## [vX.Y.Z]`, or null when the changelog has no such release. */
export function changelogSection(changelog: string, version: string): string | null {
  const wanted = version.replace(/^v/, '');
  const lines = changelog.replace(/\r\n/g, '\n').split('\n');
  const start = lines.findIndex((line) => /^## \[v?([^\]]+)\]/.exec(line)?.[1] === wanted);
  if (start < 0) return null;
  const end = lines.findIndex((line, i) => i > start && line.startsWith('## '));
  return lines.slice(start + 1, end < 0 ? undefined : end).join('\n').trim() || null;
}

export function releaseHighlights(notes: string | null | undefined, limit = 6): ReleaseHighlights {
  const source = (notes ?? '').replace(/\r\n/g, '\n').trim();
  if (!source || PLACEHOLDER.test(source)) return { items: [], more: 0 };
  const all: ReleaseHeadline[] = [];
  for (const line of source.split('\n')) {
    const bullet = /^[-*] +(.+)$/.exec(line)?.[1];
    if (!bullet) continue;
    const led = /^\*\*(.+?)\*\*\s*(?:[—–:-]\s*)?(.*)$/.exec(bullet);
    all.push(led ? { title: plain(led[1]), text: plain(led[2]) } : { title: '', text: plain(bullet) });
  }
  return { items: all.slice(0, limit), more: Math.max(0, all.length - limit) };
}
