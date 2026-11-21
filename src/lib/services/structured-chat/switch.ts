/**
 * Moving one agent pane between its terminal and a structured chat, keeping
 * the conversation (Orca's "Continue in chat" / "Continue in terminal").
 *
 * A structured chat is a separate agent process, so it can't attach to the CLI
 * running in the terminal. Going to chat quits that CLI (Ctrl+C at its idle
 * prompt, `quitAgentCli`), then starts the protocol agent in the same pane,
 * resuming the same conversation by its native id (Codex thread, Claude
 * session, ACP session). Going back closes the protocol agent and relaunches
 * the CLI in the pane's shell with its resume flag. The earlier messages are
 * read from the CLI's transcript and shown above the live conversation, since
 * a resumed protocol session does not replay them.
 */
import { get } from '$lib/stores/storeCompat';
import { showToast } from '$lib/stores/notification';
import {
  getSessionAgentStartedAt,
  getSessionRoot,
  relaunchAgentInSession,
  sessions,
} from '$lib/stores/terminal';
import {
  getBoundTranscript,
  permissionArgs,
  quitAgentCli,
  readTerminalTranscript,
  resumeArgs,
  sessionPermissionMode,
  setTerminalChatView,
  shellPromptShowing,
  transcriptAgentFor,
} from '$lib/services/terminal-chat';
import { readTerminalScreen } from '$lib/services/terminal-screen';
import {
  forgetStructuredChatPane,
  structuredChatHistory,
  structuredChatPanes,
  markStructuredChatPane,
  setStructuredChatHistory,
  structuredChatAgentFor,
  structuredChatPreset,
} from './panes';
import { structuredChatProvider } from './registry';
import { structuredAccessFor } from './defaults';

function presetOf(sessionId: number): string | null {
  return get(sessions).find((s) => s.id === sessionId)?.agentPreset ?? structuredChatPreset(sessionId);
}

/** Whether this pane's agent can run as a structured chat. */
export function canContinueInChat(preset: string | null | undefined): boolean {
  const agent = preset ? structuredChatAgentFor(preset) : null;
  return Boolean(agent && structuredChatProvider(agent));
}

/**
 * Turn a terminal agent pane into a structured chat on the same conversation.
 * Returns false when the agent has no structured chat (the caller falls back
 * to the terminal-backed chat view).
 */
export async function continueInChat(sessionId: number): Promise<boolean> {
  const preset = presetOf(sessionId);
  const agent = preset ? structuredChatAgentFor(preset) : null;
  const provider = agent ? structuredChatProvider(agent) : null;
  if (!preset || !agent || !provider) return false;
  // A second click while the CLI is quitting would send another round of Ctrl+C.
  if (switching.has(sessionId)) return true;
  switching.add(sessionId);
  try {
    return await switchToChat(sessionId, preset, agent, provider);
  } finally {
    switching.delete(sessionId);
  }
}

async function switchToChat(
  sessionId: number,
  preset: string,
  agent: NonNullable<ReturnType<typeof structuredChatAgentFor>>,
  provider: NonNullable<ReturnType<typeof structuredChatProvider>>,
): Promise<boolean> {
  const cwd = getSessionRoot(sessionId) ?? '.';

  // The conversation so far, and its native id, from the CLI's transcript.
  let resumeId: string | null = getBoundTranscript(sessionId);
  const transcriptAgent = transcriptAgentFor(preset);
  if (transcriptAgent) {
    try {
      const transcript = await readTerminalTranscript({
        sessionId,
        agent: transcriptAgent,
        cwd,
        sinceMs: getSessionAgentStartedAt(sessionId) ?? 0,
        boundSessionId: resumeId,
        knownRevision: null,
      });
      resumeId = transcript.sessionId ?? resumeId;
      setStructuredChatHistory(sessionId, transcript.messages);
    } catch {
      // No transcript yet: the chat starts empty.
    }
  }

  if (!(await quitAgentCli(sessionId))) {
    showToast(`${provider.label} didn't quit in the terminal, so the chat wasn't opened.`, 'warning');
    return true;
  }
  setTerminalChatView(sessionId, false);
  markStructuredChatPane(sessionId, agent, preset);
  await provider.start(sessionId, cwd, { resumeId, access: structuredAccessFor(preset) });
  const state = provider.get(sessionId);
  if (!state || state.status === 'failed') {
    // The CLI has already quit: never leave the pane at a bare shell. Put the
    // CLI back on the same conversation and say why the chat didn't open.
    const reason = state?.error ?? `${provider.label} chat could not start.`;
    await provider.close(sessionId).catch(() => undefined);
    forgetStructuredChatPane(sessionId);
    await relaunchCli(sessionId, preset, resumeId);
    showToast(`${reason} Back in the terminal on the same conversation.`, 'warning', 8000);
  }
  return true;
}

/** Start the CLI again in the pane's shell, resuming `conversation` when known. */
async function relaunchCli(sessionId: number, preset: string, conversation: string | null): Promise<boolean> {
  const transcriptAgent = transcriptAgentFor(preset);
  // `relaunchAgentInSession` puts `args` in place of the permission args, so
  // they have to be added back or the CLI comes back with default approvals
  // (seen live: `codex --dangerously-bypass-approvals-and-sandbox` returned as
  // a bare `codex`).
  const args = transcriptAgent
    ? [
      conversation ? resumeArgs(transcriptAgent, conversation) : '',
      permissionArgs(transcriptAgent, sessionPermissionMode(sessionId)),
    ].filter(Boolean).join(' ')
    : '';
  // `relaunchAgentInSession` marks the pane briefed. Marking it again without
  // that flag (as this used to) reset it and fired the auto-brief, which typed
  // a charter into the freshly started CLI.
  return relaunchAgentInSession(sessionId, preset, args);
}

/**
 * Watch a relaunched CLI long enough to see it either settle or exit. A CLI
 * that refuses its arguments ("No saved session found…") prints and exits
 * within a few seconds, leaving the shell prompt as the last line; one that
 * started never shows the bare prompt (its interface covers the screen).
 * Polled rather than checked once: `waitForAgentReady` can say "ready" on the
 * echo of the launch line alone, before the CLI has even run.
 */
async function cliStayedUp(sessionId: number, watchMs = 10_000): Promise<boolean> {
  const started = Date.now();
  // Let the launch line leave the prompt row first.
  await new Promise((resolve) => setTimeout(resolve, 1200));
  while (Date.now() - started < watchMs) {
    if (shellPromptShowing(sessionId)) return false;
    await new Promise((resolve) => setTimeout(resolve, 400));
  }
  return !shellPromptShowing(sessionId);
}

/**
 * The conversation id to resume, only when the agent has saved it. Codex and
 * Claude create the conversation when the chat opens but write it to disk only
 * after the first message; resuming an unsaved one exits the CLI ("No saved
 * session found with ID…"). A chat that came from the terminal (it has
 * history) or that has a user message has been saved.
 */
function savedConversation(sessionId: number, conversation: string | null, items: readonly { kind: string }[] = []): string | null {
  if (!conversation) return null;
  const fromTerminal = (get(structuredChatHistory)[sessionId] ?? []).length > 0;
  const chatted = items.some((item) => item.kind === 'user');
  return fromTerminal || chatted ? conversation : null;
}

/** Turn a structured chat pane back into its terminal CLI on the same conversation. */
export async function continueInTerminal(sessionId: number): Promise<void> {
  const preset = presetOf(sessionId);
  const agent = preset ? structuredChatAgentFor(preset) : null;
  const provider = agent ? structuredChatProvider(agent) : null;
  if (!preset || !agent || !provider) return;
  if (switching.has(sessionId)) return;
  switching.add(sessionId);
  try {
    const live = provider.get(sessionId);
    const conversation = savedConversation(sessionId, provider.conversationId?.(sessionId) ?? null, live?.items);
    const access = live?.access ?? structuredAccessFor(preset);
    await provider.close(sessionId);
    forgetStructuredChatPane(sessionId);
    const cwd = getSessionRoot(sessionId) ?? '.';
    const backToChat = async (why: string) => {
      // Keep the conversation usable: reopen the chat rather than leave a shell.
      markStructuredChatPane(sessionId, agent, preset);
      await provider.start(sessionId, cwd, { resumeId: conversation, access });
      showToast(`${why} Staying in the chat.`, 'warning', 8000);
    };
    if (!(await relaunchCli(sessionId, preset, conversation))) {
      await backToChat(`Couldn't start ${provider.label} in this terminal.`);
      return;
    }
    if (!(await cliStayedUp(sessionId))) {
      const last = (readTerminalScreen(sessionId, { maxLines: 6 }) ?? '').split('\n').map((l) => l.trim()).filter(Boolean);
      const said = last.length > 1 ? last[last.length - 2] : null;
      await backToChat(`${provider.label} exited right after starting in the terminal${said && !said.endsWith('>') ? ` ("${said.slice(0, 120)}")` : ''}.`);
    }
  } finally {
    switching.delete(sessionId);
  }
}

/** Panes in the middle of a switch; a second click must not start another. */
const switching = new Set<number>();

/** Whether this pane shows a structured chat right now. */
export function isStructuredChatPane(sessionId: number): boolean {
  return sessionId in get(structuredChatPanes);
}
