/**
 * Edit-small / delegate-big policy for the orchestrator brain.
 *
 * The orchestrator does small work itself: at most DIRECT_EDIT_FILE_LIMIT
 * distinct project files changed per task. Anything bigger belongs to a coding
 * agent (Claude Code, Codex, or another local model), and the orchestrator may
 * only hand it off after the user approves the proposal. Both halves are
 * enforced in code, not only in the prompt: the executor refuses the file that
 * crosses the limit, and the store turns an unapproved spawn/send into a
 * proposal the user answers.
 */
import type { AgentChoice, OrchestratorAction } from '$lib/services/orchestrator-brain';

/** Distinct project files the orchestrator may change on its own per task. */
export const DIRECT_EDIT_FILE_LIMIT = 3;

// Explicit "open an agent" intent. In spoken conversation mode we only spawn
// when the user clearly asks to launch an agent or to have one do coding work —
// everything else is treated as plain conversation, never a dispatch.
export const EXPLICIT_SPAWN_RE =
  /\b(open|spawn|launch|start|fire up|boot up|kick off|create|use|have|get|tell|ask|put)\b[^.?!]*\b(agents?|claude|codex|aider|opencode|antigravity|agy|cursor|pi|grok|assistants?|bots?)\b/i;

// "Delegate this", "hand it off", "send that to Iris": the user asking for a
// hand-off without naming an agent kind.
const DELEGATION_VERB_RE =
  /\b(delegate|hand\s+(?:it|this|that)?\s*(?:off|over)|(?:hand|pass|send|give)\s+(?:it|this|that|the (?:task|work|job))\s+to)\b/i;

/** True when the user's own message asks for an agent hand-off. */
export function isExplicitDelegationRequest(text: string): boolean {
  return EXPLICIT_SPAWN_RE.test(text) || DELEGATION_VERB_RE.test(text);
}

export function hasDelegationAction(actions: OrchestratorAction[]): boolean {
  return actions.some((action) => action.kind === 'spawn' || action.kind === 'send');
}

function mentions(text: string, name: string): boolean {
  const escaped = name.trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return Boolean(escaped) && new RegExp(`(?:^|[^\\w])${escaped}(?:$|[^\\w])`, 'i').test(text);
}

/**
 * Whether the user themselves asked for this hand-off. Addressing a running
 * agent by name ("Backend, run the tests") is a request for that agent. A
 * short answer to the orchestrator's own follow-up question (e.g. where the
 * agent should run) inherits the approval of the request it follows.
 */
export function userApprovedDelegation(
  text: string,
  actions: OrchestratorAction[],
  previous?: { userText: string; assistantAsked: boolean },
): boolean {
  if (isExplicitDelegationRequest(text)) return true;
  const delegated = actions.filter((action) => action.kind === 'spawn' || action.kind === 'send');
  if (delegated.length && delegated.every((action) => action.kind === 'send' && mentions(text, action.target))) return true;
  return Boolean(previous?.assistantAsked && isExplicitDelegationRequest(previous.userText));
}

// ─── Per-task edit scope ────────────────────────────────────────────────────

/**
 * What the orchestrator touched in the current task. It lives per chat thread
 * across turns, so a short go-ahead ("okay, continue") cannot reset the count
 * and slip a fourth file through; a new request starts a fresh scope.
 */
export interface DirectEditScope {
  /** Normalised keys of project files changed in this task. */
  files: Set<string>;
  /** Normalised keys of project files read in this conversation. */
  reads: Set<string>;
  /** The user said "do it yourself anyway": the file limit is lifted. */
  override: boolean;
}

export function createDirectEditScope(): DirectEditScope {
  return { files: new Set(), reads: new Set(), override: false };
}

/** Windows paths are case-insensitive and may arrive with either separator. */
export function scopeKey(path: string): string {
  return path.replace(/\\/g, '/').replace(/^\.\//, '').toLowerCase();
}

/**
 * The refusal for a write that would cross the limit, or null when allowed.
 * Files already in the scope stay writable, so the orchestrator can always
 * finish fixing what it has started.
 */
export function checkDirectEditScope(
  scope: DirectEditScope,
  path: string,
  limit: number = DIRECT_EDIT_FILE_LIMIT,
): string | null {
  if (scope.override) return null;
  const key = scopeKey(path);
  if (scope.files.has(key) || scope.files.size < limit) return null;
  const touched = [...scope.files].join(', ');
  return `error: scope limit — this task would change more than ${limit} files (already changed: ${touched}; next: ${path}). `
    + 'That is a big change, which you must not make on your own. Stop editing. Summarise what is done and what remains, '
    + 'then propose the hand-off: return a FINAL with a spawn action whose prompt is a complete brief for the remaining work '
    + '(goal, files, constraints, how to verify). The user is asked to approve it before any agent starts.';
}

export function recordDirectEdit(scope: DirectEditScope, path: string): void {
  scope.files.add(scopeKey(path));
}

export function recordDirectRead(scope: DirectEditScope, path: string): void {
  scope.reads.add(scopeKey(path));
}

export function hasDirectRead(scope: DirectEditScope, path: string): boolean {
  return scope.reads.has(scopeKey(path));
}

const CONTINUATION_RE =
  /^(?:ok(?:ay)?|k|yes|yep|yeah|sure|continue|go on|go ahead|keep going|proceed|carry on|do it|finish(?: it| up)?|next|please do|sounds good|looks good)\b[\s\w,.!']{0,40}$/i;

/** A short go-ahead that continues the current task rather than starting one. */
export function isScopeContinuation(text: string): boolean {
  const trimmed = text.trim();
  return trimmed.length <= 60 && CONTINUATION_RE.test(trimmed);
}

// ─── Delegation proposals ───────────────────────────────────────────────────

export type DelegationChoice =
  | { kind: 'delegate'; label: string; actions: OrchestratorAction[] }
  | { kind: 'self'; label: string }
  | { kind: 'decline'; label: string };

export interface DelegationProposal {
  id: string;
  /** The user request the orchestrator judged too big to do alone. */
  request: string;
  question: string;
  choices: DelegationChoice[];
  createdAt: number;
}

export const DELEGATION_SELF_LABEL = 'Do it yourself anyway';
export const DELEGATION_DECLINE_LABEL = "Don't delegate";
const MAX_AGENT_CHOICES = 4;
const BRIEF_PREVIEW_CHARS = 700;

/** Claude Code and Codex first, then the other local agents in their order. */
function rankAgents(agents: AgentChoice[]): AgentChoice[] {
  const rank = (agent: AgentChoice) => (agent.command === 'claude' ? 0 : agent.command === 'codex' ? 1 : 2);
  return agents.map((agent, index) => ({ agent, index }))
    .sort((a, b) => rank(a.agent) - rank(b.agent) || a.index - b.index)
    .map(({ agent }) => agent);
}

function retarget(actions: OrchestratorAction[], agent: string, fallbackPrompt: string): OrchestratorAction[] {
  const delegated = actions.filter((action) => action.kind === 'spawn' || action.kind === 'send');
  const prompts = delegated.map((action) => action.prompt?.trim()).filter((prompt): prompt is string => Boolean(prompt));
  const spawns = delegated.filter((action): action is Extract<OrchestratorAction, { kind: 'spawn' }> => action.kind === 'spawn');
  if (spawns.length) return spawns.map((action) => ({ ...action, agent, prompt: action.prompt?.trim() || fallbackPrompt }));
  return [{ kind: 'spawn', agent, prompt: prompts.join('\n\n') || fallbackPrompt, name: null }];
}

/**
 * Turn an unapproved hand-off into a question for the user. The agent the
 * model picked (or the running agent it addressed) is offered first; the
 * remaining installed agents follow, plus "do it yourself" and "don't".
 */
export function buildDelegationProposal(input: {
  id: string;
  request: string;
  reply: string;
  actions: OrchestratorAction[];
  agents: AgentChoice[];
  now?: number;
}): DelegationProposal {
  const delegated = input.actions.filter((action) => action.kind === 'spawn' || action.kind === 'send');
  const brief = delegated.map((action) => action.prompt?.trim()).find(Boolean) || input.request.trim();
  const choices: DelegationChoice[] = [];
  const labels = new Set<string>();
  const add = (choice: DelegationChoice) => {
    if (labels.has(choice.label)) return;
    labels.add(choice.label);
    choices.push(choice);
  };

  for (const action of delegated) {
    if (action.kind === 'send') {
      add({ kind: 'delegate', label: `Send to ${action.target}`, actions: [action] });
    }
  }
  const proposedAgents = delegated
    .filter((action): action is Extract<OrchestratorAction, { kind: 'spawn' }> => action.kind === 'spawn')
    .map((action) => action.agent);
  // The agent the model proposed stays first even when it is not in the
  // dispatch list (the spawn path resolves it by command either way).
  const ordered = [
    ...[...new Set(proposedAgents)].map((command) => input.agents.find((agent) => agent.command === command) ?? { command, name: command }),
    ...rankAgents(input.agents.filter((agent) => !proposedAgents.includes(agent.command))),
  ];
  for (const agent of ordered) {
    if (choices.filter((choice) => choice.kind === 'delegate').length >= MAX_AGENT_CHOICES) break;
    add({ kind: 'delegate', label: `Delegate to ${agent.name}`, actions: retarget(delegated, agent.command, brief) });
  }
  add({ kind: 'self', label: DELEGATION_SELF_LABEL });
  add({ kind: 'decline', label: DELEGATION_DECLINE_LABEL });

  const why = input.reply.trim();
  const preview = brief.length > BRIEF_PREVIEW_CHARS ? `${brief.slice(0, BRIEF_PREVIEW_CHARS)}…` : brief;
  const question = [
    why || `This is bigger than I should change on my own (more than ${DIRECT_EDIT_FILE_LIMIT} files).`,
    'Should I hand it off? This is the brief the agent would get:',
    preview.split('\n').map((line) => `> ${line}`).join('\n'),
  ].join('\n\n');
  return { id: input.id, request: input.request, question, choices, createdAt: input.now ?? Date.now() };
}

/** Match the user's answer (a clicked option label, or typed text) to a choice. */
export function resolveDelegationAnswer(proposal: DelegationProposal, answer: string): DelegationChoice | null {
  const text = answer.trim().toLowerCase();
  if (!text) return null;
  const exact = proposal.choices.find((choice) => choice.label.toLowerCase() === text);
  if (exact) return exact;
  const delegates = proposal.choices.filter((choice) => choice.kind === 'delegate');
  if (/^(?:y|yes|yep|yeah|sure|ok(?:ay)?|approve[d]?|go ahead|do it|delegate(?: it)?)[.!]?$/.test(text)) {
    return delegates[0] ?? null;
  }
  if (/^(?:n|no|nope|don'?t|cancel|stop|never ?mind)\b/.test(text)) {
    return proposal.choices.find((choice) => choice.kind === 'decline') ?? null;
  }
  if (/\b(?:yourself|you do it|do it you)\b/.test(text)) {
    return proposal.choices.find((choice) => choice.kind === 'self') ?? null;
  }
  // "codex", "send it to claude code": a typed agent name picks that option.
  return delegates.find((choice) => {
    const name = choice.label.replace(/^(?:Delegate|Send) to /, '').toLowerCase();
    return text.includes(name);
  }) ?? null;
}
