import { useEffect, useMemo, useRef, useState } from 'react';
import { activeProject } from '$lib/stores/workspace';
import { useStore } from '$lib/react/useStore';
import {
  agentForcedAgent,
  clearProjectChat,
  getDispatchableAgents,
  orchestratorTasks,
  sendChatMessage,
} from '$lib/stores/orchestrator';
import { allProjectSessions, getAgentDisplayName } from '$lib/stores/terminal';
import Dropdown, { type DropdownOption } from '$lib/components/shared/Dropdown';
import {
  getAgentProviderCapabilities,
  isChatAgentProvider,
  type AgentProviderModel,
} from '$lib/services/agent-provider-catalogue';
import { loadLiveAgentProviderModels } from '$lib/services/live-agent-models';
import {
  chatThreadState,
  createChatThread,
  ensureProjectThread,
  patchThreadMessage,
  setThreadDraft,
  updateChatThread,
  type ChatMessage,
  type ChatThread,
  type ChatAttachment,
} from '$lib/stores/chatThreads';
import { abortTranscription, startBarTranscription, transcriptionState } from '$lib/services/transcription-hotkey';
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

const MAX_ATTACHMENT_BYTES = 5 * 1024 * 1024;
const MAX_ATTACHMENT_TEXT = 120_000;

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function looksTextual(file: File): boolean {
  return file.type.startsWith('text/') || /\.(md|mdx|txt|json|jsonc|js|jsx|ts|tsx|css|scss|html|xml|yaml|yml|toml|rs|py|go|java|c|cpp|h|hpp|sql|sh|ps1)$/i.test(file.name);
}

async function toChatAttachment(file: File): Promise<ChatAttachment> {
  const attachment: ChatAttachment = {
    id: `attachment-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    name: file.name,
    type: file.type || 'application/octet-stream',
    size: file.size,
  };
  if (looksTextual(file)) {
    const text = await file.text();
    attachment.text = text.length > MAX_ATTACHMENT_TEXT
      ? `${text.slice(0, MAX_ATTACHMENT_TEXT)}\n\n[Attachment truncated at ${MAX_ATTACHMENT_TEXT.toLocaleString()} characters.]`
      : text;
  }
  return attachment;
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

function InlineCard({ message, onOption }: { message: ChatMessage; onOption?: (label: string) => void }) {
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
            {message.inlineRequest.options.map((option) => (
              <button key={option.id} type="button" onClick={() => onOption?.(option.label)} disabled={!onOption}>
                {option.label}
              </button>
            ))}
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
  const liveTasks = useStore(orchestratorTasks);
  const liveSessions = useStore(allProjectSessions);
  const transcriptionPhase = useStore(transcriptionState);
  const [draft, setDraft] = useState('');
  const [requestDraft, setRequestDraft] = useState('');
  const [attachments, setAttachments] = useState<ChatAttachment[]>([]);
  const [attachmentBusy, setAttachmentBusy] = useState(false);
  const [pendingSendCount, setPendingSendCount] = useState(0);
  const [liveModelsByProvider, setLiveModelsByProvider] = useState<Record<string, AgentProviderModel[]>>({});
  const [loadingModelsFor, setLoadingModelsFor] = useState<string | null>(null);
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);

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
  const chatAgents = useMemo(
    () => agents.filter((agent) => isChatAgentProvider(agent.command)),
    [agents],
  );
  const selectedProvider = activeThread?.provider ?? activeThread?.agentPreset ??
    (forcedAgent !== 'auto' ? forcedAgent : chatAgents[0]?.command ?? '');

  const providerOptions = useMemo<DropdownOption[]>(() => {
    const available = [...chatAgents];
    if (selectedProvider !== 'auto' && selectedProvider && !available.some((agent) => agent.command === selectedProvider)) {
      available.push({ command: selectedProvider, name: getAgentDisplayName(selectedProvider) ?? selectedProvider });
    }
    return available.map((agent) => {
      const task = liveTasks
        .filter((entry) => entry.projectId === project?.id && entry.agentPreset === agent.command)
        .sort((a, b) => (b.completedAt ?? b.startedAt ?? b.createdAt ?? 0) - (a.completedAt ?? a.startedAt ?? a.createdAt ?? 0))[0];
      const session = liveSessions.find((entry) => entry.projectId === project?.id && entry.agentPreset === agent.command && entry.isRunning);
      const status = task?.status === 'in-progress' || session ? 'Working' : task?.status === 'blocked' ? 'Needs input' : task?.status === 'complete' ? 'Complete' : 'Ready';
      const taskTitle = task?.title || session?.taskSummary || session?.paneTitle;
      return {
        value: agent.command,
        label: agent.name,
        sublabel: `${status}${taskTitle ? ` · ${taskTitle}` : ''}${session ? ' · terminal' : ''}`,
      };
    });
  }, [chatAgents, liveSessions, liveTasks, project?.id, selectedProvider]);

  const providerCapabilities = getAgentProviderCapabilities(selectedProvider);
  const liveModels = liveModelsByProvider[selectedProvider] ?? [];
  const availableModels = liveModels.length ? liveModels : providerCapabilities.models;
  const selectedModel = activeThread?.model ?? availableModels[0]?.id ?? 'default';
  const pendingRequestMessage = useMemo(
    () => [...messages].reverse().find((message) =>
      (message.type === 'approval' || message.type === 'input') &&
      message.inlineRequest && !message.inlineRequest.answeredAt,
    ) ?? null,
    [messages],
  );
  const pendingRequest = pendingRequestMessage?.inlineRequest ?? null;

  useEffect(() => {
    if (!selectedProvider || liveModelsByProvider[selectedProvider] || !project) return;
    let cancelled = false;
    setLoadingModelsFor(selectedProvider);
    void loadLiveAgentProviderModels(selectedProvider)
      .then((models) => {
        if (cancelled) return;
        setLiveModelsByProvider((current) => ({ ...current, [selectedProvider]: models }));
        if (models.length && activeThread && (!activeThread.model || activeThread.model === 'default')) {
          updateChatThread(activeThread.id, { model: models[0].id });
        }
      })
      .catch((error) => {
        if (!cancelled) console.warn(`[chat] Could not load live models for ${selectedProvider}:`, error);
      })
      .finally(() => {
        if (!cancelled) setLoadingModelsFor((current) => current === selectedProvider ? null : current);
      });
    return () => { cancelled = true; };
  }, [activeThread, liveModelsByProvider, project, selectedProvider]);

  const modelOptions = useMemo<DropdownOption[]>(() => {
    const models = availableModels;
    const withSelected = models.some((model) => model.id === selectedModel)
      ? models
      : [{ id: selectedModel, label: selectedModel, description: 'Selected by the provider', free: false }, ...models];
    return withSelected.map((model) => ({
      value: model.id,
      label: model.label,
      sublabel: model.free ? 'Free' : model.description,
    }));
  }, [availableModels, selectedModel]);

  const modelSource = loadingModelsFor === selectedProvider
    ? 'Loading live models…'
    : liveModels.length
      ? 'Live from CLI'
      : getAgentProviderCapabilities(selectedProvider).models.length
        ? 'CLI default'
        : 'Unavailable';

  useEffect(() => {
    if (project) ensureProjectThread(project.id);
  }, [project?.id]);

  useEffect(() => {
    if (!activeThread) return;
    setDraft(activeThread.draft);
    setRequestDraft('');
    setAttachments([]);
  }, [activeThread?.id]);

  useEffect(() => {
    const element = scrollRef.current;
    if (element) element.scrollTop = element.scrollHeight;
  }, [messages.length]);

  useEffect(() => {
    setDraft(activeThread?.draft ?? '');
  }, [project?.id]);

  async function answerPendingRequest(answer: string) {
    const trimmedAnswer = answer.trim();
    if (!project || !activeThread || !pendingRequestMessage || !pendingRequest || !trimmedAnswer) return;
    const answeredAt = Date.now();
    patchThreadMessage(activeThread.id, pendingRequestMessage.id, {
      inlineRequest: { ...pendingRequest, answer: trimmedAnswer, answeredAt },
    });
    updateChatThread(activeThread.id, { status: 'working', updatedAt: answeredAt, lastActivityAt: answeredAt });
    setRequestDraft('');
    await sendChatMessage(project.id, project.root_path, trimmedAnswer, {
      forcedAgent: activeThread.provider ?? selectedProvider,
      projectName: project.name,
      threadId: activeThread.id,
      provider: activeThread.provider ?? selectedProvider,
      model: activeThread.model ?? selectedModel,
      chatMode: true,
    });
  }

  async function handleFiles(files: FileList | null) {
    if (!files?.length) return;
    setAttachmentBusy(true);
    try {
      const next: ChatAttachment[] = [];
      for (const file of Array.from(files).slice(0, 5)) {
        if (file.size > MAX_ATTACHMENT_BYTES) {
          console.warn(`[chat] Skipping ${file.name}: attachment exceeds ${formatBytes(MAX_ATTACHMENT_BYTES)}.`);
          continue;
        }
        try {
          next.push(await toChatAttachment(file));
        } catch (error) {
          console.warn(`[chat] Could not read attachment ${file.name}:`, error);
        }
      }
      setAttachments((current) => [...current, ...next].slice(0, 5));
    } finally {
      setAttachmentBusy(false);
      if (fileInputRef.current) fileInputRef.current.value = '';
    }
  }

  function toggleDictation() {
    textareaRef.current?.focus();
    if (transcriptionPhase === 'listening') {
      abortTranscription();
      return;
    }
    startBarTranscription();
  }

  async function submit() {
    if (pendingRequest) {
      await answerPendingRequest(requestDraft);
      return;
    }
    const text = draft.trim() || (attachments.length ? 'Please review the attached files.' : '');
    if (!project || !activeThread || !text) return;
    setDraft('');
    setThreadDraft(activeThread.id, '');
    const messageAttachments = attachments;
    setAttachments([]);
    // A send commits the effective provider/model to this thread. Until then,
    // a fresh thread continues to follow its selected agent's defaults.
    updateChatThread(activeThread.id, { provider: selectedProvider, agentPreset: selectedProvider, model: selectedModel });
    setPendingSendCount((count) => count + 1);
    try {
      await sendChatMessage(project.id, project.root_path, text, {
        forcedAgent: selectedProvider,
        projectName: project.name,
        threadId: activeThread.id,
        provider: selectedProvider,
        model: selectedModel,
        chatMode: true,
        attachments: messageAttachments,
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
      className={`chat-mode-panel${messages.length === 0 ? ' empty' : ''}`}
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

      <div className={`chat-mode-body${messages.length === 0 ? ' is-empty' : ''}`}>
        <div ref={scrollRef} className={`chat-mode-transcript${messages.length === 0 ? ' is-empty' : ''}`} aria-live="polite">
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
                <InlineCard
                  message={message}
                  onOption={message.id === pendingRequestMessage?.id ? (option) => void answerPendingRequest(option) : undefined}
                />
                {message.attachments?.length ? (
                  <div className="chat-mode-message-attachments">
                    {message.attachments.map((attachment) => (
                      <span key={attachment.id} className="chat-mode-attachment-chip">
                        <span aria-hidden="true">↗</span>
                        {attachment.name}
                        <small>{formatBytes(attachment.size)}</small>
                      </span>
                    ))}
                  </div>
                ) : null}
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
        {pendingRequest && (
          <div className="chat-mode-pending-request" role="alert">
            <div className="chat-mode-pending-request-copy">
              <strong>{pendingRequest.type === 'approval' ? 'Approval needed' : 'The agent needs your input'}</strong>
              <MessageBody text={pendingRequest.prompt} />
            </div>
            {pendingRequest.options?.length ? (
              <div className="chat-mode-pending-request-options">
                {pendingRequest.options.map((option) => (
                  <button key={option.id} type="button" onClick={() => void answerPendingRequest(option.label)}>
                    {option.label}
                  </button>
                ))}
              </div>
            ) : null}
          </div>
        )}
        {attachments.length > 0 && (
          <div className="chat-mode-attachment-list" aria-label="Attached files">
            {attachments.map((attachment) => (
              <span key={attachment.id} className="chat-mode-attachment-chip">
                <span aria-hidden="true">↗</span>
                <span>{attachment.name}</span>
                <small>{formatBytes(attachment.size)}</small>
                <button
                  type="button"
                  onClick={() => setAttachments((current) => current.filter((entry) => entry.id !== attachment.id))}
                  aria-label={`Remove ${attachment.name}`}
                  title={`Remove ${attachment.name}`}
                >
                  ×
                </button>
              </span>
            ))}
          </div>
        )}
        <textarea
          ref={textareaRef}
          value={pendingRequest ? requestDraft : draft}
          onChange={(event) => {
            const value = event.target.value;
            if (pendingRequest) {
              setRequestDraft(value);
            } else {
              setDraft(value);
              if (activeThread) setThreadDraft(activeThread.id, value);
            }
          }}
          onKeyDown={onComposerKeyDown}
          placeholder={pendingRequest?.placeholder || (project ? 'Ask Spacron to do something…' : 'Select a project first')}
          disabled={!project}
          rows={2}
          aria-label="Chat message"
        />
        <input
          ref={fileInputRef}
          className="chat-mode-file-input"
          type="file"
          multiple
          onChange={(event) => void handleFiles(event.target.files)}
          aria-label="Attach files"
        />
        <div className="chat-mode-composer-footer">
          <button
            type="button"
            className="chat-mode-composer-icon-btn"
            onClick={() => fileInputRef.current?.click()}
            disabled={!project || attachmentBusy || attachments.length >= 5}
            title="Attach files"
            aria-label="Attach files"
          >
            {attachmentBusy ? '…' : '＋'}
          </button>
          <button
            type="button"
            className={`chat-mode-composer-icon-btn${transcriptionPhase === 'listening' ? ' active' : ''}`}
            onClick={toggleDictation}
            disabled={!project || transcriptionPhase === 'processing'}
            title={transcriptionPhase === 'listening' ? 'Stop dictation' : 'Dictate message'}
            aria-label={transcriptionPhase === 'listening' ? 'Stop dictation' : 'Dictate message'}
          >
            {transcriptionPhase === 'listening' ? '■' : '●'}
          </button>
          <div className="chat-mode-composer-control model-provider">
            <span className="chat-mode-control-label">Agent</span>
            <Dropdown
              value={selectedProvider}
              options={providerOptions}
              onChange={(value) => {
                const nextModel = getAgentProviderCapabilities(value).models[0]?.id ?? 'default';
                agentForcedAgent.set(value);
                if (activeThread) updateChatThread(activeThread.id, { provider: value, agentPreset: value, model: nextModel });
              }}
              ariaLabel="Chat provider"
              disabled={!project}
            />
          </div>
          <div className="chat-mode-composer-control model">
            <span className="chat-mode-control-label">
              <span>Model</span>
              <span className={`chat-mode-model-source${liveModels.length ? ' live' : ''}`}>{modelSource}</span>
            </span>
            <Dropdown
              value={selectedModel}
              options={modelOptions}
              onChange={(value) => {
                if (activeThread) updateChatThread(activeThread.id, { provider: selectedProvider, agentPreset: selectedProvider, model: value });
              }}
              ariaLabel="Chat model"
              disabled={!project}
            />
          </div>
          <span className="chat-mode-shortcut">Ctrl/Cmd + Enter to send</span>
          <button type="submit" className="chat-mode-send" disabled={!project || !(pendingRequest ? requestDraft.trim() : draft.trim() || attachments.length)}>
            {pendingRequest ? 'Continue' : pendingSendCount > 0 ? `Send (${pendingSendCount} active)` : 'Send'}
          </button>
        </div>
      </form>
    </section>
  );
}
