/**
 * The orchestrator's `edit_file` engine: exact match first, then a short chain
 * of fuzzy fallbacks (after OpenCode's replacers and Codex's seek_sequence),
 * always requiring a UNIQUE match so a loose pattern never edits the wrong
 * place. Line endings are matched in LF and written back in the file's own
 * style, so a model's `\n` old_string still hits a CRLF file on Windows.
 *
 * Pure: the store's executor does the I/O.
 */

export type EditMatcher =
  | 'exact'
  | 'line-number-prefix'
  | 'trailing-whitespace'
  | 'trimmed-lines'
  | 'whitespace-normalized'
  | 'unicode-normalized'
  | 'block-anchor';

export type TextEditResult =
  | { ok: true; content: string; matcher: EditMatcher; replacements: number }
  | { ok: false; reason: 'empty' | 'not-found' | 'ambiguous' | 'unchanged'; count?: number; matcher?: EditMatcher };

interface Range { start: number; end: number }

function exactRanges(haystack: string, needle: string): Range[] {
  const ranges: Range[] = [];
  let index = haystack.indexOf(needle);
  while (index !== -1) {
    ranges.push({ start: index, end: index + needle.length });
    index = haystack.indexOf(needle, index + needle.length);
  }
  return ranges;
}

interface Lines { text: string[]; starts: number[] }

function splitLines(content: string): Lines {
  const text = content.split('\n');
  const starts: number[] = [];
  let offset = 0;
  for (const line of text) {
    starts.push(offset);
    offset += line.length + 1;
  }
  return { text, starts };
}

const UNICODE_PUNCTUATION: Array<[RegExp, string]> = [
  [/[‘’‚‛]/g, "'"],
  [/[“”„‟]/g, '"'],
  [/[‐-―−]/g, '-'],
  [/…/g, '...'],
  [/ /g, ' '],
];

function normalizeUnicode(line: string): string {
  let out = line;
  for (const [re, replacement] of UNICODE_PUNCTUATION) out = out.replace(re, replacement);
  return out.trim();
}

/**
 * Line-block search with a line comparator. The needle's trailing newline, if
 * any, is kept in the replaced range so the replacement's own newline lines up.
 */
function blockRanges(content: Lines, needle: string, same: (a: string, b: string) => boolean): Range[] {
  const endsWithNewline = needle.endsWith('\n');
  const needleLines = (endsWithNewline ? needle.slice(0, -1) : needle).split('\n');
  const ranges: Range[] = [];
  for (let i = 0; i + needleLines.length <= content.text.length; i += 1) {
    let match = true;
    for (let j = 0; j < needleLines.length; j += 1) {
      if (!same(content.text[i + j], needleLines[j])) { match = false; break; }
    }
    if (!match) continue;
    const last = i + needleLines.length - 1;
    const end = content.starts[last] + content.text[last].length + (endsWithNewline && last < content.text.length - 1 ? 1 : 0);
    ranges.push({ start: content.starts[i], end });
  }
  return ranges;
}

function levenshtein(a: string, b: string): number {
  if (a === b) return 0;
  if (!a.length) return b.length;
  if (!b.length) return a.length;
  let previous = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i += 1) {
    const current = [i];
    for (let j = 1; j <= b.length; j += 1) {
      current[j] = Math.min(previous[j] + 1, current[j - 1] + 1, previous[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
    previous = current;
  }
  return previous[b.length];
}

function similarity(a: string, b: string): number {
  const x = a.trim();
  const y = b.trim();
  const longest = Math.max(x.length, y.length);
  return longest === 0 ? 1 : 1 - levenshtein(x, y) / longest;
}

/**
 * First and last lines anchor the block exactly (trimmed); the middle may have
 * drifted, but must stay similar. Only for blocks of 3+ lines, same length.
 */
function anchorRanges(content: Lines, needle: string): Range[] {
  const endsWithNewline = needle.endsWith('\n');
  const needleLines = (endsWithNewline ? needle.slice(0, -1) : needle).split('\n');
  if (needleLines.length < 3) return [];
  const first = needleLines[0].trim();
  const last = needleLines[needleLines.length - 1].trim();
  if (!first || !last) return [];
  const ranges: Range[] = [];
  for (let i = 0; i + needleLines.length <= content.text.length; i += 1) {
    const endLine = i + needleLines.length - 1;
    if (content.text[i].trim() !== first || content.text[endLine].trim() !== last) continue;
    let total = 0;
    for (let j = 1; j < needleLines.length - 1; j += 1) total += similarity(content.text[i + j], needleLines[j]);
    if (total / (needleLines.length - 2) < 0.7) continue;
    const end = content.starts[endLine] + content.text[endLine].length + (endsWithNewline && endLine < content.text.length - 1 ? 1 : 0);
    ranges.push({ start: content.starts[i], end });
  }
  return ranges;
}

const LINE_NUMBER_PREFIX_RE = /^\s*\d+: ?/;

/** read_file prints `N: ` before every line; a model sometimes copies it. */
function stripLineNumberPrefixes(needle: string): string | null {
  const lines = needle.split('\n');
  const meaningful = lines.filter((line) => line.length > 0);
  if (!meaningful.length || !meaningful.every((line) => LINE_NUMBER_PREFIX_RE.test(line))) return null;
  return lines.map((line) => line.replace(LINE_NUMBER_PREFIX_RE, '')).join('\n');
}

const leadingWhitespace = (line: string) => /^[ \t]*/.exec(line)?.[0] ?? '';
const firstMeaningfulLine = (text: string) => text.split('\n').find((line) => line.trim()) ?? '';

/**
 * A fuzzy match usually means the model got the indentation wrong in BOTH
 * strings. Shift the replacement by the same amount the match was shifted, but
 * only when every replacement line carries the model's base indentation.
 */
function reindent(replacement: string, needle: string, matched: string): string {
  const needleBase = leadingWhitespace(firstMeaningfulLine(needle));
  const matchedBase = leadingWhitespace(firstMeaningfulLine(matched));
  if (needleBase === matchedBase) return replacement;
  const lines = replacement.split('\n');
  if (!lines.every((line) => !line.trim() || line.startsWith(needleBase))) return replacement;
  return lines.map((line) => (line.trim() ? matchedBase + line.slice(needleBase.length) : line)).join('\n');
}

/**
 * Apply one edit. `replaceAll` applies only to exact matches: a fuzzy pattern
 * that hits several places is ambiguous by definition.
 */
export function applyTextEdit(content: string, oldString: string, newString: string, replaceAll = false): TextEditResult {
  const eol = content.includes('\r\n') ? '\r\n' : '\n';
  const source = content.replace(/\r\n/g, '\n');
  const needle = oldString.replace(/\r\n/g, '\n');
  const replacement = newString.replace(/\r\n/g, '\n');
  if (!needle) return { ok: false, reason: 'empty' };
  if (needle === replacement) return { ok: false, reason: 'unchanged' };
  const restore = (text: string) => (eol === '\r\n' ? text.replace(/\n/g, '\r\n') : text);

  const exact = exactRanges(source, needle);
  if (exact.length === 1 || (replaceAll && exact.length > 1)) {
    return { ok: true, content: restore(source.split(needle).join(replacement)), matcher: 'exact', replacements: exact.length };
  }
  if (exact.length > 1) return { ok: false, reason: 'ambiguous', count: exact.length, matcher: 'exact' };

  const lines = splitLines(source);
  const unprefixed = stripLineNumberPrefixes(needle);
  const unprefixedReplacement = unprefixed === null ? null : stripLineNumberPrefixes(replacement);
  const attempts: Array<{ matcher: EditMatcher; needle: string; replacement: string; find: () => Range[] }> = [];
  if (unprefixed !== null) {
    const next = unprefixedReplacement ?? replacement;
    attempts.push({ matcher: 'line-number-prefix', needle: unprefixed, replacement: next, find: () => exactRanges(source, unprefixed) });
  }
  const fuzzyNeedle = unprefixed ?? needle;
  const fuzzyReplacement = unprefixedReplacement ?? replacement;
  const block = (matcher: EditMatcher, same: (a: string, b: string) => boolean) => attempts.push({
    matcher, needle: fuzzyNeedle, replacement: fuzzyReplacement, find: () => blockRanges(lines, fuzzyNeedle, same),
  });
  block('trailing-whitespace', (a, b) => a.trimEnd() === b.trimEnd());
  block('trimmed-lines', (a, b) => a.trim() === b.trim());
  block('whitespace-normalized', (a, b) => a.replace(/\s+/g, ' ').trim() === b.replace(/\s+/g, ' ').trim());
  block('unicode-normalized', (a, b) => normalizeUnicode(a) === normalizeUnicode(b));
  attempts.push({ matcher: 'block-anchor', needle: fuzzyNeedle, replacement: fuzzyReplacement, find: () => anchorRanges(lines, fuzzyNeedle) });

  for (const attempt of attempts) {
    const ranges = attempt.find();
    if (!ranges.length) continue;
    if (ranges.length > 1) return { ok: false, reason: 'ambiguous', count: ranges.length, matcher: attempt.matcher };
    const [range] = ranges;
    const matched = source.slice(range.start, range.end);
    let text = attempt.matcher === 'line-number-prefix' ? attempt.replacement : reindent(attempt.replacement, attempt.needle, matched);
    // A block that ends the file has no newline to consume; keep the
    // replacement from adding one.
    if (attempt.needle.endsWith('\n') && !matched.endsWith('\n') && text.endsWith('\n')) text = text.slice(0, -1);
    return {
      ok: true,
      content: restore(source.slice(0, range.start) + text + source.slice(range.end)),
      matcher: attempt.matcher,
      replacements: 1,
    };
  }
  return { ok: false, reason: 'not-found' };
}

/**
 * A compact unified diff of one edit: common head/tail lines are trimmed and
 * the changed region is shown with a little context. Long diffs are cut at
 * `maxLines` so a big rewrite cannot flood the model's context.
 */
export function unifiedDiff(path: string, before: string, after: string, maxLines = 80, context = 2): string {
  const a = before.replace(/\r\n/g, '\n').split('\n');
  const b = after.replace(/\r\n/g, '\n').split('\n');
  let head = 0;
  while (head < a.length && head < b.length && a[head] === b[head]) head += 1;
  let tail = 0;
  while (tail < a.length - head && tail < b.length - head && a[a.length - 1 - tail] === b[b.length - 1 - tail]) tail += 1;
  if (head === a.length && head === b.length) return `(no changes to ${path})`;
  const from = Math.max(0, head - context);
  const removed = a.slice(head, a.length - tail);
  const added = b.slice(head, b.length - tail);
  const afterContext = a.slice(a.length - tail, Math.min(a.length, a.length - tail + context));
  const body = [
    ...a.slice(from, head).map((line) => ` ${line}`),
    ...removed.map((line) => `-${line}`),
    ...added.map((line) => `+${line}`),
    ...afterContext.map((line) => ` ${line}`),
  ];
  const oldCount = head - from + removed.length + afterContext.length;
  const newCount = head - from + added.length + afterContext.length;
  const lines = [`--- a/${path}`, `+++ b/${path}`, `@@ -${from + 1},${oldCount} +${from + 1},${newCount} @@`, ...body];
  if (lines.length <= maxLines) return lines.join('\n');
  return `${lines.slice(0, maxLines).join('\n')}\n… (${lines.length - maxLines} more diff lines)`;
}
