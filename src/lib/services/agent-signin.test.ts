import { describe, it, expect, beforeEach, vi } from 'vitest';
import { shouldOfferSignIn, runAgentSignIn } from './agent-signin';
import type { DetectedAgent } from '$lib/stores/usage';

type ExitInfo = { sessionId: number; projectId: string; code: number };

// shouldOfferSignIn is a pure predicate; the heavy imports in agent-signin.ts
// (the terminal store chain) are stubbed so the test loads fast and touches
// nothing outside this module.
const terminalMocks = vi.hoisted(() => ({
  ensureIdleOrCreateTerminal: vi.fn(),
  writeToSession: vi.fn(),
  setActiveSession: vi.fn(),
  onSessionExit: vi.fn(),
  refreshUsage: vi.fn(),
  requestRoomControl: vi.fn(),
}));

vi.mock('$lib/stores/terminal', () => terminalMocks);
vi.mock('$lib/stores/usage', () => ({
  refreshUsage: terminalMocks.refreshUsage,
}));
vi.mock('$lib/stores/layoutControl', () => ({
  requestRoomControl: terminalMocks.requestRoomControl,
}));

function detected(overrides: Partial<DetectedAgent> = {}): DetectedAgent {
  return {
    provider: 'test',
    command: 'test',
    name: 'Test',
    installed: true,
    signedIn: false,
    detectsSignIn: true,
    supportsUsage: false,
    ...overrides,
  };
}

describe('shouldOfferSignIn', () => {
  it('offers sign-in only when credentials are known to be missing', () => {
    // installed + sign-in detectable + not signed in — the one true case.
    expect(shouldOfferSignIn(detected())).toBe(true);
  });

  it('never offers sign-in for an agent that is not installed', () => {
    expect(shouldOfferSignIn(detected({ installed: false }))).toBe(false);
    expect(shouldOfferSignIn(detected({ installed: false, signedIn: false }))).toBe(false);
  });

  it('never offers sign-in once signed in', () => {
    expect(shouldOfferSignIn(detected({ signedIn: true }))).toBe(false);
    expect(shouldOfferSignIn(detected({ installed: true, signedIn: true }))).toBe(false);
  });

  it('never offers sign-in for keychain CLIs whose state is unknown', () => {
    // `detectsSignIn: false` means "unknown", not "signed out" — running the
    // CLI might just start an already-signed-in tool. The badge tooltip covers
    // this case instead of a one-click action.
    expect(shouldOfferSignIn(detected({ detectsSignIn: false }))).toBe(false);
    expect(shouldOfferSignIn(detected({ detectsSignIn: false, signedIn: false }))).toBe(false);
    expect(shouldOfferSignIn(detected({ detectsSignIn: false, signedIn: true }))).toBe(false);
  });

  it('requires all three conditions together — no partial states', () => {
    expect(shouldOfferSignIn(detected({ installed: false, detectsSignIn: true, signedIn: false }))).toBe(false);
    expect(shouldOfferSignIn(detected({ installed: true, detectsSignIn: false, signedIn: false }))).toBe(false);
    expect(shouldOfferSignIn(detected({ installed: true, detectsSignIn: true, signedIn: true }))).toBe(false);
  });

  it('is false when no detection data is available', () => {
    expect(shouldOfferSignIn(undefined)).toBe(false);
  });
});

describe('runAgentSignIn', () => {
  let exitListeners: Array<(info: ExitInfo) => void>;
  let unsubMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    exitListeners = [];
    unsubMock = vi.fn();
    terminalMocks.ensureIdleOrCreateTerminal.mockReset().mockResolvedValue(42);
    terminalMocks.writeToSession.mockReset();
    terminalMocks.setActiveSession.mockReset();
    terminalMocks.refreshUsage.mockReset();
    terminalMocks.onSessionExit.mockReset().mockImplementation((listener: (info: ExitInfo) => void) => {
      exitListeners.push(listener);
      return unsubMock;
    });
    terminalMocks.requestRoomControl.mockReset();
  });

  it('registers a one-shot watch on the sign-in session', async () => {
    await runAgentSignIn({ command: 'claude', name: 'Claude Code', cwd: '/work', projectId: 'p1' });
    expect(exitListeners).toHaveLength(1);
    expect(terminalMocks.writeToSession).toHaveBeenCalledWith(42, 'claude\r');
  });

  it('brings the terminal room on stage so the sign-in is visible', async () => {
    await runAgentSignIn({ command: 'claude', name: 'Claude Code', cwd: '/work', projectId: 'p1' });
    expect(terminalMocks.requestRoomControl).toHaveBeenCalledWith('focus', 'terminal');
    expect(terminalMocks.setActiveSession).toHaveBeenCalledWith(42);
  });

  it('forces a fresh detection scan shortly after the session exits', async () => {
    vi.useFakeTimers();
    try {
      await runAgentSignIn({ command: 'claude', name: 'Claude Code', cwd: '/work', projectId: 'p1' });
      exitListeners[0]({ sessionId: 42, projectId: 'p1', code: 0 });
      // The watch removes itself after the first matching exit (one-shot).
      expect(unsubMock).toHaveBeenCalledTimes(1);
      // Not immediately — the credential file needs a beat to land.
      expect(terminalMocks.refreshUsage).not.toHaveBeenCalled();
      vi.advanceTimersByTime(2000);
      expect(terminalMocks.refreshUsage).toHaveBeenCalledWith(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it('ignores exits from other sessions', async () => {
    vi.useFakeTimers();
    try {
      await runAgentSignIn({ command: 'claude', name: 'Claude Code', cwd: '/work', projectId: 'p1' });
      exitListeners[0]({ sessionId: 99, projectId: 'p1', code: 0 });
      vi.advanceTimersByTime(2000);
      expect(terminalMocks.refreshUsage).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });
});
