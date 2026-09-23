import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { MCP_CONFIGURABLE_EXECUTABLES, agentCanReport, turnEndIsSilent } from './agent-capabilities';

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

describe('what a turn end is allowed to interrupt', () => {
  // `aider` has no reporting channel; `codex` does. The distinction must matter
  // for a guessed PAUSE and be irrelevant for a guessed FINISH.
  const mute = 'aider';
  const talker = 'codex';

  it('never floats a finish nobody declared, whatever the agent could do', () => {
    // The regression this pins: an agent with no channel used to get a corner
    // card and an OS notification reading "Agent went quiet" on every idle
    // spell, which is indistinguishable from a long compile.
    for (const preset of [mute, talker, null]) {
      expect(
        turnEndIsSilent({ status: 'done', endedBy: 'inferred' }, { preset }),
        `${preset ?? 'unknown'} must not interrupt with a guessed finish`,
      ).toBe(true);
    }
  });

  it('always speaks up for a finish the agent declared', () => {
    expect(turnEndIsSilent({ status: 'done', endedBy: 'declared' }, { preset: mute })).toBe(false);
    expect(turnEndIsSilent({ status: 'done', endedBy: 'exit' }, { preset: talker })).toBe(false);
  });

  it('always speaks up for a failure, however it was learned', () => {
    // A non-zero exit is an observed fact, not a guess about one.
    expect(turnEndIsSilent({ status: 'failed', endedBy: 'inferred' }, { preset: talker })).toBe(false);
    expect(turnEndIsSilent({ status: 'failed', endedBy: 'declared' }, { preset: mute })).toBe(false);
  });

  it('keeps the agentCanReport gate for a guessed pause only', () => {
    // A missed "needs input" strands the user waiting on an agent that is
    // waiting on them, so a guess still speaks up — unless the agent could have
    // said so and didn't, which is itself evidence it is not blocked.
    expect(turnEndIsSilent({ status: 'blocked', endedBy: 'inferred' }, { preset: mute })).toBe(false);
    expect(turnEndIsSilent({ status: 'blocked', endedBy: 'inferred' }, { preset: talker })).toBe(true);
    // A question the agent actually asked is never swallowed.
    expect(turnEndIsSilent({ status: 'blocked', endedBy: 'declared' }, { preset: talker })).toBe(false);
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
