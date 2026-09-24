import { useStore } from '$lib/react/useStore';
import { agentUpdates, installAgentUpdate, updateFor } from '$lib/stores/agentUpdates';
import './AgentUpdateButton.css';

/**
 * The icon-only update control that sits on an agent's tile or row. Renders
 * nothing unless Spacron can update this agent and a newer version exists;
 * while the update runs it turns into a spinner and the caller greys the agent
 * out (see `useAgentUpdating`).
 */
export default function AgentUpdateButton({ command, name }: { command: string; name: string }) {
  const state = useStore(agentUpdates);
  const updating = state.updating.includes(command);
  const info = updateFor(state, command);
  if (!info && !updating) return null;

  const label = updating
    ? `Updating ${name}…`
    : `Update ${name} from ${info!.installed} to ${info!.latest}`;

  return (
    <button
      type="button"
      className={`agent-update-btn${updating ? ' busy' : ''}`}
      onClick={(e) => {
        e.stopPropagation();
        if (!updating) void installAgentUpdate(command);
      }}
      onKeyDown={(e) => e.stopPropagation()}
      disabled={updating}
      aria-label={label}
      title={label}
    >
      {updating ? (
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" aria-hidden="true">
          <path d="M21 12a9 9 0 1 1-6.2-8.56" />
        </svg>
      ) : (
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <path d="M12 4v11" />
          <polyline points="7 10.5 12 15.5 17 10.5" />
          <path d="M5 20h14" />
        </svg>
      )}
    </button>
  );
}

/** Whether `command` is mid-update, for greying out its tile or row. */
export function useAgentUpdating(command: string): boolean {
  return useStore(agentUpdates).updating.includes(command);
}
