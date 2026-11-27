/**
 * Standalone (outside-of-project) structured chat runtime.
 *
 * Uses negative virtual pane IDs backed by scratch workspaces created via
 * `chat_workspace_open` (`standalone-chat.ts`), so users can converse with any
 * structured agent, use `/` commands, `@` file mentions, and `/sidebar` side
 * chats without opening a project or spawning a PTY — and later promote any
 * standalone chat into a full Spacron project.
 */
import { invoke } from '@tauri-apps/api/core';
import { get } from '$lib/stores/storeCompat';
import { chatThreadState, getStandaloneChats } from '$lib/stores/chatThreads';
import { createProjectFolder, newFolderPromptOpen } from '$lib/stores/workspace';
import { showProjectChat } from '$lib/stores/chatNavigation';
import { setInteractionMode } from '$lib/stores/interactionMode';
import { openStandaloneWorkspace, projectFromChat } from '$lib/services/standalone-chat';
import type { TerminalChatItem } from '$lib/services/terminal-chat';
import type { Project } from '$lib/types/workspace';
import { pickDefaultStructuredAgent } from './agent-catalog';
import type { StructuredChatAgent } from './panes';
import { sendStructuredChat, structuredChatProvider } from './registry';
import {
  allocateVirtualStructuredPaneId,
  attachStandaloneRecordToPane,
  createStandaloneStructuredRecord,
  deleteStandaloneStructuredRecord,
  findPaneForRecord,
  flushSessionStore,
  migrateLegacyStandaloneRecords,
  recordItemsSnapshot,
  restoreStructuredSessions,
  retargetStandaloneRecord,
  structuredSessions,
  switchStructuredAgent,
  updateStandaloneStructuredRecord,
  type StructuredSessionRecord,
} from './session-store';

const recordVirtualPanes = new Map<string, number>();

/** Stable negative virtual pane id for a standalone structured record. */
export function virtualPaneForStandaloneRecord(recordId: string): number {
  const bound = findPaneForRecord(recordId);
  if (bound !== null) {
    recordVirtualPanes.set(recordId, bound);
    return bound;
  }
  let virtualId = recordVirtualPanes.get(recordId);
  if (virtualId === undefined) {
    virtualId = allocateVirtualStructuredPaneId();
    recordVirtualPanes.set(recordId, virtualId);
  }
  return virtualId;
}

/** Reset virtual pane bindings (for tests). */
export function __resetStandaloneStructuredForTests(): void {
  recordVirtualPanes.clear();
}

/** Run one-time migration of legacy standalone threads into structured records. */
export function migrateLegacyStandaloneChats(): number {
  const state = get(chatThreadState);
  const threads = getStandaloneChats(state);
  return migrateLegacyStandaloneRecords(threads, state.messagesByThread, pickDefaultStructuredAgent());
}

/** Lazily open/ensure the scratch workspace directory for a standalone chat (zero CLI spawn). */
export async function ensureStandaloneWorkspaceCwd(recordId: string, firstMessage?: string): Promise<string> {
  const record = get(structuredSessions)[recordId];
  if (!record) throw new Error('This standalone chat is no longer available.');
  if (record.cwd && record.cwd !== '.' && record.standaloneWorkspaceId) {
    return record.cwd;
  }
  const workspaceId = record.standaloneWorkspaceId || record.id;
  // The folder is named after what the chat is about.
  const about = record.title?.trim() || firstMessage?.trim().split(/\r?\n/)[0] || 'Chat';
  const project = await openStandaloneWorkspace(workspaceId, about);
  updateStandaloneStructuredRecord(recordId, {
    cwd: project.root_path,
    standaloneWorkspaceId: workspaceId,
  });
  return project.root_path;
}

/** Hydrate journal items onto a virtual pane without starting its CLI yet. */
export async function hydrateStandaloneVirtualPane(recordId: string): Promise<number> {
  const paneId = virtualPaneForStandaloneRecord(recordId);
  await attachStandaloneRecordToPane(paneId, recordId, { startProvider: false });
  return paneId;
}

/** Ensure the scratch workspace + structured provider process are running for a standalone chat. */
export async function ensureStandaloneRecordStarted(recordId: string, firstMessage?: string): Promise<number> {
  await ensureStandaloneWorkspaceCwd(recordId, firstMessage);
  const paneId = virtualPaneForStandaloneRecord(recordId);
  const ok = await attachStandaloneRecordToPane(paneId, recordId, { startProvider: true });
  if (!ok) {
    const record = get(structuredSessions)[recordId];
    const provider = record ? structuredChatProvider(record.provider) : null;
    const error = provider?.get(paneId)?.error;
    throw new Error(error || 'Failed to start agent for this chat.');
  }
  return paneId;
}

/** Start the selected agent on first send and deliver the prompt. */
export async function sendStandaloneStructuredMessage(
  recordId: string,
  text: string,
  images: string[] = [],
): Promise<void> {
  const record = get(structuredSessions)[recordId];
  if (!record) throw new Error('This standalone chat is no longer available.');
  const paneId = await ensureStandaloneRecordStarted(recordId, text);
  const updated = get(structuredSessions)[recordId] ?? record;
  await sendStructuredChat(updated.provider, paneId, text, images);
}

/** Switch agent/model/reasoning on a standalone chat (updates draft if lazy, swaps provider if live). */
export async function switchStandaloneStructuredAgent(
  recordId: string,
  targetAgent: StructuredChatAgent,
  options: { model?: string | null; effort?: string | null } = {},
): Promise<void> {
  const record = get(structuredSessions)[recordId];
  if (!record) return;
  const paneId = findPaneForRecord(recordId);
  const currentProvider = structuredChatProvider(record.provider);
  const live = paneId !== null ? currentProvider?.get(paneId) : null;
  const running = live?.status === 'ready' || live?.status === 'working';
  // A bound pane changing agent goes through the full switch even when its agent
  // failed, or the store would keep listening to the old one.
  if (paneId !== null && (running || targetAgent !== record.provider)) {
    await switchStructuredAgent(paneId, targetAgent, options);
    return;
  }
  retargetStandaloneRecord(recordId, targetAgent, options);
}

/** Delete a standalone structured record and forget its virtual pane mapping. */
export async function removeStandaloneStructuredChat(recordId: string): Promise<boolean> {
  recordVirtualPanes.delete(recordId);
  return deleteStandaloneStructuredRecord(recordId);
}

/** Synthesize a Markdown planning brief from normalized structured chat items. */
export function briefFromStructuredItems(title: string, items: readonly TerminalChatItem[]): string {
  const turns = items.filter(
    (item) => (item.kind === 'user' || item.kind === 'assistant') && item.text.trim().length > 0,
  );
  const objective = turns.find((item) => item.kind === 'user')?.text ?? '';
  const transcript = turns
    .map((item) => `### ${item.kind === 'user' ? 'User' : 'Assistant'}\n\n${item.text}`)
    .join('\n\n');
  return `# ${title}\n\nThis project started from a standalone multi-agent chat in Spacron. Use the discussion below as planning context when continuing implementation; follow the user's current instructions.\n\n## Initial idea\n\n${objective}\n\n## Conversation\n\n${transcript}\n`;
}

export function createDraftStandaloneStructuredChat(opts?: {
  provider?: StructuredChatAgent;
  model?: string | null;
  effort?: string | null;
}): StructuredSessionRecord {
  return createStandaloneStructuredRecord({
    provider: opts?.provider ?? pickDefaultStructuredAgent(),
    model: opts?.model ?? null,
    effort: opts?.effort ?? null,
  });
}

const pendingProjects = new Map<string, Project>();

/** Promote a standalone structured chat into a full Spacron project folder. */
export async function promoteStandaloneStructuredChatToProject(
  recordId: string,
  parentDir: string,
  name: string,
): Promise<Project> {
  const record = get(structuredSessions)[recordId];
  if (!record || !record.standalone) throw new Error('This chat is no longer available.');
  const paneId = findPaneForRecord(recordId);
  const activeProvider = structuredChatProvider(record.provider);
  const liveState = paneId !== null ? activeProvider?.get(paneId) : null;
  if (liveState?.status === 'working') {
    throw new Error('Wait for the response to finish before creating a project.');
  }

  await ensureStandaloneWorkspaceCwd(recordId);
  const current = get(structuredSessions)[recordId]!;
  const workspaceId = current.standaloneWorkspaceId || current.id;

  const project = pendingProjects.get(recordId) ?? await createProjectFolder(parentDir, name);
  pendingProjects.set(recordId, project);

  const files = await invoke<string[]>('chat_workspace_export', { workspaceId, projectId: project.id });
  let briefName = 'PROJECT_BRIEF.md';
  for (let suffix = 1; files.includes(briefName); suffix += 1) {
    briefName = `PROJECT_BRIEF_FROM_CHAT_${suffix}.md`;
  }
  const items = liveState?.items?.length ? liveState.items : recordItemsSnapshot(recordId);
  const title = current.title ?? name;
  const content = briefFromStructuredItems(title, items);
  const briefPath = `${project.root_path.replace(/[\\/]+$/, '')}/${briefName}`;
  const previous = await invoke<string>('fs_read_file', { path: briefPath }).catch(() => undefined);
  if (previous !== content) {
    await invoke('fs_write_file_checked', {
      path: briefPath,
      content,
      ...(previous !== undefined ? { expectedContent: previous } : {}),
    });
  }

  if (paneId !== null && activeProvider) {
    await activeProvider.close(paneId).catch(() => {});
  }
  recordVirtualPanes.delete(recordId);

  updateStandaloneStructuredRecord(recordId, {
    standalone: false,
    projectId: project.id,
    cwd: project.root_path,
    nativeSessionId: null,
    forkSourceId: null,
    seedContext: items.some((item) => item.kind === 'user'),
    lifecycle: 'detached',
  });
  flushSessionStore();
  pendingProjects.delete(recordId);
  projectFromChat.set(null);
  showProjectChat();
  setInteractionMode('cli');
  void restoreStructuredSessions(project.id);
  return project;
}

export function beginProjectFromStructuredChat(recordId: string): void {
  const record = get(structuredSessions)[recordId];
  if (!record || !record.standalone || record.lifecycle === 'working') return;
  projectFromChat.set(recordId);
  newFolderPromptOpen.set(true);
}
