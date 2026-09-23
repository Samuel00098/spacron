import { describe, expect, it } from 'vitest';
import { applyTextEdit, unifiedDiff } from './edit-match';

describe('applyTextEdit', () => {
  it('replaces a unique exact match', () => {
    const result = applyTextEdit('a\nb\nc\n', 'b', 'B');
    expect(result).toEqual({ ok: true, content: 'a\nB\nc\n', matcher: 'exact', replacements: 1 });
  });

  it('refuses an ambiguous exact match unless replace_all is set', () => {
    expect(applyTextEdit('x = 1; x = 1;', 'x = 1', 'x = 2')).toMatchObject({ ok: false, reason: 'ambiguous', count: 2 });
    expect(applyTextEdit('x = 1; x = 1;', 'x = 1', 'x = 2', true)).toMatchObject({ ok: true, content: 'x = 2; x = 2;', replacements: 2 });
  });

  it('matches an LF old_string against a CRLF file and writes CRLF back', () => {
    const result = applyTextEdit('one\r\ntwo\r\nthree\r\n', 'one\ntwo', 'uno\ndos');
    expect(result).toMatchObject({ ok: true, content: 'uno\r\ndos\r\nthree\r\n', matcher: 'exact' });
  });

  it('strips read_file line-number prefixes the model copied', () => {
    const result = applyTextEdit('const a = 1;\nconst b = 2;\n', '1: const a = 1;\n2: const b = 2;', '1: const a = 10;\n2: const b = 20;');
    expect(result).toMatchObject({ ok: true, content: 'const a = 10;\nconst b = 20;\n', matcher: 'line-number-prefix' });
  });

  it('tolerates trailing whitespace drift', () => {
    const result = applyTextEdit('if (x) {   \n  go();\n}\n', 'if (x) {\n  go();\n}', 'if (y) {\n  go();\n}');
    expect(result).toMatchObject({ ok: true, content: 'if (y) {\n  go();\n}\n', matcher: 'trailing-whitespace' });
  });

  it('matches wrong indentation and re-indents the replacement to fit', () => {
    const file = 'function f() {\n    if (x) {\n        go();\n    }\n}\n';
    const result = applyTextEdit(file, 'if (x) {\n    go();\n}', 'if (x) {\n    stop();\n}');
    expect(result).toMatchObject({ ok: true, matcher: 'trimmed-lines' });
    expect(result.ok && result.content).toBe('function f() {\n    if (x) {\n        stop();\n    }\n}\n');
  });

  it('normalizes smart quotes and dashes', () => {
    const result = applyTextEdit("const s = 'it's';\n", 'const s = ‘it’s’;', "const s = 'ok';");
    expect(result).toMatchObject({ ok: true, content: "const s = 'ok';\n", matcher: 'unicode-normalized' });
  });

  it('anchors a block on its first and last lines when the middle drifted', () => {
    const file = 'start();\nconst total = items.reduce((a, b) => a + b, 0);\nfinish();\n';
    const result = applyTextEdit(file, 'start();\nconst total = items.reduce((a, b) => a + b);\nfinish();', 'start();\nfinish();');
    expect(result).toMatchObject({ ok: true, content: 'start();\nfinish();\n', matcher: 'block-anchor' });
  });

  it('refuses a fuzzy pattern that matches more than once', () => {
    const file = 'go(); \nwait();\ngo();  \n';
    expect(applyTextEdit(file, 'go();\n', 'x\n')).toMatchObject({ ok: false, reason: 'ambiguous', matcher: 'trailing-whitespace' });
    expect(applyTextEdit('a\n  b\n', 'zzz', 'c')).toMatchObject({ ok: false, reason: 'not-found' });
  });

  it('does not add a newline when a newline-terminated block ends the file', () => {
    const result = applyTextEdit('a\n  b', 'b\n', 'c\n');
    expect(result).toMatchObject({ ok: true, content: 'a\n  c' });
  });

  it('reports empty and unchanged edits', () => {
    expect(applyTextEdit('a', '', 'b')).toMatchObject({ ok: false, reason: 'empty' });
    expect(applyTextEdit('a', 'a', 'a')).toMatchObject({ ok: false, reason: 'unchanged' });
  });
});

describe('unifiedDiff', () => {
  it('shows the changed lines with context', () => {
    const diff = unifiedDiff('src/a.ts', 'one\ntwo\nthree\nfour\n', 'one\ntwo\nTHREE\nfour\n');
    expect(diff).toBe(['--- a/src/a.ts', '+++ b/src/a.ts', '@@ -1,5 +1,5 @@', ' one', ' two', '-three', '+THREE', ' four', ' '].join('\n'));
  });

  it('caps long diffs', () => {
    const before = Array.from({ length: 200 }, (_, i) => `line ${i}`).join('\n');
    const diff = unifiedDiff('big.txt', before, '', 20);
    expect(diff.split('\n')).toHaveLength(21);
    expect(diff).toMatch(/more diff lines\)$/);
  });
});
