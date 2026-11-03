import { describe, expect, it } from 'vitest';
import { getAcpCapabilities, getAcpProviderAdapter, isNativeAcpCommand } from './acp-capabilities';

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

  it('uses verified adapter metadata for ACP launch forms', () => {
    expect(getAcpProviderAdapter('claude-agent-acp')?.id).toBe('claude-acp');
    expect(getAcpProviderAdapter('npx -y @example/my-acp-agent')?.id).toBe('@example/my-acp-agent');
    expect(getAcpProviderAdapter('npx -y @example/ordinary-agent')).toBeNull();
    expect(getAcpCapabilities('claude-agent-acp').adapterId).toBe('claude-acp');
  });
});
