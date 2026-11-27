/**
 * Structured Codex chat: the user's Codex driven over its app-server protocol
 * (JSON-RPC on stdio), with no terminal. Orca's "Codex Chat" tabs work this
 * way (`src/main/codex/structured/`): the model and reasoning level ride on
 * every `turn/start`, so any model `model/list` reports can be picked, at any
 * level it supports, at any time between turns. A terminal-backed chat can
 * only type `/model` into Codex's own picker.
 *
 * Protocol checked against Codex 0.171 (`codex app-server generate-ts`, and a
 * live `initialize` â†’ `model/list` â†’ `thread/start` â†’ `turn/start` run on
 * 2026-11-20). The process goes through the generic stdio bridge
 * (`acp_start` / `acp_request`, `src-tauri/src/acp.rs`), started from Codex's
 * native binary (`codex_app_server_launch`), never the npm shim.
 *
 * State is kept per pane in this module, not in the view: the view unmounts
 * when its room is hidden, and the conversation must be there on return.
 */
import { parseCodexQuestions, codexAnswers, type CodexQuestion } from './codex-questions';
import { invoke } from '@tauri-apps/api/core';
import type { UnlistenFn } from '@tauri-apps/api/event';
import { openAcpSession, stderrTail, type AcpNotification, type AcpServerRequest, type AcpSession } from '$lib/services/acp-transport';
import { accountEnvFor } from '$lib/stores/agentAccounts';
import type { TerminalChatItem } from '$lib/services/terminal-chat';
import type { StructuredChatProvider, StructuredSubagentSession } from './provider';
import { imageDataUrlsFor } from './attachments';
import { prepareStructuredVisuals } from './visuals';
import { aboutYouEnv } from '$lib/stores/aboutYou';

export type StructuredAccess = 'ask' | 'auto' | 'full-access';

export interface StructuredModel {
  id: string;
  label: string;
  description: string | null;
  efforts: string[];
  defaultEffort: string | null;
  isDefault: boolean;
  supportsFast?: boolean;
}

/** One answer an agent offered on its own permission/question request. */
export interface StructuredApprovalOption {
  /** The agent's own option id, sent back verbatim. */
  id: string;
  label: string;
  /** ACP spec kind: allow_once, allow_always, reject_once, reject_always. */
  kind: string | null;
}

export interface StructuredApproval {
  requestId: string | number;
  kind: 'command' | 'fileChange' | 'other';
  title: string;
  detail: string | null;
  /**
   * The answers the agent offered. ACP agents send their own list; Codex and
   * Claude do not, and the view then shows the three access answers instead.
   */
  options?: StructuredApprovalOption[];
}

export interface StructuredChatState {
  status: 'starting' | 'ready' | 'working' | 'failed' | 'closed';
  error: string | null;
  items: TerminalChatItem[];
  models: StructuredModel[];
  model: string | null;
  effort: string | null;
  /** Fast mode. Undefined until known: the CLI's own setting then applies. */
  fast?: boolean;
  /** Claude Code's ultracode. (Codex's Ultra is an effort level.) */
  ultracode?: boolean;
  /** The agent's own session mode when it advertises one (`plan`, `agent`…). */
  mode?: string | null;
  access: StructuredAccess;
  threadId: string | null;
  approvals: StructuredApproval[];
  subagents: StructuredSubagentSession[];
  pendingQueue?: string[];
  restoredMode?: 'native' | 'journal-only' | 'fresh' | null;
  contextUsed: number | null;
  contextWindow: number | null;
  /** Per-category tokens, only where the agent reports them (Claude's `get_context_usage`). */
  contextBreakdown?: { name: string; tokens: number }[] | null;
}

interface Runtime {
  session: AcpSession | null;
  unlisten: UnlistenFn[];
  turnId: string | null;
  cwd: string;
}

const states = new Map<number, StructuredChatState>();
const runtimes = new Map<number, Runtime>();
const listeners = new Set<() => void>();

function emit() {
  for (const listener of listeners) listener();
}

export function subscribeStructuredChats(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

export function getStructuredChat(sessionId: number): StructuredChatState | null {
  return states.get(sessionId) ?? null;
}

function update(sessionId: number, patch: Partial<StructuredChatState> | ((s: StructuredChatState) => Partial<StructuredChatState>)) {
  const prev = states.get(sessionId);
  if (!prev) return;
  const next = { ...prev, ...(typeof patch === 'function' ? patch(prev) : patch) };
  states.set(sessionId, next);
  emit();
}

function upsertItem(sessionId: number, item: TerminalChatItem) {
  update(sessionId, (s) => {
    const at = s.items.findIndex((i) => i.id === item.id);
    if (at < 0) return { items: [...s.items, { ...item, time: item.time ?? new Date().toISOString() }] };
    const items = s.items.slice();
    items[at] = { ...items[at], ...item };
    return { items };
  });
}

function appendText(sessionId: number, itemId: string, kind: TerminalChatItem['kind'], delta: string) {
  update(sessionId, (s) => {
    const at = s.items.findIndex((i) => i.id === itemId);
    if (at < 0) return { items: [...s.items, { id: itemId, kind, text: delta, time: new Date().toISOString() }] };
    const items = s.items.slice();
    items[at] = { ...items[at], text: items[at].text + delta };
    return { items };
  });
}

// â”€â”€ Thread items â†’ chat items â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

type Json = Record<string, unknown>;
const str = (v: unknown): string | null => (typeof v === 'string' ? v : null);
const rec = (v: unknown): Json | null => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Json) : null);

/** A Codex file change as the apply_patch text the chat's diff renderer reads. */
export function patchText(changes: unknown): string {
  const out = ['*** Begin Patch'];
  for (const raw of Array.isArray(changes) ? changes : []) {
    const change = rec(raw);
    const path = str(change?.path);
    if (!change || !path) continue;
    const kind = str(rec(change.kind)?.type) ?? 'update';
    const diff = str(change.diff) ?? '';
    if (kind === 'delete') {
      out.push(`*** Delete File: ${path}`);
    } else if (kind === 'add') {
      out.push(`*** Add File: ${path}`);
      for (const line of diff.replace(/\n$/, '').split('\n')) out.push(line.startsWith('+') ? line : `+${line}`);
    } else {
      out.push(`*** Update File: ${path}`);
      for (const line of diff.replace(/\n$/, '').split('\n')) {
        if (line.startsWith('---') || line.startsWith('+++') || line.startsWith('diff ') || line.startsWith('index ')) continue;
        out.push(line);
      }
    }
  }
  out.push('*** End Patch');
  return out.join('\n');
}

/** One Codex `ThreadItem` as the chat's item, or null for ones it doesn't show. */
export function chatItemFor(item: Json): TerminalChatItem | null {
  const id = str(item.id);
  if (!id) return null;
  switch (item.type) {
    case 'userMessage': {
      const parts = Array.isArray(item.content) ? item.content : [];
      const text = parts.map((p) => str(rec(p)?.text) ?? '').filter(Boolean).join('\n');
      const images = parts.flatMap((part) => {
        const input = rec(part);
        const source = input?.type === 'localImage' ? str(input.path)
          : input?.type === 'image' ? str(input.url) : null;
        return source ? [source] : [];
      });
      return { id, kind: 'user', text, ...(images.length ? { images } : {}) };
    }
    case 'agentMessage':
      return { id, kind: 'assistant', text: str(item.text) ?? '' };
    case 'reasoning': {
      const summary = Array.isArray(item.summary) ? item.summary.filter((s): s is string => typeof s === 'string') : [];
      return { id, kind: 'reasoning', text: summary.join('\n\n') };
    }
    case 'plan':
      return { id, kind: 'assistant', text: str(item.text) ?? '' };
    case 'commandExecution': {
      const status = str(item.status);
      const exit = typeof item.exitCode === 'number' ? item.exitCode : null;
      return {
        id,
        kind: 'tool',
        text: '',
        toolName: 'shell',
        toolInput: str(item.command) ?? '',
        toolOutput: str(item.aggregatedOutput),
        toolStatus: status === 'inProgress' ? 'running' : status === 'failed' || status === 'declined' || (exit != null && exit !== 0) ? 'error' : 'done',
      };
    }
    case 'fileChange': {
      const status = str(item.status);
      const patch = patchText(item.changes);
      return {
        id,
        kind: 'tool',
        text: '',
        toolName: 'apply_patch',
        toolInput: patch,
        toolStatus: status === 'inProgress' ? 'running' : status === 'completed' ? 'done' : status === 'failed' || status === 'declined' ? 'error' : 'done',
      };
    }
    case 'mcpToolCall': {
      const status = str(item.status);
      return {
        id,
        kind: 'tool',
        text: '',
        toolName: `mcp__${str(item.server) ?? 'server'}__${str(item.tool) ?? 'tool'}`,
        toolInput: JSON.stringify(item.arguments ?? {}),
        toolStatus: status === 'inProgress' ? 'running' : status === 'failed' ? 'error' : 'done',
      };
    }
    case 'webSearch':
      return { id, kind: 'tool', text: '', toolName: 'web_search', toolInput: str(item.query) ?? '', toolStatus: 'done' };
    case 'contextCompaction':
      return { id, kind: 'notice', text: 'Conversation compacted' };
    default:
      return null;
  }
}

// â”€â”€ Access â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

/** The approval policy and sandbox each access level runs a turn under. */
export function accessPolicy(access: StructuredAccess, cwd: string): { approvalPolicy: string; sandboxPolicy: Json } {
  if (access === 'full-access') return { approvalPolicy: 'never', sandboxPolicy: { type: 'dangerFullAccess' } };
  const workspace = { type: 'workspaceWrite', writableRoots: [cwd], networkAccess: true, excludeTmpdirEnvVar: false, excludeSlashTmp: false };
  // `auto`: works inside the workspace sandbox without stopping to ask.
  return { approvalPolicy: access === 'auto' ? 'never' : 'on-request', sandboxPolicy: workspace };
}

// â”€â”€ Lifecycle â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

/** Start (or reuse) the Codex app server behind a structured chat pane. */
export async function startCodexChat(sessionId: number, cwd: string, opts: { access?: StructuredAccess; resumeId?: string | null; model?: string | null; effort?: string | null; accountId?: string | null } = {}): Promise<void> {
  const existing = states.get(sessionId);
  if (existing && existing.status !== 'failed' && existing.status !== 'closed') return;
  states.set(sessionId, {
    status: 'starting',
    error: null,
    items: existing?.items ?? [],
    models: existing?.models ?? [],
    model: opts.model ?? existing?.model ?? null,
    effort: opts.effort ?? existing?.effort ?? null,
    fast: existing?.fast,
    access: opts.access ?? existing?.access ?? 'ask',
    threadId: null,
    approvals: [],
    subagents: existing?.subagents ?? [],
    pendingQueue: [],
    restoredMode: existing?.restoredMode ?? (opts.resumeId ? 'native' : 'fresh'),
    contextUsed: null,
    contextWindow: null,
  });
  emit();
  const runtime: Runtime = { session: null, unlisten: [], turnId: null, cwd };
  runtimes.set(sessionId, runtime);
  try {
    // On a remote the app server runs on the box, found on its own PATH.
    const { remoteTarget } = await import('$lib/stores/remoteWorkspace');
    const { get: readStore } = await import('$lib/stores/storeCompat');
    const launch = readStore(remoteTarget)
      ? { command: 'codex', args: ['app-server'], env: {} as Record<string, string> }
      : await invoke<{ command: string; args: string[]; env: Record<string, string> }>('codex_app_server_launch');
    const accountEnv = await accountEnvFor('codex', opts.accountId ?? null);
    const session = await openAcpSession(launch.command, launch.args, cwd, { ...launch.env, ...accountEnv, ...await prepareStructuredVisuals(sessionId), ...aboutYouEnv() });
    runtime.session = session;
    const tail = stderrTail(session);
    runtime.unlisten.push(
      await session.onNotification((n) => onNotification(sessionId, n)),
      await session.onRequest((r) => onServerRequest(sessionId, r)),
      await session.onExit(() => {
        if (runtimes.get(sessionId) !== runtime) return;
        const reason = tail.text();
        update(sessionId, (s) => (s.status === 'closed' ? {} : { status: 'failed', error: reason ? `Codex stopped: ${reason}` : s.error ?? 'Codex stopped.' }));
      }),
    );
    void tail.dispose.then((off) => runtime.unlisten.push(off));
    await session.request('initialize', { clientInfo: { name: 'spacron', title: 'Spacron', version: '5.1.4' } });
    await session.notify('initialized', {});
    const listed = await session.request<{ data?: Json[] }>('model/list', { limit: 100, includeHidden: false });
    const models = (listed.data ?? []).map(toModel).filter((m): m is StructuredModel => m != null);
    const chosen = states.get(sessionId)?.model;
    const fallback = models.find((m) => m.isDefault) ?? models[0] ?? null;
    // An explicit launch selection should reach Codex even when its visible
    // catalogue is incomplete. The thread request can report a rejected model.
    const model = opts.model ?? (chosen && models.some((m) => m.id === chosen) ? chosen : fallback?.id ?? null);
    const current = models.find((m) => m.id === model);
    const requestedEffort = states.get(sessionId)?.effort ?? null;
    const effort = opts.effort
      ?? (requestedEffort && current?.efforts.includes(requestedEffort) ? requestedEffort : current?.defaultEffort ?? null);
    const { approvalPolicy, sandboxPolicy } = accessPolicy(states.get(sessionId)!.access, cwd);
    // A conversation that ran in the terminal resumes by its thread id.
    const started = await session.request<{ thread?: Json; serviceTier?: string | null }>(opts.resumeId ? 'thread/resume' : 'thread/start', {
      ...(opts.resumeId ? { threadId: opts.resumeId } : {}),
      cwd,
      ...(model ? { model } : {}),
      approvalPolicy,
      sandbox: sandboxPolicy.type === 'dangerFullAccess' ? 'danger-full-access' : 'workspace-write',
    });
    const threadId = str(started.thread?.id);
    if (!threadId) throw new Error('Codex did not start a conversation.');
    // A pick made here wins; otherwise show the tier Codex started on.
    const fast = states.get(sessionId)?.fast ?? (started.serviceTier === 'priority' || started.serviceTier === 'fast' ? true : undefined);
    update(sessionId, { status: 'ready', models, model, effort, fast, threadId });
  } catch (error) {
    update(sessionId, { status: 'failed', error: error instanceof Error ? error.message : String(error) });
  }
}

function toModel(raw: Json): StructuredModel | null {
  const id = str(raw.id) ?? str(raw.model);
  if (!id) return null;
  const efforts = (Array.isArray(raw.supportedReasoningEfforts) ? raw.supportedReasoningEfforts : [])
    .map((e) => str(rec(e)?.reasoningEffort))
    .filter((e): e is string => !!e);
  return {
    id,
    label: str(raw.displayName) ?? id,
    description: str(raw.description),
    efforts,
    defaultEffort: str(raw.defaultReasoningEffort),
    isDefault: raw.isDefault === true,
    supportsFast: Array.isArray(raw.serviceTiers) && raw.serviceTiers.some((tier) => str(rec(tier)?.id) === 'priority'),
  };
}

/** Send a message as a new turn, with the model and level picked now. */
export async function sendCodexTurn(sessionId: number, text: string, images: string[] = []): Promise<void> {
  const state = states.get(sessionId);
  const runtime = runtimes.get(sessionId);
  if (!state || !runtime?.session || !state.threadId) return;
  const input: Json[] = [];
  if (text.trim()) input.push({ type: 'text', text, text_elements: [] });
  for (const path of images) input.push({ type: 'localImage', path });
  if (!input.length) return;
  const { approvalPolicy, sandboxPolicy } = accessPolicy(state.access, runtime.cwd);
  update(sessionId, { status: 'working', error: null });
  try {
    const reply = await runtime.session.request<{ turn?: Json }>('turn/start', {
      threadId: state.threadId,
      input,
      ...(state.model ? { model: state.model } : {}),
      ...(state.effort ? { effort: state.effort } : {}),
      // "default" is standard speed; leaving it out keeps the thread's tier.
      ...(state.fast === undefined ? {} : { serviceTier: state.fast ? 'priority' : 'default' }),
      approvalPolicy,
      sandboxPolicy,
    });
    runtime.turnId = str(reply.turn?.id);
  } catch (error) {
    update(sessionId, { status: 'ready', error: error instanceof Error ? error.message : String(error) });
  }
}

export async function interruptCodexTurn(sessionId: number): Promise<void> {
  const state = states.get(sessionId);
  const runtime = runtimes.get(sessionId);
  if (!state?.threadId || !runtime?.session || !runtime.turnId) return;
  try {
    await runtime.session.request('turn/interrupt', { threadId: state.threadId, turnId: runtime.turnId });
  } catch {
    // The turn may have just ended.
  }
}

export function setStructuredModel(sessionId: number, model: string): void {
  update(sessionId, (s) => {
    const next = s.models.find((m) => m.id === model);
    // Keep the level when the new model has it; otherwise its own default.
    const effort = next && s.effort && next.efforts.includes(s.effort) ? s.effort : next?.defaultEffort ?? null;
    // A model without a fast tier goes back to standard speed.
    return { model, effort, ...(s.fast && next && !next.supportsFast ? { fast: false } : {}) };
  });
}

export function setStructuredEffort(sessionId: number, effort: string): void {
  update(sessionId, { effort });
}

export function setStructuredFast(sessionId: number, fast: boolean): void {
  update(sessionId, { fast });
}

export function setStructuredAccess(sessionId: number, access: StructuredAccess): void {
  update(sessionId, { access });
}

const pendingQuestions = new Map<string, { questions: CodexQuestion[]; index: number; answers: Record<string, string> }>();
const questionKey = (sessionId: number, requestId: string | number) => `${sessionId}:${requestId}`;

/** One `request_user_input` question as an approval card whose options are the answers. */
function codexQuestionApproval(requestId: string | number, questions: CodexQuestion[], index: number): StructuredApproval {
  const q = questions[index];
  const progress = questions.length > 1 ? ` (${index + 1} of ${questions.length})` : '';
  return {
    requestId,
    kind: 'other',
    title: `${q.header ? `${q.header}: ` : ''}${q.question}${progress}`,
    detail: q.options.filter((option) => option.description).map((option) => `${option.label}: ${option.description}`).join('\n') || null,
    options: q.options.map((option, i) => ({ id: String(i), label: option.label, kind: 'allow_once' })),
  };
}

export async function answerStructuredApproval(sessionId: number, requestId: string | number, decision: 'accept' | 'acceptForSession' | 'decline', optionId?: string): Promise<void> {
  const runtime = runtimes.get(sessionId);
  const key = questionKey(sessionId, requestId);
  const asking = pendingQuestions.get(key);
  if (asking) {
    const q = asking.questions[asking.index];
    const chosen = decision === 'decline' ? undefined : q.options[Number(optionId)];
    if (chosen) {
      asking.answers[q.id] = chosen.label;
      asking.index += 1;
      if (asking.index < asking.questions.length) {
        update(sessionId, (s) => ({ approvals: s.approvals.map((a) => a.requestId === requestId ? codexQuestionApproval(requestId, asking.questions, asking.index) : a) }));
        return;
      }
      pendingQuestions.delete(key);
      update(sessionId, (s) => ({ approvals: s.approvals.filter((a) => a.requestId !== requestId) }));
      await runtime?.session?.respond(requestId, codexAnswers(asking.answers));
      return;
    }
    // Declined (or no usable option): tell Codex no answer is coming.
    pendingQuestions.delete(key);
    update(sessionId, (s) => ({ approvals: s.approvals.filter((a) => a.requestId !== requestId) }));
    await runtime?.session?.respond(requestId, {}, { code: -32000, message: 'The user declined to answer.' });
    return;
  }
  update(sessionId, (s) => ({ approvals: s.approvals.filter((a) => a.requestId !== requestId) }));
  await runtime?.session?.respond(requestId, { decision });
}

export async function closeCodexChat(sessionId: number): Promise<void> {
  const runtime = runtimes.get(sessionId);
  runtimes.delete(sessionId);
  update(sessionId, { status: 'closed' });
  states.delete(sessionId);
  emit();
  for (const off of runtime?.unlisten ?? []) off();
  await runtime?.session?.close().catch(() => undefined);
}

/** Codex is one implementation of the provider contract used by the shared view. */
export const codexProvider: StructuredChatProvider = {
  agent: 'codex',
  label: 'Codex',
  capabilities: {
    rewind: true,
    fork: true,
    rewindMode: 'native-provider',
    forkMode: 'native-provider',
    compact: 'native',
    steering: 'inject',
    contextUsage: true,
    mcp: true,
    subagents: { supported: true, spawn: false, inspectTranscript: true },
    nativeCommands: true,
    supportedAccessModes: ['ask', 'auto', 'full-access'],
  },
  get: getStructuredChat,
  subscribe: subscribeStructuredChats,
  start: startCodexChat,
  send: sendCodexTurn,
  interrupt: interruptCodexTurn,
  setModel: setStructuredModel,
  setEffort: setStructuredEffort,
  setFast: setStructuredFast,
  setAccess: setStructuredAccess,
  answerApproval: answerStructuredApproval,
  close: closeCodexChat,
  models: (sessionId) => getStructuredChat(sessionId)?.models ?? [],
  conversationId: (sessionId) => getStructuredChat(sessionId)?.threadId ?? null,
  rewind: async (sessionId, target) => {
    const runtime = runtimes.get(sessionId);
    const state = states.get(sessionId);
    if (!runtime?.session || !state?.threadId) return false;
    try {
      await runtime.session.request('thread/rollback', {
        threadId: state.threadId,
        ...(typeof target === 'object' && target?.turnId ? { turnId: target.turnId } : {}),
      });
      return true;
    } catch {
      const userIndexes = state.items.map((it, idx) => (it.kind === 'user' ? idx : -1)).filter((idx) => idx !== -1);
      if (userIndexes.length > 0) {
        const lastUser = userIndexes[userIndexes.length - 1];
        update(sessionId, (s) => ({ items: s.items.slice(0, lastUser) }));
        return true;
      }
      return false;
    }
  },
  fork: async (sessionId) => {
    const runtime = runtimes.get(sessionId);
    const state = states.get(sessionId);
    if (!runtime?.session || !state?.threadId) return false;
    try {
      const res = await runtime.session.request<{ thread?: Json }>('thread/fork', {
        threadId: state.threadId,
      });
      const newThreadId = str(res.thread?.id);
      return { nativeSessionId: newThreadId ?? null };
    } catch {
      return { nativeSessionId: null };
    }
  },
  steer: async (sessionId, text, images = []) => {
    const runtime = runtimes.get(sessionId);
    const state = states.get(sessionId);
    if (!runtime?.session || !state?.threadId) return;
    try {
      await runtime.session.request('turn/steer', {
        threadId: state.threadId,
        input: [{ type: 'text', text, text_elements: [] }, ...images.map((path) => ({ type: 'localImage', path }))],
      });
    } catch {
      await sendCodexTurn(sessionId, text, images);
    }
  },
  compact: async (sessionId) => {
    const runtime = runtimes.get(sessionId);
    const state = states.get(sessionId);
    if (!runtime?.session || !state?.threadId) return;
    try {
      await runtime.session.request('thread/compact', { threadId: state.threadId });
    } catch {
      await sendCodexTurn(sessionId, '/compact');
    }
  },
  subagents: (sessionId) => states.get(sessionId)?.subagents ?? [],
};

// â”€â”€ Events â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

function onNotification(sessionId: number, n: AcpNotification) {
  const method = str(n.method);
  const p = rec(n.params) ?? {};
  switch (method) {
    case 'item/started':
    case 'item/completed': {
      const item = rec(p.item);
      const chat = item ? chatItemFor(item) : null;
      // `item/started` commonly carries an empty assistant shell; the
      // subsequent deltas own its text, so never let an empty completion
      // replace the streamed content already in the store.
      if (chat?.kind === 'user' && chat.images?.length) {
        if (states.get(sessionId)?.items.some((entry) => entry.id === chat.id)) break;
        const { images, ...user } = chat;
        const runtime = runtimes.get(sessionId);
        upsertItem(sessionId, user);
        void imageDataUrlsFor(images).then((previews) => {
          if (previews.length && runtime === runtimes.get(sessionId)
            && states.get(sessionId)?.items.some((entry) => entry.id === user.id)) {
            upsertItem(sessionId, { ...user, images: previews });
          }
        });
      } else if (chat && (chat.text || (chat.kind !== 'assistant' && chat.kind !== 'reasoning'))) {
        upsertItem(sessionId, chat);
      }
      break;
    }
    case 'item/agentMessage/delta':
      if (str(p.itemId)) appendText(sessionId, str(p.itemId)!, 'assistant', str(p.delta) ?? '');
      break;
    case 'item/reasoning/summaryTextDelta':
      if (str(p.itemId)) appendText(sessionId, str(p.itemId)!, 'reasoning', str(p.delta) ?? '');
      break;
    case 'item/commandExecution/outputDelta': {
      const itemId = str(p.itemId);
      if (!itemId) break;
      update(sessionId, (s) => {
        const at = s.items.findIndex((i) => i.id === itemId);
        if (at < 0) return { items: [...s.items, { id: itemId, kind: 'tool', text: '', toolName: 'shell', toolOutput: str(p.delta) ?? '', toolStatus: 'running' }] };
        const items = s.items.slice();
        items[at] = { ...items[at], toolOutput: (items[at].toolOutput ?? '') + (str(p.delta) ?? '') };
        return { items };
      });
      break;
    }
    case 'turn/started':
      runtimes.get(sessionId)!.turnId = str(rec(p.turn)?.id);
      update(sessionId, { status: 'working' });
      break;
    case 'turn/completed': {
      const runtime = runtimes.get(sessionId);
      if (runtime) runtime.turnId = null;
      // A failed turn's reason already arrived as an `error` notice.
      update(sessionId, { status: 'ready', approvals: [] });
      break;
    }
    case 'error': {
      const message = str(rec(p.error)?.message);
      if (message && p.willRetry !== true) {
        upsertItem(sessionId, { id: `error-${str(p.turnId) ?? Date.now()}`, kind: 'notice', text: message });
        update(sessionId, { status: 'ready', error: message });
      }
      break;
    }
    case 'thread/tokenUsage/updated': {
      const usage = rec(p.tokenUsage);
      const total = rec(usage?.last) ?? rec(usage?.total);
      const used = typeof total?.totalTokens === 'number' ? total.totalTokens : typeof total?.inputTokens === 'number' ? total.inputTokens : null;
      const window = typeof usage?.modelContextWindow === 'number' ? usage.modelContextWindow : null;
      update(sessionId, { contextUsed: used, contextWindow: window });
      break;
    }
    default:
      break;
  }
}

function onServerRequest(sessionId: number, r: AcpServerRequest) {
  const p = r.params ?? {};
  if (r.method === 'item/commandExecution/requestApproval' || r.method === 'execCommandApproval') {
    const command = str(p.command) ?? (Array.isArray(p.command) ? (p.command as string[]).join(' ') : null);
    update(sessionId, (s) => ({
      approvals: [...s.approvals, { requestId: r.requestId, kind: 'command', title: 'Run this command?', detail: command ?? str(p.reason) }],
    }));
    return;
  }
  if (r.method === 'item/fileChange/requestApproval' || r.method === 'applyPatchApproval') {
    update(sessionId, (s) => ({
      approvals: [...s.approvals, { requestId: r.requestId, kind: 'fileChange', title: 'Apply these file changes?', detail: str(p.reason) }],
    }));
    return;
  }
  if (r.method === 'item/tool/requestUserInput') {
    const questions = parseCodexQuestions(p);
    if (questions) {
      pendingQuestions.set(questionKey(sessionId, r.requestId), { questions, index: 0, answers: {} });
      update(sessionId, (s) => ({ approvals: [...s.approvals, codexQuestionApproval(r.requestId, questions, 0)] }));
      return;
    }
  }
  // Requests the chat can't answer yet are declined, so Codex never waits forever.
  void runtimes.get(sessionId)?.session?.respond(r.requestId, {}, { code: -32601, message: `Spacron can't answer ${r.method} yet` });
}


