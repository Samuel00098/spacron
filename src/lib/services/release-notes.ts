/**
 * Turns one CHANGELOG release section, sent as the update's notes
 * (`latest.json`, filled by the release workflow), into the few lines the
 * title bar's update card shows.
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
