/**
 * Terminal ⇄ Chat view for agent panes, after Orca's design
 * (`.spacron/memory/orca-chat-view.md`).
 *
 * The chat is just another way of looking at the agent's terminal. The CLI
 * keeps running in its PTY and stays the only owner of the conversation:
 * - reading: the backend parses the transcript the CLI writes itself
 *   (`agent_transcript_read`), found from the pane's directory and launch time;
 * - writing: prompts go into the same PTY through `sendAgentPromptDirect`,
 *   which is how every other Spacron surface types into an agent TUI.
 * Nothing here starts a process, so flipping views can never fork the session.
 */

import { invoke } from '@tauri-apps/api/core';
import { useStore } from '$lib/react/useStore';
import { get, writable } from '$lib/stores/storeCompat';
import { remoteTarget } from '$lib/stores/remoteWorkspace';
import { activeSessionId, sessions } from '$lib/stores/terminal';

/** Agent presets whose transcripts the chat view can read, mapped to their reader. */
const TRANSCRIPT_AGENTS: Record<string, TranscriptAgent> = {
  claude: 'claude',
  codex: 'codex',
  opencode: 'opencode',
  grok: 'grok',
};

export type TranscriptAgent = 'claude' | 'codex' | 'opencode' | 'grok';

export function transcriptAgentFor(preset: string | null | undefined): TranscriptAgent | null {
  if (!preset) return null;
  return TRANSCRIPT_AGENTS[preset] ?? null;
}

/**
 * Whether this pane can switch to chat. Transcripts are read from this
 * machine's disk, so a remote workspace (agent on the box) stays terminal-only.
 */
export function canShowTerminalChat(preset: string | null | undefined): boolean {
  return transcriptAgentFor(preset) != null && get(remoteTarget) == null;
}

export interface TerminalChatItem {
  id: string;
  kind: 'user' | 'assistant' | 'reasoning' | 'tool' | 'notice';
  text: string;
  toolName?: string | null;
  toolInput?: string | null;
  toolOutput?: string | null;
  toolStatus?: 'running' | 'done' | 'error' | null;
  time?: string | null;
}

export interface TranscriptResult {
  sessionId: string | null;
  revision: string | null;
  unchanged: boolean;
  messages: TerminalChatItem[];
  busy: boolean | null;
  truncated: boolean;
}

const chatViewSessions = writable<ReadonlySet<number>>(new Set());

export function isTerminalChatView(sessionId: number): boolean {
  return get(chatViewSessions).has(sessionId);
}

export function setTerminalChatView(sessionId: number, on: boolean): void {
  const current = get(chatViewSessions);
  if (current.has(sessionId) === on) return;
  const next = new Set(current);
  if (on) next.add(sessionId);
  else next.delete(sessionId);
  chatViewSessions.set(next);
  if (!on) boundTranscripts.delete(sessionId);
}

export function toggleTerminalChatView(sessionId: number): void {
  setTerminalChatView(sessionId, !isTerminalChatView(sessionId));
}

/**
 * Flip the focused agent pane between Terminal and Chat (the shortcut that used
 * to switch the whole window between Code and Chat mode). False when the focused
 * pane is not an agent the chat view can read.
 */
export function toggleActiveTerminalChatView(): boolean {
  const id = get(activeSessionId);
  if (id == null) return false;
  const session = get(sessions).find((s) => s.id === id);
  if (!canShowTerminalChat(session?.agentPreset)) return false;
  toggleTerminalChatView(id);
  return true;
}

export function useTerminalChatView(sessionId: number): boolean {
  return useStore(chatViewSessions).has(sessionId);
}

/**
 * Provider session each pane's chat view is showing. Other panes exclude these
 * so two agents started in the same folder never show each other's transcript.
 */
const boundTranscripts = new Map<number, string>();

export function bindTranscript(sessionId: number, providerSessionId: string | null): void {
  if (providerSessionId) boundTranscripts.set(sessionId, providerSessionId);
  else boundTranscripts.delete(sessionId);
}

export function forgetTerminalChat(sessionId: number): void {
  boundTranscripts.delete(sessionId);
  setTerminalChatView(sessionId, false);
}

export async function readTerminalTranscript(args: {
  sessionId: number;
  agent: TranscriptAgent;
  cwd: string;
  sinceMs: number;
  boundSessionId: string | null;
  knownRevision: string | null;
}): Promise<TranscriptResult> {
  const exclude = [...boundTranscripts.entries()]
    .filter(([pane]) => pane !== args.sessionId)
    .map(([, provider]) => provider);
  return invoke<TranscriptResult>('agent_transcript_read', {
    query: {
      agent: args.agent,
      cwd: args.cwd,
      sinceMs: args.sinceMs,
      sessionId: args.boundSessionId,
      exclude,
      knownRevision: args.knownRevision,
    },
  });
}

/** Normalise text the way both a pending send and its transcript row can be compared. */
export function sendMatchKey(text: string): string {
  return text.replace(/\s+/g, ' ').trim().slice(0, 200);
}
