// One-click spawn of a single agent, for the "+" agent launcher (agent
// pane headers, terminal rooms, sidebar worktree rows and the empty stage):
// name, launch, adopt. It starts in a project worktree, never an isolated
// checkout — the "+" on an agent's room passes that agent's worktree, so the
// new agent joins it; elsewhere it is the sidebar's selected worktree.

import { get } from '$lib/stores/storeCompat';
import { applyLaunchView, launchViewFor, readTerminalTranscript, resumeArgs, transcriptAgentFor, type AgentLaunchView } from '$lib/services/terminal-chat';
import { activeProject, projects } from '$lib/stores/workspace';
import { showToast } from '$lib/stores/notification';
import { layoutSnapshot } from '$lib/stores/layoutControl';
import { sessions, spawnAgentPreset, manualPromptTargetId, waitForAgentReady, sendPromptToSession, createTerminalSession, updateSessionTitle, setActiveSession } from '$lib/stores/terminal';
import { useLayoutStore } from '$lib/stores/zustand/layout';
import { markStructuredChatPane, setStructuredChatHistory, structuredChatAgentFor, type StructuredChatAgent } from '$lib/services/structured-chat/panes';
import { bindStructuredAccount, claimClosedChat, releaseStructuredSessionClaim, renameStructuredSession, restoreStructuredInChat } from '$lib/services/structured-chat/session-store';
import { getStructuredChat, sendStructuredChat, setStructuredChatEffort, setStructuredChatModel, startStructuredChat, structuredChatProvider, subscribeStructuredChat } from '$lib/services/structured-chat/registry';
import { structuredAccessFor } from '$lib/services/structured-chat/defaults';
import { getAgentProviderLaunchOptions } from '$lib/services/chat-provider-adapters';
import { createChatThread, setChatThreadWorktree, setThreadDraft, sharedWorktreeAt } from '$lib/stores/chatThreads';
import { showProjectChat } from '$lib/stores/chatNavigation';
import { setInteractionMode } from '$lib/stores/interactionMode';
import type { ChatReasoningEffort } from '$lib/types/chat';
import { isAgentUpdating } from '$lib/stores/agentUpdates';
import { pickAssistantName } from '$lib/services/orchestrator/agent-names';
import { applyOrchestratorAgentName } from '$lib/services/orchestrator/terminal-lease';
import { adoptSpawnedAgent } from '$lib/stores/orchestrator';
import { isDeepSeekHarness, openDeepSeekHarnessPanel } from '$lib/services/deepseek-harness';
import { workingRootFor } from '$lib/stores/projectWorktrees';
import { allProjectSettings, projectConfigFor } from '$lib/stores/projectSettings';

function enrichPromptWithProjectInstructions(rawPrompt: string | undefined, projectId: string, rootPath: string): string | undefined {
  if (!rawPrompt?.trim()) return rawPrompt;
  const pConfig = projectConfigFor(get(allProjectSettings), rootPath, projectId);
  const instructions = pConfig?.customInstructions?.trim();
  if (!instructions || rawPrompt.includes(instructions)) return rawPrompt;
  return `${rawPrompt}\n\nProject Instructions & Guidelines:\n${instructions}`;
}

export interface QuickLaunchOptions {
  /** Explicit owner when launching from a background project. */
  projectId?: string;
  /** Provider model id; null/undefined keeps the CLI's configured model. */
  model?: string | null;
  reasoningEffort?: ChatReasoningEffort;
  /** Sent as the agent's first prompt once its CLI has come up. */
  prompt?: string;
  /** Open in the terminal or its chat view; omitted uses Settings → Agents. */
  view?: AgentLaunchView;
  /**
   * The project worktree to start in: a worktree path, `null` for the main
   * checkout, or omitted for the sidebar's selected worktree.
   */
  worktreePath?: string | null;
  /** Continue this CLI conversation (from Agent History) instead of starting a new one. */
  resumeId?: string | null;
  /** Name for a resumed conversation, so the chat is not just "Claude Chat". */
  title?: string | null;
  /** Launch under this managed account, or `default` for the CLI's own home (a resumed session must use its owner). */
  accountId?: string | null;
  accountLabel?: string | null;
}

export async function quickSpawnAgent(command: string, options: QuickLaunchOptions = {}): Promise<number | null> {
  const project = options.projectId ? get(projects).get(options.projectId) : get(activeProject);
  if (!project) {
    showToast('Open a project first to spawn an agent', 'warning');
    return null;
  }
  if (isAgentUpdating(command)) {
    showToast('That agent is updating. Try again when it finishes.', 'warning');
    return null;
  }

  // DeepSeek Harness has no terminal UI: it opens its web panel instead, in
  // the worktree the launch asked for (the row's "+" names it) or the sidebar's
  // selected one.
  if (isDeepSeekHarness(command)) {
    void openDeepSeekHarnessPanel({ worktreePath: options.worktreePath });
    return null;
  }

  // Chat launches use the provider protocol, while Terminal launches use the
  // CLI PTY. Both render through the same TerminalChatView; only the backend
  // changes, like Orca's structured Chat UI versus Continue in Terminal.
  const view = options.view ?? launchViewFor(command);
  if (options.resumeId && !resumeFlagsFor(command, options.resumeId)) {
    showToast('This agent cannot resume that session. No new conversation was started.', 'warning');
    return null;
  }
  const structured = view === 'chat' ? structuredChatAgentFor(command) : null;
  if (structured && structuredChatProvider(structured)) {
    const cwd = options.worktreePath === undefined
      ? workingRootFor(project.id, project.root_path)
      : options.worktreePath ?? project.root_path;
    return await openStructuredChat(command, structured, cwd, project.id, project.root_path, options);
  }

  const takenNames = get(sessions)
    .filter((s) => s.isRunning && s.agentName)
    .map((s) => s.agentName as string);
  const name = pickAssistantName(takenNames);

  try {
    const launch = getAgentProviderLaunchOptions(command, {
      model: options.model ?? null,
      reasoningEffort: options.reasoningEffort ?? 'default',
    });
    const cwd = options.worktreePath === undefined
      ? workingRootFor(project.id, project.root_path)
      : options.worktreePath ?? project.root_path;
    const id = await spawnAgentPreset(command, cwd, {
      isDev: get(layoutSnapshot).ambient === 'development',
      projectId: project.id,
      runtimeArgs: [launch.runtimeArgs, resumeFlagsFor(command, options.resumeId)].filter(Boolean).join(' ') || undefined,
      ...(options.accountId ? { accountId: options.accountId } : {}),
    });
    if (id === null) {
      showToast("Couldn't start the agent. See the console for details.", 'warning');
      return null;
    }
    applyOrchestratorAgentName(id, name);
    adoptSpawnedAgent(id, project.id);
    applyLaunchView(id, command, options.view);
    manualPromptTargetId.set(id);
    setActiveSession(id);
    useLayoutStore.getState().showTerminal();
    showToast(`Spawned ${name}`, 'success', undefined, true);
    const enriched = enrichPromptWithProjectInstructions(options.prompt, project.id, project.root_path);
    const prompt = enriched?.trim();
    if (prompt) {
      // A prompt typed before the CLI has drawn its input box is lost, so
      // wait for it to come up first.
      void waitForAgentReady(id).then((readiness) => {
        if (readiness === 'ready') sendPromptToSession(id, prompt, command);
      });
    }
    return id;
  } catch (err) {
    console.error('Failed spawning agent:', err);
    showToast(err instanceof Error ? err.message : String(err), 'error');
    return null;
  }
}

/** The CLI's own resume flags for a conversation id, or '' when there is none. */
function resumeFlagsFor(command: string, resumeId: string | null | undefined): string {
  const agent = transcriptAgentFor(command);
  return resumeId && agent ? resumeArgs(agent, resumeId) : '';
}

async function openStructuredChat(
  command: string,
  agent: StructuredChatAgent,
  cwd: string,
  projectId: string,
  projectRoot: string,
  options: QuickLaunchOptions,
): Promise<number | null> {
  // Structured chats still use a terminal session as their pane host, but the
  // host belongs in the agent's room rather than the user's terminal mosaic.
  // Marking it as an agent also lets AppShell create the same `agent:<id>` room
  // used by CLI launches, so the structured view overtakes that room in place.
  const previous = options.resumeId || options.prompt?.trim()
    ? null
    : claimClosedChat(projectId, agent, command, cwd, options.accountId);
  const id = await createTerminalSession(cwd, undefined, projectId, {
    assignPane: false,
    agentPreset: command,
    isDev: get(layoutSnapshot).ambient === 'development',
  }).catch((error) => {
    if (previous) releaseStructuredSessionClaim(previous.id);
    throw error;
  });
  if (id === null) {
    if (previous) releaseStructuredSessionClaim(previous.id);
    showToast("Couldn't open the chat. See the console for details.", 'warning');
    return null;
  }
  if (previous) {
    setActiveSession(id);
    useLayoutStore.getState().showTerminal();
    await restoreStructuredInChat(id, previous);
    return id;
  }
  markStructuredChatPane(id, agent, command, 'chat');
  if (options.accountId) bindStructuredAccount(id, options.accountId, options.accountLabel);
  updateSessionTitle(id, options.title?.trim() || `${structuredChatProvider(agent)?.label ?? 'Agent'} Chat`);
  // A resumed conversation is the CLI's own: its provider does not replay it,
  // so it is read from the CLI's transcript and shown above the new messages.
  if (options.resumeId) {
    const transcriptAgent = transcriptAgentFor(command);
    if (transcriptAgent) {
      try {
        const transcript = await readTerminalTranscript({
          sessionId: id,
          agent: transcriptAgent,
          cwd,
          sinceMs: 0,
          boundSessionId: options.resumeId,
          knownRevision: null,
          account: options.accountId && options.accountId !== 'default' ? options.accountId : null,
        });
        setStructuredChatHistory(id, transcript.messages);
      } catch {
        // No readable transcript: the chat still continues the conversation, just without the scrollback.
      }
    }
  }
  setActiveSession(id);
  useLayoutStore.getState().showTerminal();
  await startStructuredChat(agent, id, cwd, {
    access: structuredAccessFor(command),
    resumeId: options.resumeId ?? null,
    ...(options.accountId ? { accountId: options.accountId } : {}),
    model: options.model,
    effort: options.reasoningEffort && options.reasoningEffort !== 'default' ? options.reasoningEffort : undefined,
  });
  if (options.title?.trim()) renameStructuredSession(id, options.title.trim());
  // Codex applies both selections during startup, before the thread is ready.
  // Other providers may need their model or effort set after connecting.
  if (agent !== 'codex') {
    if (options.model) setStructuredChatModel(agent, id, options.model);
    if (options.reasoningEffort && options.reasoningEffort !== 'default') setStructuredChatEffort(agent, id, options.reasoningEffort);
  }
  const prompt = enrichPromptWithProjectInstructions(options.prompt, projectId, projectRoot)?.trim();
  if (prompt) {
    if (getStructuredChat(agent, id)?.status === 'ready') {
      await sendStructuredChat(agent, id, prompt);
    } else {
      let sent = false;
      const unsub = subscribeStructuredChat(agent, () => {
        if (sent) return;
        const current = getStructuredChat(agent, id);
        if (current?.status === 'ready') {
          sent = true;
          unsub();
          void sendStructuredChat(agent, id, prompt);
        } else if (current?.status === 'failed' || !current) {
          unsub();
        }
      });
      setTimeout(() => unsub(), 20000);
    }
  }
  return id;
}

/**
 * Open a new Chat-mode thread driven by this agent, with the chosen model and
 * effort. The prompt is left in the composer for the user to send.
 */
export function quickStartAgentChat(
  agent: { command: string; name: string },
  options: QuickLaunchOptions = {},
): void {
  const project = get(activeProject);
  if (!project) {
    showToast('Open a project first to start a chat', 'warning');
    return;
  }
  const thread = createChatThread(project.id, {
    agentPreset: agent.command,
    agentName: agent.name,
    model: options.model ?? null,
    reasoningEffort: options.reasoningEffort ?? 'default',
  });
  // Started from another agent's room: join that agent's worktree instead of
  // the sidebar's selected one.
  if (options.worktreePath !== undefined) {
    setChatThreadWorktree(thread.id, sharedWorktreeAt(project.id, options.worktreePath));
  }
  const prompt = enrichPromptWithProjectInstructions(options.prompt, project.id, project.root_path)?.trim();
  if (prompt) setThreadDraft(thread.id, prompt);
  showProjectChat();
  setInteractionMode('chat');
}
