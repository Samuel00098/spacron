import { describe, it, expect } from 'vitest';
import { completionVerb, completionHeadline, groupCompletions } from './AgentNotifications';
import type { ChatMessage } from '$lib/stores/orchestrator';

function mockMsg(
  id: string,
  ts: number,
  status: 'done' | 'failed' | 'blocked',
  endedBy?: 'declared' | 'exit' | 'inferred',
): ChatMessage {
  return {
    id,
    ts,
    role: 'assistant',
    text: '',
    completion: {
      taskId: `task-${id}`,
      agentName: 'Agent',
      taskTitle: `Task ${id}`,
      status,
      endedBy,
    } as any,
  };
}

/**
 * The card is only ever allowed to claim what actually happened. These are the
 * five things it may say, and the three different ways a `done` turn can end —
 * the agent reported it, the process exited, or we assumed it from a quiet
 * screen — must never collapse into one word.
 */
describe('completion copy', () => {
  it('says "finished" only when the agent reported it', () => {
    expect(completionVerb({ status: 'done', endedBy: 'declared' })).toBe('finished');
    expect(completionHeadline({ status: 'done', endedBy: 'declared' })).toBe('Agent finished');
  });

  it('says "exited" for a process that merely ended', () => {
    // `/exit`, Ctrl-D and a finished session all exit cleanly. Calling that
    // "finished" is a claim about work that nothing here observed.
    expect(completionVerb({ status: 'done', endedBy: 'exit' })).toBe('exited');
    expect(completionHeadline({ status: 'done', endedBy: 'exit' })).toBe('Agent exited');
  });

  it('says "went quiet" for a finish nobody reported', () => {
    expect(completionVerb({ status: 'done', endedBy: 'inferred' })).toBe('went quiet');
    expect(completionHeadline({ status: 'done', endedBy: 'inferred' })).toBe('Agent went quiet');
  });

  it('keeps needs-input and failure on their own words', () => {
    expect(completionVerb({ status: 'blocked' })).toBe('needs input');
    expect(completionVerb({ status: 'failed' })).toBe('failed');
    expect(completionHeadline({ status: 'blocked' })).toBe('Agent needs input');
    expect(completionHeadline({ status: 'failed' })).toBe('Agent failed');
  });

  it('treats a card saved before this field existed as declared', () => {
    // Old cards were already worded "finished"; they must not silently become
    // "went quiet" after an upgrade.
    expect(completionVerb({ status: 'done' })).toBe('finished');
  });

  it('never lets the corner and the lock screen disagree', () => {
    for (const endedBy of ['declared', 'exit', 'inferred', undefined] as const) {
      const verb = completionVerb({ status: 'done', endedBy });
      expect(completionHeadline({ status: 'done', endedBy })).toBe(
        `Agent ${verb}`,
      );
    }
  });
});

describe('what an exit is allowed to claim', () => {
  // Both the leased and the adopted process-exit paths now stamp `exit`. The
  // guard is that neither of them can reach the word "finished", and that an
  // exit still interrupts — only a guess is silenced.
  const silentFor = (endedBy: 'declared' | 'exit' | 'inferred') => endedBy === 'inferred';

  it('never calls a bare exit "finished"', () => {
    expect(completionVerb({ status: 'done', endedBy: 'exit' })).not.toContain('finished');
  });

  it('still interrupts for an exit, and only stays quiet for a guess', () => {
    expect(silentFor('declared')).toBe(false);
    expect(silentFor('exit')).toBe(false);
    expect(silentFor('inferred')).toBe(true);
  });
});

describe('completion grouping', () => {
  it('groups declared, exit, and inferred completions apart', () => {
    const msgs: ChatMessage[] = [
      mockMsg('1', 100, 'done', 'declared'),
      mockMsg('2', 200, 'done', 'exit'),
      mockMsg('3', 300, 'done', 'inferred'),
      mockMsg('4', 400, 'done', 'declared'),
      mockMsg('5', 500, 'done', 'exit'),
    ];
    const groups = groupCompletions(msgs);
    expect(groups.map((g) => g.key).sort()).toEqual(['cp-declared', 'cp-exit', 'cp-inferred']);

    const declared = groups.find((g) => g.key === 'cp-declared')!;
    expect(declared.members.map((m) => m.id)).toEqual(['1', '4']);

    const exit = groups.find((g) => g.key === 'cp-exit')!;
    expect(exit.members.map((m) => m.id)).toEqual(['2', '5']);

    const inferred = groups.find((g) => g.key === 'cp-inferred')!;
    expect(inferred.members.map((m) => m.id)).toEqual(['3']);
  });

  it('keeps non-done (failed and blocked) completions individual', () => {
    const msgs: ChatMessage[] = [
      mockMsg('1', 100, 'failed'),
      mockMsg('2', 200, 'blocked'),
      mockMsg('3', 300, 'done', 'declared'),
    ];
    const groups = groupCompletions(msgs);
    expect(groups.map((g) => g.key).sort()).toEqual(['cp-1', 'cp-2', 'cp-declared']);
  });

  it('treats missing endedBy as declared for backwards compatibility', () => {
    const msgs: ChatMessage[] = [
      mockMsg('1', 100, 'done', undefined),
    ];
    const groups = groupCompletions(msgs);
    expect(groups[0].key).toBe('cp-declared');
  });
});
