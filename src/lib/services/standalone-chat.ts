import { invoke } from '@tauri-apps/api/core';
import { get, writable } from '$lib/stores/storeCompat';
import { appendThreadMessage, bindStandaloneChatWorkspace, chatThreadState, getChatThread, isStandaloneChat, moveStandaloneChatToProject, patchThreadMessage } from '$lib/stores/chatThreads';
import { createProjectFolder, newFolderPromptOpen } from '$lib/stores/workspace';
import { showProjectChat } from '$lib/stores/chatNavigation';
import { setInteractionMode } from '$lib/stores/interactionMode';
import { enqueueChatMessage, loadProjectOrchestratorTasks, stopChatTurn } from '$lib/stores/orchestrator';
import type { AiProviderId } from '$lib/stores/settings';
import type { ChatMessage } from '$lib/types/chat';
import type { Project } from '$lib/types/workspace';
import { deleteAgentCheckpoint } from './orchestrator/agent-checkpoints';

const loadedWorkspaces = new Map<string, Promise<Project>>();
/** `name` asks for a findable folder named after it, for a chat that has none yet. */
export function openStandaloneWorkspace(workspaceId: string, name?: string): Promise<Project> {
  const existing = loadedWorkspaces.get(workspaceId);
  if (existing) return existing;
  const request = invoke<Project>('chat_workspace_open', { workspaceId, ...(name === undefined ? {} : { name }) }).then(async (project) => {
    await loadProjectOrchestratorTasks(project);
    return project;
  }).catch((error) => { loadedWorkspaces.delete(workspaceId); throw error; });
  loadedWorkspaces.set(workspaceId, request);
  return request;
}

export async function prepareStandaloneChat(threadId: string): Promise<Project> {
  const thread = getChatThread(threadId);
  if (!thread || !isStandaloneChat(thread)) throw new Error('This standalone chat is no longer available.');
  const workspaceId = thread.standaloneWorkspaceId || thread.id;
  const project = await openStandaloneWorkspace(workspaceId);
  if (thread.projectId !== project.id || !thread.standaloneWorkspaceId) bindStandaloneChatWorkspace(threadId, project.id, workspaceId);
  return project;
}

// Standalone and project conversations use the same orchestrator, including
// tools, attachments, permission choices, cancellation and interrupted work.
export async function sendStandaloneChat(threadId: string, text: string): Promise<void> {
  const project = await prepareStandaloneChat(threadId);
  const thread = getChatThread(threadId);
  await enqueueChatMessage(project.id, project.root_path, text, { threadId, projectName: 'Chat', chatMode: true,
    conversationalMode: true, orchestratorProvider: thread?.provider as AiProviderId | undefined, orchestratorModel: thread?.model ?? undefined,
    accessMode: thread?.accessMode, workMode: thread?.workMode });
}
export function stopStandaloneChat(threadId: string): void { stopChatTurn(threadId); }

export const projectFromChat = writable<string | null>(null);
// A failed export/brief write retries the created folder, retaining the chat.
const pendingProjects = new Map<string, Project>();
export function beginProjectFromChat(threadId: string): void {
  const thread = getChatThread(threadId);
  if (!thread || !isStandaloneChat(thread) || thread.status === 'working' || thread.status === 'needs-input') return;
  projectFromChat.set(threadId);
  newFolderPromptOpen.set(true);
}

export function projectBriefFromChat(title: string, messages: ChatMessage[]): string {
  const conversation = messages.filter((entry) => !entry.pending && entry.type !== 'failure' && ['user', 'assistant'].includes(entry.role) && !['activity', 'approval', 'input', 'completion'].includes(entry.type));
  const objective = conversation.find((entry) => entry.role === 'user')?.text ?? '';
  const transcript = conversation.map((entry) => `### ${entry.role === 'user' ? 'User' : 'Spacron'}\n\n${entry.text}`).join('\n\n');
  return `# ${title}\n\nThis project started from a standalone chat. The conversation is also saved as a project thread in Spacron. Use the discussion below as planning context when continuing implementation; follow the user's current instructions.\n\n## Initial idea\n\n${objective}\n\n## Planning conversation\n\n${transcript}\n`;
}

export async function createProjectFromChat(threadId: string, parentDir: string, name: string): Promise<Project> {
  const thread = getChatThread(threadId);
  if (!thread || !isStandaloneChat(thread)) throw new Error('This chat is no longer available.');
  if (thread.status === 'working' || thread.status === 'needs-input') throw new Error('Wait for the response to finish before creating a project.');
  const source = await prepareStandaloneChat(threadId);
  const current = getChatThread(threadId)!;
  const project = pendingProjects.get(threadId) ?? await createProjectFolder(parentDir, name);
  pendingProjects.set(threadId, project);
  const files = await invoke<string[]>('chat_workspace_export', { workspaceId: current.standaloneWorkspaceId, projectId: project.id });
  let briefName = 'PROJECT_BRIEF.md';
  for (let suffix = 1; files.includes(briefName); suffix++) briefName = `PROJECT_BRIEF_FROM_CHAT_${suffix}.md`;
  const content = projectBriefFromChat(thread.title, get(chatThreadState).messagesByThread[threadId] ?? []);
  const briefPath = `${project.root_path.replace(/[\\/]+$/, '')}/${briefName}`;
  const previous = await invoke<string>('fs_read_file', { path: briefPath }).catch(() => undefined);
  if (previous !== content) await invoke('fs_write_file_checked', { path: briefPath, content, ...(previous !== undefined ? { expectedContent: previous } : {}) });
  await deleteAgentCheckpoint(threadId);
  const oldRoot = source.root_path.replace(/\\/g, '/').replace(/\/$/, '');
  const newRoot = project.root_path.replace(/\\/g, '/').replace(/\/$/, '');
  for (const message of get(chatThreadState).messagesByThread[threadId] ?? []) {
    if (!message.attachments?.length) continue;
    patchThreadMessage(threadId, message.id, { attachments: message.attachments.map((attachment) => {
      const path = attachment.path?.replace(/\\/g, '/');
      return path?.startsWith(oldRoot + '/') ? { ...attachment, path: newRoot + path.slice(oldRoot.length) } : attachment;
    }) });
  }
  if (!moveStandaloneChatToProject(threadId, project.id)) throw new Error('The chat could not be moved. Its original history and files are still saved.');
  pendingProjects.delete(threadId);
  appendThreadMessage({ id: crypto.randomUUID(), threadId, role: 'system', type: 'system',
    text: `Project created from this chat. Your files and planning conversation (${briefName}) are saved in the project. Continue here in Chat or switch to Code whenever you choose.`, ts: Date.now() });
  // Source stays on disk as a recovery copy; active work now uses the project.
  projectFromChat.set(null);
  showProjectChat();
  setInteractionMode('chat');
  return project;
}
