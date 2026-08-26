import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { MCP_CONFIGURABLE_EXECUTABLES, agentCanReport } from './agent-capabilities';

describe('agentCanReport', () => {
  it('resolves the executable out of a launch command', () => {
    expect(agentCanReport('codex')).toBe(true);
    expect(agentCanReport('npx opencode')).toBe(true);
    expect(agentCanReport('/usr/local/bin/claude --resume')).toBe(true);
    expect(agentCanReport('claude.cmd')).toBe(true);
  });

  it('is false for the CLIs that launch with no Spacron tools', () => {
    // These are briefed to call `report_status` but no MCP config is ever
    // written for them, so the tool does not exist in their session.
    for (const cli of ['aider', 'goose', 'qwen', 'grok', 'cline', 'amp']) {
      expect(agentCanReport(cli)).toBe(false);
    }
    expect(agentCanReport('')).toBe(false);
    expect(agentCanReport(null)).toBe(false);
  });
});

describe('the capability list matches the config writer', () => {
  it('lists exactly the executables injectMcpConfigForAgent handles', () => {
    // Read the switch rather than trusting a copy: a CLI added there and not
    // here would be told to report and then silenced for not reporting, which
    // is the exact bug this pair of lists exists to prevent.
    const src = readFileSync('src/lib/stores/mcpBridge.ts', 'utf8');
    const body = src.split('switch (agentExecutable(preset))')[1].split('\n  }')[0];
    const cases = new Set([...body.matchAll(/case '([a-z0-9-]+)'/g)].map((m) => m[1]));
    // Claude takes the `--mcp-config` route instead of a switch case.
    cases.add('claude');
    expect([...cases].sort()).toEqual([...MCP_CONFIGURABLE_EXECUTABLES].sort());
  });
});
