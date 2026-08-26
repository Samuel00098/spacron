import { describe, expect, it } from 'vitest';
import { classifyTaskAfterExecution } from './review-gate';
import { createTaskRecord, transitionTask } from './task-lifecycle';

function started(goal: string) {
  return transitionTask(createTaskRecord('project-1', goal, 'claude'), 'in-progress');
}

describe('classifyTaskAfterExecution', () => {
  it('completes tasks on clean exit', () => {
    const task = started('Fix auth bug');
    const next = classifyTaskAfterExecution(task, { exitCode: 0 });
    expect(next.status).toBe('complete');
    expect(next.completedAt).toBeTypeOf('number');
  });

  it('marks blocked when human input is required', () => {
    const task = started('Fix auth bug');
    const next = classifyTaskAfterExecution(task, { exitCode: 0, needsHumanInput: true, note: 'Need API key' });
    expect(next.status).toBe('blocked');
    expect(next.blockedReason).toContain('API key');
    expect(next.assignedSessionId).toBeNull();
  });

  it('marks failed on a non-zero exit code', () => {
    const task = started('Fix auth bug');
    const next = classifyTaskAfterExecution(task, { exitCode: 1 });
    expect(next.status).toBe('failed');
    expect(next.failureReason).toContain('1');
  });
});

describe('a failure the agent declares itself', () => {
  const task = started('Fix auth bug');

  it('is failed, not complete, even on a clean exit', () => {
    // A CLI agent sits in a REPL: it reports an error and goes back to its
    // prompt, so the process is alive and will exit 0 whenever it does exit.
    // Exit code alone cannot see this, which is how a broken run got announced
    // as "Agent finished".
    const out = classifyTaskAfterExecution(task, {
      exitCode: 0,
      failed: true,
      note: 'Could not resolve the migration conflict.',
    });
    expect(out.status).toBe('failed');
    expect(out.failureReason).toBe('Could not resolve the migration conflict.');
    expect(out.blockedReason).toBeNull();
  });

  it('outranks needs-input, which is a different question', () => {
    const out = classifyTaskAfterExecution(task, {
      exitCode: 0,
      failed: true,
      needsHumanInput: true,
      note: 'Ran out of retries.',
    });
    expect(out.status).toBe('failed');
  });

  it('leaves the ordinary clean finish alone', () => {
    const out = classifyTaskAfterExecution(task, { exitCode: 0, failed: false });
    expect(out.status).toBe('complete');
  });
});
