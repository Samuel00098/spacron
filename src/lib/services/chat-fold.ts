/** Folding a long sent message behind a "Show more" toggle (Orca folds them too). */
export const FOLD_MAX_CHARS = 700;
export const FOLD_MAX_LINES = 14;
const FOLD_KEEP_LINES = 10;
const FOLD_KEEP_CHARS = 520;

export interface FoldedText {
  /** True when the text is long enough to fold. */
  long: boolean;
  /** What to show while folded (the whole text when it is not long). */
  preview: string;
  hiddenLines: number;
}

export function foldUserText(text: string): FoldedText {
  const lines = text.split('\n');
  if (text.length <= FOLD_MAX_CHARS && lines.length <= FOLD_MAX_LINES) return { long: false, preview: text, hiddenLines: 0 };
  let preview = lines.slice(0, FOLD_KEEP_LINES).join('\n');
  if (preview.length > FOLD_KEEP_CHARS) preview = preview.slice(0, FOLD_KEEP_CHARS).trimEnd();
  const shown = preview.split('\n').length;
  return { long: true, preview: `${preview}…`, hiddenLines: Math.max(0, lines.length - shown) };
}
