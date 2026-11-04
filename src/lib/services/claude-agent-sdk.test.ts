import { describe, it, expect } from 'vitest';
import { claudePermissionModeForAccess, parseClaudeJsonLine } from './claude-agent-sdk';

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