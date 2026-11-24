import { describe, expect, it } from 'vitest';
import { replyPreview, shouldAnnounce } from './botNotify';

const run = (status: string, trigger = 'schedule') => ({ status, trigger }) as never;

describe('shouldAnnounce', () => {
  it('announces everything by default', () => {
    expect(shouldAnnounce('all', run('completed'), false)).toBe(true);
    expect(shouldAnnounce('all', run('failed'), false)).toBe(true);
    expect(shouldAnnounce('all', run('missed'), false)).toBe(true);
  });

  it('"problems" keeps only failed and missed runs', () => {
    expect(shouldAnnounce('problems', run('completed'), false)).toBe(false);
    expect(shouldAnnounce('problems', run('failed'), false)).toBe(true);
    expect(shouldAnnounce('problems', run('missed'), false)).toBe(true);
  });

  it('"off" announces nothing, not even a failure', () => {
    expect(shouldAnnounce('off', run('failed'), false)).toBe(false);
  });

  it('stays quiet about a chat reply the user is reading, but not a failure or a scheduled run', () => {
    expect(shouldAnnounce('all', run('completed', 'chat'), true)).toBe(false);
    expect(shouldAnnounce('all', run('failed', 'chat'), true)).toBe(true);
    expect(shouldAnnounce('all', run('completed', 'schedule'), true)).toBe(true);
    expect(shouldAnnounce('all', run('completed', 'chat'), false)).toBe(true);
  });
});

describe('replyPreview', () => {
  it('flattens markdown to one short line', () => {
    expect(replyPreview('## Digest\n\n- **AI** news\n```js\ncode()\n```\nDone.')).toBe('Digest - AI news Done.');
  });

  it('caps long replies with an ellipsis and tolerates nothing', () => {
    const out = replyPreview('word '.repeat(100), 40);
    expect(out.length).toBeLessThanOrEqual(40);
    expect(out.endsWith('…')).toBe(true);
    expect(replyPreview(undefined)).toBe('');
  });
});
