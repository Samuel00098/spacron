/**
 * Slash commands as explicit session operations for structured chats.
 *
 * A structured chat has no TUI to type `/model` into, so the commands that
 * map to an operation Spacron can do itself (change model, clear, rename,
 * resume…) run here against the provider and the session store. Anything
 * else falls back to the provider's prompt channel, where agents that
 * understand their own slash commands (Claude stream-json, ACP agents that
 * advertise commands) still get it.
 */
import type { SlashCommand } from '$lib/services/terminal-chat-rich';
import { get } from '$lib/stores/storeCompat';
import { accountsState, activeAccount } from '$lib/stores/agentAccounts';
import { getAgentRoster } from '$lib/stores/runs';
import { enqueue } from '$lib/services/terminal-chat-queue';
import { addSideChat } from './side-chats';
import type { StructuredAccess } from './provider';
import { getStructuredAgentEntries, resolveStructuredAgentModels } from './agent-catalog';
import type { StructuredChatAgent } from './panes';
import { spawnStructuredSubagent, structuredChatProvider } from './registry';
import {
  archiveStructuredRecord,
  archiveStructuredSession,
  clearStructuredGoal,
  setStructuredGoal,
  clearStructuredConversation,
  compactStructuredSession,
  listArchivedSessions,
  forkStructuredSession,
  openStructuredRecordBeside,
  listStructuredSessions,
  recordForPane,
  recordHasConversation,
  renameStructuredSession,
  resumeStoppedTurn,
  resumeStructuredSessionInPane,
  rewindStructuredSession,
} from './session-store';

export interface StructuredCommandResult {
  /** True when Spacron ran the command; false means send it to the agent. */
  handled: boolean;
  /** A line to show in the chat as the command's output. */
  output?: string;
  error?: string;
  /** A UI action the caller performs (switch view, open the handoff picker). */
  action?: 'continue-in-terminal' | 'handoff';
  /** Run after the running turn ends, because the command cannot run mid-turn. */
  defer?: 'compact';
}

/**
 * Commands the agent owns: the chat does not run them, it sends them through
 * the prompt channel so the CLI answers them itself (`/init`, `/review`,
 * `/goal`, `/mcp`). Listed so the composer offers them, as Orca does.
 */
export const STRUCTURED_PASSTHROUGH: SlashCommand[] = [
  { name: '/goal', description: 'Set or view the agent\'s goal (sent to the agent)' },
  { name: '/plan', description: 'Ask the agent to work in plan mode (sent to the agent)' },
  { name: '/mcp', description: 'List or manage MCP servers (sent to the agent)' },
  { name: '/init', description: 'Initialize the project\'s instructions file (sent to the agent)' },
  { name: '/review', description: 'Review the current changes (sent to the agent)' },
  { name: '/help', description: 'Show the agent\'s own help (sent to the agent)' },
];

/** The operations this layer understands, for the composer's command menu. */
export const STRUCTURED_COMMANDS: SlashCommand[] = [
  { name: '/agent', description: 'Show or switch the active agent: /agent <name>' },
  { name: '/model', description: 'Show or change the model: /model <id>' },
  { name: '/effort', description: 'Show or change reasoning effort: /effort <level>' },
  { name: '/permissions', description: 'Access mode: /permissions ask | auto | full-access' },
  { name: '/compact', description: 'Compact conversation history: /compact' },
  { name: '/context', description: 'Show context window token usage: /context' },
  { name: '/account', description: 'Show the connected account for this chat: /account' },
  { name: '/clear', description: 'Start a new conversation in this chat' },
  { name: '/stop', description: 'Cancel the running turn' },
  { name: '/continue', description: 'Resume a stopped turn without adding a user message' },
  { name: '/retry', description: 'Send your last message again' },
  { name: '/rewind', description: 'Rewind conversation to previous checkpoint: /rewind' },
  { name: '/fork', description: 'Fork this conversation into a new branch: /fork [title]' },
  { name: '/steer', description: 'Inject guidance into current turn: /steer <text>' },
  { name: '/rename', description: 'Rename this chat: /rename <title>' },
  { name: '/subagent', description: 'Spawn a sub-agent (provider-native where supported, else Spacron-managed): /subagent [preset] <task>' },
  { name: '/history', description: 'List earlier chats with this agent' },
  { name: '/archive', description: 'Archive this chat (kept on disk; /unarchive brings it back)' },
  { name: '/archived', description: 'List this agent\'s archived chats' },
  { name: '/unarchive', description: 'Bring an archived chat back: /unarchive <number or id>' },
  { name: '/sidebar', description: 'Open a side chat in the right sidebar: /sidebar [first message]' },
  { name: '/side', description: 'Open a side chat in the right sidebar: /side [first message]' },
  { name: '/btw', description: 'Same as /sidebar: ask a side question in the right sidebar' },
  { name: '/resume', description: 'Resume an earlier chat here: /resume <number or id>' },
  { name: '/terminal', description: 'Continue this conversation in the terminal' },
  { name: '/handoff', description: 'Hand off this conversation to another agent' },
];

const ACCESS_ALIASES: Record<string, StructuredAccess> = {
  ask: 'ask',
  default: 'ask',
  auto: 'auto',
  'auto-edit': 'auto',
  full: 'full-access',
  'full-access': 'full-access',
  yolo: 'full-access',
};

function ago(ms: number): string {
  const minutes = Math.round((Date.now() - ms) / 60_000);
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  return hours < 48 ? `${hours}h ago` : `${Math.round(hours / 24)}d ago`;
}

/** Earlier chats this pane could resume: same provider and project, not open elsewhere. */
export function resumable(paneId: number) {
  const current = recordForPane(paneId);
  if (!current) return [];
  return listStructuredSessions({
    projectId: current.projectId,
    provider: current.provider,
    standalone: current.standalone,
  })
    .filter((record) => record.id !== current.id && record.lifecycle !== 'starting' && record.lifecycle !== 'working' && record.lifecycle !== 'ready')
    .filter(recordHasConversation);
}

/** Commands that change this pane's session, which only Spacron can do. */
const PANE_COMMANDS = new Set(['/agent', '/switch', '/model', '/effort', '/permissions', '/compact', '/clear', '/stop', '/continue', '/resume', '/sidebar', '/side', '/btw', '/terminal', '/handoff']);

export interface StructuredCommandContext {
  lastUserMessage?: string | null;
  agentCommands?: string[];
  lazyStart?: boolean;
  pendingModel?: string | null;
  pendingEffort?: string | null;
  pendingAccess?: StructuredAccess | null;
  onPickAccess?: (access: StructuredAccess) => void;
  ensureStarted?: () => Promise<number | null>;
  onSwitchAgent?: (agent: StructuredChatAgent, model: string | null, effort: string | null) => Promise<void>;
}

export async function runStructuredCommand(
  agent: string,
  paneId: number,
  input: string,
  context: StructuredCommandContext = {},
): Promise<StructuredCommandResult> {
  const provider = structuredChatProvider(agent);
  const text = input.trim();
  const [rawName, ...rest] = text.split(/\s+/);
  const name = rawName?.toLowerCase();
  const arg = rest.join(' ').trim();
  if (!provider || !name?.startsWith('/')) return { handled: false };
  if (context.agentCommands?.some((command) => command.toLowerCase() === name) && !PANE_COMMANDS.has(name)) return { handled: false };
  const state = provider.get(paneId);

  switch (name) {
    case '/agent':
    case '/switch': {
      // Only a host that can switch agents (the standalone chat) passes this.
      if (!context.onSwitchAgent) {
        return { handled: true, error: `This chat stays on ${provider.label}. Type /model to change its model.` };
      }
      const entries = getStructuredAgentEntries();
      if (!arg) {
        const installed = entries.filter((entry) => entry.installed);
        const uninstalledCount = entries.length - installed.length;
        const lines = installed.map((entry) => `${entry.agent === agent ? '• ' : '  '}${entry.name} (${entry.agent})`);
        if (uninstalledCount > 0) lines.push(`\n${uninstalledCount} more agent(s) can be installed from the agent picker.`);
        return { handled: true, output: `Structured agents:\n${lines.join('\n')}` };
      }
      if (state?.status === 'working') {
        return { handled: true, error: 'Wait for the running turn to finish before switching agents.' };
      }
      const query = arg.toLowerCase();
      const target = entries.find((entry) =>
        entry.agent.toLowerCase() === query
        || entry.command.toLowerCase() === query
        || entry.name.toLowerCase() === query
        || entry.name.toLowerCase().startsWith(query));
      if (!target) {
        return { handled: true, error: `Unknown agent "${arg}". Type /agent to list available agents.` };
      }
      if (!target.installed) {
        return { handled: true, error: `${target.name} is not installed yet. Install it from the agent picker first.` };
      }
      if (target.agent === agent) {
        return { handled: true, output: `Already using ${target.name}.` };
      }
      await context.onSwitchAgent(target.agent, null, null);
      return { handled: true, output: `Switched to ${target.name}.` };
    }
    case '/model': {
      const availableModels = state?.models?.length
        ? state.models.map((m) => ({ id: m.id, label: m.label }))
        : resolveStructuredAgentModels(agent as StructuredChatAgent, state).map((m) => ({ id: m.id, label: m.label }));
      const currentModelId = state?.model ?? context.pendingModel ?? null;
      if (!arg) {
        const list = availableModels.map((m) => `${m.id === currentModelId ? '• ' : '  '}${m.id}${m.label && m.label !== m.id ? ` (${m.label})` : ''}`).join('\n');
        return { handled: true, output: list ? `Models:\n${list}` : 'No model list from this agent yet.' };
      }
      const match = availableModels.find((m) => m.id === arg || m.label.toLowerCase() === arg.toLowerCase());
      if (availableModels.length && !match) return { handled: true, error: `${provider.label} doesn't offer "${arg}". Type /model to see the list.` };
      const chosen = match?.id ?? arg;
      if (!state && context.lazyStart && context.onSwitchAgent) {
        await context.onSwitchAgent(agent as StructuredChatAgent, chosen, context.pendingEffort ?? null);
        return { handled: true, output: `Model set to ${match?.label ?? chosen}.` };
      }
      provider.setModel(paneId, chosen);
      return { handled: true, output: `Model set to ${match?.label ?? chosen}.` };
    }
    case '/effort':
    case '/reasoning': {
      const availableModels = state?.models?.length
        ? state.models.map((m) => ({ id: m.id, label: m.label, efforts: m.efforts as string[] }))
        : resolveStructuredAgentModels(agent as StructuredChatAgent, state).map((m) => ({ id: m.id, label: m.label, efforts: (m.reasoningEfforts ?? []) as string[] }));
      const currentModelId = state?.model ?? context.pendingModel ?? null;
      const currentEffortId = state?.effort ?? context.pendingEffort ?? null;
      const model = availableModels.find((m) => m.id === currentModelId);
      if (!arg) return { handled: true, output: `Effort: ${currentEffortId ?? 'default'}${model?.efforts.length ? ` (available: ${model.efforts.join(', ')})` : ''}` };
      if (model?.efforts.length && !model.efforts.includes(arg)) return { handled: true, error: `${model.label} supports: ${model.efforts.join(', ')}.` };
      if (!state && context.lazyStart && context.onSwitchAgent) {
        await context.onSwitchAgent(agent as StructuredChatAgent, currentModelId, arg);
        return { handled: true, output: `Reasoning effort set to ${arg}.` };
      }
      provider.setEffort(paneId, arg);
      return { handled: true, output: `Reasoning effort set to ${arg}.` };
    }
    case '/permissions':
    case '/approvals':
    case '/access': {
      const supported = provider.capabilities?.supportedAccessModes ?? ['ask', 'auto', 'full-access'];
      if (!arg) return { handled: true, output: `Access: ${state?.access ?? context.pendingAccess ?? 'ask'}. Supported options: ${supported.join(', ')}.` };
      const access = ACCESS_ALIASES[arg.toLowerCase()];
      if (!access) return { handled: true, error: `Use ${supported.join(', ')}.` };
      if (!supported.includes(access)) {
        return { handled: true, error: `${provider.label} only supports [${supported.join(', ')}]. Discrete approvals are handled per request.` };
      }
      if (!state && context.lazyStart && context.onPickAccess) context.onPickAccess(access);
      else provider.setAccess(paneId, access);
      return { handled: true, output: `Access set to ${access}.` };
    }
    case '/compact':
    case '/summarize': {
      if (state?.status === 'working') {
        return { handled: true, defer: 'compact', output: 'This turn is still running: compaction will start as soon as it ends.' };
      }
      compactStructuredSession(paneId);
      const native = provider.capabilities?.compact === 'native';
      if (native) {
        if (provider.compact) await provider.compact(paneId);
        else await provider.send(paneId, '/compact');
        return { handled: true, output: `Compacted local history and requested context compaction from ${provider.label}…` };
      }
      return { handled: true, output: `Conversation journal compacted locally. (Note: ${provider.label} does not support native provider context compaction.)` };
    }
    case '/context':
    case '/usage': {
      const record = recordForPane(paneId);
      const continuity = record?.restoredMode === 'native'
        ? ` · Continuity: native ${provider.label} session`
        : record?.restoredMode === 'journal-only'
          ? ` · Continuity: journal-only history (fresh ${provider.label} session)`
          : '';
      if (state?.contextUsed != null && state?.contextWindow != null) {
        const pct = Math.round((state.contextUsed / Math.max(state.contextWindow, 1)) * 100);
        return { handled: true, output: `Context: ${state.contextUsed.toLocaleString()} / ${state.contextWindow.toLocaleString()} tokens (${pct}%)${continuity}.` };
      }
      return { handled: true, output: `Context usage: not reported by ${provider.label} yet${continuity}.` };
    }
    case '/rewind':
    case '/undo': {
      if (state?.status === 'working') return { handled: true, error: 'Stop the running turn before rewinding.' };
      const mode = provider.capabilities?.rewindMode
        ?? (provider.capabilities?.rewind ? 'conversation-reset' : 'none');
      if (mode === 'none') {
        return { handled: true, error: `${provider.label} does not support rewind.` };
      }
      const ok = await rewindStructuredSession(paneId);
      if (!ok) return { handled: true, error: 'Could not rewind conversation.' };
      // Say what actually changed: neither path reverts files on disk, and only
      // Codex's rollback changes the provider's own thread.
      const modeDesc = mode === 'native-provider'
        ? `native ${provider.label} thread rollback, conversation only: files on disk are unchanged`
        : `conversation reset, not a native ${provider.label} rollback: this chat restarted with the shortened history and ${provider.label}'s own saved session still has the undone turn. Files on disk are unchanged`;
      return { handled: true, output: `Rewound conversation to previous turn (${modeDesc}).` };
    }
    case '/fork':
    case '/branch': {
      if (state?.status === 'working') return { handled: true, error: 'Stop the running turn before forking.' };
      const forked = await forkStructuredSession(paneId, { title: arg || undefined });
      if (!forked) return { handled: true, error: 'Could not fork conversation.' };
      const modeDesc = forked.forkMode === 'native'
        ? `a separate native ${provider.label} conversation`
        : `a separate Spacron history, not a native ${provider.label} fork: the new chat starts a fresh ${provider.label} conversation and sends it the history with your first message`;
      return {
        handled: true,
        output: `Forked conversation to "${forked.title}" (${modeDesc}). Resume with /resume ${forked.id}.`,
      };
    }
    case '/steer': {
      if (!arg) return { handled: true, error: 'Provide steering guidance: /steer <instructions>' };
      if (state?.status !== 'working') return { handled: true, error: 'No turn is currently running to steer. Send as a normal message.' };
      if (provider.capabilities?.steering === 'inject') {
        if (provider.steer) await provider.steer(paneId, arg);
        else await provider.send(paneId, arg);
        return { handled: true, output: `Injected steering instructions into running turn for ${provider.label}.` };
      } else {
        enqueue(paneId, arg);
        return { handled: true, output: `Added follow-up to message queue for ${provider.label}. It will send automatically when the current turn finishes.` };
      }
    }
    case '/account': {
      const record = recordForPane(paneId);
      const active = activeAccount(get(accountsState), agent)?.id ?? 'default';
      const sessionAccount = record?.accountId ?? 'default';
      if (sessionAccount === active) {
        return { handled: true, output: `Account: ${sessionAccount}.` };
      }
      return {
        handled: true,
        output: `Session account: ${sessionAccount} (active in Settings is "${active}"). Restart with /new or reopen to apply the new account.`,
      };
    }
    case '/clear':
    case '/new': {
      if (state?.status === 'working') return { handled: true, error: 'Stop the running turn before clearing.' };
      const ok = await clearStructuredConversation(paneId);
      return ok ? { handled: true } : { handled: true, error: `${provider.label} could not start a new conversation.` };
    }
    case '/stop':
    case '/cancel':
      if (state?.status !== 'working') return { handled: true, output: 'Nothing is running.' };
      await provider.interrupt(paneId);
      return { handled: true, output: 'Turn cancelled.' };
    case '/continue': {
      if (state?.status === 'working') return { handled: true, error: 'A turn is already running.' };
      const ok = await resumeStoppedTurn(paneId);
      return ok ? { handled: true } : { handled: true, error: `Couldn't resume ${provider.label}.` };
    }
    case '/retry': {
      const last = context.lastUserMessage?.trim();
      if (!last) return { handled: true, error: 'There is no earlier message to send again.' };
      if (state?.status === 'working') return { handled: true, error: 'Wait for the running turn to finish.' };
      await provider.send(paneId, last);
      return { handled: true };
    }
    case '/rename':
      if (!arg) return { handled: true, error: 'Give a title: /rename <title>' };
      return renameStructuredSession(paneId, arg)
        ? { handled: true, output: `Renamed to "${arg}".` }
        : { handled: true, error: 'This chat has no session record to rename.' };
    case '/history':
    case '/sessions': {
      const list = resumable(paneId).slice(0, 15);
      if (!list.length) return { handled: true, output: 'No earlier chats with this agent in this project.' };
      return {
        handled: true,
        output: `Earlier chats (resume with /resume <number>):\n${list.map((r, i) => `${i + 1}. ${r.title ?? 'Untitled'} · ${ago(r.updatedAt)}${r.lifecycle === 'closed' ? ' · closed' : ''}`).join('\n')}`,
      };
    }
    case '/resume': {
      const list = resumable(paneId);
      const byIndex = /^\d+$/.test(arg) ? list[Number(arg) - 1] : null;
      const target = byIndex ?? list.find((r) => r.id === arg) ?? (!arg ? list[0] : null);
      if (!target) return { handled: true, error: arg ? `No earlier chat "${arg}". Type /history to list them.` : 'No earlier chat to resume.' };
      if (state?.status === 'working') return { handled: true, error: 'Stop the running turn before switching chats.' };
      const ok = await resumeStructuredSessionInPane(paneId, target.id);
      return ok ? { handled: true, output: `Resumed "${target.title ?? 'Untitled'}".` } : { handled: true, error: `Couldn't resume "${target.title ?? target.id}".` };
    }
    case '/goal': {
      // The agent owns `/goal`; this only mirrors the objective so the panel
      // above the composer can show it, and still passes the command through.
      const record = recordForPane(paneId);
      const word = arg.toLowerCase();
      if (!record || !arg) return { handled: false };
      if (word === 'pause' || word === 'resume') {
        if (record.goal) setStructuredGoal(paneId, record.goal.text, word === 'pause' ? 'paused' : 'active');
      } else if (word === 'clear' || word === 'stop' || word === 'done') {
        clearStructuredGoal(paneId);
      } else {
        setStructuredGoal(paneId, arg, 'active');
      }
      return { handled: false };
    }
    case '/archive': {
      if (state?.status === 'working') return { handled: true, error: 'Stop the running turn before archiving.' };
      const record = recordForPane(paneId);
      if (!record) return { handled: true, error: 'This chat has no session record to archive.' };
      return archiveStructuredSession(paneId)
        ? { handled: true, output: `Archived “${record.title ?? 'this chat'}”. It stays on disk: /archived lists it, /unarchive <n> brings it back.` }
        : { handled: true, error: 'Could not archive this chat.' };
    }
    case '/archived': {
      const current = recordForPane(paneId);
      const list = listArchivedSessions({ projectId: current?.projectId ?? null, provider: agent }).slice(0, 20);
      if (!list.length) return { handled: true, output: `No archived ${provider.label} chats in this project.` };
      return {
        handled: true,
        output: `Archived chats (bring one back with /unarchive <number>):\n${list.map((r, i) => `${i + 1}. ${r.title ?? 'Untitled'} · archived ${ago(r.archivedAt ?? r.updatedAt)}`).join('\n')}`,
      };
    }
    case '/unarchive': {
      const current = recordForPane(paneId);
      const list = listArchivedSessions({ projectId: current?.projectId ?? null, provider: agent });
      const target = /^\d+$/.test(arg) ? list[Number(arg) - 1] : list.find((r) => r.id === arg);
      if (!target) return { handled: true, error: arg ? `No archived chat “${arg}”. Type /archived to list them.` : 'Which chat? /archived lists them: /unarchive <number>' };
      return archiveStructuredRecord(target.id, false)
        ? { handled: true, output: `Restored “${target.title ?? 'Untitled'}”. It is in the chat tabs again; /resume ${target.id} opens it here.` }
        : { handled: true, error: 'Could not restore that chat.' };
    }
    case '/sidebar':
    case '/btw':
    case '/side': {
      let activePaneId = paneId;
      let current = recordForPane(activePaneId);
      if (!current && context.ensureStarted) {
        const startedPane = await context.ensureStarted();
        if (startedPane !== null) {
          activePaneId = startedPane;
          current = recordForPane(activePaneId);
        }
      }
      const title = `Side: ${current?.title ?? provider.label}`.slice(0, 120);
      const forked = await forkStructuredSession(activePaneId, { title });
      if (!forked) return { handled: true, error: 'Could not open a side chat from this conversation.' };
      // The side chat gets its own tab in the right sidebar: this pane keeps its
      // agent, and any running turn carries on.
      const sidePane = await openStructuredRecordBeside(activePaneId, forked.id);
      if (sidePane == null) return { handled: true, error: `Could not open a side chat.${arg ? ` Your message was not sent: ${arg}` : ''}` };
      addSideChat({ paneId: sidePane, parentPaneId: activePaneId, projectId: recordForPane(sidePane)?.projectId ?? current?.projectId ?? null });
      const side = provider.get(sidePane);
      if (!side || side.status === 'failed' || side.status === 'closed') {
        return { handled: true, error: `The side chat could not start${side?.error ? `: ${side.error}` : '.'}${arg ? ` Your message was not sent: ${arg}` : ''}` };
      }
      // Not awaited: some agents answer only when the turn ends, and this chat
      // must stay usable. Failures show in the side chat itself.
      if (arg) void provider.send(sidePane, arg).catch((error) => console.warn('Side chat message failed', error));
      return {
        handled: true,
        output: `Opened a side chat in the right sidebar (“${forked.title}”)${arg ? ' and sent your message there' : ''}. This chat is untouched.`,
      };
    }
    case '/terminal': {
      if (recordForPane(paneId)?.standalone) {
        return { handled: true, error: 'Standalone chats have no project terminal. Use "Create project from chat" first.' };
      }
      return { handled: true, action: 'continue-in-terminal' };
    }
    case '/subagent': {
      if (!arg) {
        return { handled: true, output: 'Usage: /subagent [preset] <task prompt> (e.g. /subagent claude Fix unit tests)' };
      }
      const parts = arg.split(/\s+/);
      const roster = getAgentRoster();
      const knownPresets = roster.map((r) => r.command.toLowerCase());
      let targetPreset = agent;
      let prompt = arg;
      if (knownPresets.includes(parts[0].toLowerCase())) {
        targetPreset = parts[0].toLowerCase();
        prompt = parts.slice(1).join(' ').trim();
      }
      if (!prompt) {
        return { handled: true, error: 'Please provide a task prompt for the sub-agent.' };
      }
      try {
        const sub = await spawnStructuredSubagent(targetPreset, paneId, prompt, { agent: targetPreset });
        const how = sub?.origin === 'native'
          ? `native ${targetPreset} sub-agent`
          : `${targetPreset} as a Spacron-managed agent session`;
        return { handled: true, output: `Spawned ${how}${sub?.branch ? ` on branch ${sub.branch}` : ''}. You can track and open its pane in the Sub-agents panel.` };
      } catch (err) {
        return { handled: true, error: `Failed to spawn sub-agent: ${err instanceof Error ? err.message : String(err)}` };
      }
    }
    case '/handoff':
      return { handled: true, action: 'handoff' };
    default:
      return { handled: false };
  }
}
