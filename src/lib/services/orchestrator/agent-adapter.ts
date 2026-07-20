import {
  waitForAgentReady,
  sendAgentPromptDirect,
  writeToSession,
  getSessionOutputBuffer,
  onSessionExit,
  type AgentReadiness,
} from '$lib/stores/terminal';
import { captureTranscript } from '$lib/services/orchestrator/activity-log';
import {
  watchLeasedAgentTurn,
  type AgentTurnOutcome,
  type WatchLeasedAgentOptions,
} from '$lib/services/orchestrator/agent-turn-watch';

export interface SendOptions {
  shouldContinue?: () => boolean;
}

const DEFAULT_OUTPUT_POLL_MS = 500;

export class AgentAdapter {
  readonly sessionId: number;
  private outputTimers = new Set<ReturnType<typeof setInterval>>();
  private disposed = false;

  constructor(sessionId: number) {
    this.sessionId = sessionId;
  }

  // ── Send / input ────────────────────────────────────────────────────────────

  waitForReady(): Promise<AgentReadiness> {
    return waitForAgentReady(this.sessionId);
  }

  async sendGoal(message: string, opts?: SendOptions): Promise<boolean> {
    if (!message.trim()) return false;
    if ((await this.waitForReady()) === 'launch-failed') return false;
    if (opts?.shouldContinue && !opts.shouldContinue()) return false;
    return sendAgentPromptDirect(this.sessionId, message);
  }

  sendFollowUp(message: string, opts?: SendOptions): Promise<boolean> {
    return this.sendGoal(message, opts);
  }

  resend(message: string): void {
    if (!message.trim()) return;
    void sendAgentPromptDirect(this.sessionId, message);
  }

  writeRaw(data: string): void {
    writeToSession(this.sessionId, data);
  }

  // ── Receive / output ─────────────────────────────────────────────────────────

  readOutput(tailChars?: number): string {
    return captureTranscript(getSessionOutputBuffer(this.sessionId), tailChars);
  }

  snapshot(): string {
    return getSessionOutputBuffer(this.sessionId);
  }

  subscribeOutput(onChunk: (chunk: string) => void, intervalMs = DEFAULT_OUTPUT_POLL_MS): () => void {
    let lastLen = getSessionOutputBuffer(this.sessionId).length;
    const timer = setInterval(() => {
      const buf = getSessionOutputBuffer(this.sessionId);
      if (buf.length > lastLen) {
        onChunk(buf.slice(lastLen));
        lastLen = buf.length;
      } else if (buf.length < lastLen) {
        lastLen = buf.length;
      }
    }, intervalMs);
    this.outputTimers.add(timer);
    return () => {
      clearInterval(timer);
      this.outputTimers.delete(timer);
    };
  }

  // ── Lifecycle ────────────────────────────────────────────────────────────────

  watchTurn(opts: WatchLeasedAgentOptions): Promise<AgentTurnOutcome> {
    return watchLeasedAgentTurn(this.sessionId, opts);
  }

  onExit(cb: (code: number) => void): () => void {
    return onSessionExit((info) => {
      if (info.sessionId === this.sessionId) cb(info.code);
    });
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const timer of this.outputTimers) clearInterval(timer);
    this.outputTimers.clear();
  }
}

const adapters = new Map<number, AgentAdapter>();

export function getAgentAdapter(sessionId: number): AgentAdapter {
  let adapter = adapters.get(sessionId);
  if (!adapter) {
    adapter = new AgentAdapter(sessionId);
    adapters.set(sessionId, adapter);
  }
  return adapter;
}

export function disposeAgentAdapter(sessionId: number): void {
  const adapter = adapters.get(sessionId);
  if (adapter) {
    adapter.dispose();
    adapters.delete(sessionId);
  }
}
