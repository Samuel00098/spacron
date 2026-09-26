import { invoke } from '@tauri-apps/api/core';
import { get } from '$lib/stores/storeCompat';
import { jevAgentTool, jevProvider } from '$lib/stores/settings';

/**
 * Keeps the MCP server's `jev_classify` tool in step with Settings > AI
 * Connections > Jev decisions: the "Let agents use Jev" switch and the Jev
 * source it bills. The server boots with the tool off; subscribing fires
 * immediately, so this is also the startup push.
 */
let initialized = false;

function publish(): void {
  invoke('mcp_set_jev_tool', { enabled: get(jevAgentTool) === true, provider: get(jevProvider) || 'typesafe' }).catch((e) => {
    console.error('[jev] Failed to publish the agent tool setting to the MCP server:', e);
  });
}

export function initJevAgentTool(): void {
  if (initialized) return;
  initialized = true;
  jevAgentTool.subscribe(publish);
  jevProvider.subscribe(publish);
}

export interface JevAgentUsage {
  calls: number;
  items: number;
  inputTokens: number;
  reportedCostUsd: number;
}

export async function jevAgentUsage(): Promise<JevAgentUsage | null> {
  try {
    return await invoke<JevAgentUsage>('jev_agent_usage');
  } catch {
    return null;
  }
}
