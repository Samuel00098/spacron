import { runEmbeddedCommand } from '$lib/stores/embeddedRun';
import { getAgentDisplayName } from '$lib/stores/terminal';
import {
  getLiveAgentModelCommand,
  parseLiveAgentModels,
  type AgentProviderModel,
} from './agent-provider-catalogue';

/** Ask the selected CLI for its current account/configured model list. */
export async function loadLiveAgentProviderModels(command: string): Promise<AgentProviderModel[]> {
  const liveCommand = getLiveAgentModelCommand(command);
  if (!liveCommand) return [];
  const result = await runEmbeddedCommand({
    key: `chat-models:${command}`,
    command: liveCommand,
    label: `${getAgentDisplayName(command) ?? command} models`,
    background: true,
    notify: false,
    timeoutMs: 15_000,
  });
  if (result.exitCode !== 0) return [];
  return parseLiveAgentModels(command, result.output);
}
