/** One ACP client for agents whose CLI exposes `session/new`/`session/prompt`. */
import {
  ACP_NO_CLIENT_TOOLS,
  authenticateAcp,
  createAcpNativeSession,
  initializeAcp,
  openAgentSession,
  promptAcpNativeSession,
  setAcpSessionMode,
  setAcpSessionModel,
  stderrTail,
  withTimeout,
  type AcpServerRequest,
  type AcpSession,
} from '$lib/services/acp-transport';
import { acpApprovalDecision } from '$lib/services/acp-approval-policy';
import { chooseAntigravityAcpMode } from '$lib/services/acp-permission-modes';
import { accountEnvFor } from '$lib/stores/agentAccounts';
import { get } from '$lib/stores/storeCompat';
import { chatAutoAnswerInline } from '$lib/stores/settings';
import type { TerminalChatItem } from '$lib/services/terminal-chat';
import type { StructuredAccess, StructuredApproval, StructuredApprovalOption, StructuredChatState, StructuredModel } from './codex-session';
import { acpAskAnswer, acpAskSkip, askKindFor, parseAcpQuestions, type AcpAskKind, type AcpAskQuestion } from './acp-questions';
import { acpImageBlocks, imageDataUrlsFor } from './attachments';
import { prepareStructuredVisuals } from './visuals';
import type { StructuredChatProvider } from './provider';
import { initialStructuredState, StructuredStateStore } from './state';

type Json = Record<string, unknown>;
const str = (value: unknown): string | null => typeof value === 'string' ? value : null;
const rec = (value: unknown): Json | null => value && typeof value === 'object' && !Array.isArray(value) ? value as Json : null;

function textFrom(value: unknown): string {
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) return value.map(textFrom).filter(Boolean).join('');
  const row = rec(value);
  if (!row) return '';
  return textFrom(row.text ?? row.delta ?? row.content ?? row.output ?? row.rawOutput ?? row.message);
}

/**
 * `authMethod`: an auth method that reuses the CLI's own saved login, sent as
 * `authenticate` before `session/new`. Cursor needs it: without it,
 * `session/new` never answers (seen with cursor-agent on Windows, 2026-11-20).
 */
const LAUNCHES: Record<string, { command: string; args: string[]; label: string; env?: Record<string, string>; authMethod?: string }> = {
  opencode: { command: 'opencode', args: ['acp'], label: 'OpenCode', env: { OPENCODE_CLIENT: 'acp', OPENCODE_ENABLE_QUESTION_TOOL: 'false' } },
  grok: { command: 'grok', args: ['agent', 'stdio'], label: 'Grok' },
  antigravity: { command: 'agy', args: ['acp'], label: 'Antigravity', env: { AGY_CLI_DISABLE_AUTO_UPDATE: 'true' } },
  cursor: { command: 'cursor-agent', args: ['--disable-auto-update', 'acp'], label: 'Cursor', authMethod: 'cursor_login' },
  copilot: { command: 'copilot', args: ['--acp'], label: 'Copilot' },
  kimi: { command: 'kimi', args: ['acp'], label: 'Kimi' },
  hermes: { command: 'hermes', args: ['acp'], label: 'Hermes' },
  omp: { command: 'omp', args: ['acp'], label: 'OMP', env: { PI_NO_PTY: '1' } },
};

function modelFrom(raw: unknown): StructuredModel | null {
  if (typeof raw === 'string') return { id: raw, label: raw, description: null, efforts: [], defaultEffort: null, isDefault: false };
  const row = rec(raw);
  if (!row) return null;
  const id = str(row.id) ?? str(row.modelId) ?? str(row.value) ?? str(row.name);
  if (!id) return null;
  const effortRows = row.efforts ?? row.reasoningEfforts ?? rec(row.options)?.effort;
  const efforts = Array.isArray(effortRows) ? effortRows.map((effort) => str(rec(effort)?.id) ?? str(rec(effort)?.value) ?? str(effort)).filter((effort): effort is string => !!effort) : [];
  return { id, label: str(row.name) ?? str(row.displayName) ?? id, description: str(row.description), efforts, defaultEffort: str(row.defaultEffort), isDefault: row.isDefault === true };
}

function configOptionId(option: Json): string | null {
  return str(option.configId) ?? str(option.id) ?? str(option.category) ?? str(option.name);
}

function configOptionValue(option: Json): string | null {
  return str(option.currentValue) ?? str(option.value) ?? str(option.defaultValue);
}

function configOptionsFrom(value: Json): Json[] {
  return (Array.isArray(value.configOptions) ? value.configOptions : [])
    .map(rec)
    .filter((option): option is Json => option !== null);
}

function currentConfigValue(value: Json, id: string): string | null {
  const option = configOptionsFrom(value).find((candidate) => configOptionId(candidate)?.toLowerCase() === id);
  return option ? configOptionValue(option) : null;
}

/** Parse both legacy ACP model lists and the v2 `configOptions` model select. */
export function modelsFrom(value: Json): StructuredModel[] {
  const modelContainer = rec(value.models);
  const configOptions = configOptionsFrom(value);
  const candidates = Array.isArray(value.models)
    ? value.models
    : modelContainer?.availableModels ?? modelContainer?.models ?? rec(value.model)?.models ?? [];
  const listed = (Array.isArray(candidates) ? candidates : []).map(modelFrom).filter((model): model is StructuredModel => model !== null);
  for (const option of configOptions) {
    if (configOptionId(option)?.toLowerCase() !== 'model') continue;
    const values = Array.isArray(option.options) ? option.options : [];
    for (const value of values) {
      const model = modelFrom(value);
      if (model && !listed.some((candidate) => candidate.id === model.id)) {
        listed.push({ ...model, isDefault: model.isDefault || model.id === configOptionValue(option) });
      }
    }
  }
  return listed;
}

/** Provider-neutral ACP update mapping; dialects can add fields without changing the view. */
export function chatItemForAcpUpdate(agent: string, notification: Json, fallbackId?: string): TerminalChatItem | null {
  const params = rec(notification.params) ?? notification;
  const update = rec(params.update) ?? params;
  const kind = String(update.sessionUpdate ?? update.type ?? '').toLowerCase().replace(/[-\s]/g, '_');
  const id = str(update.id) ?? str(update.toolCallId) ?? fallbackId ?? `${agent}-${Date.now()}`;
  const text = textFrom(update.content ?? update.message ?? update.text ?? update.delta ?? update.output ?? update.rawOutput);
  if (kind.includes('agent_message') || kind.includes('assistant_message') || kind === 'text_delta' || kind === 'message_chunk') return text ? { id, kind: 'assistant', text } : null;
  if (kind.includes('agent_thought') || kind.includes('assistant_thought') || kind.includes('reasoning') || kind === 'thought_chunk') return text ? { id, kind: 'reasoning', text } : null;
  if (kind.includes('user_message')) return { id, kind: 'user', text };
  if (kind.includes('tool_call') || kind.includes('tool_result') || kind.includes('tool_use')) {
    const isUpdate = kind.includes('tool_call_update') || kind.includes('tool_result');
    const rawInput = update.rawInput ?? update.input ?? update.arguments;
    const input = rec(rawInput);
    const fileDiffs = (Array.isArray(update.content) ? update.content : [])
      .map(rec)
      .filter((part) => part?.type === 'diff' && typeof part.path === 'string' && typeof part.newText === 'string');
    const fileOperation = update.kind === 'edit' || update.kind === 'move' || update.kind === 'delete' ? update.kind : null;
    const filePaths = fileOperation && Array.isArray(update.locations)
      ? update.locations.map((location) => str(rec(location)?.path)).filter(Boolean) : [];
    const status = String(update.status ?? '').toLowerCase();
    const toolStatus = !status && kind.includes('tool_call_update') ? undefined
      : /fail|error|cancel/.test(status) ? 'error'
        : /progress|running|pending/.test(status) || (!status && !isUpdate) ? 'running' : 'done';
    const toolName = str(update.title) ?? str(update.name);
    return {
      id, kind: 'tool', text: '',
      ...(toolStatus ? { toolStatus } : {}),
      ...(toolName ? { toolName } : !isUpdate ? { toolName: 'tool' } : {}),
      ...(rawInput != null ? { toolInput: JSON.stringify(rawInput) } : {}),
      ...(input || fileDiffs.length || filePaths.length ? {
        toolData: {
          ...input,
          ...(fileDiffs.length ? { fileDiffs } : {}),
          ...(filePaths.length ? { filePaths, fileOperation } : {}),
        },
      } : {}),
      ...(isUpdate ? { toolOutput: text } : {}),
    };
  }
  if (kind === 'plan' || kind.includes('plan_update')) return { id, kind: 'reasoning', text: text || JSON.stringify(update.entries ?? []) };
  if (kind.includes('error')) return { id, kind: 'notice', text: text || 'The agent reported an error.' };
  return null;
}

/**
 * The ACP answer to a permission request. Option ids are the agent's own
 * (`allow`, `proceed_once`, …), so pick by the option's `kind`; the spec
 * kinds are allow_once, allow_always, reject_once and reject_always.
 */
export function permissionOutcome(options: Json[], decision: 'accept' | 'acceptForSession' | 'decline', explicitOptionId?: string): Json {
  // A numbered answer picks the agent's own option, whatever kind it declares.
  if (explicitOptionId && options.some((option) => (str(option.optionId) ?? str(option.id)) === explicitOptionId)) {
    return { outcome: { outcome: 'selected', optionId: explicitOptionId } };
  }
  const byKind = (...kinds: string[]) => options.find((option) => kinds.includes(String(option.kind ?? '').toLowerCase()));
  const chosen = decision === 'decline'
    ? byKind('reject_once', 'reject_always')
    : decision === 'acceptForSession'
      ? byKind('allow_always') ?? byKind('allow_once')
      : byKind('allow_once') ?? byKind('allow_always');
  const optionId = chosen ? str(chosen.optionId) ?? str(chosen.id) : null;
  if (optionId) return { outcome: { outcome: 'selected', optionId } };
  if (decision === 'decline') return { outcome: { outcome: 'cancelled' } };
  // No options offered: the spec's own ids are the best guess.
  return { outcome: { outcome: 'selected', optionId: decision === 'acceptForSession' ? 'allow_always' : 'allow_once' } };
}

/**
 * The answers an ACP permission request offered, as the view's question card
 * shows them: the agent's own ids and labels, in the order it sent them.
 */
export function approvalOptions(options: readonly Json[]): StructuredApprovalOption[] {
  const out: StructuredApprovalOption[] = [];
  for (const option of options) {
    const id = str(option.optionId) ?? str(option.id);
    if (!id) continue;
    out.push({
      id,
      label: str(option.name) ?? str(option.label) ?? str(option.title) ?? id,
      kind: str(option.kind),
    });
  }
  return out;
}

/** The session mode ids an ACP agent advertised (`modes.availableModes` or a `mode` config select). */
export function advertisedModes(record: Json): string[] {
  const listed = rec(record.modes)?.availableModes;
  const fromModes = Array.isArray(listed) ? listed.map((mode) => str(rec(mode)?.id)).filter((id): id is string => !!id) : [];
  if (fromModes.length) return fromModes;
  const option = configOptionsFrom(record).find((candidate) => configOptionId(candidate)?.toLowerCase() === 'mode');
  const values = Array.isArray(option?.options) ? option.options : [];
  return values.map((value) => str(rec(value)?.value) ?? str(rec(value)?.id) ?? str(value)).filter((id): id is string => !!id);
}

/**
 * The agent's own permission mode for `access`, or null when it has none.
 * OpenCode (build/plan), Cursor (agent/plan/ask) and Grok (none) have no
 * permission modes, so nothing is sent to them.
 */
export function permissionModeFor(modes: readonly string[], access: StructuredAccess, agent?: string): string | null {
  if (agent === 'antigravity') {
    return chooseAntigravityAcpMode({ availableModes: modes.map((id) => ({ id })), currentModeId: null }, access === 'ask' ? 'supervised' : access);
  }
  const lower = new Map(modes.map((mode) => [mode.toLowerCase(), mode]));
  const pick = (...ids: string[]) => ids.map((id) => lower.get(id)).find((mode): mode is string => !!mode) ?? null;
  if (access === 'full-access') return pick('bypasspermissions', 'bypass-permissions', 'yolo', 'full-access', 'auto');
  if (access === 'auto') return pick('acceptedits', 'accept-edits', 'auto-edit', 'autoedit');
  // Only an explicit `default`: Cursor's `ask` mode is read-only Q&A, not
  // "ask before acting".
  return pick('default');
}

/**
 * Whether Spacron answers a permission request itself. Full access approves
 * everything; Auto approves reading and editing files, and asks for the rest
 * (commands, network, deletes). The ACP `kind`s are read, edit, delete, move,
 * search, execute, think, fetch, other.
 */
export function autoApproves(access: StructuredAccess, kind: string | null, autoAnswer = false): boolean {
  if (access === 'full-access') return true;
  if (access === 'auto') return ['read', 'edit', 'search', 'think'].includes(String(kind ?? '').toLowerCase());
  if (autoAnswer) return ['read', 'search', 'think'].includes(String(kind ?? '').toLowerCase());
  return false;
}

function capabilitiesForAgent(agent: string): import('./provider').StructuredProviderCapabilities {
  switch (agent) {
    case 'antigravity':
      return {
        rewind: false,
        fork: false,
        rewindMode: 'none',
        forkMode: 'none',
        compact: 'journal-only',
        steering: 'queue',
        contextUsage: true,
        mcp: true,
        // ACP exposes no subagent RPC here: the provider method is what the
        // registry checks before it claims a child is provider-native.
        subagents: { supported: false, spawn: false, inspectTranscript: false },
        nativeCommands: false,
        supportedAccessModes: ['ask', 'auto', 'full-access'],
      };
    case 'opencode':
      return {
        rewind: false,
        fork: false,
        rewindMode: 'none',
        forkMode: 'none',
        compact: 'journal-only',
        steering: 'queue',
        contextUsage: true,
        mcp: true,
        subagents: { supported: false, spawn: false, inspectTranscript: false },
        nativeCommands: true,
        supportedAccessModes: ['ask', 'auto'],
      };
    case 'cursor':
      return {
        rewind: false,
        fork: false,
        rewindMode: 'none',
        forkMode: 'none',
        compact: 'journal-only',
        steering: 'queue',
        contextUsage: true,
        mcp: true,
        subagents: { supported: false, spawn: false, inspectTranscript: false },
        nativeCommands: false,
        supportedAccessModes: ['ask', 'auto'],
      };
    default:
      return {
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
      };
  }
}

function makeProvider(agent: string): StructuredChatProvider {
  const launch = LAUNCHES[agent] ?? { command: agent, args: [], label: agent };
  const stores = new StructuredStateStore();
  const sessions = new Map<number, { session: AcpSession; sessionId: string; cwd: string; modes?: string[] }>();
  const activeAssistantIds = new Map<number, string>();
  const activeReasoningIds = new Map<number, string>();
  let segmentSequence = 0;
  /** The options each pending permission request offered. */
  const permissionOptions = new Map<string, Json[]>();
  /** Extension questions (Grok, Cursor) being answered one card at a time. */
  const pendingAsks = new Map<string, { kind: AcpAskKind; questions: AcpAskQuestion[]; title: string | null; index: number; answers: Record<string, string> }>();
  const askKey = (sessionId: number, requestId: string | number) => `${sessionId}:${requestId}`;
  const askApproval = (requestId: string | number, ask: { questions: AcpAskQuestion[]; title: string | null; index: number }): StructuredApproval => {
    const q = ask.questions[ask.index];
    const progress = ask.questions.length > 1 ? ` (${ask.index + 1} of ${ask.questions.length})` : '';
    return {
      requestId,
      kind: 'other',
      title: `${q.header ?? ask.title ? `${q.header ?? ask.title}: ` : ''}${q.text}${progress}`,
      detail: [q.multiple ? 'This agent allows several answers; pick the main one here.' : null, ...q.options.filter((o) => o.description).map((o) => `${o.label}: ${o.description}`)].filter(Boolean).join('\n') || null,
      options: q.options.map((o) => ({ id: o.id, label: o.label, kind: 'allow_once' })),
    };
  };

  function applyConfigOptions(sessionId: number, value: unknown): void {
    const record = rec(value);
    if (!record || !Array.isArray(record.configOptions)) return;
    const models = modelsFrom(record);
    const selected = currentConfigValue(record, 'model');
    const effort = currentConfigValue(record, 'effort');
    const mode = currentConfigValue(record, 'mode');
    stores.update(sessionId, (state) => ({
      // ACP config_option_update replaces the complete list, so an empty
      // model select means the server currently exposes no model catalogue.
      models,
      model: selected && models.some((model) => model.id === selected)
        ? selected
        : state.model && models.some((model) => model.id === state.model) ? state.model : models[0]?.id ?? null,
      effort: effort ?? state.effort,
      mode: mode ?? state.mode,
    }));
  }

  async function start(sessionId: number, cwd: string, options: { access?: StructuredAccess; resumeId?: string | null; model?: string | null; effort?: string | null; accountId?: string | null } = {}): Promise<void> {
    if (sessions.has(sessionId)) return;
    stores.set(sessionId, initialStructuredState(options.access, stores.get(sessionId) ?? undefined));
    let stderr: ReturnType<typeof stderrTail> | null = null;
    let exited = false;
    try {
      const accountEnv = await accountEnvFor(agent, options.accountId);
      const session = await openAgentSession(launch.command, launch.args, cwd, { ...(launch.env ?? {}), ...accountEnv, ...await prepareStructuredVisuals(sessionId) });
      stderr = stderrTail(session);
      const tail = stderr;
      sessions.set(sessionId, { session, sessionId: '', cwd });
      await session.onNotification((notification) => onNotification(sessionId, notification));
      await session.onRequest((request) => onRequest(sessionId, request));
      await session.onExit(() => {
        exited = true;
        const reason = tail.text();
        stores.update(sessionId, (state) => state.status === 'closed' ? {} : { status: 'failed', error: reason ? `${launch.label} stopped: ${reason}` : state.error ?? `${launch.label} stopped.` });
      });
      const initialized = await withTimeout(initializeAcp(session, ACP_NO_CLIENT_TOOLS), 60_000, `${launch.label} did not answer initialize`);
      const methods = initialized.authMethods.map((method) => str(rec(method)?.id)).filter((id): id is string => !!id);
      if (launch.authMethod && methods.includes(launch.authMethod)) {
        await withTimeout(authenticateAcp(session, launch.authMethod), 30_000, `${launch.label} did not finish signing in`);
      }
      const open = () => withTimeout(
        options.resumeId
          ? session.request<Json>('session/load', { sessionId: options.resumeId, cwd, mcpServers: [] })
          : createAcpNativeSession(session, cwd, null, []),
        90_000,
        `${launch.label} did not open a session`,
      );
      let created: unknown;
      let resumeId = options.resumeId ?? null;
      try {
        created = await open();
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (exited) throw error;
        if (resumeId) {
          // An explicit resume must keep the native conversation and its owner.
          throw new Error(`Could not resume ${launch.label} session ${resumeId}: ${message}`);
        } else {
          // An agent that wants sign-in first says so on session/new; sign in
          // with the method it offers that reuses its saved login, then retry.
          const fallback = launch.authMethod ?? methods[0];
          if (!fallback || !/auth|sign.?in|log.?in|credential/i.test(message)) throw error;
          await withTimeout(authenticateAcp(session, fallback), 30_000, `${launch.label} did not finish signing in`);
          created = await open();
        }
      }
      const createdRecord = created as Json;
      const nativeId = str(createdRecord.sessionId) ?? resumeId;
      if (!nativeId) throw new Error(`${launch.label} did not return a session id`);
      const runtime = sessions.get(sessionId);
      if (runtime) {
        runtime.sessionId = nativeId;
        runtime.modes = advertisedModes(createdRecord);
      }
      // Best effort: a mode the agent doesn't have must never stop the chat.
      await applyAccessMode(sessionId, stores.get(sessionId)?.access ?? 'ask');
      const models = modelsFrom(createdRecord).length ? modelsFrom(createdRecord) : modelsFrom(initialized);
      const selected = (options.model && models.some((m) => m.id === options.model) ? options.model : null)
        ?? currentConfigValue(createdRecord, 'model')
        ?? str(rec(createdRecord.models)?.currentModelId)
        ?? str(createdRecord.currentModelId)
        ?? models.find((model) => model.isDefault)?.id
        ?? models[0]?.id
        ?? null;
      stores.update(sessionId, { status: 'ready', error: null, models, model: selected, mode: currentConfigValue(createdRecord, 'mode') ?? stores.get(sessionId)?.mode ?? null, threadId: nativeId, effort: options.effort ?? null });
      if (options.model && selected === options.model && runtime) {
        void setAcpSessionModel(runtime.session, runtime.sessionId, options.model);
      }
      if (options.effort && runtime) {
        void runtime.session.request<Json>('session/set_config_option', { sessionId: runtime.sessionId, configId: 'effort', value: options.effort }).catch(() => undefined);
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const reason = stderr?.text();
      stores.update(sessionId, { status: 'failed', error: reason && !message.includes(reason) ? `${message}: ${reason}` : message });
    }
  }

  async function send(sessionId: number, text: string, images: string[] = []): Promise<void> {
    const runtime = sessions.get(sessionId);
    if (!runtime || (!text.trim() && !images.length)) return;
    activeAssistantIds.delete(sessionId);
    activeReasoningIds.delete(sessionId);
    const dataUrls = await imageDataUrlsFor(images);
    // Nothing readable and no text: say so instead of staying "working" forever.
    if (!text.trim() && !dataUrls.length) {
      stores.update(sessionId, { status: 'ready', error: 'Those attachments could not be read as images.' });
      return;
    }
    stores.upsert(sessionId, { id: `user-${Date.now()}`, kind: 'user', text, images: dataUrls.length ? dataUrls : undefined });
    stores.update(sessionId, { status: 'working', error: null });
    try {
      const result = await promptAcpNativeSession(runtime.session, runtime.sessionId, text, acpImageBlocks(dataUrls));
      if (sessions.get(sessionId) !== runtime) return;
      const stopReason = result?.stopReason;
      stores.update(sessionId, (state) => state.status !== 'working' ? {} : {
        status: 'ready',
        approvals: [],
        ...(stopReason && stopReason !== 'end_turn' && stopReason !== 'cancelled'
          ? { error: `Turn stopped (${stopReason.replace(/_/g, ' ')}).` }
          : {}),
      });
    } catch (error) {
      if (sessions.get(sessionId) !== runtime) return;
      stores.update(sessionId, (state) => state.status !== 'working' ? {} : {
        status: 'ready',
        approvals: [],
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  async function interrupt(sessionId: number): Promise<void> {
    const runtime = sessions.get(sessionId);
    if (!runtime) return;
    // `session/cancel` is a notification in ACP: a request would wait forever.
    try { await runtime.session.notify('session/cancel', { sessionId: runtime.sessionId }); } catch { /* already idle */ }
  }

  function setModel(sessionId: number, model: string): void {
    stores.update(sessionId, { model });
    const runtime = sessions.get(sessionId);
    if (runtime) void setAcpSessionModel(runtime.session, runtime.sessionId, model)
      .then((result) => applyConfigOptions(sessionId, result))
      .catch(() => runtime.session.request<Json>('session/set_config_option', { sessionId: runtime.sessionId, configId: 'model', value: model })
        .then((result) => applyConfigOptions(sessionId, result)).catch(() => undefined));
  }

  function setEffort(sessionId: number, effort: string): void {
    stores.update(sessionId, { effort });
    const runtime = sessions.get(sessionId);
    if (runtime) void runtime.session.request<Json>('session/set_config_option', { sessionId: runtime.sessionId, configId: 'effort', value: effort })
      .then((result) => applyConfigOptions(sessionId, result)).catch(() => undefined);
  }

  function setAccess(sessionId: number, access: StructuredAccess): void {
    stores.update(sessionId, { access });
    void applyAccessMode(sessionId, access);
  }

  /**
   * Put the agent in the permission mode matching `access`, only if it
   * advertises one. Most ACP agents have no such mode (OpenCode's modes are
   * build/plan personas, Cursor's agent/plan/ask, Grok has none): for them
   * access is enforced by how Spacron answers their permission requests
   * (`onRequest`). Never throws.
   */
  async function applyAccessMode(sessionId: number, access: StructuredAccess): Promise<void> {
    const runtime = sessions.get(sessionId);
    if (!runtime) return;
    const modeId = permissionModeFor(runtime.modes ?? [], access, agent);
    if (!modeId) return;
    try {
      const result = await setAcpSessionMode(runtime.session, runtime.sessionId, modeId);
      applyConfigOptions(sessionId, result);
    } catch {
      // The agent refused; permission answers still follow `access`.
    }
  }

  async function answerApproval(sessionId: number, requestId: string | number, decision: 'accept' | 'acceptForSession' | 'decline', optionId?: string): Promise<void> {
    const runtime = sessions.get(sessionId);
    const ask = pendingAsks.get(askKey(sessionId, requestId));
    if (ask) {
      const chosen = decision !== 'decline' ? ask.questions[ask.index].options.find((o) => o.id === optionId) : undefined;
      if (chosen) {
        ask.answers[ask.questions[ask.index].key] = chosen.id;
        ask.index += 1;
        if (ask.index < ask.questions.length) {
          // The next question replaces this card; the request stays open until the last.
          stores.update(sessionId, (state) => ({ approvals: state.approvals.map((approval) => approval.requestId === requestId ? askApproval(requestId, ask) : approval) }));
          return;
        }
      }
      pendingAsks.delete(askKey(sessionId, requestId));
      stores.update(sessionId, (state) => ({ approvals: state.approvals.filter((approval) => approval.requestId !== requestId) }));
      await runtime?.session.respond(requestId, chosen ? acpAskAnswer(ask.kind, ask.questions, ask.answers) : acpAskSkip(ask.kind));
      return;
    }
    stores.update(sessionId, (state) => ({ approvals: state.approvals.filter((approval) => approval.requestId !== requestId) }));
    if (!runtime) return;
    await runtime.session.respond(requestId, permissionOutcome(permissionOptions.get(String(requestId)) ?? [], decision, optionId));
    permissionOptions.delete(String(requestId));
  }

  async function close(sessionId: number): Promise<void> {
    const runtime = sessions.get(sessionId);
    sessions.delete(sessionId);
    activeAssistantIds.delete(sessionId);
    activeReasoningIds.delete(sessionId);
    stores.delete(sessionId);
    await runtime?.session.close().catch(() => undefined);
  }

  function onRequest(sessionId: number, request: AcpServerRequest): void {
    const params = request.params ?? {};
    if (request.method.includes('permission') || request.method.includes('request_permission')) {
      const toolCall = rec(params.toolCall);
      const options = (Array.isArray(params.options) ? params.options : []).map(rec).filter((option): option is Json => option !== null);
      const access = stores.get(sessionId)?.access ?? 'ask';
      const autoAnswer = get(chatAutoAnswerInline);
      const offered = approvalOptions(options);
      const toolKind = str(toolCall?.kind);
      const outcome = agent === 'antigravity'
        ? acpApprovalDecision(
            access === 'ask' ? 'supervised' : access,
            toolKind ?? undefined,
            offered.map(({ id, label, kind }) => ({ id, label, kind: kind ?? undefined })),
            { toolCallId: str(toolCall?.toolCallId) ?? undefined },
          )
        : null;
      if (outcome || (agent !== 'antigravity' && autoApproves(access, toolKind, autoAnswer))) {
        void sessions.get(sessionId)?.session.respond(request.requestId, permissionOutcome(options, 'accept', outcome?.option.id)).catch(() => undefined);
        return;
      }
      permissionOptions.set(String(request.requestId), options);
      stores.update(sessionId, (state) => ({ approvals: [...state.approvals, { requestId: request.requestId, kind: 'other', title: str(toolCall?.title) ?? 'Allow this agent action?', detail: str(params.title) ?? str(params.description) ?? str(params.command) ?? str(toolCall?.kind), ...(offered.length ? { options: offered } : {}) }] }));
    } else {
      const kind = askKindFor(request.method);
      const parsed = kind ? parseAcpQuestions(kind, params) : null;
      if (kind && parsed) {
        const ask = { kind, questions: parsed.questions, title: parsed.title, index: 0, answers: {} as Record<string, string> };
        pendingAsks.set(askKey(sessionId, request.requestId), ask);
        stores.update(sessionId, (state) => ({ approvals: [...state.approvals, askApproval(request.requestId, ask)] }));
        return;
      }
      void sessions.get(sessionId)?.session.respond(request.requestId, {}, { code: -32601, message: `Spacron cannot answer ${request.method}` });
    }
  }

  function onNotification(sessionId: number, notification: Json): void {
    const params = rec(notification.params) ?? notification;
    const update = rec(params.update) ?? params;
    applyConfigOptions(sessionId, update);
    const kind = String(update.sessionUpdate ?? update.type ?? '').toLowerCase().replace(/[-\s]/g, '_');
    const isAssistantChunk = kind === 'agent_message_chunk' || kind === 'assistant_message_chunk' || kind === 'text_delta' || kind === 'message_chunk';
    const isReasoningChunk = kind === 'agent_thought_chunk' || kind === 'assistant_thought_chunk' || kind === 'thought_chunk' || kind === 'reasoning_chunk';
    // A reply after tools is a new message, even when the provider reuses its
    // transport id. Appending it to earlier commentary moves the answer above
    // the tools and makes the activity appear to arrive after the final reply.
    if (isAssistantChunk) activeReasoningIds.delete(sessionId);
    else if (isReasoningChunk || kind.includes('tool_call') || kind.includes('tool_result') || kind.includes('user_message')) {
      activeAssistantIds.delete(sessionId);
      if (!isReasoningChunk) activeReasoningIds.delete(sessionId);
    }
    const fallbackId = isAssistantChunk
      ? (activeAssistantIds.get(sessionId) ?? `acp-${sessionId}-assistant-${++segmentSequence}`)
      : isReasoningChunk
        ? (activeReasoningIds.get(sessionId) ?? `acp-${sessionId}-reasoning-${++segmentSequence}`)
        : `acp-${sessionId}-event-${++segmentSequence}`;
    if (isAssistantChunk && fallbackId) activeAssistantIds.set(sessionId, fallbackId);
    if (isReasoningChunk && fallbackId) activeReasoningIds.set(sessionId, fallbackId);
    const item = chatItemForAcpUpdate(agent, notification, fallbackId);
    if (item) {
      if ((isAssistantChunk || isReasoningChunk) && (item.kind === 'assistant' || item.kind === 'reasoning')) stores.append(sessionId, fallbackId!, item.kind, item.text);
      else {
        if (item.kind === 'tool' && item.toolData) {
          const previous = stores.get(sessionId)?.items.find((entry) => entry.id === item.id);
          item.toolData = { ...rec(previous?.toolData), ...rec(item.toolData) };
        }
        stores.upsert(sessionId, item);
      }
    }
    // A session update can be tool progress or replayed history. The prompt
    // request owns the working state and its result settles the turn.
    if (kind.includes('usage')) {
      const usage = rec(update.usage) ?? update;
      const used = typeof usage.used === 'number'
        ? usage.used
        : typeof usage.totalTokens === 'number'
          ? usage.totalTokens
          : typeof usage.inputTokens === 'number' ? usage.inputTokens : null;
      const window = typeof usage.contextWindow === 'number'
        ? usage.contextWindow
        : typeof usage.modelContextWindow === 'number' ? usage.modelContextWindow : null;
      stores.update(sessionId, { contextUsed: used, contextWindow: window });
    }
    if (kind.includes('error')) stores.update(sessionId, { error: textFrom(update.error ?? update.message ?? update) || 'The agent reported an error.' });
  }

  return {
    agent,
    label: launch.label,
    capabilities: capabilitiesForAgent(agent),
    get: stores.get.bind(stores),
    subscribe: stores.subscribe.bind(stores),
    start,
    send,
    interrupt,
    setModel,
    setEffort,
    setAccess,
    answerApproval,
    close,
    models: (sessionId) => stores.get(sessionId)?.models ?? [],
    conversationId: (sessionId) => stores.get(sessionId)?.threadId ?? null,
    subagents: (sessionId) => stores.get(sessionId)?.subagents ?? [],
  };
}

export function createAcpProvider(agent: string): StructuredChatProvider {
  return makeProvider(agent);
}

export const acpProvider = createAcpProvider('opencode');
