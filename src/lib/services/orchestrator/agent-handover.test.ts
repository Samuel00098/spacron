import { describe, it, expect } from 'vitest';
import {
  buildHandoverBrief,
  buildWrapUpRequest,
  describeHandoverReason,
  describeMigrationChain,
} from './agent-handover';
import type { TaskMigration } from './task-lifecycle';
import type { WorktreeDelta } from './worktree-manager';

function delta(over: Partial<WorktreeDelta> = {}): WorktreeDelta {
  return {
    head: 'abc123',
    dirtyFiles: 0,
    committedFiles: 4,
    upToDate: false,
    pendingFiles: 4,
    firstFile: 'src/db/schema.ts',
    firstSubject: 'add users table',
    ...over,
  };
}

function migration(over: Partial<TaskMigration> = {}): TaskMigration {
  return {
    at: 0,
    fromPreset: 'claude',
    fromAccountId: 'work',
    fromAccountLabel: 'work@example.com',
    fromHeadroomPercent: 3,
    fromResetAtMs: null,
    toPreset: 'codex',
    toAccountId: null,
    toAccountLabel: null,
    toHeadroomPercent: 71,
    filesChanged: 4,
    stoppedBy: 'wrap-up',
    reason: 'Claude Code dropped to 3% usage left.',
    ...over,
  };
}

const task = {
  goal: 'Add a users table and the two mutations that write to it',
  title: 'Add a users table',
  transcript: null,
  worktree: null,
};

describe('the handover brief', () => {
  it('describes the branch from git rather than from the agent', () => {
    const brief = buildHandoverBrief({
      task,
      fromLabel: 'Claude Code',
      toLabel: 'Codex CLI',
      delta: delta(),
      reason: 'Claude Code dropped to 3% usage left.',
    });
    expect(brief).toContain('4 files changed in commits on this branch');
    expect(brief).toContain('src/db/schema.ts');
    expect(brief).toContain(task.goal);
  });

  it('tells the successor to trust the diff over the dead agent’s last words', () => {
    // A dying agent's last paragraph is frequently a plan it never carried out.
    // Presenting that as "what is done" is how a successor marks a feature
    // complete that was never built.
    const brief = buildHandoverBrief({
      task: { ...task, transcript: 'Next I will wire up the handlers and add tests.' },
      fromLabel: 'Claude Code',
      toLabel: 'Codex CLI',
      delta: delta(),
      reason: 'ran out',
    });
    expect(brief).toContain('Next I will wire up the handlers');
    expect(brief).toContain('Treat that as a claim, not as a record');
    expect(brief).toContain('the diff is right');
  });

  it('says plainly when nothing landed, rather than implying work exists', () => {
    const brief = buildHandoverBrief({
      task,
      fromLabel: 'Claude Code',
      toLabel: 'Codex CLI',
      delta: delta({ committedFiles: 0, dirtyFiles: 0, pendingFiles: 0, firstFile: null }),
      reason: 'ran out',
    });
    expect(brief).toContain('starting this from the beginning');
  });

  it('admits an unreadable branch instead of describing one it could not see', () => {
    const brief = buildHandoverBrief({
      task,
      fromLabel: 'Claude Code',
      toLabel: 'Codex CLI',
      delta: null,
      reason: 'ran out',
    });
    expect(brief).toContain('could not read the branch state');
  });

  it('carries the whole chain so a third agent sees more than the last link', () => {
    const brief = buildHandoverBrief({
      task,
      fromLabel: 'Codex CLI',
      toLabel: 'Gemini CLI',
      delta: delta(),
      reason: 'ran out',
      history: [migration()],
    });
    expect(brief).toContain('already been handed over once');
    expect(brief).toContain('claude (work@example.com) → codex');
  });

  it('tells the successor not to discard what is already on the branch', () => {
    const brief = buildHandoverBrief({ task, fromLabel: 'A', toLabel: 'B', delta: delta(), reason: 'x' });
    expect(brief).toContain('Do not reset, rebase, or discard');
  });
});

describe('the wrap-up request', () => {
  it('asks for a commit and explicitly forbids finishing the feature', () => {
    // The difference between a handover and a crash is that the outgoing agent
    // lands what it has. Asking it to *finish* would spend the headroom the
    // wrap-up exists to preserve.
    const ask = buildWrapUpRequest(3);
    expect(ask).toContain('3% of its usage limit left');
    expect(ask).toContain('Commit everything on this branch');
    expect(ask).toContain('Do not try to finish the feature.');
  });

  it('does not invent a number it was not given', () => {
    expect(buildWrapUpRequest(null)).toContain('almost none');
  });
});

describe('describeHandoverReason', () => {
  const now = Date.UTC(2026, 8, 20, 12, 0, 0);

  it('names the reset time when the meter gave one', () => {
    expect(describeHandoverReason('Claude Code', 3, now + 4 * 3600 * 1000, now)).toBe(
      'Claude Code dropped to 3% usage left, with 4h to reset.'
    );
  });

  it('stays honest when there is no reset instant', () => {
    expect(describeHandoverReason('Claude Code', 3, null, now)).toBe('Claude Code dropped to 3% usage left.');
  });
});

describe('the migration chain on a completion card', () => {
  it('describes each hop by what was observed, never by what an agent finished', () => {
    // `endedBy` lets only a *declared* end use the word "finished", and the
    // chain has to keep that per hop: an earlier agent's contribution is
    // recorded as headroom and files, not as a completion claim.
    const told = describeMigrationChain([migration()]);
    expect(told).toContain('dropped to 3%');
    expect(told).toContain('leaving 4 changed files on the branch');
    expect(told).toContain('picked the work up on the same branch');
    expect(told).not.toMatch(/\bfinished\b/i);
    expect(told).not.toMatch(/\bcompleted\b/i);
  });

  it('distinguishes an agent that stopped when asked from one that was interrupted', () => {
    expect(describeMigrationChain([migration({ stoppedBy: 'wrap-up' })])).toContain('wrapped up and committed first');
    expect(describeMigrationChain([migration({ stoppedBy: 'interrupt' })])).toContain('did not stop when asked');
    // A pre-emptive swap interrupted nothing, so it claims nothing either way.
    const preEmptive = describeMigrationChain([migration({ stoppedBy: 'pre-emptive' })]);
    expect(preEmptive).not.toContain('wrapped up');
    expect(preEmptive).not.toContain('interrupted');
  });

  it('says nothing at all for work that never moved', () => {
    // Which is the overwhelming majority of turns, and they must not grow a
    // "handed over" line saying nothing happened.
    expect(describeMigrationChain([])).toBeNull();
  });

  it('shows every hop, not only the last', () => {
    const told = describeMigrationChain([
      migration(),
      migration({ fromPreset: 'codex', fromAccountId: null, fromAccountLabel: null, toPreset: 'gemini' }),
    ]);
    expect(told).toContain('claude (work@example.com)');
    expect(told).toContain('codex');
    expect(told).toContain('gemini');
  });
});
