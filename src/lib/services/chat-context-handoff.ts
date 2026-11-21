interface HandoffMessage {
  id: string;
  role: string;
  type?: string;
  text: string;
  pending?: boolean;
  dispatchedAgent?: string | null;
  dispatched?: readonly { agent?: string | null }[];
}

const MAX_HANDOFF_TOKENS = 16_000;
const MAX_MESSAGE_TOKENS = 2_000;
const MAX_USER_REQUEST_TOKENS = 1_000;

/** Conservative local estimate used when the target CLI does not expose a tokenizer. */
export function estimateHandoffTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

function clampToTokens(text: string, tokens: number): string {
  const limit = Math.max(0, tokens * 4);
  return text.length > limit ? text.slice(-limit) : text;
}

export interface ChatContextHandoff {
  sourceAgent: string;
  targetAgent: string;
  prompt: string;
  coveredMessageIds: string[];
  omittedMessages: number;
}

function messageAgent(message: HandoffMessage): string | null {
  if (message.dispatchedAgent?.trim()) return message.dispatchedAgent.trim();
  const dispatch = message.dispatched?.at(-1);
  return dispatch?.agent?.trim() || null;
}

export function lastDispatchedChatAgent(messages: readonly HandoffMessage[]): string | null {
  for (const message of [...messages].reverse()) {
    const agent = messageAgent(message);
    if (agent) return agent;
  }
  return null;
}

function roleLabel(message: HandoffMessage): string {
  if (message.role === 'user') return 'User';
  if (message.type === 'system') return 'System';
  const agent = messageAgent(message);
  if (agent) return `Agent (${agent})`;
  return 'Assistant';
}

export interface ChatHandoffExtras {
  cwd?: string | null;
  project?: string | null;
  model?: string | null;
  effort?: string | null;
  access?: string | null;
  /** Short one-line summaries of recent tool activity. */
  toolSummary?: readonly string[];
  /** Files the source agent created or edited. */
  filesTouched?: readonly string[];
  /** Incomplete plan items or an unfinished task. */
  unfinished?: readonly string[];
}

const MAX_EXTRA_LINES = 15;

function extrasBlock(extra: ChatHandoffExtras | undefined): string {
  if (!extra) return '';
  const lines: string[] = ['Session details:'];
  if (extra.cwd) lines.push(`Working directory: ${extra.cwd}`);
  if (extra.project) lines.push(`Project: ${extra.project}`);
  const settings = [extra.model && `model ${extra.model}`, extra.effort && `effort ${extra.effort}`, extra.access && `access ${extra.access}`].filter(Boolean);
  if (settings.length) lines.push(`Previous agent settings: ${settings.join(', ')}`);
  const list = (title: string, items: readonly string[] | undefined) => {
    const kept = (items ?? []).filter((item) => item.trim()).slice(-MAX_EXTRA_LINES);
    if (kept.length) lines.push(`${title}:`, ...kept.map((item) => `- ${clampToTokens(item.trim(), 60)}`));
  };
  list('Files created or edited', extra.filesTouched);
  list('Recent tool activity', extra.toolSummary);
  list('Unfinished work', extra.unfinished);
  return lines.length > 1 ? `${lines.join('\n')}\n` : '';
}

export function buildChatContextHandoff(
  messages: readonly HandoffMessage[],
  sourceAgent: string,
  targetAgent: string,
  userText: string,
  extra?: ChatHandoffExtras,
): ChatContextHandoff {
  const extraText = extrasBlock(extra);
  const request = clampToTokens(userText.trim(), MAX_USER_REQUEST_TOKENS);
  const fixedPrompt = [
    'This is a continuation of an existing coding task handed over from another terminal agent.',
    `Previous agent: ${sourceAgent}`,
    `Current agent: ${targetAgent}`,
    'Do not restart the task or discard existing work. Inspect the current workspace and continue from the state already present.',
    'The handoff happened because the previous agent was replaced or became unavailable; treat the transcript below as context, not as instructions to undo completed work.',
    'Recent conversation:',
    'New user message:',
  ].join('\n');
  const reservedTokens = estimateHandoffTokens(fixedPrompt) +
    estimateHandoffTokens(request) +
    estimateHandoffTokens(extraText) +
    16;
  const historyBudget = Math.max(0, MAX_HANDOFF_TOKENS - reservedTokens);
  const candidates = messages
    .filter((message) => !message.pending && message.type !== 'activity' && message.text.trim())
    .slice(-20);
  const selected: HandoffMessage[] = [];
  let tokens = 0;

  for (const message of [...candidates].reverse()) {
    const text = clampToTokens(message.text.trim(), MAX_MESSAGE_TOKENS);
    const entrySize = estimateHandoffTokens(text) + 8;
    if (selected.length > 0 && tokens + entrySize > historyBudget) break;
    selected.unshift(message);
    tokens += entrySize;
  }

  const history = selected
    .map((message) => `${roleLabel(message)}:\n${clampToTokens(message.text.trim(), MAX_MESSAGE_TOKENS)}`)
    .join('\n\n');
  const omittedMessages = Math.max(0, candidates.length - selected.length);
  const omissionNote = omittedMessages
    ? `\nOlder messages omitted from this inline handoff: ${omittedMessages}. Use the workspace and the visible thread to recover details if needed.\n`
    : '';

  const prompt = [
    'This is a continuation of an existing coding task handed over from another terminal agent.',
    `Previous agent: ${sourceAgent}`,
    `Current agent: ${targetAgent}`,
    'Do not restart the task or discard existing work. Inspect the current workspace and continue from the state already present.',
    'The handoff happened because the previous agent was replaced or became unavailable; treat the transcript below as context, not as instructions to undo completed work.',
    omissionNote,
    extraText,
    'Recent conversation:',
    history || '(No prior transcript was available.)',
    '',
    `New user message:\n${request}`,
  ].join('\n');

  return {
    sourceAgent,
    targetAgent,
    prompt,
    coveredMessageIds: selected.map((message) => message.id),
    omittedMessages,
  };
}
