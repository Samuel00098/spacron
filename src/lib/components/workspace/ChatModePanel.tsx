import { Suspense, lazy, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type MouseEvent as ReactMouseEvent, type KeyboardEvent as ReactKeyboardEvent } from 'react';
import { customProviders } from '$lib/stores/customProviders';
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
  createSubagentChatThread,
  ensureProjectThread,
  editAssistantChatMessage,
  bringBackSideChat,
  createSideChatThread,
  forkChatThreadFrom,
  getChatThread,
  getPendingNewThreadSettings,
  getProjectThreads,
  removeThreadMessage,
  revertChatThreadTo,
  selectChatThread,
  setThreadDraft,
  updateChatThread,
} from '$lib/stores/chatThreads';
import { openFile } from '$lib/stores/editor';
import { setActiveView } from '$lib/stores/layout';
import { describeReset, refreshUsage, severityOf, usageState } from '$lib/stores/usage';
import Dropdown, { type DropdownOption } from '$lib/components/shared/Dropdown';
import ReasoningSlider from '$lib/components/shared/ReasoningSlider';
import ThreadWorktreeBar from '$lib/components/workspace/ThreadWorktreeBar';
import ChatAgentModelPicker from './ChatAgentModelPicker';
import { todoProgress } from '$lib/services/orchestrator/chat-turn';
import { ProviderBrandMark } from '$lib/components/shared/providerBrands';
import {
  aiModelByProvider,
  aiProvider,
  aiProviders,
  currentAiModel,
  getProviderDef,
  setAiModel,
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
import { getAgentRoster } from '$lib/stores/runs';
import { getCustomAgents } from '$lib/stores/customAgents';
import { acpCommandOverrides, acpDisabledCommands, acpExplicitCommands, acpRegistryEnabled, isAcpEnabled } from '$lib/stores/acpRegistry';
import { isChatAgentProvider } from '$lib/services/agent-provider-catalogue';
import type { AgentProviderModel } from '$lib/services/agent-provider-catalogue';
import AgentLaunchConfigFields from '$lib/components/shared/AgentLaunchConfigFields';
import type { ChatAccessMode, ChatAttachment, ChatFileRef, ChatInlineRequest, ChatMessage, ChatReasoningEffort, ChatThread } from '$lib/types/chat';
import type { Project } from '$lib/types/workspace';
import { reasoningLevelsFor } from '$lib/services/orchestrator/reasoning-levels';
import { CHAT_ACCESS_TIER_HINTS, CHAT_ACCESS_TIER_LABELS, CHAT_ACCESS_TIERS, accessTier } from '$lib/services/orchestrator/access-policy';
import ModelCapabilityBadges, { ModelCapabilityIcons, forgetModelVision } from './ModelCapabilityBadges';
import { modelCapabilitiesVersion } from '$lib/services/model-capabilities';
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
import ImageViewer, { type ViewerImage } from '$lib/components/shared/ImageViewer';
import { convertFileSrc } from '@tauri-apps/api/core';
import ChatAgentRuns from './ChatAgentRuns';
import StandaloneChatPanel from './StandaloneChatPanel';
import { chatScope, showProjectChat, startStandaloneChat } from '$lib/stores/chatNavigation';
import { beginProjectFromChat, projectFromChat } from '$lib/services/standalone-chat';
import type { OrchestratorTask } from '$lib/services/orchestrator/task-lifecycle';
import ChatFileGlyph from './ChatFileGlyph';
import { groupChatToolActivity, toolGroupIsWorking } from '$lib/services/chat-tool-groups';
import { readAloudMessageId, readAloudSupported, stopReadAloud, toggleReadAloud } from '$lib/services/read-aloud';
import './ChatModePanel.css';
import './ChatFileViewer.css';

// The viewer pulls in CodeMirror; load it the first time a file is opened.
const ChatFileViewer = lazy(() => import('./ChatFileViewer'));

/**
 * The composer's `/` commands. Only commands that actually do something are
 * listed: `/image` and `/video` are prefixes the dispatcher already understands,
 * and `/plan` `/build` flip this thread's work mode. A menu that offers a
 * command nothing handles is worse than no menu.
 */
const CHAT_SLASH_COMMANDS: ReadonlyArray<{
  name: string;
  hint: string;
  insert?: string;
  action?: 'plan' | 'build' | 'side' | 'limits';
}> = [
  { name: 'image', hint: 'Generate an image from a description', insert: '/image ' },
  { name: 'video', hint: 'Generate a video from a description', insert: '/video ' },
  { name: 'plan', hint: 'Plan only: inspect and propose, make no edits', action: 'plan' },
  { name: 'build', hint: 'Build: carry out the task with this thread’s access', action: 'build' },
  { name: 'side', hint: 'Ask a side question without interrupting this thread', action: 'side' },
  { name: 'limits', hint: 'Show remaining usage limits for your signed-in agents', action: 'limits' },
];

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

function ImageIcon() {
  return <svg className="chat-mode-composer-action-icon" viewBox="0 0 24 24" aria-hidden="true"><rect x="3" y="4" width="18" height="16" rx="2" /><circle cx="8.5" cy="9" r="1.5" /><path d="m5 17 4.5-4.5 3 3 2-2 4.5 4.5" /></svg>;
}

function CopyIcon() {
  return <svg viewBox="0 0 24 24" aria-hidden="true"><rect x="8" y="8" width="11" height="12" rx="2" /><path d="M16 8V6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v10a2 2 0 0 0 2 2h2" /></svg>;
}

function SpeakerIcon() {
  return <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M11 5 6 9H3v6h3l5 4z" /><path d="M15.5 8.5a5 5 0 0 1 0 7" /><path d="M18.5 5.5a9 9 0 0 1 0 13" /></svg>;
}

function StopSpeakingIcon() {
  return <svg viewBox="0 0 24 24" aria-hidden="true"><rect x="7" y="7" width="10" height="10" rx="1.5" /></svg>;
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
      link.title = 'Open file';
      link.textContent = path;
      fragment.appendChild(link);
      cursor = start + path.length;
    }
    if (cursor === 0) continue;
    if (cursor < value.length) fragment.appendChild(document.createTextNode(value.slice(cursor)));
    node.replaceWith(fragment);
  }
}

/** Open an absolute path in the editor (Code mode). */
async function openPathInEditor(path: string): Promise<void> {
  try {
    await openFile(path);
    setActiveView('editor');
  } catch {
    showToast(`Couldn't open ${path}`, 'error', 4000);
  }
}

/** Paths a reply names open through `onOpenFile` (the chat's file viewer). */
export function ChatMarkdownBody({ text, pending, onOpenFile }: { text: string; pending?: boolean; onOpenFile?: (path: string) => void }) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const html = useMemo(() => {
    try {
      return DOMPurify.sanitize(marked.parse(text || '', { gfm: true, breaks: true }) as string);
    } catch (error) {
      console.error('Failed to render chat Markdown:', error);
      return DOMPurify.sanitize(text || '');
    }
  }, [text]);
  // One object per `html`: a fresh `{ __html }` each render makes React
  // rewrite innerHTML, which wiped the linkified paths and table wrappers.
  const innerHtml = useMemo(() => ({ __html: html }), [html]);

  // Runs after every render (both passes are idempotent), so anything that
  // does reset the markup still gets its links and scroll regions back.
  useLayoutEffect(() => {
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

    if (onOpenFile) linkifyProjectPaths(container);
  });

  if (pending && !text.trim()) {
    return <span className="chat-mode-pending"><i /><i /><i /></span>;
  }
  return (
    <div
      ref={containerRef}
      className="chat-mode-message-markdown"
      onClick={onOpenFile ? (event: ReactMouseEvent<HTMLDivElement>) => {
        const link = (event.target as HTMLElement | null)?.closest?.('[data-chat-file-path]') as HTMLElement | null;
        const path = link?.dataset.chatFilePath?.trim();
        if (!path) return;
        event.preventDefault();
        onOpenFile(path);
      } : undefined}
      onKeyDown={onOpenFile ? (event: ReactKeyboardEvent<HTMLDivElement>) => {
        if (event.key !== 'Enter' && event.key !== ' ') return;
        const path = (event.target as HTMLElement | null)?.dataset?.chatFilePath?.trim();
        if (!path) return;
        event.preventDefault();
        onOpenFile(path);
      } : undefined}
      dangerouslySetInnerHTML={innerHtml}
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

/** Compact token counts for the context meter: 8,214 / 200,000 -> "8.2k/200k". */
function formatTokenCount(value: number): string {
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`;
  if (value >= 10_000) return `${Math.round(value / 1_000)}k`;
  if (value >= 1_000) return `${(value / 1_000).toFixed(1)}k`;
  return String(Math.max(0, Math.round(value)));
}

function isUsageLimitFailure(message: ChatMessage): boolean {
  if (message.type !== 'failure' && message.completion?.status !== 'failed') return false;
  return /(?:usage|rate)[ -]?limit|quota|out of credits?|insufficient[_ ]quota|credit balance|payment required/i
    .test(`${message.text} ${message.completion?.reason ?? ''}`);
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

/** One card for a run of tool calls: summary line, then the individual calls. */
function ToolActivityGroup({ messages }: { messages: ChatMessage[] }) {
  const [open, setOpen] = useState(false);
  const working = toolGroupIsWorking(messages);
  const last = messages[messages.length - 1];
  return (
    <div className={`chat-mode-tool-group${working ? ' working' : ''}`} role="status">
      <button
        type="button"
        className="chat-mode-tool-group-head"
        onClick={() => setOpen((value) => !value)}
        aria-expanded={open}
        aria-label={open ? 'Hide tool calls' : 'Show tool calls'}
      >
        <span className="chat-mode-tool-group-dot" aria-hidden="true" />
        <strong>{working ? 'Running tools' : 'Tools'}</strong>
        <span className="chat-mode-tool-group-count">{messages.length} {messages.length === 1 ? 'call' : 'calls'}</span>
        <span className="chat-mode-tool-group-last">{last?.text}</span>
        <span className="chat-mode-tool-group-toggle" aria-hidden="true">{open ? 'Hide' : 'Show'}</span>
      </button>
      {open && (
        <ul className="chat-mode-tool-group-list">
          {messages.map((message) => (
            <li key={message.id} className={message.pending ? 'working' : 'done'}>
              <span className="chat-mode-tool-group-check" aria-hidden="true">{message.pending ? '●' : '✓'}</span>
              <span>{message.text}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
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
  const scope = useStore(chatScope);
  const sourceChatId = useStore(projectFromChat);
  const previousProject = useRef(project?.id);
  useEffect(() => {
    if (previousProject.current !== project?.id && project && !sourceChatId) showProjectChat();
    previousProject.current = project?.id;
  }, [project?.id, sourceChatId]);
  return !project || scope === 'standalone' ? <StandaloneChatPanel /> : <ProjectChatModePanel />;
}

export function ProjectChatModePanel({ chatProject, standalone = false, onCreateStandaloneThread }: {
  chatProject?: Project;
  standalone?: boolean;
  onCreateStandaloneThread?: (overrides: Parameters<typeof createChatThread>[1]) => ChatThread;
} = {}) {
  const activeProjectValue = useStore(activeProject);
  const project = chatProject ?? activeProjectValue;
  const workspace = useStore(activeWorkspace);
  const pendingProjectPath = workspace?.active_project_path ?? workspace?.project_paths?.[0];
  const projectName = standalone ? undefined : project?.name ?? pendingProjectPath?.replace(/[\\/]+$/, '').split(/[\\/]/).pop();
  const threadState = useStore(chatThreadState);
  const acpChatEnabled = useStore(acpRegistryEnabled);
  const disabledAcpCommands = useStore(acpDisabledCommands);
  const explicitAcpCommands = useStore(acpExplicitCommands);
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
  const [threadMentions, setThreadMentions] = useState<string[]>([]);
  const [threadPickerOpen, setThreadPickerOpen] = useState(false);
  const [fileMention, setFileMention] = useState<{ start: number; end: number; query: string } | null>(null);
  const [fileMatches, setFileMatches] = useState<string[]>([]);
  const [fileMatchIndex, setFileMatchIndex] = useState(0);
  const [isComposerDragOver, setIsComposerDragOver] = useState(false);
  const [viewer, setViewer] = useState<{ images: ViewerImage[]; index: number } | null>(null);
  const [pendingSendCount, setPendingSendCount] = useState(0);
  const [answeringRequest, setAnsweringRequest] = useState(false);
  const answeringRequestRef = useRef(false);
  const [subagentPrompt, setSubagentPrompt] = useState('');
  const [liveModelsByProvider, setLiveModelsByProvider] = useState<Record<string, AiModelOption[]>>({});
  const [loadingModelsFor, setLoadingModelsFor] = useState<string | null>(null);
  const [liveModelsByAgent, setLiveModelsByAgent] = useState<Record<string, AgentProviderModel[]>>({});
  const [loadingAgentModelsFor, setLoadingAgentModelsFor] = useState<string | null>(null);
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
  const panelRef = useRef<HTMLElement | null>(null);

  const projectThreads = project ? threadState.threadsByProject[project.id] ?? [] : [];
  const activeThreadId = project ? threadState.activeThreadByProject[project.id] ?? null : null;
  const thread = projectThreads.find((entry) => entry.id === activeThreadId) ?? projectThreads[0] ?? null;
  const threadGroupParentId = thread?.parentThreadId ?? thread?.id;
  const subagentThreads = useMemo(
    () => project && threadGroupParentId
      ? projectThreads.filter((entry) => entry.parentThreadId === threadGroupParentId)
      : [],
    [projectThreads, project, threadGroupParentId],
  );
  const messages = thread ? threadState.messagesByThread[thread.id] ?? [] : [];
  // Runs of consecutive tool rows, keyed by their first message id: the run
  // renders once, as a single card, and the later rows render nothing.
  const toolGroups = useMemo(() => {
    const groups = new Map<string, ChatMessage[]>();
    for (const group of groupChatToolActivity(messages)) {
      if (group[0]?.type === 'activity' && group[0]) groups.set(group[0].id, group);
    }
    return groups;
  }, [messages]);
  // The file open in the side viewer: `label` is the path as the conversation
  // names it, `path` the absolute file under this chat's root.
  const [viewerFile, setViewerFile] = useState<{ path: string; label: string } | null>(null);
  const viewerRoot = thread?.worktree?.path ?? project?.root_path ?? '';
  const openFileInViewer = useCallback((path: string) => {
    if (!viewerRoot && !/^(?:[a-zA-Z]:)?[\\/]/.test(path)) {
      showToast('No folder to open this file from.', 'warning', 3000);
      return;
    }
    setViewerFile({ path: resolveProjectFilePath(path, viewerRoot), label: path });
  }, [viewerRoot]);
  useEffect(() => { setViewerFile(null); }, [thread?.id, project?.id]);
  const readingMessageId = useStore(readAloudMessageId);
  const canReadAloud = useMemo(() => readAloudSupported(), []);
  // A read belongs to the conversation on screen; leaving it stops the voice.
  useEffect(() => () => stopReadAloud(), [thread?.id]);
  const openAbsoluteInViewer = useCallback((absolutePath: string) => {
    const root = viewerRoot.replace(/\\/g, '/').replace(/\/$/, '');
    const normalized = absolutePath.replace(/\\/g, '/');
    setViewerFile({ path: absolutePath, label: root && normalized.toLowerCase().startsWith(root.toLowerCase() + '/') ? normalized.slice(root.length + 1) : normalized });
  }, [viewerRoot]);
  // What is waiting to run in this thread: rendered as the queue strip above
  // the composer, with per-row steer/remove.
  const [findOpen, setFindOpen] = useState(false);
  const [findQuery, setFindQuery] = useState('');
  const [findAt, setFindAt] = useState(0);
  const [findFlashId, setFindFlashId] = useState<string | null>(null);
  const findInputRef = useRef<HTMLInputElement | null>(null);
  const [slashAt, setSlashAt] = useState(0);
  const [revertRestoreFiles, setRevertRestoreFiles] = useState(false);
  // Limits are read from the store the meters already poll; opening the card
  // asks for a refresh rather than starting a second timer.
  const [limitsOpen, setLimitsOpen] = useState(false);
  const usage = useStore(usageState);
  const queuedMessages = (thread ? messageQueues[thread.id] ?? [] : []) as QueuedChatMessage[];
  // ACP v2 reports its own context usage and plan. Both are per-thread state, so
  // the meter and card survive a thread switch without re-reading the stream.
  const contextUsage = thread?.contextUsage ?? null;
  const agentPlan = thread?.turnPlan && thread.turnPlan.entries.length > 0 ? thread.turnPlan : null;
  const limitProviders = usage.providers.filter((provider) => provider.status === 'ok' && provider.windows.length > 0);
  const tickerOwnsPlan = Boolean(turnTicker && turnTicker.threadId === thread?.id);
  // Find in thread: matches are the text-bearing rows in transcript order, so
  // "next" walks the conversation the way the user reads it.
  const findMatches = findQuery.trim()
    ? messages.filter((message) => message.type !== 'activity' && message.type !== 'completion'
      && message.text.toLowerCase().includes(findQuery.trim().toLowerCase()))
    : [];
  const findCurrent = findMatches.length ? findMatches[Math.min(findAt, findMatches.length - 1)] : null;
  const findCurrentId = findCurrent?.id ?? null;

  useEffect(() => {
    if (!findCurrentId || typeof document === 'undefined') {
      setFindFlashId(null);
      return;
    }
    document.getElementById(`chat-msg-${findCurrentId}`)?.scrollIntoView({ block: 'center', behavior: 'smooth' });
    setFindFlashId(findCurrentId);
    const timer = setTimeout(() => setFindFlashId(null), 1400);
    return () => clearTimeout(timer);
  }, [findCurrentId, findQuery]);

  useEffect(() => {
    if (!findOpen) return;
    findInputRef.current?.focus();
    findInputRef.current?.select();
  }, [findOpen]);

  useEffect(() => {
    if (typeof window === 'undefined') return;
    const onFindKey = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && !event.shiftKey && !event.altKey && event.key.toLowerCase() === 'f') {
        event.preventDefault();
        setFindOpen(true);
      } else if (event.key === 'Escape' && findOpen) {
        setFindOpen(false);
      }
    };
    window.addEventListener('keydown', onFindKey);
    return () => window.removeEventListener('keydown', onFindKey);
  }, [findOpen]);
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
  // Agents the orchestrator dispatched, each shown once as a card under the
  // LAST message that dispatched it (a later "send" to the same agent moves
  // its card down rather than duplicating it).
  const agentRunsByMessage = useMemo(() => {
    const lastDispatch = new Map<string, string>();
    for (const message of messages) {
      for (const ref of message.dispatched ?? []) lastDispatch.set(ref.taskId, message.id);
    }
    const byMessage = new Map<string, OrchestratorTask[]>();
    for (const [taskId, messageId] of lastDispatch) {
      const task = allTasks.find((entry) => entry.id === taskId);
      if (!task) continue;
      byMessage.set(messageId, [...(byMessage.get(messageId) ?? []), task]);
    }
    return byMessage;
  }, [messages, allTasks]);
  const cardTaskIds = useMemo(
    () => new Set([...agentRunsByMessage.values()].flat().map((task) => task.id)),
    [agentRunsByMessage],
  );
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
  // Custom providers join `aiProviders` when they load, so the list follows them.
  const customList = useStore(customProviders);
  const orchestratorProviders = useMemo(() => aiProviders.filter((entry) => entry.id !== 'local'), [customList]);
  const providerIds = useMemo(() => new Set(orchestratorProviders.map((entry) => entry.id)), [orchestratorProviders]);
  const selectedProvider = thread?.provider && providerIds.has(thread.provider as AiProviderId)
    ? thread.provider as AiProviderId
    : providerIds.has(defaultProvider) ? defaultProvider : 'chatgpt';
  const providerDef = getProviderDef(selectedProvider);
  const selectedModel = thread?.model?.trim()
    || (selectedProvider === defaultProvider ? defaultModel : modelByProvider[selectedProvider])
    || providerDef.defaultModel;
  const liveModels = liveModelsByProvider[selectedProvider] ?? [];
  // Only the levels this provider's API accepts for this model; a saved level
  // the new model lacks shows (and is sent) as the provider default.
  // Redraw when background-learned capabilities arrive: a model the built-in
  // rules do not know may gain a reasoning menu from its provider's list.
  useStore(modelCapabilitiesVersion);
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
  // The composer shows T3's four tiers. A thread that never picked one reads
  // as supervised: absent means narrow, not wide.
  const accessMode: ChatAccessMode = accessTier(thread?.accessMode);
  const workMode = thread?.workMode === 'plan' ? 'plan' : 'build';
  const acpAgents = useMemo(() => {
    void acpChatEnabled;
    void disabledAcpCommands;
    void acpCommandOverrides;
    const custom = getCustomAgents();
    // ACP membership comes from three places: a custom agent added with the ACP
    // box ticked, a command the user declared ACP in Settings (which is how
    // presets like Claude Code or Antigravity get here), and the command's own
    // name, which the transport settles at send time.
    const acpCommands = new Set([
      ...custom.filter((agent) => agent.supportsAcp).map((agent) => agent.command.trim().toLowerCase()),
      ...explicitAcpCommands.map((command) => command.trim().toLowerCase()),
    ]);
    return getAgentRoster()
      .filter((agent) => isAcpEnabled(agent.command))
      .filter((agent) =>
        isChatAgentProvider(agent.command)
        || acpCommands.has(agent.command.trim().toLowerCase())
        // A local ACP command set in Settings makes any roster agent chattable:
        // Chat launches that entry point, so the agent belongs in the list.
        || Boolean(get(acpCommandOverrides)[agent.command.trim().toLowerCase()]),
      )
      .map((agent) => ({ command: agent.command, name: agent.name }));
  }, [threadState, project?.id, acpChatEnabled, disabledAcpCommands, explicitAcpCommands, acpCommandOverrides]);
  const selectedAcpAgent = thread?.agentPreset && acpAgents.some((agent) => agent.command === thread.agentPreset)
    ? thread.agentPreset
    : acpAgents[0]?.command ?? '';
  const selectedAcpModel = thread?.model?.trim()
    || liveModelsByAgent[selectedAcpAgent]?.find((entry) => entry.isDefault)?.id
    || liveModelsByAgent[selectedAcpAgent]?.[0]?.id
    || 'default';

  const ensureAgentModels = useCallback((command: string, force = false) => {
    if (!command || (!force && Object.prototype.hasOwnProperty.call(liveModelsByAgent, command))) return;
    if (loadingAgentModelsFor === command) return;
    setLoadingAgentModelsFor(command);
    void loadLiveAgentProviderModels(command)
      .then((models) => setLiveModelsByAgent((current) => ({ ...current, [command]: models })))
      .catch(() => setLiveModelsByAgent((current) => ({ ...current, [command]: [] })))
      .finally(() => setLoadingAgentModelsFor((current) => current === command ? null : current));
  }, [liveModelsByAgent, loadingAgentModelsFor]);

  useEffect(() => {
    if (selectedAcpAgent) ensureAgentModels(selectedAcpAgent);
  }, [selectedAcpAgent, ensureAgentModels]);

  useEffect(() => {
    if (!project || !fileMention) { setFileMatches([]); return; }
    let cancelled = false;
    const timer = setTimeout(() => {
      const escaped = fileMention.query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      void invoke<string[]>('fs_glob_files', {
        rootPath: project.root_path,
        pattern: `(?i)${escaped || '.'}`,
        matchAnywhere: false,
        max: 30,
      }).then((paths) => { if (!cancelled) { setFileMatches(paths); setFileMatchIndex(0); } })
        .catch(() => { if (!cancelled) setFileMatches([]); });
    }, 120);
    return () => { cancelled = true; clearTimeout(timer); };
  }, [project?.root_path, fileMention?.query]);

  function updateFileMention(value: string, cursor: number) {
    const prefix = value.slice(0, cursor);
    const match = /(?:^|\s)@([^\s@]*)$/.exec(prefix);
    setFileMention(match ? { start: cursor - match[1].length - 1, end: cursor, query: match[1] } : null);
  }

  function pickFileMention(path: string) {
    if (!thread || !fileMention) return;
    const value = thread.draft;
    const next = `${value.slice(0, fileMention.start)}@${path} ${value.slice(fileMention.end)}`;
    updateDraft(next);
    setFileMention(null);
    const cursor = fileMention.start + path.length + 2;
    requestAnimationFrame(() => { textareaRef.current?.focus(); textareaRef.current?.setSelectionRange(cursor, cursor); });
  }
  const composerValue = thread?.draft ?? '';
  // Open while the draft is exactly a slash word, so the menu never interrupts
  // a prompt that merely contains a slash.
  const slashQuery = /^\/([a-z-]*)$/i.exec(composerValue)?.[1].toLowerCase() ?? null;
  const slashMatches = slashQuery === null
    ? []
    : CHAT_SLASH_COMMANDS.filter((command) => command.name.startsWith(slashQuery));
  const slashActive = slashMatches.length ? Math.min(slashAt, slashMatches.length - 1) : 0;
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
    if (project && !standalone) ensureProjectThread(project.id);
  }, [project?.id, standalone]);

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
    const target = ensureConversationThread();
    if (!target) return;
    updateChatThread(target.id, {
      accessMode: accessTier(nextAccess as ChatAccessMode),
      updatedAt: Date.now(),
    });
  }

  function updateDraft(value: string) {
    const target = thread ?? (value ? ensureConversationThread() : null);
    if (target) setThreadDraft(target.id, value);
  }

  function ensureConversationThread(): ChatThread | null {
    return thread ?? onCreateStandaloneThread?.({ provider: selectedProvider, model: selectedModel, accessMode, workMode }) ?? null;
  }

  function beginEditMessage(message: ChatMessage) {
    if (message.pending || (message.role !== 'user' && message.role !== 'assistant')) return;
    setEditingMessageId(message.id);
    setEditingMessageDraft(message.text);
  }

  async function saveEditedResponse(messageId: string) {
    if (!thread || !editingMessageDraft.trim()) return;
    try {
      if (await editAssistantChatMessage(thread.id, messageId, editingMessageDraft)) cancelEditMessage();
    } catch (error) { showToast(`Could not save the response: ${String(error)}`, 'error'); }
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
    if (standalone) {
      startStandaloneChat();
      return;
    }

    const pendingSettings = getPendingNewThreadSettings(project.id);
    createChatThread(project.id, {
      agentPreset: selectedAcpAgent || null,
      agentName: acpAgents.find((agent) => agent.command === selectedAcpAgent)?.name ?? null,
      model: selectedAcpModel,
      provider: pendingSettings?.provider ?? selectedProvider,
      ...(selectedAcpAgent ? {} : { model: pendingSettings?.model ?? selectedModel }),
      accessMode,
      workMode,
    });
    setAttachments((current) => {
      revokeAttachmentPreviews(current);
      return [];
    });
    setRequestDraft('');
  }

  async function createSubagentThread() {
    const prompt = subagentPrompt.trim();
    if (!project || !thread || !prompt) {
      showToast('Describe the work for the sub-agent first.', 'warning', 4000);
      return;
    }
    const normalizedPrompt = prompt.toLowerCase().replace(/[`"'()[\],:;]/g, ' ').replace(/\s+/g, ' ');
    const requestedAgent = getAgentRoster().find((entry) =>
      normalizedPrompt.includes(entry.command.toLowerCase()) || normalizedPrompt.includes(entry.name.toLowerCase()));
    const agent = acpAgents.find((entry) => entry.command === requestedAgent?.command)
      ?? (requestedAgent ? null : acpAgents.find((entry) => entry.command === selectedAcpAgent));
    if (requestedAgent && !agent) {
      showToast(`${requestedAgent.name} is not enabled as an ACP Chat agent. Enable it in Settings > Agents.`, 'warning', 5000);
      return;
    }
    if (!agent) return;
    ensureAgentModels(agent.command);
    let available = liveModelsByAgent[agent.command] ?? [];
    if (!available.length) {
      try {
        available = await loadLiveAgentProviderModels(agent.command);
        setLiveModelsByAgent((current) => ({ ...current, [agent.command]: available }));
      } catch {
        available = [];
      }
    }
    const normalizedModelText = normalizedPrompt.replace(/[-_.:/]+/g, ' ');
    const matchedModel = available.find((entry) => {
      const id = entry.id.toLowerCase();
      const label = entry.label.toLowerCase();
      return normalizedPrompt.includes(id) || normalizedModelText.includes(id.replace(/[-_.:/]+/g, ' '))
        || normalizedPrompt.includes(label) || normalizedModelText.includes(label.replace(/[-_.:/]+/g, ' '));
    })?.id;
    if (available.length && !matchedModel && requestedAgent) {
      showToast(`The requested model was not reported by ${agent.name}. Refresh its model list and try again.`, 'warning', 5000);
      return;
    }
    const model = matchedModel ?? (thread.agentPreset === agent.command ? thread.model : null)
      ?? available.find((entry) => entry.isDefault)?.id ?? available[0]?.id ?? 'default';
    const child = createSubagentChatThread(project.id, thread.parentThreadId ?? thread.id, {
      name: agent.name,
      command: agent.command,
      model,
      role: 'custom',
    });
    const context = messages
      .filter((message) => message.text.trim())
      .slice(-8)
      .map((message) => `${message.role === 'user' ? 'User' : 'Assistant'}: ${message.text.trim()}`)
      .join('\n\n')
      .slice(-12000);
    appendThreadMessage({
      id: `chat-message-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      threadId: child.id,
      type: 'system',
      role: 'system',
      text: `Dedicated sub-agent thread for ${agent.name} (${model}).`,
      ts: Date.now(),
    });
    if (context) {
      appendThreadMessage({
        id: `chat-message-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        threadId: child.id,
        type: 'system',
        role: 'system',
        text: `Bounded context handoff from the parent thread:\n\n${context}`,
        ts: Date.now(),
      });
    }
    const childPrompt = context
      ? `Work on this request using ${agent.name} model ${model}.\n\nParent context:\n${context}\n\nSub-agent assignment:\n${prompt}`
      : prompt;
    setSubagentPrompt('');
    selectChatThread(project.id, child.id);
    void sendChatMessage(project.id, project.root_path, childPrompt, {
      projectName: project.name,
      threadId: child.id,
      orchestratorProvider: selectedProvider,
      orchestratorModel: selectedModel,
      forcedAgent: agent.command,
      model,
      accessMode,
      workMode,
      chatMode: true,
      conversationalMode: true,
    }).catch((error) => showToast(error instanceof Error ? error.message : String(error), 'error'));
  }

  async function answerPendingRequest(answer: string, request = pendingRequest) {
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
      forcedAgent: selectedAcpAgent || undefined,
      model: selectedAcpModel,
      accessMode,
      workMode,
      chatMode: true,
      conversationalMode: true,
      // The banner/card answers the agent that asked, not the orchestrator.
      answerTaskId: request?.taskId ?? undefined,
      });
      setRequestDraft('');
    } finally {
      answeringRequestRef.current = false;
      setAnsweringRequest(false);
    }
  }

  /** An agent card's reply box: goes to that one agent, verbatim. */
  async function answerAgent(taskId: string, text: string) {
    if (!project || !thread) return;
    await sendChatMessage(project.id, project.root_path, text, {
      projectName: project.name,
      threadId: thread.id,
      orchestratorProvider: selectedProvider,
      orchestratorModel: selectedModel,
      forcedAgent: selectedAcpAgent || undefined,
      model: selectedAcpModel,
      accessMode,
      workMode,
      chatMode: true,
      conversationalMode: true,
      answerTaskId: taskId,
    });
  }

  async function switchAndContinue(message: ChatMessage) {
    if (!project || !thread || pendingSendCount > 0) return;
    const source = message.dispatchedAgent ?? message.completion?.agentName ?? thread.agentPreset;
    const target = acpAgents.find((agent) => agent.command !== source) ?? acpAgents[0];
    if (!target) {
      showToast('Add or enable another ACP agent in Settings > Agents before switching.', 'warning', 5000);
      return;
    }
    ensureAgentModels(target.command);
    const targetModels = liveModelsByAgent[target.command] ?? [];
    const targetModel = targetModels.find((model) => model.isDefault)?.id
      ?? targetModels[0]?.id
      ?? 'default';
    updateChatThread(thread.id, { agentPreset: target.command, model: targetModel, updatedAt: Date.now() });
    setPendingSendCount((count) => count + 1);
    try {
      await sendChatMessage(project.id, project.root_path, 'Continue where you left off.', {
        projectName: project.name,
        threadId: thread.id,
        orchestratorProvider: selectedProvider,
        orchestratorModel: selectedModel,
        forcedAgent: target.command,
        model: targetModel,
        accessMode,
        workMode,
        chatMode: true,
        conversationalMode: true,
      });
    } finally {
      setPendingSendCount((count) => Math.max(0, count - 1));
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

  // Explorer drags can land anywhere on the visible chat panel.
  useEffect(() => {
    const overPanel = (x: number, y: number) =>
      document.elementFromPoint(x, y)?.closest('.chat-mode-panel') === panelRef.current;
    const onExplorerMove = (event: Event) => {
      const { clientX, clientY } = (event as CustomEvent<{ clientX: number; clientY: number }>).detail;
      setIsComposerDragOver(overPanel(clientX, clientY));
    };
    const onExplorerEnd = (event: Event) => {
      const { path, clientX, clientY } = (event as CustomEvent<{ path: string; clientX: number; clientY: number }>).detail;
      setIsComposerDragOver(false);
      if (!path || !overPanel(clientX, clientY)) return;
      void handleDroppedPaths([path]);
      textareaRef.current?.focus();
    };
    window.addEventListener('spacron-explorer-drag-move', onExplorerMove);
    window.addEventListener('spacron-explorer-drag-end', onExplorerEnd);
    return () => {
      window.removeEventListener('spacron-explorer-drag-move', onExplorerMove);
      window.removeEventListener('spacron-explorer-drag-end', onExplorerEnd);
    };
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

  // Thread @-mention: mention another thread so its recent context rides the
  // next message. Keeps the mentioned thread intact — only its transcript is
  // quoted into this turn's prompt.
  function openThreadPicker() {
    setThreadPickerOpen(true);
  }

  function closeThreadPicker() {
    setThreadPickerOpen(false);
  }

  function mentionThread(threadId: string) {
    if (threadMentions.includes(threadId)) return;
    setThreadMentions([...threadMentions, threadId]);
    closeThreadPicker();
  }

  function removeThreadMention(threadId: string) {
    setThreadMentions(threadMentions.filter((id) => id !== threadId));
  }

  function mentionedThreadsContext(): string {
    if (!project || threadMentions.length === 0) return '';
    const state = get(chatThreadState);
    const parts: string[] = [];
    for (const threadId of threadMentions) {
      const thread = state.threadsByProject[project.id]?.find((t) => t.id === threadId);
      const messages = state.messagesByThread[threadId] ?? [];
      const recent = messages
        .filter((m) => m.text.trim())
        .slice(-6)
        .map((m) => `${m.role === 'user' ? 'User' : 'Assistant'}: ${m.text.trim()}`)
        .join('\n');
      if (recent) {
        parts.push(`# Thread "${thread?.title ?? threadId}" (referenced):\n${recent}`);
      }
    }
    return parts.join('\n\n');
  }

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

  function runSlashCommand(command: (typeof CHAT_SLASH_COMMANDS)[number]) {
    if (command.action === 'limits') {
      setLimitsOpen(true);
      void refreshUsage(true);
      updateDraft('');
      setSlashAt(0);
      return;
    }
    if (command.action === 'side') {
      if (thread) createSideChatThread(thread.id);
      updateDraft('');
      setSlashAt(0);
      return;
    }
    if (command.action) {
      const target = thread ?? ensureConversationThread();
      if (target) updateChatThread(target.id, { workMode: command.action, updatedAt: Date.now() });
      updateDraft('');
      setSlashAt(0);
      return;
    }
    updateDraft(command.insert ?? `/${command.name} `);
    setSlashAt(0);
    textareaRef.current?.focus();
  }

  // Fork keeps this thread intact and continues from a copy, which is the other
  // half of "branch the conversation": revert rewrites, fork branches.
  function forkFrom(messageId: string | null) {
    if (!thread) return;
    forkChatThreadFrom(thread.id, messageId);
  }

  // Revert to before a message: the transcript branches there and, for a user
  // message, its text returns to the composer so it can be re-sent differently.
  function revertToMessage(messageId: string) {
    if (!thread) return;
    if (!revertChatThreadTo(thread.id, messageId, revertRestoreFiles)) return;
    setFindOpen(false);
    setFindQuery('');
    setFindAt(0);
    setRevertRestoreFiles(false);
  }

  async function submit() {
    if (pendingRequest) {
      await answerPendingRequest(requestDraft);
      return;
    }
    const target = thread ?? (attachments.length ? ensureConversationThread() : null);
    const baseText = target?.draft.trim() || (attachments.length ? 'Please review the attached files.' : '');
    const threadContext = mentionedThreadsContext();
    const text = threadContext ? `${threadContext}\n\n${baseText}` : baseText;
    if (!project || !target || !text || pendingSendCount > 0) return;
    // previewUrl is a live blob: URL for thumbnails only — strip it before the
    // attachments are recorded, then revoke so the blobs don't leak.
    const messageAttachments = attachments.map(({ previewUrl: _preview, ...rest }) => rest);
    revokeAttachmentPreviews(attachments);
    setThreadDraft(target.id, '');
    setFileMention(null);
    setThreadMentions([]);
    setAttachments([]);
    setPendingSendCount((count) => count + 1);
    try {
      // Queue-aware send: while a turn is running the message waits its turn
      // instead of being refused; the queued list under the composer offers
      // "Send now" (steer: hand it to the running turn) and "×".
      await enqueueChatMessage(project.id, project.root_path, text, {
        projectName: project.name,
        threadId: target.id,
        orchestratorProvider: selectedProvider,
        orchestratorModel: selectedModel,
        forcedAgent: selectedAcpAgent || undefined,
        model: selectedAcpModel,
        accessMode,
        workMode,
        chatMode: true,
        conversationalMode: true,
        attachments: messageAttachments,
      });
    } finally {
      setPendingSendCount((count) => Math.max(0, count - 1));
    }
  }

  if (!project) return null;

  return (
    <section
      ref={panelRef}
      className={`chat-mode-panel${standalone ? ' standalone-chat-panel' : ''}${messages.length === 0 ? ' empty' : ''}${viewerFile ? ' has-file-viewer' : ''}`}
      aria-label="Chat"
      onMouseOver={(event) => {
        const target = event.target instanceof Element ? event.target.closest('[title]') as HTMLElement | null : null;
        if (!target || !event.currentTarget.contains(target)) return;
        target.dataset.chatTooltipTitle ??= target.getAttribute('title') ?? '';
        target.removeAttribute('title');
      }}
      onMouseOut={(event) => {
        const target = event.target instanceof Element ? event.target.closest('[data-chat-tooltip-title]') as HTMLElement | null : null;
        if (!target || target.contains(event.relatedTarget as Node | null)) return;
        target.setAttribute('title', target.dataset.chatTooltipTitle ?? '');
        delete target.dataset.chatTooltipTitle;
      }}
    >
      {viewerFile && (
        <Suspense fallback={null}>
          <ChatFileViewer
            path={viewerFile.path}
            label={viewerFile.label}
            onClose={() => setViewerFile(null)}
            onOpenInEditor={standalone ? undefined : () => void openPathInEditor(viewerFile.path)}
            onOpenFile={openAbsoluteInViewer}
          />
        </Suspense>
      )}
      <div className="chat-mode-room-header">
        <div className="chat-mode-room-title">
          <span className="chat-mode-room-icon" aria-hidden="true"></span>
          <span className="chat-mode-room-kind">Chat</span>
          <strong>{standalone && (!thread || thread.title === 'New thread') ? 'New chat' : thread?.title ?? 'Conversation'}</strong>
          {/* Chat-level activity only ("Working", "Idle", "Needs input") — never a
              single agent's name. The thread can drive several agents at once,
              so naming one here reads as "that agent is working" and hides
              the rest. Per-agent state lives on the agent cards/panes. */}
          <span className={`chat-mode-live-status ${liveStatusClass}`} aria-live="polite">{liveStatusText}</span>
        </div>
        <div className="chat-mode-room-actions">
          {standalone && project && <button type="button" onClick={() => void invoke('chat_workspace_reveal', { workspaceId: thread?.standaloneWorkspaceId ?? project.id.replace(/^chat-/, '') }).catch((error) => showToast(String(error), 'error'))}>Files</button>}
          {standalone && thread && messages.some((message) => message.role === 'user') && <button type="button" disabled={thread.status === 'working' || thread.status === 'needs-input' || pendingSendCount > 0} onClick={() => beginProjectFromChat(thread.id)}>Create project from chat</button>}
          {project && <button type="button" onClick={startNewThread}>{standalone ? 'New chat' : 'New conversation'}</button>}
        </div>
      </div>

      {project && thread && (
         <aside className="chat-mode-subagents" aria-label="Sub-agents">
           <div className="chat-mode-subagents-head">
             <strong>Sub-agents</strong>
             <input
               type="text"
               value={subagentPrompt}
               onChange={(event) => setSubagentPrompt(event.target.value)}
               onKeyDown={(event) => { if (event.key === 'Enter') void createSubagentThread(); }}
               placeholder="Assign work, agent, and model…"
               aria-label="Sub-agent assignment"
             />
             <button
               type="button"
               onClick={() => void createSubagentThread()}
               disabled={!subagentPrompt.trim() || pendingSendCount > 0}
               title="Create a dedicated chat thread for the selected agent"
             >
               + Add
             </button>
           </div>
           {subagentThreads.length === 0 ? (
             <span className="chat-mode-subagents-empty">Create a focused agent thread without leaving this conversation.</span>
           ) : (
             <div className="chat-mode-subagents-list">
               {subagentThreads.map((child) => (
                 <button
                   type="button"
                   key={child.id}
                   className={`chat-mode-subagent ${child.id === thread.id ? 'active' : ''}`}
                   onClick={() => selectChatThread(project.id, child.id)}
                 >
                   <span className="chat-mode-subagent-name">{child.agentName || child.title} · {child.model || 'default'}</span>
                   <span className={`chat-mode-subagent-status ${child.status}`}>
                     {child.status === 'working' ? 'Working' : child.status === 'needs-input' ? 'Needs input' : child.status === 'failed' ? 'Failed' : 'Idle'}
                   </span>
                 </button>
               ))}
             </div>
           )}
         </aside>
      )}

      <div className={`chat-mode-content-stack${messages.length === 0 ? ' is-empty' : ''}`}>
        <div className={`chat-mode-body${messages.length === 0 ? ' is-empty' : ''}`}>
          {findOpen && (
            <div className="chat-mode-find" role="search" aria-label="Find in thread">
              <input
                ref={findInputRef}
                value={findQuery}
                onChange={(event) => { setFindQuery(event.target.value); setFindAt(0); }}
                onKeyDown={(event) => {
                  if (event.key === 'Enter') {
                    event.preventDefault();
                    const step = event.shiftKey ? -1 : 1;
                    setFindAt((value) => (findMatches.length ? (value + step + findMatches.length) % findMatches.length : 0));
                  } else if (event.key === 'Escape') {
                    setFindOpen(false);
                  }
                }}
                placeholder="Find in thread"
                aria-label="Find in thread"
              />
              <span className="chat-mode-find-count">
                {findQuery.trim() ? (findMatches.length ? `${Math.min(findAt, findMatches.length - 1) + 1}/${findMatches.length}` : 'No matches') : ''}
              </span>
              <button type="button" onClick={() => setFindAt((value) => (findMatches.length ? (value - 1 + findMatches.length) % findMatches.length : 0))} aria-label="Previous match" disabled={findMatches.length === 0}>↑</button>
              <button type="button" onClick={() => setFindAt((value) => (findMatches.length ? (value + 1) % findMatches.length : 0))} aria-label="Next match" disabled={findMatches.length === 0}>↓</button>
              <button type="button" onClick={() => setFindOpen(false)} aria-label="Close find">×</button>
            </div>
          )}
          <div ref={scrollRef} className={`chat-mode-transcript${messages.length === 0 ? ' is-empty' : ''}`} aria-live="polite">
            {(thread.parentThreadId || thread.forkOfThreadId) && (
              <div className="chat-mode-lineage" role="note">
                <span>
                  {thread.parentThreadId ? 'Side chat of ' : 'Forked from '}
                  <strong>{getChatThread(thread.parentThreadId ?? thread.forkOfThreadId ?? '')?.title ?? 'another thread'}</strong>
                </span>
                <div className="chat-mode-lineage-actions">
                  <button
                    type="button"
                    onClick={() => {
                      const parentId = thread.parentThreadId ?? thread.forkOfThreadId;
                      if (parentId) selectChatThread(thread.projectId, parentId);
                    }}
                  >
                    Open that thread
                  </button>
                  {thread.parentThreadId && (
                    <button type="button" onClick={() => { bringBackSideChat(thread.id); }}>Bring back into main</button>
                  )}
                </div>
              </div>
            )}
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
                <h2 className="chat-mode-empty-heading">{standalone ? 'What are we working on?' : projectName ? `What should we work on in ${projectName}?` : 'What should we work on?'}</h2>
              </div>
            ) : messages.map((message) => {
              // An agent's turn-end record stays in the thread (its card reads
              // the report from it, and the inbox files it), but Chat does not
              // show it as a strip of its own: the agent's card already says
              // Finished or Failed and shows the report.
              if (message.type === 'completion') return null;
              if (message.completion?.taskId && cardTaskIds.has(message.completion.taskId)) return null;
              if (message.type === 'activity') {
                const group = toolGroups.get(message.id);
                // Members of an already-rendered run draw nothing; the run is
                // one card, not one row per notification.
                if (!group) return null;
                if (group.length === 1) {
                  return (
                    <div key={message.id} className="chat-mode-activity-card" role="status">
                      <span className="chat-mode-activity-dot" aria-hidden="true" />
                      <span>{message.text}</span>
                      <time>{formatTime(message.ts)}</time>
                    </div>
                  );
                }
                return <ToolActivityGroup key={`tool-group-${message.id}`} messages={group} />;
              }
              if (message.type === 'orchestrator') return null;

              return (
                <article
                  key={message.id}
                  id={`chat-msg-${message.id}`}
                  className={`chat-mode-message ${message.role}${findFlashId === message.id ? ' find-target' : ''}`}
                >
                  <div className="chat-mode-message-meta">
                    <strong>{messageLabel(message)}</strong>
                    <time>{formatTime(message.ts)}</time>
                    {thread.status !== 'working' && (
                      <button
                        type="button"
                        className="chat-mode-revert"
                        title="Fork the thread from here, keeping this one"
                        aria-label="Fork from this message"
                        onClick={() => forkFrom(message.id)}
                      >
                        ⑂
                      </button>
                    )}
                    {thread.status !== 'working' && message.id !== messages[0]?.id && (
                      <div className="chat-mode-revert-group">
                        <button
                          type="button"
                          className="chat-mode-revert"
                          title="Revert the thread to before this message"
                          aria-label="Revert to before this message"
                          onClick={() => revertToMessage(message.id)}
                        >
                          ↺
                        </button>
                        <label className="chat-mode-revert-restore">
                          <input
                            type="checkbox"
                            checked={revertRestoreFiles}
                            onChange={(event) => setRevertRestoreFiles(event.target.checked)}
                            aria-label="Also restore files to their state at this point"
                          />
                          Restore files
                        </label>
                      </div>
                    )}
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
                        {message.role === 'user' && editingMessageDraft.trim() !== message.text.trim() && (
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
                        {message.role === 'assistant' && <button type="button" className="primary" disabled={!editingMessageDraft.trim() || thread?.status === 'working' || thread?.status === 'needs-input'} onClick={() => void saveEditedResponse(message.id)}>Save</button>}
                      </div>
                    </div>
                  ) : <ChatMarkdownBody text={message.text} pending={message.pending} onOpenFile={openFileInViewer} />}
                  {message.files?.length && !message.pending ? (
                    <div className="chat-file-cards">
                      {message.files.map((file) => {
                        const name = file.path.replace(/\\/g, '/').split('/').pop() || file.path;
                        const active = viewerFile?.label === file.path;
                        return (
                          <button key={file.path} type="button" className={`chat-file-card${active ? ' active' : ''}`} onClick={() => active ? setViewerFile(null) : openFileInViewer(file.path)} title={`Open ${file.path}`}>
                            <ChatFileGlyph />
                            <span className="chat-file-card-text">
                              <strong>{name}</strong>
                              <span>{file.action === 'created' ? 'Created' : 'Edited'}{file.path !== name ? ` · ${file.path}` : ''}</span>
                            </span>
                            <span className="chat-file-card-open" aria-hidden="true">{active ? 'Close' : 'Open'}</span>
                          </button>
                        );
                      })}
                    </div>
                  ) : null}
                  <InlineCard
                    message={message}
                    onOption={message.inlineRequest && !message.inlineRequest.answeredAt
                      ? (option) => void answerPendingRequest(option, message.inlineRequest)
                      : undefined}
                  />
                  {agentRunsByMessage.has(message.id) && (
                    <ChatAgentRuns
                      tasks={agentRunsByMessage.get(message.id)!}
                      messages={messages}
                      onAnswer={answerAgent}
                    />
                  )}
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
                      {isUsageLimitFailure(message) && acpAgents.length > 1 && (
                        <button
                          type="button"
                          className="chat-mode-handoff-action"
                          onClick={() => void switchAndContinue(message)}
                          disabled={pendingSendCount > 0 || thread?.status === 'working'}
                        >
                          Switch agent and continue
                        </button>
                      )}
                    </div>
                  )}
                  {!message.pending && (
                    <div className="chat-mode-message-actions">
                      <button type="button" onClick={() => void copyMessage(message)} title="Copy message" aria-label="Copy message">
                        <CopyIcon />
                      </button>
                      {message.role === 'assistant' && canReadAloud && message.text.trim() && (
                        <button type="button" className={readingMessageId === message.id ? 'active' : undefined} onClick={() => toggleReadAloud(message.id, message.text)} title={readingMessageId === message.id ? 'Stop reading' : 'Read aloud'} aria-label={readingMessageId === message.id ? 'Stop reading' : 'Read aloud'} aria-pressed={readingMessageId === message.id}>
                          {readingMessageId === message.id ? <StopSpeakingIcon /> : <SpeakerIcon />}
                        </button>
                      )}
                      {/* Replies are the model's record of the turn; only your own messages can be edited and resent. */}
                      {message.role === 'user' && (
                        <button type="button" disabled={thread?.status === 'working' || thread?.status === 'needs-input'} onClick={() => beginEditMessage(message)} title="Edit message" aria-label="Edit message">
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

        {thread?.handoffs?.length ? (
          <div className="chat-mode-handoff-history" aria-label="Agent handoff history">
            <div className="chat-mode-handoff-history-title">Agent handoffs</div>
            {thread.handoffs.slice(-5).map((handoff) => (
              <div className={`chat-mode-handoff-row ${handoff.status}`} key={handoff.id}>
                <span>{handoff.sourceAgent} → {handoff.targetAgent}</span>
                <small>
                  {handoff.status === 'delivered'
                    ? 'Context delivered'
                    : handoff.status === 'failed'
                      ? handoff.failureReason ?? 'Delivery failed'
                      : 'Delivering context…'}
                </small>
              </div>
            ))}
          </div>
        ) : null}

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
          {agentPlan && !tickerOwnsPlan && (
            <div className="chat-mode-agent-plan" role="status" aria-label="Agent plan">
              <div className="chat-mode-agent-plan-head">
                <span>Agent plan</span>
                <span className="chat-mode-agent-plan-count">
                  {agentPlan.entries.filter((entry) => entry.status === 'completed').length}/{agentPlan.entries.length}
                </span>
              </div>
              <ul>
                {agentPlan.entries.map((entry, index) => (
                  <li key={`${entry.content}-${index}`} data-status={entry.status}>
                    <span className="chat-mode-agent-plan-mark" aria-hidden="true">
                      {entry.status === 'completed' ? '✓' : entry.status === 'in_progress' ? '●' : entry.status === 'cancelled' ? '−' : ''}
                    </span>
                    <span className="chat-mode-agent-plan-label">{entry.content}</span>
                  </li>
                ))}
              </ul>
            </div>
          )}
          {limitsOpen && (
            <div className="chat-mode-limits" role="status" aria-label="Usage limits">
              <div className="chat-mode-limits-head">
                <span>Usage limits</span>
                <button type="button" onClick={() => setLimitsOpen(false)} aria-label="Hide usage limits">×</button>
              </div>
              {limitProviders.length === 0 ? (
                <span className="chat-mode-limits-empty">
                  {usage.loading ? 'Reading limits…' : 'No metered limits reported. Sign in to an agent CLI, then run /limits again.'}
                </span>
              ) : limitProviders.map((provider) => (
                <div key={provider.provider} className="chat-mode-limits-provider">
                  <strong>{provider.name}{provider.plan ? ` · ${provider.plan}` : ''}</strong>
                  {provider.windows.map((window) => {
                    const reset = describeReset(window);
                    return (
                      <div key={`${provider.provider}-${window.label}`} className="chat-mode-limits-window" data-severity={severityOf(window.usedPercent)}>
                        <span className="chat-mode-limits-window-label">{window.label}</span>
                        <span className="chat-mode-limits-track" aria-hidden="true">
                          <span style={{ width: `${Math.min(100, Math.max(0, window.usedPercent))}%` }} />
                        </span>
                        <span className="chat-mode-limits-percent">{Math.round(window.usedPercent)}% used</span>
                        {reset && <span className="chat-mode-limits-reset">{reset}</span>}
                      </div>
                    );
                  })}
                  {provider.resetCreditsAvailable != null && provider.resetCreditsAvailable > 0 && (
                    <span className="chat-mode-limits-credits">
                      {provider.resetCreditsAvailable} reset credit{provider.resetCreditsAvailable === 1 ? '' : 's'} banked
                    </span>
                  )}
                </div>
              ))}
              <div className="chat-mode-limits-foot">
                <button
                  type="button"
                  className="chat-mode-limits-resume"
                  onClick={() => {
                    setLimitsOpen(false);
                    showToast('Resume-at-reset set: you will be notified when the earliest limit window resets.', 'info', 5000);
                  }}
                  aria-label="Resume at reset"
                >
                  Resume at reset
                </button>
              </div>
            </div>
          )}
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
          <form ref={composerRef} className={`chat-mode-composer${isComposerDragOver ? ' drag-over' : ''}`} onSubmit={(event) => { event.preventDefault(); void submit(); }} onDragOver={handleComposerDragOver} onDragLeave={handleComposerDragLeave} onDrop={(event) => void handleComposerDrop(event)}>
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
          {threadMentions.length > 0 && (
            <div className="chat-mode-attachment-list" aria-label="Mentioned threads">
              {threadMentions.map((threadId) => {
                const state = get(chatThreadState);
                const thread = project ? state.threadsByProject[project.id]?.find((t) => t.id === threadId) : null;
                return (
                  <span key={threadId} className="chat-mode-attachment-chip">
                    <span>@</span>
                    <span>{thread?.title ?? threadId}</span>
                    <button type="button" onClick={() => removeThreadMention(threadId)} aria-label={`Remove mention of ${thread?.title ?? threadId}`}>×</button>
                  </span>
                );
              })}
            </div>
          )}
              {threadPickerOpen && project && (
                <div className="chat-mode-thread-picker" role="listbox" aria-label="Mention a thread">
                  <div className="chat-mode-thread-picker-header">
                    <span>Mention thread</span>
                    <button type="button" onClick={closeThreadPicker} aria-label="Close">×</button>
                  </div>
                  {get(getProjectThreads(project.id)).map((thread) => (
                <button
                  key={thread.id}
                  type="button"
                  role="option"
                  onClick={() => mentionThread(thread.id)}
                  className={`chat-mode-thread-picker-row${threadMentions.includes(thread.id) ? ' mentioned' : ''}`}
                >
                  <span>{thread.title}</span>
                  <span className="chat-mode-thread-picker-hint">{thread.status}</span>
                </button>
              ))}
            </div>
          )}
          {slashMatches.length > 0 && (
            <div className="chat-mode-slash-menu" role="listbox" aria-label="Chat commands">
              {slashMatches.map((command, index) => (
                <button
                  key={command.name}
                  type="button"
                  role="option"
                  aria-selected={index === slashActive}
                  className={index === slashActive ? 'active' : ''}
                  onMouseDown={(event) => { event.preventDefault(); runSlashCommand(command); }}
                >
                  <span className="chat-mode-slash-name">/{command.name}</span>
                  <span className="chat-mode-slash-hint">{command.hint}</span>
                </button>
              ))}
            </div>
          )}
          <div className={`chat-mode-composer-input-shell${dictationLive ? ' is-dictating' : ''}`}>
            <textarea
              ref={textareaRef}
              value={composerValue}
              rows={1}
              onChange={(event) => { updateDraft(event.target.value); updateFileMention(event.target.value, event.target.selectionStart); }}
              onPaste={(event) => void handlePaste(event)}
              onKeyDown={(event) => {
                if (slashMatches.length > 0) {
                  if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
                    event.preventDefault();
                    const step = event.key === 'ArrowDown' ? 1 : -1;
                    setSlashAt((value) => (value + step + slashMatches.length) % slashMatches.length);
                    return;
                  }
                  if ((event.key === 'Enter' || event.key === 'Tab') && !event.shiftKey) {
                    event.preventDefault();
                    runSlashCommand(slashMatches[slashActive]);
                    return;
                  }
                  if (event.key === 'Escape') {
                    event.preventDefault();
                    updateDraft('');
                    return;
                  }
                }
                if (fileMention && fileMatches.length) {
                  if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
                    event.preventDefault();
                    setFileMatchIndex((index) => (index + (event.key === 'ArrowDown' ? 1 : fileMatches.length - 1)) % fileMatches.length);
                    return;
                  }
                  if (event.key === 'Enter' && !event.shiftKey) { event.preventDefault(); pickFileMention(fileMatches[fileMatchIndex]); return; }
                }
                if (event.key === 'Escape' && fileMention) { setFileMention(null); return; }
                // Enter sends; Shift+Enter keeps the native newline behavior.
                // Ignore IME composition commits so East Asian input methods do
                // not submit a message while the candidate text is composing.
                if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing && event.keyCode !== 229) {
                  event.preventDefault();
                  void submit();
                }
              }}
              placeholder={pendingRequest
                ? 'Answer the request above…'
                : project
                  ? `Message ${acpAgents.find((agent) => agent.command === selectedAcpAgent)?.name ?? 'the agent'}…`
                  : 'Select a project first'}
              disabled={!project || Boolean(pendingRequest)}
              aria-label="Message the selected agent"
            />
            {fileMention && fileMatches.length > 0 && (
              <div className="chat-mode-file-mentions" role="listbox" aria-label="Project files">
                {fileMatches.map((path, index) => (
                  <button key={path} type="button" role="option" aria-selected={index === fileMatchIndex}
                    onMouseDown={(event) => event.preventDefault()} onClick={() => pickFileMention(path)}>{path}</button>
                ))}
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
          {thread && <ThreadWorktreeBar thread={thread} projectId={project?.id ?? ''} />}
          <div className="chat-mode-composer-footer">
            <div className="chat-mode-composer-settings">
              <ChatAgentModelPicker
                agents={acpAgents}
                provider={selectedAcpAgent}
                model={selectedAcpModel}
                modelsFor={(command) => liveModelsByAgent[command] ?? [{ id: 'default', label: 'CLI default', description: 'Use the agent’s configured model.' }]}
                loadingProvider={loadingAgentModelsFor}
                boundarySelector=".chat-mode-panel"
                onPreviewProvider={(command) => ensureAgentModels(command)}
                onRefresh={(command) => ensureAgentModels(command, true)}
                onChange={(command, model) => {
                  const target = ensureConversationThread();
                  if (!target) return;
                  clearPendingNewThreadSettings(target.projectId);
                  updateChatThread(target.id, {
                    agentPreset: command,
                    agentName: acpAgents.find((agent) => agent.command === command)?.name ?? command,
                    model,
                    updatedAt: Date.now(),
                  });
                  ensureAgentModels(command);
                }}
                disabled={!thread && !standalone}
              />
              <div className="chat-mode-access-dropdown">
                <Dropdown
                  value={accessMode}
                  options={CHAT_ACCESS_TIERS.map((tier) => ({
                    value: tier,
                    label: CHAT_ACCESS_TIER_LABELS[tier],
                    tooltip: `${CHAT_ACCESS_TIER_LABELS[tier]}: ${CHAT_ACCESS_TIER_HINTS[tier]}`,
                  })) as DropdownOption[]}
                  onChange={selectAccess}
                  ariaLabel="Agent access"
                  disabled={!thread && !standalone}
                  boundarySelector=".chat-mode-panel"
                  disableTooltips
                />
              </div>
              <div className="chat-mode-work-dropdown">
                <Dropdown value={workMode} options={[
                  { value: 'build', label: 'Build', tooltip: 'Inspect and carry out the task using this thread’s access setting.' },
                  { value: 'plan', label: 'Plan', tooltip: 'Inspect the project and propose a plan without edits or agent dispatch.' },
                ]} onChange={(value) => {
                  const target = ensureConversationThread();
                  if (target) updateChatThread(target.id, { workMode: value === 'plan' ? 'plan' : 'build', updatedAt: Date.now() });
                }} ariaLabel="Chat work mode" disabled={!thread && !standalone} boundarySelector=".chat-mode-panel" disableTooltips />
              </div>
              {reasoningLevels.length > 0 && (
                <div className="chat-mode-reasoning-dropdown">
                  <ReasoningSlider
                    value={selectedReasoning}
                    levels={reasoningLevels}
                    onChange={(value) => {
                      const target = ensureConversationThread();
                      if (target) updateChatThread(target.id, { reasoningEffort: value, updatedAt: Date.now() });
                    }}
                    disabled={!thread && !standalone}
                    dropdown
                  />
                </div>
              )}
              {contextUsage && contextUsage.size > 0 && (
                <span
                  className="chat-mode-context-meter"
                  role="status"
                  title={`${contextUsage.used.toLocaleString()} of ${contextUsage.size.toLocaleString()} context tokens in use${contextUsage.cost ? ` · ${contextUsage.cost.amount.toFixed(2)} ${contextUsage.cost.currency} this turn` : ''}`}
                >
                  <span className="chat-mode-context-meter-track" aria-hidden="true">
                    <span
                      className={`chat-mode-context-meter-fill${contextUsage.used / contextUsage.size >= 0.9 ? ' full' : ''}`}
                      style={{ width: `${Math.min(100, Math.max(2, Math.round((contextUsage.used / contextUsage.size) * 100)))}%` }}
                    />
                  </span>
                  <span className="chat-mode-context-meter-label">
                    {formatTokenCount(contextUsage.used)}/{formatTokenCount(contextUsage.size)}
                  </span>
                </span>
              )}
              <ModelCapabilityBadges provider={selectedProvider} model={selectedModel} />
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
              <button type="button" className="chat-mode-composer-icon-btn" onClick={() => { if (standalone) ensureConversationThread(); fileInputRef.current?.click(); }} disabled={!project || attachmentBusy || attachments.length >= 5} title="Attach files or images (or drag and drop files here, paste images)" aria-label="Attach files or images"><PaperclipIcon /></button>
              <button type="button" className="chat-mode-composer-icon-btn" onClick={openThreadPicker} disabled={!project} title="@-mention another thread to bring its recent context into this message" aria-label="@-mention a thread">@</button>
              <button type="button" className={`chat-mode-composer-icon-btn${dictationLive ? ' active' : ''}`} onClick={toggleDictation} disabled={!project || transcriptionPhase === 'processing'} title={dictationLive ? 'Stop dictation and put the transcript in the composer' : 'Dictate a message'} aria-label="Dictate a message"><VoiceInputIcon className="chat-mode-composer-action-icon chat-mode-microphone-icon" /></button>
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
                  disabled={dictationLive || pendingSendCount > 0 || !(thread?.draft.trim() || attachments.length)}
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
          onRename={(previous, renamed) => {
            setViewer((current) => current ? {
              ...current, images: current.images.map((entry) => entry.path === previous.path ? renamed : entry),
            } : null);
            setAttachments((current) => current.map((entry) => entry.path?.replace(/\\/g, '/') === previous.path?.replace(/\\/g, '/')
              ? { ...entry, path: renamed.path, name: renamed.name } : entry));
          }}
          onUseAsInput={useImageAsInput}
          onEdit={editImage}
        />
      )}
    </section>
  );
}
