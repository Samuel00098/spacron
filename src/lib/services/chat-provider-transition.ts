export type ChatProviderTransition =
  | 'reuse'
  | 'switch_model_in_session'
  | 'restart_and_resume'
  | 'create_with_handoff';

export interface ChatProviderState {
  agent: string;
  model: string | null;
  workspace: string | null;
}

/**
 * ACP/terminal CLIs do not expose one uniform native model-switch contract.
 * Reuse is therefore safe only when the agent, model, and workspace are
 * unchanged; every other compatible switch starts a fresh session with a
 * durable handoff.
 */
export function decideChatProviderTransition(
  current: ChatProviderState | null,
  target: ChatProviderState,
): ChatProviderTransition {
  if (!current) return 'create_with_handoff';
  if (current.agent !== target.agent) return 'create_with_handoff';
  if (current.workspace !== target.workspace) return 'restart_and_resume';
  if (current.model !== target.model) return 'create_with_handoff';
  return 'reuse';
}
