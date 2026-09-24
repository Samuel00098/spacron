import { describe, expect, it, vi } from 'vitest';

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn() }));

import { formatElapsed, statusFor, summaryLine } from './FleetDashboard';
import { sessionHeaderSummary } from '$lib/stores/terminal';
import type { OrchestratorTask } from '$lib/services/orchestrator/task-lifecycle';

const task = (status: string) => ({ status }) as unknown as OrchestratorTask;

// statusFor(task, live, turnPhase)
describe('fleet card status', () => {
  it('reads Idle for an agent that was only opened', () => {
    expect(statusFor(null, true, undefined)).toBe('idle');
    expect(statusFor(null, true, 'idle')).toBe('idle');
  });

  it('reads Idle for an agent whose orchestrator task was never sent to it', () => {
    expect(statusFor(task('in-progress'), true, undefined)).toBe('idle');
  });

  it('reads Working while a sent task is open', () => {
    expect(statusFor(null, true, 'working')).toBe('working');
  });

  it('reports how the last turn ended, like the notification did', () => {
    expect(statusFor(null, true, 'finished')).toBe('finished');
    expect(statusFor(null, true, 'blocked')).toBe('awaiting');
    expect(statusFor(null, true, 'failed')).toBe('failed');
  });

  it('lets a question outrank activity', () => {
    expect(statusFor(task('blocked'), true, 'working')).toBe('awaiting');
  });

  it('reads Exited once the pane is gone, or the task outcome', () => {
    expect(statusFor(null, false, 'working')).toBe('exited');
    expect(statusFor(task('complete'), false, undefined)).toBe('finished');
    expect(statusFor(task('failed'), false, undefined)).toBe('failed');
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

describe('summaryLine', () => {
  it("shows the agent's header summary, then the task goal", () => {
    expect(summaryLine('Task panel multi-line text input', 'Old goal', 'working')).toBe('Task panel multi-line text input');
    expect(summaryLine(null, 'Add dark mode', 'working')).toBe('Add dark mode');
  });

  it('falls back to a plain word for the state', () => {
    expect(summaryLine(null, null, 'idle')).toBe('No task yet');
    expect(summaryLine('  ', '  ', 'working')).toBe('Working on a task');
  });
});

describe('sessionHeaderSummary', () => {
  it("takes the CLI's own title, without its spinner glyph", () => {
    expect(sessionHeaderSummary({ paneTitle: '◐ Task panel multi-line text input', agentPreset: 'claude' })).toBe(
      'Task panel multi-line text input',
    );
  });

  it("treats the product's own name as no summary", () => {
    expect(sessionHeaderSummary({ paneTitle: '✳ Claude Code', agentPreset: 'claude' })).toBeNull();
    expect(sessionHeaderSummary({ paneTitle: '✳ Claude Code', taskSummary: 'Fix login', agentPreset: 'claude' })).toBe('Fix login');
    expect(sessionHeaderSummary(null)).toBeNull();
  });
});
