import { useEffect } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { showToast } from '$lib/stores/notification';
import TerminalChatView from '$lib/components/terminal/TerminalChatView';
import { useStore } from '$lib/react/useStore';
import { closeStandaloneChat, selectedStandaloneChatId, showStandaloneStructuredChat } from '$lib/stores/chatNavigation';
import { commandForStructuredAgent } from '$lib/services/structured-chat/panes';
import {
  findPaneForRecord,
  listStandaloneStructuredRecords,
  structuredSessions,
  updateStandaloneStructuredRecord,
  useStructuredSessionRecord,
} from '$lib/services/structured-chat/session-store';
import {
  beginProjectFromStructuredChat,
  createDraftStandaloneStructuredChat,
  ensureStandaloneRecordStarted,
  hydrateStandaloneVirtualPane,
  migrateLegacyStandaloneChats,
  sendStandaloneStructuredMessage,
  switchStandaloneStructuredAgent,
  virtualPaneForStandaloneRecord,
} from '$lib/services/structured-chat/standalone-structured';
import './StandaloneChats.css';

/**
 * Outside-of-project multi-agent structured chat. Uses the shared `TerminalChatView`
 * and unified Agent -> Model -> Reasoning picker backed by an isolated scratch
 * workspace (`chat_workspace_open`) with lazy process startup on first send.
 */
export default function StandaloneChatPanel() {
  const allSessions = useStore(structuredSessions);
  const selectedId = useStore(selectedStandaloneChatId);

  useEffect(() => {
    migrateLegacyStandaloneChats();
  }, []);

  const standaloneRecords = listStandaloneStructuredRecords(allSessions);
  const record = (selectedId ? standaloneRecords.find((entry) => entry.id === selectedId) : null)
    ?? standaloneRecords[0]
    ?? null;

  useEffect(() => {
    if (record) {
      if (selectedId !== record.id) selectedStandaloneChatId.set(record.id);
      return;
    }
    const draft = createDraftStandaloneStructuredChat();
    showStandaloneStructuredChat(draft.id);
  }, [record?.id, selectedId]);

  const activeId = record?.id ?? null;
  const virtualPaneId = activeId ? virtualPaneForStandaloneRecord(activeId) : null;
  const liveRecord = useStructuredSessionRecord(virtualPaneId ?? 0);
  useEffect(() => {
    // The folder is made on the first message, so an unused chat leaves none.
    if (activeId) void hydrateStandaloneVirtualPane(activeId);
  }, [activeId]);

  if (!record || virtualPaneId === null) {
    return (
      <section className="chat-mode-panel empty" aria-label="Chat">
        <div className="chat-mode-empty">
          <h2 className="chat-mode-empty-heading">What are we working on?</h2>
          <p>Opening chat…</p>
        </div>
      </section>
    );
  }

  const boundPane = findPaneForRecord(record.id);
  const isLive = boundPane !== null
    && (liveRecord?.lifecycle === 'ready' || liveRecord?.lifecycle === 'working' || liveRecord?.lifecycle === 'starting');

  return (
    <section className="chat-mode-panel standalone-structured-panel" aria-label="Chat">
      <TerminalChatView
        key={record.id}
        sessionId={virtualPaneId}
        agentPreset={record.preset ?? commandForStructuredAgent(record.provider)}
        cwd={record.cwd !== '.' ? record.cwd : null}
        onRevealFolder={() => {
          const workspaceId = record.standaloneWorkspaceId;
          if (workspaceId) void invoke('chat_workspace_reveal', { workspaceId }).catch((error) => showToast(String(error), 'error'));
        }}
        isRunning={isLive}
        structuredAgent={record.provider}
        standalone
        lazyStart={!isLive}
        pendingModel={record.model}
        pendingEffort={record.effort}
        pendingAccess={record.access ?? 'ask'}
        onPickAccess={(access) => updateStandaloneStructuredRecord(record.id, { access })}
        onSwitchAgent={(agent, model, effort) => switchStandaloneStructuredAgent(record.id, agent, { model, effort })}
        onLazySend={(text, images) => sendStandaloneStructuredMessage(record.id, text, images)}
        onEnsureStarted={() => ensureStandaloneRecordStarted(record.id)}
        onCreateProjectFromChat={() => beginProjectFromStructuredChat(record.id)}
        onCloseStandalone={closeStandaloneChat}
      />
    </section>
  );
}
