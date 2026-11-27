import { describe, expect, it } from 'vitest';
import { cmdQuote, windowsShimCommandLine } from '$lib/services/acp-transport';
import { chatItemsForClaude, claudeArgs, modelFrom } from './claude-session';
import { advertisedModes, approvalOptions, autoApproves, permissionModeFor, permissionOutcome } from './acp-session';
import { piModelsFrom, piProvider } from './pi-session';

describe('agent launch lines', () => {
  it('routes a bare command through cmd.exe with quoted arguments', () => {
    expect(windowsShimCommandLine('cursor-agent', ['--disable-auto-update', 'acp'])).toBe('/d /s /c cursor-agent --disable-auto-update acp');
    expect(cmdQuote('C:\\Users\\SMIDS MAN\\repo')).toBe('"C:\\Users\\SMIDS MAN\\repo"');
    expect(cmdQuote('say "hi"')).toBe('"say ""hi"""');
  });

  it('starts Claude with host permission prompts, valid effort only, and resume', () => {
    const args = claudeArgs({ effort: 'high', resumeId: 'abc', access: 'auto' });
    expect(args).toEqual(expect.arrayContaining(['--permission-prompt-tool', 'stdio', '--permission-mode', 'acceptEdits', '--effort', 'high', '--resume', 'abc']));
    expect(claudeArgs({ resumeId: 'abc', forkSession: true })).toEqual(expect.arrayContaining(['--resume', 'abc', '--fork-session']));
    expect(claudeArgs({ forkSession: true })).not.toContain('--fork-session');
    expect(claudeArgs({ effort: 'ultra' })).not.toContain('--effort');
    expect(claudeArgs({})).not.toContain('--permission-mode');
    expect(claudeArgs({ access: 'full-access' })).toEqual(expect.arrayContaining(['--permission-mode', 'bypassPermissions', '--allow-dangerously-skip-permissions']));
  });
});

describe('Claude stream-json mapping', () => {
  it('reads the initialize model catalog shape Claude Code 2.1 returns', () => {
    expect(modelFrom({ value: 'default', displayName: 'Default (recommended)', description: 'Opus', supportsEffort: true, supportedEffortLevels: ['low', 'high'] }))
      .toEqual({ id: 'default', label: 'Default (recommended)', description: 'Opus', efforts: ['low', 'high'], defaultEffort: null, isDefault: true, supportsFast: false });
    expect(modelFrom({ value: 'haiku', supportsEffort: false, supportedEffortLevels: ['low'] })?.efforts).toEqual([]);
  });

  it('keeps text, thinking and tool calls from one assistant frame', () => {
    const items = chatItemsForClaude({
      type: 'assistant',
      uuid: 'u1',
      message: { content: [
        { type: 'thinking', thinking: 'plan' },
        { type: 'text', text: 'Running it' },
        { type: 'tool_use', id: 'toolu_1', name: 'Bash', input: { command: 'ls' } },
      ] },
    });
    expect(items.map((i) => [i.id, i.kind, i.text])).toEqual([
      ['u1-0', 'reasoning', 'plan'],
      ['u1-1', 'assistant', 'Running it'],
      ['toolu_1', 'tool', 'ls'],
    ]);
  });

  it('maps tool results onto their call and failed results to a notice', () => {
    const [result] = chatItemsForClaude({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'toolu_1', content: 'a.txt', is_error: false }] } });
    expect(result).toMatchObject({ id: 'toolu_1', kind: 'tool', toolOutput: 'a.txt', toolStatus: 'done' });
    expect(chatItemsForClaude({ type: 'user', message: { content: 'plain echo' } })).toEqual([]);
    expect(chatItemsForClaude({ type: 'result', subtype: 'success', is_error: false, result: 'pong' })).toEqual([]);
    expect(chatItemsForClaude({ type: 'result', subtype: 'error_during_execution', is_error: true, uuid: 'r', result: '' })[0]).toMatchObject({ kind: 'notice' });
  });
});

describe('ACP permission answers', () => {
  const options = [
    { optionId: 'proceed_always', kind: 'allow_always', name: 'Always' },
    { optionId: 'proceed_once', kind: 'allow_once', name: 'Once' },
    { optionId: 'cancel', kind: 'reject_once', name: 'No' },
  ];
  it('answers with the option ids the agent offered', () => {
    expect(permissionOutcome(options, 'accept')).toEqual({ outcome: { outcome: 'selected', optionId: 'proceed_once' } });
    expect(permissionOutcome(options, 'acceptForSession')).toEqual({ outcome: { outcome: 'selected', optionId: 'proceed_always' } });
    expect(permissionOutcome(options, 'decline')).toEqual({ outcome: { outcome: 'selected', optionId: 'cancel' } });
    expect(permissionOutcome([], 'decline')).toEqual({ outcome: { outcome: 'cancelled' } });
  });

  it("offers the agent's own answers as a numbered card", () => {
    expect(approvalOptions(options)).toEqual([
      { id: 'proceed_always', label: 'Always', kind: 'allow_always' },
      { id: 'proceed_once', label: 'Once', kind: 'allow_once' },
      { id: 'cancel', label: 'No', kind: 'reject_once' },
    ]);
    expect(permissionOutcome(options, 'accept', 'proceed_always')).toEqual({ outcome: { outcome: 'selected', optionId: 'proceed_always' } });
    // An id the agent never offered falls back to the kind-based answer.
    expect(permissionOutcome(options, 'decline', 'nonsense')).toEqual({ outcome: { outcome: 'selected', optionId: 'cancel' } });
  });
});

describe('ACP access modes (as each agent advertised them, 2026-11-20)', () => {
  it('reads modes from availableModes or a mode config select', () => {
    expect(advertisedModes({ modes: { availableModes: [{ id: 'agent' }, { id: 'plan' }, { id: 'ask' }] } })).toEqual(['agent', 'plan', 'ask']);
    expect(advertisedModes({ configOptions: [{ configId: 'mode', options: [{ value: 'build' }, { value: 'plan' }] }] })).toEqual(['build', 'plan']);
    expect(advertisedModes({})).toEqual([]);
  });

  it('sends a mode only to agents that have a permission mode', () => {
    expect(permissionModeFor(['default', 'accept-edits', 'auto', 'plan'], 'full-access')).toBe('auto');
    expect(permissionModeFor(['default', 'accept-edits', 'auto', 'plan'], 'auto')).toBe('accept-edits');
    expect(permissionModeFor(['build', 'plan'], 'full-access')).toBeNull(); // OpenCode
    expect(permissionModeFor(['agent', 'plan', 'ask'], 'full-access')).toBeNull(); // Cursor
    expect(permissionModeFor([], 'full-access')).toBeNull(); // Grok
    expect(permissionModeFor(['agent', 'plan', 'ask'], 'ask')).toBeNull(); // Cursor's `ask` is Q&A, not approvals
    expect(permissionModeFor(['default', 'accept-edits', 'auto', 'plan'], 'ask')).toBe('default');
    expect(permissionModeFor(['default', 'accept-edits', 'auto', 'plan'], 'auto', 'antigravity')).toBe('auto');
    expect(permissionModeFor(['default', 'accept-edits'], 'auto', 'antigravity')).toBe('default');
    expect(permissionModeFor(['default', 'auto'], 'full-access', 'antigravity')).toBe('default');
  });

  it('answers permission requests itself under Full access and, for file work, under Auto', () => {
    expect(autoApproves('full-access', 'execute')).toBe(true);
    expect(autoApproves('auto', 'edit')).toBe(true);
    expect(autoApproves('auto', 'execute')).toBe(false);
    expect(autoApproves('ask', 'read')).toBe(false);
    expect(autoApproves('ask', 'read', true)).toBe(true);
    expect(autoApproves('ask', 'execute', true)).toBe(false);
  });
});

describe('Pi model catalog', () => {
  it('keeps equal model ids from different providers apart', () => {
    const models = piModelsFrom([
      { id: 'gpt-x', name: 'GPT X', provider: 'openrouter' },
      { id: 'gpt-x', name: 'GPT X', provider: 'github-copilot' },
    ]);
    expect(models.map((m) => m.id)).toEqual(['openrouter/gpt-x', 'github-copilot/gpt-x']);
    expect(models[0].label).toBe('GPT X · openrouter');
  });

  it('provides approval answer handler', async () => {
    await piProvider.answerApproval(999, 'req-1', 'accept');
    expect(piProvider.get(999)).toBeNull();
  });
});
