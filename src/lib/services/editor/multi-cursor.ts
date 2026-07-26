/**
 * Add-cursor-above / add-cursor-below.
 *
 * CodeMirror ships the box-selection gesture (`rectangularSelection`) and
 * `Mod-d` occurrence-select (via `searchKeymap`), but no command for stacking a
 * cursor onto the adjacent line — the `Ctrl+Alt+Up/Down` half of what people
 * mean by "multi-cursor". These two supply it.
 *
 * The geometry is deliberately column-based rather than offset-based: stepping
 * by a fixed character offset lands in the wrong place the moment lines differ
 * in length, which is exactly when you are stacking cursors.
 */
import { EditorSelection, type EditorState, type SelectionRange } from '@codemirror/state';
import type { Command } from '@codemirror/view';

/**
 * The visual column of `pos`, counting a tab as `tabSize` columns so a cursor
 * stacked through indented code stays visually aligned.
 */
export function columnAt(state: EditorState, pos: number): number {
  const line = state.doc.lineAt(pos);
  const text = line.text.slice(0, pos - line.from);
  const tabSize = state.tabSize;
  let column = 0;
  for (const ch of text) {
    column += ch === '\t' ? tabSize - (column % tabSize) : 1;
  }
  return column;
}

/** The offset in `lineNumber` nearest to visual column `column`. */
export function posAtColumn(state: EditorState, lineNumber: number, column: number): number {
  const line = state.doc.line(lineNumber);
  const tabSize = state.tabSize;
  let current = 0;
  let offset = 0;
  for (const ch of line.text) {
    if (current >= column) break;
    current += ch === '\t' ? tabSize - (current % tabSize) : 1;
    offset += ch.length;
  }
  // Short lines clamp to their end rather than spilling onto the next one.
  return line.from + Math.min(offset, line.length);
}

/**
 * Compute the selection produced by stacking a cursor one line `direction` from
 * the outermost existing cursor.
 *
 * Exported separately from the command so the geometry is testable without an
 * `EditorView`. Returns null when there is nowhere to go — the caller then
 * leaves the selection untouched and reports the key as unhandled.
 */
export function selectionWithAddedCursor(
  state: EditorState,
  direction: -1 | 1,
): EditorSelection | null {
  const ranges = state.selection.ranges;
  // Grow from the edge in the direction of travel, so repeated presses extend
  // the stack instead of toggling between two lines.
  const anchorRange: SelectionRange =
    direction === -1
      ? ranges.reduce((a, b) => (b.head < a.head ? b : a))
      : ranges.reduce((a, b) => (b.head > a.head ? b : a));

  const line = state.doc.lineAt(anchorRange.head);
  const targetLineNumber = line.number + direction;
  if (targetLineNumber < 1 || targetLineNumber > state.doc.lines) return null;

  const column = columnAt(state, anchorRange.head);
  const pos = posAtColumn(state, targetLineNumber, column);

  // Already have a cursor there (two presses that collapse onto the same short
  // line) — adding a duplicate would silently do nothing visible.
  if (ranges.some((range) => range.empty && range.head === pos)) return null;

  const next = [...ranges, EditorSelection.cursor(pos)];
  return EditorSelection.create(next, next.length - 1);
}

function addCursor(direction: -1 | 1): Command {
  return (view) => {
    const selection = selectionWithAddedCursor(view.state, direction);
    if (!selection) return false;
    view.dispatch({ selection, scrollIntoView: true });
    return true;
  };
}

export const addCursorAbove = addCursor(-1);
export const addCursorBelow = addCursor(1);

/**
 * macOS reports itself through `platform` (deprecated but still the only
 * synchronous signal available in the WebView) or `userAgent`. Falls back to the
 * Windows/Linux label, which is the right default for a Tauri app that ships
 * primarily there.
 */
function isMacPlatform(): boolean {
  if (typeof navigator === 'undefined') return false;
  const probe = `${navigator.platform ?? ''} ${navigator.userAgent ?? ''}`;
  return /Mac|iPhone|iPad/i.test(probe);
}

/** Platform-correct label for the box-selection drag, for settings and help UI. */
export const COLUMN_SELECT_GESTURE = isMacPlatform()
  ? 'Option+Shift+drag'
  : 'Alt+Shift+drag';

/** Platform-correct label for cursor stacking. */
export const ADD_CURSOR_GESTURE = isMacPlatform()
  ? 'Cmd+Option+↑/↓'
  : 'Ctrl+Alt+↑/↓';
