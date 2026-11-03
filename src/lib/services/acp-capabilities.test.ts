import { describe, expect, it } from 'vitest';
import { getAcpCapabilities, getAcpProviderAdapter, isAcpChatCommand, isNativeAcpCommand } from './acp-capabilities';

describe('ACP capabilities', () => {
  it('recognizes native ACP executables', () => {
    expect(isNativeAcpCommand('/usr/local/bin/claude-agent-acp')).toBe(true);
    expect(getAcpCapabilities('copilot.cmd').nativeProtocol).toBe(true);
    expect(getAcpCapabilities('copilot.cmd').supportsSessionLoad).toBe(false);
    expect(isNativeAcpCommand('npx -y @example/my-acp-agent')).toBe(true);
    expect(isNativeAcpCommand('my-agent --acp')).toBe(false);
    expect(isNativeAcpCommand('npx -y @example/my-agent')).toBe(false);
  });

  it('keeps unknown ACP commands on prompt fallback', () => {
    const capabilities = getAcpCapabilities('my-custom-agent');
    expect(capabilities.sessionHandoff).toBe('prompt-fallback');
    expect(capabilities.supportsSessionLoad).toBe(false);
    expect(capabilities.reason).toContain('native ACP protocol');
  });

  it('routes registry-installed ACP agents to the native transport', () => {
    // Nothing in this command says "acp": the registry entry is the evidence.
    expect(isAcpChatCommand('uvx notes-agent')).toBe(false);
    expect(isAcpChatCommand('uvx notes-agent', ['uvx notes-agent'])).toBe(true);
    expect(isAcpChatCommand('uvx notes-agent', ['UVX NOTES-AGENT'])).toBe(true);
    expect(isAcpChatCommand('uvx notes-agent', ['uvx other-agent'])).toBe(false);
    expect(isAcpChatCommand(undefined, ['uvx notes-agent'])).toBe(false);
  });

  it('uses verified adapter metadata for ACP launch forms', () => {
    expect(getAcpProviderAdapter('claude-agent-acp')?.id).toBe('claude-acp');
    expect(getAcpProviderAdapter('npx -y @example/my-acp-agent')?.id).toBe('@example/my-acp-agent');
    expect(getAcpProviderAdapter('npx -y @example/ordinary-agent')).toBeNull();
    expect(getAcpCapabilities('claude-agent-acp').adapterId).toBe('claude-acp');
  });
});
