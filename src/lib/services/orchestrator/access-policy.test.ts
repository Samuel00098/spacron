import { describe, expect, it } from 'vitest';
import { CHAT_ACCESS_TIERS, accessTier, tierNeedsApproval } from './access-policy';

describe('chat access tiers', () => {
  it('treats an unset or inherited mode as supervised', () => {
    expect(accessTier(undefined)).toBe('supervised');
    expect(accessTier(null)).toBe('supervised');
    expect(accessTier('inherit')).toBe('supervised');
    expect(accessTier('nonsense' as never)).toBe('supervised');
    expect(CHAT_ACCESS_TIERS).toEqual(['supervised', 'auto-edits', 'auto', 'full-access']);
  });

  it('keeps every real tier as chosen', () => {
    for (const tier of CHAT_ACCESS_TIERS) expect(accessTier(tier)).toBe(tier);
  });

  it('asks before everything when supervised', () => {
    expect(tierNeedsApproval('supervised', 'read_file')).toBe(true);
    expect(tierNeedsApproval('supervised', 'write_file')).toBe(true);
    expect(tierNeedsApproval('supervised', 'run_command')).toBe(true);
  });

  it('lets edits through but still asks for commands when auto-accepting edits', () => {
    expect(tierNeedsApproval('auto-edits', 'write_file')).toBe(false);
    expect(tierNeedsApproval('auto-edits', 'edit_file')).toBe(false);
    expect(tierNeedsApproval('auto-edits', 'run_command')).toBe(true);
    expect(tierNeedsApproval('auto-edits', 'mcp_call_tool')).toBe(true);
  });

  it('never asks for auto or full access', () => {
    for (const tier of ['auto', 'full-access'] as const) {
      expect(tierNeedsApproval(tier, 'run_command')).toBe(false);
      expect(tierNeedsApproval(tier, 'write_file')).toBe(false);
    }
  });
});
