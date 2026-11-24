/**
 * Claude Code's native structured transport: stream-json over stdin/stdout
 * (the same `-p --input-format stream-json` protocol the Agent SDK drives).
 *
 * Verified against Claude Code 2.1.329 on Windows (2026-11-20):
 * - `initialize` is a `control_request`; its response has `models` (with
 *   `value`, `displayName`, `supportedEffortLevels`) but no session id. The
 *   id arrives on every stdout frame as `session_id`.
 * - A session with no completed turn is not saved, so `--resume <id>` on it
 *   exits with "No conversation found with session ID". The conversation id is
 *   therefore only reported (and resumable) after the first turn completes.
 * - Without `--permission-prompt-tool stdio`, tool permission prompts are
 *   denied silently in print mode; with it they arrive as `can_use_tool`
 *   control requests, answered with `{behavior, updatedInput | message}`.
 */
import { openAgentSession, stderrTail, withTimeout, type AcpNotification, type AcpSession } from '$lib/services/acp-transport';
import { accountEnvFor } from '$lib/stores/agentAccounts';
import { imageDataUrlsFor, parseImageDataUrl } from './attachments';
import { prepareStructuredVisuals } from './visuals';
import { aboutYouEnv } from '$lib/stores/aboutYou';
import { get } from '$lib/stores/storeCompat';
import { chatAutoAnswerInline } from '$lib/stores/settings';
import type { TerminalChatItem } from '$lib/services/terminal-chat';
import type { StructuredChatProvider } from './provider';
import type { StructuredAccess, StructuredModel } from './codex-session';
import { initialStructuredState, StructuredStateStore } from './state';
import { answeredInput, isAskUserQuestion, parseAskUserQuestion, type ClaudeQuestion } from './claude-questions';
import type { StructuredApproval } from './codex-session';

/** One `AskUserQuestion` question as an approval card whose options are the answers. */
function questionApproval(requestId: string, questions: ClaudeQuestion[], index: number): StructuredApproval {
  const q = questions[index];
  const progress = questions.length > 1 ? ` (${index + 1} of ${questions.length})` : '';
  const described = q.options.filter((option) => option.description).map((option) => `${option.label}: ${option.description}`);
  return {
    requestId,
    kind: 'other',
    title: `${q.header ? `${q.header}: ` : ''}${q.question}${progress}`,
    detail: [q.multiSelect ? 'Claude allows several answers; pick the main one here.' : null, ...described].filter(Boolean).join('\n') || null,
    options: q.options.map((option, i) => ({ id: String(i), label: option.label, kind: 'allow_once' })),
  };
}

type Json = Record<string, unknown>;
const str = (value: unknown): string | null => typeof value === 'string' ? value : null;
const rec = (value: unknown): Json | null => value && typeof value === 'object' && !Array.isArray(value) ? value as Json : null;

function textFrom(value: unknown): string {
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) return value.map(textFrom).filter(Boolean).join('');
  const row = rec(value);
  return row ? textFrom(row.text ?? row.delta ?? row.content ?? row.output ?? row.message) : '';
}

const CLAUDE_EFFORTS = new Set(['low', 'medium', 'high', 'xhigh', 'max']);
const INITIALIZE_TIMEOUT_MS = 60_000;

interface Runtime {
  session: AcpSession;
  cwd: string;
  requestId: number;
  /** Claude's session id from its frames; reported once a turn has completed. */
  pendingSessionId: string | null;
  controls: Map<string, { resolve: (frame: Json) => void; reject: (error: Error) => void }>;
  /** Tool input per permission request, echoed back as `updatedInput`. */
  permissionInputs: Map<string, { input: Json; suggestions: unknown }>;
  /** `AskUserQuestion` requests in progress: answered one question at a time. */
  questions: Map<string, { input: Json; questions: ClaudeQuestion[]; index: number; answers: Record<string, string> }>;
  stderr: ReturnType<typeof stderrTail>;
  exited: boolean;
}

const stores = new StructuredStateStore();
const sessions = new Map<number, Runtime>();

function nextId(runtime: Runtime): string {
  runtime.requestId += 1;
  return `spacron-claude-${Date.now()}-${runtime.requestId}`;
}

function permissionMode(access: StructuredAccess | undefined): string | null {
  if (access === 'full-access') return 'bypassPermissions';
  if (access === 'auto') return 'acceptEdits';
  return null;
}

/** The CLI arguments for a structured Claude session. Exported for tests. */
export function claudeArgs(options: { effort?: string | null; resumeId?: string | null; access?: StructuredAccess }): string[] {
  const args = [
    '-p',
    '--input-format', 'stream-json',
    '--output-format', 'stream-json',
    '--verbose',
    '--permission-prompt-tool', 'stdio',
    // Lets "Full access" be switched on later in the session; it is not
    // enabled by this flag alone.
    '--allow-dangerously-skip-permissions',
  ];
  const mode = permissionMode(options.access);
  if (mode) args.push('--permission-mode', mode);
  if (options.effort && CLAUDE_EFFORTS.has(options.effort)) args.push('--effort', options.effort);
  if (options.resumeId) args.push('--resume', options.resumeId);
  return args;
}

/**
 * Claude's `get_context_usage` control response (seen live, 2026-11-21):
 * `{ categories: [{ name, tokens, kind: 'used'|'deferred'|'buffer'|'free' }],
 * totalTokens, maxTokens }`. Only the categories that really occupy the window
 * are listed; deferred, buffer and free space are not "used".
 */
export function contextUsageFrom(response: unknown): { contextUsed: number; contextWindow: number | null; contextBreakdown: { name: string; tokens: number }[] } | null {
  const r = rec(response);
  const total = typeof r?.totalTokens === 'number' ? r.totalTokens : null;
  if (total == null) return null;
  const categories = Array.isArray(r?.categories) ? r.categories : [];
  const breakdown = categories.flatMap((entry) => {
    const c = rec(entry);
    return c && c.kind === 'used' && typeof c.name === 'string' && typeof c.tokens === 'number' && c.tokens > 0 ? [{ name: c.name, tokens: c.tokens }] : [];
  });
  return { contextUsed: total, contextWindow: typeof r?.maxTokens === 'number' ? r.maxTokens : null, contextBreakdown: breakdown };
}

export function modelFrom(raw: unknown): StructuredModel | null {
  if (typeof raw === 'string') return { id: raw, label: raw, description: null, efforts: [], defaultEffort: null, isDefault: false };
  const row = rec(raw);
  if (!row) return null;
  const id = str(row.value) ?? str(row.id) ?? str(row.model);
  if (!id) return null;
  const rawEfforts = row.supportedEffortLevels ?? row.efforts ?? row.reasoningEfforts ?? rec(row.options)?.effort;
  const efforts = Array.isArray(rawEfforts)
    ? rawEfforts.map((item) => str(rec(item)?.value) ?? str(rec(item)?.id) ?? str(item)).filter((item): item is string => !!item)
    : [];
  return {
    id,
    label: str(row.displayName) ?? str(row.name) ?? id,
    description: str(row.description),
    efforts: row.supportsEffort === false ? [] : efforts,
    defaultEffort: str(row.defaultEffort) ?? str(row.defaultReasoningEffort),
    isDefault: row.isDefault === true || id === 'default',
  };
}

function toolSummary(name: string | null, input: Json): string {
  const pick = str(input.command) ?? str(input.file_path) ?? str(input.path) ?? str(input.pattern) ?? str(input.url) ?? str(input.description);
  return pick ? pick.slice(0, 400) : name ?? '';
}

/**
 * Map one Claude stream-json frame to chat items. An assistant frame can hold
 * text, thinking and tool calls together; a user frame carries tool results.
 */
export function chatItemsForClaude(frame: Json): TerminalChatItem[] {
  const type = str(frame.type);
  const message = rec(frame.message);
  const id = str(frame.uuid) ?? str(message?.id) ?? `claude-${Date.now()}`;
  const content = Array.isArray(message?.content) ? message.content.map(rec).filter((part): part is Json => part !== null) : [];
  const items: TerminalChatItem[] = [];

  if (type === 'assistant') {
    content.forEach((part, index) => {
      const partType = str(part.type);
      const partId = content.length > 1 ? `${id}-${index}` : id;
      if (partType === 'text' && str(part.text)?.trim()) items.push({ id: partId, kind: 'assistant', text: str(part.text)! });
      else if (partType === 'thinking' && str(part.thinking)?.trim()) items.push({ id: partId, kind: 'reasoning', text: str(part.thinking)! });
      else if (partType === 'tool_use') {
        const input = rec(part.input) ?? {};
        const name = str(part.name) ?? 'tool';
        const isSubagent = name.toLowerCase() === 'agent' || name.toLowerCase() === 'task' || 'subagent_type' in input || 'subagentType' in input;
        const subagentId = isSubagent ? str(part.id) ?? `sub-${Date.now()}` : undefined;
        items.push({ id: str(part.id) ?? partId, kind: 'tool', text: toolSummary(name, input), toolName: name, toolInput: JSON.stringify(input), toolData: input, toolStatus: 'running', subagentId });
      }
    });
    if (!content.length) {
      const text = textFrom(message?.content);
      if (text) items.push({ id, kind: 'assistant', text });
    }
    return items;
  }

  if (type === 'user') {
    for (const part of content) {
      if (str(part.type) === 'tool_result' && str(part.tool_use_id)) {
        items.push({
          id: str(part.tool_use_id)!,
          kind: 'tool',
          text: '',
          toolOutput: textFrom(part.content) || null,
          toolStatus: part.is_error === true ? 'error' : 'done',
        });
      }
    }
    // Output of a local slash command (`/cost`, `/context`…) comes back as a
    // user frame wrapped in tags; show it as the command's reply.
    const text = typeof message?.content === 'string' ? message.content : '';
    const local = /<local-command-stdout>([\s\S]*?)<\/local-command-stdout>/.exec(text)?.[1]?.trim();
    if (local) items.push({ id, kind: 'command-output', text: local });
    return items;
  }

  if (type === 'result' && (frame.is_error === true || (str(frame.subtype) && str(frame.subtype) !== 'success'))) {
    const reason = textFrom(frame.result) || (Array.isArray(frame.errors) ? frame.errors.map(textFrom).join('\n') : '') || 'Claude could not finish this turn.';
    items.push({ id, kind: 'notice', text: reason });
  }
  return items;
}

/** Single-item form kept for callers that only need the first item. */
export function chatItemForClaude(frame: Json): TerminalChatItem | null {
  return chatItemsForClaude(frame)[0] ?? null;
}

function failControls(runtime: Runtime, error: Error): void {
  for (const pending of runtime.controls.values()) pending.reject(error);
  runtime.controls.clear();
}

async function control(sessionId: number, subtype: string, request: Json = {}, timeoutMs = 120_000): Promise<Json> {
  const runtime = sessions.get(sessionId);
  if (!runtime || runtime.exited) throw new Error('Claude is not running');
  const requestId = nextId(runtime);
  const pending = new Promise<Json>((resolve, reject) => runtime.controls.set(requestId, { resolve, reject }));
  await runtime.session.writeRaw(`${JSON.stringify({ type: 'control_request', request_id: requestId, request: { subtype, ...request } })}\n`);
  try {
    return await withTimeout(pending, timeoutMs, `Claude did not answer ${subtype}`);
  } finally {
    runtime.controls.delete(requestId);
  }
}

async function start(sessionId: number, cwd: string, options: { access?: StructuredAccess; resumeId?: string | null; model?: string | null; effort?: string | null; accountId?: string | null } = {}): Promise<void> {
  if (sessions.has(sessionId)) return;
  const previous = stores.get(sessionId);
  stores.set(sessionId, initialStructuredState(options.access, previous ?? undefined));
  const access = options.access ?? previous?.access ?? 'ask';
  const targetEffort = options.effort ?? previous?.effort ?? null;
  let runtime: Runtime | null = null;
  try {
    const accountEnv = await accountEnvFor('claude', options.accountId ?? null);
    const session = await openAgentSession('claude', claudeArgs({ effort: targetEffort, resumeId: options.resumeId ?? null, access }), cwd, { ...accountEnv, ...await prepareStructuredVisuals(sessionId), ...aboutYouEnv() });
    runtime = {
      session,
      cwd,
      requestId: 0,
      pendingSessionId: options.resumeId ?? null,
      controls: new Map(),
      permissionInputs: new Map(),
      questions: new Map(),
      stderr: stderrTail(session),
      exited: false,
    };
    sessions.set(sessionId, runtime);
    const current = runtime;
    await session.onNotification((notification) => onFrame(sessionId, notification));
    await session.onRawLine((line) => {
      try { onFrame(sessionId, JSON.parse(line) as Json); } catch { /* not a frame */ }
    });
    await session.onExit(() => {
      current.exited = true;
      const reason = current.stderr.text();
      failControls(current, new Error(reason ?? 'Claude exited.'));
      if (sessions.get(sessionId) !== current) return;
      stores.update(sessionId, (state) => state.status === 'closed' ? {} : { status: 'failed', error: reason ? `Claude stopped: ${reason}` : state.error ?? 'Claude stopped.' });
    });
    const initialized = await control(sessionId, 'initialize', {}, INITIALIZE_TIMEOUT_MS);
    const rawModels = initialized.models ?? rec(initialized.modelCatalog)?.models ?? [];
    const models = (Array.isArray(rawModels) ? rawModels : []).map(modelFrom).filter((model): model is StructuredModel => model !== null);
    const defaultModel = models.find((model) => model.isDefault)?.id ?? models[0]?.id ?? null;
    const targetModel = options.model ?? previous?.model ?? null;
    const chosenModel = targetModel && models.some((model) => model.id === targetModel) ? targetModel : defaultModel;
    const entry = models.find((model) => model.id === chosenModel);
    const effort = targetEffort && entry?.efforts.includes(targetEffort) ? targetEffort : entry?.defaultEffort ?? null;
    stores.update(sessionId, {
      status: 'ready',
      error: null,
      models,
      model: chosenModel,
      effort,
      access,
      threadId: options.resumeId ?? null,
    });
    if (chosenModel && chosenModel !== defaultModel) {
      void control(sessionId, 'set_model', { model: chosenModel }).catch(() => undefined);
    }
  } catch (error) {
    const reason = runtime?.stderr.text();
    const message = error instanceof Error ? error.message : String(error);
    stores.update(sessionId, { status: 'failed', error: reason && !message.includes(reason) ? `${message}: ${reason}` : message });
  }
}

async function send(sessionId: number, text: string, images: string[] = []): Promise<void> {
  const runtime = sessions.get(sessionId);
  const state = stores.get(sessionId);
  if (!runtime || !state || (!text.trim() && !images.length)) return;
  if (runtime.exited) {
    stores.update(sessionId, { status: 'failed', error: 'Claude is not running. Reconnect to continue.' });
    return;
  }
  // A path attachment has to be read before it can be sent as an image block.
  const dataUrls = await imageDataUrlsFor(images);
  stores.upsert(sessionId, { id: `user-${Date.now()}`, kind: 'user', text, images: dataUrls.length ? dataUrls : undefined });
  stores.update(sessionId, { status: 'working', error: null });
  const content: Json[] = [];
  for (const image of dataUrls) {
    const parsed = parseImageDataUrl(image);
    if (parsed) content.push({ type: 'image', source: { type: 'base64', media_type: parsed.mimeType, data: parsed.data } });
  }
  if (text.trim()) content.push({ type: 'text', text });
  if (!content.length) {
    stores.update(sessionId, { status: 'ready', error: 'Those attachments could not be read as images.' });
    return;
  }
  try {
    await runtime.session.writeRaw(`${JSON.stringify({ type: 'user', message: { role: 'user', content } })}\n`);
  } catch (error) {
    stores.update(sessionId, { status: 'failed', error: `Couldn't send to Claude: ${error instanceof Error ? error.message : String(error)}` });
  }
}

async function interrupt(sessionId: number): Promise<void> {
  try { await control(sessionId, 'interrupt', {}, 15_000); } catch { /* the turn may have just finished */ }
}

function setModel(sessionId: number, model: string): void {
  stores.update(sessionId, { model });
  void control(sessionId, 'set_model', { model }).catch((error) => stores.update(sessionId, { error: `Claude kept its model: ${error instanceof Error ? error.message : String(error)}` }));
}

function setEffort(sessionId: number, effort: string): void {
  // Claude takes effort at launch (`--effort`); it is used on the next start.
  stores.update(sessionId, { effort });
  void control(sessionId, 'apply_flag_settings', { settings: { effort } }).catch(() => undefined);
}

function setAccess(sessionId: number, access: StructuredAccess): void {
  stores.update(sessionId, { access });
  const mode = permissionMode(access) ?? 'default';
  void control(sessionId, 'set_permission_mode', { mode }).catch((error) => stores.update(sessionId, { error: `Claude kept its permission mode: ${error instanceof Error ? error.message : String(error)}` }));
}

async function answerApproval(sessionId: number, requestId: string | number, decision: 'accept' | 'acceptForSession' | 'decline', optionId?: string): Promise<void> {
  const runtime = sessions.get(sessionId);
  const asking = runtime?.questions.get(String(requestId));
  if (runtime && asking && decision !== 'decline') {
    const chosen = asking.questions[asking.index].options[Number(optionId)];
    if (chosen) {
      asking.answers[asking.questions[asking.index].question] = chosen.label;
      asking.index += 1;
      if (asking.index < asking.questions.length) {
        // Next question replaces this card; the request stays open until the last.
        stores.update(sessionId, (state) => ({
          approvals: state.approvals.map((approval) => approval.requestId === requestId ? questionApproval(String(requestId), asking.questions, asking.index) : approval),
        }));
        return;
      }
      runtime.questions.delete(String(requestId));
      stores.update(sessionId, (state) => ({ approvals: state.approvals.filter((approval) => approval.requestId !== requestId) }));
      await runtime.session.writeRaw(`${JSON.stringify({ type: 'control_response', response: { subtype: 'success', request_id: String(requestId), response: { behavior: 'allow', updatedInput: answeredInput(asking.input, asking.answers) } } })}\n`);
      return;
    }
  }
  runtime?.questions.delete(String(requestId));
  stores.update(sessionId, (state) => ({ approvals: state.approvals.filter((approval) => approval.requestId !== requestId) }));
  if (!runtime) return;
  const asked = runtime.permissionInputs.get(String(requestId));
  runtime.permissionInputs.delete(String(requestId));
  const response = decision === 'decline'
    ? { behavior: 'deny', message: 'The user declined this action.' }
    : {
      behavior: 'allow',
      updatedInput: asked?.input ?? {},
      ...(decision === 'acceptForSession' && Array.isArray(asked?.suggestions) ? { updatedPermissions: asked.suggestions } : {}),
    };
  await runtime.session.writeRaw(`${JSON.stringify({ type: 'control_response', response: { subtype: 'success', request_id: String(requestId), response } })}\n`);
}

async function close(sessionId: number): Promise<void> {
  const runtime = sessions.get(sessionId);
  sessions.delete(sessionId);
  stores.update(sessionId, { status: 'closed' });
  stores.delete(sessionId);
  if (runtime) failControls(runtime, new Error('Claude was closed'));
  await runtime?.session.close().catch(() => undefined);
}

function onFrame(sessionId: number, frame: AcpNotification | Json): void {
  const value = frame as Json;
  const runtime = sessions.get(sessionId);
  const type = str(value.type);
  const sid = str(value.session_id);
  if (runtime && sid) runtime.pendingSessionId = sid;

  if (type === 'control_response') {
    const response = rec(value.response);
    const requestId = str(response?.request_id);
    const pending = requestId ? runtime?.controls.get(requestId) : undefined;
    if (!pending) return;
    if (str(response?.subtype) === 'error') pending.reject(new Error(str(response?.error) ?? str(rec(response?.error)?.message) ?? 'Claude rejected the request'));
    else pending.resolve(rec(response?.response) ?? {});
    return;
  }
  if (type === 'control_request') {
    const request = rec(value.request);
    const requestId = str(value.request_id);
    if (request?.subtype === 'can_use_tool' && requestId) {
      const input = rec(request.input) ?? {};
      const tool = str(request.tool_name) ?? 'a tool';
      // Never auto-allowed: allowing it blind would answer with nothing.
      if (isAskUserQuestion(tool) && runtime) {
        const questions = parseAskUserQuestion(input);
        if (questions) {
          runtime.questions.set(requestId, { input, questions, index: 0, answers: {} });
          stores.update(sessionId, (state) => ({ approvals: [...state.approvals, questionApproval(requestId, questions, 0)] }));
          return;
        }
      }
      const access = stores.get(sessionId)?.access ?? 'ask';
      const autoAnswer = get(chatAutoAnswerInline);
      const isRead = /read|view|list|glob|grep|search/i.test(tool);
      const isWrite = /edit|write|create|replace/i.test(tool);
      const canAuto = access === 'full-access'
        || (access === 'auto' && (isRead || isWrite))
        || (autoAnswer && isRead);
      if (canAuto) {
        void runtime?.session.writeRaw(`${JSON.stringify({
          type: 'control_response',
          response: {
            subtype: 'success',
            request_id: requestId,
            response: { behavior: 'allow', updatedInput: input },
          },
        })}\n`).catch(() => undefined);
        return;
      }
      runtime?.permissionInputs.set(requestId, { input, suggestions: request.permission_suggestions });
      stores.update(sessionId, (state) => ({
        approvals: [...state.approvals, {
          requestId,
          kind: /bash|shell|command/i.test(tool) ? 'command' : /edit|write/i.test(tool) ? 'fileChange' : 'other',
          title: `Claude wants to use ${tool}`,
          detail: toolSummary(tool, input) || null,
        }],
      }));
    } else if (requestId && runtime) {
      // Unknown host requests must still be answered or Claude waits forever.
      void runtime.session.writeRaw(`${JSON.stringify({ type: 'control_response', response: { subtype: 'error', request_id: requestId, error: `Spacron does not handle ${String(request?.subtype)}` } })}\n`).catch(() => undefined);
    }
    return;
  }

  for (const item of chatItemsForClaude(value)) {
    // A tool result carries no summary of its own: keep the call's.
    const existing = item.kind === 'tool' && !item.text ? stores.get(sessionId)?.items.find((candidate) => candidate.id === item.id) : undefined;
    const finalItem = existing ? { ...item, text: existing.text, subagentId: existing.subagentId ?? item.subagentId } : item;
    stores.upsert(sessionId, finalItem);
    if (finalItem.subagentId) {
      const name = finalItem.toolName ?? 'subagent';
      const input = (finalItem.toolData as Record<string, unknown>) ?? {};
      const subagentSession: import('./provider').StructuredSubagentSession = {
        id: finalItem.subagentId,
        parentSessionId: sessionId,
        agent: typeof input.agent === 'string' ? input.agent : name,
        model: typeof input.model === 'string' ? input.model : undefined,
        assignment: typeof input.description === 'string' ? input.description : typeof input.prompt === 'string' ? input.prompt : name,
        status: finalItem.toolStatus === 'error' ? 'failed' : finalItem.toolStatus === 'done' ? 'completed' : 'running',
        output: finalItem.toolOutput ?? undefined,
        startedAt: Date.now(),
        ...(finalItem.toolStatus === 'done' || finalItem.toolStatus === 'error' ? { completedAt: Date.now() } : {}),
      };
      stores.update(sessionId, (s) => ({
        subagents: [...s.subagents.filter((sa) => sa.id !== finalItem.subagentId), subagentSession],
      }));
    }
  }

  if (type === 'system' && str(value.subtype) === 'init') {
    const model = str(value.model);
    if (model && !stores.get(sessionId)?.model) stores.update(sessionId, { model });
  }
  if (type === 'assistant') stores.update(sessionId, { status: 'working' });
  if (type === 'result') {
    const usage = rec(value.usage);
    const used = usage ? ['input_tokens', 'cache_read_input_tokens', 'cache_creation_input_tokens'].reduce((sum, key) => sum + (typeof usage[key] === 'number' ? usage[key] as number : 0), 0) : null;
    stores.update(sessionId, {
      status: 'ready',
      error: value.is_error === true || (str(value.subtype) && str(value.subtype) !== 'success')
        ? (textFrom(value.result) || (Array.isArray(value.errors) ? value.errors.map(textFrom).join('\n') : '') || 'Claude could not finish this turn.')
        : null,
      approvals: [],
      // The conversation now exists on disk, so it can be resumed by this id.
      threadId: runtime?.pendingSessionId ?? stores.get(sessionId)?.threadId ?? null,
      ...(used ? { contextUsed: used } : {}),
    });
    // The CLI can say what fills the window; best effort, the totals above stay.
    void control(sessionId, 'get_context_usage', {}, 15_000).then((response) => {
      const usage = contextUsageFrom(response);
      if (usage) stores.update(sessionId, usage);
    }).catch(() => undefined);
  }
}

export const claudeProvider: StructuredChatProvider = {
  agent: 'claude',
  label: 'Claude',
  capabilities: {
    // Stream-json has no rollback or fork RPC: `rewind` re-seeds a fresh
    // process from the shortened journal, `fork` copies the history into a new
    // Spacron chat. Neither is a native Claude conversation operation.
    rewind: true,
    fork: true,
    rewindMode: 'conversation-reset',
    forkMode: 'journal-branch',
    compact: 'native',
    steering: 'inject',
    contextUsage: true,
    mcp: true,
    subagents: { supported: true, spawn: false, inspectTranscript: true },
    nativeCommands: true,
    supportedAccessModes: ['ask', 'auto', 'full-access'],
  },
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
  rewind: async (sessionId, target) => {
    // Claude stream-json does not expose a native rollback RPC.
    // Returning false signals session-store to perform clean process restart
    // with re-seeded history so the model's context window does not retain the undone turn.
    return false;
  },
  fork: async (sessionId) => {
    // Claude stream-json has no native thread fork RPC. Return null so session-store
    // creates an independent journal branch rather than aliasing the parent's session file on disk.
    return { nativeSessionId: null };
  },
  steer: async (sessionId, text, images = []) => {
    await send(sessionId, text, images);
  },
  compact: async (sessionId) => {
    await send(sessionId, '/compact');
  },
  subagents: (sessionId) => stores.get(sessionId)?.subagents ?? [],
};
