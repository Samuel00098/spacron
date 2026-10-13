import { captureTranscript } from './activity-log';
import { parseBrainTodos, type BrainToolResult } from './brain-tools';
import type { ChatInlineRequest } from '$lib/types/chat';

/**
 * "create an image of a dog", "draw me a cat", "make a video of…": the user
 * wants Spacron to generate media. Conservative on purpose — "add an image
 * tag" or "make the image component responsive" is code work, not a picture.
 */
export function mediaGenerationRequest(text: string): 'image' | 'video' | null {
  const clean = text.trim();
  if (!clean || clean.length > 600) return null;
  const match = clean.match(/\b(?:create|generate|make|draw|render|produce|design|paint|sketch|illustrate|animate)\s+(?:me\s+|us\s+)?(?:(?:a|an|some|another|one|two|three|\d+)\s+)?(?:\w+\s+){0,3}?(images?|pictures?|pics?|photos?|drawings?|illustrations?|artwork|logos?|icons?|wallpapers?|videos?|animations?|clips?)\b(?!\s*(?:tags?|components?|elements?|fields?|uploads?|uploader|urls?|paths?|loaders?|carousel|gallery|props?|src|\.))/i);
  if (match) return /^(?:videos?|animations?|clips?)$/i.test(match[1]) ? 'video' : 'image';
  // "draw me a dog" / "draw a cat": drawing is always a picture.
  if (/^(?:can you |could you |please )?(?:draw|paint|sketch)\s+(?:me\s+)?(?:a|an|some)\s+\w+/i.test(clean)) return 'image';
  return null;
}

const ATTACHMENT_SUFFIX = '\n\nThe user attached these files.';

/** The user's own words, without the attachment block the store appends. */
export function userRequestText(message: string): string {
  const cut = message.indexOf(ATTACHMENT_SUFFIX);
  return (cut >= 0 ? message.slice(0, cut) : message).trim();
}

/** Paths of attached images ("saved at <path>. Inspect it…"), for reference_images. */
export function attachedImagePaths(message: string): string[] {
  const paths: string[] = [];
  const re = /--- Attached file: [^\n]* \(image\/[^)\n]*\) ---\nThe binary attachment was saved at (.+?)\. Inspect it when relevant\./g;
  for (let match = re.exec(message); match; match = re.exec(message)) paths.push(match[1]);
  return paths.slice(0, 4);
}

/** A short promise is progress copy, never evidence that the requested work finished. */
export function isPromiseOnlyReply(text: string): boolean {
  const clean = text.trim();
  if (/^(?:on it|got it|working on it|absolutely|sure)[.!]?$/i.test(clean)) return true;
  return clean.length < 550
    && !/\n\s*(?:[-*]|\d+[.)])\s/.test(clean)
    && /^(?:(?:sure|absolutely|okay|ok|got it|on it)[!,.—\s]*)?(?:i(?:['’]ll| will| am going to)|let me)\s+(?:take|look|check|inspect|read|review|map|investigate|analy[sz]e|run|implement|fix|start|work|help|coordinate|update|build|make|go|do|generate|create|draw|render|produce|design|draft)\b/i.test(clean);
}

/**
 * A deferral claims partial progress, then hands the deliverable to a future
 * exchange instead of this turn: "I've inspected the project at a high level,
 * the most valuable next step is to review the schema, then I can give you
 * concrete recommendations." The turn ended, nothing further happened, and the
 * user's actual request went unanswered. Such replies must be detected wherever
 * `isPromiseOnlyReply` is so the loop can force the work to happen now.
 *
 * Conservative on purpose: a genuine completion states findings and does not
 * defer, so any deliverable evidence (findings, recommendations, code) beats a
 * matching deferral phrase, and short conversational replies stay out.
 */
export function isDeferredCompletionReply(text: string): boolean {
  const clean = text.trim();
  if (!clean || clean.length > 1200) return false;
  // A deliverable in the reply is incompatible with a deferral: the model may
  // summarize partial observations, but it delivered the substance already.
  if (hasTurnDeliverable(clean)) return false;
  if (DEFERRAL_PHRASE_RE.test(clean)) return true;
  // Fallback: a partial-progress framing ("at a high level", "first pass")
  // combined with sequencing language ("next", "from there") is a deferral
  // even when no first-person offer phrase survived.
  return PHASE_CLAIM_RE.test(clean) && SEQUENCE_RE.test(clean);
}

const DEFERRAL_PHRASE_RE =
  /\b(?:then (?:i(?:'ll| will)? |i can )|i can (?:then )?give you|next step(?:s)? (?:is|are|would be)|once (?:you|that|this|i) |as soon as (?:you|i) |after (?:you|that) |ready (?:when|for) |waiting (?:for|on) (?:you|your)|let me know (?:if|when|how|which|what)|happy to (?:continue|proceed|dive|go deeper|walk)|want me to (?:continue|proceed|go ahead)|shall i (?:continue|proceed|go ahead)|before i (?:continue|proceed|can give|dive)|follow[- ]up (?:turn|message|reply))\b/i;

const PHASE_CLAIM_RE =
  /\b(?:high[- ]level|at a high level|overview|initial (?:look|pass|review|read)|first pass|broad strokes|to start|to begin|so far)\b/i;

const SEQUENCE_RE =
  /\b(?:next|after that|from there|then)\b/i;

/** Deliverable signals: concrete findings mean the reply answers, not postpones. */
function hasTurnDeliverable(body: string): boolean {
  if (/\n\s*(?:[-*+]|\d+[.)])\s/.test(body)) return true; // bulleted findings
  if (/```/.test(body)) return true; // code or patch output
  if (/\b(?:i recommend(?:ed)?|recommendation|findings?|here(?:'s| is) (?:what|the)|the (?:issue|problem|bug) (?:is|was)|root cause)\b/i.test(body)) return true;
  return false;
}

export function agentInputRequest(id: string, reason: string, taskId: string, sessionId: number, inferred = false): ChatInlineRequest {
  const prompt = captureTranscript(reason, 6000).trim() || 'The agent needs your input to continue.';
  if (inferred && /\b(?:y\s*\/\s*n|yes\s*\/\s*no)\b/i.test(prompt)) {
    return { id, type: 'approval', prompt, taskId, sessionId, inputMode: 'line', options: [{ id: 'yes', label: 'Yes', value: 'y' }, { id: 'no', label: 'No', value: 'n' }] };
  }
  const options = [...prompt.matchAll(/^\s*(?:[-*]\s+|\d+[.)]\s+)(.+)$/gm)]
    .slice(0, 6).map((match, index) => ({ id: String(index + 1), label: match[1].trim() }));
  return { id, type: options.length ? 'choice' : 'text', prompt, options, taskId, sessionId };
}

/**
 * Remove em dashes (—), en dashes (–), and spaced hyphen breaks from orchestrator
 * replies, replacing them with standard, natural punctuation (commas, periods,
 * or spaces).
 *
 * Preserves code fences (```...```) and inline code (`...`) untouched.
 * Preserves markdown list bullets (- item).
 * Preserves compound words (e.g. in-app, full-access).
 * Preserves negative numbers (e.g. -5).
 */
export function cleanOrchestratorReply(text: string): string {
  if (!text) return '';

  // Separate code segments so nothing inside code is altered.
  const codeRegex = /(```[\s\S]*?```|`[^`\n]*`)/g;
  const segments: Array<{ isCode: boolean; content: string }> = [];
  let lastIndex = 0;
  let match: RegExpExecArray | null;

  while ((match = codeRegex.exec(text)) !== null) {
    if (match.index > lastIndex) {
      segments.push({ isCode: false, content: text.slice(lastIndex, match.index) });
    }
    segments.push({ isCode: true, content: match[0] });
    lastIndex = match.index + match[0].length;
  }
  if (lastIndex < text.length) {
    segments.push({ isCode: false, content: text.slice(lastIndex) });
  }

  const cleaned = segments.map((seg, segIndex) => {
    if (seg.isCode) return seg.content;

    // A segment that touches inline code is mid-sentence at that edge: the
    // ", " in "`a`, `b`" is a whole segment, and trimming its "leading" comma
    // glued the code spans together ("`a``b`").
    const afterCode = segments[segIndex - 1]?.isCode === true;
    const beforeCode = segments[segIndex + 1]?.isCode === true;
    const lines = seg.content.split('\n');
    const processedLines = lines.map((line, lineIndex) => {
      // Horizontal rules (e.g. ---) are left as-is.
      if (/^\s*---+$/.test(line)) return line;

      // Extract markdown list bullet prefix if present: e.g. "  - " or "- "
      const bulletMatch = line.match(/^(\s*[-*+]\s+)(.*)$/);
      const prefix = bulletMatch ? bulletMatch[1] : '';
      let rest = bulletMatch ? bulletMatch[2] : line;

      // 1. Em dashes (—) and en dashes (–)
      // Preceded by terminal punctuation: e.g. "Done! — I have..." -> "Done! I have..."
      rest = rest.replace(/([.?!,;:])\s*[—–]\s*/g, '$1 ');
      // Between alphanumeric words: e.g. "Hello — happy" or "Hello—happy" -> "Hello, happy"
      rest = rest.replace(/([a-zA-Z0-9])\s*[—–]\s*([a-zA-Z0-9])/g, '$1, $2');
      // Any remaining em/en dashes
      rest = rest.replace(/\s*[—–]\s*/g, ', ');

      // 2. Spaced hyphens or double hyphens (e.g. "Hello - how" or "Hello -- how")
      rest = rest.replace(/([.?!,;:])\s+--?\s+/g, '$1 ');
      rest = rest.replace(/([a-zA-Z0-9])\s+--?\s+([a-zA-Z0-9])/g, '$1, $2');
      // Double hyphens without spaces: e.g. "word--word" -> "word, word"
      rest = rest.replace(/([a-zA-Z0-9])--([a-zA-Z0-9])/g, '$1, $2');

      // 3. Clean up any doubled commas or punctuation collisions
      rest = rest.replace(/,\s*,+/g, ',');
      rest = rest.replace(/([.?!;:])\s*,/g, '$1');
      rest = rest.replace(/,\s*([.?!;:])/g, '$1');

      // Clean leading or trailing standalone commas on the rest of the line
      if (!(afterCode && lineIndex === 0)) rest = rest.replace(/^,\s*/, '');
      if (!(beforeCode && lineIndex === lines.length - 1)) rest = rest.replace(/,\s*$/, '');

      return prefix + rest;
    });

    return processedLines.join('\n');
  });

  return cleaned.join('');
}

/** Friendly verb per brain tool, used for to-do items. */
const TOOL_ACTION_LABELS: Readonly<Record<string, string>> = {
  read_project: 'Review project',
  read_file: 'Read',
  glob_files: 'Find files',
  grep_code: 'Search',
  write_file: 'Write',
  save_document: 'Save document',
  edit_file: 'Edit',
  run_command: 'Run',
  command_status: 'Check command',
  cancel_command: 'Cancel',
  read_tool_result: 'Read result',
  list_terminals: 'List terminals',
  list_agents: 'List agents',
  get_agent_output: 'Read agent output',
  wait_for_agent: 'Check agent',
  ask_user: 'Ask you',
  ask_question: 'Ask you',
  list_app_commands: 'Find app command',
  run_app_command: 'Run app command',
  emulator_list: 'List devices',
  emulator_boot: 'Boot device',
  emulator_shutdown: 'Shut down device',
  emulator_screenshot: 'Capture screen',
  emulator_tap: 'Tap',
  emulator_swipe: 'Swipe',
  emulator_key: 'Press key',
  emulator_text: 'Type',
  emulator_rotate: 'Rotate',
  emulator_logcat: 'Read logcat',
  generate_image: 'Generate image',
  generate_video: 'Generate video',
};

/**
 * Gemini-style five-state todo model. The model sets these through the
 * update_todos TOOL (never through reply text), so the app owns plan state
 * and the old "attach a finished checklist to a reply" fabrication has no
 * surface to exist on. `done` on ChatTurnTodoItem stays as the derived UI
 * bit so existing consumers keep working.
 */
export type TodoStatus = 'pending' | 'in_progress' | 'completed' | 'cancelled' | 'blocked';

/** Marker prefix a model writes on an update_todos entry to set its status. */
export const TODO_STATUS_MARKERS: Readonly<Record<string, TodoStatus>> = {
  '[ ]': 'pending',
  '[~]': 'in_progress',
  '[x]': 'completed',
  '[X]': 'completed',
  '[!]': 'blocked',
  '[-]': 'cancelled',
};

/** Read a leading status marker off a todo entry, if any. */
export function todoMarkerStatus(raw: string): { status: TodoStatus | null; text: string } {
  const match = raw.trim().match(/^\[([ xX~!\-])\]\s*/);
  if (!match) return { status: null, text: raw.trim() };
  const status = TODO_STATUS_MARKERS[`[${match[1]}]`] ?? null;
  return { status, text: raw.trim().slice(match[0].length) };
}

/** The derived UI bit: completed and cancelled items are finished with. */
export function todoIsDone(status: TodoStatus | null | undefined, fallback: boolean): boolean {
  if (status === 'completed' || status === 'cancelled') return true;
  if (status) return false;
  return fallback;
}

/** One item of the live turn to-do ticker. */
export interface ChatTurnTodoItem {
  label: string;
  done: boolean;
  /** Set only when the model declared this state via update_todos. */
  status?: TodoStatus;
  /** Why an item is blocked or cancelled (model-supplied, optional). */
  reason?: string;
  /** Unique ID for dependency tracking (optional, model-supplied). */
  id?: string;
  /** IDs of tasks that must complete before this one can start. */
  dependsOn?: string[];
  /** Nested subtasks for hierarchical decomposition. */
  subtasks?: ChatTurnTodoItem[];
}

const PLAN_STEP_LABELS = Object.values(TOOL_ACTION_LABELS);

function isPlanStepLine(line: string): boolean {
  return PLAN_STEP_LABELS.some((label) => line === label || line.startsWith(`${label}: `));
}

function cleanTodoText(raw: string): string {
  return raw
    .replace(/^\s*(?:[-*+]\s+)?(?:\[[ xX]\]\s*)?/, '')
    .replace(/^\s*(?:\d+[.)]|\([0-9]+\)|(?:step|task)\s*\d+[:.-]?)\s*/i, '')
    .trim();
}

/**
 * To-do items for the live ticker and completion checklist from plan text or raw response.
 * Parses model-provided structured todos (with optional [ ]/[~]/[x]/[!]/[-] status
 * markers), markdown checklists (- [ ] ...), numbered steps (1. ...), or actionable
 * tool rows.
 */
export function parseTodoList(text: string, rawJson?: string): ChatTurnTodoItem[] {
  if (rawJson) {
    // Try to parse structured JSON with id, dependsOn, subtasks support
    try {
      const parsed = JSON.parse(rawJson.replace(/^```(?:json)?\s*([\s\S]*?)\s*```$/i, '$1').trim());
      if (parsed && typeof parsed === 'object' && Array.isArray(parsed.todos)) {
        const items = parsed.todos.map((item: unknown): ChatTurnTodoItem | null => {
          if (typeof item === 'string') {
            const { status, text: body } = todoMarkerStatus(item);
            const label = cleanTodoText(body);
            if (!label) return null;
            return {
              label,
              done: todoIsDone(status, /^\s*\[[xX]\]/.test(item) || /^\s*✓/.test(item)),
              ...(status ? { status } : {}),
            };
          }
          if (item && typeof item === 'object') {
            const obj = item as Record<string, unknown>;
            const rawLabel = typeof obj.label === 'string' ? obj.label : typeof obj.step === 'string' ? obj.step : '';
            const { status, text: body } = todoMarkerStatus(rawLabel);
            const label = cleanTodoText(body);
            if (!label) return null;
            const id = typeof obj.id === 'string' ? obj.id : undefined;
            const dependsOn = Array.isArray(obj.dependsOn) ? obj.dependsOn.filter((d): d is string => typeof d === 'string') : undefined;
            const subtasks = Array.isArray(obj.subtasks) ? parseSubtasks(obj.subtasks) : undefined;
            return {
              label,
              done: todoIsDone(status, /^\s*\[[xX]\]/.test(rawLabel) || /^\s*✓/.test(rawLabel)),
              ...(status ? { status } : {}),
              ...(id ? { id } : {}),
              ...(dependsOn?.length ? { dependsOn } : {}),
              ...(subtasks?.length ? { subtasks } : {}),
            };
          }
          return null;
        }).filter((item: ChatTurnTodoItem | null): item is ChatTurnTodoItem => Boolean(item));
        if (items.length) return items;
      }
    } catch {
      // Fall through to legacy parsing
    }

    // Legacy: flat string array from parseBrainTodos
    const jsonTodos = parseBrainTodos(rawJson);
    if (jsonTodos && jsonTodos.length) {
      return jsonTodos
        .map((item) => {
          const { status, text: body } = todoMarkerStatus(item);
          const label = cleanTodoText(body);
          if (!label) return null;
          return {
            label,
            done: todoIsDone(status, /^\s*\[[xX]\]/.test(item) || /^\s*✓/.test(item)),
            ...(status ? { status } : {}),
          } as ChatTurnTodoItem;
        })
        .filter((item): item is ChatTurnTodoItem => Boolean(item));
    }
  }

  const lines = text.split('\n').map((line) => line.trim()).filter(Boolean);
  const items: ChatTurnTodoItem[] = [];
  const seen = new Set<string>();

  for (const line of lines) {
    // 1. Tool action lines (e.g. "Review project: active project", "Run: npm test")
    if (isPlanStepLine(line)) {
      if (!seen.has(line)) {
        seen.add(line);
        items.push({ label: line, done: false });
      }
      continue;
    }

    // 2. Markdown checkbox lines (e.g. "- [ ] Inspect files", "- [x] Done")
    const checkMatch = line.match(/^\s*[-*+]\s+\[([ xX])\]\s+(.+)$/);
    if (checkMatch) {
      const label = cleanTodoText(checkMatch[2]);
      if (label && !seen.has(label)) {
        seen.add(label);
        items.push({ label, done: checkMatch[1].toLowerCase() === 'x' });
      }
      continue;
    }

    // 3. Numbered / step items (e.g. "1. Inspect auth setup", "Step 2: Edit auth.ts")
    const numMatch = line.match(/^\s*(?:\d+[.)]|\([0-9]+\)|(?:step|task)\s*\d+[:.-]?)\s+(.+)$/i);
    if (numMatch) {
      const label = cleanTodoText(numMatch[1]);
      if (label && !seen.has(label)) {
        seen.add(label);
        items.push({ label, done: false });
      }
      continue;
    }
  }

  return items;
}

/**
 * Parse an array of subtask objects into ChatTurnTodoItem[].
 */
function parseSubtasks(raw: unknown[]): ChatTurnTodoItem[] {
  return raw
    .map((item): ChatTurnTodoItem | null => {
      if (!item || typeof item !== 'object') return null;
      const obj = item as Record<string, unknown>;
      const rawLabel = typeof obj.label === 'string' ? obj.label : typeof obj.step === 'string' ? obj.step : '';
      const { status, text: body } = todoMarkerStatus(rawLabel);
      const label = cleanTodoText(body);
      if (!label) return null;
      const id = typeof obj.id === 'string' ? obj.id : undefined;
      const dependsOn = Array.isArray(obj.dependsOn) ? obj.dependsOn.filter((d): d is string => typeof d === 'string') : undefined;
      const subtasks = Array.isArray(obj.subtasks) ? parseSubtasks(obj.subtasks) : undefined;
      return {
        label,
        done: todoIsDone(status, /^\s*\[[xX]\]/.test(rawLabel) || /^\s*✓/.test(rawLabel)),
        ...(status ? { status } : {}),
        ...(id ? { id } : {}),
        ...(dependsOn?.length ? { dependsOn } : {}),
        ...(subtasks?.length ? { subtasks } : {}),
      };
    })
    .filter((item): item is ChatTurnTodoItem => Boolean(item));
}

/**
 * Synonym classes for the leading verb of a plan row, so a model re-announcing
 * "Check core backend…" after "Review core backend…" merges into one item
 * instead of appending a reworded duplicate.
 */
const TODO_VERB_CLASSES: ReadonlyArray<readonly string[]> = [
  ['review', 'inspect', 'assess', 'check', 'examine', 'survey', 'audit', 'analyze', 'analyse', 'explore', 'map', 'verify', 'look'],
  ['summarize', 'summarise', 'report', 'describe', 'document'],
  ['fix', 'repair', 'correct', 'patch'],
  ['write', 'create', 'add', 'draft'],
  ['read', 'open', 'load'],
  ['run', 'execute', 'test'],
  ['search', 'grep', 'find', 'locate', 'scan'],
];

function canonicalTodoVerb(word: string): string {
  for (const cls of TODO_VERB_CLASSES) {
    if (cls.includes(word)) return cls[0];
  }
  return word;
}

/**
 * Normalise a label for near-duplicate detection: lowercase, strip status
 * markers, list punctuation and everything but letters, digits and basic
 * path/word separators, collapse stop-words, and canonicalise the leading
 * verb to its synonym class. "Review project" and "Check: project" collapse
 * to the same key; two different intents do not.
 */
function todoKeyOf(label: string): string {
  const stripped = label
    .toLowerCase()
    .replace(/\[[ xX~!\-]\]/g, ' ')
    .replace(/^[^\p{L}\p{N}]+/u, '')
    .replace(/[^\p{L}\p{N}._/ ]+/gu, ' ')
    .replace(/\b(?:the|a|an|of|to|for|and)\b/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  const [first, ...rest] = stripped.split(' ');
  if (!first) return stripped;
  return `${canonicalTodoVerb(first)} ${rest.join(' ')}`.trim();
}

/** Cheap suffix stem so "improvements"/"improvement" and "working"/"works"
 * match in fuzzy todo comparison. Only applied to the fuzzy word sets. */
function stemTodoWord(word: string): string {
  let stem = word
    .replace(/ies$/u, 'y')
    .replace(/sses$/u, 'ss')
    .replace(/ation$/u, '');
  if (stem.length >= 5 && /[^s]s$/u.test(stem)) stem = stem.slice(0, -1);
  if (stem.length >= 6 && /ing$/u.test(stem)) stem = stem.slice(0, -3);
  if (stem.length >= 5 && /ed$/u.test(stem)) stem = stem.slice(0, -2);
  return stem;
}

/**
 * Same planned step when one key equals or word-extends the other (≥2 words,
 * so "Search" alone never matches everything), OR when both rows share their
 * leading verb class and most of their content words — the shape of a model
 * re-narrating the same task in different words ("Review Convex backend for
 * schema consistency" vs "Check Convex backend schema and auth safety").
 */
function sameTodoStep(a: string, b: string): boolean {
  if (a === b) return true;
  const shorter = a.length <= b.length ? a : b;
  const longer = a.length <= b.length ? b : a;
  const shorterWords = shorter.split(' ').filter(Boolean);
  if (shorterWords.length >= 2 && longer.startsWith(`${shorter} `)) return true;
  // Fuzzy: same verb class + a majority of shared stemmed content words —
  // the shape of a model re-narrating the same task in different words
  // ("Review Convex backend for schema consistency and performance hotspots"
  // vs "Check core backend Convex auth, schema, and query safety", or
  // "Assess backend correctness and hotspots"). Requires ≥2 shared words so
  // coincidental single overlaps ("Review alpha backend" vs "Review bravo
  // backend") never merge two genuinely different tasks.
  const [verbA, ...restA] = a.split(' ');
  const [verbB, ...restB] = b.split(' ');
  if (!verbA || verbA !== verbB) return false;
  const wordsA = restA.filter((w) => w.length >= 3).map(stemTodoWord);
  if (wordsA.length < 3) return false;
  const wordsB = restB.filter((w) => w.length >= 3).map(stemTodoWord);
  // A word hits when stemmed forms are equal OR one contains the other with a
  // ≥5-char stem (improve/improvement, working/work) — morphological variants
  // of the same content word, not coincidental overlap.
  const hits = wordsA.filter((w) => wordsB.some((v) => v === w || (v.length >= 5 && w.length >= 5 && (v.startsWith(w) || w.startsWith(v))))).length;
  return hits >= 3 && hits / wordsA.length >= 0.4;
}

/**
 * Safety ceiling for the live plan. The planner contract asks for 3-6 grouped
 * items, so this is deliberately generous: a legitimate eight-step plan is no
 * longer truncated to six, while a runaway model emitting one row per sub-check
 * is still bounded. Reaching the ceiling never discards PLANNED work — only
 * rows that are already finished are recycled, and a further addition is
 * refused (reported through `truncated`) rather than swapped in for a pending
 * item. The full plan therefore always survives to the final card.
 */
export const MAX_PLAN_ITEMS = 12;

/**
 * Resolve an incoming row to the index of the existing row it restates: an
 * explicit id is exact and wins outright, then the label key, then the fuzzy
 * step matcher. Shared by the merge and the omission check so the two can never
 * disagree about what counts as "the same row".
 */
function todoRowMatcher(current: ChatTurnTodoItem[]): (item: ChatTurnTodoItem) => number | undefined {
  const byKey = new Map<string, number>(current.map((t, i) => [todoKeyOf(t.label), i]));
  const byId = new Map<string, number>();
  current.forEach((t, i) => { if (t.id) byId.set(t.id, i); });
  return (item) => {
    if (item.id !== undefined) {
      const byIdentity = byId.get(item.id);
      if (byIdentity !== undefined) return byIdentity;
    }
    const key = todoKeyOf(item.label);
    const exact = byKey.get(key);
    if (exact !== undefined) return exact;
    for (const [existingKey, existingIndex] of byKey) {
      if (sameTodoStep(key, existingKey)) return existingIndex;
    }
    return undefined;
  };
}

/**
 * How many unmatched incoming rows stand in for omitted open rows. A model
 * re-announcing its plan in different words produces rows that match nothing,
 * while the rows they replace are "omitted" — the two are the same event. They
 * pair one-for-one, but only when the call introduces no MORE new rows than it
 * omitted: that reads as a re-statement. A call that brings more new rows than
 * it dropped reads as an expansion, so its rows are genuinely new work.
 */
function pairedReplacements(unmatchedIncoming: number, omittedOpen: number): number {
  return unmatchedIncoming <= omittedOpen ? unmatchedIncoming : 0;
}

/**
 * Stickily merge an incoming plan into the turn's live todo list. A turn that
 * re-announces its plan with reworded or shrinking steps must not churn the
 * ticker, lose finished items, or grow a near-duplicate row per retelling, so:
 *  - a row restating an existing one is RECONCILED in place — applying the
 *    model-declared status and adopting its latest wording — and never has
 *    `done` reset;
 *  - unmatched rows PAIR with the open rows the call omitted, so a wholesale
 *    re-narration refreshes those rows instead of appending duplicates;
 *  - only rows left over after that pairing are APPENDED as new work, and only
 *    while the plan is below the safety ceiling;
 *  - the ceiling is relieved with finished rows only, and no synthetic
 *    "more areas" row is ever invented. `truncated` reports a refused append
 *    so the caller can say so instead of dropping it silently.
 */
export function mergeTodoItems(
  current: ChatTurnTodoItem[],
  incoming: ChatTurnTodoItem[],
): { todos: ChatTurnTodoItem[]; changed: boolean; truncated: boolean } {
  if (!incoming.length) return { todos: current, changed: false, truncated: false };
  if (!current.length) {
    const adopted = incoming.slice(0, MAX_PLAN_ITEMS).map((t) => ({ ...t }));
    return { todos: adopted, changed: true, truncated: incoming.length > adopted.length };
  }

  let changed = false;
  let truncated = false;
  const merged = current.map((t) => ({ ...t }));

  // Pass 1 — classify. Which existing row does each incoming row restate, and
  // which open rows did this call leave out entirely?
  const matchRow = todoRowMatcher(merged);
  const claimed = incoming.map((item) => (item.label ? matchRow(item) : undefined));
  const matchedExisting = new Set(claimed.filter((index): index is number => index !== undefined));
  const unmatchedIncoming = incoming.filter((item, i) => item.label && claimed[i] === undefined);
  const omittedOpen = merged
    .map((t, i) => i)
    .filter((i) => !matchedExisting.has(i) && !todoIsDone(merged[i].status, merged[i].done));
  const paired = pairedReplacements(unmatchedIncoming.length, omittedOpen.length);

  // Pass 2 — reconcile a row in place.
  const applyRow = (index: number, item: ChatTurnTodoItem, label: string): void => {
    // A model-declared status is authoritative for its state, but a
    // completed/blocked item is never un-finished by a later re-announce.
    if (item.status && item.status !== merged[index].status && !todoIsDone(merged[index].status, merged[index].done)) {
      merged[index] = { ...merged[index], status: item.status, done: todoIsDone(item.status, merged[index].done) };
      changed = true;
    }
    // Adopt the model's latest wording for a row that is still open, so a
    // reworded re-announcement refreshes its own row instead of drifting away
    // from it and being added back later as a near-duplicate.
    if (label !== merged[index].label && !todoIsDone(merged[index].status, merged[index].done)) {
      merged[index] = { ...merged[index], label };
      changed = true;
    }
    if (item.id && !merged[index].id) {
      merged[index] = { ...merged[index], id: item.id };
      changed = true;
    }
    if (item.dependsOn?.length && !merged[index].dependsOn?.length) {
      merged[index] = { ...merged[index], dependsOn: item.dependsOn };
      changed = true;
    }
    if (item.subtasks?.length) {
      merged[index] = { ...merged[index], subtasks: mergeTodoItems(merged[index].subtasks ?? [], item.subtasks).todos };
      changed = true;
    }
  };

  claimed.forEach((index, i) => {
    if (index !== undefined) applyRow(index, incoming[i], incoming[i].label);
  });
  // Pass 3 — absorb the omissions with the unmatched rows that replace them.
  for (let k = 0; k < paired; k++) {
    applyRow(omittedOpen[k], unmatchedIncoming[k], unmatchedIncoming[k].label);
  }
  // Pass 4 — whatever is left is genuinely new work.
  // Count room after reconciliation: this update may have just finished a row.
  const recyclable = merged.filter((t) => todoIsDone(t.status, t.done) && t.status !== 'blocked').length;
  let additionsLeft = Math.max(0, MAX_PLAN_ITEMS - merged.length) + recyclable;
  for (let k = paired; k < unmatchedIncoming.length; k++) {
    if (additionsLeft <= 0) {
      truncated = true;
      continue;
    }
    additionsLeft -= 1;
    merged.push({ ...unmatchedIncoming[k] });
    changed = true;
  }
  // Relieve the ceiling with finished rows only, so room for a newly discovered
  // step is made by retiring a completed one. Pending planned work is never
  // dropped; `truncated` is how a refused addition is reported instead.
  while (merged.length > MAX_PLAN_ITEMS) {
    const finishedIndex = merged.findIndex((t) => todoIsDone(t.status, t.done) && t.status !== 'blocked');
    if (finishedIndex < 0) break;
    merged.splice(finishedIndex, 1);
    changed = true;
  }
  return { todos: merged, changed, truncated };
}

/**
 * The ONE definition of the plan's progress count, shared by the ticker, the
 * update_todos tool feedback, and the finished card so they can never disagree.
 * Status is authoritative (see `todoIsDone`); a cancelled row is dropped from
 * both sides of the fraction instead of being counted as done work.
 */
export function todoProgress(items: ChatTurnTodoItem[]): { completed: number; total: number } {
  const counted = items.filter((item) => item.status !== 'cancelled');
  return {
    completed: counted.filter((item) => todoIsDone(item.status, item.done)).length,
    total: counted.length,
  };
}

/**
 * Close out the plan at a successful turn end that did real work. The row the
 * model was working (`in_progress`) and legacy status-less rows are finished by
 * that evidence, since models routinely skip the last `[x]` re-announcement.
 * Rows the model explicitly left `pending` are NOT: painting never-started work
 * green is what made the ticker read 5/5 for a turn that did three things.
 * Status and `done` are set together so every counter agrees.
 */
export function closeOutTodoItems(items: ChatTurnTodoItem[]): ChatTurnTodoItem[] {
  return items.map((item) => (item.status === undefined || item.status === 'in_progress'
    ? { ...item, status: 'completed', done: true }
    : { ...item, done: todoIsDone(item.status, item.done) }));
}

/**
 * Rows of a turn's FIRST plan that merely re-state work finished in the
 * previous turn. The finished card writes its checklist into the transcript,
 * so on a follow-up ("also add X") models copy every `[x]` row into the new
 * plan and append X, and the list grew by the whole history on every message.
 * Only rows the model itself declares completed are carried over: a PENDING row
 * matching old work is a real redo request ("run the tests again") and stays.
 */
export function splitCarriedOverTodos(
  previous: ChatTurnTodoItem[],
  incoming: ChatTurnTodoItem[],
): { fresh: ChatTurnTodoItem[]; carried: ChatTurnTodoItem[] } {
  const finished = previous.filter((item) => item.status !== 'cancelled' && todoIsDone(item.status, item.done));
  if (!finished.length) return { fresh: incoming, carried: [] };
  const matchRow = todoRowMatcher(finished);
  const fresh: ChatTurnTodoItem[] = [];
  const carried: ChatTurnTodoItem[] = [];
  for (const item of incoming) {
    if (item.status === 'completed' && matchRow(item) !== undefined) carried.push(item);
    else fresh.push(item);
  }
  return { fresh, carried };
}

/**
 * Fewer unfinished rows than this is a plan the model is still forming, not an
 * established one, so it may be freely restated. Only an established plan is
 * enforced as authoritative.
 */
const MIN_ESTABLISHED_PLAN_ITEMS = 2;

/**
 * The unfinished items of the authoritative plan that a later update left out
 * with nothing standing in for them. The first update_todos of a turn
 * establishes the plan; once it has real shape, a later call that silently
 * drops unfinished work is ambiguous — a paraphrase the matcher missed, a real
 * removal, or a forgotten row — and guessing is what turned reworded
 * re-announcements into appended duplicates. The runtime asks for the complete
 * list instead.
 *
 * Rows an unmatched incoming row replaces are not omissions (see
 * `pairedReplacements`), so this only reports the surplus. Returns [] for a stub
 * plan (under MIN_ESTABLISHED_PLAN_ITEMS unfinished rows), letting a model still
 * replace its opening one-liner with the real plan, and [] when nothing is
 * missing. Finished rows are ignored: a completed item legitimately stops being
 * re-announced.
 */
export function findOmittedPlanItems(current: ChatTurnTodoItem[], incoming: ChatTurnTodoItem[]): ChatTurnTodoItem[] {
  const open = current.filter((item) => !todoIsDone(item.status, item.done));
  if (open.length < MIN_ESTABLISHED_PLAN_ITEMS) return [];
  const matchRow = todoRowMatcher(current);
  const matchedExisting = new Set<number>();
  let unmatchedIncoming = 0;
  for (const item of incoming) {
    if (!item.label) continue;
    const index = matchRow(item);
    if (index === undefined) unmatchedIncoming += 1;
    else matchedExisting.add(index);
  }
  const omittedOpen: ChatTurnTodoItem[] = [];
  current.forEach((item, i) => {
    if (!matchedExisting.has(i) && !todoIsDone(item.status, item.done)) omittedOpen.push(item);
  });
  // A re-statement pairs its new wording with the rows it replaced; only the
  // surplus it left behind is a real omission.
  return omittedOpen.slice(pairedReplacements(unmatchedIncoming, omittedOpen.length));
}

/**
 * One indexed Documents/ file the brain can reference at turn start.
 */
export interface DocumentsIndexEntry {
  /** Repo-relative path, e.g. docs/plans/2026-09-17-onboarding-plan.md */
  path: string;
  /** First markdown heading, or the filename in prose form. */
  title: string;
  /** First line of body prose, so the brain can tell plans from reports. */
  excerpt?: string;
}

const DOCUMENTS_INDEX_MAX_ENTRIES = 12;

/**
 * Prompt block listing previously written Documents/ files. Null when the
 * project has none, so no empty header is ever rendered.
 */
export function formatDocumentsIndexBlock(entries: DocumentsIndexEntry[]): string | null {
  const usable = entries.filter((e) => e.path && e.title).slice(0, DOCUMENTS_INDEX_MAX_ENTRIES);
  if (!usable.length) return null;
  const lines: string[] = [
    'Previously written documents in this project (read one with read_file to answer from it or extend it; cite it instead of guessing):',
  ];
  for (const entry of usable) {
    const excerpt = entry.excerpt ? ` — ${entry.excerpt.slice(0, 180)}` : '';
    lines.push(`- ${entry.path}: ${entry.title.slice(0, 90)}${excerpt}`);
  }
  return lines.join('\n');
}

function todoVerbOf(label: string): string {
  const colon = label.indexOf(': ');
  return colon >= 0 ? label.slice(0, colon) : label;
}

function matchesToolSemantic(label: string, result: BrainToolResult): boolean {
  const l = label.toLowerCase();
  const tool = result.name;

  if (tool === 'run_command') {
    return /\b(test|verify|check|run|build|typecheck|compile|lint|execution|command)\b/i.test(l);
  }
  if (tool === 'write_file' || tool === 'save_document' || tool === 'edit_file') {
    if (/\b(write|edit|update|change|modify|implement|create|fix|add|delete|remove|patch)\b/i.test(l)) return true;
    const firstLine = (result.output.split('\n')[0] ?? '').toLowerCase();
    const words = firstLine.split(/[^a-z0-9_.-]+/).filter((w) => w.length > 3);
    return words.some((w) => l.includes(w));
  }
  if (tool === 'read_file' || tool === 'read_project' || tool === 'glob_files') {
    if (/\b(read|review|inspect|examine|explore|survey|check|map|find|locate|overview|snapshot)\b/i.test(l)) return true;
    const firstLine = (result.output.split('\n')[0] ?? '').toLowerCase();
    const words = firstLine.split(/[^a-z0-9_.-]+/).filter((w) => w.length > 3);
    return words.some((w) => l.includes(w));
  }
  if (tool === 'grep_code') {
    return /\b(search|grep|find|query|locate|look for)\b/i.test(l);
  }
  return false;
}

/**
 * Check if all dependencies for a todo item are satisfied.
 */
function dependenciesSatisfied(item: ChatTurnTodoItem, completedIds: Set<string>): boolean {
  if (!item.dependsOn?.length) return true;
  return item.dependsOn.every((depId) => completedIds.has(depId));
}

/**
 * Collect all completed IDs from a todo list (including subtasks).
 */
function collectCompletedIds(todos: ChatTurnTodoItem[]): Set<string> {
  const ids = new Set<string>();
  for (const item of todos) {
    if (item.id && (item.done || item.status === 'completed' || item.status === 'cancelled')) {
      ids.add(item.id);
    }
    if (item.subtasks?.length) {
      for (const sub of collectCompletedIds(item.subtasks)) {
        ids.add(sub);
      }
    }
  }
  return ids;
}

/**
 * Advance a to-do list against finished tool results. Each successful result
 * completes the first unfinished item matching its action verb or semantic target;
 * a failed result completes nothing. Items whose state the MODEL declared through
 * update_todos are never second-guessed here: the model may legitimately order
 * work differently from the plan, and a completed item it already closed must not
 * be resurrected by a later read matching its verb.
 *
 * Supports:
 * - Hierarchical subtasks (recursive advancement)
 * - Dependency tracking (dependsOn must be satisfied before in_progress)
 * - Auto-completion of parent tasks when all subtasks complete
 */
export function advanceTodoItems(
  todos: ChatTurnTodoItem[],
  results: BrainToolResult[],
): { todos: ChatTurnTodoItem[]; changed: boolean } {
  let changed = false;
  let next = todos.map((t) => ({ ...t }));

  // First, advance subtasks recursively
  for (let i = 0; i < next.length; i++) {
    if (next[i].subtasks?.length) {
      const subResult = advanceTodoItems(next[i].subtasks!, results);
      if (subResult.changed) {
        next[i] = { ...next[i], subtasks: subResult.todos };
        changed = true;
      }
    }
  }

  // Collect completed IDs for dependency checking
  const completedIds = collectCompletedIds(next);

  // Advance top-level items
  for (const result of results) {
    if (!result.ok) continue;
    const verb = TOOL_ACTION_LABELS[result.name];

    // Try exact verb prefix match first
    let index = -1;
    if (verb) {
      index = next.findIndex((todo) => !todo.done && todo.status === undefined && todoVerbOf(todo.label) === verb);
    }

    // Try semantic matching if no exact verb prefix match
    if (index < 0) {
      index = next.findIndex((todo) => !todo.done && todo.status === undefined && matchesToolSemantic(todo.label, result));
    }

    if (index >= 0) {
      next = next.map((todo, i) => (i === index ? { ...todo, done: true } : todo));
      changed = true;
    }
  }

  // Auto-complete parent tasks when all subtasks are complete
  for (let i = 0; i < next.length; i++) {
    const item = next[i];
    if (item.subtasks?.length && !item.done && item.status === undefined) {
      const allSubtasksDone = item.subtasks.every((sub) => sub.done || sub.status === 'completed' || sub.status === 'cancelled');
      if (allSubtasksDone) {
        next[i] = { ...item, done: true };
        changed = true;
      }
    }
  }

  return { todos: changed ? next : todos, changed };
}

/**
 * One concrete evidence line per tool result, parsed from the tool's own
 * output shape (read_file's first line is the path, run_command's is the
 * status plus the command, grep's is the match counts, …). Returns null when
 * the output is unusable.
 */
function toolSummaryLine(result: BrainToolResult): string | null {
  const first = (result.output.split('\n')[0] ?? '').trim().replace(/\s+/g, ' ');
  if (!first) return null;
  let text = first;
  switch (result.name) {
    case 'read_file':
      text = first;
      break;
    case 'read_project': {
      const match = first.match(/read (\d+) of (\d+) relevant text file/);
      text = match ? `project snapshot (${match[1]} of ${match[2]} files)` : first;
      break;
    }
    case 'glob_files': {
      const match = first.match(/Files matching "(.+)" \((\d+)\)/);
      text = match ? `${match[2]} files for "${match[1]}"` : first;
      break;
    }
    case 'grep_code': {
      const match = first.match(/^(\d+) match\(es\) in (\d+) file\(s\)/);
      text = match ? `${match[1]} matches in ${match[2]} files` : first;
      break;
    }
    case 'write_file':
    case 'save_document':
    case 'edit_file': {
      const match = first.match(/^(?:Wrote|Edited)\s+(.+?)(?:\.)?$/);
      text = match ? match[1] : first;
      break;
    }
    case 'run_command': {
      const match = first.match(/^([^:]+):\s*`([^`]+)`/);
      text = match ? `\`${match[2]}\` (${match[1]})` : first;
      break;
    }
    default:
      break;
  }
  return text.slice(0, 110);
}

function joinedEvidence(results: BrainToolResult[], max: number): string {
  const detail = results.slice(0, max).map(toolSummaryLine).filter(Boolean).join('; ');
  return `${detail}${results.length > max ? '; …' : ''}`;
}

/**
 * Completion summary folded into the final reply, derived strictly from tool
 * evidence with one concrete line per action: files read or edited, search
 * hit counts, commands with their exit codes. Every line exists because a
 * tool result exists; nothing here may claim unverified work. Pure so the
 * store can unit-test it against recorded results.
 */
export function formatTurnSummary(results: BrainToolResult[]): string | null {
  const executed = results.filter((r) => r.ok);
  if (executed.length === 0) return null;
  const lines: string[] = [];
  const reads = executed.filter((r) => ['read_project', 'read_file', 'glob_files'].includes(r.name));
  const searches = executed.filter((r) => r.name === 'grep_code');
  const writes = executed.filter((r) => ['write_file', 'save_document', 'edit_file'].includes(r.name));
  const commands = executed.filter((r) => r.name === 'run_command');
  const agents = executed.filter((r) => ['list_agents', 'list_terminals', 'get_agent_output', 'wait_for_agent'].includes(r.name));
  if (reads.length === 1) {
    const line = toolSummaryLine(reads[0]);
    if (line) lines.push(`Reviewed ${line}`);
  } else if (reads.length) {
    // Multiple read_project sweeps repeat the same "project snapshot (N of M
    // files)" line; count the passes instead of parroting near-duplicates.
    // File totals are only claimed for a single pass: summed totals across
    // passes can overcount when the model re-swept from the start.
    const snapshots = reads.filter((r) => r.name === 'read_project');
    const otherReads = reads.filter((r) => r.name !== 'read_project');
    const snapshotText = snapshots.length === 1
      ? (toolSummaryLine(snapshots[0]) ?? '')
      : snapshots.length > 1
        ? `project snapshot across ${snapshots.length} passes`
        : '';
    const restText = joinedEvidence(otherReads, 4);
    const body = [snapshotText, restText].filter(Boolean).join('; ');
    if (body) lines.push(`Reviewed ${body}`);
  }
  if (searches.length) {
    lines.push(`Searched ${joinedEvidence(searches, 3)}`);
  }
  if (writes.length) {
    lines.push(`Changed ${joinedEvidence(writes, 5)}`);
  }
  if (commands.length) {
    lines.push(`Ran ${joinedEvidence(commands, 3)}`);
  }
  if (agents.length) {
    lines.push(`Checked agents: ${joinedEvidence(agents, 3)}`);
  }
  if (!lines.length) return null;
  lines.push('Full detail in Work details above.');
  return lines.join('\n');
}

/**
 * Render a completed or in-progress to-do list into a GitHub-flavored checklist.
 * Model-declared statuses are honoured: completed/cancelled get [x], an active
 * in_progress gets [~], blocked gets [!] and pending stays [ ].
 * Supports hierarchical subtasks and dependency indicators.
 */
export function formatTodoListMarkdown(todos: ChatTurnTodoItem[]): string {
  if (!todos.length) return '';

  function renderItems(items: ChatTurnTodoItem[], indent = 0): string[] {
    const lines: string[] = [];
    for (const item of items) {
      let marker: string;
      if (item.status) {
        // Cancelled is its own marker: rendering it as [x] claimed work that
        // never happened, and the next turn re-read it as finished.
        marker = item.status === 'completed' ? 'x'
          : item.status === 'cancelled' ? '-'
          : item.status === 'in_progress' ? '~'
          : item.status === 'blocked' ? '!' : ' ';
      } else {
        marker = item.done ? 'x' : ' ';
      }
      const reason = item.reason && !item.done ? ` (${item.reason})` : '';
      const deps = item.dependsOn?.length ? ` [depends on: ${item.dependsOn.join(', ')}]` : '';
      const prefix = '  '.repeat(indent);
      lines.push(`${prefix}- [${marker}] ${item.label}${reason}${deps}`);
      if (item.subtasks?.length) {
        lines.push(...renderItems(item.subtasks, indent + 1));
      }
    }
    return lines;
  }

  const lines = renderItems(todos);
  return `### Plan & Tasks\n${lines.join('\n')}`;
}

/**
 * The full reply card for a finished turn: the model's answer with the
 * to-do checklist and evidence-derived summary folded in, so the transcript
 * shows ONE response card with ONE copy action.
 */
// ─── Claimed-write verification ──────────────────────────────────────────
// Models sometimes state "File created: docs/x.md" in a FINAL reply without
// having called write_file. These pure helpers let the runtime detect that
// fabrication and force a corrective pass (or annotate honestly) before the
// reply reaches the user.

/** Verb + repo-relative path within one sentence, e.g. "created `docs/plan.md`". */
const WRITE_CLAIM_PATH_RE = /\b(?:created|wrote|written|saved|generated)\b[^.\n]{0,80}?((?:[\w@.-]+\/)+[\w@.-]+\.[A-Za-z0-9]{1,6})/gi;

/** Verb + document-ish noun without a path, e.g. "saved the suggestions as a document". */
const WRITE_CLAIM_DOC_RE = /\b(?:created|wrote|written|saved|generated)\b[^.\n]{0,40}?\b(?:a|the|this|your)\b[^.\n]{0,20}?\b(?:document|doc|report|plan|markdown|notes?)\b/i;

/** Explicit "File created:" style header. */
const WRITE_CLAIM_HEADER_RE = /\bfile\s+(?:created|saved|written|wrote)\s*:/i;

/** Paths the reply claims to have created or written, deduplicated. */
export function findClaimedWritePaths(reply: string): string[] {
  const paths = new Set<string>();
  for (const match of reply.matchAll(WRITE_CLAIM_PATH_RE)) {
    const path = (match[1] ?? '').replace(/[.,;:]+$/, '');
    if (path.includes('/')) paths.add(path);
  }
  return [...paths];
}

/** True when the reply claims any file/document creation, with or without a path. */
export function replyClaimsDocumentWrite(reply: string): boolean {
  return WRITE_CLAIM_HEADER_RE.test(reply) || WRITE_CLAIM_DOC_RE.test(reply) || findClaimedWritePaths(reply).length > 0;
}

/**
 * Whether successful write evidence covers the claimed paths. No specific
 * paths claimed: any successful write satisfies the claim. Paths claimed: at
 * least one write output must mention a claimed file's basename (outputs read
 * "Wrote docs/plan.md (…)").
 */
export function writeEvidenceCoversClaims(claimedPaths: string[], writeOutputs: string[]): boolean {
  if (!writeOutputs.length) return false;
  if (!claimedPaths.length) return true;
  const outputs = writeOutputs.map((o) => o.toLowerCase());
  return claimedPaths.some((path) => {
    const base = path.split('/').pop()?.toLowerCase() ?? '';
    return base.length > 0 && outputs.some((output) => output.includes(base));
  });
}

/**
 * A turn reports itself section by section when it changed files or ran a
 * command, because that is exactly when a one-line evidence summary cannot say
 * what matters: which files changed, and whether anything checked them. A
 * read-only turn has nothing to verify, so it keeps the compact summary.
 */
function isReportableTurn(results: BrainToolResult[]): boolean {
  return results.some((r) => CODE_MUTATING_TOOL_NAMES.has(r.name) || r.name === 'run_command');
}

export function composeTurnReply(
  reply: string,
  summary: string | null,
  todos?: ChatTurnTodoItem[],
  results?: BrainToolResult[],
  options?: { conversational?: boolean },
): string {
  const parts: string[] = [];
  const body = reply.trim();
  if (body) parts.push(body);

  if (todos && todos.length > 0) {
    const todoMd = formatTodoListMarkdown(todos);
    // Only append if the reply doesn't already contain a markdown checklist
    if (todoMd && !body.includes('- [x]') && !body.includes('- [ ]')) {
      parts.push(todoMd);
    }
  }

  // The structured report REPLACES the one-line summary for a turn that did
  // work. An empty render (nothing worth a section) falls back to the summary
  // rather than dropping the evidence line entirely.
  // Chat replies read like a conversation: the files a turn wrote are shown as
  // viewable cards under the reply, and the tool trail lives in Work details,
  // so only what the user must act on (a failure, a measured check) is added.
  const conversational = options?.conversational === true;
  const report = results && isReportableTurn(results) ? buildCompletionReport(results, todos ?? []) : null;
  const structured = report
    ? formatStructuredReport(conversational ? { ...report, completed: [] } : report, body).trim()
    : '';
  if (structured) parts.push(structured);
  else if ((!conversational || !body) && summary && summary.trim()) parts.push(summary.trim());

  return parts.join('\n\n');
}

/** Every tool that writes to disk: project files and user documents alike. */
const MUTATING_TOOL_NAMES: ReadonlySet<string> = new Set(['write_file', 'save_document', 'edit_file']);

/**
 * The subset that changes the project itself, and so owes the turn a
 * verification run. `save_document` is deliberately excluded even though it
 * writes to disk: it lands a prose document in the project's docs/ folder (or
 * the user's Documents folder), which no test, typecheck or build can say
 * anything about, so gating it would demand a
 * pointless command every time the user asks for a written-up answer.
 */
const CODE_MUTATING_TOOL_NAMES: ReadonlySet<string> = new Set(['write_file', 'edit_file']);

/**
 * Command words that mean a run CHECKED the work rather than only looked at it.
 * Deliberately broad: a gate that recognises `npm test` alone misfires on every
 * project that names its own command (`just verify`, `./scripts/check.sh`,
 * `cargo clippy`, `go test ./...`). A false positive here only costs one nudge,
 * which is the cheap direction for a gate that must never block a turn.
 */
const VERIFICATION_COMMAND_RE =
  /\b(?:tests?|specs?|typecheck|type-check|tsc|lint|check|verify|validate|build|compile|audit|vitest|jest|mocha|pytest|ctest|clippy|msbuild|mypy|eslint|ruff|flake8|phpunit|rspec)\b/i;

export function extractToolEvidence(results: BrainToolResult[]): TurnEvidence {
  const ok = results.filter((r) => r.ok);
  return {
    read: ok.some((r) => ['read_project', 'read_file', 'glob_files', 'grep_code'].includes(r.name)),
    mutated: ok.filter((r) => MUTATING_TOOL_NAMES.has(r.name)).map((r) => r.output.split('\n')[0]?.replace(/^Updated\s+/, '').trim()).filter(Boolean) as string[],
    commands: ok.filter((r) => r.name === 'run_command').map((r) => r.output.split('\n')[0]?.trim() ?? '').filter(Boolean),
  };
}

export function hasReadEvidence(results: BrainToolResult[]): boolean {
  return extractToolEvidence(results).read;
}

/** The command a run_command result ran, parsed from its `${status}: \`cmd\`` first line. */
function runCommandText(result: BrainToolResult): string {
  const first = result.output.split('\n')[0] ?? '';
  return first.match(/`([^`]+)`/)?.[1] ?? first;
}

/**
 * A run that produced no verdict at all: it timed out, its session died before
 * the command finished, or the tool errored before the command ever ran.
 *
 * This is NOT a failure, and the difference is the whole point. `exit 1` is a
 * result — the suite ran and something is broken. A TIMEOUT is the absence of
 * a result, and printing it as `Tests: FAILED` tells the user their tests are
 * red when nothing was ever checked. It is the worse lie of the two: a red
 * badge sends them hunting a failure that does not exist, and it contradicts
 * the model's own prose in the same card ("no verification run was possible"),
 * which costs the whole report its credibility.
 *
 * Matched against the status line `formatBrainRunResult` writes, which is the
 * same text `ok` is derived from in `executeBrainToolCalls`.
 */
const INCONCLUSIVE_RUN_RE = /^(?:TIMEOUT\b|SESSION CLOSED\b|error:)/i;

function runInconclusive(result: BrainToolResult): boolean {
  return INCONCLUSIVE_RUN_RE.test(result.output.trimStart());
}

/**
 * The verification commands run after a given position in the tool log. The
 * gate asks whether one ran; the completion report checks whether each latest
 * verification class passed.
 */
function verificationRunsAfter(results: BrainToolResult[], index: number): BrainToolResult[] {
  return results
    .slice(index + 1)
    .filter((r) => r.name === 'run_command' && VERIFICATION_COMMAND_RE.test(runCommandText(r)));
}

/**
 * True when the turn changed a file and never ran a verification command
 * AFTERWARDS — the one state a turn must not reach FINAL in. Three deliberate
 * choices: a verification that FAILED still counts, because a reported failing
 * run is honest and the reply is where it gets surfaced; a command run before
 * the last write is ignored, since it cannot have covered the change; and a
 * run that never COMPLETED does not count at all, because a command that hung
 * checked nothing. The gate exists to make a check actually happen, and a
 * timeout is the case where it did not. The caller nudges once and only once,
 * so a project whose checks always hang still finishes its turn.
 *
 * Pure, so the store can unit-test it against recorded tool results.
 */
export function hasUnverifiedMutation(results: BrainToolResult[]): boolean {
  let lastWrite = -1;
  for (let i = 0; i < results.length; i += 1) {
    if (results[i].ok && CODE_MUTATING_TOOL_NAMES.has(results[i].name)) lastWrite = i;
  }
  if (lastWrite < 0) return false;
  return verificationRunsAfter(results, lastWrite).every(runInconclusive);
}

export interface TurnEvidence {
  read: boolean;
  mutated: string[];
  commands: string[];
}

/**
 * Structured completion report for a finished turn. Distinguishes what was
 * accomplished, what failed, and what needs improvement — with evidence.
 */
/**
 * `pass`/`fail` are verdicts a command actually returned. `inconclusive` is a
 * command that never returned one (it hung, or its session died), and
 * `skipped` is a check that was never attempted. The last two look alike to
 * the user — neither says anything about the code — but they need separate
 * wording, because one of them means a check was tried and is broken.
 */
export type VerificationStatus = 'pass' | 'fail' | 'inconclusive' | 'skipped';

export interface CompletionReport {
  /** What was built/changed with verification status */
  completed: Array<{
    task: string;
    files: string[];
    /** True only when the post-task verification passed. */
    verified: boolean;
    verificationOutcome: VerificationStatus;
    evidence: string;
  }>;
  /** What failed and why */
  failed: Array<{
    task: string;
    reason: string;
    suggestion: string;
    /**
     * The tool produced no verdict rather than a bad one. Rendered amber, and
     * never told to "fix what the command reported" — it reported nothing.
     */
    inconclusive?: boolean;
  }>;
  /** What works but could be improved */
  improvements: Array<{
    area: string;
    current: string;
    suggested: string;
  }>;
  /** Verification results from tool evidence */
  verification: {
    tests: VerificationStatus;
    typecheck: VerificationStatus;
    build: VerificationStatus;
  };
}

/**
 * Verification classes, matched against the COMMAND and never its output: a
 * build log that mentions a test file must not file itself under tests.
 */
const TEST_COMMAND_RE = /\b(?:tests?|specs?|vitest|jest|mocha|pytest|ctest|phpunit|rspec)\b/i;
const TYPECHECK_COMMAND_RE = /\b(?:typecheck|type-check|tsc|mypy)\b/i;
const BUILD_COMMAND_RE = /\b(?:build|compile|bundle|msbuild)\b/i;

function verificationClass(result: BrainToolResult): string {
  const command = runCommandText(result);
  if (TEST_COMMAND_RE.test(command)) return 'tests';
  if (TYPECHECK_COMMAND_RE.test(command)) return 'typecheck';
  if (BUILD_COMMAND_RE.test(command)) return 'build';
  return 'other';
}

/** Summarize the latest result per check class without letting a failed test
 * disappear behind a later passing typecheck or build. A real failure outranks
 * a check that never completed: a red suite is the more urgent fact, and the
 * Verification section below still names which class produced no verdict. */
function summarizeVerificationRuns(runs: BrainToolResult[]): VerificationStatus {
  const latestByClass = new Map<string, BrainToolResult>();
  for (const run of runs) latestByClass.set(verificationClass(run), run);
  if (latestByClass.size === 0) return 'skipped';
  const latest = [...latestByClass.values()];
  if (latest.some((run) => !run.ok && !runInconclusive(run))) return 'fail';
  if (latest.some(runInconclusive)) return 'inconclusive';
  return 'pass';
}

/**
 * Tools whose failure means the WORK did not happen, as opposed to a probe that
 * came back empty. Only these earn a "What is not working" line: a read_file of
 * a path that turned out not to exist is exploration, and reporting it as a
 * failure would put a false failure section on every healthy turn.
 */
const WORK_TOOL_NAMES: ReadonlySet<string> = new Set(['write_file', 'save_document', 'edit_file', 'run_command']);

/** The path a write tool reported, from `Wrote <path> (N chars).` and friends. */
const WRITE_PATH_RE = /^(?:Wrote|Saved|Edited|Updated)\s+(.+?)(?:\s+\([^()]*\))?\.?$/;

function writeVerb(name: string): string {
  if (name === 'edit_file') return 'Edited';
  if (name === 'save_document') return 'Saved';
  return 'Wrote';
}

/**
 * Build a CompletionReport from tool evidence gathered during a turn.
 */
export function buildCompletionReport(
  results: BrainToolResult[],
  todos: ChatTurnTodoItem[]
): CompletionReport {
  const commandRuns = results.filter((r) => r.name === 'run_command');

  /**
   * `ok` is the brain's own verdict on a run's status line (`exit 1`, TIMEOUT
   * and SESSION CLOSED all read as not-ok), so it is the only honest pass/fail
   * signal here. Deciding this by grepping the output gets it backwards in both
   * directions: a failing run is excluded before it is ever seen, so it can only
   * report "skipped", while a green run printing "0 failed" reads as a failure.
   *
   * The LAST run of a class decides it, never an OR across every run of that
   * class. The brain is told to fix what a red run reported and run it again,
   * so a turn that did exactly that ends green — and an OR would keep printing
   * FAILED for the very run it was asked to repair.
   *
   * `ok` alone is still not enough to call something failed, because it lumps
   * a command that hung in with a command that returned non-zero. Those are
   * split here: only a run that reported gets a verdict.
   */
  const verifyStatus = (runs: BrainToolResult[]): VerificationStatus => {
    const last = runs.at(-1);
    if (!last) return 'skipped';
    if (runInconclusive(last)) return 'inconclusive';
    return last.ok ? 'pass' : 'fail';
  };

  // The plan badge below is judged on verification-class runs only. Feeding it
  // every command would let an `ls` that exited 1 — or, under last-run-wins, a
  // trailing `cat` that exited 0 — stand in for a verdict on the work.
  const verificationRuns = commandRuns.filter((r) => VERIFICATION_COMMAND_RE.test(runCommandText(r)));
  const verificationOutcome = summarizeVerificationRuns(verificationRuns);

  const completed: CompletionReport['completed'] = [];
  results.forEach((result, index) => {
    if (!result.ok || !MUTATING_TOOL_NAMES.has(result.name)) return;
    const firstLine = result.output.split('\n')[0] ?? '';
    const pathMatch = firstLine.match(WRITE_PATH_RE);
    const filePath = (pathMatch ? pathMatch[1] : firstLine).trim();
    const verificationOutcome = summarizeVerificationRuns(verificationRunsAfter(results, index));
    completed.push({
      task: `${writeVerb(result.name)} ${filePath}`,
      files: [filePath],
      verified: verificationOutcome === 'pass',
      verificationOutcome,
      evidence: firstLine.slice(0, 120),
    });
  });

  // Plan items are listed only when no write landed, because the checklist is
  // rendered beside this report and the two would otherwise repeat each other
  // line for line.
  if (completed.length === 0) {
    for (const todo of todos.filter((t) => todoIsDone(t.status, t.done))) {
      completed.push({
        task: todo.label,
        files: [],
        verified: verificationOutcome === 'pass',
        verificationOutcome,
        evidence: 'Completed per plan',
      });
    }
  }

  const failed: CompletionReport['failed'] = results
    .filter((r) => !r.ok && WORK_TOOL_NAMES.has(r.name))
    .map((r) => {
      const inconclusive = runInconclusive(r);
      return {
        task: r.name,
        reason: (r.output.split('\n')[0] ?? '').slice(0, 150),
        // "Fix what the command reported" is nonsense advice for a run that
        // reported nothing, and it is what sent the last review hunting a
        // failure that never existed.
        suggestion: inconclusive
          ? 'The command never finished, so nothing was checked. Re-run it in its run-once, non-interactive form, or with background: true, before treating the work as verified.'
          : r.name === 'run_command'
            ? 'Fix what the command reported, then run it again before calling the work done.'
            : 'Check the error output and retry with corrected parameters.',
        ...(inconclusive ? { inconclusive: true } : {}),
      };
    });

  return {
    completed,
    failed,
    // Judgement no tool output can supply: the model states its own suggestions
    // in the reply, and an invented list here would be the runtime's opinion
    // dressed up as evidence.
    improvements: [],
    verification: {
      tests: verifyStatus(commandRuns.filter((r) => TEST_COMMAND_RE.test(runCommandText(r)))),
      typecheck: verifyStatus(commandRuns.filter((r) => TYPECHECK_COMMAND_RE.test(runCommandText(r)))),
      build: verifyStatus(commandRuns.filter((r) => BUILD_COMMAND_RE.test(runCommandText(r)))),
    },
  };
}

/**
 * Format a CompletionReport into a structured markdown section. `existingText`
 * is what the model already wrote: a section the model headed itself is
 * skipped, so the finished card never carries two `### What is working` blocks.
 */
export function formatStructuredReport(report: CompletionReport, existingText = ''): string {
  const lines: string[] = [];
  /** True when the model headed this section itself (`### X`, `**X**`). */
  const headed = (label: string) =>
    new RegExp(`(?:^|\\n)[ \\t]*(?:#{1,6}[ \\t]*|\\*\\*[ \\t]*)${label}\\b`, 'i').test(existingText);

  if (report.completed.length > 0 && !headed('what is working')) {
    lines.push('### What is working');
    for (const item of report.completed) {
      const files = item.files.filter((f) => !item.task.includes(f));
      const badge = item.verificationOutcome === 'pass'
        ? ' [verified] 🟢'
        : item.verificationOutcome === 'fail'
          ? ' [verification failed] 🔴'
          : item.verificationOutcome === 'inconclusive'
            ? ' [unverified: the check never finished] 🟡'
            : ' [not verified] 🟡';
      lines.push(`- ${item.task}${files.length > 0 ? ` (${files.join(', ')})` : ''}${badge}`);
      if (item.evidence && !item.evidence.includes(item.task)) lines.push(`  - ${item.evidence}`);
    }
  }

  if (report.failed.length > 0 && !headed('what is not working')) {
    if (lines.length > 0) lines.push('');
    lines.push('### What is not working');
    for (const item of report.failed) {
      lines.push(`- ${item.inconclusive ? '🟡' : '🔴'} **${item.task}**: ${item.reason}`);
      lines.push(`  - Suggestion: ${item.suggestion}`);
    }
  }

  if (report.improvements.length > 0 && !headed('what needs improvement')) {
    if (lines.length > 0) lines.push('');
    lines.push('### What needs improvement');
    for (const item of report.improvements) {
      lines.push(`- 🟡 **${item.area}**: ${item.current}`);
      lines.push(`  - Suggested: ${item.suggested}`);
    }
  }

  // Verification is the one section the runtime owns outright: it is the
  // objective check the verification gate forced, so a model that merely
  // mentions the word keeps its prose and still gets the measured result.
  const v = report.verification;
  if ((v.tests !== 'skipped' || v.typecheck !== 'skipped' || v.build !== 'skipped') && !headed('verification')) {
    if (lines.length > 0) lines.push('');
    lines.push('### Verification');
    const label = (status: VerificationStatus): string =>
      status === 'pass' ? 'PASSED 🟢' : status === 'fail' ? 'FAILED 🔴' : 'DID NOT COMPLETE 🟡';
    const items: string[] = [];
    if (v.tests !== 'skipped') items.push(`Tests: ${label(v.tests)}`);
    if (v.typecheck !== 'skipped') items.push(`Typecheck: ${label(v.typecheck)}`);
    if (v.build !== 'skipped') items.push(`Build: ${label(v.build)}`);
    lines.push(items.join(' | '));
    // Without this the line reads as a verdict on the code. It is not one:
    // nothing was measured, and the user needs to know that before they go
    // looking for a failure.
    if (v.tests === 'inconclusive' || v.typecheck === 'inconclusive' || v.build === 'inconclusive') {
      lines.push('');
      lines.push('_A check marked DID NOT COMPLETE timed out or lost its session: it reports nothing about the code. This change is unverified._');
    }
  }

  return lines.join('\n');
}
