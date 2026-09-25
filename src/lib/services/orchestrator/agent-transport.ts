import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { attachedImagePaths } from './chat-turn';
import { activeBrainToolDefs, parseBrainToolCalls, brainToolProfile, type BrainMode, type BrainToolName, type BrainToolCall, type BrainToolResult } from './brain-tools';

type Property = { type: string; items?: { type: string }; minimum?: number; description?: string };
const str: Property = { type: 'string' };
const num: Property = { type: 'integer', minimum: 0 };
const bool: Property = { type: 'boolean' };
/** A fractional number. Screen coordinates are normalized 0.0–1.0, so `num` — which is integer-only — would reject every tap but the corners. */
const dec: Property = { type: 'number' };
/** A signed step count: desktop_scroll's dx/dy go negative for up and left. `num` has a floor of 0. */
const signed: Property = { type: 'integer', minimum: -50 };
const definitions: Record<string, { required: string[]; properties: Record<string, Property> }> = {
  read_project: { required: [], properties: { max_files: num, offset: num } },
  read_file: { required: ['path'], properties: { path: str, start_line: { type: 'integer', minimum: 1 }, line_count: num, start_char: num } },
  glob_files: { required: ['pattern'], properties: { pattern: str, max: num, offset: num } },
  grep_code: { required: ['query'], properties: { query: str, include_glob: str, use_regex: bool, case_sensitive: bool, whole_word: bool, offset: num, max: num } },
  write_file: { required: ['path', 'content'], properties: { path: str, content: str, expected_content: str } },
  save_document: { required: ['content'], properties: { filename: str, content: str } },
  edit_file: { required: ['path', 'old_string', 'new_string'], properties: { path: str, old_string: str, new_string: str, replace_all: bool } },
  run_command: { required: ['command'], properties: { command: str, timeout_s: num, background: bool } },
  command_status: { required: ['id'], properties: { id: str, offset: num } },
  cancel_command: { required: ['id'], properties: { id: str } },
  read_tool_result: { required: ['id'], properties: { id: str, offset: num } },
  list_terminals: { required: [], properties: { offset: num } },
  list_agents: { required: [], properties: { offset: num } },
  get_agent_output: { required: ['name'], properties: { name: str } },
  wait_for_agent: { required: ['name'], properties: { name: str } },
  update_todos: { required: ['todos'], properties: { todos: { type: 'array', items: str } } },
  ask_user: { required: ['question'], properties: { question: str } },
  ask_question: { required: ['question'], properties: { question: str, options: { type: 'array', items: str }, target: str } },
  list_app_commands: { required: [], properties: { query: str } },
  run_app_command: { required: ['id'], properties: { id: str } },
  emulator_list: { required: [], properties: {} },
  emulator_boot: { required: ['target'], properties: { target: str, platform: str } },
  emulator_shutdown: { required: ['target'], properties: { target: str, platform: str } },
  emulator_screenshot: { required: ['target'], properties: { target: str, platform: str } },
  emulator_tap: { required: ['target', 'x', 'y'], properties: { target: str, x: dec, y: dec } },
  emulator_swipe: { required: ['target', 'x1', 'y1', 'x2', 'y2'], properties: { target: str, x1: dec, y1: dec, x2: dec, y2: dec, duration_ms: num } },
  emulator_key: { required: ['target', 'key'], properties: { target: str, key: str } },
  emulator_text: { required: ['target', 'text'], properties: { target: str, text: str } },
  emulator_rotate: { required: ['target'], properties: { target: str, rotation: num } },
  emulator_logcat: { required: ['target'], properties: { target: str, lines: num, filter: str } },
  desktop_list_windows: { required: [], properties: { reason: str } },
  desktop_ui_tree: { required: ['window'], properties: { window: str, depth: num, reason: str } },
  desktop_find: { required: ['window'], properties: { window: str, query: str, role: str, reason: str } },
  desktop_screenshot: { required: ['window'], properties: { window: str, reason: str } },
  desktop_focus_window: { required: ['window'], properties: { window: str, reason: str } },
  desktop_click: { required: ['window'], properties: { window: str, ref: str, x: dec, y: dec, button: str, double: bool, reason: str } },
  desktop_type: { required: ['window', 'text'], properties: { window: str, text: str, ref: str, replace: bool, reason: str } },
  desktop_key: { required: ['window', 'keys'], properties: { window: str, keys: str, reason: str } },
  desktop_scroll: { required: ['window'], properties: { window: str, ref: str, x: dec, y: dec, dx: signed, dy: signed, reason: str } },
  desktop_drag: { required: ['window'], properties: { window: str, from_ref: str, from_x: dec, from_y: dec, to_ref: str, to_x: dec, to_y: dec, reason: str } },
  // Mirrors Playwright MCP 0.0.82's own input schemas exactly: the server
  // rejects what it does not declare, and so does this check.
  browser_navigate: { required: ['url'], properties: { url: str } },
  browser_navigate_back: { required: [], properties: {} },
  browser_snapshot: { required: [], properties: { target: str, depth: dec } },
  browser_find: { required: [], properties: { text: str, regex: str } },
  browser_take_screenshot: { required: ['scale'], properties: { scale: str, type: str, fullPage: bool, target: str, element: str } },
  browser_console_messages: { required: ['level'], properties: { level: str, all: bool } },
  browser_network_requests: { required: ['static'], properties: { static: bool, filter: str } },
  browser_network_request: { required: ['index'], properties: { index: num, part: str } },
  browser_tabs: { required: ['action'], properties: { action: str, index: dec, url: str } },
  browser_wait_for: { required: [], properties: { time: dec, text: str, textGone: str } },
  browser_click: { required: ['target'], properties: { target: str, element: str, doubleClick: bool, button: str, modifiers: { type: 'array', items: str } } },
  browser_hover: { required: ['target'], properties: { target: str, element: str } },
  browser_type: { required: ['target', 'text'], properties: { target: str, text: str, element: str, submit: bool, slowly: bool } },
  browser_select_option: { required: ['target', 'values'], properties: { target: str, values: { type: 'array', items: str }, element: str } },
  browser_press_key: { required: ['key'], properties: { key: str } },
  browser_drag: { required: ['startTarget', 'endTarget'], properties: { startTarget: str, endTarget: str, startElement: str, endElement: str } },
  browser_handle_dialog: { required: ['accept'], properties: { accept: bool, promptText: str } },
  browser_resize: { required: ['width', 'height'], properties: { width: dec, height: dec } },
  browser_close: { required: [], properties: {} },
  browser_evaluate: { required: ['function'], properties: { function: str, target: str, element: str } },
  mcp_list_tools: { required: [], properties: { server: str } },
  // `arguments` is the target tool's own input, validated by its server.
  mcp_call_tool: { required: ['server', 'tool'], properties: { server: str, tool: str, arguments: { type: 'object' } } },
  generate_image: { required: ['prompt'], properties: { prompt: str, reference_images: { type: 'array', items: str } } },
  generate_video: { required: ['prompt'], properties: { prompt: str, reference_image: str } },
};

export function nativeTools(allowed?: ReadonlySet<BrainToolName>) {
  return activeBrainToolDefs()
    .filter((d) => !allowed || allowed.has(d.name))
    .map(d => ({ name: d.name, description: d.description,
      parameters: { type: 'object', ...definitions[d.name], additionalProperties: false } }));
}

/** The active tool profile for a turn, from its explicit mode or its budgets. */
export function profileForTurn(mode: BrainMode | undefined, budgets?: AgentBudgets): { allowed: ReadonlySet<BrainToolName>; mutating: boolean } {
  return brainToolProfile(budgets?.toolProfile ?? mode ?? 'full');
}

/**
 * Snap a model-supplied argument to the schema type when the text form is
 * unambiguous ("80" → 80, "true" → true). Models frequently stringify numeric
 * and boolean arguments; rejecting the whole call (the old behaviour) killed
 * every tool call in the round, the turn's evidence stayed empty, and the
 * recovery passes then failed the turn as "no evidence" — a whole operation
 * lost to a quoting quirk.
 */
function coerceArg(value: unknown, p: Property): { ok: true; value: unknown } | { ok: false } {
  if (p.type === 'integer') {
    if (typeof value === 'number') return Number.isSafeInteger(value) && value >= (p.minimum ?? 0) ? { ok: true, value } : { ok: false };
    if (typeof value === 'string' && value.trim() !== '' && Number.isFinite(Number(value.trim()))) {
      const n = Number(value.trim());
      return Number.isSafeInteger(n) && n >= (p.minimum ?? 0) ? { ok: true, value: n } : { ok: false };
    }
    return { ok: false };
  }
  if (p.type === 'number') {
    if (typeof value === 'number') return Number.isFinite(value) ? { ok: true, value } : { ok: false };
    if (typeof value === 'string' && value.trim() !== '' && Number.isFinite(Number(value.trim()))) {
      return { ok: true, value: Number(value.trim()) };
    }
    return { ok: false };
  }
  if (p.type === 'boolean') {
    if (typeof value === 'boolean') return { ok: true, value };
    if (typeof value === 'string') {
      const t = value.trim().toLowerCase();
      if (t === 'true' || t === '1' || t === 'yes') return { ok: true, value: true };
      if (t === 'false' || t === '0' || t === 'no') return { ok: true, value: false };
    }
    return { ok: false };
  }
  if (p.type === 'string') {
    if (typeof value === 'string') return { ok: true, value };
    if (typeof value === 'number' && Number.isFinite(value)) return { ok: true, value: String(value) };
    if (typeof value === 'boolean') return { ok: true, value: String(value) };
    return { ok: false };
  }
  if (p.type === 'object') {
    const isPlain = (v: unknown) => !!v && typeof v === 'object' && !Array.isArray(v);
    if (isPlain(value)) return { ok: true, value };
    // Models sometimes pass the object as JSON text.
    if (typeof value === 'string') {
      if (!value.trim()) return { ok: true, value: {} };
      try {
        const parsed: unknown = JSON.parse(value);
        return isPlain(parsed) ? { ok: true, value: parsed } : { ok: false };
      } catch {
        return { ok: false };
      }
    }
    return { ok: false };
  }
  if (p.type === 'array') {
    if (Array.isArray(value)) return value.some(v => typeof v !== 'string') ? { ok: false } : { ok: true, value };
    if (typeof value === 'string') {
      const parts = value.split(',').map(s => s.trim()).filter(Boolean);
      return parts.length ? { ok: true, value: parts } : { ok: false };
    }
    return { ok: false };
  }
  return { ok: false };
}

export function validateToolCall(call: BrainToolCall): string | null {
  const schema = definitions[call.name];
  if (!schema) return `Unknown tool: ${call.name}`;
  if (!call.args || typeof call.args !== 'object' || Array.isArray(call.args)) return 'Arguments must be an object';
  for (const key of schema.required) if (!(key in call.args)) return `Missing argument: ${key}`;
  for (const [key, value] of Object.entries(call.args)) {
    const p = schema.properties[key];
    if (!p) return `Unknown argument: ${key}`;
    const coerced = coerceArg(value, p);
    if (!coerced.ok) return `Invalid ${key}: expected ${p.type}`;
    // Coerce in place so the executor sees the corrected type.
    call.args[key] = coerced.value;
  }
  return null;
}

export interface AgentExchange { assistant: unknown; results: BrainToolResult[] }
export interface AgentCheckpoint {
  provider: string;
  model: string;
  exchanges: AgentExchange[];
  /** Full tool outputs survive compaction and can be retrieved by id. */
  results: BrainToolResult[];
  summary: string;
  pending?: BrainToolCall[];
  pendingAssistant?: unknown;
  /**
   * Set once the model proved it cannot take native tools (catalogue says so,
   * or the provider rejected the tools param). Persisted with the checkpoint
   * because text-mode exchanges cannot be replayed as native ones: a resumed
   * turn must keep speaking the protocol its history was written in.
   */
  textFallback?: boolean;
}
interface Response { text: string; calls: BrainToolCall[]; assistant: unknown; finishReason: string; usage: unknown }
export interface AgentBudgets {
  contextChars?: number; outputTokens?: number; maxRounds?: number; toolMode?: 'native' | 'text'; toolProfile?: BrainMode;
  /** Provider-native reasoning level for this turn; already checked against the model. */
  reasoningEffort?: string;
}
export const DEFAULT_AGENT_BUDGETS = {
  outputTokens: 32_768,
  contextChars: 128_000,
  maxRounds: 50,
} as const;

/**
 * English prose and source code both run around 3.5 characters per token, so
 * this converts a model's advertised window into the character budget every
 * prompt-sizing decision here uses.
 */
export const CHARS_PER_TOKEN = 3.5;
/** Room left inside the window for the system prompt, the reply and tool schemas. */
const CONTEXT_HEADROOM_TOKENS = 12_000;

/**
 * How many characters of prompt this turn may use: the user's own limit when
 * they set one in Task limits, otherwise the model's real window converted
 * from tokens. The conversion is the point — comparing a token count against
 * a character length treated a 128k-token model as a 128k-CHARACTER one, a
 * quarter of its actual room, which forced needless compaction and extra
 * round trips on exactly the big reviews that need the space.
 */
export function contextCharBudget(
  budgets?: AgentBudgets,
  capabilities?: { contextTokens?: number },
): number {
  if (budgets?.contextChars) return budgets.contextChars;
  const tokens = capabilities?.contextTokens;
  if (!tokens) return DEFAULT_AGENT_BUDGETS.contextChars;
  return Math.max(DEFAULT_AGENT_BUDGETS.contextChars, Math.floor(Math.max(8_000, tokens - CONTEXT_HEADROOM_TOKENS) * CHARS_PER_TOKEN));
}

/**
 * Native protocol requires one result per assistant tool_call (id+name).
 * Profile stripping and unknown names must not drop a call from the recorded
 * exchange — that is `protocol: tool results do not match the assistant calls`
 * on the next round. Unavailable calls become error results instead.
 */
export function alignToolResults(expected: BrainToolCall[], results: BrainToolResult[], unavailable: (call: BrainToolCall) => string): BrainToolResult[] {
  const provided = new Map(results.map((result) => [result.id, result]));
  return expected.map((call) => {
    const got = provided.get(call.id);
    if (got && got.name === call.name) {
      return { id: call.id, name: call.name, ok: got.ok, output: got.output, ...(got.images?.length ? { images: got.images } : {}) };
    }
    return { id: call.id, name: call.name, ok: false, output: unavailable(call) };
  });
}

/** Receives a request's visible reply text while it streams (display only). */
export interface ReplyStreamSink {
  /** A request (or a retry of it) is starting: forget any earlier text. */
  start(): void;
  delta(text: string): void;
}

export class AgentTransport {
  state: AgentCheckpoint;
  /** Set to stream replies; without it requests are sent unstreamed. */
  stream?: ReplyStreamSink;
  /** Capability profile: which tools this transport may offer or accept. */
  private profile = brainToolProfile('full');
  private response?: Response;
  /** Provider-emitted calls before profile stripping; record() must cover all of them. */
  private nativeCalls: BrainToolCall[] = [];
  private capabilities?: { contextTokens?: number; outputTokens?: number; nativeTools?: boolean; images?: boolean };
  constructor(private provider: string, private model: string, checkpoint?: AgentCheckpoint,
    private save?: (state: AgentCheckpoint) => void | Promise<void>, private signal?: AbortSignal,
    private budgets: AgentBudgets = {}) {
    this.state = checkpoint?.provider === provider && checkpoint.model === model
      ? structuredClone(checkpoint) : { provider, model, exchanges: [], results: [], summary: '' };
    this.profile = profileForTurn(undefined, budgets);
    // A reload during a mutation cannot prove whether it completed. Never replay it.
    if (this.state.pending?.length && this.state.pendingAssistant) {
      this.state.exchanges.push({ assistant: this.state.pendingAssistant, results: this.state.pending.map(c => ({ id: c.id, name: c.name, ok: false,
        output: 'Interrupted: outcome is unknown. Inspect the current file/command state before deciding what to do; do not blindly repeat a mutation.' })) });
      delete this.state.pending;
      delete this.state.pendingAssistant;
    }
  }
  private unavailableResult(call: BrainToolCall): string {
    if (!definitions[call.name]) return `error: unknown tool: ${call.name}`;
    if (!this.profile.allowed.has(call.name as BrainToolName)) return `error: ${call.name} is not available in this mode`;
    return 'error: tool was not executed';
  }
  private async persist() { await this.save?.(structuredClone(this.state)); }
  /** Text tool protocol: chosen in Task limits, or fallen back to for a tool-less model. */
  private get textMode(): boolean { return this.budgets.toolMode === 'text' || this.state.textFallback === true; }
  /**
   * `outputTokensOverride` raises this request's visible-output budget above
   * the turn's configured one. The brain uses it for the JSON protocol
   * recovery pass after a reasoning model truncated its FINAL reply — the
   * scratchpad consumed the budget, so the fix is headroom, not a lecture.
   * It stays capability-aware: the model catalogue's own output cap wins.
   */
  async request(systemPrompt: string, userText: string, baseUrl?: string, sessionId?: string, final = false, outputTokensOverride?: number): Promise<string> {
    this.signal?.throwIfAborted();
    if (!this.capabilities) this.capabilities = await invoke('ai_agent_capabilities', { provider: this.provider, model: this.model, baseUrl }).catch(() => ({})) ?? {};
    this.signal?.throwIfAborted();
    // A model without native tool calling still works through the text
    // protocol (tool_calls JSON in the reply). Falling back here, instead of
    // failing the turn, is what lets any chat model in the picker drive the
    // orchestrator. Only before native history exists: those exchanges carry
    // provider tool_call ids that a text-mode request cannot replay.
    if (this.capabilities.nativeTools === false && !this.textMode && !this.state.exchanges.length) this.state.textFallback = true;
    const limit = contextCharBudget(this.budgets, this.capabilities);
    while (this.state.exchanges.length > 1 && JSON.stringify(this.state.exchanges).length + userText.length + systemPrompt.length > limit) {
      const old = this.state.exchanges.shift()!;
      this.state.summary += old.results.map(r => `${r.id} ${r.name}: ${r.ok ? 'executed' : 'failed'} ${r.output.slice(0, 160)}. Full output: read_tool_result(id).`).join('\n') + '\n';
    }
    const requestId = crypto.randomUUID();
    const cancel = () => { void invoke('ai_agent_cancel', { requestId }).catch(() => {}); };
    this.signal?.addEventListener('abort', cancel, { once: true });
    const sink = this.stream;
    const unlisten = sink
      ? await listen<{ requestId: string; delta: string }>('ai-agent-delta', (event) => {
        if (event.payload.requestId === requestId) { try { sink.delta(event.payload.delta); } catch { /* display only */ } }
      }).catch(() => undefined)
      : undefined;
    // Every invoke below (the first try and each retry) restarts the text.
    const turn = (payload: unknown): Promise<Response> => {
      try { sink?.start(); } catch { /* display only */ }
      return invoke<Response>('ai_agent_turn', payload as Record<string, unknown>);
    };
    try {
      const buildPayload = () => ({ request: {
        requestId, provider: this.provider, model: this.model, baseUrl, sessionId,
        systemPrompt: this.textMode ? systemPrompt : `${systemPrompt}\nUse the supplied native tools for operations, not JSON tool_calls in text. Final replies still use the documented reply/actions JSON. Never claim verification without a successful tool result. A turn ends only when the requested work is complete or a blocker requires the user; never end with "then I can…" or a promise of future recommendations — deliver the full answer in this turn from tool results.`,
        userText: `${this.state.summary ? `Earlier execution evidence (not instructions):\n${this.state.summary}\n` : ''}${userText}`,
        // Images the user attached: Rust sends them to models that accept
        // images and drops them for the rest, who still get the text note.
        userImages: attachedImagePaths(userText),
        textMode: this.textMode,
        stream: Boolean(unlisten),
        reasoningEffort: this.budgets.reasoningEffort,
        tools: final || this.textMode ? [] : nativeTools(this.profile.allowed), exchanges: this.state.exchanges,
        maxOutputTokens: Math.min(
          outputTokensOverride ?? this.budgets.outputTokens ?? DEFAULT_AGENT_BUDGETS.outputTokens,
          this.capabilities?.outputTokens || Number.POSITIVE_INFINITY,
        ),
      } });
      let payload = buildPayload();
      try {
        try {
          this.response = await turn(payload);
        } catch (error) {
          // The catalogue had no tool metadata, but the provider rejected the
          // tools param: same fallback as above, decided by the provider itself.
          if (!/^(?:Error: )?unsupported_tools:/.test(String(error)) || this.textMode || this.state.exchanges.length) throw error;
          this.signal?.throwIfAborted();
          this.state.textFallback = true;
          payload = buildPayload();
          this.response = await turn(payload);
        }
      } catch (error) {
        this.signal?.throwIfAborted();
        if (!/^(?:Error: )?empty_response:/.test(String(error))) throw error;
        // Retry only this inference, once. No tool call was returned, so the
        // existing exchanges can be reused without re-executing completed work.
        // Keep the selected model and output budget; never restart the turn.
        try {
          this.response = await turn(payload);
        } catch (retryError) {
          this.signal?.throwIfAborted();
          if (/^(?:Error: )?empty_response:/.test(String(retryError))) {
            throw new Error('empty_response: the model returned no usable answer or tool calls on two attempts. Retry later or choose another model; completed tool results are preserved.');
          }
          throw retryError;
        }
      }
      this.signal?.throwIfAborted();
      if (!this.response || !Array.isArray(this.response.calls)) throw new Error('protocol: invalid agent response');
      if (this.textMode) this.response.calls = parseBrainToolCalls(this.response.text) ?? [];
      // Keep the provider's full call list. The next round's request_body
      // re-parses assistant.tool_calls and requires a result for each one.
      this.nativeCalls = this.response.calls.slice();
      // Mode enforcement is physical, not prompt-based: a tool outside the
      // profile never reaches the executor, even if the provider emitted one.
      const executable = this.nativeCalls.filter(call => this.profile.allowed.has(call.name as BrainToolName));
      if (executable.some(call => !definitions[call.name])) throw new Error('protocol: unknown tool; no operations executed');
      if (this.nativeCalls.length) {
        const ids = this.nativeCalls.map(c => c.id);
        if (new Set(ids).size !== ids.length) throw new Error('protocol: duplicate tool IDs');
        this.state.pending = this.nativeCalls;
        this.state.pendingAssistant = this.response.assistant;
        await this.persist();
        this.response.calls = executable;
        if (!executable.length) {
          // Nothing the executor may run, but assistant.tool_calls is non-empty.
          // Close the exchange with error results so the next round is valid.
          await this.record([]);
          return JSON.stringify({ tool_calls: [] });
        }
        return JSON.stringify({ tool_calls: executable });
      }
      return this.response.text;
    } finally { this.signal?.removeEventListener('abort', cancel); unlisten?.(); }
  }
  async record(results: BrainToolResult[]) {
    const expected = this.nativeCalls.length ? this.nativeCalls : this.response?.calls ?? [];
    const aligned = alignToolResults(expected, results, (call) => this.unavailableResult(call));
    if (expected.length) this.state.exchanges.push({ assistant: this.response?.assistant, results: aligned });
    this.state.results.push(...aligned);
    this.nativeCalls = [];
    delete this.state.pending;
    delete this.state.pendingAssistant;
    await this.persist();
  }
}

/** Line + character paging supports both ordinary files and huge single-line files. */
export function filePage(text: string, startLine = 1, lineCount = 200, startChar = 0): string {
  const lines = text.split('\n');
  const start = Math.max(0, Math.floor(startLine) - 1);
  const end = Math.min(lines.length, start + Math.max(1, Math.floor(lineCount)));
  const content = lines.slice(start, end).map((line, i) => `${start + i + 1}: ${line}`).join('\n');
  const page = content.slice(startChar, startChar + 12_000);
  const next = startChar + page.length < content.length
    ? `Continue: start_line=${start + 1}, line_count=${end - start}, start_char=${startChar + page.length}`
    : end < lines.length ? `Continue: start_line=${end + 1}, start_char=0` : 'End of file';
  return `Lines ${start + 1}-${end} of ${lines.length}\n${page}\n${next}`;
}
