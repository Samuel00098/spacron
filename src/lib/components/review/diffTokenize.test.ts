import { describe, expect, it } from 'vitest';
import { tokenizeDiffLine } from './diffTokenize';

const join = (tokens: { text: string }[]) => tokens.map((t) => t.text).join('');

describe('diff line tokenizer', () => {
  it('never loses a character, whatever the language (spaces and punctuation included)', () => {
    const samples: [string, string][] = [
      ['- [agent-history-persistence](agent-history-persistence.md) — spacron persists agent structure not content', 'INDEX.md'],
      ['const answer = compute(1, 2) + "x"; // done', 'a.ts'],
      ['pub fn run(&self) -> Result<(), String> { Ok(()) }', 'lib.rs'],
      ['<div class="a" data-x={y}>text</div>', 'index.html'],
      ['key: value # comment', 'config.yml'],
      ['  \t  ', 'blank.txt'],
      ['', 'empty.ts'],
    ];
    for (const [line, file] of samples) expect(join(tokenizeDiffLine(line, file))).toBe(line);
  });

  it('keeps words apart so a Markdown line can wrap', () => {
    const text = '- [a-note](a-note.md) — persists agent structure';
    const tokens = tokenizeDiffLine(text, 'INDEX.md');
    expect(tokens.some((t) => t.type === 'text' && t.text.includes(' '))).toBe(true);
    expect(join(tokens)).toContain('persists agent structure');
  });

  it('classifies the tokens it should', () => {
    const types = (line: string, file: string) => tokenizeDiffLine(line, file).filter((t) => t.type !== 'text').map((t) => `${t.type}:${t.text}`);
    expect(types('const n = foo(42) // hi', 'a.ts')).toEqual(['keyword:const', 'operator:=', 'function:foo', 'number:42', 'comment:// hi']);
    expect(types('let s: String = "x"', 'a.rs')).toEqual(['keyword:let', 'operator::', 'type:String', 'operator:=', 'string:"x"']);
    expect(types('<a href="u">', 'a.html')).toEqual(['tag:<a', 'attribute:href', 'operator:=', 'string:"u"', 'operator:>']);
  });
});
