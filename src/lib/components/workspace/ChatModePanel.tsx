import { useEffect, useMemo, useRef, useState } from 'react';
import { activeProject } from '$lib/stores/workspace';
import { useStore } from '$lib/react/useStore';
import {
  agentForcedAgent,
  clearProjectChat,
  getDispatchableAgents,
  sendChatMessage,
} from '$lib/stores/orchestrator';
import { getAgentDisplayName } from '$lib/stores/terminal';
import {
  chatThreadState,
  createChatThread,
  ensureProjectThread,
  setThreadDraft,
  type ChatMessage,
  type ChatThread,
} from '$lib/stores/chatThreads';
import './ChatModePanel.css';

function formatTime(timestamp: number): string {
  return new Date(timestamp).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
}

function messageLabel(message: ChatMessage): string {
  if (message.role === 'user') return 'You';
  if (message.dispatched?.length) {
    const names = message.dispatched.map((entry) => entry.name || getAgentDisplayName(entry.agent) || entry.agent);
    return names.join(', ');
  }
  return 'Spacron';
}

function statusLabel(status: string): string {
  switch (status) {
    case 'in-progress': return 'Working';
    case 'complete': return 'Complete';
    case 'blocked': return 'Needs input';
    case 'failed': return 'Failed';
    case 'cancelled': return 'Cancelled';
    default: return 'Queued';
  }
}

function threadStatusLabel(status: ChatThread['status'] | undefined): string {
  switch (status) {
    case 'working': return 'Working';
    case 'needs-input': return 'Needs input';
    case 'complete': return 'Complete';
    case 'failed': return 'Failed';
    case 'draft': return 'Draft';
    case 'archived': return 'Archived';
    default: return 'Ready';
  }
}

function MessageBody({ text, pending }: { text: string; pending?: boolean }) {
  if (pending && !text.trim()) {
    return <span className="chat-mode-pending"><i /> <i /> <i /></span>;
  }
  return (
    <div className="chat-mode-message-text">
      {text.split('\n').map((line, index) => (
        <span key={`${index}-${line}`}>
          {line || '\u00a0'}
          {index < text.split('\n').length - 1 && <br />}
        </span>
      ))}
    </div>
  );
}

function InlineCard({ message }: { message: ChatMessage }) {
  if (message.type === 'plan' || message.type === 'activity' || message.type === 'orchestrator') {
    return (
      <div className={`chat-mode-inline-card ${message.type}`}>
        <span>{message.type === 'plan' ? 'Plan' : 'Activity'}</span>
        <MessageBody text={message.text} />
      </div>
    );
  }
  if ((message.type === 'approval' || message.type === 'input') && message.inlineRequest) {
    return (
      <div className={`chat-mode-inline-card request ${message.type}`}>
        <strong>{message.type === 'approval' ? 'Approval needed' : 'Input needed'}</strong>
        <MessageBody text={message.inlineRequest.prompt} />
        {message.inlineRequest.options?.length ? (
          <div className="chat-mode-inline-options">
            {message.inlineRequest.options.map((option) => <button key={option.id} type="button" disabled>{option.label}</button>)}
          </div>
        ) : null}
      </div>
    );
  }
  return null;
}

export default function ChatModePanel() {
  const project = useStore(activeProject);
  const threadState = useStore(chatThreadState);
  const forcedAgent = useStore(agentForcedAgent);
  const [draft, setDraft] = useState('');
  const [pendingSendCount, setPendingSendCount] = useState(0);
  const scrollRef = useRef<HTMLDivElement | null>(null);

  const threads = useMemo(
    () => (project ? threadState.threadsByProject[project.id] ?? [] : []),
    [project, threadState.threadsByProject],
  );
  const activeThread = useMemo(() => {
    if (!project) return null;
    const activeId = threadState.activeThreadByProject[project.id];
    return threads.find((thread) => thread.id === activeId) ?? threads[0] ?? null;
  }, [project, threadState.activeThreadByProject, threads]);
  const messages = useMemo(
    () => (activeThread ? threadState.messagesByThread[activeThread.id] ?? [] : []),
    [activeThread, threadState.messagesByThread],
  );
  const agents = useMemo(
    () => (project ? getDispatchableAgents(project.id) : []),
    [project],
  );

  useEffect(() => {
    if (project) ensureProjectThread(project.id);
  }, [project?.id]);

  useEffect(() => {
    if (!activeThread) return;
    setDraft(activeThread.draft);
  }, [activeThread?.id]);

  useEffect(() => {
    const element = scrollRef.current;
    if (element) element.scrollTop = element.scrollHeight;
  }, [messages.length]);

  useEffect(() => {
    setDraft(activeThread?.draft ?? '');
  }, [project?.id]);

  async function submit() {
    const text = draft.trim();
    if (!project || !activeThread || !text) return;
    setDraft('');
    setThreadDraft(activeThread.id, '');
    setPendingSendCount((count) => count + 1);
    try {
      await sendChatMessage(project.id, project.root_path, text, {
        forcedAgent,
        projectName: project.name,
        threadId: activeThread.id,
      });
    } finally {
      setPendingSendCount((count) => Math.max(0, count - 1));
    }
  }

  function onComposerKeyDown(event: React.KeyboardEvent<HTMLTextAreaElement>) {
    if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) {
      event.preventDefault();
      void submit();
    }
  }

  return (
    <section
      className="chat-mode-panel"
      aria-label="Chat room"
    >
      <div className="chat-mode-room-header">
        <div className="chat-mode-room-title">
          <span className="chat-mode-room-icon" aria-hidden="true">✦</span>
          <span className="chat-mode-room-kind">chat</span>
          <strong>Chat</strong>
        </div>
        <div className="chat-mode-room-actions">
          <span className="chat-mode-room-state">{project?.name ?? 'No project selected'}</span>
          {project && (
            <>
              <button type="button" onClick={() => createChatThread(project.id)}>New thread</button>
              <button type="button" onClick={() => clearProjectChat(project.id)}>Clear</button>
            </>
          )}
        </div>
      </div>

      <div className="chat-mode-thread-header">
        <div className="chat-mode-thread-heading">
          <span className="chat-mode-thread-kicker">Project thread</span>
          <strong>{activeThread?.title ?? 'New thread'}</strong>
          <span>{activeThread?.agentName || (activeThread?.agentPreset ? getAgentDisplayName(activeThread.agentPreset) : 'Auto')} · {threadStatusLabel(activeThread?.status)}</span>
        </div>
        <span className="chat-mode-thread-count">{threads.length} thread{threads.length === 1 ? '' : 's'}</span>
      </div>

      <div className="chat-mode-body">
        <div ref={scrollRef} className="chat-mode-transcript" aria-live="polite">
          {messages.length === 0 ? (
            <div className="chat-mode-empty">
              <div className="chat-mode-empty-icon" aria-hidden="true">✦</div>
              <h2>What would you like to work on?</h2>
              <p>Ask for a change, a review, an explanation, or a new agent.</p>
              <div className="chat-mode-suggestions">
                {['Summarize this project', 'Check the current Git status', 'Open an agent to help me'].map((suggestion) => (
                  <button
                    key={suggestion}
                    type="button"
                    onClick={() => {
                      setDraft(suggestion);
                      if (activeThread) setThreadDraft(activeThread.id, suggestion);
                    }}
                  >
                    {suggestion}
                  </button>
                ))}
                </div>
              </div>
            ) : (
            messages.map((message) => (
              <article key={message.id} className={`chat-mode-message ${message.role}`}>
                <div className="chat-mode-message-meta">
                  <strong>{messageLabel(message)}</strong>
                  <time>{formatTime(message.ts)}</time>
                </div>
                <MessageBody text={message.text} pending={message.pending} />
                <InlineCard message={message} />
                {message.completion && (
                  <div className={`chat-mode-completion ${message.completion.status}`}>
                    <strong>{message.completion.taskTitle}</strong>
                    <span>{message.completion.summary || message.completion.reason || statusLabel(message.completion.status)}</span>
                  </div>
                )}
              </article>
            ))
          )}
        </div>
      </div>

      <form
        className="chat-mode-composer"
        onSubmit={(event) => {
          event.preventDefault();
          void submit();
        }}
      >
        <textarea
          value={draft}
          onChange={(event) => {
            const value = event.target.value;
            setDraft(value);
            if (activeThread) setThreadDraft(activeThread.id, value);
          }}
          onKeyDown={onComposerKeyDown}
          placeholder={project ? 'Ask Spacron to do something…' : 'Select a project first'}
          disabled={!project}
          rows={2}
          aria-label="Chat message"
        />
        <div className="chat-mode-composer-footer">
          <label>
            <span>Route to</span>
            <select value={forcedAgent} onChange={(event) => agentForcedAgent.set(event.target.value)} disabled={!project}>
              <option value="auto">Auto</option>
              {agents.map((agent) => <option key={agent.command} value={agent.command}>{agent.name}</option>)}
            </select>
          </label>
          <span className="chat-mode-shortcut">Ctrl/Cmd + Enter to send</span>
          <button type="submit" className="chat-mode-send" disabled={!project || !draft.trim()}>
            {pendingSendCount > 0 ? `Send (${pendingSendCount} active)` : 'Send'}
          </button>
        </div>
      </form>
    </section>
  );
}
