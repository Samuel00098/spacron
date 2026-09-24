import { describe, expect, it, vi } from 'vitest';

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn() }));

import { formatElapsed, statusFor } from './FleetDashboard';
import type { OrchestratorTask } from '$lib/services/orchestrator/task-lifecycle';

const task = (status: string) => ({ status }) as unknown as OrchestratorTask;

// statusFor(task, live, turnPhase, leasedTurn)
describe('fleet card status', () => {
  it('reads Idle for an agent that was only opened', () => {
    expect(statusFor(null, true, undefined, false)).toBe('idle');
    expect(statusFor(null, true, 'idle', false)).toBe('idle');
  });

  it('reads Working while a prompted turn is open', () => {
    expect(statusFor(null, true, 'working', false)).toBe('working');
  });

  it('reads Working while the orchestrator runs a task it dispatched', () => {
    expect(statusFor(task('in-progress'), true, undefined, true)).toBe('working');
  });

  it('reports how the last turn ended, like the notification did', () => {
    expect(statusFor(null, true, 'finished', false)).toBe('finished');
    expect(statusFor(null, true, 'blocked', false)).toBe('awaiting');
    expect(statusFor(null, true, 'failed', false)).toBe('failed');
  });

  it('lets a question outrank activity', () => {
    expect(statusFor(task('blocked'), true, 'working', true)).toBe('awaiting');
  });

  it('falls back to the task outcome for a live agent with no turn record', () => {
    expect(statusFor(task('complete'), true, undefined, false)).toBe('finished');
  });

  it('reads Exited once the pane is gone, or the task outcome', () => {
    expect(statusFor(null, false, 'working', false)).toBe('exited');
    expect(statusFor(task('complete'), false, undefined, false)).toBe('finished');
    expect(statusFor(task('failed'), false, undefined, false)).toBe('failed');
  });
});

describe('formatElapsed', () => {
  it('formats seconds, minutes and hours', () => {
    expect(formatElapsed(42_000)).toBe('42s');
    expect(formatElapsed(185_000)).toBe('3m 05s');
    expect(formatElapsed(4_320_000)).toBe('1h 12m');
    expect(formatElapsed(-5)).toBe('0s');
  });
});
