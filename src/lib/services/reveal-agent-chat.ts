import { closeSettings } from '$lib/stores/layout';
import { closeBots } from '$lib/services/bots/bots';
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

/**
 * Reveal the agent's current Chat or Terminal view without changing modes.
 *
 * Takes the user straight to the agent from wherever they are: it closes what
 * covers the workspace (Settings, the Bots page), switches to the agent's
 * project when it is a different one, and focuses the agent's own room. Pass
 * `ownerProjectId` when the caller already knows it, as a launch does, since a
 * session that was only just created may not be in the lookups yet.
 */
export async function revealAgentView(
  paneId: number,
  ownerProjectId?: string | null,
  opts: { keepDialogs?: boolean } = {},
): Promise<void> {
  // A launch from inside a dialog (New worktree with "create more") must not close
  // that dialog; a notification click should, so the conversation is in view.
  if (!opts.keepDialogs) window.dispatchEvent(new Event('spacron:reveal-agent-chat'));
  closeSettings();
  closeBots();
  const projectId = ownerProjectId
    ?? recordForPane(paneId)?.projectId
    ?? get(allProjectSessions).find((session) => session.id === paneId)?.projectId;
  if (projectId && get(activeProjectId) !== projectId) await switchToProject(projectId);
  setActiveSession(paneId);
  // Let dialog cleanup restore its old focus before revealing the agent room.
  requestAnimationFrame(() => requestRoomControl('focus', `agent:${paneId}`));
  // A room for an agent launched a moment ago may not exist on the first frame;
  // asking again once the shell has built it is harmless when it already did.
  setTimeout(() => requestRoomControl('focus', `agent:${paneId}`), 350);
}
