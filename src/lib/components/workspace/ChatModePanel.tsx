import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type MouseEvent as ReactMouseEvent, type KeyboardEvent as ReactKeyboardEvent } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { marked } from 'marked';
import DOMPurify from 'dompurify';
import { get } from '$lib/stores/storeCompat';
import { activeProject, activeWorkspace } from '$lib/stores/workspace';
import { useStore } from '$lib/react/useStore';
import { stopChatTurn, sendChatMessage, enqueueChatMessage, resendEditedChatMessage, hasResumableTurn, resumeOrchestratorTurn, dismissResumableTurn, orchestratorTasks, resolveProjectFilePath, chatMessageQueues, removeQueuedChatMessage, steerQueuedChatMessage, editImageInThread, type QueuedChatMessage } from '$lib/stores/orchestrator';
import {
  chatThreadState,
  chatTurnTicker,
  clearPendingNewThreadSettings,
  clearChatTurnTicker,
  appendThreadMessage,
  createChatThread,
  ensureProjectThread,
  getPendingNewThreadSettings,
  removeThreadMessage,
  setThreadDraft,
  updateChatThread,
} from '$lib/stores/chatThreads';
import { openFile } from '$lib/stores/editor';
import { setActiveView } from '$lib/stores/layout';
import Dropdown, { type DropdownOption } from '$lib/components/shared/Dropdown';
import ChatAgentModelPicker from './ChatAgentModelPicker';
import { todoProgress } from '$lib/services/orchestrator/chat-turn';
import { ProviderBrandMark } from '$lib/components/shared/providerBrands';
import {
  aiModelByProvider,
  aiProvider,
  aiProviders,
  currentAiModel,
  getProviderDef,
  openaiRealtimeModel,
  openaiRealtimeVoice,
  openaiLiveModel,
  openaiLiveVoice,
  setAiModel,
  voiceConversationEngine,
  xaiRealtimeModel,
  xaiRealtimeVoice,
  type AiModelOption,
  type AiProviderId,
} from '$lib/stores/settings';
import { isProviderApiKeyConfiguredLocal, listProviderModels } from '$lib/services/ai-keychain';
import { openSettings } from '$lib/stores/layout';
import { showToast } from '$lib/stores/notification';
import {
  agentPlacementRequest,
  resolveAgentPlacement,
  type AgentLaunchChoice,
  type AgentPlacement,
  initialLaunchChoice,
  type AgentPlacementRequest,
} from '$lib/stores/agentPlacement';
import { loadLiveAgentProviderModels } from '$lib/services/live-agent-models';
import type { AgentProviderModel } from '$lib/services/agent-provider-catalogue';
import AgentLaunchConfigFields from '$lib/components/shared/AgentLaunchConfigFields';
import {
  isRealtimeVoiceSupported,
  REALTIME_VOICE_INSTRUCTIONS,
  startRealtimeVoiceSession,
  type RealtimeVoiceProvider,
  type RealtimeVoiceSession,
  type RealtimeVoiceState,
} from '$lib/services/realtime-voice';
import type { ChatAccessMode, ChatAttachment, ChatInlineRequest, ChatMessage, ChatReasoningEffort } from '$lib/types/chat';
import { REASONING_LABELS, reasoningLevelsFor } from '$lib/services/orchestrator/reasoning-levels';
import {
  sendTranscriptionNow,
  transcriptionActive,
  transcriptionLevel,
  transcriptionState,
  transcriptionTarget,
  transcriptionWordCount,
  toggleChatModeTranscription,
} from '$lib/services/transcription-hotkey';
import { chatVoiceModeRequest } from '$lib/stores/interactionMode';
import SpectrumVisualizer, { type SpectrumPhase } from '$lib/components/terminal/SpectrumVisualizer';
import VoiceInputIcon from '$lib/components/shared/VoiceInputIcon';
import { copyTextToClipboard } from '$lib/utils/clipboard';
import { isTauriRuntime, dropPositionToCss } from '$lib/utils/tauri';
import { isImagePath, getImageMimeType } from '$lib/stores/editor';
import { TURN_TIMING_PREFIX } from '$lib/services/orchestrator/turn-timing';
import ImageViewer, { type ViewerImage } from '$lib/components/shared/ImageViewer';
import { convertFileSrc } from '@tauri-apps/api/core';
import './ChatModePanel.css';

const MAX_ATTACHMENT_BYTES = 5 * 1024 * 1024;
const MAX_ATTACHMENT_TEXT = 120_000;
const MODEL_REFRESH_COOLDOWN_MS = 60_000;
const MODEL_REFRESH_INTERVAL_MS = 5 * 60_000;

function formatTime(timestamp: number): string {
  return new Date(timestamp).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function looksTextual(file: File): boolean {
  return file.type.startsWith('text/') ||
    /\.(md|mdx|txt|json|jsonc|js|jsx|ts|tsx|css|scss|html|xml|yaml|yml|toml|rs|py|go|java|c|cpp|h|hpp|sql|sh|ps1)$/i.test(file.name);
}

/** The viewer entry for an image attachment, or null when it has nothing to show. */
function attachmentViewerImage(attachment: ChatAttachment): ViewerImage | null {
  if (!attachment.type.startsWith('image/')) return null;
  if (attachment.previewUrl) return { src: attachment.previewUrl, name: attachment.name, path: attachment.path };
  // A sent message keeps only the path. Pasted images live in a temp folder
  // for the session; generated ones are kept (see ChatAttachment.generated).
  if (attachment.path && isTauriRuntime()) return { src: convertFileSrc(attachment.path), name: attachment.name, path: attachment.path };
  return null;
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
  } else if (file.type.startsWith('image/')) {
    const data = Array.from(new Uint8Array(await file.arrayBuffer()));
    attachment.path = (await invoke<string>('save_pasted_image', {
      name: file.name || `attachment-${Date.now()}.png`,
      data,
    })).replace(/\\/g, '/');
    try {
      attachment.previewUrl = URL.createObjectURL(file);
    } catch {
      /* preview is best-effort */
    }
  }
  return attachment;
}

function PaperclipIcon() {
  return <svg className="chat-mode-composer-action-icon chat-mode-paperclip-icon" viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="m20.5 11.5-8.75 8.75a5.3 5.3 0 0 1-7.5-7.5l9.25-9.25a3.75 3.75 0 0 1 5.3 5.3l-9.25 9.25a2.15 2.15 0 0 1-3.05-3.05l8.55-8.55" /></svg>;
}

function VoiceModeIcon() {
  return <svg className="chat-mode-composer-action-icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M4 9v6M8 6v12M12 3v18M16 6v12M20 9v6" /></svg>;
}

function ImageIcon() {
  return <svg className="chat-mode-composer-action-icon" viewBox="0 0 24 24" aria-hidden="true"><rect x="3" y="4" width="18" height="16" rx="2" /><circle cx="8.5" cy="9" r="1.5" /><path d="m5 17 4.5-4.5 3 3 2-2 4.5 4.5" /></svg>;
}

function CopyIcon() {
  return <svg viewBox="0 0 24 24" aria-hidden="true"><rect x="8" y="8" width="11" height="12" rx="2" /><path d="M16 8V6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v10a2 2 0 0 0 2 2h2" /></svg>;
}

function EditIcon() {
  return <svg viewBox="0 0 24 24" aria-hidden="true"><path d="m4 16.5-.7 3.9 3.9-.7L18.8 8.1a2.2 2.2 0 0 0-3.1-3.1z" /><path d="m14.4 6.8 2.8 2.8" /></svg>;
}

function MessageBody({ text, pending }: { text: string; pending?: boolean }) {
  if (pending && !text.trim()) {
    return <span className="chat-mode-pending"><i /><i /><i /></span>;
  }
  const lines = text.split('\n');
  return (
    <div className="chat-mode-message-text">
      {lines.map((line, index) => (
        <span key={`${index}-${line}`}>
          {line || '\u00a0'}
          {index < lines.length - 1 && <br />}
        </span>
      ))}
    </div>
  );
}

// ─── Clickable file paths in chat replies ────────────────────────────────────
// Models mention written files as plain text or inline code ("File created:
// `docs/2026-09-17-app-review-suggestions.md`"). After the sanitized markdown
// hits the DOM, bare path-like tokens are wrapped in clickable spans; one
// delegated handler opens them in the editor.

/** Repo-relative path with at least one directory and an extension. */
const CHAT_FILE_PATH_RE = /((?:[\w@.-]+\/)+[\w@.-]+\.[A-Za-z0-9]{1,6})(?=[.,;:!?)]*[\s)]|$)/g;
const CHAT_FILE_PATH_TEST_RE = new RegExp(CHAT_FILE_PATH_RE.source);

/** Wrap path-like text tokens in clickable spans. Idempotent per DOM subtree. */
function linkifyProjectPaths(root: HTMLElement): void {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
    acceptNode(node) {
      const parent = (node as Text).parentElement;
      // Links/pre blocks are already actionable or preformatted; existing
      // chat-file-link spans keep re-renders from double-wrapping. Inline
      // <code> is intentionally INCLUDED: backticked paths are the most
      // common way models mention written files.
      if (!parent || parent.closest('a, pre, button, .chat-mode-file-link')) return NodeFilter.FILTER_REJECT;
      CHAT_FILE_PATH_TEST_RE.lastIndex = 0;
      return CHAT_FILE_PATH_TEST_RE.test(node.nodeValue ?? '') ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_REJECT;
    },
  });
  const nodes: Text[] = [];
  while (walker.nextNode()) nodes.push(walker.currentNode as Text);
  for (const node of nodes) {
    const value = node.nodeValue ?? '';
    const fragment = document.createDocumentFragment();
    let cursor = 0;
    CHAT_FILE_PATH_RE.lastIndex = 0;
    for (const match of value.matchAll(CHAT_FILE_PATH_RE)) {
      const start = match.index ?? 0;
      const path = match[1];
      if (start > cursor) fragment.appendChild(document.createTextNode(value.slice(cursor, start)));
      const link = document.createElement('span');
      link.className = 'chat-mode-file-link';
      link.dataset.chatFilePath = path;
      link.tabIndex = 0;
      link.setAttribute('role', 'link');
      link.title = 'Open in editor';
      link.textContent = path;
      fragment.appendChild(link);
      cursor = start + path.length;
    }
    if (cursor === 0) continue;
    if (cursor < value.length) fragment.appendChild(document.createTextNode(value.slice(cursor)));
    node.replaceWith(fragment);
  }
}

/** Open a chat-mentioned project path in the editor, resolving it against the active project root. */
async function openChatFilePath(rawPath: string): Promise<void> {
  const path = rawPath.trim();
  if (!path) return;
  const project = get(activeProject);
  if (!project?.root_path) {
    showToast('No active project to open the file in.', 'warning', 4000);
    return;
  }
  try {
    await openFile(resolveProjectFilePath(path, project.root_path));
    setActiveView('editor');
  } catch {
    showToast(`Couldn't open ${path}`, 'error', 4000);
  }
}

function handleChatMarkdownClick(event: ReactMouseEvent<HTMLDivElement>): void {
  const link = (event.target as HTMLElement | null)?.closest?.('[data-chat-file-path]') as HTMLElement | null;
  if (!link) return;
  event.preventDefault();
  void openChatFilePath(link.dataset.chatFilePath ?? '');
}

function handleChatMarkdownKeydown(event: ReactKeyboardEvent<HTMLDivElement>): void {
  if (event.key !== 'Enter' && event.key !== ' ') return;
  const path = (event.target as HTMLElement | null)?.dataset?.chatFilePath;
  if (!path) return;
  event.preventDefault();
  void openChatFilePath(path);
}

function ChatMarkdownBody({ text, pending }: { text: string; pending?: boolean }) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const html = useMemo(() => {
    try {
      return DOMPurify.sanitize(marked.parse(text || '', { gfm: true, breaks: true }) as string);
    } catch (error) {
      console.error('Failed to render chat Markdown:', error);
      return DOMPurify.sanitize(text || '');
    }
  }, [text]);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    container.querySelectorAll('table').forEach((table) => {
      if (table.parentElement?.classList.contains('chat-mode-markdown-table-scroll')) return;
      const scrollRegion = document.createElement('div');
      scrollRegion.className = 'chat-mode-markdown-table-scroll';
      scrollRegion.tabIndex = 0;
      scrollRegion.setAttribute('role', 'region');
      scrollRegion.setAttribute('aria-label', 'Scrollable table');
      table.parentNode?.insertBefore(scrollRegion, table);
      scrollRegion.appendChild(table);
    });

    linkifyProjectPaths(container);
  }, [html]);

  if (pending && !text.trim()) {
    return <span className="chat-mode-pending"><i /><i /><i /></span>;
  }
  return (
    <div
      ref={containerRef}
      className="chat-mode-message-markdown"
      onClick={handleChatMarkdownClick}
      onKeyDown={handleChatMarkdownKeydown}
      dangerouslySetInnerHTML={{ __html: html }}
    />
  );
}

function messageLabel(message: ChatMessage): string {
  return message.role === 'user' ? 'You' : 'Spacron';
}

function statusLabel(status: string): string {
  switch (status) {
    case 'done': return 'Completed';
    case 'failed': return 'Failed';
    case 'blocked': return 'Needs input';
    case 'complete': return 'Completed';
    case 'needs-input': return 'Needs input';
    case 'working': return 'Working';
    case 'idle': return 'Idle';
    case 'draft': return 'Draft';
    default: return 'Working';
  }
}

function liveTaskStatusLabel(status: string, stalled: boolean): string {
  if (stalled && status === 'in-progress') return 'Possibly stalled';
  switch (status) {
    case 'in-progress': return 'Working';
    case 'blocked': return 'Needs input';
    case 'complete': return 'Completed';
    case 'failed': return 'Failed';
    case 'cancelled': return 'Cancelled';
    default: return statusLabel(status);
  }
}

function InlineCard({ message, onOption }: { message: ChatMessage; onOption?: (label: string) => void }) {
  if (message.type === 'orchestrator') {
    return (
      <div className="chat-mode-inline-card orchestrator">
        <span>Activity</span>
        <MessageBody text={message.text} />
      </div>
    );
  }
  if ((message.type === 'approval' || message.type === 'input') && message.inlineRequest) {
    const request = message.inlineRequest;
    const answered = !!request.answeredAt;
    const picked = answered
      ? request.options?.find((option) => request.answer === option.label || request.answer === option.id)
      : null;
    return (
      <div className={`chat-mode-inline-card request${answered ? ' answered' : ''}`}>
        <strong>{message.type === 'approval' ? 'Approval needed' : 'Input needed'}</strong>
        <MessageBody text={request.prompt} />
        {answered ? (
          <span className="chat-mode-inline-answer">✓ {picked?.label ?? request.answer}</span>
        ) : request.options?.length ? (
          <div className="chat-mode-inline-options">
            {request.options.map((option) => (
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

function ActivityDisclosure({ activities: rows }: { activities: ChatMessage[] }) {
  // The turn's timing row is a summary, not an operation: it labels the
  // disclosure ("Worked for 2m 14s") and stays out of the count.
  const timing = rows.find((row) => row.text.startsWith(TURN_TIMING_PREFIX));
  const activities = timing ? rows.filter((row) => row !== timing) : rows;
  const pending = activities.some((activity) => activity.pending);
  const noun = activities.length === 1 ? 'operation' : 'operations';

  return (
    <div className="chat-mode-tool-work">
      <details className="chat-mode-activity-details">
        <summary>
          <span className={`chat-mode-activity-state${pending ? ' pending' : ''}`}>
            {pending ? 'Working' : 'Work details'}
          </span>
          <span className="chat-mode-activity-summary">
            {activities.length} {noun}
            {timing ? ` · ${timing.text.split('\n')[0].slice(TURN_TIMING_PREFIX.length)}` : ''}
          </span>
          <svg className="chat-mode-activity-chevron" viewBox="0 0 16 16" aria-hidden="true">
            <path d="m4 6 4 4 4-4" />
          </svg>
        </summary>
        <div className="chat-mode-activity-list">
          {timing && <pre className="chat-mode-activity-timing">{timing.text.split('\n').filter(Boolean).join('\n')}</pre>}
          {activities.map((activity) => {
            const lines = activity.text.split('\n');
            const title = lines[0] || 'Tool activity';
            const detail = lines.slice(1).join('\n').trim();
            return (
              <div key={activity.id} className={`chat-mode-activity-step${activity.pending ? ' pending' : ''}`}>
                <div className="chat-mode-activity-step-title">
                  <span className="chat-mode-activity-step-state">{activity.pending ? 'Working' : 'Done'}</span>
                  <span>{title}</span>
                </div>
                {detail && <pre>{detail}</pre>}
              </div>
            );
          })}
        </div>
      </details>
    </div>
  );
}

/** A reply that can carry a Work details disclosure (not a card or a report). */
function ownsActivity(message: ChatMessage | undefined): boolean {
  return message?.role === 'assistant'
    && message.type !== 'activity'
    && message.type !== 'approval'
    && message.type !== 'input'
    && message.type !== 'completion';
}

/**
 * The index of the reply a run of activity rows belongs to, or -1. A run has
 * ONE owner — the reply right after it, else the reply right before it — so
 * the same operations are never rendered twice (the old rule attached a run to
 * the replies on BOTH sides, duplicating "Work details" around a card).
 */
function activityRunOwner(messages: ChatMessage[], messageIndex: number): number {
  let first = messageIndex;
  while (first > 0 && messages[first - 1]?.type === 'activity') first -= 1;
  let last = messageIndex;
  while (last + 1 < messages.length && messages[last + 1]?.type === 'activity') last += 1;
  if (ownsActivity(messages[last + 1])) return last + 1;
  if (ownsActivity(messages[first - 1])) return first - 1;
  return -1;
}

function adjacentActivities(messages: ChatMessage[], messageIndex: number): ChatMessage[] {
  if (!ownsActivity(messages[messageIndex])) return [];
  const before: ChatMessage[] = [];
  for (let index = messageIndex - 1; index >= 0 && messages[index]?.type === 'activity'; index -= 1) before.unshift(messages[index]);
  const after: ChatMessage[] = [];
  for (let index = messageIndex + 1; index < messages.length && messages[index]?.type === 'activity'; index += 1) after.push(messages[index]);
  return [
    ...(before.length && activityRunOwner(messages, messageIndex - 1) === messageIndex ? before : []),
    ...(after.length && activityRunOwner(messages, messageIndex + 1) === messageIndex ? after : []),
  ];
}

function activityRunBelongsToAssistant(messages: ChatMessage[], messageIndex: number): boolean {
  return activityRunOwner(messages, messageIndex) >= 0;
}

function ChatPlacementDialog({ request }: { request: AgentPlacementRequest }) {
  const [choices, setChoices] = useState<AgentLaunchChoice[]>([]);
  const [modelsByCommand, setModelsByCommand] = useState<Record<string, AgentProviderModel[]>>({});
  const [loadingCommands, setLoadingCommands] = useState<Set<string>>(new Set());

  useEffect(() => {
    setChoices(request.agents.map((_agent, index) => initialLaunchChoice(request, index)));
    let cancelled = false;
    const commands = [...new Set(request.commands ?? request.agents)];
    setLoadingCommands(new Set(commands));
    void Promise.all(commands.map(async (command) => {
      try {
        const models = await loadLiveAgentProviderModels(command);
        if (!cancelled && models.length) {
          setModelsByCommand((current) => ({ ...current, [command]: models }));
        }
      } catch (error) {
        console.warn(`Could not load ${command} local models:`, error);
      } finally {
        if (!cancelled) {
          setLoadingCommands((current) => {
            const next = new Set(current);
            next.delete(command);
            return next;
          });
        }
      }
    }));
    return () => { cancelled = true; };
  }, [request.id]);

  const launchChoices = request.agents.map((_agent, index) => choices[index] ?? initialLaunchChoice(request, index));
  const placements = launchChoices.map((choice) => choice.placement);
  const isolatedCount = placements.filter((placement) => placement === 'worktree').length;
  const mainCount = placements.length - isolatedCount;
  const isMulti = placements.length > 1;
  const setAt = (index: number, placement: AgentPlacement) => {
    setChoices(launchChoices.map((choice, currentIndex) => currentIndex === index ? { ...choice, placement } : choice));
  };
  const setAll = (placement: AgentPlacement) => setChoices(launchChoices.map((choice) => ({ ...choice, placement })));
  const setModel = (index: number, model: string | null) =>
    setChoices(launchChoices.map((choice, currentIndex) => currentIndex === index ? { ...choice, model } : choice));
  const setReasoning = (index: number, reasoningEffort: ChatReasoningEffort) =>
    setChoices(launchChoices.map((choice, currentIndex) => currentIndex === index ? { ...choice, reasoningEffort } : choice));
  const commandFor = (index: number) => request.commands?.[index] ?? request.agents[index] ?? '';
  const modelsFor = (index: number) => modelsByCommand[commandFor(index)] ?? [];
  const confirmLabel = !isMulti
    ? placements[0] === 'main' ? 'Start in main repo' : 'Start isolated'
    : mainCount === 0 ? `Start ${placements.length} isolated`
      : isolatedCount === 0 ? `Start ${placements.length} in main repo`
        : `Start ${placements.length} agents`;

  return (
    <div className="chat-mode-placement-dialog" role="dialog" aria-label="Configure local CLI agent launches">
      <div className="chat-mode-placement-header">
        <div>
          <strong>{isMulti ? 'Configure these local CLI launches' : 'Configure this local CLI launch'}</strong>
          <span>{isMulti ? `${placements.length} agents · location, model, and reasoning` : `${request.agents[0] ?? 'Agent'} · location, model, and reasoning`}</span>
        </div>
        {isMulti && (
          <div className="chat-mode-placement-setall" aria-label="Set all agent locations">
            <span>Set all</span>
            <button type="button" className={isolatedCount === placements.length ? 'active' : ''} onClick={() => setAll('worktree')}>Isolated</button>
            <button type="button" className={mainCount === placements.length ? 'active' : ''} onClick={() => setAll('main')}>Main repo</button>
          </div>
        )}
      </div>
      {request.suggestionReason && <p className="chat-mode-placement-hint">{request.suggestionReason}</p>}
      <div className="chat-mode-placement-list">
        {request.agents.map((agent, index) => (
          <div className="chat-mode-placement-row" key={`${agent}-${index}`}>
            <div className="chat-mode-placement-location">
              <span className="chat-mode-placement-agent" title={agent}>{agent}</span>
              <div className="chat-mode-placement-options">
                <button type="button" className={placements[index] === 'worktree' ? 'active' : ''} onClick={() => setAt(index, 'worktree')}>Isolated</button>
                <button type="button" className={placements[index] === 'main' ? 'active' : ''} onClick={() => setAt(index, 'main')}>Main repo</button>
              </div>
            </div>
            <AgentLaunchConfigFields
              className="chat-mode-placement-config"
              command={commandFor(index)}
              models={modelsFor(index)}
              loading={loadingCommands.has(commandFor(index))}
              model={launchChoices[index].model ?? null}
              reasoningEffort={launchChoices[index].reasoningEffort ?? 'default'}
              onModelChange={(model) => setModel(index, model)}
              onReasoningChange={(effort) => setReasoning(index, effort)}
              boundarySelector=".chat-mode-placement-dialog"
            />
          </div>
        ))}
      </div>
      <div className="chat-mode-placement-footer">
        <span>{isolatedCount} isolated · {mainCount} main repo</span>
        <div>
          <button type="button" onClick={() => resolveAgentPlacement(request.id, null)}>Cancel</button>
          <button type="button" className="primary" onClick={() => resolveAgentPlacement(request.id, launchChoices)}>{confirmLabel}</button>
        </div>
      </div>
    </div>
  );
}

function ChatInputDialog({
  request,
  draft,
  onDraftChange,
  onAnswer,
  busy,
}: {
  request: ChatInlineRequest;
  draft: string;
  onDraftChange: (value: string) => void;
  onAnswer: (value: string) => void;
  busy: boolean;
}) {
  return (
    <div className="chat-mode-input-dialog" role="dialog" aria-label="Input needed">
      <div className="chat-mode-input-dialog-copy">
        <strong>{request.type === 'approval' ? 'Approval needed' : request.taskId ? 'Your agent needs your input' : 'The orchestrator needs your input'}</strong>
        <ChatMarkdownBody text={request.prompt} />
      </div>
      {request.options?.length ? (
        <div className="chat-mode-input-dialog-options" aria-label="Suggested answers">
          {request.options.map((option) => (
            <button key={option.id} type="button" disabled={busy} onClick={() => onAnswer(option.label)}>{option.label}</button>
          ))}
        </div>
      ) : null}
      <div className="chat-mode-input-dialog-custom">
        <textarea
          value={draft}
          rows={1}
          onChange={(event) => onDraftChange(event.target.value)}
          placeholder={request.placeholder || 'Or type a custom answer…'}
          aria-label="Custom input"
          disabled={busy}
          onKeyDown={(event) => {
            if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing && event.keyCode !== 229) {
              event.preventDefault();
              onAnswer(draft);
            }
          }}
        />
        <button type="button" onClick={() => onAnswer(draft)} disabled={busy || !draft.trim()}>{busy ? 'Sending…' : 'Send'}</button>
      </div>
    </div>
  );
}

export default function ChatModePanel() {
  const project = useStore(activeProject);
  const workspace = useStore(activeWorkspace);
  const pendingProjectPath = workspace?.active_project_path ?? workspace?.project_paths?.[0];
  const projectName = project?.name ?? pendingProjectPath?.replace(/[\\/]+$/, '').split(/[\\/]/).pop();
  const threadState = useStore(chatThreadState);
  const allTasks = useStore(orchestratorTasks);
  const defaultProvider = useStore(aiProvider);
  const defaultModel = useStore(currentAiModel);
  const modelByProvider = useStore(aiModelByProvider);
  const transcriptionPhase = useStore(transcriptionState);
  const transcriptionActiveValue = useStore(transcriptionActive);
  const transcriptionLevelValue = useStore(transcriptionLevel);
  const transcriptionTargetValue = useStore(transcriptionTarget);
  const transcriptionWordCountValue = useStore(transcriptionWordCount);
  const chatVoiceRequest = useStore(chatVoiceModeRequest);
  const placementRequest = useStore(agentPlacementRequest);
  const turnTicker = useStore(chatTurnTicker);
  const messageQueues = useStore(chatMessageQueues);
  // Fully-done tickers close themselves: a short beat so the user sees the
  // final all-green state, then the box clears and disappears.
  const tickerAllDone = Boolean(turnTicker && turnTicker.items.length > 0 && turnTicker.items.every((item) => item.done));
  const tickerDismissTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const dismissedTickerRef = useRef<string | null>(null);
  useEffect(() => {
    if (!tickerAllDone || !turnTicker) {
      if (tickerDismissTimer.current) {
        clearTimeout(tickerDismissTimer.current);
        tickerDismissTimer.current = null;
      }
      return;
    }
    const key = `${turnTicker.threadId}:${turnTicker.items.length}:${turnTicker.items.filter((i) => i.done).length}:${turnTicker.items[0]?.label ?? ''}`;
    if (dismissedTickerRef.current === key) return; // already dismissing this exact list
    dismissedTickerRef.current = key;
    tickerDismissTimer.current = setTimeout(() => clearChatTurnTicker(), 1500);
    return () => {
      if (tickerDismissTimer.current) {
        clearTimeout(tickerDismissTimer.current);
        tickerDismissTimer.current = null;
      }
    };
  }, [tickerAllDone, turnTicker]);
  const [tickerCollapsed, setTickerCollapsed] = useState(false);
  useEffect(() => {
    // A new turn's plan starts collapsed again.
    setTickerCollapsed(false);
  }, [turnTicker?.threadId, turnTicker?.items.length === 0]);
  const [requestDraft, setRequestDraft] = useState('');
  const [editingMessageId, setEditingMessageId] = useState<string | null>(null);
  const [editingMessageDraft, setEditingMessageDraft] = useState('');
  const [attachments, setAttachments] = useState<ChatAttachment[]>([]);
  const [attachmentBusy, setAttachmentBusy] = useState(false);
  const [isComposerDragOver, setIsComposerDragOver] = useState(false);
  const [viewer, setViewer] = useState<{ images: ViewerImage[]; index: number } | null>(null);
  const [pendingSendCount, setPendingSendCount] = useState(0);
  const [answeringRequest, setAnsweringRequest] = useState(false);
  const answeringRequestRef = useRef(false);
  const [liveModelsByProvider, setLiveModelsByProvider] = useState<Record<string, AiModelOption[]>>({});
  const [loadingModelsFor, setLoadingModelsFor] = useState<string | null>(null);
  const [modelErrors, setModelErrors] = useState<Record<string, string>>({});
  const lastModelRefreshRef = useRef<Record<string, number>>({});
  // Providers whose last live fetch failed, with the failure timestamp. A
  // failed fetch must NOT be cached as an empty list: that both hides the
  // curated fallback distinction and blocks every later retry (the "Grok 4.6
  // never appears" class of bug). Instead the failure is remembered briefly
  // so a persistently failing provider doesn't refetch in a tight loop.
  const modelFailureAtRef = useRef<Record<string, number>>({});
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const editingTextareaRef = useRef<HTMLTextAreaElement | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const composerRef = useRef<HTMLFormElement | null>(null);
  const [voicePhase, setVoicePhase] = useState<RealtimeVoiceState | 'idle'>('idle');
  const voiceSessionRef = useRef<RealtimeVoiceSession | null>(null);
  const voiceActiveRef = useRef(false);
  // Voice exchanges stream into the THREAD so a conversation reads as "me
  // sending a message, it replying back" — not just a rolling strip line. These
  // refs keep that live mirror free of duplicates:
  // - `voiceThreadIdRef` pins the thread the call started on (the closure's
  //   `thread` can change if the user switches conversations mid-call).
  // - `voiceEchoUserRef` is the id of the live user row so an orchestrator
  //   turn can drop it before `sendChatMessage` records the real one.
  // - `awaitingVoiceCommandReplyRef` suppresses the spoken echo of a reply
  //   that `sendChatMessage` already recorded in the thread.
  const voiceThreadIdRef = useRef<string | null>(null);
  const voiceEchoUserRef = useRef<string | null>(null);
  const awaitingVoiceCommandReplyRef = useRef(false);

  const projectThreads = project ? threadState.threadsByProject[project.id] ?? [] : [];
  const activeThreadId = project ? threadState.activeThreadByProject[project.id] ?? null : null;
  const thread = projectThreads.find((entry) => entry.id === activeThreadId) ?? projectThreads[0] ?? null;
  const messages = thread ? threadState.messagesByThread[thread.id] ?? [] : [];
  // What is waiting to run in this thread: rendered as the queue strip above
  // the composer, with per-row steer/remove.
  const queuedMessages = (thread ? messageQueues[thread.id] ?? [] : []) as QueuedChatMessage[];
  const pendingRequestMessage = useMemo(
    () => [...messages].reverse().find((message) =>
      (message.type === 'approval' || message.type === 'input') &&
      message.inlineRequest && !message.inlineRequest.answeredAt,
    ) ?? null,
    [messages],
  );
  const boundTask = useMemo(() => {
    if (!thread?.taskId) return null;
    return allTasks.find((task) => task.id === thread.taskId) ?? null;
  }, [allTasks, thread?.taskId]);
  // A bound blocked task with no stored request card (e.g. the agent blocked
  // outside a chat-mode follow-up) still gets a composer banner: answering it
  // resumes the task via the thread-follow-up path.
  const derivedTaskRequest = useMemo<ChatInlineRequest | null>(() => {
    if (pendingRequestMessage || boundTask?.status !== 'blocked') return null;
    const reason = boundTask.blockedReason?.trim();
    const who = boundTask.name?.trim() || boundTask.agentPreset || 'The agent';
    return {
      id: `task-input-${boundTask.id}`,
      type: 'text',
      prompt: reason
        ? `${who} is waiting for your input: ${reason}`
        : `${who} is waiting for your input.`,
      taskId: boundTask.id,
      sessionId: boundTask.assignedSessionId ?? boundTask.lastSessionId ?? null,
    };
  }, [pendingRequestMessage, boundTask]);
  const pendingRequest = pendingRequestMessage?.inlineRequest ?? derivedTaskRequest ?? null;
  const taskStalled = useMemo(() => {
    if (!boundTask || boundTask.status !== 'in-progress') return false;
    const signalAt = Math.max(
      boundTask.activity?.length ? boundTask.activity[boundTask.activity.length - 1].ts : 0,
      boundTask.promptSentAt ?? 0,
      boundTask.startedAt ?? 0,
      boundTask.createdAt ?? 0,
    );
    return Date.now() - signalAt > 10 * 60 * 1000;
  }, [boundTask]);
  const liveStatusText = pendingRequest
    ? 'Needs input'
    : boundTask
      ? liveTaskStatusLabel(boundTask.status, taskStalled)
      : statusLabel(thread?.status ?? 'idle');
  const liveStatusClass = pendingRequest || boundTask?.status === 'blocked' || thread?.status === 'needs-input'
    ? 'needs-input'
    : taskStalled
      ? 'stalled'
      : boundTask?.status === 'in-progress' || thread?.status === 'working'
        ? 'working'
        : boundTask?.status === 'failed' || thread?.status === 'failed'
          ? 'failed'
          : 'idle';
  const orchestratorProviders = useMemo(() => aiProviders.filter((entry) => entry.id !== 'local'), []);
  const providerIds = useMemo(() => new Set(orchestratorProviders.map((entry) => entry.id)), [orchestratorProviders]);
  const selectedProvider = thread?.provider && providerIds.has(thread.provider as AiProviderId)
    ? thread.provider as AiProviderId
    : providerIds.has(defaultProvider) ? defaultProvider : 'openrouter';
  const providerDef = getProviderDef(selectedProvider);
  const selectedModel = thread?.model?.trim()
    || (selectedProvider === defaultProvider ? defaultModel : modelByProvider[selectedProvider])
    || providerDef.defaultModel;
  const liveModels = liveModelsByProvider[selectedProvider] ?? [];
  // Only the levels this provider's API accepts for this model; a saved level
  // the new model lacks shows (and is sent) as the provider default.
  const reasoningLevels = reasoningLevelsFor(selectedProvider, selectedModel);
  const selectedReasoning: ChatReasoningEffort = thread?.reasoningEffort && reasoningLevels.includes(thread.reasoningEffort)
    ? thread.reasoningEffort
    : 'default';
  // A conversation keeps its saved model, so one the provider retired or now
  // lists as unsupported would fail every turn with no hint in the composer.
  // Only judged against a loaded live list: the curated fallback is not
  // authoritative about what the key can reach.
  const selectedLiveModel = liveModels.find((entry) => entry.id === selectedModel);
  const selectedModelIssue = !liveModels.length
    ? null
    : !selectedLiveModel
      ? `${providerDef.label} does not list "${selectedModel}" for this key. Choose another model.`
      : selectedLiveModel.supported === false
        ? selectedLiveModel.supportReason ?? `"${selectedModel}" cannot run as a chat model yet. Choose another model.`
        : null;
  const availableModels = useMemo(() => {
    const source = liveModels.length ? liveModels : providerDef.models;
    if (source.some((entry) => entry.id === selectedModel)) return source;
    return [{ id: selectedModel, label: selectedModel, description: 'Saved model for this conversation.' }, ...source];
  }, [liveModels, providerDef.models, selectedModel]);
  const accessMode: ChatAccessMode = thread?.accessMode === 'full-access' ? 'full-access' : 'inherit';
  const composerValue = thread?.draft ?? '';
  const chatPlacementRequest = project && thread && placementRequest?.source === 'orchestrator'
    && placementRequest.projectId === project.id && placementRequest.threadId === thread.id
    ? placementRequest
    : null;

  useLayoutEffect(() => {
    const textarea = textareaRef.current;
    if (!textarea) return;

    textarea.style.height = 'auto';
    const styles = window.getComputedStyle(textarea);
    const lineHeight = Number.parseFloat(styles.lineHeight) || 19;
    const verticalPadding = Number.parseFloat(styles.paddingTop) + Number.parseFloat(styles.paddingBottom);
    const minHeight = lineHeight + verticalPadding;
    const maxHeight = lineHeight * 5 + verticalPadding;
    const contentHeight = Math.max(textarea.scrollHeight, minHeight);

    textarea.style.height = `${Math.min(contentHeight, maxHeight)}px`;
    textarea.style.overflowY = contentHeight > maxHeight ? 'auto' : 'hidden';
  }, [composerValue, thread?.id]);

  // The edit box starts as a single line and grows with its content (same
  // auto-size pattern as the composer), so short edits stay compact and long
  // ones expand up to the cap instead of scrolling immediately.
  useLayoutEffect(() => {
    const textarea = editingTextareaRef.current;
    if (!textarea || !editingMessageId) return;

    textarea.style.height = 'auto';
    const styles = window.getComputedStyle(textarea);
    const lineHeight = Number.parseFloat(styles.lineHeight) || 18;
    const verticalPadding = Number.parseFloat(styles.paddingTop) + Number.parseFloat(styles.paddingBottom);
    const minHeight = lineHeight + verticalPadding;
    const maxHeight = 180;
    const contentHeight = Math.max(textarea.scrollHeight, minHeight);

    textarea.style.height = `${Math.min(contentHeight, maxHeight)}px`;
    textarea.style.overflowY = contentHeight > maxHeight ? 'auto' : 'hidden';
  }, [editingMessageDraft, editingMessageId]);

  const ensureLiveModels = useCallback((provider: AiProviderId, force = false) => {
    if (provider === 'local') return;
    if (!force && Object.prototype.hasOwnProperty.call(liveModelsByProvider, provider)) return;
    if (!force && Date.now() - (modelFailureAtRef.current[provider] ?? 0) < MODEL_REFRESH_COOLDOWN_MS) return;
    if (loadingModelsFor === provider) return;
    setLoadingModelsFor(provider);
    void listProviderModels(provider, 'chat')
      .then((models) => {
        if (models.length === 0) {
          throw new Error(`${getProviderDef(provider).label} returned no usable chat models.`);
        }
        delete modelFailureAtRef.current[provider];
        setLiveModelsByProvider((current) => ({ ...current, [provider]: models }));
        setModelErrors((current) => {
          const next = { ...current };
          delete next[provider];
          return next;
        });
      })
      .catch((error) => {
        modelFailureAtRef.current[provider] = Date.now();
        // Leave any previous good list in place and never cache the failure
        // as an empty list — the picker falls back to the curated catalogue
        // and the error surfaces as a retry affordance instead.
        console.warn(`[chat] Could not load live models for ${provider}:`, error);
        setModelErrors((current) => ({ ...current, [provider]: error instanceof Error ? error.message : String(error) }));
      })
      .finally(() => setLoadingModelsFor((current) => current === provider ? null : current));
  }, [liveModelsByProvider, loadingModelsFor]);

  const refreshLiveModels = useCallback((provider: AiProviderId) => {
    const now = Date.now();
    if (now - (lastModelRefreshRef.current[provider] ?? 0) < MODEL_REFRESH_COOLDOWN_MS) return;
    lastModelRefreshRef.current[provider] = now;
    ensureLiveModels(provider, true);
  }, [ensureLiveModels]);

  useEffect(() => {
    if (project) ensureProjectThread(project.id);
  }, [project?.id]);

  useEffect(() => {
    setEditingMessageId(null);
    setEditingMessageDraft('');
  }, [thread?.id]);

  useEffect(() => {
    ensureLiveModels(selectedProvider);
  }, [ensureLiveModels, selectedProvider]);

  // Interrupted-work detection: a stale execution checkpoint (no live brain
  // turn) offers to resume in the thread. Re-checked whenever the thread or
  // its checkpoint changes — resume/dismiss both clear the card by updating
  // the checkpoint.
  const [resumable, setResumable] = useState(false);
  useEffect(() => {
    if (!thread?.id) {
      setResumable(false);
      return;
    }
    let cancelled = false;
    const check = () => {
      if (!cancelled) setResumable(hasResumableTurn(thread.id));
    };
    check();
    const interval = window.setInterval(check, 1500);
    return () => {
      cancelled = true;
      window.clearInterval(interval);
    };
  }, [thread?.id, thread?.agentCheckpoint]);

  async function resumeInterrupted() {
    if (!project || !thread || pendingSendCount > 0) return;
    setPendingSendCount((count) => count + 1);
    setResumable(false);
    try {
      await resumeOrchestratorTurn(project.id, project.root_path, thread.id, {
        projectName: project.name,
        orchestratorProvider: selectedProvider,
        orchestratorModel: selectedModel,
        accessMode,
        chatMode: true,
        conversationalMode: true,
      });
    } finally {
      setPendingSendCount((count) => Math.max(0, count - 1));
      setResumable(hasResumableTurn(thread.id));
    }
  }

  function dismissInterrupted() {
    if (!thread) return;
    dismissResumableTurn(thread.id);
    setResumable(false);
  }

  useEffect(() => {
    const refresh = () => refreshLiveModels(selectedProvider);
    const interval = window.setInterval(refresh, MODEL_REFRESH_INTERVAL_MS);
    return () => window.clearInterval(interval);
  }, [refreshLiveModels, selectedProvider]);

  useEffect(() => {
    if (!thread || (thread.provider && thread.model)) return;
    updateChatThread(thread.id, {
      provider: selectedProvider,
      model: selectedModel,
      updatedAt: Date.now(),
    });
  }, [thread?.id, thread?.provider, thread?.model, selectedProvider, selectedModel]);

  useEffect(() => {
    const element = scrollRef.current;
    if (element) element.scrollTop = element.scrollHeight;
  }, [messages.length]);

  useEffect(() => {
    // Release the mic when the chat panel unmounts mid-call.
    return () => stopChatVoiceMode();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function selectProvider(nextValue: string) {
    if (!thread || !providerIds.has(nextValue as AiProviderId)) return;
    const nextProvider = nextValue as AiProviderId;
    const nextModel = modelByProvider[nextProvider] || getProviderDef(nextProvider).defaultModel;
    clearPendingNewThreadSettings(thread.projectId);
    updateChatThread(thread.id, { provider: nextProvider, model: nextModel, updatedAt: Date.now() });
    aiProvider.set(nextProvider);
    setAiModel(nextProvider, nextModel);
    ensureLiveModels(nextProvider);
  }

  function selectModel(nextModel: string, provider = selectedProvider) {
    if (!thread || !nextModel.trim()) return;
    clearPendingNewThreadSettings(thread.projectId);
    updateChatThread(thread.id, { model: nextModel, updatedAt: Date.now() });
    aiProvider.set(provider);
    setAiModel(provider, nextModel);
  }

  function selectAccess(nextAccess: string) {
    if (!thread) return;
    updateChatThread(thread.id, {
      accessMode: nextAccess === 'full-access' ? 'full-access' : 'inherit',
      updatedAt: Date.now(),
    });
  }

  function updateDraft(value: string) {
    if (thread) setThreadDraft(thread.id, value);
  }

  function beginEditMessage(message: ChatMessage) {
    if (message.role !== 'user') return;
    setEditingMessageId(message.id);
    setEditingMessageDraft(message.text);
  }

  function cancelEditMessage() {
    setEditingMessageId(null);
    setEditingMessageDraft('');
  }

  // Resend overwrites in place: the edited bubble keeps its position, the
  // stale reply (and any later turns built on it) is discarded atomically
  // with the fresh turn's appends, so the new summary replaces the previous
  // one without the transcript flashing an intermediate state.
  async function resendEditedMessage() {
    if (!project || !thread || !editingMessageId) return;
    const original = messages.find((entry) => entry.id === editingMessageId);
    const nextText = editingMessageDraft.trim();
    if (!nextText) {
      showToast('A message cannot be empty', 'warning');
      return;
    }
    if (original && nextText === original.text.trim()) {
      showToast('Edit the message before resending', 'warning');
      return;
    }
    const messageId = editingMessageId;
    cancelEditMessage();
    setPendingSendCount((count) => count + 1);
    try {
      const result = await resendEditedChatMessage(project.id, project.root_path, thread.id, messageId, nextText, {
        projectName: project.name,
        orchestratorProvider: selectedProvider,
        orchestratorModel: selectedModel,
        accessMode,
        chatMode: true,
        conversationalMode: true,
      });
      if (!result) {
        showToast('Could not resend that message', 'warning');
        return;
      }
      if (result.removedLaterCount > 0) {
        showToast(
          result.removedLaterCount === 1
            ? 'Resent: 1 later message removed'
            : `Resent: ${result.removedLaterCount} later messages removed`,
          'info',
          2600,
        );
      }
    } finally {
      setPendingSendCount((count) => Math.max(0, count - 1));
    }
  }

  async function copyMessage(message: ChatMessage) {
    try {
      await copyTextToClipboard(message.text);
      showToast('Message copied', 'success', 1800);
    } catch {
      showToast('Could not copy message', 'warning');
    }
  }

  function revokeAttachmentPreviews(list: ChatAttachment[]) {
    for (const entry of list) {
      if (entry.previewUrl) {
        try { URL.revokeObjectURL(entry.previewUrl); } catch { /* already revoked */ }
      }
    }
  }

  function startNewThread() {
    if (!project) return;
    const pendingSettings = getPendingNewThreadSettings(project.id);
    createChatThread(project.id, {
      provider: pendingSettings?.provider ?? selectedProvider,
      model: pendingSettings?.model ?? selectedModel,
      accessMode,
    });
    setAttachments((current) => {
      revokeAttachmentPreviews(current);
      return [];
    });
    setRequestDraft('');
  }

  async function answerPendingRequest(answer: string) {
    const text = answer.trim();
    if (!project || !thread || !text || answeringRequestRef.current) return;
    answeringRequestRef.current = true;
    setAnsweringRequest(true);
    try {
      await sendChatMessage(project.id, project.root_path, text, {
      projectName: project.name,
      threadId: thread.id,
      orchestratorProvider: selectedProvider,
      orchestratorModel: selectedModel,
      accessMode,
      chatMode: true,
      conversationalMode: true,
      });
      setRequestDraft('');
    } finally {
      answeringRequestRef.current = false;
      setAnsweringRequest(false);
    }
  }

  async function handleFiles(files: FileList | null) {
    if (!files?.length) return;
    setAttachmentBusy(true);
    try {
      const next: ChatAttachment[] = [];
      for (const file of Array.from(files).slice(0, 5)) {
        if (file.size > MAX_ATTACHMENT_BYTES) continue;
        next.push(await toChatAttachment(file));
      }
      setAttachments((current) => [...current, ...next].slice(0, 5));
    } finally {
      setAttachmentBusy(false);
      if (fileInputRef.current) fileInputRef.current.value = '';
    }
  }

  function removeAttachment(id: string) {
    setAttachments((current) => {
      const removed = current.find((entry) => entry.id === id);
      if (removed?.previewUrl) {
        try { URL.revokeObjectURL(removed.previewUrl); } catch { /* already revoked */ }
      }
      return current.filter((entry) => entry.id !== id);
    });
  }

  // Attach on-disk paths (OS file drops, in-app explorer drags). Images get a
  // thumbnail via fs_read_binary so they render and preview like pasted ones;
  // text-likes are inlined so the model sees them without opening the file.
  async function handleDroppedPaths(paths: string[]) {
    const cleaned = paths.map((p) => p.trim()).filter(Boolean).slice(0, 5);
    if (!cleaned.length) return;
    setAttachmentBusy(true);
    try {
      const next: ChatAttachment[] = [];
      for (const rawPath of cleaned) {
        const path = rawPath.replace(/\\/g, '/');
        const name = path.split('/').pop() || path;
        if (isImagePath(path)) {
          try {
            const bytes = await invoke<number[]>('fs_read_binary', { path });
            const mimeType = getImageMimeType(path);
            const blob = new Blob([new Uint8Array(bytes)], { type: mimeType });
            next.push({
              id: `attachment-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
              name,
              type: mimeType,
              size: bytes.length,
              path,
              previewUrl: URL.createObjectURL(blob),
            });
          } catch {
            next.push({
              id: `attachment-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
              name,
              type: getImageMimeType(path),
              size: 0,
              path,
            });
          }
        } else {
          try {
            const text = await invoke<string>('fs_read_file', { path });
            next.push({
              id: `attachment-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
              name,
              type: 'text/plain',
              size: text.length,
              text: text.length > MAX_ATTACHMENT_TEXT
                ? `${text.slice(0, MAX_ATTACHMENT_TEXT)}\n\n[Attachment truncated at ${MAX_ATTACHMENT_TEXT.toLocaleString()} characters.]`
                : text,
            });
          } catch {
            next.push({
              id: `attachment-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
              name,
              type: 'application/octet-stream',
              size: 0,
              path,
            });
          }
        }
      }
      setAttachments((current) => [...current, ...next].slice(0, 5));
    } finally {
      setAttachmentBusy(false);
    }
  }

  function isEventOverComposer(clientX: number, clientY: number): boolean {
    const el = composerRef.current;
    if (!el || typeof document === 'undefined') return false;
    const rect = el.getBoundingClientRect();
    return clientX >= rect.left && clientX <= rect.right && clientY >= rect.top && clientY <= rect.bottom;
  }

  function toggleDictation() {
    if (!project) return;
    if (transcriptionPhase === 'listening') {
      // Tap-tap gesture, same as the hotkey: the button that started the
      // dictation ends it and pastes instead of discarding.
      sendTranscriptionNow();
      return;
    }
    if (transcriptionPhase === 'processing') return;
    // Aim at the composer before the capture starts, so the mic button never
    // has to steal focus mid-dictation to claim the transcript.
    textareaRef.current?.focus();
    toggleChatModeTranscription();
  }

  const voiceActive = voicePhase !== 'idle';
  const voiceStatusClass = voicePhase === 'speaking'
    ? 'speaking'
    : voicePhase === 'listening'
      ? 'listening'
      : 'thinking';
  const voiceStatusLabel = voicePhase === 'speaking'
    ? 'Speaking'
    : voicePhase === 'listening'
      ? 'Listening'
      : 'Thinking';

  // The composer's own dictation indicator. `transcriptionActive` tells the
  // truth from the very first beat — the microsecond the hotkey/button commits
  // to a capture, before `transcriptionState` leaves 'idle' (the mic-opening
  // gap is exactly where F9 used to look dead). `transcriptionTarget` then
  // decides whether this surface is the right one to say it: in conversational
  // mode the strip reports when the capture feeds the chat composer (or a text
  // field here) — and the CLI pill stays in CLI mode.
  const dictationLive =
    transcriptionActiveValue &&
    (transcriptionTargetValue?.kind === 'chat' || transcriptionTargetValue?.kind === 'field');
  const dictationRetargetLabel =
    transcriptionTargetValue?.kind === 'field'
      ? `Listening · dictating into ${transcriptionTargetValue.label}`
      : 'Listening · dictating a chat message';
  const dictationWaitingForMic = dictationLive && transcriptionPhase === 'idle';
  const dictationLabel = dictationWaitingForMic
    ? 'Listening…'
    : transcriptionPhase === 'listening'
      ? dictationRetargetLabel
      : 'Transcribing…';
  const dictationSpectrumPhase: SpectrumPhase = transcriptionPhase === 'listening'
    ? 'listening'
    : transcriptionPhase === 'processing'
      ? 'thinking'
      : 'connecting';

  // Runs one orchestrator turn from a live voice call and returns the brain's
  // reply so the realtime model can speak it. Same path as CLI voice mode, but
  // routed into the open chat thread so the exchange lands in the transcript.
  async function runOrchestratorVoice(request: string): Promise<string> {
    if (!project) return 'No project is open right now.';
    // The live echo of this utterance ("You: …") is superseded by the turn's
    // own rows — sendChatMessage appends the real user message and streams the
    // real reply into the thread. Drop the echo so the turn reads once.
    const echoId = voiceEchoUserRef.current;
    voiceEchoUserRef.current = null;
    if (echoId && voiceThreadIdRef.current) {
      removeThreadMessage(voiceThreadIdRef.current, echoId);
    }
    try {
      await sendChatMessage(project.id, project.root_path, request, {
        projectName: project.name,
        threadId: thread?.id,
        orchestratorProvider: selectedProvider,
        orchestratorModel: selectedModel,
        accessMode,
        voiceConversation: true,
        conversationalMode: true,
      });
      // The turn's real reply is already in the thread now — suppress the
      // spoken echo of it in onAssistantTranscript so it does not read twice.
      // Cleared one-shot when that echo arrives (or on session teardown).
      awaitingVoiceCommandReplyRef.current = true;
    } catch (error) {
      console.error('Voice orchestrator turn failed:', error);
    }
    const threadId = voiceThreadIdRef.current;
    if (!threadId) return 'The orchestrator accepted the request.';
    const threadMessages = get(chatThreadState).messagesByThread[threadId] ?? [];
    for (let i = threadMessages.length - 1; i >= 0; i -= 1) {
      const message = threadMessages[i];
      if (message.role === 'assistant' && !message.pending && message.text?.trim()) {
        return message.text.trim();
      }
      if (message.role === 'user') break;
    }
    return 'The orchestrator accepted the request.';
  }

  function resetVoiceThreadRefs() {
    voiceEchoUserRef.current = null;
    awaitingVoiceCommandReplyRef.current = false;
    voiceThreadIdRef.current = null;
  }

  /** Stream one side of a live voice exchange into the open chat thread. */
  function appendVoiceThreadMessage(role: 'user' | 'assistant', text: string): string | null {
    const threadId = voiceThreadIdRef.current;
    if (!threadId) return null;
    const id = `voice-${role}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    appendThreadMessage({
      id,
      threadId,
      type: role === 'user' ? 'user' : 'agent',
      role,
      text,
      ts: Date.now(),
    });
    return id;
  }

  async function startChatVoiceMode() {
    if (!project || !thread) return;
    voiceThreadIdRef.current = thread.id;
    const engine = get(voiceConversationEngine);
    const provider: RealtimeVoiceProvider =
      engine === 'xai-realtime' ? 'xai' : engine === 'openai-live' ? 'openai-live' : 'openai';
    const label = provider === 'xai' ? 'Grok Realtime' : provider === 'openai-live' ? 'GPT Live' : 'GPT Realtime';
    const keyProvider = provider === 'xai' ? 'xai' : 'openai';
    if (!isRealtimeVoiceSupported(provider)) {
      showToast(
        `${label} voice isn't supported in this runtime. Try the other realtime engine in Settings → Voice, or the dictate button to speak text instead.`,
        'warning',
      );
      openSettings();
      return;
    }
    if (!isProviderApiKeyConfiguredLocal(keyProvider)) {
      showToast(
        `${label} needs an ${keyProvider === 'xai' ? 'xAI' : 'OpenAI'} API key. Add it in Settings, or switch the conversation engine.`,
        'warning',
      );
      openSettings();
      return;
    }
    // Tear down any lingering session from a previous attempt so its onEnded
    // callback can't fire on this new session's state.
    const prevSession = voiceSessionRef.current;
    voiceSessionRef.current = null;
    if (prevSession) {
      try {
        prevSession.stop();
      } catch {
        /* already stopped */
      }
    }
    voiceActiveRef.current = true;
    setVoicePhase('connecting');
    try {
      const session = await startRealtimeVoiceSession({
        provider,
        model: get(provider === 'xai' ? xaiRealtimeModel : provider === 'openai-live' ? openaiLiveModel : openaiRealtimeModel),
        voice: get(provider === 'xai' ? xaiRealtimeVoice : provider === 'openai-live' ? openaiLiveVoice : openaiRealtimeVoice),
        instructions: REALTIME_VOICE_INSTRUCTIONS,
        callbacks: {
          onStateChange: (state) => {
            if (!voiceActiveRef.current) return;
            setVoicePhase(state);
          },
          onUserTranscript: (text) => {
            const clean = text.trim();
            if (!clean || !voiceActiveRef.current) return;
            // Stream the utterance into the thread as a real message so the
            // voice conversation reads as me → it.
            voiceEchoUserRef.current = appendVoiceThreadMessage('user', clean);
          },
          onAssistantTranscript: (text, final) => {
            const clean = text.trim();
            if (!clean || !voiceActiveRef.current) return;
            if (!final) return;
            if (awaitingVoiceCommandReplyRef.current) {
              // The real reply was already recorded in the thread by
              // sendChatMessage — this is its spoken echo, so skip the copy.
              awaitingVoiceCommandReplyRef.current = false;
              return;
            }
            appendVoiceThreadMessage('assistant', clean);
          },
          onOrchestratorCommand: (request) => runOrchestratorVoice(request),
          onError: (message) => showToast(message, 'error'),
          onEnded: () => {
            // Fires for a spontaneous transport failure as well as stop(). A
            // user-initiated stop already nulled the ref, so this only acts
            // when the connection died on its own.
            if (voiceSessionRef.current) {
              voiceSessionRef.current = null;
              voiceActiveRef.current = false;
              resetVoiceThreadRefs();
              setVoicePhase('idle');
            }
          },
        },
      });
      if (!voiceActiveRef.current) {
        // The user exited voice mode while the call was still connecting.
        resetVoiceThreadRefs();
        session.stop();
        return;
      }
      voiceSessionRef.current = session;
    } catch (error) {
      voiceActiveRef.current = false;
      setVoicePhase('idle');
      showToast(
        error instanceof Error ? error.message : `Could not start ${label} voice.`,
        'error',
      );
    }
  }

  function stopChatVoiceMode() {
    if (!voiceActiveRef.current) return;
    voiceActiveRef.current = false;
    resetVoiceThreadRefs();
    setVoicePhase('idle');
    const session = voiceSessionRef.current;
    voiceSessionRef.current = null;
    session?.stop();
  }

  function toggleChatVoiceMode() {
    if (voiceActiveRef.current) stopChatVoiceMode();
    else void startChatVoiceMode();
  }

  // The floating bar owns the bare-Alt gesture globally; in conversational
  // mode it routes the tap here instead of opening its own (hidden) call.
  // Consume the counter so Alt toggles the composer's voice session.
  const lastChatVoiceRequestRef = useRef(0);
  useEffect(() => {
    if (chatVoiceRequest === lastChatVoiceRequestRef.current) return;
    lastChatVoiceRequestRef.current = chatVoiceRequest;
    if (chatVoiceRequest > 0) toggleChatVoiceMode();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [chatVoiceRequest]);

  // Escape ends a live chat voice call the same way it ends the CLI bar's.
  // Registered only while the call is up so it can't swallow Escape elsewhere.
  useEffect(() => {
    if (!voiceActive || typeof document === 'undefined') return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      event.preventDefault();
      event.stopPropagation();
      stopChatVoiceMode();
    };
    document.addEventListener('keydown', onKeyDown, true);
    return () => document.removeEventListener('keydown', onKeyDown, true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [voiceActive]);

  async function handlePaste(event: React.ClipboardEvent<HTMLTextAreaElement>) {
    const items = Array.from(event.clipboardData.items).filter((item) => item.type.startsWith('image/'));
    const files = Array.from(event.clipboardData.files).filter((file) => file.type.startsWith('image/'));
    if (!items.length && !files.length) return;
    event.preventDefault();
    setAttachmentBusy(true);
    try {
      const next: ChatAttachment[] = [];
      for (const file of files.slice(0, 5)) {
        if (file.size > MAX_ATTACHMENT_BYTES) continue;
        next.push(await toChatAttachment(file));
      }
      for (const item of items.slice(0, 5)) {
        const file = item.getAsFile();
        if (!file) continue;
        if (file.size > MAX_ATTACHMENT_BYTES) continue;
        next.push(await toChatAttachment(new File([file], `pasted-image-${Date.now()}.png`, { type: file.type || 'image/png' })));
      }
      if (next.length) setAttachments((current) => [...current, ...next].slice(0, 5));
    } finally {
      setAttachmentBusy(false);
    }
  }

  // HTML5 drag-and-drop of real files (browser dev sessions, and file-manager
  // drags where the webview still delivers File objects). In Tauri the OS
  // passes absolute paths instead — handled by the onDragDropEvent effect
  // below — so this only acts when Files are present.
  function handleComposerDragOver(event: React.DragEvent) {
    if (Array.from(event.dataTransfer?.types ?? []).includes('Files')) {
      event.preventDefault();
      event.dataTransfer.dropEffect = 'copy';
      setIsComposerDragOver(true);
    }
  }

  function handleComposerDragLeave(event: React.DragEvent) {
    if (event.currentTarget === event.target) setIsComposerDragOver(false);
  }

  async function handleComposerDrop(event: React.DragEvent) {
    const files = event.dataTransfer?.files;
    // Path drags from the in-app explorer carry no Files — let the explorer
    // effect below own those so they aren't swallowed here.
    const pathHint =
      event.dataTransfer?.getData('application/x-spacron-path')?.trim() ||
      event.dataTransfer?.getData('text/plain')?.trim() ||
      null;
    if ((!files || files.length === 0) && pathHint) {
      setIsComposerDragOver(false);
      void handleDroppedPaths([pathHint]);
      return;
    }
    if (!files || files.length === 0) {
      setIsComposerDragOver(false);
      return;
    }
    event.preventDefault();
    event.stopPropagation();
    setIsComposerDragOver(false);
    await handleFiles(files);
  }

  // OS file-manager drops (Tauri intercepts before HTML5 events reach the
  // webview) plus in-app explorer drags (custom pointer events carrying a
  // project path). Both hit-test against the composer so drops elsewhere on
  // the page don't attach.
  useEffect(() => {
    if (typeof document === 'undefined') return;
    const onExplorerEnd = (event: Event) => {
      const custom = event as CustomEvent<{ path?: string; clientX?: number; clientY?: number }>;
      const path = custom.detail?.path?.trim();
      if (!path) return;
      const cx = custom.detail?.clientX;
      const cy = custom.detail?.clientY;
      if (typeof cx !== 'number' || typeof cy !== 'number') return;
      if (!isEventOverComposer(cx, cy)) return;
      void handleDroppedPaths([path]);
    };
    window.addEventListener('spacron-explorer-drag-end', onExplorerEnd as EventListener);
    return () => window.removeEventListener('spacron-explorer-drag-end', onExplorerEnd as EventListener);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (!isTauriRuntime()) return;
    let unlisten: (() => void) | undefined;
    getCurrentWindow().onDragDropEvent((event) => {
      const type = event.payload.type;
      if (type === 'enter' || type === 'over') {
        const pos = (event.payload as unknown as { position: { x: number; y: number } }).position;
        void dropPositionToCss(pos).then((css) => {
          if (!css) return;
          setIsComposerDragOver(isEventOverComposer(css.x, css.y));
        });
        return;
      }
      if (type === 'leave') {
        setIsComposerDragOver(false);
        return;
      }
      if (type === 'drop') {
        const payload = event.payload as unknown as { paths?: string[]; position: { x: number; y: number } };
        const paths: string[] = payload.paths ?? [];
        if (!paths.length) {
          setIsComposerDragOver(false);
          return;
        }
        void dropPositionToCss(payload.position).then((css) => {
          setIsComposerDragOver(false);
          if (!css || !isEventOverComposer(css.x, css.y)) return;
          void handleDroppedPaths(paths);
        });
      }
    }).then((u) => { unlisten = u; });
    return () => { unlisten?.(); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Revoke thumbnail object URLs on unmount so repeated attaches don't leak.
  useEffect(() => {
    return () => {
      setAttachments((current) => {
        for (const entry of current) {
          if (entry.previewUrl) {
            try { URL.revokeObjectURL(entry.previewUrl); } catch { /* already revoked */ }
          }
        }
        return [];
      });
    };
  }, []);

  // Every image in the thread, oldest first, so the viewer can step through them.
  const threadImages = useMemo(() => messages.flatMap((message) => (message.attachments ?? [])
    .map((attachment) => ({ id: attachment.id, image: attachmentViewerImage(attachment) }))
    .filter((entry): entry is { id: string; image: ViewerImage } => entry.image !== null)), [messages]);

  function openThreadImage(attachmentId: string) {
    const index = threadImages.findIndex((entry) => entry.id === attachmentId);
    if (index >= 0) setViewer({ images: threadImages.map((entry) => entry.image), index });
  }

  // A project's generations folder is outside the asset scope granted at
  // startup; re-grant it per project so saved images and videos load.
  useEffect(() => {
    const root = project?.root_path;
    if (!root || !isTauriRuntime()) return;
    void invoke('allow_generations_dir', { projectRoot: root }).catch(() => {});
  }, [project?.root_path]);

  // The viewer's Edit: runs straight away and lands in this thread.
  function editImage(image: ViewerImage, prompt: string, markPath?: string) {
    if (!project || !image.path) return;
    void editImageInThread({
      projectId: project.id,
      rootPath: project.root_path,
      threadId: thread?.id,
      imagePath: image.path,
      imageName: image.name,
      markPath,
      prompt,
    });
  }

  // "Use as input": the image rides the next message as an attachment, which
  // is how the brain learns its path for generate_image's reference_images.
  function useImageAsInput(image: ViewerImage) {
    if (!image.path) return;
    const path = image.path;
    setAttachments((current) => current.some((entry) => entry.path === path) ? current : [...current, {
      id: `attachment-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      name: image.name,
      type: getImageMimeType(path) || 'image/png',
      size: 0,
      path,
      previewUrl: image.src,
    }]);
  }

  async function submit() {
    if (pendingRequest) {
      await answerPendingRequest(requestDraft);
      return;
    }
    const text = thread?.draft.trim() || (attachments.length ? 'Please review the attached files.' : '');
    if (!project || !thread || !text || pendingSendCount > 0) return;
    // previewUrl is a live blob: URL for thumbnails only — strip it before the
    // attachments are recorded, then revoke so the blobs don't leak.
    const messageAttachments = attachments.map(({ previewUrl: _preview, ...rest }) => rest);
    revokeAttachmentPreviews(attachments);
    setThreadDraft(thread.id, '');
    setAttachments([]);
    setPendingSendCount((count) => count + 1);
    try {
      // Queue-aware send: while a turn is running the message waits its turn
      // instead of being refused; the queued list under the composer offers
      // "Send now" (steer: hand it to the running turn) and "×".
      await enqueueChatMessage(project.id, project.root_path, text, {
        projectName: project.name,
        threadId: thread.id,
        orchestratorProvider: selectedProvider,
        orchestratorModel: selectedModel,
        accessMode,
        chatMode: true,
        conversationalMode: true,
        attachments: messageAttachments,
      });
    } finally {
      setPendingSendCount((count) => Math.max(0, count - 1));
    }
  }

  return (
    <section className={`chat-mode-panel${messages.length === 0 ? ' empty' : ''}`} aria-label="Chat">
      <div className="chat-mode-room-header">
        <div className="chat-mode-room-title">
          <span className="chat-mode-room-icon" aria-hidden="true"><VoiceModeIcon /></span>
          <span className="chat-mode-room-kind">Chat</span>
          <strong>{thread?.title ?? 'Conversation'}</strong>
          {/* Chat-level activity only ("Working", "Idle", "Needs input") — never a
              single agent's name. The thread can drive several agents at once,
              so naming one here reads as "that agent is working" and hides
              the rest. Per-agent state lives on the agent cards/panes. */}
          <span className={`chat-mode-live-status ${liveStatusClass}`} aria-live="polite">{liveStatusText}</span>
        </div>
        <div className="chat-mode-room-actions">
          {project && <button type="button" onClick={startNewThread}>New conversation</button>}
        </div>
      </div>

      <div className={`chat-mode-content-stack${messages.length === 0 ? ' is-empty' : ''}`}>
        <div className={`chat-mode-body${messages.length === 0 ? ' is-empty' : ''}`}>
          <div ref={scrollRef} className={`chat-mode-transcript${messages.length === 0 ? ' is-empty' : ''}`} aria-live="polite">
            {resumable && (
              <div className="chat-mode-resume-card" role="status" aria-label="Saved interrupted work">
                <span className="chat-mode-resume-icon" aria-hidden="true">↻</span>
                <div className="chat-mode-resume-copy">
                  <strong>Saved work is ready to continue</strong>
                  <span>Your previous turn stopped before finishing. Its execution state is still intact.</span>
                </div>
                <div className="chat-mode-resume-actions">
                  <button type="button" className="primary" onClick={() => void resumeInterrupted()} disabled={pendingSendCount > 0}>Resume work</button>
                  <button type="button" onClick={dismissInterrupted} disabled={pendingSendCount > 0}>Dismiss</button>
                </div>
              </div>
            )}
            {messages.length === 0 ? (
              <div className="chat-mode-empty">
                <h2 className="chat-mode-empty-heading">{projectName ? `What should we work on in ${projectName}?` : 'What should we work on?'}</h2>
              </div>
            ) : messages.map((message, messageIndex) => {
              if (message.type === 'completion') {
                return (
                  <div key={message.id} className="chat-mode-inline-card completion">
                    <span>Completed</span>
                    <MessageBody text={message.text} />
                  </div>
                );
              }
              if (message.type === 'activity') {
                // Tool calls are appended consecutively for one orchestrator
                // turn. Render that run as one compact disclosure instead of a
                // full transcript card for every read/search operation. The
                // disclosure is attached to the adjacent assistant response;
                // keep this branch only for legacy/orphaned activity records.
                if (activityRunBelongsToAssistant(messages, messageIndex)) return null;
                if (messageIndex > 0 && messages[messageIndex - 1]?.type === 'activity') return null;
                const activities: ChatMessage[] = [];
                for (let index = messageIndex; index < messages.length; index += 1) {
                  const activity = messages[index];
                  if (!activity || activity.type !== 'activity') break;
                  activities.push(activity);
                }
                return <ActivityDisclosure key={`activity-${message.id}`} activities={activities} />;
              }

              const attachedActivities = message.role === 'assistant'
                ? adjacentActivities(messages, messageIndex)
                : [];
              return (
                <article key={message.id} className={`chat-mode-message ${message.role}`}>
                  {attachedActivities.length > 0 && (
                    <ActivityDisclosure activities={attachedActivities} />
                  )}
                  <div className="chat-mode-message-meta">
                    <strong>{messageLabel(message)}</strong>
                    <time>{formatTime(message.ts)}</time>
                  </div>
                  {editingMessageId === message.id ? (
                    <div className="chat-mode-message-editing">
                      <textarea
                        ref={editingTextareaRef}
                        value={editingMessageDraft}
                        rows={1}
                        onChange={(event) => setEditingMessageDraft(event.target.value)}
                        aria-label="Edit message"
                        autoFocus
                      />
                      <div className="chat-mode-message-edit-actions">
                        <button type="button" onClick={cancelEditMessage}>Cancel</button>
                        {editingMessageDraft.trim() !== message.text.trim() && (
                          <button
                            type="button"
                            className="primary"
                            onClick={() => void resendEditedMessage()}
                            disabled={!editingMessageDraft.trim() || pendingSendCount > 0}
                            title="Send this edited message again"
                            aria-label="Resend edited message"
                          >
                            {pendingSendCount > 0 ? 'Resending…' : 'Resend'}
                          </button>
                        )}
                      </div>
                    </div>
                  ) : <ChatMarkdownBody text={message.text} pending={message.pending} />}
                  <InlineCard
                    message={message}
                    onOption={message.id === pendingRequestMessage?.id ? (option) => void answerPendingRequest(option) : undefined}
                  />
                  {message.attachments?.length ? (
                    <div className="chat-mode-message-attachments">
                      {message.attachments.map((attachment) => {
                        if (attachment.type.startsWith('video/') && attachment.path && isTauriRuntime()) {
                          return (
                            <div key={attachment.id} className="chat-mode-generated-video">
                              <video src={convertFileSrc(attachment.path)} controls preload="metadata" />
                              <button type="button" onClick={() => void invoke('reveal_image', { path: attachment.path, projectRoot: project?.root_path ?? null }).catch(() => {})} title={attachment.path}>
                                Show in folder
                              </button>
                            </div>
                          );
                        }
                        const image = attachmentViewerImage(attachment);
                        if (image && attachment.generated) {
                          return (
                            <button key={attachment.id} type="button" className="chat-mode-generated-image" onClick={() => openThreadImage(attachment.id)} title="Open in the image viewer">
                              <img src={image.src} alt={attachment.name} loading="lazy" />
                            </button>
                          );
                        }
                        if (image) {
                          return (
                            <button key={attachment.id} type="button" className="chat-mode-attachment-chip image" onClick={() => openThreadImage(attachment.id)} title={`${attachment.name}: click to open`}>
                              <img src={image.src} alt={attachment.name} className="chat-mode-attachment-thumb" loading="lazy" />
                              <span>{attachment.name}</span>{attachment.size > 0 && <small>{formatBytes(attachment.size)}</small>}
                            </button>
                          );
                        }
                        return (
                          <span key={attachment.id} className="chat-mode-attachment-chip">
                            {attachment.type.startsWith('image/') ? <ImageIcon /> : <PaperclipIcon />}
                            {attachment.name}<small>{formatBytes(attachment.size)}</small>
                          </span>
                        );
                      })}
                    </div>
                  ) : null}
                  {message.completion && (
                    <div className={`chat-mode-completion ${message.completion.status}`}>
                      <strong>{message.completion.taskTitle}</strong>
                      <span>{message.completion.summary || message.completion.reason || statusLabel(message.completion.status)}</span>
                    </div>
                  )}
                  {!message.pending && (
                    <div className="chat-mode-message-actions">
                      <button type="button" onClick={() => void copyMessage(message)} title="Copy message" aria-label="Copy message">
                        <CopyIcon />
                      </button>
                      {message.role === 'user' && (
                        <button type="button" onClick={() => beginEditMessage(message)} title="Edit message" aria-label="Edit message">
                          <EditIcon />
                        </button>
                      )}
                    </div>
                  )}
                </article>
              );
            })}
          </div>
        </div>

        <div className="chat-mode-composer-area">
          {turnTicker && turnTicker.threadId === thread?.id && turnTicker.items.length > 0 && (() => {
            return (
              <div className={`chat-mode-turn-ticker${tickerAllDone ? ' complete' : ''}${tickerCollapsed ? ' collapsed' : ''}`} role="status" aria-label="Turn plan progress">
                <div className="chat-mode-turn-ticker-head">
                  <button
                    type="button"
                    className="chat-mode-turn-ticker-collapse"
                    onClick={() => setTickerCollapsed((value) => !value)}
                    aria-expanded={!tickerCollapsed}
                    aria-label={tickerCollapsed ? 'Expand turn plan' : 'Collapse turn plan'}
                  >
                    <span className="chat-mode-turn-ticker-state">
                      {tickerAllDone ? 'Done' : 'Working plan'}
                    </span>
                    <span className="chat-mode-turn-ticker-strip">{tickerCollapsed ? 'Show checklist' : 'Hide checklist'}</span>
                  </button>
                  <span className="chat-mode-turn-ticker-count">
                    {todoProgress(turnTicker.items).completed}/{todoProgress(turnTicker.items).total}
                  </span>
                </div>
                {!tickerCollapsed && <ul className="chat-mode-turn-ticker-items">
                  {turnTicker.items.map((item, index) => (
                    <li key={`${turnTicker.threadId}-todo-${turnTicker.items.indexOf(item)}-${index}`} className={item.done ? 'done' : (item.status === 'blocked' || item.status === 'in_progress' ? item.status : '')}>
                      <span className="chat-mode-turn-ticker-check" aria-hidden="true">
                        {item.status === 'in_progress' ? '●' : item.status === 'blocked' ? '!' : item.status === 'cancelled' ? '−' : item.done ? '✓' : ''}
                      </span>
                      <span className="chat-mode-turn-ticker-label">{item.label}{item.reason ? ` (${item.reason})` : ''}</span>
                    </li>
                  ))}
                </ul>}
              </div>
            );
          })()}
          {queuedMessages.length > 0 && (
            <div className="chat-mode-message-queue" aria-label="Queued messages">
              <div className="chat-mode-message-queue-head">
                <span>{queuedMessages.length === 1 ? '1 queued message' : `${queuedMessages.length} queued messages`}</span>
              </div>
              {queuedMessages.map((queued) => (
                <div key={queued.id} className="chat-mode-message-queue-row">
                  <span className="chat-mode-message-queue-text" title={queued.text}>{queued.text}</span>
                  <button
                    type="button"
                    className="chat-mode-message-queue-btn"
                    title="Give this message to the running turn at its next step"
                    onClick={() => steerQueuedChatMessage(thread.id, queued.id)}
                  >
                    Send now
                  </button>
                  <button
                    type="button"
                    className="chat-mode-message-queue-btn"
                    title="Remove from queue"
                    aria-label="Remove queued message"
                    onClick={() => removeQueuedChatMessage(thread.id, queued.id)}
                  >
                    ×
                  </button>
                </div>
              ))}
            </div>
          )}
          {chatPlacementRequest && <ChatPlacementDialog request={chatPlacementRequest} />}
          {pendingRequest && (
            <ChatInputDialog
              request={pendingRequest}
              busy={answeringRequest}
              draft={requestDraft}
              onDraftChange={setRequestDraft}
              onAnswer={(answer) => void answerPendingRequest(answer)}
            />
          )}
          <form ref={composerRef} className={`chat-mode-composer${voiceActive ? ' voice-active' : ''}${isComposerDragOver ? ' drag-over' : ''}`} onSubmit={(event) => { event.preventDefault(); void submit(); }} onDragOver={handleComposerDragOver} onDragLeave={handleComposerDragLeave} onDrop={(event) => void handleComposerDrop(event)}>
          {isComposerDragOver && (
            <div className="chat-mode-drop-overlay" aria-hidden="true">
              Drop files to attach
            </div>
          )}
          {attachments.length > 0 && (
            <div className="chat-mode-attachment-list" aria-label="Attached files">
              {attachments.map((attachment) => (
                attachment.type.startsWith('image/') && attachment.previewUrl ? (
                  <span key={attachment.id} className="chat-mode-attachment-chip image" title={`${attachment.name}: click to preview`}>
                    <img
                      src={attachment.previewUrl}
                      alt={attachment.name}
                      className="chat-mode-attachment-thumb"
                      onClick={() => {
                        const images = attachments.map(attachmentViewerImage).filter((entry): entry is ViewerImage => entry !== null);
                        const index = images.findIndex((entry) => entry.src === attachment.previewUrl);
                        setViewer({ images, index: Math.max(0, index) });
                      }}
                    />
                    <span>{attachment.name}</span><small>{formatBytes(attachment.size)}</small>
                    <button type="button" onClick={() => removeAttachment(attachment.id)} aria-label={`Remove ${attachment.name}`}>×</button>
                  </span>
                ) : (
                  <span key={attachment.id} className="chat-mode-attachment-chip">
                    {attachment.type.startsWith('image/') ? <ImageIcon /> : <PaperclipIcon />}
                    <span>{attachment.name}</span><small>{formatBytes(attachment.size)}</small>
                    <button type="button" onClick={() => removeAttachment(attachment.id)} aria-label={`Remove ${attachment.name}`}>×</button>
                  </span>
                )
              ))}
            </div>
          )}
          <div className={`chat-mode-composer-input-shell${dictationLive ? ' is-dictating' : ''}${voiceActive ? ' is-voice-active' : ''}`}>
            <textarea
              ref={textareaRef}
              value={composerValue}
              rows={1}
              onChange={(event) => updateDraft(event.target.value)}
              onPaste={(event) => void handlePaste(event)}
              onKeyDown={(event) => {
                // Enter sends; Shift+Enter keeps the native newline behavior.
                // Ignore IME composition commits so East Asian input methods do
                // not submit a message while the candidate text is composing.
                if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing && event.keyCode !== 229) {
                  event.preventDefault();
                  void submit();
                }
              }}
              placeholder={pendingRequest ? 'Answer the request above…' : (project ? 'Talk to the orchestrator…' : 'Select a project first')}
              disabled={!project || Boolean(pendingRequest)}
              aria-label="Message the orchestrator"
            />
            {voiceActive && (
              <div className="chat-mode-composer-voice-stage" role="status" aria-label="Voice mode active">
                <div className="chat-mode-composer-voice-spectrum">
                  <SpectrumVisualizer
                    phase={voicePhase as SpectrumPhase}
                    barCount={32}
                    glow
                    height={36}
                  />
                </div>
                <span className={`chat-mode-composer-voice-status ${voiceStatusClass}`} aria-live="polite">
                  {voiceStatusLabel}
                </span>
              </div>
            )}
            {dictationLive && (
              <div className={`chat-mode-composer-transcription${transcriptionPhase === 'listening' ? ' listening' : ''}`} role="status">
                <SpectrumVisualizer
                  phase={dictationSpectrumPhase}
                  audioLevel={transcriptionLevelValue}
                  barCount={22}
                  glow={false}
                  height={24}
                />
                <span className="chat-mode-transcription-label">{dictationLabel}</span>
                {transcriptionWordCountValue > 0 && (
                  <span className="chat-mode-transcription-count">
                    {transcriptionWordCountValue} word{transcriptionWordCountValue === 1 ? '' : 's'}
                  </span>
                )}
                {transcriptionPhase === 'listening' && (
                  <span className="chat-mode-transcription-hint">
                    press the square button to finish · <kbd>Esc</kbd> to cancel
                  </span>
                )}
              </div>
            )}
          </div>
          <input ref={fileInputRef} className="chat-mode-file-input" type="file" multiple onChange={(event) => void handleFiles(event.target.files)} />
          <div className="chat-mode-composer-footer">
            <div className="chat-mode-composer-settings">
              <ChatAgentModelPicker
                agents={orchestratorProviders.map((entry) => ({ command: entry.id, name: entry.label }))}
                provider={selectedProvider}
                model={selectedModel}
                modelsFor={(provider) => {
                  const def = getProviderDef(provider as AiProviderId);
                  const live = liveModelsByProvider[provider] ?? [];
                  return (live.length ? live : def.models);
                }}
                loadingProvider={loadingModelsFor}
                boundarySelector=".chat-mode-panel"
                onPreviewProvider={(provider) => refreshLiveModels(provider as AiProviderId)}
                onRefresh={(provider) => ensureLiveModels(provider as AiProviderId, true)}
                renderEngineIcon={(command, name) => <ProviderBrandMark id={command} label={name} />}
                onChange={(provider, model) => {
                  if (!thread || !providerIds.has(provider as AiProviderId)) return;
                  const nextProvider = provider as AiProviderId;
                  clearPendingNewThreadSettings(thread.projectId);
                  updateChatThread(thread.id, { provider: nextProvider, model, updatedAt: Date.now() });
                  aiProvider.set(nextProvider);
                  setAiModel(nextProvider, model);
                  ensureLiveModels(nextProvider);
                }}
                disabled={!thread}
              />
              <div className="chat-mode-access-dropdown">
                <Dropdown
                  value={accessMode}
                  options={[
                    { value: 'full-access', label: 'Full access', tooltip: 'Full access: the orchestrator edits files and runs commands on its own, without stopping to ask you first. Fastest; best when you trust the task.' },
                    { value: 'inherit', label: 'Ask before edit', tooltip: 'Ask before edit: the orchestrator can read and search freely, but stops and asks you before it changes a file or runs a command that could change anything.' },
                  ] as DropdownOption[]}
                  onChange={selectAccess}
                  ariaLabel="Orchestrator agent access"
                  disabled={!thread}
                  boundarySelector=".chat-mode-panel"
                />
              </div>
              {reasoningLevels.length > 0 && (
                <div className="chat-mode-reasoning-dropdown">
                  <Dropdown
                    value={selectedReasoning}
                    options={(['default', ...reasoningLevels] as ChatReasoningEffort[]).map((level) => ({
                      value: level,
                      label: level === 'default' ? 'Default reasoning' : `${REASONING_LABELS[level]} reasoning`,
                    })) as DropdownOption[]}
                    onChange={(value) => {
                      if (thread) updateChatThread(thread.id, { reasoningEffort: value as ChatReasoningEffort, updatedAt: Date.now() });
                    }}
                    ariaLabel="Reasoning level"
                    disabled={!thread}
                    boundarySelector=".chat-mode-panel"
                  />
                </div>
              )}
              {modelErrors[selectedProvider] && (
                <button
                  type="button"
                  className="chat-mode-provider-warning"
                  title={modelErrors[selectedProvider]}
                  onClick={() => ensureLiveModels(selectedProvider, true)}
                >Retry connection</button>
              )}
              {!modelErrors[selectedProvider] && selectedModelIssue && (
                <span className="chat-mode-provider-warning" role="status" title={selectedModelIssue}>Model unavailable</span>
              )}
            </div>
            <span className="chat-mode-composer-spacer" aria-hidden="true" />
            <div className="chat-mode-composer-actions">
              <button type="button" className="chat-mode-composer-icon-btn" onClick={() => fileInputRef.current?.click()} disabled={!project || attachmentBusy || attachments.length >= 5} title="Attach files or images (or drag and drop files here, paste images)" aria-label="Attach files or images"><PaperclipIcon /></button>
              <button type="button" className={`chat-mode-composer-icon-btn${dictationLive ? ' active' : ''}`} onClick={toggleDictation} disabled={!project || transcriptionPhase === 'processing' || voiceActive} title={dictationLive ? 'Stop dictation and put the transcript in the composer' : 'Dictate a message'} aria-label="Dictate a message"><VoiceInputIcon className="chat-mode-composer-action-icon chat-mode-microphone-icon" /></button>
              <button type="button" className={`chat-mode-composer-icon-btn${voiceActive ? ' active' : ''}`} onClick={toggleChatVoiceMode} disabled={!project} title="Start voice mode" aria-label="Start voice mode"><VoiceModeIcon /></button>
              {dictationLive && (
                <button
                  type="button"
                  className="chat-mode-dictation-stop"
                  onClick={sendTranscriptionNow}
                  disabled={transcriptionPhase === 'processing'}
                  title="Stop dictation and put the transcript in the composer"
                  aria-label="Stop dictation"
                >
                  <svg width="15" height="15" viewBox="0 0 24 24" fill="none" aria-hidden="true">
                    <rect x="5.5" y="5.5" width="13" height="13" rx="1.6" fill="currentColor" />
                  </svg>
                </button>
              )}
              {thread?.status === 'working' ? (
                <button
                  type="button"
                  className="chat-mode-send"
                  onClick={() => stopChatTurn(thread.id)}
                  aria-label="Stop task"
                  title="Stop task"
                >
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
                    <rect x="6" y="6" width="12" height="12" rx="1.8" />
                  </svg>
                </button>
              ) : (
                <button
                  type="submit"
                  className="chat-mode-send"
                  disabled={dictationLive || pendingSendCount > 0 || !thread || !(thread.draft.trim() || attachments.length)}
                  aria-label="Send message"
                >
                {pendingSendCount > 0 ? (
                  <svg className="chat-mode-send-spinner" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" aria-hidden="true">
                    <path d="M12 2a10 10 0 0 1 10 10" />
                  </svg>
                ) : (
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                    <line x1="12" y1="19" x2="12" y2="5" />
                    <polyline points="5 12 12 5 19 12" />
                  </svg>
                )}
                </button>
              )}
            </div>
          </div>
          </form>
        </div>
      </div>
      {viewer && (
        <ImageViewer
          images={viewer.images}
          startIndex={viewer.index}
          projectRoot={project?.root_path ?? null}
          onClose={() => setViewer(null)}
          onUseAsInput={useImageAsInput}
          onEdit={editImage}
        />
      )}
    </section>
  );
}
