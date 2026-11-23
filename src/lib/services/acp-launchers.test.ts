import { describe, expect, it } from 'vitest';
import { ANTIGRAVITY_ACP_SERVER, acpLauncherNote, builtinAcpLauncher, isAntigravityAcpCommand, resolveAcpLaunchCommand } from './acp-launchers';

describe('ACP launch entry points', () => {
  it('recognizes managed Antigravity binaries and the CLI ACP command', () => {
    expect(isAntigravityAcpCommand('"C:/Program Files/agy_acp_server.exe"')).toBe(true);
    expect(isAntigravityAcpCommand('./agy_acp_server.par')).toBe(true);
    expect(isAntigravityAcpCommand('agy acp')).toBe(true);
    expect(isAntigravityAcpCommand('cursor-agent acp')).toBe(false);
  });
  it('resolves the vendor ACP entry point for each chat preset', () => {
    expect(resolveAcpLaunchCommand('claude')).toBe('npx -y @agentclientprotocol/claude-agent-acp');
    expect(resolveAcpLaunchCommand('codex')).toBe('npx -y @agentclientprotocol/codex-acp');
    expect(resolveAcpLaunchCommand('cursor-agent')).toBe('cursor-agent acp');
    expect(resolveAcpLaunchCommand('opencode')).toBe('opencode acp');
    expect(resolveAcpLaunchCommand('grok')).toBe('grok agent stdio');
  });

  it('matches on the executable, not on arguments or a path', () => {
    expect(builtinAcpLauncher('/usr/local/bin/codex --profile work')?.command).toContain('codex-acp');
    expect(builtinAcpLauncher('C:\\tools\\claude.cmd')?.command).toContain('claude-agent-acp');
  });

  it('leaves commands it has no verified entry point for alone', () => {
    // Google ships ACP as an extension server binary, not an `agy` subcommand.
    expect(resolveAcpLaunchCommand('agy')).toBeNull();
    expect(ANTIGRAVITY_ACP_SERVER).toBe('agy_acp_server');
    expect(acpLauncherNote('agy')).toContain('agy_acp_server');
    expect(resolveAcpLaunchCommand('my-terminal-agent')).toBeNull();
    expect(resolveAcpLaunchCommand('')).toBeNull();
  });

  it('uses a declared ACP command exactly as written', () => {
    expect(resolveAcpLaunchCommand('uvx notes-agent', true)).toBe('uvx notes-agent');
    // Declaring a preset ACP wins over its built-in launcher: the user pointed
    // at a specific entry point on purpose.
    expect(resolveAcpLaunchCommand('claude', true)).toBe('claude');
  });
});
