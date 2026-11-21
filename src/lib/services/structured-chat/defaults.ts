import { get } from '$lib/stores/storeCompat';
import {
  agentCmdOverrides,
  agentDefaultArgs,
  agentDefaultEnv,
  agentPermissionMode,
  chatDefaultAccessMode,
} from '$lib/stores/settings';
import { effectiveAgentMode } from '$lib/services/agent-permissions';
import type { StructuredAccess } from './provider';

/**
 * Structured chats use the chatDefaultAccessMode setting when explicitly set,
 * or inherit the permission default from the agent's launch configuration.
 * A custom launch override is intentionally conservative: without knowing
 * what that override means to the provider protocol, ask rather than silently
 * granting broader access.
 */
export function structuredAccessFor(command: string): StructuredAccess {
  const chatDefault = get(chatDefaultAccessMode);
  if (chatDefault && chatDefault !== 'inherit') {
    if (chatDefault === 'full-access') return 'full-access';
    if (chatDefault === 'auto' || chatDefault === 'auto-edits') return 'auto';
    if (chatDefault === 'supervised') return 'ask';
  }

  // Structured provider names are not always the launch command used by the
  // agent settings table (for example, `cursor` starts `cursor-agent`).
  const settingCommand = command === 'antigravity' ? 'agy' : command === 'cursor' ? 'cursor-agent' : command;
  const mode = effectiveAgentMode(settingCommand, get(agentPermissionMode), {
    agentCmdOverrides: get(agentCmdOverrides),
    agentDefaultArgs: get(agentDefaultArgs),
    agentDefaultEnv: get(agentDefaultEnv),
  });
  return mode === 'yolo' ? 'full-access' : 'ask';
}

