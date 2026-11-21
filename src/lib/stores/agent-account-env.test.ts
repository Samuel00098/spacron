import { beforeEach, describe, expect, it, vi } from 'vitest';
vi.mock('$lib/utils/tauri', () => ({ isTauriRuntime: () => true }));
vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn() }));
import { invoke } from '@tauri-apps/api/core';
import { accountEnvFor } from './agentAccounts';

describe('explicit session account routing', () => {
  beforeEach(() => { vi.mocked(invoke).mockReset(); });

  it('routes the Antigravity executable to its account provider', async () => {
    vi.mocked(invoke).mockResolvedValue({ GEMINI_HOME: '/accounts/work' });
    expect(await accountEnvFor('agy', 'work')).toEqual({ GEMINI_HOME: '/accounts/work' });
    expect(invoke).toHaveBeenCalledWith('usage_account_env', { provider: 'antigravity', accountId: 'work' });
  });

  it('refuses to substitute the default account when a recorded managed account is gone', async () => {
    vi.mocked(invoke).mockResolvedValue({});
    await expect(accountEnvFor('grok', 'deleted')).rejects.toThrow('Account deleted is unavailable');
  });

  it('surfaces account lookup failures for explicit resumes while preserving ordinary launch behavior', async () => {
    vi.mocked(invoke).mockRejectedValue(new Error('offline'));
    await expect(accountEnvFor('grok', 'default')).rejects.toThrow('offline');
    await expect(accountEnvFor('grok')).resolves.toEqual({});
  });
});
