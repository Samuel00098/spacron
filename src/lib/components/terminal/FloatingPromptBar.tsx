import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { get } from '$lib/stores/storeCompat';
import { invoke } from '@tauri-apps/api/core';
import { getCurrentWindow } from '@tauri-apps/api/window';
import {
  activeSessionId,
  devActiveSessionId,
  manualPromptTargetId,
  sessions,
  devSessions,
  commandHistory,
  addHistoryEntry,
  setSessionExecuting,
  setSessionTaskSummary,
  summarizeTerminalTask,
  startCommandBlock,
  promptBarInput,
  promptBarImage,
  promptBarFocusRequest,
  promptBarVoiceModeRequest,
  activateSessionInPane,
  sendPromptToSession,
  getSessionLabel,
  getSessionPromptTargetLabel,
  isAgentSession,
} from '$lib/stores/terminal';
import { showToast } from '$lib/stores/notification';
import { createVoiceInputSession, mergeVoiceTranscript } from '$lib/services/voice-input';
import { isRealtimeVoiceSupported, startRealtimeVoiceSession, type RealtimeVoiceSession } from '$lib/services/realtime-voice';
import { isProviderApiKeyConfiguredLocal } from '$lib/services/ai-keychain';
import {
  openaiRealtimeModel,
  openaiRealtimeVoice,
  voiceConversationEngine,
  voiceInputProvider,
  voiceInputUsesModelTranscription,
  xaiRealtimeModel,
  xaiRealtimeVoice,
} from '$lib/stores/settings';
import { refineVoicePrompt } from '$lib/services/voice-refinement';
import { isTauriRuntime, isWebkitGtk } from '$lib/utils/tauri';
import { activeProject } from '$lib/stores/workspace';
import { layoutSnapshot } from '$lib/stores/layoutControl';
import {
  orchestratorTasks,
  sendChatMessage,
  chatMessages,
  agentForcedAgent,
  agentVoiceModeActive,
  appendVoiceExchangeMessage,
  type ChatMessage,
} from '$lib/stores/orchestrator';
import { describeTtsError, getVoiceReplyConfigError, speak, stopSpeaking, warmupLocalTts } from '$lib/services/tts';
import { openSettings } from '$lib/stores/layout';
import { requestRoomControl } from '$lib/stores/layoutControl';
import { addRunEntry } from '$lib/stores/runHistory';
import { isImagePath, getImageMimeType } from '$lib/stores/editor';
import { copyTextToClipboard, readImageFromClipboard, readTextFromClipboard } from '$lib/utils/clipboard';
import MentionDropdown from './MentionDropdown.tsx';
import type { FileEntry } from '$lib/types/explorer';
import { useStore } from '$lib/react/useStore';
import { useLayoutStore } from '$lib/stores/zustand/layout';
import '$lib/components/orchestrator/VoiceConversationOverlay.css';
import './FloatingPromptBar.css';

// WebKitGTK (Linux) gives our textarea no usable native right-click menu and
// blocks clipboard writes, so the prompt box needs its own copy/paste there.
// Windows/macOS keep their native menu untouched.
const isLinuxHost = typeof navigator !== 'undefined' &&
  navigator.userAgent.includes('Linux') && !navigator.userAgent.includes('Android');

// Spoken commands that pause / resume the conversational voice loop. Listed in
// NORMALIZED form (lowercase, no punctuation) — matchVoiceCommand() normalizes
// the transcript the same way and matches on whole-word boundaries, so "ready"
// wakes on "ready" but not "already", and punctuation / apostrophes / trailing
// words don't defeat a match. Extra variants cover common STT mishearings.
const SLEEP_KEYWORDS = ['go to sleep', 'goto sleep', 'stop listening', 'take a break', 'pause listening', 'sleep now', 'go to bed'];
const WAKE_KEYWORDS = ['wake up', 'wake', 'come back', 'resume listening', 'resume', 'listen up', 'ready', 'im back', 'i m back'];

/** Lowercase, strip punctuation, and collapse whitespace for command matching. */
function normalizeSpeech(s: string): string {
  return s.toLowerCase().replace(/[^\p{L}\p{N}\s]/gu, ' ').replace(/\s+/g, ' ').trim();
}

/** True if any normalized `phrase` appears as a whole word/phrase in `transcript`. */
function matchVoiceCommand(transcript: string, phrases: string[]): boolean {
  const padded = ` ${normalizeSpeech(transcript)} `;
  return phrases.some((p) => padded.includes(` ${p} `));
}

// System instructions for the GPT Realtime speech-to-speech engine. The model
// converses on its own and delegates real work to the orchestrator via the
// spacron_orchestrator tool (see realtime-voice.ts).
const REALTIME_VOICE_INSTRUCTIONS = [
  "You are Spacron's voice assistant. The user is a developer talking to you hands-free inside Spacron, a desktop app that orchestrates AI coding agents (Claude Code, Codex, Gemini and others) working in terminals on the user's projects.",
  'Personality: a sharp, friendly pair-programming partner. Sound natural and conversational — contractions, brief reactions, no corporate filler.',
  'Keep spoken replies short: one to three sentences unless the user asks for detail. Never read code, file paths, or long output aloud verbatim — summarize what it means instead.',
  'Whenever the user wants project work done or asked about — spawning or closing agents, giving an agent a task, checking progress or output, navigating the app — call the spacron_orchestrator tool with a clear standalone request, then relay its answer conversationally. For casual conversation, just talk; do not call the tool.',
  'Calling the tool executes the request immediately — there is no separate confirmation step after it. When the user clearly asked for something, call the tool right away instead of only saying you will. Only ask a clarifying question first when the request is ambiguous or destructive (like closing agents).',
  'If a tool result is long, give the gist and offer to go deeper.',
].join('\n');

// Per-project state cache
const barProjectCache = new Map<string, { inputValue: string; manualTargetId: number | null }>();

// `diskPath` is set when the image already exists on disk (attached via the
// file picker) so submitPrompt can reference it directly instead of re-saving
// a fresh copy — the agent then reads the exact file the user picked.
type PastedImage = { objectUrl: string; dataUrl: string; name: string; diskPath?: string };

// Map a clipboard image MIME type to a clean file extension. Splitting on "/"
// alone mangles compound subtypes (e.g. "image/svg+xml" -> "svgxml"), which
// would write a file with a bogus extension the agent can't open.
function extensionForMime(mime: string): string {
  switch (mime) {
    case 'image/png': return 'png';
    case 'image/apng': return 'apng';
    case 'image/jpeg': return 'jpg';
    case 'image/gif': return 'gif';
    case 'image/webp': return 'webp';
    case 'image/bmp': return 'bmp';
    case 'image/x-icon':
    case 'image/vnd.microsoft.icon': return 'ico';
    case 'image/svg+xml': return 'svg';
    case 'image/avif': return 'avif';
    case 'image/tiff': return 'tif';
    default: {
      const sub = (mime.split('/')[1] || 'png').replace(/[^a-z0-9]/gi, '').toLowerCase();
      return sub || 'png';
    }
  }
}

// Decode a data: URL into raw bytes locally. We deliberately avoid
// `fetch(dataUrl)` here: Chromium routes fetches of data: URLs through the
// `connect-src` CSP directive, which doesn't allow `data:` — so fetch throws
// and the pasted image is silently dropped before it ever reaches the agent.
function dataUrlToBytes(dataUrl: string): Uint8Array {
  const comma = dataUrl.indexOf(',');
  if (comma === -1) return new Uint8Array();
  const meta = dataUrl.slice(0, comma);
  const body = dataUrl.slice(comma + 1);
  const raw = meta.includes(';base64') ? atob(body) : decodeURIComponent(body);
  const bytes = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) bytes[i] = raw.charCodeAt(i);
  return bytes;
}

// Encode raw clipboard RGBA into a PNG data URL via a canvas. Used for the Linux
// clipboard-image paste path, where the native plugin hands us raw pixels rather
// than an encoded image.
function rgbaToPngDataUrl(bytes: Uint8Array, width: number, height: number): string | null {
  if (typeof document === 'undefined') return null;
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d');
  if (!ctx) return null;
  const imageData = ctx.createImageData(width, height);
  imageData.data.set(bytes.subarray(0, imageData.data.length));
  ctx.putImageData(imageData, 0, 0);
  return canvas.toDataURL('image/png');
}

function stripMarkdown(text: string): string {
  return text
    .replace(/```[\s\S]*?```/g, '')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/\*([^*]+)\*/g, '$1')
    .replace(/#+\s+/g, '')
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
    .replace(/^[-*+]\s+/gm, '')
    .replace(/\n+/g, ' ')
    .trim();
}

function speechTextForAssistantMessage(message: ChatMessage): string {
  if (message.completion) {
    const c = message.completion;
    const status =
      c.status === 'done' ? 'finished' :
      c.status === 'failed' ? 'failed' :
      'needs your input';
    const pieces = [
      `${c.agentName} ${status}: ${c.taskTitle}.`,
      c.reason ? `Reason: ${c.reason}.` : '',
      c.summary ? c.summary : c.summaryPending ? 'I am still summarizing the terminal output.' : '',
    ];
    return pieces.filter(Boolean).join(' ');
  }
  return message.text;
}

function speechKeyForAssistantMessage(message: ChatMessage): string {
  const spoken = stripMarkdown(speechTextForAssistantMessage(message).split('\n\n🔍')[0]);
  return `${message.id}:${spoken}`;
}

function useSyncedState<T>(initialValue: T) {
  const [value, setValueState] = useState(initialValue);
  const valueRef = useRef(value);
  const setValue = useCallback((next: T | ((current: T) => T)) => {
    const resolved = typeof next === 'function'
      ? (next as (current: T) => T)(valueRef.current)
      : next;
    valueRef.current = resolved;
    setValueState(resolved);
  }, []);
  return [value, setValue, valueRef] as const;
}

export default function FloatingPromptBar() {
  const isDev = useStore(layoutSnapshot).ambient === 'development';
  const $activeSessionId = useStore(isDev ? devActiveSessionId : activeSessionId);
  const $manualPromptTargetId = useStore(manualPromptTargetId);
  const $sessions = useStore(isDev ? devSessions : sessions);
  const $commandHistory = useStore(commandHistory);
  const $activeProject = useStore(activeProject);
  const $orchestratorTasks = useStore(orchestratorTasks);
  const $chatMessages = useStore(chatMessages);
  const $promptBarInput = useStore(promptBarInput);
  const $promptBarImage = useStore(promptBarImage);
  const $promptBarFocusRequest = useStore(promptBarFocusRequest);
  const $promptBarVoiceModeRequest = useStore(promptBarVoiceModeRequest);

  const lastBarProjectIdRef = useRef<string | null>(null);

  const [inputValue, setInputValue, inputValueRef] = useSyncedState('');
  const inputElRef = useRef<HTMLTextAreaElement | null>(null);
  const [, setHistoryIndex] = useState(-1);
  const draftBeforeHistoryRef = useRef('');
  const [historyOpen, setHistoryOpen] = useState(false);
  const [isListening, setIsListening, isListeningRef] = useSyncedState(false);
  const [isRefining, setIsRefining, isRefiningRef] = useSyncedState(false);
  const [voiceLocked, setVoiceLocked] = useSyncedState(false);
  const [, setVoiceHeld] = useSyncedState(false);
  const [, setVoiceStopping, voiceStoppingRef] = useSyncedState(false);
  const shellElRef = useRef<HTMLDivElement | null>(null);
  const barElRef = useRef<HTMLDivElement | null>(null);
  const [draggedExplorerPath, setDraggedExplorerPath] = useState<string | null>(null);
  const [lastExplorerDragPoint, setLastExplorerDragPoint] = useState<{ x: number; y: number } | null>(null);
  // Guard: when the React drop handler fires first, suppress the document-level handler
  const internalDropHandledRef = useRef(false);
  const [, setIsHovered] = useState(false);
  const [, setIsFocused] = useState(false);
  const [isExpanded, setIsExpanded] = useState(false);
  const [isDragOver, setIsDragOver] = useState(false);
  const [isGlobalFileDrag, setIsGlobalFileDrag] = useState(false);
  const [targetPickerOpen, setTargetPickerOpen] = useState(false);
  const voiceDraftBaseRef = useRef('');
  const [voiceDraftText, setVoiceDraftText, voiceDraftTextRef] = useSyncedState('');
  const [isAgentMode, setIsAgentMode] = useState(true);
  const [agentSending, setAgentSending, agentSendingRef] = useSyncedState(false);
  const [voiceModeActive, setVoiceModeActive, voiceModeActiveRef] = useSyncedState(false);
  const [isTtsSpeaking, setIsTtsSpeaking, isTtsSpeakingRef] = useSyncedState(false);
  const [voiceSleeping, setVoiceSleeping, voiceSleepingRef] = useSyncedState(false);
  const [audioRms, setAudioRms] = useState(0);
  const lastSpokenMessageKeyRef = useRef<string | null>(null);
  const [pastedImages, setPastedImages] = useState<PastedImage[]>([]);
  const [pastedFiles, setPastedFiles] = useState<Array<{ name: string; path: string }>>([]);
  const [mentionQuery, setMentionQuery] = useState<string | null>(null);
  const [mentionSelectedIndex, setMentionSelectedIndex] = useState(0);
  const [expandedImage, setExpandedImage] = useState<string | null>(null);
  const transcriptElRef = useRef<HTMLDivElement | null>(null);

  const hasPromptText = inputValue.trim().length > 0;
  const isActive = true;

  const waitingTaskCount = useMemo(
    () => $orchestratorTasks.filter(
      (t) => t.projectId === ($activeProject?.id ?? '') && t.status === 'blocked'
    ).length,
    [$orchestratorTasks, $activeProject]
  );

  const projectChatMessages = useMemo(
    () => $chatMessages[$activeProject?.id ?? ''] ?? [],
    [$chatMessages, $activeProject]
  );

  const isVoiceActive = isAgentMode && voiceModeActive;

  // Agent task cards for CNVS-like running/waiting/done state visualization
  const activeTerminal = useMemo(
    () => $sessions.find((session) => session.id === $activeSessionId) ?? null,
    [$sessions, $activeSessionId]
  );
  const preferredAgentTerminal = useMemo(
    () => (
      isAgentSession(activeTerminal)
        ? activeTerminal
        : ($sessions
            .filter((session) => session.isRunning && isAgentSession(session))
            .sort((a, b) => (b.lastActivatedAt ?? 0) - (a.lastActivatedAt ?? 0))[0] ?? null)
    ),
    [activeTerminal, $sessions]
  );
  // Prefer a running agent as the target so a terminal-mode prompt reaches an
  // agent for a response (routing it through the auto-submitting paste path)
  // instead of running as a command in whatever shell pane happens to be focused.
  // `preferredAgentTerminal` already returns the focused pane when it's itself an
  // agent, so this still respects "the agent I'm looking at"; it only overrides a
  // non-agent active pane, and falls back to that shell when no agent is running.
  const autoTarget = preferredAgentTerminal ?? activeTerminal;
  const manualTarget = useMemo(
    () => {
      if ($manualPromptTargetId === null) return null;
      return ($sessions.find((s) => s.id === $manualPromptTargetId && s.isRunning) ?? null);
    },
    [$manualPromptTargetId, $sessions]
  );
  const promptTarget = manualTarget ?? autoTarget;
  // "Pinned" only when the user deliberately targets a terminal other than the
  // active one (via the picker). Focusing a pane keeps target === active = auto.
  const isPinned = $manualPromptTargetId !== null && $manualPromptTargetId !== $activeSessionId;
  const runningSessions = useMemo(() => $sessions.filter((s) => s.isRunning), [$sessions]);
  const historyItems = useMemo(() => ($commandHistory || []).slice(0, 12), [$commandHistory]);
  const canSend = isAgentMode
    ? Boolean($activeProject) && !agentSending
    : Boolean(promptTarget?.isRunning);

  const focusInput = useCallback(() => {
    requestAnimationFrame(() => inputElRef.current?.focus());
  }, []);

  const adjustInputHeight = useCallback(() => {
    const inputEl = inputElRef.current;
    if (!inputEl) return;
    // Grow the box with typed content up to three lines; past that it stops
    // growing and scrolls internally (overflow-y: auto in the CSS). The cap is
    // derived from the live computed line-height so it stays correct across the
    // responsive font-size breakpoints instead of a hard-coded pixel count.
    const cs = window.getComputedStyle(inputEl);
    const lineHeight = parseFloat(cs.lineHeight) || 21;
    const padding = (parseFloat(cs.paddingTop) || 0) + (parseFloat(cs.paddingBottom) || 0);
    const oneLine = lineHeight + padding;
    const maxHeight = lineHeight * 3 + padding;
    if (!inputEl.value) {
      inputEl.style.height = `${oneLine}px`;
      return;
    }
    inputEl.style.height = '0px';
    const nextHeight = Math.min(inputEl.scrollHeight, maxHeight);
    inputEl.style.height = `${Math.max(nextHeight, oneLine)}px`;
  }, []);

  const resetHistoryCursor = useCallback(() => {
    setHistoryIndex(-1);
    draftBeforeHistoryRef.current = '';
  }, []);

  // Per-project state: save/restore inputValue and pinned target when project changes
  useEffect(() => {
    const projectId = $activeProject?.id ?? null;
    if (projectId === lastBarProjectIdRef.current) return;

    if (lastBarProjectIdRef.current !== null) {
      barProjectCache.set(lastBarProjectIdRef.current, { inputValue, manualTargetId: get(manualPromptTargetId) });
    }

    if (projectId !== null) {
      const cached = barProjectCache.get(projectId);
      setInputValue(cached?.inputValue ?? '');
      const sessionAlive = cached?.manualTargetId != null &&
        get(sessions).some((s) => s.id === cached.manualTargetId && s.isRunning);
      manualPromptTargetId.set(sessionAlive ? (cached?.manualTargetId ?? null) : null);
    } else {
      setInputValue('');
      manualPromptTargetId.set(null);
    }

    lastBarProjectIdRef.current = projectId;
    setHistoryIndex(-1);
    draftBeforeHistoryRef.current = '';
    setHistoryOpen(false);
    setTargetPickerOpen(false);
    requestAnimationFrame(adjustInputHeight);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [$activeProject]);

  // Clear manual pin if the session dies
  useEffect(() => {
    if ($manualPromptTargetId !== null && !$sessions.find((s) => s.id === $manualPromptTargetId && s.isRunning)) {
      manualPromptTargetId.set(null);
    }
  }, [$manualPromptTargetId, $sessions]);

  const selectTarget = useCallback((id: number) => {
    manualPromptTargetId.set(id);
    setTargetPickerOpen(false);
    focusInput();
  }, [focusInput]);

  const toggleTargetPicker = useCallback(() => {
    setTargetPickerOpen((v) => !v);
    setHistoryOpen(false);
  }, []);

  const resolvePromptTarget = useCallback(() => {
    const isDevLayout = get(layoutSnapshot).ambient === 'development';
    const allSessions = get(isDevLayout ? devSessions : sessions);
    const pinnedId = get(manualPromptTargetId);
    if (pinnedId !== null) {
      const manual = allSessions.find((s) => s.id === pinnedId && s.isRunning);
      if (manual) return manual;
    }
    const currentActiveSessionId = get(isDevLayout ? devActiveSessionId : activeSessionId);
    const currentActiveTerminal = allSessions.find((session) => session.id === currentActiveSessionId) ?? null;
    // The focused pane wins only when it's itself an agent (the one you're looking
    // at). Otherwise prefer the most recently used running agent over a non-agent
    // active pane, so the prompt actually reaches an agent for a response (and
    // takes the auto-submitting paste path) instead of running as a shell command.
    // Falls back to the focused shell only when no agent is running.
    if (currentActiveTerminal && isAgentSession(currentActiveTerminal)) return currentActiveTerminal;
    const runningAgent = allSessions
      .filter((session) => session.isRunning && isAgentSession(session))
      .sort((a, b) => (b.lastActivatedAt ?? 0) - (a.lastActivatedAt ?? 0))[0] ?? null;
    return runningAgent ?? currentActiveTerminal;
  }, []);

  const openPromptBar = useCallback(() => {
    setIsExpanded(true);
    setIsFocused(true);
    focusInput();
  }, [focusInput]);

  const canStayOpen = useCallback(() => {
    return hasPromptText || historyOpen || targetPickerOpen || isListening || isRefining || isDragOver || (!draggedExplorerPath && isGlobalFileDrag) || voiceModeActive;
  }, [hasPromptText, historyOpen, targetPickerOpen, isListening, isRefining, isDragOver, draggedExplorerPath, isGlobalFileDrag, voiceModeActive]);

  const enterAgentMode = useCallback(() => {
    if (isAgentMode) {
      focusInput();
      return;
    }
    setIsAgentMode(true);
    setHistoryOpen(false);
    setTargetPickerOpen(false);
    focusInput();
  }, [isAgentMode, focusInput]);

  const handleShellFocusOut = useCallback((event: React.FocusEvent) => {
    setIsFocused(false);
    const next = event.relatedTarget as Node | null;
    if (shellElRef.current && next && shellElRef.current.contains(next)) return;
    if (!canStayOpen()) setIsExpanded(false);
  }, [canStayOpen]);

  const sendPromptToTarget = useCallback((sessionId: number, text: string, agentPreset?: string | null) => {
    sendPromptToSession(sessionId, text, agentPreset);
  }, []);



  const saveImageToDisk = useCallback(async (img: PastedImage): Promise<string | null> => {
    // Write under the project's `.spacron/` dir (already the app's project-local
    // scratch area and in the orchestrator's skip-dirs), NOT the OS temp dir: the
    // fs_write_binary command enforces require_in_project, so a temp path outside
    // the project root is rejected and the attachment silently fails on every OS.
    const root = $activeProject?.root_path;
    if (!root) return null;
    try {
      const base = root.replace(/\\/g, '/').replace(/\/+$/, '');
      const dir = `${base}/.spacron/paste`;
      // Sanitize to a bare filename so a name can't traverse out of the dir.
      const safeName = (img.name.split(/[/\\]/).pop() || 'image.png').replace(/^\.+/, '');
      try {
        await invoke('fs_create_dir', { path: dir });
      } catch {
        /* already exists */
      }
      const savePath = `${dir}/${safeName}`;
      const data = Array.from(dataUrlToBytes(img.dataUrl));
      await invoke('fs_write_binary', { path: savePath, data });
      return savePath;
    } catch (error) {
      console.error('Failed to save pasted image to disk:', error);
      return null;
    }
  }, [$activeProject]);

  const removeImage = useCallback((index: number) => {
    setPastedImages((prev) => {
      const img = prev[index];
      if (img) URL.revokeObjectURL(img.objectUrl);
      return prev.filter((_, i) => i !== index);
    });
  }, []);

  const addFileChip = useCallback((filePath: string) => {
    const name = filePath.split(/[/\\]/).pop() || filePath;
    const path = filePath.replace(/\\/g, '/');
    // Dedup by path: chips are keyed by file.path, so attaching the same file
    // twice (e.g. drag then @-mention) would produce duplicate React keys and
    // make removeFile(index) target the wrong chip.
    setPastedFiles((prev) => (prev.some((f) => f.path === path) ? prev : [...prev, { name, path }]));
  }, []);

  const removeFile = useCallback((index: number) => {
    setPastedFiles((prev) => prev.filter((_, i) => i !== index));
  }, []);

  // Pull an image off the native clipboard (Linux/WebKitGTK fallback) and add it
  // as a preview chip. Returns true when an image was found and attached.
  const addNativeClipboardImage = useCallback(async (): Promise<boolean> => {
    const img = await readImageFromClipboard();
    if (!img) return false;
    const dataUrl = rgbaToPngDataUrl(img.bytes, img.width, img.height);
    if (!dataUrl) return false;
    const blob = new Blob([dataUrlToBytes(dataUrl)], { type: 'image/png' });
    const objectUrl = URL.createObjectURL(blob);
    const name = `paste-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.png`;
    setPastedImages((prev) => [...prev, { objectUrl, dataUrl, name }]);
    return true;
  }, []);

  const handlePaste = useCallback(async (e: React.ClipboardEvent) => {
    const items = Array.from(e.clipboardData?.items ?? []);
    const imageItems = items.filter((item) => item.type.startsWith('image/'));
    if (!imageItems.length) {
      // WebKitGTK never exposes clipboard images through the paste event, so fall
      // back to reading them natively. Only do this when the clipboard carried no
      // text/files to paste — otherwise let the default text paste run untouched.
      const hasOther = items.some((item) => item.kind !== 'image');
      if (!hasOther && isTauriRuntime()) {
        void addNativeClipboardImage();
      }
      return;
    }
    e.preventDefault();
    for (const item of imageItems) {
      const blob = item.getAsFile();
      if (!blob) continue;
      // Unique name (timestamp + random) so two images pasted at once never
      // collide; keep the real extension so the agent reads the right format.
      const ext = extensionForMime(item.type);
      const name = `paste-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.${ext}`;
      const objectUrl = URL.createObjectURL(blob);
      const dataUrl = await new Promise<string>((resolve) => {
        const reader = new FileReader();
        reader.onloadend = () => resolve(reader.result as string);
        reader.readAsDataURL(blob);
      });
      setPastedImages((prev) => [...prev, { objectUrl, dataUrl, name }]);
    }
  }, [addNativeClipboardImage]);

  // Write any attached/pasted images to disk and return their on-disk paths,
  // so both the agent-chat path and the terminal path can fold attachments into
  // the message text identically. Clipboard-pasted images are saved to the OS
  // temp directory (so they never bloat the project); file-picked images already
  // have a diskPath and are referenced in-place. Non-image files are collected
  // from pastedFiles chips and appended as raw paths.
  const materializeAttachments = useCallback(async (): Promise<{ paths: string[]; ok: boolean }> => {
    const filePaths = pastedFiles.map((f) => f.path);
    setPastedFiles([]);
    if (pastedImages.length === 0) return { paths: filePaths, ok: true };
    const toSave = [...pastedImages];
    setPastedImages([]);
    const imagePaths = await Promise.all(
      toSave.map((img) =>
        img.diskPath
          ? Promise.resolve(img.diskPath.replace(/\\/g, '/'))
          : saveImageToDisk(img)
      )
    );
    const validImagePaths = imagePaths.filter(Boolean) as string[];
    const failedCount = toSave.length - validImagePaths.length;
    if (failedCount > 0) {
      showToast(
        failedCount === toSave.length
          ? `Couldn't attach ${toSave.length === 1 ? 'the image' : 'the images'}`
          : `Couldn't attach ${failedCount} of ${toSave.length} images`,
        'error'
      );
    }
    toSave.forEach((img) => URL.revokeObjectURL(img.objectUrl));
    return { paths: [...validImagePaths, ...filePaths], ok: true };
  }, [pastedImages, pastedFiles, saveImageToDisk]);

  // Quote only paths with spaces — matches attachPathsToInput and is friendlier
  // to agent TUIs than always-single-quoting (which leaves literal quotes the
  // CLI then can't open).
  const appendAttachmentPaths = useCallback((text: string, paths: string[]): string => {
    if (!paths.length) return text;
    const quoted = paths.map((p) => (p.includes(' ') ? `"${p}"` : p)).join(' ');
    return text ? `${text} ${quoted}` : quoted;
  }, []);

  // Single source of truth for "should the mic come back on now?" in the
  // conversational voice loop. Every terminal point of a turn (dispatch done,
  // speech done, a transcript that errored out) funnels through here instead of
  // repeating the guard, so the loop can never get wedged with the mic off while
  // nothing else is running. The internal guards in voiceInput.start() make a
  // redundant call from two racing finalizers a harmless no-op.
  const resumeVoiceLoopRef = useRef<() => void>(() => {});

  // Late-bound handle to stopAgentVoice so the once-created voiceInput callbacks
  // (onError) can tear voice mode down without depending on definition order.
  const stopAgentVoiceRef = useRef<() => void>(() => {});

  const submitAgentMessageRef = useRef<(textOverride?: string) => Promise<void>>(async () => {});

  // Live GPT Realtime session (speech-to-speech engine). When it's active the
  // classic pipeline (voiceInput loop + auto-speak TTS) must stay dormant: the
  // realtime call owns the mic and speaks for itself.
  const realtimeSessionRef = useRef<RealtimeVoiceSession | null>(null);
  const realtimeActiveRef = useRef(false);

  // Barge-in (interrupt the assistant mid-sentence, like the GPT Realtime
  // engine): keep the mic live while the reply TTS plays, so onSpeechStart can
  // cut playback and the utterance becomes the next turn. Only where it's safe:
  // - not on WebKitGTK, whose echoCancellation is a no-op — the mic would hear
  //   the reply audio and the assistant would cut itself off;
  // - only for raw-audio input providers. Web Speech runs its own recognizer,
  //   which would transcribe the assistant's reply as user input.
  // The raised VAD playback gate (voiceInput.setPlaybackActive) filters out the
  // echo residue that survives cancellation.
  const bargeInSupported = () =>
    !isWebkitGtk() && voiceInputUsesModelTranscription(get(voiceInputProvider));

  useEffect(() => {
    resumeVoiceLoopRef.current = () => {
      if (
        !realtimeActiveRef.current &&
        voiceModeActiveRef.current &&
        isAgentModeRef.current &&
        !voiceStoppingRef.current &&
        !isListeningRef.current &&
        !isRefiningRef.current &&
        !agentSendingRef.current &&
        // With barge-in support the mic listens straight through TTS playback.
        // Otherwise don't reopen it while TTS is speaking; speakResponse()'s
        // finally re-invokes this the instant TTS ends.
        (!isTtsSpeakingRef.current || bargeInSupported())
      ) {
        // When sleeping, still keep the mic on so the wake word can be heard
        void voiceInput.start();
      }
    };
  });

  const speakResponse = useCallback(async (text: string) => {
    // Drop the transient "🔍 Analyzing codebase…" status the orchestrator appends
    // to the reply while reconnaissance runs — we only want to speak the reply.
    const clean = stripMarkdown(text.split('\n\n🔍')[0]);
    if (!clean || clean.length < 3) {
      setIsTtsSpeaking(false);
      resumeVoiceLoopRef.current();
      return;
    }
    try {
      // Raise the VAD's speech-onset gate for the duration of playback so the
      // live barge-in mic isn't tripped by the reply's own echo.
      voiceInput.setPlaybackActive(true);
      await speak(clean);
    } catch (error) {
      if (voiceModeActive) showToast(describeTtsError(error), 'error');
    } finally {
      voiceInput.setPlaybackActive(false);
      setIsTtsSpeaking(false);
      resumeVoiceLoopRef.current();
    }
  }, [voiceModeActive]);

  const stopAgentVoice = useCallback(() => {
    setVoiceModeActive(false);
    agentVoiceModeActive.set(false);
    setIsTtsSpeaking(false);
    setVoiceSleeping(false);
    lastSpokenMessageKeyRef.current = null;
    stopSpeaking();
    setVoiceLocked(false);
    setVoiceHeld(false);
    // Null the session ref BEFORE stopping so the session's onEnded callback
    // (which fires from stop()) sees it gone and doesn't re-enter this teardown.
    const realtimeSession = realtimeSessionRef.current;
    realtimeSessionRef.current = null;
    realtimeActiveRef.current = false;
    if (realtimeSession) {
      realtimeSession.stop();
      setIsListening(false);
      setIsRefining(false);
      setVoiceStopping(false);
      focusInput();
      return;
    }
    setVoiceStopping(true);
    voiceInput.setConversationMode(false);
    voiceInput.stop();
    focusInput();
  }, [focusInput]);

  useEffect(() => {
    stopAgentVoiceRef.current = stopAgentVoice;
  }, [stopAgentVoice]);

  // Bridge from the GPT Realtime model to the orchestrator brain: the model
  // calls its spacron_orchestrator tool, we run the request through the same
  // sendChatMessage path the pipeline uses, and hand back the brain's reply for
  // the model to speak. Chat logging comes for free from sendChatMessage.
  const runRealtimeOrchestratorCommand = useCallback(async (request: string): Promise<string> => {
    const project = get(activeProject);
    if (!project) return 'No project is open right now.';
    setAgentSending(true);
    try {
      await sendChatMessage(project.id, project.root_path, request, {
        forcedAgent: get(agentForcedAgent),
        voiceConversation: true,
        // The realtime model rephrases every request, so the orchestrator's
        // "yes"/"no" confirmation round-trip can never complete — the model
        // confirms with the user verbally before calling the tool instead.
        skipConfirmation: true,
      });
    } finally {
      setAgentSending(false);
    }
    const messages = get(chatMessages)[project.id] ?? [];
    for (let i = messages.length - 1; i >= 0; i -= 1) {
      const message = messages[i];
      if (message.role === 'assistant' && !message.pending && message.text?.trim()) {
        return message.text.trim();
      }
      if (message.role === 'user') break;
    }
    return 'The orchestrator accepted the request.';
  }, [setAgentSending]);

  const startRealtimeVoiceMode = useCallback((engine: 'openai-realtime' | 'xai-realtime') => {
    const provider = engine === 'xai-realtime' ? ('xai' as const) : ('openai' as const);
    const label = provider === 'xai' ? 'Grok Realtime' : 'GPT Realtime';
    if (!isRealtimeVoiceSupported(provider)) {
      showToast(`${label} voice isn't supported in this runtime. Pick the standard engine in Settings → Voice.`, 'warning');
      openSettings();
      return;
    }
    if (!isProviderApiKeyConfiguredLocal(provider)) {
      showToast(`${label} needs an ${provider === 'xai' ? 'xAI' : 'OpenAI'} API key. Add it in Settings, or switch the conversation engine.`, 'warning');
      openSettings();
      return;
    }
    setVoiceModeActive(true);
    agentVoiceModeActive.set(true);
    realtimeActiveRef.current = true;
    setIsRefining(true); // "thinking" orb while the call connects

    void (async () => {
      try {
        const session = await startRealtimeVoiceSession({
          provider,
          model: get(provider === 'xai' ? xaiRealtimeModel : openaiRealtimeModel),
          voice: get(provider === 'xai' ? xaiRealtimeVoice : openaiRealtimeVoice),
          instructions: REALTIME_VOICE_INSTRUCTIONS,
          callbacks: {
            onStateChange: (state) => {
              setIsRefining(state === 'connecting' || state === 'thinking');
              setIsListening(state === 'listening');
              setIsTtsSpeaking(state === 'speaking');
            },
            onUserTranscript: (text) => {
              const project = get(activeProject);
              if (project) appendVoiceExchangeMessage(project.id, 'user', text);
            },
            onAssistantTranscript: (text, final) => {
              if (!final) return;
              const project = get(activeProject);
              if (project) appendVoiceExchangeMessage(project.id, 'assistant', text);
            },
            onOrchestratorCommand: runRealtimeOrchestratorCommand,
            onError: (message) => showToast(message, 'error'),
            onEnded: () => {
              // Fires for a spontaneous transport failure as well as stop().
              // A user-initiated stop already nulled the ref, so this only acts
              // when the connection died on its own.
              if (realtimeSessionRef.current) {
                realtimeSessionRef.current = null;
                realtimeActiveRef.current = false;
                if (voiceModeActiveRef.current) stopAgentVoiceRef.current();
              }
            },
          },
        });
        if (!realtimeActiveRef.current) {
          // The user exited voice mode while the call was still connecting.
          session.stop();
          return;
        }
        realtimeSessionRef.current = session;
      } catch (error) {
        realtimeActiveRef.current = false;
        setIsRefining(false);
        showToast(error instanceof Error ? error.message : `Could not start ${label} voice.`, 'error');
        stopAgentVoiceRef.current();
      }
    })();
  }, [runRealtimeOrchestratorCommand, setIsListening, setIsRefining, setIsTtsSpeaking, setVoiceModeActive]);

  const toggleAgentVoiceMode = useCallback(() => {
    if (voiceModeActive) { stopAgentVoice(); return; }
    // The realtime engines (GPT Realtime / Grok Realtime) replace the whole
    // STT → brain → TTS loop with one speech-to-speech call; none of the
    // pipeline validation below applies.
    const engine = get(voiceConversationEngine);
    if (engine === 'openai-realtime' || engine === 'xai-realtime') {
      startRealtimeVoiceMode(engine);
      return;
    }
    // Validate voice *input* first: entering with an unsupported input provider
    // (e.g. the default Web Speech provider on Linux/WebKitGTK, whose recognizer
    // doesn't exist) would open the overlay on the idle orb with a mic that never
    // engages — the "headphone icon that never picks anything up" wedge.
    if (!voiceInput.isSupported()) {
      showToast(
        isWebkitGtk()
          ? "Web Speech voice input isn't available on Linux. Pick a local or cloud voice provider in Settings → Voice."
          : 'Voice input is not supported in this runtime. Pick a voice provider in Settings → Voice.',
        'warning',
      );
      openSettings();
      return;
    }
    const replyVoiceError = getVoiceReplyConfigError();
    if (replyVoiceError) {
      showToast(replyVoiceError, 'warning');
      openSettings();
      return;
    }
    // Seed with the current last assistant message so entering voice mode opens
    // straight into listening instead of re-speaking the reply already on screen.
    const lastMsg = projectChatMessages.at(-1);
    lastSpokenMessageKeyRef.current = lastMsg && lastMsg.role === 'assistant' && !lastMsg.pending ? speechKeyForAssistantMessage(lastMsg) : null;
    setVoiceModeActive(true);
    agentVoiceModeActive.set(true);
    // Warm the local speech engine now so the first reply isn't stalled on a
    // cold WASM/ONNX start (no-op for cloud providers).
    warmupLocalTts();
    // Keep the mic warm between turns so each turn re-arms instantly instead of
    // re-acquiring the mic (getUserMedia + AudioContext + warmup) every time.
    voiceInput.setConversationMode(true);
    void voiceInput.start();
  }, [voiceModeActive, stopAgentVoice, projectChatMessages, startRealtimeVoiceMode]);

  const launchAgentVoiceMode = useCallback(() => {
    openPromptBar();
    enterAgentMode();
    if (!voiceModeActive) {
      toggleAgentVoiceMode();
    }
  }, [openPromptBar, enterAgentMode, voiceModeActive, toggleAgentVoiceMode]);

  const toggleAgentMode = useCallback(() => {
    if (isAgentMode) {
      if (voiceModeActive) stopAgentVoice();
      setIsAgentMode(false);
      focusInput();
      return;
    }
    enterAgentMode();
    toggleAgentVoiceMode();
  }, [isAgentMode, voiceModeActive, stopAgentVoice, focusInput, enterAgentMode, toggleAgentVoiceMode]);

  const submitAgentMessage = useCallback(async (textOverride?: string) => {
    if (!$activeProject || agentSendingRef.current) return;
    const { paths, ok } = await materializeAttachments();
    if (!ok) return;
    const promptText = (textOverride ?? inputValueRef.current).trim();
    const finalText = appendAttachmentPaths(promptText, paths);
    if (!finalText) return;
    setInputValue('');
    setAgentSending(true);
    try {
      await sendChatMessage($activeProject.id, $activeProject.root_path, finalText, {
        forcedAgent: get(agentForcedAgent),
        voiceConversation: voiceModeActiveRef.current,
      });
    } finally {
      setAgentSending(false);
      resumeVoiceLoopRef.current();
    }
    resetHistoryCursor();
      requestAnimationFrame(adjustInputHeight);
      focusInput();
  }, [$activeProject, materializeAttachments, appendAttachmentPaths, inputValueRef, resetHistoryCursor, adjustInputHeight, focusInput]);

  useEffect(() => {
    submitAgentMessageRef.current = submitAgentMessage;
  }, [submitAgentMessage]);

  // Auto-speak new assistant messages in agent voice mode.
  // Deliberately NOT gated on `agentSending`: the conversational reply is ready
  // the moment routing finishes (well before recon + spawn + dispatch complete),
  // so speaking it immediately removes seconds of dead air. Background dispatch
  // keeps running while TTS plays; the mic resumes when dispatch finishes
  // (see submitAgentMessage's finally) or when TTS ends (see speakResponse).
  useEffect(() => {
    if (!voiceModeActive || !isAgentMode || isTtsSpeaking) return;
    // The GPT Realtime engine speaks for itself; assistant messages it logs to
    // the chat must not ALSO be synthesized by the pipeline TTS.
    if (realtimeActiveRef.current) return;
    const lastMsg = projectChatMessages.at(-1);
    if (!lastMsg || lastMsg.role !== 'assistant' || lastMsg.pending) return;
    const speechKey = speechKeyForAssistantMessage(lastMsg);
    if (speechKey === lastSpokenMessageKeyRef.current) return;
    lastSpokenMessageKeyRef.current = speechKey;
    setIsTtsSpeaking(true);
    void speakResponse(speechTextForAssistantMessage(lastMsg));
    queueMicrotask(() => resumeVoiceLoopRef.current());
  }, [voiceModeActive, isAgentMode, isTtsSpeaking, projectChatMessages, speakResponse]);

  // Auto-open agent center when waiting tasks arrive (if in agent mode and not in voice mode)
  useEffect(() => {
    void waitingTaskCount; // subscribe but don't open panel — orchestrator panel removed
  }, [isAgentMode, voiceModeActive, waitingTaskCount]);

  // Clean up pasted-image object URLs on unmount to prevent blob: URL leaks.
  useEffect(() => {
    return () => {
      setPastedImages((prev) => {
        for (const img of prev) URL.revokeObjectURL(img.objectUrl);
        return [];
      });
    };
  }, []);

  // The voice transcript grows up to three lines and then scrolls vertically.
  // While the user is speaking (or the turn is being processed) keep the newest
  // words in view by pinning to the bottom; for a settled assistant reply reset
  // to the top so it reads from the beginning.
  useEffect(() => {
    const el = transcriptElRef.current;
    if (!el) return;
    if (isListening || isRefining || agentSending) {
      el.scrollTop = el.scrollHeight;
    } else {
      el.scrollTop = 0;
    }
  }, [projectChatMessages.length, voiceDraftText, isListening, isRefining, agentSending]);

  const submitPrompt = useCallback(async () => {
    if (isAgentMode) { await submitAgentMessage(); return; }
    if (!inputValue.trim() && pastedImages.length === 0) return;

    const { paths, ok } = await materializeAttachments();
    if (!ok) return;
    const finalText = appendAttachmentPaths(inputValue.trim(), paths);
    if (!finalText) return;

    const target = resolvePromptTarget();
    if (!target) {
      showToast('No active terminal available', 'warning');
      return;
    }

    activateSessionInPane(target.id);
    if (!target.agentPreset) {
      const isDevLayout = get(layoutSnapshot).ambient === 'development';
      requestRoomControl('focus', isDevLayout ? 'dev-terminal' : 'terminal');
    }
    const taskSummary = target.agentPreset ? summarizeTerminalTask(finalText) : '';
    sendPromptToTarget(target.id, finalText, target.agentPreset);
    setSessionExecuting(target.id, true);
    if (target.agentPreset) {
      setSessionTaskSummary(target.id, taskSummary || null);
    } else {
      setSessionTaskSummary(target.id, null);
    }
    startCommandBlock(target.id, finalText);
    addRunEntry({
      command: finalText,
      sessionId: target.id,
      sessionRole: target.role ?? null,
      sessionLabel: getSessionLabel(target, $sessions),
      agentPreset: target.agentPreset ?? null,
      projectId: $activeProject?.id ?? '',
      startedAt: Date.now(),
    });
    addHistoryEntry(finalText);

    setInputValue('');
    setIsExpanded(false);
    setHistoryOpen(false);
    resetHistoryCursor();
    requestAnimationFrame(adjustInputHeight);
    focusInput();
    showToast(
      `Sent to ${getSessionPromptTargetLabel(target, $sessions)}`,
      'info',
      undefined,
      true
    );
  }, [isAgentMode, submitAgentMessage, inputValue, pastedImages, materializeAttachments, appendAttachmentPaths, resolvePromptTarget, sendPromptToTarget, $sessions, $activeProject, resetHistoryCursor, adjustInputHeight, focusInput]);

  const selectHistoryItem = useCallback((text: string) => {
    setInputValue(text);
    setHistoryOpen(false);
    resetHistoryCursor();
    focusInput();
  }, [resetHistoryCursor, focusInput]);

  const stepHistory = useCallback((direction: 1 | -1) => {
    const items = get(commandHistory);
    if (!items.length) return;

    setHistoryIndex((prevIndex) => {
      if (prevIndex === -1) {
        draftBeforeHistoryRef.current = inputValue;
      }
      const nextIndex = Math.max(-1, Math.min(items.length - 1, prevIndex + direction));
      setInputValue(nextIndex === -1 ? draftBeforeHistoryRef.current : items[nextIndex]);
      return nextIndex;
    });
  }, [inputValue]);

  const handleKeyDown = useCallback((event: React.KeyboardEvent<HTMLTextAreaElement>) => {
    // When the @-mention dropdown is open, intercept keyboard events and let
    // the MentionDropdown's window-level listener handle them.
    if (mentionQuery !== null) {
      if (event.key === 'ArrowDown' || event.key === 'ArrowUp' || event.key === 'Enter' || event.key === 'Escape') {
        event.preventDefault();
        return;
      }
    }

    // Copy / cut for the prompt box. navigator.clipboard writes are permission-
    // blocked on WebKitGTK (Linux), so a plain Ctrl+C in this textarea never
    // reached the system clipboard there — route the selection through the native
    // clipboard plugin instead. Only intercept when text is actually selected, so
    // Ctrl+C with no selection keeps its default behaviour. (Paste keeps working
    // through the onPaste handler / native paste, which WebKitGTK does allow.)
    if ((event.ctrlKey || event.metaKey) && !event.shiftKey && !event.altKey && isTauriRuntime()) {
      const key = event.key.toLowerCase();
      const el = inputElRef.current;
      if ((key === 'c' || key === 'x') && el) {
        const start = el.selectionStart ?? 0;
        const end = el.selectionEnd ?? 0;
        if (start !== end) {
          event.preventDefault();
          void copyTextToClipboard(el.value.slice(start, end));
          if (key === 'x') {
            const next = el.value.slice(0, start) + el.value.slice(end);
            setInputValue(next);
            requestAnimationFrame(() => {
              adjustInputHeight();
              el.focus();
              el.setSelectionRange(start, start);
            });
          }
          return;
        }
      }
    }

    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault();
      void submitPrompt();
      return;
    }

    if (event.key === 'ArrowUp') {
      const cursorPos = inputElRef.current?.selectionStart ?? 0;
      const onFirstLine = !inputValue.substring(0, cursorPos).includes('\n');
      if (onFirstLine) {
        event.preventDefault();
        stepHistory(1);
        return;
      }
    }

    if (event.key === 'ArrowDown') {
      const cursorPos = inputElRef.current?.selectionStart ?? inputValue.length;
      const onLastLine = !inputValue.substring(cursorPos).includes('\n');
      if (onLastLine) {
        event.preventDefault();
        stepHistory(-1);
        return;
      }
    }

    if (event.key === 'Escape') {
      setHistoryOpen(false);
      resetHistoryCursor();
    }
  }, [submitPrompt, inputValue, stepHistory, resetHistoryCursor, adjustInputHeight]);

  // Right-click copy/paste for the prompt box on Linux (touchpad-friendly, and the
  // only reliable copy path there). Selection → copy; no selection → paste at the
  // cursor. Mirrors the terminal's context-menu behaviour. Left untouched on
  // Windows/macOS so their native menu keeps working.
  const handleInputContextMenu = useCallback(async (event: React.MouseEvent<HTMLTextAreaElement>) => {
    if (!isLinuxHost || !isTauriRuntime()) return;
    event.preventDefault();
    const el = inputElRef.current;
    if (!el) return;
    const start = el.selectionStart ?? 0;
    const end = el.selectionEnd ?? 0;
    if (start !== end) {
      await copyTextToClipboard(el.value.slice(start, end));
      showToast('Copied to clipboard', 'info', undefined, true);
      return;
    }
    const text = await readTextFromClipboard();
    if (!text) return;
    const next = el.value.slice(0, start) + text + el.value.slice(end);
    setInputValue(next);
    requestAnimationFrame(() => {
      adjustInputHeight();
      el.focus();
      const pos = start + text.length;
      el.setSelectionRange(pos, pos);
    });
  }, [adjustInputHeight]);

  const handleMentionSelect = useCallback((entry: FileEntry) => {
    const el = inputElRef.current;
    const value = inputValueRef.current;
    const cursorPos = el?.selectionStart ?? value.length;
    const atIndex = value.lastIndexOf('@', cursorPos - 1);
    if (atIndex !== -1) {
      setInputValue(value.slice(0, atIndex) + value.slice(cursorPos));
    }
    addFileChip(entry.path);
    setMentionQuery(null);
    requestAnimationFrame(() => {
      adjustInputHeight();
      inputElRef.current?.focus();
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [adjustInputHeight]);

  const handleInput = useCallback((event: React.ChangeEvent<HTMLTextAreaElement>) => {
    const value = event.target.value;
    setInputValue(value);
    setHistoryOpen(false);
    adjustInputHeight();
    setHistoryIndex((prev) => (prev !== -1 ? -1 : prev));
    if (value.trim()) setIsExpanded(true);

    // Check for @-mention trigger
    const el = event.target;
    const cursorPos = el.selectionStart;
    if ($activeProject) {
      const textBefore = value.slice(0, cursorPos);
      const atIndex = textBefore.lastIndexOf('@');
      if (atIndex !== -1 && (atIndex === 0 || value[atIndex - 1] === ' ' || value[atIndex - 1] === '\n')) {
        const afterAt = value.slice(atIndex + 1, cursorPos);
        if (!afterAt.includes(' ') && !afterAt.includes('\n')) {
          setMentionQuery(afterAt);
          return;
        }
      }
    }
    setMentionQuery(null);
  }, [adjustInputHeight, $activeProject]);

  const voiceInputRef = useRef(
    createVoiceInputSession({
      onAudioLevel: (rms) => setAudioRms(rms),
      onStart: () => {
        setIsListening(true);
        setIsRefining(false);
        voiceDraftBaseRef.current = inputValueRef.current;
        setVoiceDraftText('');
        showToast('Listening for terminal prompt...', 'info');
      },
      onSpeechStart: () => {
        stopSpeaking();
        setIsTtsSpeaking(false);
      },
      onResult: (transcript) => {
        setVoiceDraftText(transcript);
      },
      onProcessingStart: () => {
        setIsListening(false);
        setIsRefining(true);
      },
      onEnd: () => {
        setVoiceStopping((currentStopping) => {
          setVoiceLocked((currentLocked) => {
            setVoiceHeld((currentHeld) => {
              const shouldRestart = !currentStopping && (currentLocked || currentHeld);
              const shouldResumeAgentVoice = isAgentModeRef.current && voiceModeActiveRef.current;
              const transcript = voiceDraftTextRef.current.trim();
              setIsListening(false);

              if (!transcript) {
                setIsRefining(false);
                setVoiceStopping(false);
                voiceDraftBaseRef.current = '';
                setVoiceDraftText('');
                queueMicrotask(() => {
                  if (shouldRestart) {
                    if (currentLocked || currentHeld) {
                      void voiceInputRef.current.start();
                    }
                    return;
                  }
                  resumeVoiceLoopRef.current();
                });
                return currentHeld;
              }

              // Check for sleep/wake keywords in voice mode
              if (shouldResumeAgentVoice) {
                if (voiceSleepingRef.current) {
                  if (matchVoiceCommand(transcript, WAKE_KEYWORDS)) {
                    setVoiceSleeping(false);
                    setIsRefining(false);
                    setVoiceStopping(false);
                    voiceDraftBaseRef.current = '';
                    setVoiceDraftText('');
                    queueMicrotask(() => resumeVoiceLoopRef.current());
                    return currentHeld;
                  }
                  // Still sleeping — ignore everything else
                  setIsRefining(false);
                  setVoiceStopping(false);
                  voiceDraftBaseRef.current = '';
                  setVoiceDraftText('');
                  queueMicrotask(() => resumeVoiceLoopRef.current());
                  return currentHeld;
                }
                if (matchVoiceCommand(transcript, SLEEP_KEYWORDS)) {
                  setVoiceSleeping(true);
                  setIsRefining(false);
                  setVoiceStopping(false);
                  voiceDraftBaseRef.current = '';
                  setVoiceDraftText('');
                  queueMicrotask(() => resumeVoiceLoopRef.current());
                  return currentHeld;
                }
              }

              setIsRefining(true);

              void (async () => {
                try {
                  const result = await refineVoicePrompt(transcript, { aiRefinement: !(isAgentModeRef.current && voiceModeActiveRef.current) });
                  if (result.text) {
                    const merged = mergeVoiceTranscript(voiceDraftBaseRef.current, result.text);
                    setInputValue(merged);
                    requestAnimationFrame(adjustInputHeight);
                    if (isAgentModeRef.current && voiceModeActiveRef.current) {
                      await submitAgentMessageRef.current(merged);
                    } else {
                      focusInput();
                      if (result.aiRefined) {
                        showToast('Prompt refined by AI', 'success', undefined, true);
                      }
                    }
                  }
                  // An empty refinement (nothing usable was said) just falls through to
                  // the finally below, which restarts the loop — no special-casing here.
                } catch (error) {
                  console.error('Failed to refine voice prompt:', error);
                  // Surface the failure in voice mode so a silent dead mic isn't the only
                  // signal; the finally still re-arms listening so the loop survives it.
                  if (shouldResumeAgentVoice) showToast('Could not process that — listening again.', 'warning', 3000);
                } finally {
                  setIsRefining(false);
                  setVoiceStopping(false);
                  voiceDraftBaseRef.current = '';
                  setVoiceDraftText('');
                  if (shouldRestart) {
                    queueMicrotask(() => {
                      if (currentLocked || currentHeld) {
                        void voiceInputRef.current.start();
                      }
                    });
                  } else {
                    // Conversational voice loop: re-arm the mic for the next turn. Guarded
                    // (won't fire mid-speech or mid-send), so racing finalizers are safe.
                    queueMicrotask(() => resumeVoiceLoopRef.current());
                  }
                }
              })();
              return currentHeld;
            });
            return currentLocked;
          });
          return currentStopping;
        });
      },
      onError: (message) => {
        setIsListening(false);
        setIsRefining(false);
        setVoiceLocked(false);
        setVoiceHeld(false);
        setVoiceStopping(false);
        voiceDraftBaseRef.current = '';
        setVoiceDraftText('');
        showToast(message, 'error');
        // In the hands-free agent voice loop a start/transcription error would
        // otherwise leave the overlay wedged on the idle orb with a dead mic.
        // Tear voice mode down so the error toast is the clear signal.
        if (isAgentModeRef.current && voiceModeActiveRef.current) {
          stopAgentVoiceRef.current();
        }
      },
    })
  );
  const voiceInput = voiceInputRef.current;

  // Mirror frequently-read state into refs so the voiceInput callbacks (created
  // once via useRef above) always see current values without being recreated.
  const isAgentModeRef = useRef(isAgentMode);
  useEffect(() => { isAgentModeRef.current = isAgentMode; }, [isAgentMode]);

  const toggleVoiceInput = useCallback(async () => {
    if (isRefining) return;
    if (isListening && voiceLocked) {
      setVoiceLocked(false);
      setVoiceStopping(true);
      voiceInput.stop();
      voiceDraftBaseRef.current = '';
      return;
    }
    setVoiceLocked(true);
    await voiceInput.start();
  }, [isRefining, isListening, voiceLocked, voiceInput]);

  // Read an on-disk image into a preview chip. Returns true when the chip was
  // added; false (e.g. file outside the project) lets the caller fall back to a
  // plain path so the image is still sent, just without a thumbnail.
  const addDiskImageChip = useCallback(async (path: string): Promise<boolean> => {
    try {
      const bytes = await invoke<number[]>('fs_read_binary', { path });
      const mimeType = getImageMimeType(path);
      const blob = new Blob([new Uint8Array(bytes)], { type: mimeType });
      const objectUrl = URL.createObjectURL(blob);
      const name = path.split(/[\\/]/).pop() || 'image';
      setPastedImages((prev) => [...prev, { objectUrl, dataUrl: '', name, diskPath: path }]);
      return true;
    } catch (error) {
      console.error('Failed to preview attached image:', error);
      return false;
    }
  }, []);

  const attachPathsToInput = useCallback((paths: string[]) => {
    if (!paths.length) return;

    const formatted = paths
      .map((path) => path.trim())
      .filter(Boolean)
      .map((path) => (path.includes(' ') ? `"${path}"` : path))
      .join(' ');

    if (!formatted) return;

    setInputValue((prev) => (prev ? `${prev} ${formatted}` : formatted));
    setHistoryOpen(false);
    setTargetPickerOpen(false);
    resetHistoryCursor();
    requestAnimationFrame(() => {
      adjustInputHeight();
      const el = inputElRef.current;
      el?.focus();
      el?.setSelectionRange(el.value.length, el.value.length);
    });
  }, [resetHistoryCursor, adjustInputHeight]);

  const isPointInsideBar = useCallback((clientX: number, clientY: number) => {
    const barEl = barElRef.current;
    if (!barEl || typeof document === 'undefined') return false;
    const hovered = document.elementsFromPoint(clientX, clientY) as HTMLElement[];
    return hovered.some((el) => el === barEl || el.closest('.floating-prompt-bar') === barEl);
  }, []);

  const updateExplorerDragPoint = useCallback((clientX: number, clientY: number) => {
    if (clientX < 0 || clientY < 0) return false;
    setLastExplorerDragPoint({ x: clientX, y: clientY });
    const overBar = isPointInsideBar(clientX, clientY);
    setIsDragOver(overBar);
    return overBar;
  }, [isPointInsideBar]);

  const handleInternalDragOver = useCallback((event: React.DragEvent) => {
    if (!draggedExplorerPath) return;
    event.preventDefault();
    if (event.dataTransfer) {
      event.dataTransfer.dropEffect = 'copy';
    }
    updateExplorerDragPoint(event.clientX, event.clientY);
  }, [draggedExplorerPath, updateExplorerDragPoint]);

  const handleInternalDragEnter = useCallback((event: React.DragEvent) => {
    if (!draggedExplorerPath) return;
    event.preventDefault();
    updateExplorerDragPoint(event.clientX, event.clientY);
  }, [draggedExplorerPath, updateExplorerDragPoint]);

  const handleInternalDragLeave = useCallback((event: React.DragEvent) => {
    if (!draggedExplorerPath) return;
    event.preventDefault();
  }, [draggedExplorerPath]);

  const handleInternalDrop = useCallback((event: React.DragEvent) => {
    const droppedPath =
      draggedExplorerPath ||
      event.dataTransfer?.getData('application/x-spacron-path')?.trim() ||
      event.dataTransfer?.getData('text/plain')?.trim() ||
      null;

    if (!droppedPath) return;

    event.preventDefault();
    event.stopPropagation();
    // Signal to the document-level handler (which fires after React's synthetic
    // event) that this drop was already handled — prevents the path being added twice.
    internalDropHandledRef.current = true;
    queueMicrotask(() => { internalDropHandledRef.current = false; });
    updateExplorerDragPoint(event.clientX, event.clientY);
    setIsDragOver(false);
    if (isImagePath(droppedPath)) {
      void addDiskImageChip(droppedPath);
    } else {
      addFileChip(droppedPath);
    }
    setDraggedExplorerPath(null);
    setLastExplorerDragPoint(null);
  }, [draggedExplorerPath, updateExplorerDragPoint, addDiskImageChip, addFileChip, isImagePath]);

  const lastFocusRequestRef = useRef(0);
  useEffect(() => {
    const req = $promptBarFocusRequest;
    if (req !== lastFocusRequestRef.current) {
      lastFocusRequestRef.current = req;
      if (req > 0) openPromptBar();
    }
  }, [$promptBarFocusRequest, openPromptBar]);

  const lastVoiceModeRequestRef = useRef(0);
  useEffect(() => {
    const req = $promptBarVoiceModeRequest;
    if (req !== lastVoiceModeRequestRef.current) {
      lastVoiceModeRequestRef.current = req;
      if (req > 0) launchAgentVoiceMode();
    }
  }, [$promptBarVoiceModeRequest, launchAgentVoiceMode]);

  useEffect(() => {
    const text = $promptBarInput;
    if (text) {
      // Append the injected text to any existing input rather than overwriting it
      setInputValue((prev) => (prev.trim() ? `${prev.trim()} ${text}` : text));
      promptBarInput.set(null);
      setHistoryOpen(false);
      resetHistoryCursor();
      requestAnimationFrame(() => {
        adjustInputHeight();
        const el = inputElRef.current;
        el?.focus();
        if (el) el.setSelectionRange(el.value.length, el.value.length);
      });
    }
  }, [$promptBarInput, resetHistoryCursor, adjustInputHeight]);

  // Watch for element screenshots injected from the Preview panel inspector
  useEffect(() => {
    const img = $promptBarImage;
    if (!img) return;
    promptBarImage.set(null);
    // Convert the dataUrl into an objectUrl so it renders in the chip. Decode
    // locally rather than fetch(dataUrl) — the CSP connect-src blocks data: URLs.
    try {
      const mime = img.dataUrl.slice(5, img.dataUrl.indexOf(';')) || 'image/png';
      const blob = new Blob([dataUrlToBytes(img.dataUrl)], { type: mime });
      const objectUrl = URL.createObjectURL(blob);
      setPastedImages((prev) => [...prev, { objectUrl, dataUrl: img.dataUrl, name: img.name }]);
      requestAnimationFrame(() => {
        inputElRef.current?.focus();
      });
    } catch {/* silently ignore */}
  }, [$promptBarImage]);

  // Run once on mount — NOT on every session/active-session change. These mirror
  // Svelte `$effect`s that read the prompt target via `resolvePromptTarget()`,
  // which uses the non-reactive `get(store)`; Svelte therefore tracked no
  // dependencies and ran them exactly once. Listing $sessions/$activeSessionId/
  // $manualPromptTargetId as React deps (the original port) made the second
  // effect re-focus the prompt bar input on every active-session change, which
  // fights the terminal pane's own focus handler — a focus war that repaints the
  // whole view every frame (the flicker; it pauses only while DevTools holds
  // focus). See focusTerminalPane → focusPane → activateSessionInPane.
  useEffect(() => {
    if (!resolvePromptTarget()?.id) {
      setHistoryOpen(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    const sessionId = resolvePromptTarget()?.id;
    if (!sessionId) return;
    setHistoryOpen(false);
    resetHistoryCursor();
    requestAnimationFrame(() => {
      adjustInputHeight();
      inputElRef.current?.focus();
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    requestAnimationFrame(adjustInputHeight);
  }, [inputValue, adjustInputHeight]);

  const handleDocumentPointerDown = useCallback((event: MouseEvent) => {
    if (!historyOpen && !targetPickerOpen && !isExpanded) return;
    const target = event.target as Node | null;
    if (shellElRef.current && target && !shellElRef.current.contains(target)) {
      if (!canStayOpen()) setIsExpanded(false);
      setHistoryOpen(false);
      setTargetPickerOpen(false);
    }
  }, [historyOpen, targetPickerOpen, isExpanded, canStayOpen]);

  const handleGlobalVoiceShortcut = useCallback((event: KeyboardEvent) => {
    // 1. If voice mode is active, Escape or Alt exits voice mode
    if (voiceModeActive && isAgentMode) {
      if (event.key === 'Escape' || (event.key === 'Alt' && event.location === KeyboardEvent.DOM_KEY_LOCATION_LEFT)) {
        event.preventDefault();
        stopAgentVoice();
      }
      return;
    }

    // 2. If voice input is listening (non-agent mode), Alt stops it
    if (isListening && !isAgentMode) {
      if (event.key === 'Alt' && event.location === KeyboardEvent.DOM_KEY_LOCATION_LEFT) {
        event.preventDefault();
        void toggleVoiceInput();
        return;
      }
    }

    if (event.key !== 'Alt' || event.location !== KeyboardEvent.DOM_KEY_LOCATION_LEFT || event.repeat || isRefining) return;

    // In agent mode, Alt always toggles voice regardless of focus —
    // the transcript area doesn't hold keyboard focus so the old focus
    // guard would prevent the shortcut from ever firing.
    if (isAgentMode) {
      event.preventDefault();
      toggleAgentVoiceMode();
      return;
    }

    // In non-agent mode, require focus to be within the prompt bar
    const activeElement = document.activeElement;
    if (!shellElRef.current || !activeElement || !shellElRef.current.contains(activeElement)) return;

    event.preventDefault();
    void toggleVoiceInput();
  }, [voiceModeActive, isAgentMode, isListening, isRefining, stopAgentVoice, toggleAgentVoiceMode, toggleVoiceInput]);

  const handleExplorerDragStart = useCallback((event: Event) => {
    const custom = event as CustomEvent<{ path?: string }>;
    setDraggedExplorerPath(custom.detail?.path?.trim() || null);
    setLastExplorerDragPoint(null);
    setIsDragOver(false);
    setIsGlobalFileDrag(false);
  }, []);

  const handleExplorerDragMoveRef = useRef<(event: Event) => void>(() => {});
  const handleExplorerDragEndRef = useRef<(event: Event) => void>(() => {});

  useEffect(() => {
    handleExplorerDragMoveRef.current = (event: Event) => {
      const custom = event as CustomEvent<{ clientX?: number; clientY?: number }>;
      if (!draggedExplorerPath) return;
      updateExplorerDragPoint(custom.detail?.clientX ?? -1, custom.detail?.clientY ?? -1);
    };
    handleExplorerDragEndRef.current = (event: Event) => {
      const custom = event as CustomEvent<{ path?: string; clientX?: number; clientY?: number }>;
      const endedPath = custom.detail?.path?.trim() || draggedExplorerPath;
      const droppedOverBar =
        typeof custom.detail?.clientX === 'number' && typeof custom.detail?.clientY === 'number'
          ? updateExplorerDragPoint(custom.detail.clientX, custom.detail.clientY)
          : lastExplorerDragPoint
            ? isPointInsideBar(lastExplorerDragPoint.x, lastExplorerDragPoint.y)
            : isDragOver;

      if (endedPath && droppedOverBar) {
        setDraggedExplorerPath(endedPath);
        attachPathsToInput([endedPath]);
      }
      setDraggedExplorerPath(null);
      setLastExplorerDragPoint(null);
      setIsDragOver(false);
    };
  }, [draggedExplorerPath, updateExplorerDragPoint, lastExplorerDragPoint, isPointInsideBar, isDragOver, attachPathsToInput]);

  const handleDocumentDragOver = useCallback((event: DragEvent) => {
    if (!draggedExplorerPath) return;
    const overBar = updateExplorerDragPoint(event.clientX, event.clientY);
    if (overBar) {
      event.preventDefault();
      if (event.dataTransfer) {
        event.dataTransfer.dropEffect = 'copy';
      }
    }
  }, [draggedExplorerPath, updateExplorerDragPoint]);

  const handleDocumentDrop = useCallback((event: DragEvent) => {
    // Skip if the React synthetic handler already processed this drop (prevents duplicates).
    if (internalDropHandledRef.current) {
      setDraggedExplorerPath(null);
      setLastExplorerDragPoint(null);
      setIsDragOver(false);
      return;
    }
    const droppedPath =
      draggedExplorerPath ||
      event.dataTransfer?.getData('application/x-spacron-path')?.trim() ||
      event.dataTransfer?.getData('text/plain')?.trim() ||
      null;

    if (!droppedPath) return;
    const overBar = updateExplorerDragPoint(event.clientX, event.clientY);
    if (overBar) {
      event.preventDefault();
      event.stopPropagation();
      attachPathsToInput([droppedPath]);
    }
    setDraggedExplorerPath(null);
    setLastExplorerDragPoint(null);
    setIsDragOver(false);
  }, [draggedExplorerPath, updateExplorerDragPoint, attachPathsToInput]);

  useEffect(() => {
    if (typeof document === 'undefined') return;
    const dragStartHandler = handleExplorerDragStart as EventListener;
    const dragMoveHandler = ((event: Event) => handleExplorerDragMoveRef.current(event)) as EventListener;
    const dragEndHandler = ((event: Event) => handleExplorerDragEndRef.current(event)) as EventListener;

    document.addEventListener('mousedown', handleDocumentPointerDown);
    document.addEventListener('keydown', handleGlobalVoiceShortcut);
    document.addEventListener('dragover', handleDocumentDragOver);
    document.addEventListener('drop', handleDocumentDrop);
    window.addEventListener('spacron-explorer-drag-start', dragStartHandler);
    window.addEventListener('spacron-explorer-drag-move', dragMoveHandler);
    window.addEventListener('spacron-explorer-drag-end', dragEndHandler);

    return () => {
      document.removeEventListener('mousedown', handleDocumentPointerDown);
      document.removeEventListener('keydown', handleGlobalVoiceShortcut);
      document.removeEventListener('dragover', handleDocumentDragOver);
      document.removeEventListener('drop', handleDocumentDrop);
      window.removeEventListener('spacron-explorer-drag-start', dragStartHandler);
      window.removeEventListener('spacron-explorer-drag-move', dragMoveHandler);
      window.removeEventListener('spacron-explorer-drag-end', dragEndHandler);
    };
  }, [
    handleDocumentPointerDown,
    handleGlobalVoiceShortcut,
    handleDocumentDragOver,
    handleDocumentDrop,
    handleExplorerDragStart,
    draggedExplorerPath,
    attachPathsToInput,
  ]);

  // OS file drops (Tauri v2 intercepts them before HTML5 events reach the webview).
  // Registered exactly ONCE for the component's lifetime — the previous version
  // lived in the effect above, which re-runs whenever voice/hover/drag state
  // changes its callback identities. Because Tauri's unlisten resolves
  // asynchronously (`.then`), a re-run frequently registered a fresh listener
  // before the prior one's unlisten was ready, so listeners piled up and a single
  // OS drop fired all of them — the "file path shows four times" bug. Mutable
  // state is read through refs so this listener never needs to re-subscribe.
  const draggedExplorerPathRef = useRef(draggedExplorerPath);
  useEffect(() => { draggedExplorerPathRef.current = draggedExplorerPath; }, [draggedExplorerPath]);
  const addChipsForPathsRef = useRef<(paths: string[]) => void>(() => {});
  useEffect(() => {
    addChipsForPathsRef.current = (paths: string[]) => {
      for (const p of paths) {
        if (isImagePath(p)) {
          void addDiskImageChip(p);
        } else {
          addFileChip(p);
        }
      }
    };
  }, [addDiskImageChip, addFileChip, isImagePath]);

  useEffect(() => {
    if (!isTauriRuntime()) return;
    let cancelled = false;
    let unlisten: (() => void) | undefined;

    getCurrentWindow().onDragDropEvent((event) => {
      // Internal explorer drags are handled by their own pointer-based path.
      if (draggedExplorerPathRef.current) return;

      const type = event.payload.type;

      if (type === 'enter') {
        setIsGlobalFileDrag(true);
        return;
      }
      if (type === 'leave') {
        setIsGlobalFileDrag(false);
        setIsDragOver(false);
        return;
      }
      if (type === 'over') {
        const barEl = barElRef.current;
        if (!barEl) return;
        const pos = (event.payload as any).position as { x: number; y: number };
        const rect = barEl.getBoundingClientRect();
        setIsDragOver(pos.x >= rect.left && pos.x <= rect.right && pos.y >= rect.top && pos.y <= rect.bottom);
        return;
      }
      if (type === 'drop') {
        setIsGlobalFileDrag(false);
        const payload = event.payload as any;
        const paths: string[] = payload.paths ?? [];

        const barEl = barElRef.current;
        if (!barEl || !paths.length) { setIsDragOver(false); return; }

        const pos = payload.position as { x: number; y: number };
        const rect = barEl.getBoundingClientRect();
        const isOverBar = pos.x >= rect.left && pos.x <= rect.right && pos.y >= rect.top && pos.y <= rect.bottom;

        setIsDragOver(false);
        if (!isOverBar) return;

        addChipsForPathsRef.current(paths);
      }
    }).then((u) => {
      // If the component unmounted before this resolved, unlisten immediately so
      // the listener never leaks past the component's life.
      if (cancelled) u();
      else unlisten = u;
    });

    return () => {
      cancelled = true;
      unlisten?.();
    };
  }, []);

  const showDropOverlay = draggedExplorerPath ? isDragOver : (isGlobalFileDrag || isDragOver);

  return (
    <div
      className={`floating-prompt-shell ${isActive ? 'active' : 'collapsed'}`}
      ref={shellElRef}
    >
      {isActive && (
        <>
          {historyOpen && historyItems.length > 0 && (
            <div
              className="history-panel"
              onMouseEnter={() => setIsHovered(true)}
              onMouseLeave={() => setIsHovered(false)}
            >
              <div className="history-header">
                <span className="history-label">Recent prompts</span>
                <span className="history-hint">Click to re-use</span>
              </div>
              <div className="history-list">
                {historyItems.map((item, i) => (
                  <button key={i} className="history-item" onClick={() => selectHistoryItem(item)} title={item}>
                    <span className="history-index">{i + 1}</span>
                    <span className="history-text">{item}</span>
                    <svg className="history-insert-icon" width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                      <polyline points="9 10 4 15 9 20" />
                      <path d="M20 4v7a4 4 0 0 1-4 4H4" />
                    </svg>
                  </button>
                ))}
              </div>
            </div>
          )}

          <div
            className={`floating-prompt-bar${!canSend ? ' disabled' : ''}${isDragOver ? ' drag-over' : ''}${isGlobalFileDrag && !isDragOver ? ' global-drag' : ''}${isAgentMode ? ' agent-mode' : ''}${isVoiceActive ? ' voice-active' : ''}${promptTarget?.agentPreset ? ` target-${promptTarget.agentPreset}` : ''}`}
            id="floating-prompt-bar"
            ref={barElRef}
            onDragEnter={handleInternalDragEnter}
            onDragOver={handleInternalDragOver}
            onDragLeave={handleInternalDragLeave}
            onDrop={handleInternalDrop}
            onMouseEnter={() => setIsHovered(true)}
            onMouseLeave={() => setIsHovered(false)}
            onFocus={() => setIsFocused(true)}
            onBlur={handleShellFocusOut}
          >
            {showDropOverlay && (
              <div className="drop-overlay">
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
                  <polyline points="17 8 12 3 7 8" />
                  <line x1="12" x2="12" y1="3" y2="15" />
                </svg>
                Drop file to add as context
              </div>
            )}
            {isVoiceActive && (
              <div className="voice-mode-inner">
                <div className="voice-mode-row">
                  <div className={`orb-wrap ${
                    voiceSleeping
                      ? 'sleeping'
                      : isTtsSpeaking
                        ? 'speaking'
                        : isListening
                          ? 'listening'
                          : isRefining || agentSending
                            ? 'thinking'
                            : 'idle'
                  }`}>
                    {isListening && (
                      <>
                        <div className="voice-ring voice-ring-a"></div>
                        <div className="voice-ring voice-ring-b"></div>
                      </>
                    )}
                    <div className="orb">
                      {voiceSleeping ? (
                        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                          <path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z" />
                        </svg>
                      ) : isTtsSpeaking ? (
                        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                          <polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5" />
                          <path d="M19.07 4.93a10 10 0 0 1 0 14.14" />
                          <path d="M15.54 8.46a5 5 0 0 1 0 7.07" />
                        </svg>
                      ) : isListening ? (
                        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                          <path d="M12 2a3 3 0 0 0-3 3v7a3 3 0 0 0 6 0V5a3 3 0 0 0-3-3Z" />
                          <path d="M19 10v1a7 7 0 0 1-14 0v-1" />
                          <line x1="12" x2="12" y1="19" y2="22" />
                        </svg>
                      ) : isRefining || agentSending ? (
                        <svg className="spin" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round">
                          <path d="M21 12a9 9 0 1 1-6.219-8.56" />
                        </svg>
                      ) : (
                        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                          <path d="M3 18v-6a9 9 0 0 1 18 0v6" />
                          <path d="M21 19a2 2 0 0 1-2 2h-1a2 2 0 0 1-2-2v-3a2 2 0 0 1 2-2h3z" />
                          <path d="M3 19a2 2 0 0 0 2 2h1a2 2 0 0 0 2-2v-3a2 2 0 0 0-2-2H3z" />
                        </svg>
                      )}
                    </div>
                  </div>

                  <div className={`voice-eq ${
                    isListening ? 'listening' :
                    isTtsSpeaking ? 'speaking' :
                    isRefining || agentSending ? 'thinking' : 'idle'
                  }`}>
                    {Array.from({ length: 16 }).map((_, i) => {
                      const c = (16 - 1) / 2;
                      const d = Math.abs(i - c) / c;
                      return (
                        <div
                          key={i}
                          className="voice-eq-bar"
                          style={{
                            '--dur': `${280 + ((i * 137) % 420)}ms`,
                            '--dly': `${(i * 83) % 360}ms`,
                            '--max': (0.22 + (1 - d * d) * 0.78).toFixed(2),
                          } as React.CSSProperties}
                        />
                      );
                    })}
                  </div>

                  {isListening && audioRms > 0.01 && (
                    <div className="voice-waveform">
                      <div
                        className="voice-waveform-fill"
                        style={{ width: `${Math.min(100, audioRms * 120)}%` }}
                      />
                    </div>
                  )}

                  <button
                    className="voice-close-btn"
                    onClick={stopAgentVoice}
                    aria-label="End voice mode"
                    title="End voice mode"
                  >
                    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round">
                      <line x1="18" y1="6" x2="6" y2="18" />
                      <line x1="6" y1="6" x2="18" y2="18" />
                    </svg>
                  </button>
                </div>
              </div>
            )}
            {!voiceModeActive && (
              <>
                <button
                  className={`agent-toggle${isAgentMode ? ' active' : ''}`}
                  onClick={toggleAgentMode}
                  title={isAgentMode ? 'Exit agent mode' : 'Enter agent mode'}
                  aria-label={isAgentMode ? 'Exit agent mode' : 'Enter agent mode'}
                >
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <rect x="3" y="11" width="18" height="10" rx="2" />
                    <path d="M12 7v4" />
                    <circle cx="12" cy="5" r="2" />
                    <path d="M8 16h.01M16 16h.01" />
                    <path d="M5 11V9a7 7 0 0 1 14 0v2" />
                  </svg>
                  {waitingTaskCount > 0 && !isAgentMode && (
                    <span className="agent-toggle-badge">{waitingTaskCount}</span>
                  )}
                </button>



                <button
                  className={`voice-toggle${isListening ? ' listening' : ''}${isRefining ? ' refining' : ''}${isAgentMode ? ' agent-voice' : ''}`}
                  onClick={toggleVoiceInput}
                  title={isRefining ? 'Refining with AI…' : isListening ? 'Stop listening' : (isAgentMode ? 'Speak to agent' : 'Start voice input')}
                  aria-label={isRefining ? 'Refining with AI…' : isListening ? 'Stop listening' : (isAgentMode ? 'Speak to agent' : 'Start voice input')}
                >
                  {isRefining ? (
                    <svg className="spin" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round">
                      <path d="M21 12a9 9 0 1 1-9-9c2.52 0 4.93 1 6.74 2.74L21 8" />
                      <polyline points="21 3 21 8 16 8" />
                    </svg>
                  ) : (
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                      <path d="M12 2a3 3 0 0 0-3 3v7a3 3 0 0 0 6 0V5a3 3 0 0 0-3-3Z" />
                      <path d="M19 10v1a7 7 0 0 1-14 0v-1" />
                      <line x1="12" x2="12" y1="19" y2="22" />
                    </svg>
                  )}
                </button>
              </>
            )}

            <div className="prompt-copy">

              <div className="prompt-meta">
                {isAgentMode ? (
                  <>
                    {/* "Now playing" — one moment at a time, no history */}
                    <div className="voice-transcript" ref={transcriptElRef}>
                      {(() => {
                        // Only show content while voice mode is active;
                        // clears to the idle hint as soon as voice ends.
                        if (!voiceModeActive) {
                          return (
                            <div className="transcript-empty">
                              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                                <path d="M3 18v-6a9 9 0 0 1 18 0v6" />
                                <path d="M21 19a2 2 0 0 1-2 2h-1a2 2 0 0 1-2-2v-3a2 2 0 0 1 2-2h3z" />
                                <path d="M3 19a2 2 0 0 0 2 2h1a2 2 0 0 0 2-2v-3a2 2 0 0 0-2-2H3z" />
                              </svg>
                              <span>Press <kbd>Alt</kbd> or tap the mic to speak</span>
                            </div>
                          );
                        }
                        // 1. Voice is sleeping — show moon icon and hint
                        if (voiceSleeping) {
                          return (
                            <div className="transcript-now sleeping">
                              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                                <path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z" />
                              </svg>
                              <span>Sleeping — say &ldquo;wake up&rdquo; to resume</span>
                            </div>
                          );
                        }
                        // 2. User is speaking and we have a live draft (Web Speech
                        //    interim results) — show it. With raw-audio STT there is
                        //    no interim transcript, and with barge-in the mic is open
                        //    the whole time the reply plays, so an unconditional
                        //    "Listening…" here would hide every assistant response.
                        //    Instead fall through and keep the last reply on screen
                        //    until the user actually says something.
                        if (isListening && voiceDraftText) {
                          return (
                            <p className="transcript-now user draft">
                              {voiceDraftText}…
                            </p>
                          );
                        }
                        // 3. Transition: user done, agent thinking/processing — show the
                        //    user's last spoken words with a thinking indicator instead of
                        //    the previous assistant reply, so the bar never goes blank or
                        //    shows stale text from an earlier turn.
                        if ((isRefining || agentSending) && voiceDraftText) {
                          return (
                            <p className="transcript-now user draft">
                              {voiceDraftText}
                              <span className="orc-typing"><span /><span /><span /></span>
                            </p>
                          );
                        }
                        // 4. Assistant message exists — show it (also reached while
                        //    the mic listens with no draft yet, so the reply stays
                        //    readable until the user starts the next turn)
                        const lastMsg = projectChatMessages.at(-1);
                        if (lastMsg?.role === 'assistant') {
                          if (lastMsg.pending) {
                            return (
                              <span className="orc-typing"><span /><span /><span /></span>
                            );
                          }
                          if (lastMsg.completion) {
                            const icon = lastMsg.completion.status === 'done' ? '✅' : lastMsg.completion.status === 'failed' ? '❌' : '⚠️';
                            const verb = lastMsg.completion.status === 'done' ? 'finished' : lastMsg.completion.status === 'failed' ? 'failed' : 'needs input';
                            return (
                              <p className="transcript-now assistant">
                                {icon} {lastMsg.completion.agentName} {verb}: {lastMsg.completion.taskTitle}
                              </p>
                            );
                          }
                          const displayText = stripMarkdown(speechTextForAssistantMessage(lastMsg).split('\n\n🔍')[0]);
                          return (
                            <p className="transcript-now assistant">{displayText}</p>
                          );
                        }
                        // 5. Mic is open but nothing has been said yet and there is
                        //    no reply to keep on screen (first turn of the session).
                        if (isListening) {
                          return <p className="transcript-now user draft">Listening…</p>;
                        }
                        // 6. Voice mode on but no message yet
                        return (
                          <span className="orc-typing"><span /><span /><span /></span>
                        );
                      })()}
                    </div>
                  </>
                ) : (
                  <>
                    <button
                      className={`prompt-target prompt-target-btn${isPinned ? ' pinned' : ''}`}
                      onClick={toggleTargetPicker}
                      title="Click to choose target terminal"
                    >
                      {promptTarget ? getSessionPromptTargetLabel(promptTarget, $sessions) : 'No active terminal'}
                      <svg width="9" height="9" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" className="chevron-icon">
                        <polyline points="6 9 12 15 18 9" />
                      </svg>
                    </button>
                    <span className="prompt-hint">Enter to send · Up/Down history · mic to dictate · drag file to attach</span>
                  </>
                )}
              </div>

              {targetPickerOpen && runningSessions.length > 0 && (
                <div className="target-picker">
                  {runningSessions.map((s) => (
                    <button
                      key={s.id}
                      className={`target-item${promptTarget?.id === s.id ? ' active' : ''}`}
                      onClick={() => selectTarget(s.id)}
                    >
                      {s.role ? (
                        <span
                          className="target-dot"
                          style={{
                            background: s.role === 'Server' ? 'var(--role-server)' : s.role === 'Tests' ? 'var(--role-tests)' : s.role === 'Build' ? 'var(--role-build)' : s.role === 'Agent' ? 'var(--role-agent)' : s.role === 'Git' ? 'var(--role-git)' : 'var(--text-muted)',
                          }}
                        />
                      ) : null}
                      <span className="target-label">{getSessionPromptTargetLabel(s, $sessions)}</span>
                      {s.id === promptTarget?.id && !isPinned && (
                        <span className="target-auto-badge">auto</span>
                      )}
                    </button>
                  ))}
                </div>
              )}

              {pastedImages.length > 0 && (
                <div className="image-chips">
                  {pastedImages.map((img, i) => (
                    <div className="image-chip" key={img.objectUrl}>
                      <img
                        src={img.objectUrl}
                        alt="Pasted image"
                        className="chip-thumb"
                        onClick={() => setExpandedImage(img.objectUrl)}
                        title="Click to view full size"
                      />
                      <button className="chip-remove" onClick={() => removeImage(i)} title="Remove image" aria-label="Remove image">
                        <svg width="7" height="7" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3.5" strokeLinecap="round">
                          <line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" />
                        </svg>
                      </button>
                    </div>
                  ))}
                </div>
              )}

              {pastedFiles.length > 0 && (
                <div className="file-chips">
                  {pastedFiles.map((file, i) => (
                    <div className="file-chip" key={file.path}>
                      <svg className="file-chip-icon" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                        <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
                        <polyline points="14 2 14 8 20 8" />
                      </svg>
                      <span className="file-chip-name" title={file.path}>{file.name}</span>
                      <button className="chip-remove" onClick={() => removeFile(i)} title="Remove file" aria-label="Remove file">
                        <svg width="7" height="7" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3.5" strokeLinecap="round">
                          <line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" />
                        </svg>
                      </button>
                    </div>
                  ))}
                </div>
              )}

              {/* Input: hidden in agent mode (voice-only), shown in terminal mode */}
              {mentionQuery !== null && $activeProject && (
                <MentionDropdown
                  projectRoot={$activeProject.root_path}
                  query={mentionQuery}
                  selectedIndex={mentionSelectedIndex}
                  onSelect={handleMentionSelect}
                  onSetSelectedIndex={setMentionSelectedIndex}
                  onClose={() => setMentionQuery(null)}
                />
              )}
              {!isAgentMode && (
                <textarea
                  ref={inputElRef}
                  value={inputValue}
                  className="prompt-input"
                  placeholder={canSend ? 'Prompt the active terminal...' : 'Open or focus a terminal to send prompts'}
                  rows={1}
                  onChange={handleInput}
                  onKeyDown={handleKeyDown}
                  onPaste={handlePaste}
                  onContextMenu={handleInputContextMenu}
                  onMouseDown={() => { setTargetPickerOpen(false); setHistoryOpen(false); }}
                />
              )}
            </div>

            {/* Send button is hidden in agent mode — voice is the primary input there */}
            {!isAgentMode && (
              <button
                className="send-btn"
                onClick={submitPrompt}
                disabled={!canSend || (!inputValue.trim() && pastedImages.length === 0 && pastedFiles.length === 0)}
                title={preferredAgentTerminal ? 'Send prompt to AI agent terminal' : 'Send prompt to active terminal'}
              >
                Send
              </button>
            )}
          </div>
        </>
      )}
      {!isActive && (
        <button
          type="button"
          className="prompt-bubble"
          onClick={openPromptBar}
          title="Open prompt bar"
          aria-label="Open prompt bar"
          aria-controls="floating-prompt-bar"
          aria-expanded={isActive}
        >
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
            <path d="m8 8 4 4-4 4" />
            <path d="M13 16h3.5" />
          </svg>
          {waitingTaskCount > 0 && (
            <span className="bubble-waiting-badge">{waitingTaskCount}</span>
          )}
        </button>
      )}

      {expandedImage && (
        <div className="image-preview-overlay" onClick={() => setExpandedImage(null)}>
          <div className="image-preview-content" onClick={(e) => e.stopPropagation()}>
            <img src={expandedImage} alt="Expanded preview" className="image-preview-img" />
            <button className="image-preview-close" onClick={() => setExpandedImage(null)}>✕</button>
          </div>
        </div>
      )}
    </div>
  );
}
