import { describe, it, expect } from 'vitest';
import { EditorState, EditorSelection } from '@codemirror/state';
import { columnAt, posAtColumn, selectionWithAddedCursor } from './multi-cursor';

function stateWith(doc: string, cursors: number[], tabSize = 4): EditorState {
  return EditorState.create({
    doc,
    selection: EditorSelection.create(cursors.map((p) => EditorSelection.cursor(p))),
    extensions: [
      EditorState.tabSize.of(tabSize),
      // Without this the state silently collapses to a single range, so every
      // multi-cursor assertion would be testing the wrong thing. CodeEditor
      // sets it too — these commands are meaningless without it.
      EditorState.allowMultipleSelections.of(true),
    ],
  });
}

describe('columnAt / posAtColumn', () => {
  it('counts plain characters one per column', () => {
    const state = stateWith('hello\nworld', [3]);
    expect(columnAt(state, 3)).toBe(3);
  });

  it('expands a tab to the next tab stop, not one column', () => {
    // "\tx" — the tab occupies columns 0-3, so x sits at column 4.
    const state = stateWith('\tx', [2], 4);
    expect(columnAt(state, 1)).toBe(4);
    expect(columnAt(state, 2)).toBe(5);
  });

  it('round-trips a column back to an offset', () => {
    const state = stateWith('    indented', [0], 4);
    const pos = posAtColumn(state, 1, 4);
    expect(columnAt(state, pos)).toBe(4);
  });

  it('clamps to the end of a short line instead of spilling over', () => {
    const state = stateWith('long line here\nab', [0]);
    // Column 10 does not exist on line 2; the offset must stay inside it.
    const pos = posAtColumn(state, 2, 10);
    expect(pos).toBe(state.doc.line(2).to);
  });
});

describe('selectionWithAddedCursor', () => {
  it('adds a cursor on the line below at the same column', () => {
    const state = stateWith('abcdef\nabcdef', [3]);
    const selection = selectionWithAddedCursor(state, 1)!;
    expect(selection.ranges).toHaveLength(2);
    // Line 2 starts at offset 7, so column 3 is offset 10.
    expect(selection.ranges.map((r) => r.head).sort((a, b) => a - b)).toEqual([3, 10]);
  });

  it('adds a cursor on the line above', () => {
    const state = stateWith('abcdef\nabcdef', [10]);
    const selection = selectionWithAddedCursor(state, -1)!;
    expect(selection.ranges.map((r) => r.head).sort((a, b) => a - b)).toEqual([3, 10]);
  });

  it('extends the stack from the leading edge on repeated presses', () => {
    // Cursors on lines 1 and 2; pressing down again must reach line 3, not
    // re-add on line 2 next to the original.
    const state = stateWith('aaaa\nbbbb\ncccc', [1, 6]);
    const selection = selectionWithAddedCursor(state, 1)!;
    expect(selection.ranges).toHaveLength(3);
    expect(Math.max(...selection.ranges.map((r) => r.head))).toBe(11);
  });

  it('extends upward from the topmost cursor', () => {
    const state = stateWith('aaaa\nbbbb\ncccc', [6, 11]);
    const selection = selectionWithAddedCursor(state, -1)!;
    expect(selection.ranges).toHaveLength(3);
    expect(Math.min(...selection.ranges.map((r) => r.head))).toBe(1);
  });

  it('returns null at the first and last line rather than wrapping', () => {
    const top = stateWith('aaaa\nbbbb', [1]);
    expect(selectionWithAddedCursor(top, -1)).toBeNull();
    const bottom = stateWith('aaaa\nbbbb', [6]);
    expect(selectionWithAddedCursor(bottom, 1)).toBeNull();
  });

  it('clamps onto a short line instead of overshooting it', () => {
    // Cursor at column 4 of a long line; the line below has only two characters,
    // so the new cursor lands at its end rather than past it.
    const state = stateWith('abcdefgh\nab\nabcdefgh', [4]);
    const selection = selectionWithAddedCursor(state, 1)!;
    const added = selection.main.head;
    expect(added).toBe(state.doc.line(2).to);
  });

  it('keeps the newly added cursor as the main range', () => {
    const state = stateWith('abcdef\nabcdef', [3]);
    const selection = selectionWithAddedCursor(state, 1)!;
    expect(selection.main.head).toBe(10);
  });

  it('aligns visually through indentation rather than by raw offset', () => {
    // Line 1 is tab-indented, line 2 space-indented to the same visual column.
    // An offset-based implementation would land in the wrong place here.
    const state = stateWith('\tfoo\n    bar', [2], 4);
    expect(columnAt(state, 2)).toBe(5);
    const selection = selectionWithAddedCursor(state, 1)!;
    const added = selection.main.head;
    expect(columnAt(state, added)).toBe(5);
  });
});
