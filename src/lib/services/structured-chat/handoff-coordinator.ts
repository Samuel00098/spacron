/**
 * Context handoff: move the work of one agent pane to another agent.
 *
 * The source pane is never touched (no interrupt, no close). A target is
 * started first, the bounded context is delivered to it, and only a confirmed
 * delivery is recorded as `delivered`. Any failure leaves the source usable and
 * is kept on the record so the picker can show it and offer a retry.
 *
 * Lifecycle: pending -> starting -> delivering -> delivered | failed.
 */
import { writable, get } from '$lib/stores/storeCompat';
import { useStore } from '$lib/react/useStore';
import { showToast } from '$lib/stores/notification';
import { activeProject } from '$lib/stores/workspace';
import {
  createTerminalSession,
  getAgentDisplayName,
  sessions,
  getSessionRoot,
  killSession,
  sendAgentPromptDirect,
  spawnAgentPreset,
  updateSessionTitle,
  waitForAgentReady,
} from '$lib/stores/terminal';
import { applyLaunchView, readTerminalTranscript, transcriptAgentFor, getBoundTranscript } from '$lib/services/terminal-chat';
import type { TerminalChatItem } from '$lib/services/terminal-chat';
import { readTerminalScreen } from '$lib/services/terminal-screen';
import { buildChatContextHandoff, type ChatHandoffExtras } from '$lib/services/chat-context-handoff';
import { markStructuredChatPane, structuredChatAgentFor, forgetStructuredChatPane } from './panes';
import { linkHandoffLineage } from './session-store';
import { closeStructuredChat, getStructuredChat, sendStructuredChat, structuredChatProvider } from './registry';
import { structuredAccessFor } from './defaults';

export type HandoffStatus = 'pending' | 'starting' | 'delivering' | 'delivered' | 'failed';
export type HandoffMode = 'chat' | 'terminal';

export interface HandoffRequest {
  sourceSessionId: number;
  sourceAgentName: string;
  sourcePreset: string | null;
  targetCommand: string;
  targetName: string;
  mode: HandoffMode;
}

export interface PaneHandoff {
  request: HandoffRequest;
  status: HandoffStatus;
  error: string | null;
  targetSessionId: number | null;
  startedAt: number;
  updatedAt: number;
}

const START_TIMEOUT_MS = 30_000;
const STORAGE_KEY = 'spacron_pane_handoffs';

function load(): Record<number, PaneHandoff> {
  try {
    const raw = typeof window !== 'undefined' ? window.localStorage.getItem(STORAGE_KEY) : null;
    if (!raw) return {};
    const parsed = JSON.parse(raw) as Record<number, PaneHandoff>;
    // A handoff that was mid-flight when the app closed did not finish.
    for (const record of Object.values(parsed)) {
      if (record.status !== 'delivered' && record.status !== 'failed') {
        record.status = 'failed';
        record.error = 'The app closed before the handoff finished.';
      }
    }
    return parsed;
  } catch {
    return {};
  }
}

const handoffs = writable<Record<number, PaneHandoff>>(load());

handoffs.subscribe((all) => {
  try {
    if (typeof window === 'undefined') return;
    const recent = Object.entries(all).sort((a, b) => b[1].updatedAt - a[1].updatedAt).slice(0, 20);
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(Object.fromEntries(recent)));
  } catch {
    // Restricted storage: the record lasts for this session only.
  }
});

function setRecord(sessionId: number, patch: Partial<PaneHandoff> & { request?: HandoffRequest }): void {
  handoffs.update((all) => {
    const prev = all[sessionId];
    if (!prev && !patch.request) return all;
    const next = { ...(prev ?? { error: null, targetSessionId: null, startedAt: Date.now(), status: 'pending' as const }), ...patch, updatedAt: Date.now() } as PaneHandoff;
    return { ...all, [sessionId]: next };
  });
}

export function usePaneHandoff(sessionId: number): PaneHandoff | null {
  return useStore(handoffs)[sessionId] ?? null;
}

export function getPaneHandoff(sessionId: number): PaneHandoff | null {
  return get(handoffs)[sessionId] ?? null;
}

export function isHandoffInProgress(sessionId: number): boolean {
  const status = getPaneHandoff(sessionId)?.status;
  return status === 'pending' || status === 'starting' || status === 'delivering';
}

/** Panes that asked (e.g. via `/handoff`) for their title-bar picker to open. */
const pickerRequests = writable<Record<number, number>>({});

export function requestHandoffPicker(sessionId: number): void {
  pickerRequests.update((all) => ({ ...all, [sessionId]: (all[sessionId] ?? 0) + 1 }));
}

/** Changes each time the pane's picker is requested; 0 when never. */
export function useHandoffPickerRequest(sessionId: number): number {
  return useStore(pickerRequests)[sessionId] ?? 0;
}

export function clearPaneHandoff(sessionId: number): void {
  handoffs.update((all) => {
    if (!(sessionId in all)) return all;
    const next = { ...all };
    delete next[sessionId];
    return next;
  });
}

// ---------------------------------------------------------------------------
// Reading the source conversation
// ---------------------------------------------------------------------------

interface SourceSnapshot {
  items: TerminalChatItem[];
  extras: ChatHandoffExtras;
  unfinishedTurn: boolean;
}

const EDIT_TOOL = /edit|write|patch|create|replace|multi/i;

function pathOf(item: TerminalChatItem): string | null {
  const data = item.toolData as Record<string, unknown> | null | undefined;
  for (const key of ['file_path', 'filePath', 'path', 'file']) {
    const value = data && typeof data === 'object' ? data[key] : null;
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  return null;
}

function summariseItems(items: TerminalChatItem[]): Pick<ChatHandoffExtras, 'toolSummary' | 'filesTouched'> {
  const tools = items.filter((item) => item.kind === 'tool');
  const files = new Set<string>();
  for (const tool of tools) {
    if (!tool.toolName || !EDIT_TOOL.test(tool.toolName)) continue;
    const path = pathOf(tool);
    if (path) files.add(path);
  }
  const toolSummary = tools.slice(-10).map((tool) => {
    const first = tool.text.split('\n')[0]?.trim() ?? '';
    return `${tool.toolName ?? 'tool'}${first ? `: ${first}` : ''}${tool.toolStatus === 'error' ? ' (failed)' : ''}`;
  });
  return { toolSummary, filesTouched: [...files].slice(-15) };
}

async function readSource(request: HandoffRequest): Promise<SourceSnapshot> {
  const { sourceSessionId: id, sourcePreset } = request;
  const info = get(sessions).find((session) => session.id === id);
  const cwd = getSessionRoot(id);
  const project = get(activeProject);
  const base: ChatHandoffExtras = { cwd, project: project?.name ?? null };

  const structuredAgent = sourcePreset ? structuredChatAgentFor(sourcePreset) : null;
  const live = structuredAgent ? getStructuredChat(structuredAgent, id) : null;
  if (live) {
    return {
      items: live.items,
      unfinishedTurn: live.status === 'working',
      extras: { ...base, model: live.model, effort: live.effort, access: live.access, ...summariseItems(live.items) },
    };
  }

  let items: TerminalChatItem[] = [];
  const transcriptAgent = transcriptAgentFor(sourcePreset ?? info?.agentPreset);
  if (transcriptAgent && cwd) {
    try {
      const transcript = await readTerminalTranscript({
        sessionId: id,
        agent: transcriptAgent,
        cwd,
        sinceMs: 0,
        boundSessionId: getBoundTranscript(id),
        knownRevision: null,
      });
      items = transcript.messages;
      return {
        items,
        unfinishedTurn: transcript.busy === true,
        extras: { ...base, model: transcript.model, effort: transcript.effort, access: transcript.permission, ...summariseItems(items) },
      };
    } catch {
      // Fall through to the visible screen.
    }
  }
  const screen = readTerminalScreen(id, { maxLines: 200 })?.trim();
  if (screen) items = [{ id: 'screen', kind: 'assistant', text: `Terminal screen at the time of handoff:\n${screen}` }];
  return { items, unfinishedTurn: Boolean(info?.isExecuting), extras: base };
}

function toHandoffMessages(items: TerminalChatItem[]) {
  return items
    .filter((item) => item.kind !== 'reasoning')
    .map((item) => {
      const role = item.kind === 'user' || item.kind === 'command' ? 'user' : 'assistant';
      const text = item.kind === 'tool'
        ? `${item.toolName ? `${item.toolName}: ` : ''}${item.text}${item.toolOutput ? `\nTool output:\n${item.toolOutput.slice(0, 1500)}` : ''}`
        : item.text;
      const images = item.images?.length ? `\n[${item.images.length} image attachment${item.images.length === 1 ? '' : 's'}]` : '';
      return { id: item.id, role, text: `${text}${images}` };
    });
}

function latestUserRequest(items: TerminalChatItem[]): string | null {
  for (let index = items.length - 1; index >= 0; index -= 1) {
    if (items[index].kind === 'user' && items[index].text.trim()) return items[index].text.trim();
  }
  return null;
}

/** Build the bounded handoff prompt for a request. Exported for tests. */
/**
 * The source as the receiving agent should read it. A pane's name is often a
 * nickname ("Zee"), which says nothing about which agent it was, so the
 * agent's own name is added (seen live: "Previous agent: Zee").
 */
function sourceLabel(request: HandoffRequest): string {
  const name = request.sourceAgentName.trim();
  const kind = request.sourcePreset ? getAgentDisplayName(request.sourcePreset) ?? request.sourcePreset : null;
  return kind && kind.toLowerCase() !== name.toLowerCase() ? `${name} (${kind})` : name;
}

export function buildHandoffPrompt(request: HandoffRequest, source: SourceSnapshot): string {
  const latest = latestUserRequest(source.items);
  const extras: ChatHandoffExtras = {
    ...source.extras,
    unfinished: [
      ...(source.unfinishedTurn ? ['The previous agent was still working on a turn when this handoff started; it may have left changes half applied.'] : []),
      ...(latest ? [`Latest user request: ${latest.slice(0, 400)}`] : []),
    ],
  };
  return buildChatContextHandoff(
    toHandoffMessages(source.items),
    sourceLabel(request),
    request.targetName,
    'Continue the current task from the latest state in this workspace. Inspect the repository before changing anything, and do not redo work that is already finished.',
    extras,
  ).prompt;
}

// ---------------------------------------------------------------------------
// Delivery
// ---------------------------------------------------------------------------

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

class HandoffError extends Error {}

async function deliverToStructuredChat(request: HandoffRequest, prompt: string, cwd: string): Promise<number> {
  const agent = structuredChatAgentFor(request.targetCommand);
  const provider = agent ? structuredChatProvider(agent) : null;
  if (!agent || !provider) throw new HandoffError(`${request.targetName} has no structured chat.`);
  const project = get(activeProject);
  const id = await createTerminalSession(cwd, undefined, project?.id, {
    assignPane: false,
    agentPreset: request.targetCommand,
  });
  if (id === null) throw new HandoffError(`Couldn't open a pane for ${request.targetName}.`);
  setRecord(request.sourceSessionId, { targetSessionId: id });
  const cleanup = async () => {
    await closeStructuredChat(agent, id).catch(() => {});
    forgetStructuredChatPane(id);
    await killSession(id).catch(() => {});
  };
  try {
    markStructuredChatPane(id, agent, request.targetCommand);
    updateSessionTitle(id, `${provider.label} Chat`);
    await provider.start(id, cwd, { access: structuredAccessFor(request.targetCommand) });
    const startedAt = Date.now();
    for (;;) {
      const state = provider.get(id);
      if (state?.status === 'ready') break;
      if (!state || state.status === 'failed' || state.status === 'closed') {
        throw new HandoffError(state?.error || `${request.targetName} could not start.`);
      }
      if (Date.now() - startedAt > START_TIMEOUT_MS) throw new HandoffError(`${request.targetName} did not become ready in time.`);
      await sleep(250);
    }
    const sending = sendStructuredChat(agent, id, prompt);
    setRecord(request.sourceSessionId, { status: 'delivering' });
    await sending;
    const after = provider.get(id);
    if (!after || after.error || after.status === 'failed' || after.status === 'closed') {
      throw new HandoffError(after?.error || `${request.targetName} rejected the handoff.`);
    }
    return id;
  } catch (error) {
    await cleanup();
    throw error;
  }
}

async function deliverToTerminal(request: HandoffRequest, prompt: string, cwd: string): Promise<number> {
  const id = await spawnAgentPreset(request.targetCommand, cwd, { activate: true });
  if (id === null) throw new HandoffError(`Couldn't start ${request.targetName}.`);
  setRecord(request.sourceSessionId, { targetSessionId: id });
  try {
    applyLaunchView(id, request.targetCommand, 'terminal');
    const readiness = await waitForAgentReady(id);
    if (readiness !== 'ready') throw new HandoffError(`${request.targetName} did not start. Check that it is installed and signed in.`);
    setRecord(request.sourceSessionId, { status: 'delivering' });
    const sent = await sendAgentPromptDirect(id, prompt);
    if (!sent) throw new HandoffError(`${request.targetName} opened, but did not accept the handoff prompt.`);
    return id;
  } catch (error) {
    await killSession(id).catch(() => {});
    throw error;
  }
}

/** Run a handoff. Resolves true only when the target accepted the context. */
export async function initiateHandoff(request: HandoffRequest): Promise<boolean> {
  const id = request.sourceSessionId;
  if (isHandoffInProgress(id)) return false;
  handoffs.update((all) => ({
    ...all,
    [id]: { request, status: 'pending', error: null, targetSessionId: null, startedAt: Date.now(), updatedAt: Date.now() },
  }));
  try {
    const cwd = getSessionRoot(id) ?? get(activeProject)?.root_path ?? '.';
    const source = await readSource(request);
    const prompt = buildHandoffPrompt(request, source);
    setRecord(id, { status: 'starting' });
    const mode: HandoffMode = request.mode === 'chat' && structuredChatAgentFor(request.targetCommand) ? 'chat' : 'terminal';
    const targetId = mode === 'chat'
      ? await deliverToStructuredChat(request, prompt, cwd)
      : await deliverToTerminal(request, prompt, cwd);
    setRecord(id, { status: 'delivered', targetSessionId: targetId, error: null });
    linkHandoffLineage(id, request.sourceAgentName, targetId);
    showToast(`Conversation handed off to ${request.targetName}.`, 'info', 5000);
    return true;
  } catch (error) {
    const message = error instanceof Error ? error.message : `Couldn't hand off to ${request.targetName}.`;
    setRecord(id, { status: 'failed', error: message, targetSessionId: null });
    showToast(message, 'error', 7000);
    return false;
  }
}

/** Retry the last failed handoff for a pane. */
export async function retryHandoff(sessionId: number): Promise<boolean> {
  const record = getPaneHandoff(sessionId);
  if (!record || record.status !== 'failed') return false;
  return initiateHandoff(record.request);
}

// ---------------------------------------------------------------------------
// Handing over a past session (Agent History)
// ---------------------------------------------------------------------------

/** A history row has no pane; this id never matches one, so no pane record is touched. */
const HISTORY_SOURCE_ID = -1;

export interface HistoryHandoffSource {
  /** The source agent's launch command (`claude`, `codex`, `opencode`). */
  command: string;
  agentName: string;
  /** The CLI's own session id. */
  sessionId: string;
  cwd: string;
  /** The managed account that owns the session; omitted or null = the CLI's own home. */
  account?: string | null;
}

export interface HistoryHandoffSnapshot {
  items: TerminalChatItem[];
  model: string | null;
  effort: string | null;
  access: string | null;
}

/** Read a past session back from its CLI's transcript, by id. */
export async function readHistoryHandoffSource(source: HistoryHandoffSource): Promise<HistoryHandoffSnapshot> {
  const transcriptAgent = transcriptAgentFor(source.command);
  if (!transcriptAgent) throw new HandoffError(`${source.agentName} sessions cannot be read back yet.`);
  const transcript = await readTerminalTranscript({
    sessionId: HISTORY_SOURCE_ID,
    agent: transcriptAgent,
    cwd: source.cwd,
    sinceMs: 0,
    boundSessionId: source.sessionId,
    knownRevision: null,
    account: source.account ?? null,
  });
  if (!transcript.messages.length) {
    throw new HandoffError("Couldn't read that session's conversation. It may be open in a pane right now.");
  }
  return {
    items: transcript.messages,
    model: transcript.model ?? null,
    effort: transcript.effort ?? null,
    access: transcript.permission ?? null,
  };
}

function historyRequest(source: HistoryHandoffSource, target: { command: string; name: string }, mode: HandoffMode): HandoffRequest {
  return {
    sourceSessionId: HISTORY_SOURCE_ID,
    sourceAgentName: source.agentName,
    sourcePreset: source.command,
    targetCommand: target.command,
    targetName: target.name,
    mode,
  };
}

/** The context the receiving agent is given, exactly as it will be sent. */
export function buildHistoryHandoffPrompt(
  source: HistoryHandoffSource,
  snapshot: HistoryHandoffSnapshot,
  target: { command: string; name: string },
  mode: HandoffMode = 'chat',
): string {
  return buildHandoffPrompt(historyRequest(source, target, mode), {
    items: snapshot.items,
    unfinishedTurn: false,
    extras: {
      cwd: source.cwd,
      project: get(activeProject)?.name ?? null,
      model: snapshot.model,
      effort: snapshot.effort,
      access: snapshot.access,
      ...summariseItems(snapshot.items),
    },
  });
}

/**
 * Hand a past session to another agent. `prompt` is the context to send, as
 * previewed (and possibly edited) by the person; without it the context is read
 * and built here. Resolves true only when the target accepted it.
 */
export async function handOffFromHistory(
  source: HistoryHandoffSource,
  target: { command: string; name: string },
  mode: HandoffMode,
  prompt?: string,
): Promise<boolean> {
  try {
    const text = prompt?.trim()
      ? prompt
      : buildHistoryHandoffPrompt(source, await readHistoryHandoffSource(source), target, mode);
    const request = historyRequest(source, target, mode);
    const effective: HandoffMode = mode === 'chat' && structuredChatAgentFor(target.command) ? 'chat' : 'terminal';
    if (effective === 'chat') await deliverToStructuredChat(request, text, source.cwd);
    else await deliverToTerminal(request, text, source.cwd);
    showToast(`Session handed over to ${target.name}.`, 'info', 5000);
    return true;
  } catch (error) {
    showToast(error instanceof Error ? error.message : `Couldn't hand over to ${target.name}.`, 'error', 7000);
    return false;
  }
}
