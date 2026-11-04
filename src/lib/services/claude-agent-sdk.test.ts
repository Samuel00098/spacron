import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  claudePermissionModeForAccess,
  parseClaudeJsonLine,
  runClaudeAgentSdkTurn,
  forkClaudeSession,
  getClaudeSessionMessages,
  getClaudeSessionInfo,
} from './claude-agent-sdk';
import { invoke } from '@tauri-apps/api/core';

vi.mock('@tauri-apps/api/core', () => ({
  invoke: vi.fn(),
}));

const mockInvoke = invoke as ReturnType<typeof vi.fn>;

describe('claudePermissionModeForAccess', () => {
  it('maps Spacron tiers to Claude permission modes', () => {
    expect(claudePermissionModeForAccess('supervised')).toBe('default');
    expect(claudePermissionModeForAccess('auto-edits')).toBe('acceptEdits');
    expect(claudePermissionModeForAccess('auto')).toBe('plan');
    expect(claudePermissionModeForAccess('full-access')).toBe('bypassPermissions');
    expect(claudePermissionModeForAccess('inherit')).toBe('default');
  });
});

describe('parseClaudeJsonLine', () => {
  it('parses a text result line', () => {
    const line = JSON.stringify({ result: { text: 'Hello world', usage: { input_tokens: 5, output_tokens: 3, cost: 0.01 } } });
    const parsed = parseClaudeJsonLine(line);
    expect(parsed?.text).toBe('Hello world');
    expect(parsed?.usage).toEqual({ input_tokens: 5, output_tokens: 3, cost: 0.01 });
  });

  it('parses a message content text line', () => {
    const line = JSON.stringify({
      message: {
        role: 'assistant',
        content: [{ type: 'text', text: 'Hi there' }],
      },
    });
    const parsed = parseClaudeJsonLine(line);
    expect(parsed?.text).toBe('Hi there');
  });

  it('parses a tool use block', () => {
    const line = JSON.stringify({
      message: {
        role: 'assistant',
        content: [{ type: 'tool_use', name: 'Write', input: { path: '/tmp/test.txt' } }],
      },
    });
    const parsed = parseClaudeJsonLine(line);
    expect(parsed?.toolName).toBe('Write');
    expect(parsed?.toolInput).toEqual({ path: '/tmp/test.txt' });
  });

  it('returns null on malformed JSON', () => {
    expect(parseClaudeJsonLine('not json')).toBeNull();
  });

  it('returns null on empty string', () => {
    expect(parseClaudeJsonLine('')).toBeNull();
  });
});

describe('runClaudeAgentSdkTurn', () => {
  const baseOpts = {
    prompt: 'Hello',
    cwd: '/tmp',
    onText: vi.fn(),
    onUsage: vi.fn(),
  };

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('captures session_id from native turn result', async () => {
    mockInvoke.mockResolvedValue({ text: 'Hello back', session_id: 'sess_123' });
    const onSessionId = vi.fn();
    const result = await runClaudeAgentSdkTurn({ ...baseOpts, onSessionId });
    expect(result.sessionId).toBe('sess_123');
    expect(result.text).toBe('Hello back');
    expect(mockInvoke).toHaveBeenCalledWith('claude_chat_complete', {
      cwd: '/tmp',
      model: null,
      system_prompt: '',
      user_text: 'Hello',
      images: [],
      effort: null,
      access_mode: null,
      session_id: null,
      fork_session: false,
    });
    expect(onSessionId).toHaveBeenCalledWith('sess_123');
    expect(baseOpts.onText).toHaveBeenCalledWith('Hello back');
  });

  it('passes resume and forkSession options when provided', async () => {
    mockInvoke.mockResolvedValue({ text: 'Hi', session_id: 'sess_fork' });
    await runClaudeAgentSdkTurn({ ...baseOpts, sessionId: 'sess_abc', forkSession: true });
    expect(mockInvoke).toHaveBeenCalledWith('claude_chat_complete', {
      cwd: '/tmp',
      model: null,
      system_prompt: '',
      user_text: 'Hello',
      images: [],
      effort: null,
      access_mode: null,
      session_id: 'sess_abc',
      fork_session: true,
    });
  });

  it('returns null sessionId when none observed', async () => {
    mockInvoke.mockResolvedValue({ text: 'Hi', session_id: null });
    const result = await runClaudeAgentSdkTurn({ ...baseOpts });
    expect(result.sessionId).toBeNull();
  });
});

describe('forkClaudeSession', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('forwards to claude_fork_session command and returns session id', async () => {
    mockInvoke.mockResolvedValue({ text: '', session_id: 'forked_1' });
    const result = await forkClaudeSession('sess_abc', { dir: '/tmp', title: 'Fork' });
    expect(result).toEqual({ sessionId: 'forked_1' });
    expect(mockInvoke).toHaveBeenCalledWith('claude_fork_session', {
      cwd: '/tmp',
      session_id: 'sess_abc',
    });
  });

  it('returns null when no session id returned', async () => {
    mockInvoke.mockResolvedValue({ text: '', session_id: null });
    const result = await forkClaudeSession('sess_abc');
    expect(result).toBeNull();
  });

  it('returns null on failure', async () => {
    mockInvoke.mockRejectedValue(new Error('boom'));
    const result = await forkClaudeSession('sess_abc');
    expect(result).toBeNull();
  });
});

describe('getClaudeSessionMessages', () => {
  it('returns empty array (no Rust-native equivalent yet)', async () => {
    const result = await getClaudeSessionMessages('sess_abc', { limit: 5 });
    expect(result).toEqual([]);
  });
});

describe('getClaudeSessionInfo', () => {
  it('returns null (no Rust-native equivalent yet)', async () => {
    const result = await getClaudeSessionInfo('sess_abc');
    expect(result).toBeNull();
  });
});
