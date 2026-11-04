import { invoke } from '@tauri-apps/api/core';
import { isTauriRuntime } from '$lib/utils/tauri';

export interface AgentBinaryStatus {
  id: string;
  installed: boolean;
  managed: boolean;
  version: string;
  path: string | null;
  supported: boolean;
}

/** Check whether a managed binary for `agent_id`/`version` is installed. */
export async function agentBinaryStatus(
  agentId: string,
  version: string,
): Promise<AgentBinaryStatus | null> {
  if (!isTauriRuntime()) return null;
  return invoke<AgentBinaryStatus>('agent_binary_status', { agent_id: agentId, version })
    .catch(() => null);
}

/** Download, verify (sha256) and install one agent's binary distribution. */
export async function agentBinaryInstall(
  agentId: string,
  version: string,
  url: string,
  sha256: string,
  cmd: string,
): Promise<AgentBinaryStatus> {
  if (!isTauriRuntime()) {
    throw new Error('Installing agent binaries needs the desktop app.');
  }
  return invoke<AgentBinaryStatus>('agent_binary_install', {
    agent_id: agentId,
    version,
    url,
    sha256,
    cmd,
  });
}
