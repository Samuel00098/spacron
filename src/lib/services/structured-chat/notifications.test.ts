import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { StructuredEvent } from './event-journal';

const {
  announceVal,
  speakVal,
  activeSessionVal,
  systemAwayState,
  mockPlayNudge,
  mockSpeakText,
  mockShowToast,
  mockShowSystemNotification,
  mockMarkStructuredChatUnread,
  mockSetActiveSession,
} = vi.hoisted(() => {
  return {
    announceVal: { current: true },
    speakVal: { current: true },
    activeSessionVal: { current: 1 as number | null },
    systemAwayState: { value: false },
    mockPlayNudge: vi.fn(),
    mockSpeakText: vi.fn(),
    mockShowToast: vi.fn(),
    mockShowSystemNotification: vi.fn(),
    mockMarkStructuredChatUnread: vi.fn(),
    mockSetActiveSession: vi.fn(),
  };
});

vi.mock('$lib/stores/settings', () => ({
  announceAgentCompletions: {
    subscribe: (fn: (v: boolean) => void) => {
      fn(announceVal.current);
      return () => {};
    },
  },
  speakAgentCompletions: {
    subscribe: (fn: (v: boolean) => void) => {
      fn(speakVal.current);
      return () => {};
    },
  },
}));

vi.mock('$lib/stores/terminal', () => ({
  activeSessionId: {
    subscribe: (fn: (v: number | null) => void) => {
      fn(activeSessionVal.current);
      return () => {};
    },
  },
  getAgentDisplayName: (preset: string) => (preset === 'codex' ? 'Codex' : preset === 'claude' ? 'Claude' : preset),
  setActiveSession: (...args: any[]) => mockSetActiveSession(...args),
}));

vi.mock('$lib/services/reveal-agent-chat', () => ({
  revealAgentChat: (...args: any[]) => mockSetActiveSession(...args),
}));

vi.mock('$lib/services/nudge', () => ({
  playNudge: (...args: any[]) => mockPlayNudge(...args),
}));

vi.mock('$lib/services/read-aloud', () => ({
  speakText: (...args: any[]) => mockSpeakText(...args),
}));

vi.mock('$lib/stores/notification', () => ({
  showToast: (...args: any[]) => mockShowToast(...args),
}));

vi.mock('$lib/stores/zustand/notification', () => ({
  showSystemNotification: (...args: any[]) => mockShowSystemNotification(...args),
  shouldUseSystemNotification: () => systemAwayState.value,
}));

vi.mock('./panes', () => ({
  markStructuredChatUnread: (...args: any[]) => mockMarkStructuredChatUnread(...args),
  structuredChatPreset: (paneId: number) => (paneId === 1 ? 'codex' : 'claude'),
}));

vi.mock('./session-store', () => ({
  recordForPane: (paneId: number) => ({
    id: `rec-${paneId}`,
    preset: paneId === 1 ? 'codex' : 'claude',
    provider: paneId === 1 ? 'codex' : 'claude',
  }),
  subscribeStructuredEvents: vi.fn(),
}));

import {
  handleStructuredNotificationEvent,
  resetStructuredChatNotificationsForTesting,
} from './notifications';

function makeEvent(type: StructuredEvent['type'], payload: Record<string, unknown>): StructuredEvent {
  return {
    id: 'evt-1',
    sessionId: 'sess-1',
    seq: 1,
    turnId: 'turn-1',
    provider: 'codex',
    type,
    at: Date.now(),
    payload,
  };
}

describe('structured chat notifications', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetStructuredChatNotificationsForTesting();
    announceVal.current = true;
    speakVal.current = true;
    activeSessionVal.current = 1;
    systemAwayState.value = false;
  });

  describe('turn.completed', () => {
    it('plays "done" nudge and speaks text when focused on current pane', () => {
      const event = makeEvent('turn.completed', { turnId: 'turn-1' });

      handleStructuredNotificationEvent(1, event);

      expect(mockPlayNudge).toHaveBeenCalledWith('done');
      expect(mockSpeakText).toHaveBeenCalledWith('Codex finished its turn.');
      // Should NOT show toast or unread mark because pane 1 is active and not away
      expect(mockMarkStructuredChatUnread).not.toHaveBeenCalled();
      expect(mockShowToast).not.toHaveBeenCalled();
      expect(mockShowSystemNotification).not.toHaveBeenCalled();
    });

    it('marks unread and shows in-app toast when another pane is active', () => {
      activeSessionVal.current = 2; // user is looking at pane 2
      const event = makeEvent('turn.completed', { turnId: 'turn-1' });

      handleStructuredNotificationEvent(1, event);

      expect(mockPlayNudge).toHaveBeenCalledWith('done');
      expect(mockSpeakText).toHaveBeenCalledWith('Codex finished its turn.');
      expect(mockMarkStructuredChatUnread).toHaveBeenCalledWith(1);
      expect(mockShowToast).toHaveBeenCalledWith(
        'Codex finished its turn.',
        'success',
        5000,
        false,
        expect.objectContaining({ label: 'View chat' }),
      );
      expect(mockShowSystemNotification).not.toHaveBeenCalled();
    });

    it('shows desktop OS notification when system is away', () => {
      systemAwayState.value = true;
      const event = makeEvent('turn.completed', { turnId: 'turn-1' });

      handleStructuredNotificationEvent(1, event);

      expect(mockMarkStructuredChatUnread).toHaveBeenCalledWith(1);
      expect(mockShowSystemNotification).toHaveBeenCalledWith('Codex finished its turn', 'success');
      expect(mockShowToast).not.toHaveBeenCalled();
    });

    it('respects settings when audio and speech are disabled', () => {
      announceVal.current = false;
      speakVal.current = false;
      const event = makeEvent('turn.completed', { turnId: 'turn-1' });

      handleStructuredNotificationEvent(1, event);

      expect(mockPlayNudge).not.toHaveBeenCalled();
      expect(mockSpeakText).not.toHaveBeenCalled();
    });
  });

  describe('approval.requested', () => {
    it('plays "blocked" nudge and alerts for permission requests', () => {
      activeSessionVal.current = 2;
      const event = makeEvent('approval.requested', { requestId: 'req-42', title: 'Execute command: git pull' });

      handleStructuredNotificationEvent(1, event);

      expect(mockPlayNudge).toHaveBeenCalledWith('blocked');
      expect(mockSpeakText).toHaveBeenCalledWith('Codex needs your approval.');
      expect(mockMarkStructuredChatUnread).toHaveBeenCalledWith(1);
      expect(mockShowToast).toHaveBeenCalledWith(
        'Codex needs your approval: Execute command: git pull',
        'warning',
        7000,
        false,
        expect.objectContaining({ label: 'Review' }),
      );
    });

    it('deduplicates repeat approval events with the same requestId', () => {
      const event = makeEvent('approval.requested', { requestId: 'req-dup', title: 'File edit' });

      handleStructuredNotificationEvent(1, event);
      handleStructuredNotificationEvent(1, event);

      expect(mockPlayNudge).toHaveBeenCalledTimes(1);
      expect(mockSpeakText).toHaveBeenCalledTimes(1);
    });
  });

  describe('turn.interrupted and error', () => {
    it('plays "failed" nudge and speaks text on failure', () => {
      const event = makeEvent('turn.interrupted', { message: 'Agent cancelled' });

      handleStructuredNotificationEvent(1, event);

      expect(mockPlayNudge).toHaveBeenCalledWith('failed');
      expect(mockSpeakText).toHaveBeenCalledWith('Codex could not finish.');
    });

    it('debounces rapid consecutive error events', () => {
      const event1 = makeEvent('turn.interrupted', { message: 'Interrupted' });
      const event2 = makeEvent('error', { message: 'Process exited' });

      handleStructuredNotificationEvent(1, event1);
      handleStructuredNotificationEvent(1, event2);

      // Only one alert should fire within 800ms
      expect(mockPlayNudge).toHaveBeenCalledTimes(1);
      expect(mockSpeakText).toHaveBeenCalledTimes(1);
    });
  });
});
