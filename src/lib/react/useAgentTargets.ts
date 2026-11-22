import { useMemo } from 'react';
import { useStore } from './useStore';
import { sessions, devSessions, activeSessionId, devActiveSessionId, manualPromptTargetId } from '$lib/stores/terminal';
import { structuredChatPanes } from '$lib/services/structured-chat/panes';
import { getActiveAgentTargets } from '$lib/services/agent-target';

/** Keep visual-context destinations current while an inspector is open. */
export function useAgentTargets() {
  const normal = useStore(sessions);
  const dev = useStore(devSessions);
  const active = useStore(activeSessionId);
  const devActive = useStore(devActiveSessionId);
  const manual = useStore(manualPromptTargetId);
  const panes = useStore(structuredChatPanes);
  return useMemo(() => getActiveAgentTargets(), [normal, dev, active, devActive, manual, panes]);
}
