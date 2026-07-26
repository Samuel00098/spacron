import { describe, it, expect } from 'vitest';
import {
  parseUnifiedDiff,
  buildHunkPatch,
  buildLinePatch,
  hunkStats,
  selectableLineIndices,
  findFile,
} from './patch';

const SIMPLE = `diff --git a/src/app.ts b/src/app.ts
index 1111111..2222222 100644
--- a/src/app.ts
+++ b/src/app.ts
@@ -1,4 +1,5 @@
 const a = 1;
-const b = 2;
+const b = 3;
+const c = 4;
 const d = 5;
 const e = 6;
`;

/** Every line of a hunk body must be accounted for by its header counts. */
function assertHeaderMatchesBody(patch: string) {
  const lines = patch.split('\n');
  const headerIndex = lines.findIndex((l) => l.startsWith('@@'));
  expect(headerIndex).toBeGreaterThanOrEqual(0);

  const match = /^@@ -(?:\d+)(?:,(\d+))? \+(?:\d+)(?:,(\d+))? @@/.exec(lines[headerIndex]);
  expect(match).not.toBeNull();
  const oldCount = match![1] === undefined ? 1 : Number(match![1]);
  const newCount = match![2] === undefined ? 1 : Number(match![2]);

  let oldSeen = 0;
  let newSeen = 0;
  for (const line of lines.slice(headerIndex + 1)) {
    if (line === '' || line.startsWith('\\')) continue;
    if (line.startsWith('+')) newSeen += 1;
    else if (line.startsWith('-')) oldSeen += 1;
    else {
      oldSeen += 1;
      newSeen += 1;
    }
  }
  expect({ oldSeen, newSeen }).toEqual({ oldSeen: oldCount, newSeen: newCount });
}

describe('parseUnifiedDiff', () => {
  it('reads paths, hunk bounds and line kinds', () => {
    const [file] = parseUnifiedDiff(SIMPLE);
    expect(file.oldPath).toBe('src/app.ts');
    expect(file.newPath).toBe('src/app.ts');
    expect(file.binary).toBe(false);
    expect(file.hunks).toHaveLength(1);

    const hunk = file.hunks[0];
    expect([hunk.oldStart, hunk.oldCount, hunk.newStart, hunk.newCount]).toEqual([1, 4, 1, 5]);
    expect(hunk.lines.map((l) => l.kind)).toEqual([
      'context',
      'del',
      'add',
      'add',
      'context',
      'context',
    ]);
  });

  it('numbers both sides independently', () => {
    const [file] = parseUnifiedDiff(SIMPLE);
    const lines = file.hunks[0].lines;
    expect(lines[0]).toMatchObject({ oldLine: 1, newLine: 1 });
    expect(lines[1]).toMatchObject({ kind: 'del', oldLine: 2, newLine: null });
    expect(lines[2]).toMatchObject({ kind: 'add', oldLine: null, newLine: 2 });
    expect(lines[3]).toMatchObject({ kind: 'add', oldLine: null, newLine: 3 });
    expect(lines[4]).toMatchObject({ oldLine: 3, newLine: 4 });
  });

  it('treats a missing count as 1, the way git writes it', () => {
    const [file] = parseUnifiedDiff(
      `diff --git a/x b/x\n--- a/x\n+++ b/x\n@@ -7 +7 @@\n-old\n+new\n`,
    );
    expect(file.hunks[0]).toMatchObject({ oldStart: 7, oldCount: 1, newStart: 7, newCount: 1 });
  });

  it('splits a multi-file diff', () => {
    const [a, b] = parseUnifiedDiff(
      `${SIMPLE}diff --git a/other.md b/other.md\n--- a/other.md\n+++ b/other.md\n@@ -1 +1 @@\n-x\n+y\n`,
    );
    expect(a.newPath).toBe('src/app.ts');
    expect(b.newPath).toBe('other.md');
    expect(b.hunks).toHaveLength(1);
  });

  it('reads several hunks in one file', () => {
    const [file] = parseUnifiedDiff(
      `diff --git a/x b/x\n--- a/x\n+++ b/x\n@@ -1,2 +1,2 @@\n-a\n+A\n b\n@@ -10,2 +10,2 @@\n-c\n+C\n d\n`,
    );
    expect(file.hunks).toHaveLength(2);
    expect(file.hunks[1].oldStart).toBe(10);
  });

  it('attaches a no-newline marker to the line it describes', () => {
    const [file] = parseUnifiedDiff(
      `diff --git a/x b/x\n--- a/x\n+++ b/x\n@@ -1 +1 @@\n-old\n\\ No newline at end of file\n+new\n`,
    );
    const lines = file.hunks[0].lines;
    expect(lines[0]).toMatchObject({ kind: 'del', noNewline: true });
    expect(lines[1]).toMatchObject({ kind: 'add', noNewline: false });
  });

  it('flags a binary file and gives it no hunks', () => {
    const [file] = parseUnifiedDiff(
      `diff --git a/logo.png b/logo.png\nindex 111..222 100644\nBinary files a/logo.png and b/logo.png differ\n`,
    );
    expect(file.binary).toBe(true);
    expect(file.hunks).toHaveLength(0);
  });

  it('handles CRLF diffs and empty input', () => {
    expect(parseUnifiedDiff('')).toEqual([]);
    const [file] = parseUnifiedDiff(SIMPLE.replace(/\n/g, '\r\n'));
    expect(file.newPath).toBe('src/app.ts');
    expect(file.hunks[0].lines).toHaveLength(6);
  });
});

describe('buildHunkPatch', () => {
  it('round-trips a whole hunk unchanged', () => {
    const [file] = parseUnifiedDiff(SIMPLE);
    const patch = buildHunkPatch(file, file.hunks[0]);
    expect(patch).toBe(SIMPLE);
    assertHeaderMatchesBody(patch);
  });

  it('emits only the requested hunk from a multi-hunk file', () => {
    const [file] = parseUnifiedDiff(
      `diff --git a/x b/x\n--- a/x\n+++ b/x\n@@ -1,2 +1,2 @@\n-a\n+A\n b\n@@ -10,2 +10,2 @@\n-c\n+C\n d\n`,
    );
    const patch = buildHunkPatch(file, file.hunks[1]);
    expect(patch).toContain('@@ -10,2 +10,2 @@');
    expect(patch).not.toContain('@@ -1,2 +1,2 @@');
    expect(patch).toContain('+C');
    expect(patch).not.toContain('+A');
    assertHeaderMatchesBody(patch);
  });
});

describe('buildLinePatch', () => {
  const [file] = parseUnifiedDiff(SIMPLE);
  const hunk = file.hunks[0];
  // lines: 0 context, 1 del(const b = 2), 2 add(const b = 3), 3 add(const c = 4), 4/5 context

  it('drops an unselected addition entirely', () => {
    // Take only `+const c = 4;`. The other addition never existed as far as this
    // patch is concerned, so it appears on neither side.
    const patch = buildLinePatch(file, hunk, new Set([3]))!;
    expect(patch).toContain('+const c = 4;');
    expect(patch).not.toContain('+const b = 3;');
    assertHeaderMatchesBody(patch);
  });

  it('turns an unselected deletion into context', () => {
    // Selecting only the addition means the deleted line stays, so it has to be
    // present on both sides — as context, not as a deletion.
    const patch = buildLinePatch(file, hunk, new Set([2]))!;
    const body = patch.split('\n').slice(patch.split('\n').findIndex((l) => l.startsWith('@@')) + 1);
    expect(body).toContain(' const b = 2;');
    expect(body).not.toContain('-const b = 2;');
    assertHeaderMatchesBody(patch);
  });

  it('recomputes both counts for a partial selection', () => {
    // Only the deletion: old side keeps all 4 original lines, new side loses one.
    const patch = buildLinePatch(file, hunk, new Set([1]))!;
    expect(patch).toContain('@@ -1,4 +1,3 @@');
    assertHeaderMatchesBody(patch);
  });

  it('reproduces the whole hunk when everything is selected', () => {
    const patch = buildLinePatch(file, hunk, new Set(selectableLineIndices(hunk)))!;
    expect(patch).toBe(buildHunkPatch(file, hunk));
    assertHeaderMatchesBody(patch);
  });

  it('keeps the old start unchanged — the old side is what we apply against', () => {
    const [multi] = parseUnifiedDiff(
      `diff --git a/x b/x\n--- a/x\n+++ b/x\n@@ -42,2 +42,3 @@\n ctx\n-gone\n+kept\n+also\n`,
    );
    // Take only `+kept`: the deletion becomes context (old 2, new 3), and the
    // start stays 42 because the old side we apply against has not moved.
    const patch = buildLinePatch(multi, multi.hunks[0], new Set([2]))!;
    expect(patch).toContain('@@ -42,2 +42,3 @@');
    assertHeaderMatchesBody(patch);

    // Take only the deletion: new side shrinks to one line, so the count is
    // omitted — git's own convention, and one `git apply` expects back.
    const removal = buildLinePatch(multi, multi.hunks[0], new Set([1]))!;
    expect(removal).toContain('@@ -42,2 +42 @@');
    assertHeaderMatchesBody(removal);
  });

  it('returns null for an empty selection rather than an unappliable patch', () => {
    expect(buildLinePatch(file, hunk, new Set())).toBeNull();
    // Selecting only context is also nothing to apply.
    expect(buildLinePatch(file, hunk, new Set([0, 4, 5]))).toBeNull();
  });

  it('carries the no-newline marker only for lines it emits', () => {
    const [f] = parseUnifiedDiff(
      `diff --git a/x b/x\n--- a/x\n+++ b/x\n@@ -1,2 +1,2 @@\n a\n-b\n\\ No newline at end of file\n+c\n\\ No newline at end of file\n`,
    );
    const h = f.hunks[0];
    // Take only the addition: the deletion becomes context and keeps its marker,
    // because the line really does still lack a trailing newline.
    const patch = buildLinePatch(f, h, new Set([2]))!;
    expect(patch).toContain(' b\n\\ No newline at end of file');
  });

  it('handles a pure addition hunk against an empty file', () => {
    const [f] = parseUnifiedDiff(
      `diff --git a/new.txt b/new.txt\n--- /dev/null\n+++ b/new.txt\n@@ -0,0 +1,3 @@\n+one\n+two\n+three\n`,
    );
    const patch = buildLinePatch(f, f.hunks[0], new Set([0, 2]))!;
    expect(patch).toContain('@@ -0,0 +1,2 @@');
    expect(patch).toContain('+one');
    expect(patch).toContain('+three');
    expect(patch).not.toContain('+two');
  });

  it('preserves the file header so git apply knows the target', () => {
    const patch = buildLinePatch(file, hunk, new Set([2]))!;
    expect(patch.startsWith('diff --git a/src/app.ts b/src/app.ts\n')).toBe(true);
    expect(patch).toContain('--- a/src/app.ts');
    expect(patch).toContain('+++ b/src/app.ts');
  });

  it('ends with a newline, which git apply requires', () => {
    expect(buildLinePatch(file, hunk, new Set([2]))!.endsWith('\n')).toBe(true);
    expect(buildHunkPatch(file, hunk).endsWith('\n')).toBe(true);
  });
});

describe('helpers', () => {
  const [file] = parseUnifiedDiff(SIMPLE);

  it('counts a hunk', () => {
    expect(hunkStats(file.hunks[0])).toEqual({ additions: 2, deletions: 1 });
  });

  it('lists only the lines a user can pick', () => {
    expect(selectableLineIndices(file.hunks[0])).toEqual([1, 2, 3]);
  });

  it('finds a file by either side of a rename, and normalises separators', () => {
    expect(findFile([file], 'src/app.ts')).toBe(file);
    expect(findFile([file], 'src\\app.ts')).toBe(file);
    expect(findFile([file], 'nope.ts')).toBeNull();
  });
});
