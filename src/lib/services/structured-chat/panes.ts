/**
 * Which panes are structured chats (Orca's "Codex Chat" tabs): a pane created
 * the ordinary way, so rooms, splits and closing all work unchanged, whose
 * body shows `StructuredChatView` in place of its terminal. The agent runs as
 * a protocol process (`codex-session.ts`); the pane's own shell sits unused.
 *
 * Not persisted yet: after an app restart the pane comes back as a plain shell.
 */
import { writable } from '$lib/stores/storeCompat';
import { useStore } from '$lib/react/useStore';
import { onSessionExit } from '$lib/stores/terminal';
import { closeStructuredChat } from './registry';
import type { TerminalChatItem } from '$lib/services/terminal-chat';

export type StructuredChatAgent = 'codex' | 'claude' | 'opencode' | 'grok' | 'cursor' | 'antigravity' | 'copilot' | 'kimi' | 'hermes' | 'omp' | 'pi';

export const structuredChatPanes = writable<Record<number, StructuredChatAgent>>({});
/** The CLI preset a pane continues in when it goes back to its terminal. */
const panePresets = new Map<number, string>();
/** The conversation before the chat took over (from the CLI's transcript). */
export const structuredChatHistory = writable<Record<number, TerminalChatItem[]>>({});

export function markStructuredChatPane(sessionId: number, agent: StructuredChatAgent, preset?: string): void {
  if (preset) panePresets.set(sessionId, preset);
  structuredChatPanes.update((panes) => ({ ...panes, [sessionId]: agent }));
}

export function structuredChatPreset(sessionId: number): string | null {
  return panePresets.get(sessionId) ?? null;
}

export function setStructuredChatHistory(sessionId: number, items: TerminalChatItem[]): void {
  structuredChatHistory.update((all) => ({ ...all, [sessionId]: items }));
}

export function useStructuredChatHistory(sessionId: number): TerminalChatItem[] {
  return useStore(structuredChatHistory)[sessionId] ?? EMPTY;
}
const EMPTY: TerminalChatItem[] = [];

export function forgetStructuredChatPane(sessionId: number): void {
  structuredChatHistory.update((all) => {
    if (!(sessionId in all)) return all;
    const next = { ...all };
    delete next[sessionId];
    return next;
  });
  structuredChatPanes.update((panes) => {
    if (!(sessionId in panes)) return panes;
    const next = { ...panes };
    delete next[sessionId];
    return next;
  });
}

export function useStructuredChatPane(sessionId: number): StructuredChatAgent | null {
  return useStore(structuredChatPanes)[sessionId] ?? null;
}

// Closing the pane ends its agent process too.
onSessionExit(({ sessionId }) => {
  const agent = getStructuredChatAgent(sessionId);
  forgetStructuredChatPane(sessionId);
  if (agent) void closeStructuredChat(agent, sessionId);
});

function getStructuredChatAgent(sessionId: number): StructuredChatAgent | null {
  let found: StructuredChatAgent | null = null;
  structuredChatPanes.subscribe((panes) => { found = panes[sessionId] ?? null; })();
  return found;
}

/** The agents a structured chat can run, by launch command. */
export function structuredChatAgentFor(command: string): StructuredChatAgent | null {
  const name = command.trim().split(/\s+/)[0]?.replace(/^.*[\\/]/, '').replace(/\.(cmd|exe)$/i, '').toLowerCase();
  if (name === 'codex' || name === 'claude' || name === 'pi' || name === 'grok' || name === 'agy' || name === 'opencode' || name === 'cursor-agent' || name === 'copilot' || name === 'kimi' || name === 'hermes' || name === 'omp') {
    return name === 'agy' ? 'antigravity' : name === 'cursor-agent' ? 'cursor' : name;
  }
  return null;
}


