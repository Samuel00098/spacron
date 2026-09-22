import { beforeEach, describe, expect, it, vi } from 'vitest';

const invoke = vi.hoisted(() => vi.fn());
vi.mock('@tauri-apps/api/core', () => ({ invoke }));

import { classify, classifyDecision, classifyRouting, estimateFileOverlap, triageNeedsInput } from './jev';

const answer = (probabilities: Record<string, number>, confidence = 0.95) => ({
  type: 'choice', choice: Object.entries(probabilities).sort((a, b) => b[1] - a[1])[0][0], probabilities, confidence,
});

beforeEach(() => invoke.mockReset());

describe('Jev Choice client', () => {
  it('returns the documented probabilities and keeps key handling in Rust', async () => {
    invoke.mockResolvedValue(answer({ yes: 0.9, no: 0.1 }));
    await expect(classify('The agent asked for approval', { yes: 'Yes', no: 'No' }, 'Is it waiting?'))
      .resolves.toEqual({ yes: 0.9, no: 0.1 });
    expect(invoke).toHaveBeenCalledWith('jev_classify', {
      state: 'The agent asked for approval', question: 'Is it waiting?', labels: { yes: 'Yes', no: 'No' },
    });
  });

  it('falls back with no key, request error, timeout, or malformed probabilities', async () => {
    invoke.mockResolvedValueOnce(null)
      .mockRejectedValueOnce(new Error('HTTP 429'))
      .mockRejectedValueOnce(new Error('timed out'))
      .mockResolvedValueOnce(answer({ yes: 1.4, no: -0.4 }));
    const call = () => classifyDecision('state', { yes: 'Yes', no: 'No' }, 'Which?');
    await expect(call()).resolves.toBeNull();
    await expect(call()).resolves.toBeNull();
    await expect(call()).resolves.toBeNull();
    await expect(call()).resolves.toBeNull();
  });

  it('keeps low-confidence routing and triage on the current behavior', async () => {
    invoke.mockResolvedValueOnce(null).mockResolvedValueOnce(answer({ permission_prompt: 0.9, question: 0.04, crash: 0.03, auth_or_rate_limit: 0.03 }, 0.5));
    await expect(classifyRouting('Please explain this')).resolves.toBeNull();
    await expect(triageNeedsInput('Approve?')).resolves.toBeNull();
  });

  it('classifies needs-input text and warns only on confident overlap', async () => {
    invoke.mockResolvedValueOnce(answer({ permission_prompt: 0.92, question: 0.03, crash: 0.03, auth_or_rate_limit: 0.02 }))
      .mockResolvedValueOnce(answer({ overlap: 0.91, separate: 0.09 }))
      .mockResolvedValueOnce(null);
    await expect(triageNeedsInput('\x1b[31mApprove editing app.ts?\x1b[0m')).resolves.toBe('permission_prompt');
    expect(invoke.mock.calls[0][1].state).not.toContain('\x1b');
    const running = [{ name: 'Iris', title: 'Edit app.ts', recentOutput: 'Writing app.ts' }];
    await expect(estimateFileOverlap('Change app.ts', running)).resolves.toBe(true);
    await expect(estimateFileOverlap('Change app.ts', running)).resolves.toBe(false);
    await expect(estimateFileOverlap('Change app.ts', [])).resolves.toBe(false);
  });
});
