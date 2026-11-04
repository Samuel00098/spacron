import { describe, it, expect } from 'vitest';
import { autoSettleStaleThreads, AUTO_SETTLE_IDLE_MS } from './chatThreads';
import type { ChatThread } from './chatThreads';

describe('autoSettleStaleThreads', () => {
const baseThread = (overrides: Partial<ChatThread> = {}): ChatThread => ({
  id: 't1',
  projectId: 'p1',
  title: 'Test',
  agentName: null,
  agentPreset: null,
  provider: null,
  model: null,
  accessMode: 'inherit',
  workMode: 'build',
  standalone: false,
  pinned: false,
  archived: false,
  order: undefined,
  forkOfThreadId: null,
  snoozedUntil: undefined,
  settledAt: undefined,
  unreadCount: 0,
  draft: '',
  contextUsage: undefined,
  turnPlan: undefined,
  handoffs: [],
  nativeAcpSessionId: null,
  nativeAcpCommand: null,
  nativeAcpModel: null,
  nativeAcpCapabilities: null,
  agentCheckpoint: undefined,
  agentBudgets: undefined,
  worktree: null,
  pullRequest: null,
  parentThreadId: null,
  subagentTaskId: null,
  subagentRole: null,
  status: 'idle',
  createdAt: Date.now() - 100000,
  updatedAt: Date.now() - 100000,
  lastActivityAt: Date.now() - 100000,
  turnEndedAt: undefined,
  taskId: null,
  sessionId: null,
  reasoningEffort: 'default',
  ...overrides,
});

  it('does not settle pinned threads', () => {
    const now = Date.now();
    const t = baseThread({ pinned: true, status: 'idle', lastActivityAt: now - AUTO_SETTLE_IDLE_MS * 2 });
    const { settled, remaining } = autoSettleStaleThreads([t], now);
    expect(settled).toHaveLength(0);
    expect(remaining).toHaveLength(1);
  });

  it('does not settle working threads', () => {
    const now = Date.now();
    const t = baseThread({ status: 'working', lastActivityAt: now - AUTO_SETTLE_IDLE_MS * 2 });
    const { settled, remaining } = autoSettleStaleThreads([t], now);
    expect(settled).toHaveLength(0);
    expect(remaining).toHaveLength(1);
  });

  it('does not settle recently active threads', () => {
    const now = Date.now();
    const t = baseThread({ status: 'idle', lastActivityAt: now - AUTO_SETTLE_IDLE_MS / 2 });
    const { settled, remaining } = autoSettleStaleThreads([t], now);
    expect(settled).toHaveLength(0);
    expect(remaining).toHaveLength(1);
  });

  it('settles stale idle threads', () => {
    const now = Date.now();
    const t = baseThread({ status: 'idle', lastActivityAt: now - AUTO_SETTLE_IDLE_MS * 2 });
    const { settled, remaining } = autoSettleStaleThreads([t], now);
    expect(settled).toHaveLength(1);
    expect(remaining[0].settledAt).toBe(now);
    expect(remaining[0].snoozedUntil).toBeUndefined();
  });

  it('preserves already settled threads', () => {
    const now = Date.now();
    const t = baseThread({ status: 'idle', lastActivityAt: now - AUTO_SETTLE_IDLE_MS * 2, settledAt: now - 1000 });
    const { settled, remaining } = autoSettleStaleThreads([t], now);
    expect(settled).toHaveLength(0); // already settled
    expect(remaining[0].settledAt).toBe(now - 1000);
  });
});