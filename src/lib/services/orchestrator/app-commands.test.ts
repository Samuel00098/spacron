import { describe, expect, it } from 'vitest';
import { findAppCommand, formatAppCommandList, isRiskyAppCommand, listAppCommands, type AppCommand } from './app-commands';
import { approvalRuleKey, describeRule } from './command-policy';

const noop = () => {};
const COMMANDS: AppCommand[] = [
  { id: 'view.terminal', name: 'Go to Terminal', category: 'View', action: noop },
  { id: 'terminal.new', name: 'New Terminal', category: 'Terminal', action: noop },
  { id: 'layout.fleet', name: 'Tile all agents', category: 'Layout', action: noop },
  { id: 'preview.stop', name: 'Stop Dev Proxy Server', category: 'Preview', action: noop },
  { id: 'settings.general', name: 'Settings: General', category: 'Settings', action: noop },
];

describe('app commands', () => {
  it('finds commands by every word of the query', () => {
    expect(listAppCommands(COMMANDS, 'terminal').map((c) => c.id)).toEqual(['view.terminal', 'terminal.new']);
    expect(listAppCommands(COMMANDS, 'new terminal').map((c) => c.id)).toEqual(['terminal.new']);
    expect(listAppCommands(COMMANDS, '')).toHaveLength(COMMANDS.length);
  });

  it('resolves an id first, then an exact name, and never guesses', () => {
    expect(findAppCommand(COMMANDS, 'layout.fleet')?.name).toBe('Tile all agents');
    expect(findAppCommand(COMMANDS, 'go to terminal')?.id).toBe('view.terminal');
    expect(findAppCommand(COMMANDS, 'terminal')).toBeNull();
  });

  it('marks commands that stop, delete, reset or close things as risky', () => {
    expect(isRiskyAppCommand({ id: 'preview.stop', name: 'Stop Dev Proxy Server' })).toBe(true);
    expect(isRiskyAppCommand({ id: 'settings.factory_reset', name: 'Factory reset' })).toBe(true);
    expect(isRiskyAppCommand({ id: 'terminal.close_all', name: 'Close all terminals' })).toBe(true);
    expect(isRiskyAppCommand({ id: 'view.terminal', name: 'Go to Terminal' })).toBe(false);
    expect(formatAppCommandList(listAppCommands(COMMANDS, 'stop'), 'stop')).toContain('asks the user first');
  });

  it('caps a long listing and says how many were left out', () => {
    const many = Array.from({ length: 55 }, (_, i) => ({ id: `tools.x.${i}`, name: `Tool ${i}`, category: 'Utilities', action: noop }));
    const text = formatAppCommandList(listAppCommands(many, 'tool'), 'tool');
    expect(text).toContain('40 app command(s)');
    expect(text).toContain('15 more');
  });

  it('allows one risky command per rule, not all of them', () => {
    expect(approvalRuleKey('run_app_command', 'preview.stop')).not.toBe(approvalRuleKey('run_app_command', 'terminal.close_all'));
    expect(describeRule('run_app_command', 'preview.stop')).toBe('the `preview.stop` app command');
  });
});
