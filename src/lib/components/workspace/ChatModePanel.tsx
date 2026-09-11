import { useEffect, useMemo, useRef, useState } from 'react';
import { activeProject } from '$lib/stores/workspace';
import { useStore } from '$lib/react/useStore';
import {
  agentForcedAgent,
  chatMessages,
  clearProjectChat,
  getDispatchableAgents,
  orchestratorTasks,
  sendChatMessage,
  type ChatMessage,
} from '$lib/stores/orchestrator';
import { getAgentDisplayName } from '$lib/stores/terminal';
import './ChatModePanel.css';

const CHAT_MODE_PROTOTYPE_RESET_KEY = 'spacron_chat_mode_prototype_reset_v1';

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

export default function ChatModePanel() {
  const project = useStore(activeProject);
  const allMessages = useStore(chatMessages);
  const allTasks = useStore(orchestratorTasks);
  const forcedAgent = useStore(agentForcedAgent);
  const [draft, setDraft] = useState('');
  const [pendingSendCount, setPendingSendCount] = useState(0);
  const [composerCentered, setComposerCentered] = useState(false);
  const panelRef = useRef<HTMLElement | null>(null);
  const composerRef = useRef<HTMLFormElement | null>(null);
  const scrollRef = useRef<HTMLDivElement | null>(null);

  const messages = useMemo(
    () => (project ? allMessages[project.id] ?? [] : []),
    [allMessages, project],
  );
  const tasks = useMemo(
    () => (project ? allTasks.filter((task) => task.projectId === project.id).slice(-5).reverse() : []),
    [allTasks, project],
  );
  const agents = useMemo(
    () => (project ? getDispatchableAgents(project.id) : []),
    [project],
  );

  useEffect(() => {
    const element = scrollRef.current;
    if (element) element.scrollTop = element.scrollHeight;
  }, [messages.length]);

  useEffect(() => {
    setDraft('');
    setComposerCentered(false);
  }, [project?.id]);

  useEffect(() => {
    if (!composerCentered) return;
    const frame = window.requestAnimationFrame(() => {
      const panel = panelRef.current;
      const composer = composerRef.current;
      if (!panel || !composer) return;
      const panelRect = panel.getBoundingClientRect();
      const composerRect = composer.getBoundingClientRect();
      const target = panel.scrollTop
        + composerRect.top
        - panelRect.top
        - (panel.clientHeight - composerRect.height) / 2;
      const maxScroll = Math.max(0, panel.scrollHeight - panel.clientHeight);
      panel.scrollTo({
        top: Math.min(maxScroll, Math.max(0, target)),
        behavior: 'smooth',
      });
    });
    return () => window.cancelAnimationFrame(frame);
  }, [composerCentered]);

  // The first Chat-mode prototype shipped with seeded/demo conversation rows.
  // Clear that one-time fixture for the current project so this room starts as
  // a real workspace. Later conversations remain durable and user-controlled.
  useEffect(() => {
    if (!project) return;
    try {
      if (window.localStorage.getItem(CHAT_MODE_PROTOTYPE_RESET_KEY)) return;
      clearProjectChat(project.id);
      window.localStorage.setItem(CHAT_MODE_PROTOTYPE_RESET_KEY, '1');
    } catch {
      // If storage is unavailable, leave the live conversation untouched.
    }
  }, [project]);

  async function submit() {
    const text = draft.trim();
    if (!project || !text) return;
    setDraft('');
    setComposerCentered(false);
    setPendingSendCount((count) => count + 1);
    try {
      await sendChatMessage(project.id, project.root_path, text, {
        forcedAgent,
        projectName: project.name,
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
      ref={panelRef}
      className={`chat-mode-panel${composerCentered ? ' is-composing' : ''}`}
      aria-label="Chat room"
    >
      <div className="chat-mode-room-header">
        <div className="chat-mode-room-title">
          <span className="chat-mode-room-icon" aria-hidden="true">✦</span>
          <span className="chat-mode-room-kind">chat</span>
          <strong>Chat</strong>
        </div>
        <div className="chat-mode-room-actions">
          <span className="chat-mode-room-state">Project conversation</span>
          {project && (
            <button type="button" onClick={() => clearProjectChat(project.id)}>
              Clear
            </button>
          )}
        </div>
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
                  <button key={suggestion} type="button" onClick={() => setDraft(suggestion)}>
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

        <aside className="chat-mode-sidecar">
          <div className="chat-mode-context">
            <span className="chat-mode-context-label">Project context</span>
            <strong>{project?.name ?? 'No project selected'}</strong>
            {project && <span>{project.root_path}</span>}
          </div>
          <div className="chat-mode-activity" aria-label="Agent activity">
            <div className="chat-mode-activity-heading">
              <span>Activity</span>
              <span className="chat-mode-live-mark">Live</span>
            </div>
            {tasks.length === 0 ? (
              <p className="chat-mode-activity-empty">Agent work will appear here.</p>
            ) : (
              <div className="chat-mode-task-list">
                {tasks.map((task) => (
                  <div key={task.id} className="chat-mode-task">
                    <span className={`chat-mode-task-status ${task.status}`} />
                    <div>
                      <strong>{task.name || getAgentDisplayName(task.agentPreset) || 'Agent'}</strong>
                      <span>{task.title}</span>
                    </div>
                    <em>{statusLabel(task.status)}</em>
                  </div>
                ))}
              </div>
            )}
          </div>
        </aside>
      </div>

      <form
        ref={composerRef}
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
            if (value.trim() && !composerCentered) setComposerCentered(true);
          }}
          onFocus={() => setComposerCentered(true)}
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
