/**
 * Notifications for structured chat turns, approvals, and errors.
 *
 * Keeps structured chat tabs on the same notification contract as autonomous
 * agents:
 * - Audio chime (playNudge: done / blocked / failed) when enabled
 * - Voice read-aloud TTS (speakText: "Agent finished its turn", "Agent needs your approval")
 * - Native desktop OS notification (showSystemNotification) when away / unfocused
 * - Tab unread dot (markStructuredChatUnread) when the pane is not active
 * - In-app Toast with "View chat" button when the user is in another pane/room
 */
import { get } from '$lib/stores/storeCompat';
import { activeSessionId, getAgentDisplayName, setActiveSession } from '$lib/stores/terminal';
import { announceAgentCompletions, speakAgentCompletions } from '$lib/stores/settings';
import { playNudge } from '$lib/services/nudge';
import { speakText } from '$lib/services/read-aloud';
import { showToast } from '$lib/stores/notification';
import { showSystemNotification, shouldUseSystemNotification } from '$lib/stores/zustand/notification';
import { markStructuredChatUnread, structuredChatPreset } from './panes';
import { recordForPane, subscribeStructuredEvents } from './session-store';
import type { StructuredEvent } from './event-journal';

let started = false;
let unsubscribe: (() => void) | null = null;

// Track approvals seen so we don't alert twice for the same request
const knownApprovals = new Set<string>();
// Track recent failures to avoid double-pinging when turn.interrupted + error fire together
const recentFailures = new Map<number, number>();

export function getStructuredPaneAgentName(paneId: number): string {
  const record = recordForPane(paneId);
  const preset = record?.preset ?? structuredChatPreset(paneId) ?? record?.provider ?? 'Agent';
  const display = typeof getAgentDisplayName === 'function' ? getAgentDisplayName(preset) : null;
  return display ?? preset;
}

export function handleStructuredNotificationEvent(paneId: number, event: StructuredEvent): void {
  const agentName = getStructuredPaneAgentName(paneId);
  const isSystemAway = typeof shouldUseSystemNotification === 'function' ? shouldUseSystemNotification() : false;
  const isActivePane = activeSessionId ? get(activeSessionId) === paneId : false;
  const isAway = isSystemAway || !isActivePane;

  const shouldAnnounce = announceAgentCompletions ? get(announceAgentCompletions) : false;
  const shouldSpeak = speakAgentCompletions ? get(speakAgentCompletions) : false;

  if (event.type === 'turn.completed') {
    if (shouldAnnounce && typeof playNudge === 'function') {
      playNudge('done');
    }
    if (shouldSpeak && typeof speakText === 'function') {
      speakText(`${agentName} finished its turn.`);
    }
    if (isAway) {
      if (typeof markStructuredChatUnread === 'function') {
        markStructuredChatUnread(paneId);
      }
      if (isSystemAway && typeof showSystemNotification === 'function') {
        showSystemNotification(`${agentName} finished its turn`, 'success');
      } else if (typeof showToast === 'function') {
        showToast(`${agentName} finished its turn.`, 'success', 5000, false, {
          label: 'View chat',
          onClick: () => {
            if (typeof setActiveSession === 'function') {
              setActiveSession(paneId);
            }
          },
        });
      }
    }
    return;
  }

  if (event.type === 'approval.requested') {
    const reqId = String(event.payload.requestId ?? '');
    if (reqId && knownApprovals.has(reqId)) return;
    if (reqId) knownApprovals.add(reqId);

    if (shouldAnnounce && typeof playNudge === 'function') {
      playNudge('blocked');
    }
    if (shouldSpeak && typeof speakText === 'function') {
      speakText(`${agentName} needs your approval.`);
    }
    if (isAway) {
      if (typeof markStructuredChatUnread === 'function') {
        markStructuredChatUnread(paneId);
      }
      const title = typeof event.payload.title === 'string' && event.payload.title
        ? event.payload.title
        : 'Permission requested';
      if (isSystemAway && typeof showSystemNotification === 'function') {
        showSystemNotification(`${agentName} needs your approval: ${title}`, 'warning');
      } else if (typeof showToast === 'function') {
        showToast(`${agentName} needs your approval: ${title}`, 'warning', 7000, false, {
          label: 'Review',
          onClick: () => {
            if (typeof setActiveSession === 'function') {
              setActiveSession(paneId);
            }
          },
        });
      }
    }
    return;
  }

  if (event.type === 'turn.interrupted' || event.type === 'error') {
    const now = Date.now();
    const last = recentFailures.get(paneId) ?? 0;
    if (now - last < 800) return;
    recentFailures.set(paneId, now);

    if (shouldAnnounce && typeof playNudge === 'function') {
      playNudge('failed');
    }
    if (shouldSpeak && typeof speakText === 'function') {
      speakText(`${agentName} could not finish.`);
    }
    if (isAway) {
      if (typeof markStructuredChatUnread === 'function') {
        markStructuredChatUnread(paneId);
      }
      const msg = typeof event.payload.message === 'string' && event.payload.message
        ? event.payload.message
        : 'Could not finish';
      if (isSystemAway && typeof showSystemNotification === 'function') {
        showSystemNotification(`${agentName} could not finish: ${msg}`, 'error');
      } else if (typeof showToast === 'function') {
        showToast(`${agentName} could not finish: ${msg}`, 'error', 7000, false, {
          label: 'View chat',
          onClick: () => {
            if (typeof setActiveSession === 'function') {
              setActiveSession(paneId);
            }
          },
        });
      }
    }
    return;
  }
}

export function startStructuredChatNotifications(): () => void {
  if (started) return unsubscribe ?? (() => {});
  started = true;
  unsubscribe = subscribeStructuredEvents(handleStructuredNotificationEvent);
  return unsubscribe;
}

export function resetStructuredChatNotificationsForTesting(): void {
  if (unsubscribe) {
    unsubscribe();
    unsubscribe = null;
  }
  started = false;
  knownApprovals.clear();
  recentFailures.clear();
}
