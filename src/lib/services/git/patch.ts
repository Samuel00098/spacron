/**
 * Unified-diff parsing and patch synthesis for hunk- and line-level staging.
 *
 * Staging part of a file means handing `git apply --cached` a patch containing
 * only the parts you chose. Getting that wrong is not a cosmetic failure: git
 * rejects a patch whose `@@ -a,b +c,d @@` counts don't match its body, so the
 * arithmetic below is the load-bearing part of the feature and is tested
 * directly rather than through the UI.
 *
 * Which diff to feed in, and which direction to apply:
 *
 *   stage    ← `git diff` (index → worktree),        applied `--cached`
 *   unstage  ← `git diff --cached` (HEAD → index),   applied `--cached --reverse`
 *
 * In both cases the patch describes the *current* old side, so hunk starts are
 * carried through unchanged and only the counts are recomputed.
 */

export type PatchLineKind = 'context' | 'add' | 'del';

export interface PatchLine {
  kind: PatchLineKind;
  /** Line content without the leading +/-/space marker. */
  text: string;
  /** Index within the parent hunk's `lines`, used as the selection key. */
  index: number;
  /** 1-based line number on the old side, or null for additions. */
  oldLine: number | null;
  /** 1-based line number on the new side, or null for deletions. */
  newLine: number | null;
  /**
   * True when this line was followed by `\ No newline at end of file`. The
   * marker belongs to the line, not the hunk, so it travels with it — emitting
   * it for a line that was dropped produces a patch git refuses.
   */
  noNewline: boolean;
}

export interface PatchHunk {
  oldStart: number;
  oldCount: number;
  newStart: number;
  newCount: number;
  /** Trailing section text after the second `@@`, preserved for display. */
  heading: string;
  lines: PatchLine[];
}

export interface PatchFile {
  /** `diff --git`, `index`, mode, `---`, `+++` lines, kept verbatim. */
  headerLines: string[];
  oldPath: string;
  newPath: string;
  /** Binary files have no hunks and cannot be partially staged. */
  binary: boolean;
  hunks: PatchHunk[];
}

const HUNK_RE = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@(.*)$/;

/**
 * Parse a `git diff` into files and hunks.
 *
 * Tolerant by design: unknown header lines are carried through untouched so a
 * rebuilt patch keeps whatever git chose to emit (mode changes, rename
 * metadata), and anything before the first `diff --git` is ignored.
 */
export function parseUnifiedDiff(text: string): PatchFile[] {
  if (!text) return [];
  const lines = text.split('\n');
  // A trailing newline produces a final empty element that is not a diff line.
  if (lines.length && lines[lines.length - 1] === '') lines.pop();

  const files: PatchFile[] = [];
  let file: PatchFile | null = null;
  let hunk: PatchHunk | null = null;
  let oldLine = 0;
  let newLine = 0;

  const closeHunk = () => {
    hunk = null;
  };

  for (const raw of lines) {
    const line = raw.endsWith('\r') ? raw.slice(0, -1) : raw;

    if (line.startsWith('diff --git ')) {
      closeHunk();
      file = {
        headerLines: [line],
        oldPath: '',
        newPath: '',
        binary: false,
        hunks: [],
      };
      files.push(file);
      continue;
    }
    if (!file) continue;

    // A hunk header ends any hunk in progress. Checked before the body handling
    // because a body line always starts with ' ', '+', '-' or '\', so a line
    // beginning with '@' inside a hunk can only be the next hunk.
    const match = HUNK_RE.exec(line);
    if (match) {
      oldLine = Number(match[1]);
      newLine = Number(match[3]);
      hunk = {
        oldStart: oldLine,
        oldCount: match[2] === undefined ? 1 : Number(match[2]),
        newStart: newLine,
        newCount: match[4] === undefined ? 1 : Number(match[4]),
        heading: match[5] ?? '',
        lines: [],
      };
      file.hunks.push(hunk);
      continue;
    }

    if (!hunk) {
      if (line.startsWith('--- ')) {
        file.oldPath = stripPathPrefix(line.slice(4));
      } else if (line.startsWith('+++ ')) {
        file.newPath = stripPathPrefix(line.slice(4));
      } else if (line.startsWith('Binary files ') || line.startsWith('GIT binary patch')) {
        file.binary = true;
      }
      file.headerLines.push(line);
      continue;
    }

    // Inside a hunk.
    if (line.startsWith('\\')) {
      // `\ No newline at end of file` — attach to the line it describes.
      const previous = hunk.lines[hunk.lines.length - 1];
      if (previous) previous.noNewline = true;
      continue;
    }

    const marker = line[0] ?? ' ';
    const body = line.slice(1);
    if (marker === '+') {
      hunk.lines.push({
        kind: 'add',
        text: body,
        index: hunk.lines.length,
        oldLine: null,
        newLine: newLine++,
        noNewline: false,
      });
    } else if (marker === '-') {
      hunk.lines.push({
        kind: 'del',
        text: body,
        index: hunk.lines.length,
        oldLine: oldLine++,
        newLine: null,
        noNewline: false,
      });
    } else if (marker === ' ') {
      hunk.lines.push({
        kind: 'context',
        text: body,
        index: hunk.lines.length,
        oldLine: oldLine++,
        newLine: newLine++,
        noNewline: false,
      });
    } else {
      // Not a hunk body line — the hunk ended and this belongs to the next file
      // section (or is trailing noise). Reprocessing it as a header keeps
      // `diff --git` detection working for multi-file diffs.
      closeHunk();
      if (line.startsWith('diff --git ')) {
        file = {
          headerLines: [line],
          oldPath: '',
          newPath: '',
          binary: false,
          hunks: [],
        };
        files.push(file);
      }
    }
  }

  return files;
}

/** `a/src/x.ts` → `src/x.ts`; `/dev/null` is left alone. */
function stripPathPrefix(path: string): string {
  const trimmed = path.trim();
  if (trimmed === '/dev/null') return trimmed;
  return trimmed.replace(/^[ab]\//, '');
}

/** Render one line back into unified-diff form, marker and all. */
function renderLine(kind: PatchLineKind, line: PatchLine): string {
  const marker = kind === 'add' ? '+' : kind === 'del' ? '-' : ' ';
  const rendered = `${marker}${line.text}`;
  return line.noNewline ? `${rendered}\n\\ No newline at end of file` : rendered;
}

/**
 * A patch containing exactly one whole hunk of one file.
 *
 * The counts are copied rather than recomputed — a whole hunk taken verbatim is
 * already consistent, and recomputing would mask a parser bug instead of
 * letting `git apply` catch it.
 */
export function buildHunkPatch(file: PatchFile, hunk: PatchHunk): string {
  const body = hunk.lines.map((line) => renderLine(line.kind, line));
  return [
    ...file.headerLines,
    formatHunkHeader(hunk.oldStart, hunk.oldCount, hunk.newStart, hunk.newCount, hunk.heading),
    ...body,
    '',
  ].join('\n');
}

/**
 * A patch containing only the selected lines of one hunk.
 *
 * The two rules that make this work, and that the counts follow from:
 *
 *   - An **unselected addition is dropped**. It exists only in the working tree,
 *     so it appears on neither side of a patch that leaves it behind.
 *   - An **unselected deletion becomes context**. It exists on both sides,
 *     because this patch is choosing not to remove it.
 *
 * So the old side keeps every context and every deletion (selected or not),
 * while the new side keeps every context, every *unselected* deletion, and
 * every selected addition.
 *
 * Returns null when the selection is empty — there is nothing to apply, and an
 * empty patch is an error rather than a no-op to `git apply`.
 */
export function buildLinePatch(
  file: PatchFile,
  hunk: PatchHunk,
  selected: ReadonlySet<number>,
): string | null {
  const body: string[] = [];
  let oldCount = 0;
  let newCount = 0;
  let anySelected = false;

  for (const line of hunk.lines) {
    const isSelected = selected.has(line.index);
    if (line.kind === 'context') {
      body.push(renderLine('context', line));
      oldCount += 1;
      newCount += 1;
      continue;
    }
    if (line.kind === 'add') {
      if (!isSelected) continue; // dropped entirely
      anySelected = true;
      body.push(renderLine('add', line));
      newCount += 1;
      continue;
    }
    // Deletion.
    if (isSelected) {
      anySelected = true;
      body.push(renderLine('del', line));
      oldCount += 1;
    } else {
      body.push(renderLine('context', line));
      oldCount += 1;
      newCount += 1;
    }
  }

  if (!anySelected) return null;

  return [
    ...file.headerLines,
    formatHunkHeader(hunk.oldStart, oldCount, hunk.newStart, newCount, hunk.heading),
    ...body,
    '',
  ].join('\n');
}

/**
 * Git omits the count when it is 1, and writes `-0,0` for an empty side. Both
 * forms are reproduced here because `git apply` is strict about the header it
 * gets back.
 */
function formatHunkHeader(
  oldStart: number,
  oldCount: number,
  newStart: number,
  newCount: number,
  heading: string,
): string {
  const old = oldCount === 1 ? `${oldStart}` : `${oldCount === 0 ? 0 : oldStart},${oldCount}`;
  const next = newCount === 1 ? `${newStart}` : `${newCount === 0 ? 0 : newStart},${newCount}`;
  return `@@ -${old} +${next} @@${heading}`;
}

/** Every line index in a hunk that the user can select (i.e. not context). */
export function selectableLineIndices(hunk: PatchHunk): number[] {
  return hunk.lines.filter((line) => line.kind !== 'context').map((line) => line.index);
}

/** +N / −M for one hunk, for the gutter summary. */
export function hunkStats(hunk: PatchHunk): { additions: number; deletions: number } {
  let additions = 0;
  let deletions = 0;
  for (const line of hunk.lines) {
    if (line.kind === 'add') additions += 1;
    else if (line.kind === 'del') deletions += 1;
  }
  return { additions, deletions };
}

/** Find the parsed file entry for a repo-relative path. */
export function findFile(files: PatchFile[], path: string): PatchFile | null {
  const wanted = path.replace(/\\/g, '/');
  return (
    files.find((f) => f.newPath === wanted) ??
    files.find((f) => f.oldPath === wanted) ??
    null
  );
}
