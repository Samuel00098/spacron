import { useEffect, useMemo, useState } from 'react';
import { useStore } from '$lib/react/useStore';
import { chatThreadState, createChatThread, getStandaloneChats } from '$lib/stores/chatThreads';
import { selectedStandaloneChatId, showStandaloneChat } from '$lib/stores/chatNavigation';
import { openStandaloneWorkspace, prepareStandaloneChat } from '$lib/services/standalone-chat';
import type { Project } from '$lib/types/workspace';
import { ProjectChatModePanel } from './ChatModePanel';
import './StandaloneChats.css';

/** Only supplies conversation scope. The entire composer/transcript is shared. */
export default function StandaloneChatPanel() {
  const state = useStore(chatThreadState);
  const selectedId = useStore(selectedStandaloneChatId);
  const thread = getStandaloneChats(state).find((entry) => entry.id === selectedId) ?? null;
  const draftWorkspaceId = useMemo(() => `chat-draft-${crypto.randomUUID()}`, [thread?.id]);
  const workspaceId = thread?.standaloneWorkspaceId || thread?.id || draftWorkspaceId;
  const [ready, setReady] = useState<{ key: string; project: Project } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [retry, setRetry] = useState(0);
  useEffect(() => {
    let cancelled = false;
    setError(null);
    const request = thread ? prepareStandaloneChat(thread.id) : openStandaloneWorkspace(workspaceId);
    void request.then((project) => { if (!cancelled) setReady({ key: workspaceId, project }); })
      .catch((err) => { if (!cancelled) setError(String(err)); });
    return () => { cancelled = true; };
  }, [workspaceId, retry]);
  if (!ready || ready.key !== workspaceId || error) return <section className="chat-mode-panel empty" aria-label="Chat">
    <div className="chat-mode-empty"><h2 className="chat-mode-empty-heading">What are we working on?</h2>
      {error ? <><p role="alert">{error}</p><button type="button" onClick={() => setRetry((value) => value + 1)}>Retry</button></> : <p>Opening chat…</p>}
    </div>
  </section>;
  return <ProjectChatModePanel key={ready.project.id} chatProject={ready.project} standalone
    onCreateStandaloneThread={(overrides) => {
      const next = createChatThread(ready.project.id, { ...overrides, standalone: true, standaloneWorkspaceId: workspaceId });
      showStandaloneChat(next.id);
      return next;
    }} />;
}
