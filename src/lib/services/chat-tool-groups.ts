import type { ChatMessage } from '$lib/types/chat';

/**
 * Group consecutive tool/activity rows so a burst of tool calls reads as one
 * card instead of N separate lines — the shape T3 gives a run of tool calls.
 *
 * Consecutive `activity` messages join one group; anything else is its own
 * group, so transcript order never changes. A single activity row stays a
 * single-element group and can keep the plain row rendering.
 */
export function groupChatToolActivity(messages: ChatMessage[]): ChatMessage[][] {
  const groups: ChatMessage[][] = [];
  for (const message of messages) {
    const last = groups.at(-1);
    if (message.type === 'activity' && last?.[0]?.type === 'activity') {
      last.push(message);
    } else {
      groups.push([message]);
    }
  }
  return groups;
}

/** True while any call in the group is still in flight. */
export function toolGroupIsWorking(group: ChatMessage[]): boolean {
  return group.some((message) => message.pending === true);
}
