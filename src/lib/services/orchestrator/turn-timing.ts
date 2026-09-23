/**
 * Where a turn's time went, as one "Worked for …" line at the end of Work
 * details (Codex shows the same). Model time is wall-clock per request, so it
 * includes the provider's queueing and any rate-limit back-off; tool time is
 * the sum of each operation's wall-clock, so parallel reads can exceed it.
 */
export interface TurnTiming {
  startedAt: number;
  modelCalls: number;
  modelMs: number;
  slowestModelMs: number;
  toolCalls: number;
  toolMs: number;
}

export const TURN_TIMING_PREFIX = 'Worked for ';

export function createTurnTiming(now = Date.now()): TurnTiming {
  return { startedAt: now, modelCalls: 0, modelMs: 0, slowestModelMs: 0, toolCalls: 0, toolMs: 0 };
}

export function recordModelCall(timing: TurnTiming, elapsedMs: number): void {
  timing.modelCalls += 1;
  timing.modelMs += elapsedMs;
  timing.slowestModelMs = Math.max(timing.slowestModelMs, elapsedMs);
}

export function recordToolCall(timing: TurnTiming, elapsedMs: number): void {
  timing.toolCalls += 1;
  timing.toolMs += elapsedMs;
}

export function formatDuration(ms: number): string {
  const seconds = Math.max(0, Math.round(ms / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  return `${minutes}m ${String(seconds % 60).padStart(2, '0')}s`;
}

/** "Worked for 2m 14s" plus a breakdown line, or null for a turn without model calls. */
export function formatTurnTiming(timing: TurnTiming, now = Date.now()): string | null {
  if (!timing.modelCalls) return null;
  const total = now - timing.startedAt;
  const calls = timing.modelCalls === 1 ? '1 model call' : `${timing.modelCalls} model calls`;
  const parts = [`${calls}: ${formatDuration(timing.modelMs)} (slowest ${formatDuration(timing.slowestModelMs)})`];
  if (timing.toolCalls) parts.push(`${timing.toolCalls} operation${timing.toolCalls === 1 ? '' : 's'}: ${formatDuration(timing.toolMs)}`);
  const waiting = total - timing.modelMs - timing.toolMs;
  if (waiting > 5_000) parts.push(`waiting on you or other work: ${formatDuration(waiting)}`);
  return `${TURN_TIMING_PREFIX}${formatDuration(total)}\n\n${parts.join('\n')}`;
}
