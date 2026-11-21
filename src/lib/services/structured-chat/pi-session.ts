/**
 * Pi's JSONL RPC mode (`pi --mode rpc`) behind the same provider contract.
 * Verified on Windows (2026-11-20): commands are `{type, id}` lines and are
 * answered by `{type: 'response', id, command, success, data}`;
 * `get_state.data.model` is the current model and
 * `get_available_models.data.models` the catalog, where ids repeat across
 * providers.
 */
import { openAgentSession, stderrTail, withTimeout, type AcpSession } from '$lib/services/acp-transport';
import { accountEnvFor } from '$lib/stores/agentAccounts';
import { prepareStructuredVisuals } from './visuals';
import { get } from '$lib/stores/storeCompat';
import { chatAutoAnswerInline } from '$lib/stores/settings';
import type { StructuredChatProvider } from './provider';
import type { StructuredAccess, StructuredModel } from './codex-session';
import { initialStructuredState, StructuredStateStore } from './state';

type Json = Record<string, unknown>;
const str = (value: unknown): string | null => typeof value === 'string' ? value : null;
const rec = (value: unknown): Json | null => value && typeof value === 'object' && !Array.isArray(value) ? value as Json : null;

function textFrom(value: unknown): string {
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) return value.map(textFrom).filter(Boolean).join('');
  const row = rec(value);
  return row ? textFrom(row.text ?? row.delta ?? row.content ?? row.output ?? row.message) : '';
}

const stores = new StructuredStateStore();
const sessions = new Map<number, { session: AcpSession; requestId: number; responses?: Map<string, (frame: Json) => void> }>();

/** One Pi catalog entry, keyed `provider/id` so equal ids from two providers stay apart. */
export function piModelRef(row: Json | null): StructuredModel | null {
  const id = str(row?.id);
  if (!row || !id) return null;
  const provider = str(row.provider);
  return {
    id: provider ? `${provider}/${id}` : id,
    label: `${str(row.name) ?? id}${provider ? ` · ${provider}` : ''}`,
    description: null,
    efforts: [],
    defaultEffort: null,
    isDefault: false,
  };
}

export function piModelsFrom(raw: unknown): StructuredModel[] {
  return (Array.isArray(raw) ? raw : []).map((entry) => piModelRef(rec(entry))).filter((model): model is StructuredModel => model !== null);
}

function rpcRequest(runtime: { session: AcpSession; requestId: number; responses?: Map<string, (frame: Json) => void> }, command: string, params: Json): Promise<Json> {
  const id = nextId(runtime);
  runtime.responses ??= new Map();
  const answered = new Promise<Json>((resolve) => runtime.responses!.set(id, resolve));
  void runtime.session.writeRaw(`${JSON.stringify({ type: command, id, ...params })}\n`).catch(() => undefined);
  return answered;
}
const activeAssistantIds = new Map<number, string>();

function modelListFrom(frame: Json): StructuredModel[] {
  const state = rec(frame.state) ?? frame;
  const raw = state.models ?? state.availableModels ?? rec(state.modelCatalog)?.models;
  if (!Array.isArray(raw)) return [];
  const models: Array<StructuredModel | null> = raw.map((entry): StructuredModel | null => {
    if (typeof entry === 'string') return { id: entry, label: entry, description: null, efforts: [], defaultEffort: null, isDefault: false };
    const row = rec(entry);
    if (!row) return null;
    const id = str(row.id) ?? str(row.model) ?? str(row.value);
    if (!id) return null;
    return { id, label: str(row.name) ?? str(row.displayName) ?? id, description: str(row.description), efforts: [], defaultEffort: null, isDefault: row.isDefault === true };
  });
  return models.filter((entry): entry is StructuredModel => entry !== null);
}

function nextId(runtime: { requestId: number }): string { runtime.requestId += 1; return `spacron-pi-${Date.now()}-${runtime.requestId}`; }

export function chatItemForPi(frame: Json, fallbackId?: string): import('$lib/services/terminal-chat').TerminalChatItem | null {
  const type = str(frame.type) ?? str(frame.event);
  const id = str(frame.id) ?? str(frame.messageId) ?? fallbackId ?? `pi-${Date.now()}`;
  const message = rec(frame.message);
  const content = message?.content;
  const contentText = textFrom(content) || textFrom(frame.assistantMessageEvent);
  const text = textFrom(frame.text ?? frame.content ?? frame.delta ?? frame.output) || contentText;
  if (type === 'message' || type === 'assistant' || type === 'response' || type === 'message_start' || type === 'message_update' || type === 'message_end') return text ? { id, kind: 'assistant', text } : null;
  if (type === 'tool_start' || type === 'tool_call' || type === 'tool_execution_start') return { id, kind: 'tool', text: '', toolName: str(frame.toolName) ?? str(frame.name) ?? 'tool', toolInput: JSON.stringify(frame.args ?? frame.input ?? {}), toolStatus: 'running' };
  if (type === 'tool_end' || type === 'tool_result' || type === 'tool_execution_end') return { id, kind: 'tool', text: '', toolName: str(frame.toolName) ?? str(frame.name) ?? 'tool', toolOutput: text, toolStatus: frame.isError === true ? 'error' : 'done' };
  if (type === 'thinking' || type === 'reasoning' || type === 'thinking_delta') return text ? { id, kind: 'reasoning', text } : null;
  if (type === 'error' || type === 'agent_error') return { id, kind: 'notice', text: text || 'Pi reported an error.' };
  return null;
}

async function sendRpc(runtime: { session: AcpSession; requestId: number }, command: string, params: Json): Promise<void> {
  const frame = command === 'prompt'
    ? { type: command, ...params, streamingBehavior: 'followUp' }
    : { type: command, id: nextId(runtime), ...params };
  await runtime.session.writeRaw(`${JSON.stringify(frame)}\n`);
}

export const piProvider: StructuredChatProvider = {
  agent: 'pi', label: 'Pi',
  capabilities: {
    rewind: false,
    fork: false,
    rewindMode: 'none',
    forkMode: 'none',
    compact: 'journal-only',
    steering: 'queue',
    contextUsage: false,
    mcp: false,
    subagents: { supported: false, spawn: false, inspectTranscript: false },
    nativeCommands: false,
    supportedAccessModes: ['ask'],
  },
  get: stores.get.bind(stores), subscribe: stores.subscribe.bind(stores),
  async start(sessionId, cwd, options = {}) {
    if (sessions.has(sessionId)) return;
    stores.set(sessionId, initialStructuredState(options.access, stores.get(sessionId) ?? undefined));
    let tail: ReturnType<typeof stderrTail> | null = null;
    try {
      const accountEnv = await accountEnvFor('pi', options.accountId);
      const args = ['--mode', 'rpc', ...(options.resumeId ? ['--session', options.resumeId] : [])];
      const session = await openAgentSession('pi', args, cwd, { ...accountEnv, ...await prepareStructuredVisuals(sessionId) });
      tail = stderrTail(session);
      const stderr = tail;
      const runtime = { session, requestId: 0, responses: new Map<string, (frame: Json) => void>() };
      sessions.set(sessionId, runtime);
      await session.onExit(() => {
        const reason = stderr.text();
        stores.update(sessionId, (state) => state.status === 'closed' ? {} : { status: 'failed', error: reason ? `Pi stopped: ${reason}` : state.error ?? 'Pi stopped.' });
      });
      const handleFrame = (frame: Json) => {
        const type = (str(frame.type) ?? str(frame.event) ?? '').toLowerCase();
        if (type === 'response') {
          const waiter = str(frame.id) ? runtime.responses.get(str(frame.id)!) : undefined;
          if (waiter) { runtime.responses.delete(str(frame.id)!); waiter(frame); }
          return;
        }
        const isConfirm = type === 'confirmation' || type === 'permission_request' || type === 'confirm' || type === 'approval_request' || (type === 'request' && /confirm|permission/i.test(str(frame.subtype) ?? ''));
        if (isConfirm) {
          const reqId = str(frame.requestId) ?? str(frame.id) ?? `pi-${sessionId}-req-${Date.now()}`;
          const tool = str(frame.tool) ?? str(frame.toolName) ?? str(frame.tool_name) ?? str(frame.name) ?? 'tool';
          const access = stores.get(sessionId)?.access ?? 'ask';
          const autoAnswer = get(chatAutoAnswerInline);
          const isRead = /read|view|list|glob|grep|search/i.test(tool);
          const isWrite = /edit|write|create|replace/i.test(tool);
          const canAuto = access === 'full-access'
            || (access === 'auto' && (isRead || isWrite))
            || (autoAnswer && isRead);
          if (canAuto) {
            void runtime.session.writeRaw(`${JSON.stringify({
              type: 'response',
              id: reqId,
              confirmed: true,
              decision: 'accept',
              success: true,
            })}\n`).catch(() => undefined);
            return;
          }
          stores.update(sessionId, (state) => ({
            approvals: [...state.approvals, {
              requestId: reqId,
              kind: /bash|shell|command|exec/i.test(tool) ? 'command' : /edit|write|file/i.test(tool) ? 'fileChange' : 'other',
              title: str(frame.title) ?? str(frame.message) ?? `Pi wants to use ${tool}`,
              detail: str(frame.command) ?? str(frame.detail) ?? str(frame.description) ?? (frame.args ? JSON.stringify(frame.args) : null),
            }],
          }));
          return;
        }
        const streaming = type === 'message_update' || type === 'assistant_delta' || type === 'text_delta' || type === 'thinking_delta';
        const fallbackId = streaming ? (activeAssistantIds.get(sessionId) ?? `pi-${sessionId}-assistant-${Date.now()}`) : undefined;
        if (streaming && fallbackId) activeAssistantIds.set(sessionId, fallbackId);
        const item = chatItemForPi(frame, fallbackId);
        if (item) {
          if (streaming && (item.kind === 'assistant' || item.kind === 'reasoning')) stores.append(sessionId, item.id, item.kind, item.text);
          else stores.upsert(sessionId, item);
        }
        const models = modelListFrom(frame);
        if (models.length) stores.update(sessionId, { models, model: stores.get(sessionId)?.model && models.some((model) => model.id === stores.get(sessionId)?.model) ? stores.get(sessionId)?.model : models.find((model) => model.isDefault)?.id ?? models[0]?.id ?? null });
        if (streaming || type === 'tool_start' || type === 'tool_call') stores.update(sessionId, { status: 'working' });
        if (['turn_end', 'agent_settled', 'idle', 'response_end', 'message_end'].includes(type)) {
          activeAssistantIds.delete(sessionId);
          stores.update(sessionId, { status: 'ready', approvals: [] });
        }
        if (type === 'error' || type === 'agent_error') stores.update(sessionId, { status: 'ready', error: textFrom(frame.error ?? frame.message ?? frame) || 'Pi reported an error.' });
      };
      await session.onNotification(handleFrame);
      await session.onRawLine((line) => { try { handleFrame(JSON.parse(line) as Json); } catch { /* diagnostics are not chat frames */ } });
      // Ready only once Pi has answered: a process that started but can't
      // serve RPC must not look connected.
      const state = await withTimeout(rpcRequest(runtime, 'get_state', {}), 30_000, 'Pi did not answer get_state');
      if (state.success === false) throw new Error(str(state.error) ?? 'Pi refused get_state');
      const current = piModelRef(rec(rec(state.data)?.model));
      let models: StructuredModel[] = [];
      try {
        const listed = await withTimeout(rpcRequest(runtime, 'get_available_models', {}), 30_000, 'Pi did not list its models');
        models = piModelsFrom(rec(listed.data)?.models ?? listed.data);
      } catch {
        // The catalog is optional; the current model still shows.
      }
      if (current && !models.some((model) => model.id === current.id)) models.unshift(current);
      stores.update(sessionId, { status: 'ready', error: null, threadId: str(rec(state.data)?.sessionId) ?? options.resumeId ?? null, models, model: current?.id ?? models[0]?.id ?? null, effort: str(rec(state.data)?.thinkingLevel) ?? null });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const reason = tail?.text();
      stores.update(sessionId, { status: 'failed', error: reason && !message.includes(reason) ? `${message}: ${reason}` : message });
    }
  },
  async send(sessionId, text) {
    const runtime = sessions.get(sessionId);
    if (!runtime || !text.trim()) return;
    activeAssistantIds.delete(sessionId);
    stores.upsert(sessionId, { id: `user-${Date.now()}`, kind: 'user', text });
    stores.update(sessionId, { status: 'working' });
    await sendRpc(runtime, 'prompt', { message: text });
  },
  async interrupt(sessionId) { const runtime = sessions.get(sessionId); if (runtime) await sendRpc(runtime, 'abort', {}); },
  setModel(sessionId, model) {
    const runtime = sessions.get(sessionId);
    stores.update(sessionId, { model });
    // Model ids repeat across providers, so the catalog id is `provider/id`.
    const slash = model.indexOf('/');
    const known = stores.get(sessionId)?.models.some((entry) => entry.id === model);
    if (runtime) void sendRpc(runtime, 'set_model', known && slash > 0 ? { provider: model.slice(0, slash), modelId: model.slice(slash + 1) } : { model });
  },
  setEffort(sessionId, effort) { const runtime = sessions.get(sessionId); stores.update(sessionId, { effort }); if (runtime) void sendRpc(runtime, 'set_thinking_level', { level: effort }); },
  setAccess(sessionId, access: StructuredAccess) {
    const runtime = sessions.get(sessionId);
    stores.update(sessionId, { access });
    if (runtime) {
      void sendRpc(runtime, 'set_access', { access }).catch(() => undefined);
      void sendRpc(runtime, 'set_permission_mode', { mode: access === 'full-access' ? 'yolo' : access === 'auto' ? 'auto' : 'ask' }).catch(() => undefined);
    }
  },
  async answerApproval(sessionId, requestId, decision) {
    const runtime = sessions.get(sessionId);
    stores.update(sessionId, (state) => ({
      approvals: state.approvals.filter((approval) => approval.requestId !== requestId),
    }));
    if (!runtime) return;
    const confirmed = decision !== 'decline';
    await runtime.session.writeRaw(`${JSON.stringify({
      type: 'response',
      id: String(requestId),
      confirmed,
      decision,
      success: confirmed,
    })}\n`).catch(() => undefined);
  },
  async close(sessionId) { const runtime = sessions.get(sessionId); sessions.delete(sessionId); activeAssistantIds.delete(sessionId); stores.delete(sessionId); await runtime?.session.close().catch(() => undefined); },
  models: (sessionId) => stores.get(sessionId)?.models ?? [],
  conversationId: (sessionId) => stores.get(sessionId)?.threadId ?? null,
  subagents: (sessionId) => stores.get(sessionId)?.subagents ?? [],
};
