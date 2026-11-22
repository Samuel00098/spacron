import { closeSettings } from '$lib/stores/layout';
import { requestRoomControl } from '$lib/stores/layoutControl';
import { allProjectSessions, setActiveSession } from '$lib/stores/terminal';
import { setTerminalChatView } from '$lib/services/terminal-chat';
import { recordForPane } from '$lib/services/structured-chat/session-store';
import { switchToProject, activeProjectId } from '$lib/stores/workspace';
import { get } from '$lib/stores/storeCompat';

/** Bring a notification's conversation above covering app dialogs. */
export async function revealAgentChat(paneId: number): Promise<void> {
  setTerminalChatView(paneId, true);
  await revealAgentView(paneId);
}

/** Reveal the agent's current Chat or Terminal view without changing modes. */
export async function revealAgentView(paneId: number): Promise<void> {
  window.dispatchEvent(new Event('spacron:reveal-agent-chat'));
  closeSettings();
  const projectId = recordForPane(paneId)?.projectId
    ?? get(allProjectSessions).find((session) => session.id === paneId)?.projectId;
  if (projectId && get(activeProjectId) !== projectId) await switchToProject(projectId);
  setActiveSession(paneId);
  // Let dialog cleanup restore its old focus before revealing the agent room.
  requestAnimationFrame(() => requestRoomControl('focus', `agent:${paneId}`));
}
