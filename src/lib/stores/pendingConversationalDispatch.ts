import { get, writable } from '$lib/stores/storeCompat';
import type { RouteResult } from '$lib/services/orchestrator-brain';
import type { AiProviderId } from '$lib/stores/settings';
import type { ChatAccessMode, ChatReasoningEffort } from '$lib/types/chat';

/**
 * A conversational-mode spawn plan held until the user answers the Composer
 * placement prompt. Keyed by thread so two conversations cannot steal each
 * other's held actions.
 */
export interface PendingConversationalDispatch {
  threadId: string;
  projectId: string;
  rootPath: string;
  projectName?: string;
  /** Assistant message that carries the Composer inlineRequest. */
  requestMessageId: string;
  result: RouteResult;
  forcedAgent?: string;
  model?: string;
  orchestratorProvider?: AiProviderId;
  orchestratorModel?: string;
  accessMode?: ChatAccessMode;
  reasoningEffort?: ChatReasoningEffort;
  panelTaskId?: string;
  chatMode: boolean;
}

const pendingByThread = writable<Record<string, PendingConversationalDispatch>>({});

export function getPendingConversationalDispatch(threadId: string): PendingConversationalDispatch | null {
  return get(pendingByThread)[threadId] ?? null;
}

export function setPendingConversationalDispatch(pending: PendingConversationalDispatch): void {
  pendingByThread.update((all) => ({ ...all, [pending.threadId]: pending }));
}

export function clearPendingConversationalDispatch(threadId: string): PendingConversationalDispatch | null {
  const current = get(pendingByThread)[threadId] ?? null;
  if (!current) return null;
  pendingByThread.update((all) => {
    const next = { ...all };
    delete next[threadId];
    return next;
  });
  return current;
}

export function clearAllPendingConversationalDispatches(): void {
  pendingByThread.set({});
}

/** Test helper — wipe held plans between cases. */
export function resetPendingConversationalDispatchForTests(): void {
  pendingByThread.set({});
}
