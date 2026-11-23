import { describe, expect, it } from 'vitest';
import { isStaleChat, retentionCutoff } from './chat-retention';

describe('chat retention', () => {
  const now = Date.parse('2026-11-23T12:00:00Z');
  it('never expires anything when set to never', () => {
    expect(retentionCutoff(0, now)).toBeNull();
  });
  it('expires a chat only after its last activity is older than the period', () => {
    const cutoff = retentionCutoff(30, now)!;
    expect(isStaleChat(now - 31 * 86_400_000, cutoff)).toBe(true);
    expect(isStaleChat(now - 29 * 86_400_000, cutoff)).toBe(false);
  });
  it('keeps chats with no usable timestamp', () => {
    const cutoff = retentionCutoff(30, now)!;
    expect(isStaleChat(0, cutoff)).toBe(false);
    expect(isStaleChat(Number.NaN, cutoff)).toBe(false);
  });
});
