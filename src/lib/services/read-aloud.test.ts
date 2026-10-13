import { describe, expect, it } from 'vitest';
import { speakableText, speechChunks } from './read-aloud';

describe('read aloud', () => {
  it('reads Markdown as prose: code is announced, icons dropped, list items pause', () => {
    const text = speakableText('## Plan\n\n- Read the file\n- Fix it 🟢\n\n```ts\nconst a = 1;\n```\n\nSee [the docs](https://x.dev).');
    expect(text).toBe('Plan. Read the file. Fix it. (code sample) See the docs.');
  });

  it('packs sentences into short pieces and splits a run-on sentence', () => {
    const chunks = speechChunks('One. Two. Three.', 10);
    expect(chunks).toEqual(['One. Two.', 'Three.']);
    const long = speechChunks(`${'word '.repeat(80).trim()}.`, 60);
    expect(long.every((chunk) => chunk.length <= 60)).toBe(true);
    expect(long.join(' ')).toBe(`${'word '.repeat(80).trim()}.`);
  });
});
