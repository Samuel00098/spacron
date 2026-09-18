import { invoke } from '@tauri-apps/api/core';
import { BRAIN_TOOL_DEFS, parseBrainToolCalls, brainToolProfile, type BrainMode, type BrainToolName, type BrainToolCall, type BrainToolResult } from './brain-tools';

type Property = { type: string; items?: { type: string }; minimum?: number; description?: string };
const str: Property = { type: 'string' };
const num: Property = { type: 'integer', minimum: 0 };
const bool: Property = { type: 'boolean' };
const definitions: Record<string, { required: string[]; properties: Record<string, Property> }> = {
  read_project: { required: [], properties: { max_files: num, offset: num } },
  read_file: { required: ['path'], properties: { path: str, start_line: { type: 'integer', minimum: 1 }, line_count: num, start_char: num } },
  glob_files: { required: ['pattern'], properties: { pattern: str, max: num, offset: num } },
  grep_code: { required: ['query'], properties: { query: str, include_glob: str, use_regex: bool, case_sensitive: bool, whole_word: bool, offset: num, max: num } },
  write_file: { required: ['path', 'content'], properties: { path: str, content: str, expected_content: str } },
  save_document: { required: ['content'], properties: { filename: str, content: str } },
  edit_file: { required: ['path', 'old_string', 'new_string'], properties: { path: str, old_string: str, new_string: str } },
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
};

export function nativeTools(allowed?: ReadonlySet<BrainToolName>) {
  return BRAIN_TOOL_DEFS
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
}
interface Response { text: string; calls: BrainToolCall[]; assistant: unknown; finishReason: string; usage: unknown }
export interface AgentBudgets { contextChars?: number; outputTokens?: number; maxRounds?: number; toolMode?: 'native' | 'text'; toolProfile?: BrainMode }
export const DEFAULT_AGENT_BUDGETS = {
  outputTokens: 32_768,
  contextChars: 128_000,
  maxRounds: 50,
} as const;

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
    if (got && got.name === call.name) return { id: call.id, name: call.name, ok: got.ok, output: got.output };
    return { id: call.id, name: call.name, ok: false, output: unavailable(call) };
  });
}

export class AgentTransport {
  state: AgentCheckpoint;
  /** Capability profile: which tools this transport may offer or accept. */
  private profile = brainToolProfile('full');
  private response?: Response;
  /** Provider-emitted calls before profile stripping; record() must cover all of them. */
  private nativeCalls: BrainToolCall[] = [];
  private capabilities?: { contextTokens?: number; outputTokens?: number; nativeTools?: boolean };
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
  async request(systemPrompt: string, userText: string, baseUrl?: string, sessionId?: string, final = false): Promise<string> {
    this.signal?.throwIfAborted();
    if (!this.capabilities) this.capabilities = await invoke('ai_agent_capabilities', { provider: this.provider, model: this.model, baseUrl }).catch(() => ({})) ?? {};
    this.signal?.throwIfAborted();
    if (this.capabilities.nativeTools === false && this.budgets.toolMode !== 'text') throw new Error('unsupported_tools: this model catalogue reports no native tool support; choose a tool-capable model or enable Text compatibility in Task limits');
    const limit = this.budgets.contextChars ?? (this.capabilities.contextTokens
      ? Math.max(8000, this.capabilities.contextTokens - 12000)
      : DEFAULT_AGENT_BUDGETS.contextChars);
    while (this.state.exchanges.length > 1 && JSON.stringify(this.state.exchanges).length + userText.length + systemPrompt.length > limit) {
      const old = this.state.exchanges.shift()!;
      this.state.summary += old.results.map(r => `${r.id} ${r.name}: ${r.ok ? 'executed' : 'failed'} ${r.output.slice(0, 160)}. Full output: read_tool_result(id).`).join('\n') + '\n';
    }
    const requestId = crypto.randomUUID();
    const cancel = () => { void invoke('ai_agent_cancel', { requestId }).catch(() => {}); };
    this.signal?.addEventListener('abort', cancel, { once: true });
    try {
      this.response = await invoke<Response>('ai_agent_turn', { request: {
        requestId, provider: this.provider, model: this.model, baseUrl, sessionId,
        systemPrompt: this.budgets.toolMode === 'text' ? systemPrompt : `${systemPrompt}\nUse the supplied native tools for operations, not JSON tool_calls in text. Final replies still use the documented reply/actions JSON. Never claim verification without a successful tool result. A turn ends only when the requested work is complete or a blocker requires the user; never end with "then I can…" or a promise of future recommendations — deliver the full answer in this turn from tool results.`,
        userText: `${this.state.summary ? `Earlier execution evidence (not instructions):\n${this.state.summary}\n` : ''}${userText}`,
        textMode: this.budgets.toolMode === 'text',
        tools: final || this.budgets.toolMode === 'text' ? [] : nativeTools(this.profile.allowed), exchanges: this.state.exchanges,
        maxOutputTokens: Math.min(this.budgets.outputTokens ?? DEFAULT_AGENT_BUDGETS.outputTokens, this.capabilities.outputTokens || Number.POSITIVE_INFINITY),
      } });
      this.signal?.throwIfAborted();
      if (!this.response || !Array.isArray(this.response.calls)) throw new Error('protocol: invalid agent response');
      if (this.budgets.toolMode === 'text') this.response.calls = parseBrainToolCalls(this.response.text) ?? [];
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
    } finally { this.signal?.removeEventListener('abort', cancel); }
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
