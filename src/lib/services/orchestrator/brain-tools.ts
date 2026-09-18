/** Shared tools for native provider calls and legacy text-only callers. */

export type BrainToolName =
  | 'read_project'
  | 'read_file'
  | 'glob_files'
  | 'grep_code'
  | 'write_file'
  | 'save_document'
  | 'edit_file'
  | 'run_command'
  | 'command_status'
  | 'cancel_command'
  | 'read_tool_result'
  | 'list_terminals'
  | 'list_agents'
  | 'get_agent_output'
  | 'wait_for_agent'
  | 'update_todos'
  | 'ask_user'
  | 'ask_question';

export interface BrainToolCall {
  /** Client-generated id so results can be matched back. Optional from model. */
  id: string;
  name: BrainToolName;
  args: Record<string, unknown>;
}

export interface BrainToolResult {
  id: string;
  name: BrainToolName;
  ok: boolean;
  /** Compact text fed back to the model (already truncated by executor). */
  output: string;
}

export interface BrainToolDef {
  name: BrainToolName;
  description: string;
  /** JSON-schema-ish hint for the model; kept human-readable on purpose. */
  parameters: string;
}

export const BRAIN_TOOL_DEFS: BrainToolDef[] = [
  { name: 'command_status', description: 'Read a background command status and paginated output. Poll until an exit code is known before claiming success.', parameters: '{"id":"command id", "offset":0}' },
  { name: 'cancel_command', description: 'Stop one background command owned by this conversation.', parameters: '{"id":"command id"}' },
  { name: 'read_tool_result', description: 'Retrieve the next page of an earlier tool result by its id, including evidence compacted from context.', parameters: '{"id":"tool result id", "offset":0}' },
  {
    name: 'read_project',
    description: 'Read the relevant text files across the active project for broad reconnaissance and review. Skips dependencies, build output, hidden state, and binary files; capped for safety. Use this FIRST for any multi-step task to understand the codebase before planning. This is the Explore step in the Explore-Plan-Code workflow.',
    parameters: '{"max_files": "80 (optional, maximum 120)"}',
  },
  {
    name: 'read_file',
    description: 'Read a repo-relative file with start_line, line_count and optional start_char paging. Follow the returned continuation to read the entire file.',
    parameters: '{"path": "src/lib/auth.ts (required, repo-relative)"}',
  },
  {
    name: 'glob_files',
    description: 'Find files by glob pattern (e.g. "src/**/*.ts", "*.json"). Read-only; capped. Prefer over guessing paths.',
    parameters: '{"pattern": "src/**/*.ts (required)", "max": "20 (optional)"}',
  },
  {
    name: 'grep_code',
    description: 'Search file contents with plain text or regex (ripgrep-backed). Read-only; capped. Prefer over reading whole trees.',
    parameters: '{"query": "authenticate (required)", "include_glob": "src/**/*.ts (optional)", "use_regex": "false (optional)"}',
  },
  {
    name: 'write_file',
    description: 'Create or overwrite a small repo-relative file. Coordinator fast-path ONLY for surgical changes (notes, reports, tiny fixes) — large coding work goes to an agent via spawn/send.',
    parameters: '{"path": "notes/todo.md (required, repo-relative)", "content": "<full file text> (required)"}',
  },
  {
    name: 'save_document',
    description: 'Save a generated document in the user Documents folder. Choose a descriptive filename yourself; do not ask the user for a filename unless they explicitly require a specific one.',
    parameters: '{"filename": "descriptive filename with extension (optional)", "content": "<full file text> (required)"}',
  },
  {
    name: 'edit_file',
    description: 'Precise string replacement in a repo-relative file. old_string must match EXACTLY and UNAMBIGUOUSLY (one occurrence). Small surgical changes only — large work goes to an agent.',
    parameters: '{"path": "src/lib/auth.ts (required)", "old_string": "<exact text> (required)", "new_string": "<replacement> (required)"}',
  },
  {
    name: 'run_command',
    description: 'Run a shell command and get its exit code + output back IN THIS TURN (tests, typecheck, build). Runs hidden in the project shell; output capped. Prefer verification commands.',
    parameters: '{"command": "npm test (required)", "timeout_s": "90 (optional, 5-300)"}',
  },
  {
    name: 'list_terminals',
    description: 'Re-read the live terminal list (labels, running/busy, recent output tail). Use when the user asks what terminals are open or whether something finished.',
    parameters: '{}',
  },
  {
    name: 'list_agents',
    description: 'Re-read running agents plus recent task status/output. Use before send/close or when asked what agents are doing.',
    parameters: '{}',
  },
  {
    name: 'get_agent_output',
    description: 'Get the fuller recent output of ONE agent by name. Use when asked what an agent said/wrote, or to check progress before replying.',
    parameters: '{"name": "Iris (required)"}',
  },
  {
    name: 'wait_for_agent',
    description: 'Check ONE agent\'s coordination status for the monitor loop: WORKING (still going — poll again later), BLOCKED (relayed question — surface it to the user), COMPLETE/FAILED (report it). Never infer done from silence — only from this.',
    parameters: '{"name": "Iris (required)"}',
  },
  {
    name: 'update_todos',
    description: 'Create or update the complete high-level plan for this turn. For multi-step work, send the FULL plan in one call after reconnaissance, normally 3-6 grouped items covering exploration, implementation, questions or delegation, and verification. The first call is the plan of record: a later call that omits an unfinished item is rejected and you must resend the COMPLETE list, so always repeat every unfinished item and only change its status markers. Add an item only for genuinely discovered work, never as a paraphrase or replacement; use [-] to drop one. Use [~] before starting an item, [x] only when a tool result proves it, and [!] with the blocking reason. Keep exactly one item in_progress.',
    parameters: '{"todos": ["[~] Inspect the orchestrator routing and todo lifecycle", "[ ] Fix full-plan reconciliation", "[ ] Add regression coverage", "[ ] Run focused verification"], "required": true, "marker-prefixed": true}',
  },
  {
    name: 'ask_user',
    description: 'Ask the user ONE blocking question and stop this turn. Use only when you cannot safely continue (missing file/path, implementation choice, credential, destructive decision).',
    parameters: '{"question": "Which module should I change? (required)"}',
  },
  {
    name: 'ask_question',
    description: 'Ask the user a blocking multiple-choice question (e.g. relaying a worker\'s question with its options) and stop this turn. Prefer over ask_user when there are clear options.',
    parameters: '{"question": "Iris asks: use Postgres or SQLite? (required)", "options": "[\\"Postgres\\", \\"SQLite\\"] (optional)", "target": "Iris (optional: agent waiting on the answer)"}',
  },
];

export const BRAIN_TOOL_NAMES: ReadonlySet<string> = new Set(
  BRAIN_TOOL_DEFS.map((d) => d.name),
);

/** Tools safe to run concurrently (read-only, no ordering hazards). */
export const BRAIN_READONLY_TOOLS: ReadonlySet<BrainToolName> = new Set([
  'command_status',
  'read_tool_result',
  'read_project',
  'read_file',
  'glob_files',
  'grep_code',
  'list_terminals',
  'list_agents',
  'get_agent_output',
  'wait_for_agent',
]);

/** Tools that mutate state — the loop runs these sequentially, in order. */
export const BRAIN_WRITE_TOOLS: ReadonlySet<BrainToolName> = new Set([
  'cancel_command',
  'write_file',
  'save_document',
  'edit_file',
  'run_command',
]);

/** Tools that end the turn as a blocking question for the user. */
export const BRAIN_ASK_TOOLS: ReadonlySet<BrainToolName> = new Set([
  'ask_user',
  'ask_question',
]);

/** The planner: available in every mode, mutates only turn-local plan state. */
export const PLAN_TOOL: BrainToolName = 'update_todos';

/**
 * Capability profiles per brain mode (the report's §15): mutating tools are
 * REMOVED in ask/plan mode rather than prompt-discouraged, so a read-only turn
 * cannot write a file even if the model tries. `full` is the only profile with
 * write/execute tools; every profile keeps reads and the todo planner.
 */
export type BrainMode = 'ask' | 'plan' | 'full';

export function brainToolProfile(mode: BrainMode): { allowed: ReadonlySet<BrainToolName>; mutating: boolean } {
  const readOnly: BrainToolName[] = [
    'read_project',
    'read_file',
    'glob_files',
    'grep_code',
    'command_status',
    'read_tool_result',
    'list_terminals',
    'list_agents',
    'get_agent_output',
    'wait_for_agent',
  ];
  if (mode === 'full') {
    return {
      allowed: new Set<BrainToolName>([...readOnly, PLAN_TOOL, 'write_file', 'save_document', 'edit_file', 'run_command', 'cancel_command', 'ask_user', 'ask_question']),
      mutating: true,
    };
  }
  return {
    allowed: new Set<BrainToolName>([...readOnly, PLAN_TOOL, 'ask_user', 'ask_question']),
    mutating: false,
  };
}

/** Max tool calls accepted per round (OpenCode batches; we stay small). */
export const MAX_TOOL_CALLS_PER_ROUND = Number.POSITIVE_INFINITY;

/** Per-tool output cap applied by the executor before feeding back. */
export const BRAIN_TOOL_OUTPUT_CAP = 32_000;

/** Larger cap for the deliberate broad-review snapshot, still bounded. */
export const BRAIN_REVIEW_OUTPUT_CAP = 120_000;

/** Same tool + same args this many times in a row = doom loop, stop. */
export const DOOM_LOOP_THRESHOLD = 3;

export function isBrainToolName(raw: unknown): raw is BrainToolName {
  return typeof raw === 'string' && BRAIN_TOOL_NAMES.has(raw);
}

/** Prompt fragment appended to the system prompt so every provider sees the tools. */
export function buildBrainToolsPrompt(): string {
  const lines = BRAIN_TOOL_DEFS.map(
    (d) => `- ${d.name} ${d.parameters} — ${d.description}`,
  );
  return [
    '',
    'TOOLS — you have these tools. Use them instead of guessing about files, terminals, or agents:',
    ...lines,
    '',
    'How to respond (ONLY one JSON object, no prose):',
    '- FINAL (you are done): {"reply": "<detailed report>", "needsInput": <bool>, "actions": [ ... ]} — return this only when the entire task or question is completely answered and verified.',
    '- TOOL REQUEST (you need data first): {"tool_calls": [{"id": "1", "name": "read_file", "args": {"path": "package.json"}}], "reply": "<optional one-line status>"}',
    '- PLAN STATE: declare and track your plan ONLY through the update_todos tool — never as a "todos" array inside your JSON. After reconnaissance, establish the COMPLETE plan in one call, normally 3-6 concise top-level items. Group related sub-steps, and do not silently omit verification or a required question.',
    '- You may request MULTIPLE independent calls in one turn (e.g. read package.json + glob src/**/*.ts together). Reads run concurrently; writes run sequentially in order.',
    '- After the app returns {"tool_results": [...]}, continue: call more tools or return FINAL.',
    '- Set needsInput to true only when a required answer blocks safe progress; optional follow-ups stay conversational.',
    '- DIRECT-FIRST: review, audit, inspect, explain, summarize, recommend, suggest, and "go through the application" requests belong to you. Use the supplied app state and read tools, then return a FINAL answer with no agent action unless the user explicitly requested an agent.',
    '- For a broad review or "go through the application" request, call read_project first. It returns a bounded snapshot of the relevant text files. Do not return FINAL until you have reviewed that result and can give concrete recommendations in this same turn.',
    '- A broad review is not a reason to delegate. Batch read-only calls, synthesize evidence, and make concrete recommendations yourself. If you use glob_files instead of read_project, immediately read the returned paths in batches and do not stop at the file list.',
    '- NEVER return a bare acknowledgement with no actions and no tool_calls when the user asked for work — that ends the turn and nothing happens.',
    '- COORDINATOR LOOP: to monitor a worker, call wait_for_agent(name). WORKING → keep waiting (return FINAL with no actions and let the next user turn re-check, or poll once more). BLOCKED → relay its question via ask_question and stop. COMPLETE/FAILED → report the result.',
    '- DIRECT EDITS & EXECUTION: You can inspect, edit, write, and verify files directly using read_file, edit_file, write_file, and run_command. Perform multi-step work iteratively across tool rounds. Only delegate to an agent via spawn/send when the user explicitly requests an agent or for massive parallel sub-projects.',
    '- run_command is SYNC: it runs hidden and returns `exit <code>` plus the output tail in the same turn. Chain verification yourself: run tests → read failures → edit → re-run.',
    '- run_command is WRITE-class: it runs sequentially, never in parallel with edits. Long-running servers/watchers do NOT belong here — use the `run` action for those.',
    '- SELF-CORRECTION: If a command exits non-zero or an edit fails to match, inspect the error output in the next tool round, adjust the code, and re-verify. Do not stop until the task is working.',
    '- ask_user / ask_question END the turn: return {"reply": "<the question>", "needsInput": true, "actions": []} after calling it, or directly when one question blocks you.',
    '- If the same tool with the same arguments fails 3 times in a row, STOP calling it — summarize what you learned and either delegate differently or ask the user.',
    '- REPORT STYLE: Match the final response to the task. Simple questions and small edits should receive a natural concise answer. Reviews, investigations, multi-step changes, and verification work should receive a breakdown with substantive sections for what is working, what is not working, what needs improvement, and evidence. Do not emit empty headings or force the breakdown when it adds no value.',
    '- PLAN WITH update_todos: for any multi-step task, first inspect the project, then call update_todos once with the complete 3-6 item plan. Repeat that same full list on later updates, changing statuses rather than appending paraphrases. Add a new item only when execution discovers genuinely new work, and include the reason in the next progress update. Keep exactly one [~] in_progress. The app renders your list live and closes items only from successful tool results, so never claim completion in the todo list itself.',
    '- AUTOMATIC VERIFICATION: When all implementation tasks are complete, automatically run verification commands (npm test, npm run typecheck, npm run build, or the project\'s equivalent) BEFORE returning FINAL. If verification fails, fix the issues and re-verify. Include verification evidence in the final breakdown when the task is substantial; do not force a formal report for a simple answer.',
    '- DEPENDENCY ORDER: When tasks have dependencies (dependsOn), never mark a task as in_progress until all its dependencies are completed. The system enforces this automatically, but you should plan dependencies correctly when creating your todo list.',
  ].join('\n');
}

/** Extract model-provided to-do items from a JSON response if present. */
export function parseBrainTodos(raw: string): string[] | null {
  const trimmed = raw.trim();
  const unfenced = trimmed.replace(/^```(?:json)?\s*([\s\S]*?)\s*```$/i, '$1').trim();
  const match = unfenced.match(/\{[\s\S]*\}/);
  if (!match) return null;
  try {
    const parsed: unknown = JSON.parse(match[0]);
    if (!parsed || typeof parsed !== 'object') return null;
    const obj = parsed as Record<string, unknown>;
    if (Array.isArray(obj.todos)) {
      const items = obj.todos
        .map((item) => {
          if (typeof item === 'string') return item.trim();
          if (item && typeof item === 'object' && 'label' in item && typeof (item as any).label === 'string') {
            return (item as any).label.trim();
          }
          return '';
        })
        .filter(Boolean);
      if (items.length) return items;
    }
    if (typeof obj.plan === 'string' && obj.plan.trim()) {
      const lines = obj.plan.split('\n').map((line) => line.trim()).filter(Boolean);
      if (lines.length) return lines;
    }
  } catch {
    return null;
  }
  return null;
}

/** A parsed TOOL REQUEST from the model. Null when the raw text is a FINAL answer. */
export function parseBrainToolCalls(raw: string): BrainToolCall[] | null {
  const trimmed = raw.trim();
  const unfenced = trimmed.replace(/^```(?:json)?\s*([\s\S]*?)\s*```$/i, '$1').trim();
  const match = unfenced.match(/\{[\s\S]*\}/);
  if (!match) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(match[0]);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== 'object') return null;
  const obj = parsed as Record<string, unknown>;
  if (!Array.isArray(obj.tool_calls)) return null;
  const calls: BrainToolCall[] = [];
  let n = 0;
  for (const entry of obj.tool_calls) {
    if (n >= MAX_TOOL_CALLS_PER_ROUND) break;
    if (!entry || typeof entry !== 'object') continue;
    const e = entry as Record<string, unknown>;
    if (!isBrainToolName(e.name)) continue;
    const args =
      e.args && typeof e.args === 'object'
        ? (e.args as Record<string, unknown>)
        : {};
    n += 1;
    calls.push({
      id: typeof e.id === 'string' && e.id ? e.id : `tool-${n}`,
      name: e.name,
      args,
    });
  }
  return calls.length ? calls : null;
}

/** Stable signature for doom-loop detection (same tool + same args). */
export function brainToolSignature(call: Pick<BrainToolCall, 'name' | 'args'>): string {
  return `${call.name}:${JSON.stringify(call.args ?? {})}`;
}

/** True when the trailing signatures are all identical (stuck in a retry loop). */
export function isDoomLoop(signatures: string[]): boolean {
  if (signatures.length < DOOM_LOOP_THRESHOLD) return false;
  const tail = signatures.slice(-DOOM_LOOP_THRESHOLD);
  return tail.every((s) => s === tail[0]);
}

/** Render executed tool results back into user-text the model can continue from. */
export function formatBrainToolResults(results: BrainToolResult[]): string {
  return results
    .map((r) => {
      const head = `tool_result ${r.id} (${r.name}, ${r.ok ? 'ok' : 'error'}):`;
      const cap = r.name === 'read_project' ? BRAIN_REVIEW_OUTPUT_CAP : BRAIN_TOOL_OUTPUT_CAP;
      const body = r.output.trim().slice(0, cap) || '(empty)';
      return `${head}\n${body}`;
    })
    .join('\n\n');
}

export function toolArgStr(args: Record<string, unknown>, key: string): string {
  const v = args[key];
  return typeof v === 'string' ? v.trim() : '';
}

export function toolArgNum(args: Record<string, unknown>, key: string, fallback: number): number {
  const v = args[key];
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  if (typeof v === 'string' && v.trim() !== '' && Number.isFinite(Number(v.trim()))) {
    return Number(v.trim());
  }
  return fallback;
}

export function toolArgBool(args: Record<string, unknown>, key: string, fallback = false): boolean {
  const v = args[key];
  if (typeof v === 'boolean') return v;
  if (typeof v === 'string') {
    const t = v.trim().toLowerCase();
    if (t === 'true' || t === '1' || t === 'yes') return true;
    if (t === 'false' || t === '0' || t === 'no') return false;
  }
  return fallback;
}

export function toolArgStrArr(args: Record<string, unknown>, key: string): string[] {
  const v = args[key];
  if (!Array.isArray(v)) return [];
  return v
    .filter((x): x is string => typeof x === 'string')
    .map((x) => x.trim())
    .filter((x) => x.length > 0);
}
