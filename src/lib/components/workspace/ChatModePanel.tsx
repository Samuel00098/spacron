import { useEffect, useMemo, useRef, useState } from 'react';
import { activeProject } from '$lib/stores/workspace';
import { useStore } from '$lib/react/useStore';
import {
  agentForcedAgent,
  chatMessages,
  getDispatchableAgents,
  orchestratorTasks,
  sendChatMessage,
  type ChatMessage,
} from '$lib/stores/orchestrator';
import { getAgentDisplayName } from '$lib/stores/terminal';
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
  const [sending, setSending] = useState(false);
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
  }, [project?.id]);

  async function submit() {
    const text = draft.trim();
    if (!project || !text || sending) return;
    setDraft('');
    setSending(true);
    try {
      await sendChatMessage(project.id, project.root_path, text, {
        forcedAgent,
        projectName: project.name,
      });
    } finally {
      setSending(false);
    }
  }

  function onComposerKeyDown(event: React.KeyboardEvent<HTMLTextAreaElement>) {
    if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) {
      event.preventDefault();
      void submit();
    }
  }

  return (
    <section className="chat-mode-panel" aria-label="Chat room">
      <div className="chat-mode-room-header">
        <div className="chat-mode-room-title">
          <span className="chat-mode-room-icon" aria-hidden="true">✦</span>
          <span className="chat-mode-room-kind">chat</span>
          <strong>Chat</strong>
        </div>
        <span className="chat-mode-room-state">Project conversation</span>
      </div>
      <header className="chat-mode-header">
        <div>
          <span className="chat-mode-eyebrow">Chat mode</span>
          <h1>{project ? `Talk to your project` : 'Open a project to start chatting'}</h1>
          <p>
            {project
              ? 'Describe the work and Spacron will route it to the right agent.'
              : 'Your live terminals are waiting behind this view.'}
          </p>
        </div>
        <div className="chat-mode-context">
          <span className="chat-mode-context-label">Project context</span>
          <strong>{project?.name ?? 'No project selected'}</strong>
          {project && <span>{project.root_path}</span>}
        </div>
      </header>

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

        <aside className="chat-mode-activity" aria-label="Agent activity">
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
        </aside>
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
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={onComposerKeyDown}
          placeholder={project ? 'Ask Spacron to do something…' : 'Select a project first'}
          disabled={!project || sending}
          rows={2}
          aria-label="Chat message"
        />
        <div className="chat-mode-composer-footer">
          <label>
            <span>Route to</span>
            <select value={forcedAgent} onChange={(event) => agentForcedAgent.set(event.target.value)} disabled={!project || sending}>
              <option value="auto">Auto</option>
              {agents.map((agent) => <option key={agent.command} value={agent.command}>{agent.name}</option>)}
            </select>
          </label>
          <span className="chat-mode-shortcut">Ctrl/Cmd + Enter to send</span>
          <button type="submit" className="chat-mode-send" disabled={!project || !draft.trim() || sending}>
            {sending ? 'Working…' : 'Send'}
          </button>
        </div>
      </form>
    </section>
  );
}
