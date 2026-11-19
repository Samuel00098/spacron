// One-click spawn of a single agent, for the "+" agent launcher (agent
// pane headers, terminal rooms, sidebar worktree rows and the empty stage):
// name, launch, adopt. It starts in a project worktree, never an isolated
// checkout — the "+" on an agent's room passes that agent's worktree, so the
// new agent joins it; elsewhere it is the sidebar's selected worktree.

import { get } from '$lib/stores/storeCompat';
import { activeProject } from '$lib/stores/workspace';
import { showToast } from '$lib/stores/notification';
import { layoutSnapshot } from '$lib/stores/layoutControl';
import { sessions, spawnAgentPreset, manualPromptTargetId, waitForAgentReady, sendPromptToSession } from '$lib/stores/terminal';
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

export interface QuickLaunchOptions {
  /** Provider model id; null/undefined keeps the CLI's configured model. */
  model?: string | null;
  reasoningEffort?: ChatReasoningEffort;
  /** Sent as the agent's first prompt once its CLI has come up. */
  prompt?: string;
  /**
   * The project worktree to start in: a worktree path, `null` for the main
   * checkout, or omitted for the sidebar's selected worktree.
   */
  worktreePath?: string | null;
}

export async function quickSpawnAgent(command: string, options: QuickLaunchOptions = {}): Promise<void> {
  const project = get(activeProject);
  if (!project) {
    showToast('Open a project first to spawn an agent', 'warning');
    return;
  }
  if (isAgentUpdating(command)) {
    showToast('That agent is updating. Try again when it finishes.', 'warning');
    return;
  }

  // DeepSeek Harness has no terminal UI: it opens its web panel instead.
  if (isDeepSeekHarness(command)) {
    void openDeepSeekHarnessPanel({ isolated: false });
    return;
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
      runtimeArgs: launch.runtimeArgs || undefined,
    });
    if (id === null) {
      showToast("Couldn't start the agent. See the console for details.", 'warning');
      return;
    }
    applyOrchestratorAgentName(id, name);
    adoptSpawnedAgent(id, project.id);
    manualPromptTargetId.set(id);
    showToast(`Spawned ${name}`, 'success', undefined, true);
    const prompt = options.prompt?.trim();
    if (prompt) {
      // A prompt typed before the CLI has drawn its input box is lost, so
      // wait for it to come up first.
      void waitForAgentReady(id).then((readiness) => {
        if (readiness === 'ready') sendPromptToSession(id, prompt, command);
      });
    }
  } catch (err) {
    console.error('Failed spawning agent:', err);
    showToast(err instanceof Error ? err.message : String(err), 'error');
  }
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
  const prompt = options.prompt?.trim();
  if (prompt) setThreadDraft(thread.id, prompt);
  showProjectChat();
  setInteractionMode('chat');
}
