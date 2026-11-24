import { describe, it, expect, beforeEach, vi } from 'vitest';
import { get } from '$lib/stores/storeCompat';
import {
  sessions,
  devSessions,
  activeSessionId,
  terminalInputRequest,
  terminalChatInputRequest,
  promptBarImage,
  type TerminalSessionInfo,
} from '$lib/stores/terminal';
import { setTerminalChatView } from '$lib/services/terminal-chat';
import { structuredChatPanes } from '$lib/services/structured-chat/panes';
import {
  getActiveAgentTargets,
  resolveDefaultTarget,
  quoteTerminalPath,
  dataUrlToBytes,
  dispatchPromptToAgent,
  type AgentTarget,
} from './agent-target';

vi.mock('@tauri-apps/api/core', () => ({
  invoke: vi.fn(async (cmd: string, args: any) => {
    if (cmd === 'save_pasted_image') {
      return `C:/Users/test/.spacron/pasted/${args.name}`;
    }
    return null;
  }),
}));

describe('agent-target service', () => {
  beforeEach(() => {
    sessions.set([]);
    devSessions.set([]);
    activeSessionId.set(null);
    terminalInputRequest.set(null);
    terminalChatInputRequest.set(null);
    promptBarImage.set(null);
    structuredChatPanes.set({});
  });

  describe('quoteTerminalPath', () => {
    it('normalizes backslashes to forward slashes', () => {
      expect(quoteTerminalPath('C:\\path\\to\\file.png')).toBe('C:/path/to/file.png');
    });

    it('quotes paths with spaces', () => {
      expect(quoteTerminalPath('C:\\My Folder\\image.png')).toBe('"C:/My Folder/image.png"');
    });
  });

  describe('dataUrlToBytes', () => {
    it('converts base64 data URL to bytes array', () => {
      const dataUrl = 'data:image/png;base64,aGVsbG8=';
      const bytes = dataUrlToBytes(dataUrl);
      expect(bytes.length).toBe(5);
      expect(String.fromCharCode(...bytes)).toBe('hello');
    });
  });

  describe('getActiveAgentTargets', () => {
    it('returns empty array when no sessions exist', () => {
      expect(getActiveAgentTargets()).toEqual([]);
    });

    it('ignores plain shell sessions without agentPreset', () => {
      sessions.set([
        { id: 1, title: 'bash', isRunning: true, projectId: 'p1' } as TerminalSessionInfo,
      ]);
      expect(getActiveAgentTargets()).toEqual([]);
    });

    it('ignores non-running or hidden agent sessions', () => {
      sessions.set([
        { id: 1, agentPreset: 'claude', isRunning: false, projectId: 'p1' } as TerminalSessionInfo,
        { id: 2, agentPreset: 'codex', isRunning: true, hidden: true, projectId: 'p1' } as TerminalSessionInfo,
      ]);
      expect(getActiveAgentTargets()).toEqual([]);
    });

    it('includes running agent sessions and detects Chat vs Terminal mode', () => {
      sessions.set([
        {
          id: 1,
          agentPreset: 'claude',
          agentName: 'Claude Code',
          isRunning: true,
          projectId: 'p1',
          lastActivatedAt: 100,
        } as TerminalSessionInfo,
        {
          id: 2,
          agentPreset: 'codex',
          agentName: 'Codex',
          isRunning: true,
          projectId: 'p1',
          lastActivatedAt: 200,
        } as TerminalSessionInfo,
      ]);

      setTerminalChatView(1, true);
      setTerminalChatView(2, false);

      const targets = getActiveAgentTargets();
      expect(targets.length).toBe(2);

      const claude = targets.find((t) => t.id === 1)!;
      expect(claude.isChatView).toBe(true);
      expect(claude.displayName).toContain('(Chat)');

      const codex = targets.find((t) => t.id === 2)!;
      expect(codex.isChatView).toBe(false);
      expect(codex.displayName).toContain('(Terminal)');
    });
  });

  describe('resolveDefaultTarget', () => {
    it('returns null for empty target list', () => {
      expect(resolveDefaultTarget([])).toBeNull();
    });

    it('automatically selects the only open agent when length === 1', () => {
      const singleTarget: AgentTarget = {
        id: 42,
        sessionId: 42,
        name: 'Claude Code',
        preset: 'claude',
        displayName: 'Claude Code (Chat)',
        isChatView: true,
        isDev: false,
        lastActivatedAt: 1234,
      };

      const resolved = resolveDefaultTarget([singleTarget]);
      expect(resolved).toBe(singleTarget);
      expect(resolved?.id).toBe(42);
    });

    it('prefers active session if among targets when multiple agents are open', () => {
      const t1: AgentTarget = {
        id: 1,
        sessionId: 1,
        name: 'Claude Code',
        preset: 'claude',
        displayName: 'Claude Code (Chat)',
        isChatView: true,
        isDev: false,
        lastActivatedAt: 100,
      };
      const t2: AgentTarget = {
        id: 2,
        sessionId: 2,
        name: 'Codex',
        preset: 'codex',
        displayName: 'Codex (Terminal)',
        isChatView: false,
        isDev: false,
        lastActivatedAt: 200,
      };

      activeSessionId.set(2);
      expect(resolveDefaultTarget([t1, t2])?.id).toBe(2);

      activeSessionId.set(1);
      expect(resolveDefaultTarget([t1, t2])?.id).toBe(1);
    });
  });

  describe('dispatchPromptToAgent', () => {
    it('dispatches to TerminalChatView when target is in Chat UI', async () => {
      const chatTarget: AgentTarget = {
        id: 10,
        sessionId: 10,
        name: 'Claude Code',
        preset: 'claude',
        displayName: 'Claude Code (Chat)',
        isChatView: true,
        isDev: false,
        lastActivatedAt: 100,
      };

      // The destination must still be a running agent session.
      sessions.set([{ id: 10, agentPreset: 'claude', agentName: 'Claude Code', isRunning: true, projectId: 'p1' } as TerminalSessionInfo]);
      await dispatchPromptToAgent(chatTarget, 'Please fix the header styling', {
        imageDataUrl: 'data:image/png;base64,aGVsbG8=',
        imageName: 'header-element.png',
      });

      const chatReq = get(terminalChatInputRequest);
      expect(chatReq).not.toBeNull();
      expect(chatReq?.sessionId).toBe(10);
      expect(chatReq?.text).toBe('Please fix the header styling');
      expect(chatReq?.image?.name).toBe('header-element.png');
      expect(chatReq?.image?.path).toContain('header-element.png');
      expect(get(terminalInputRequest)).toBeNull();
    });

    it('dispatches to TerminalPane when target is in Terminal UI', async () => {
      const termTarget: AgentTarget = {
        id: 20,
        sessionId: 20,
        name: 'Codex',
        preset: 'codex',
        displayName: 'Codex (Terminal)',
        isChatView: false,
        isDev: false,
        lastActivatedAt: 200,
      };

      sessions.set([{ id: 20, agentPreset: 'codex', agentName: 'Codex', isRunning: true, projectId: 'p1' } as TerminalSessionInfo]);
      await dispatchPromptToAgent(termTarget, 'Refactor this button', {
        imageDataUrl: 'data:image/png;base64,aGVsbG8=',
        imageName: 'btn.png',
      });

      const termReq = get(terminalInputRequest);
      expect(termReq).not.toBeNull();
      expect(termReq?.sessionId).toBe(20);
      expect(termReq?.text).toContain('btn.png');
      expect(termReq?.text).toContain('Refactor this button');

      const barImg = get(promptBarImage);
      expect(barImg).not.toBeNull();
      expect(barImg?.name).toBe('btn.png');
    });
  });
});
