// One-click spawn of a single agent, for the "+" menu on an agent pane's
// header. It walks the same steps as one agent picked in AgentSpawnModal —
// name, launch, adopt — with the CLI's own model. Unlike the picker it always
// runs in the main repo, never a worktree: the "+" is the fast path, and the
// picker ("More options…") is where placement is chosen. Keep the shared steps
// in step with the picker.

import { get } from '$lib/stores/storeCompat';
import { activeProject } from '$lib/stores/workspace';
import { showToast } from '$lib/stores/notification';
import { layoutSnapshot } from '$lib/stores/layoutControl';
import { sessions, spawnAgentPreset, manualPromptTargetId } from '$lib/stores/terminal';
import { isAgentUpdating } from '$lib/stores/agentUpdates';
import { pickAssistantName } from '$lib/services/orchestrator/agent-names';
import { applyOrchestratorAgentName } from '$lib/services/orchestrator/terminal-lease';
import { adoptSpawnedAgent } from '$lib/stores/orchestrator';
import { isDeepSeekHarness, openDeepSeekHarnessPanel } from '$lib/services/deepseek-harness';

export async function quickSpawnAgent(command: string): Promise<void> {
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
    const id = await spawnAgentPreset(command, project.root_path, {
      isDev: get(layoutSnapshot).ambient === 'development',
      projectId: project.id,
    });
    if (id === null) {
      showToast("Couldn't start the agent. See the console for details.", 'warning');
      return;
    }
    applyOrchestratorAgentName(id, name);
    adoptSpawnedAgent(id, project.id);
    manualPromptTargetId.set(id);
    showToast(`Spawned ${name}`, 'success', undefined, true);
  } catch (err) {
    console.error('Failed spawning agent:', err);
    showToast(err instanceof Error ? err.message : String(err), 'error');
  }
}
