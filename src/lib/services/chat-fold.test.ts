import { describe, expect, it } from 'vitest';
import { foldUserText } from './chat-fold';

describe('folding long sent messages', () => {
  it('leaves a short message alone', () => {
    expect(foldUserText('hello\nworld')).toEqual({ long: false, preview: 'hello\nworld', hiddenLines: 0 });
  });

  it('folds by line count and reports what is hidden', () => {
    const text = Array.from({ length: 30 }, (_, i) => `line ${i + 1}`).join('\n');
    const folded = foldUserText(text);
    expect(folded.long).toBe(true);
    expect(folded.preview.startsWith('line 1\n')).toBe(true);
    expect(folded.preview.endsWith('…')).toBe(true);
    expect(folded.hiddenLines).toBe(20);
  });

  it('folds one very long line by characters', () => {
    const folded = foldUserText('x'.repeat(5000));
    expect(folded.long).toBe(true);
    expect(folded.preview.length).toBeLessThan(600);
    expect(folded.hiddenLines).toBe(0);
  });
});
