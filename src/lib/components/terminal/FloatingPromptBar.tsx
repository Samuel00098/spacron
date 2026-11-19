import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { get } from '$lib/stores/storeCompat';
import { invoke } from '@tauri-apps/api/core';
import { getCurrentWindow } from '@tauri-apps/api/window';
import {
  promptBarInput,
  promptBarImage,
  promptBarFocusRequest,
  promptBarVoiceModeRequest,
} from '$lib/stores/terminal';
import { showToast } from '$lib/stores/notification';
import {
  primeTranscriptionTargetTracking,
  sendTranscriptionNow,
  startBarTranscription,
  toggleChatModeTranscription,
  transcriptionState,
  transcriptionLevel,
  transcriptionWordCount,
} from '$lib/services/transcription-hotkey';
import SpectrumVisualizer, { type SpectrumPhase } from './SpectrumVisualizer.tsx';
import TranscriptionIndicator from './TranscriptionIndicator.tsx';
import { createAltTapGesture } from '$lib/services/alt-tap-gesture';
import { isProviderApiKeyConfiguredLocal } from '$lib/services/ai-keychain';
import {
  userShortcuts,
} from '$lib/stores/settings';
import { isTauriRuntime, dropPositionToCss } from '$lib/utils/tauri';
import { activeProject } from '$lib/stores/workspace';
import { interactionMode } from '$lib/stores/interactionMode';
import {
  orchestratorTasks,
  sendChatMessage,
  chatMessages,
  agentForcedAgent,
  type ChatMessage,
} from '$lib/stores/orchestrator';
import { formatAgentIdentity } from '$lib/services/orchestrator/inbox';
import { openSettings } from '$lib/stores/layout';
import { isImagePath, getImageMimeType } from '$lib/stores/editor';
import { useStore } from '$lib/react/useStore';
import VoiceInputIcon from '$lib/components/shared/VoiceInputIcon';
import './FloatingPromptBar.css';

// Per-project state cache
const barProjectCache = new Map<string, { inputValue: string }>();

// `diskPath` is set when the image already exists on disk (attached via the
// file picker) so submitPrompt can reference it directly instead of re-saving
// a fresh copy — the agent then reads the exact file the user picked.
type PastedImage = {
  objectUrl: string;
  dataUrl: string;
  name: string;
  diskPath?: string;
};

// Map a clipboard image MIME type to a clean file extension. Splitting on "/"
// alone mangles compound subtypes (e.g. "image/svg+xml" -> "svgxml"), which
// would write a file with a bogus extension the agent can't open.

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

function stripMarkdown(text: string): string {
  return text
    .replace(/```[\s\S]*?```/g, '')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/\*([^*]+)\*/g, '$1')
    .replace(/#+\s+/g, '')
    .replace(/\[([^\]]+)\]\(([^)]+)\)/g, '$1')
    .replace(/^[-*+]\s+/gm, '')
    .replace(/\n+/g, ' ')
    .trim();
}

function useSyncedState<T>(initialValue: T) {
  const [value, setValueState] = useState(initialValue);
  const valueRef = useRef(value);
  const setValue = useCallback((next: T | ((current: T) => T)) => {
    const resolved =
      typeof next === 'function'
        ? (next as (current: T) => T)(valueRef.current)
        : next;
    valueRef.current = resolved;
    setValueState(resolved);
  }, []);
  return [value, setValue, valueRef] as const;
}

interface FloatingPromptBarProps {
  /** Chrome rendered at the tail of the bar, between the input and Send — the
   *  Tools menu and the layout actions that used to live in the room dock.
   *  Owned by AppShell (it holds the room/drawer wiring). Always rendered —
   *  including in voice mode — so the layout and Tools buttons never
   *  move out from under the cursor when the orb takes over the bar. */
  trailingControls?: React.ReactNode;
}

export default function FloatingPromptBar({
  trailingControls,
}: FloatingPromptBarProps = {}) {
  useEffect(() => {
    // Install before the bar's mic can steal focus from a page input inside
    // Preview. The page focus bridge itself is delivered through this window.
    primeTranscriptionTargetTracking();
  }, []);

  const $activeProject = useStore(activeProject);
  const $orchestratorTasks = useStore(orchestratorTasks);
  const $chatMessages = useStore(chatMessages);
  const $promptBarInput = useStore(promptBarInput);
  const $promptBarImage = useStore(promptBarImage);
  const $promptBarFocusRequest = useStore(promptBarFocusRequest);
  const $promptBarVoiceModeRequest = useStore(promptBarVoiceModeRequest);
  const $transcriptionLevel = useStore(transcriptionLevel);
  const $transcriptionWordCount = useStore(transcriptionWordCount);
  // Read the live binding rather than hardcoding "F9" — the hint has to follow
  // whatever the user rebinds the dictation key to in Settings.
  const $shortcuts = useStore(userShortcuts);
  const transcribeKey = useMemo(() => {
    const binding = ($shortcuts || []).find((shortcut) => {
      if (!shortcut) return false;
      const actionId = shortcut.id.startsWith('custom_')
        ? shortcut.action
        : shortcut.id;
      return actionId === 'transcribeToTerminal';
    });
    return binding?.keys || 'F9';
  }, [$shortcuts]);

  const lastBarProjectIdRef = useRef<string | null>(null);

  // The staged prompt. There is no text box any more — this holds text handed to
  // the bar from elsewhere (Preview's "add element to prompt", a spawned agent's
  // goal), plus attachment paths dragged onto it, and it is shown read-only in
  // the agent-mode strip. Speaking merges the transcript onto it and sends the
  // pair as one message; `mergeVoiceTranscript` in the voice pipeline is what
  // made keeping this a plain string worth doing.
  const [inputValue, setInputValue, inputValueRef] = useSyncedState('');
  // Transcription mode: the mic button runs the shared single-shot
  // speech-to-text service (same engine as Ctrl+Alt+M) — text lands at the
  // cursor, nothing is spoken back. `listening` mirrors its phase store so
  // the bar can show a recording state.
  const [transcribing, setTranscribing] = useState(false);
  useEffect(() => {
    const unsub = transcriptionState.subscribe((phase) =>
      setTranscribing(phase !== 'idle')
    );
    return () => unsub();
  }, []);
  const [isListening, setIsListening, isListeningRef] = useSyncedState(false);
  const [isRefining, setIsRefining, isRefiningRef] = useSyncedState(false);
  const shellElRef = useRef<HTMLDivElement | null>(null);
  const barElRef = useRef<HTMLDivElement | null>(null);
  // Alt-to-voice is a deliberate act: the shortcut only fires once the user has
  // actually clicked on the floating bar. A bare Alt anywhere on the machine
  // must not yank the voice overlay open. Arming happens on pointer-down inside
  // the shell and disarms on any outside click. Arming deliberately does NOT
  // happen on focus: `focusInput()` is called programmatically in a dozen
  // places (mount, session change, after send…), and those focus events would
  // arm the shortcut without the user ever touching the bar — the exact bug
  // this ref exists to prevent.
  // Bare-tap-of-left-Alt detector. Lives in its own module so the rule is
  // unit-tested (`alt-tap-gesture.test.ts`) — getting it wrong is what made
  // Ctrl+Alt+M open voice mode instead of transcribing.
  const altTapRef = useRef(createAltTapGesture());
  const [draggedExplorerPath, setDraggedExplorerPath] = useState<string | null>(
    null
  );
  const [lastExplorerDragPoint, setLastExplorerDragPoint] = useState<{
    x: number;
    y: number;
  } | null>(null);
  // Guard: when the React drop handler fires first, suppress the document-level handler
  const internalDropHandledRef = useRef(false);
  const [, setIsHovered] = useState(false);
  const [, setIsFocused] = useState(false);
  const [isExpanded, setIsExpanded] = useState(false);
  const [isDragOver, setIsDragOver] = useState(false);
  const [isGlobalFileDrag, setIsGlobalFileDrag] = useState(false);
  // True while the spacron_orchestrator tool runs inside the live realtime
  // call (brain working on a spoken request) — drives the "thinking" orb.
  const [agentSending, setAgentSending, agentSendingRef] =
    useSyncedState(false);
  const [pastedImages, setPastedImages] = useState<PastedImage[]>([]);
  const [pastedFiles, setPastedFiles] = useState<
    Array<{ name: string; path: string }>
  >([]);
  const [expandedImage, setExpandedImage] = useState<string | null>(null);
  const transcriptElRef = useRef<HTMLDivElement | null>(null);

  const hasPromptText = inputValue.trim().length > 0;
  // Attachments can arrive on their own — Preview sends an element screenshot
  // with no accompanying text when the element has nothing worth describing —
  // so the staged strip keys off content, not text, or that screenshot would
  // sit in a chip with no way to send it.
  const attachmentCount = pastedImages.length + pastedFiles.length;
  const hasStagedContent = hasPromptText || attachmentCount > 0;
  const isActive = true;

  const waitingTaskCount = useMemo(
    () =>
      $orchestratorTasks.filter(
        (t) =>
          t.projectId === ($activeProject?.id ?? '') && t.status === 'blocked'
      ).length,
    [$orchestratorTasks, $activeProject]
  );

  const projectChatMessages = useMemo(
    () => $chatMessages[$activeProject?.id ?? ''] ?? [],
    [$chatMessages, $activeProject]
  );

  const canSend = Boolean($activeProject) && !agentSending;

  // Per-project state: the staged prompt follows the project it was staged for.
  useEffect(() => {
    const projectId = $activeProject?.id ?? null;
    if (projectId === lastBarProjectIdRef.current) return;

    if (lastBarProjectIdRef.current !== null) {
      barProjectCache.set(lastBarProjectIdRef.current, { inputValue });
    }

    setInputValue(
      projectId !== null
        ? (barProjectCache.get(projectId)?.inputValue ?? '')
        : ''
    );
    lastBarProjectIdRef.current = projectId;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [$activeProject]);

  const openPromptBar = useCallback(() => {
    setIsExpanded(true);
    setIsFocused(true);
  }, []);

  const canStayOpen = useCallback(() => {
    return (
      hasStagedContent ||
      isListening ||
      isRefining ||
      isDragOver ||
      (!draggedExplorerPath && isGlobalFileDrag)
    );
  }, [
    hasStagedContent,
    isListening,
    isRefining,
    isDragOver,
    draggedExplorerPath,
    isGlobalFileDrag,
  ]);

  const handleShellFocusOut = useCallback(
    (event: React.FocusEvent) => {
      setIsFocused(false);
      const next = event.relatedTarget as Node | null;
      if (shellElRef.current && next && shellElRef.current.contains(next))
        return;
      if (!canStayOpen()) setIsExpanded(false);
    },
    [canStayOpen]
  );

  const saveImageToDisk = useCallback(
    async (img: PastedImage): Promise<string | null> => {
      // A pasted image is raw clipboard pixels with no source file to reference, so
      // the bytes must be written somewhere. `save_pasted_image` writes them to an
      // app-owned scratch dir OUTSIDE the project (the OS temp dir) and returns the
      // absolute path — so pastes never bloat the codebase. This is what terminal
      // agents like Claude Code / Cursor do: treat a paste as ephemeral. (The old
      // path wrote into `<project>/.spacron/paste`, piling screenshots up in the
      // working tree.) The scratch dir is wiped on app exit. File-picked/dragged
      // images take the diskPath branch in materializeAttachments and skip this.
      try {
        const data = Array.from(dataUrlToBytes(img.dataUrl));
        const savePath = await invoke<string>('save_pasted_image', {
          name: img.name,
          data,
        });
        return savePath.replace(/\\/g, '/');
      } catch (error) {
        console.error('Failed to save pasted image to disk:', error);
        return null;
      }
    },
    []
  );

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
    setPastedFiles((prev) =>
      prev.some((f) => f.path === path) ? prev : [...prev, { name, path }]
    );
  }, []);

  const removeFile = useCallback((index: number) => {
    setPastedFiles((prev) => prev.filter((_, i) => i !== index));
  }, []);

  // Write any attached/pasted images to disk and return their on-disk paths,
  // so both the agent-chat path and the terminal path can fold attachments into
  // the message text identically. Clipboard-pasted images are saved to the OS
  // temp directory (so they never bloat the project); file-picked images already
  // have a diskPath and are referenced in-place. Non-image files are collected
  // from pastedFiles chips and appended as raw paths.
  const materializeAttachments = useCallback(async (): Promise<{
    paths: string[];
    ok: boolean;
  }> => {
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
  const appendAttachmentPaths = useCallback(
    (text: string, paths: string[]): string => {
      if (!paths.length) return text;
      const quoted = paths
        .map((p) => (p.includes(' ') ? `"${p}"` : p))
        .join(' ');
      return text ? `${text} ${quoted}` : quoted;
    },
    []
  );

  const submitAgentMessage = useCallback(
    async (textOverride?: string) => {
      if (!$activeProject) return;
      const { paths, ok } = await materializeAttachments();
      if (!ok) return;
      const promptText = (textOverride ?? inputValueRef.current).trim();
      const finalText = appendAttachmentPaths(promptText, paths);
      if (!finalText) return;
      setInputValue('');
      setAgentSending(true);
      try {
        await sendChatMessage(
          $activeProject.id,
          $activeProject.root_path,
          finalText,
          {
            forcedAgent: get(agentForcedAgent),
          }
        );
      } finally {
        setAgentSending(false);
      }
    },
    [
      $activeProject,
      materializeAttachments,
      appendAttachmentPaths,
      inputValueRef,
    ]
  );

  // The staged prompt's two buttons. Sending takes no argument on purpose:
  // submitAgentMessage falls back to the staged text and folds the attachment
  // chips in.
  const sendStagedPrompt = useCallback(() => {
    void submitAgentMessage();
  }, [submitAgentMessage]);

  const clearStagedPrompt = useCallback(() => {
    setInputValue('');
    setPastedFiles([]);
    setPastedImages((prev) => {
      for (const img of prev) URL.revokeObjectURL(img.objectUrl);
      return [];
    });
  }, [setInputValue]);

  // Auto-open agent center when waiting tasks arrive (if in agent mode and not in voice mode)
  useEffect(() => {
    void waitingTaskCount; // subscribe but don't open panel — orchestrator panel removed
  }, [waitingTaskCount]);

  // Clean up pasted-image object URLs on unmount to prevent blob: URL leaks.
  useEffect(() => {
    return () => {
      setPastedImages((prev) => {
        for (const img of prev) URL.revokeObjectURL(img.objectUrl);
        return [];
      });
    };
  }, []);

  // Read an on-disk image into a preview chip. Returns true when the chip was
  // added; false (e.g. file outside the project) lets the caller fall back to a
  // plain path so the image is still sent, just without a thumbnail.

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
  }, [projectChatMessages.length, isListening, isRefining, agentSending]);

  // The bar's mic button: transcription mode. Same single-shot speech-to-text
  // service as Ctrl+Alt+M — one utterance, typed straight into whatever field
  // or terminal held the cursor when it started. No reply is synthesized.
  const toggleTranscriptionMode = useCallback(() => {
    if (transcribing) {
      sendTranscriptionNow();
      return;
    }
    if (get(interactionMode) === 'chat') {
      toggleChatModeTranscription();
      return;
    }
    if (!startBarTranscription()) {
      showToast(
        'A transcription is already running. Finish it or press Escape first.',
        'warning'
      );
    }
  }, [transcribing]);

  // Read an on-disk image into a preview chip. Returns true when the chip was
  // added; false (e.g. file outside the project) lets the caller fall back to a
  // plain path so the image is still sent, just without a thumbnail.
  const addDiskImageChip = useCallback(
    async (path: string): Promise<boolean> => {
      try {
        const bytes = await invoke<number[]>('fs_read_binary', { path });
        const mimeType = getImageMimeType(path);
        const blob = new Blob([new Uint8Array(bytes)], { type: mimeType });
        const objectUrl = URL.createObjectURL(blob);
        const name = path.split(/[\\/]/).pop() || 'image';
        setPastedImages((prev) => [
          ...prev,
          { objectUrl, dataUrl: '', name, diskPath: path },
        ]);
        return true;
      } catch (error) {
        console.error('Failed to preview attached image:', error);
        return false;
      }
    },
    []
  );

  const attachPathsToInput = useCallback((paths: string[]) => {
    if (!paths.length) return;

    const formatted = paths
      .map((path) => path.trim())
      .filter(Boolean)
      .map((path) => (path.includes(' ') ? `"${path}"` : path))
      .join(' ');

    if (!formatted) return;

    setInputValue((prev) => (prev ? `${prev} ${formatted}` : formatted));
    setIsExpanded(true);
  }, []);

  const isPointInsideBar = useCallback((clientX: number, clientY: number) => {
    const barEl = barElRef.current;
    if (!barEl || typeof document === 'undefined') return false;
    const hovered = document.elementsFromPoint(
      clientX,
      clientY
    ) as HTMLElement[];
    return hovered.some(
      (el) => el === barEl || el.closest('.floating-prompt-bar') === barEl
    );
  }, []);

  const updateExplorerDragPoint = useCallback(
    (clientX: number, clientY: number) => {
      if (clientX < 0 || clientY < 0) return false;
      setLastExplorerDragPoint({ x: clientX, y: clientY });
      const overBar = isPointInsideBar(clientX, clientY);
      setIsDragOver(overBar);
      return overBar;
    },
    [isPointInsideBar]
  );

  const hasTransferFiles = (event: React.DragEvent) =>
    Array.from(event.dataTransfer?.types ?? []).includes('Files');

  const handleInternalDragOver = useCallback(
    (event: React.DragEvent) => {
      if (!draggedExplorerPath && !hasTransferFiles(event)) return;
      event.preventDefault();
      if (event.dataTransfer) {
        event.dataTransfer.dropEffect = 'copy';
      }
      updateExplorerDragPoint(event.clientX, event.clientY);
    },
    [draggedExplorerPath, updateExplorerDragPoint]
  );

  const handleInternalDragEnter = useCallback(
    (event: React.DragEvent) => {
      if (!draggedExplorerPath && !hasTransferFiles(event)) return;
      event.preventDefault();
      updateExplorerDragPoint(event.clientX, event.clientY);
    },
    [draggedExplorerPath, updateExplorerDragPoint]
  );

  const handleInternalDragLeave = useCallback(
    (event: React.DragEvent) => {
      if (!draggedExplorerPath) return;
      event.preventDefault();
    },
    [draggedExplorerPath]
  );

  const handleInternalDrop = useCallback(
    (event: React.DragEvent) => {
      // Real file drops (browser sessions, or file-manager drags where the
      // webview delivers File objects): persist image bytes to the scratch dir
      // and chip them; non-images become path chips via the scratch path.
      const files = Array.from(event.dataTransfer?.files ?? []);
      if (files.length) {
        event.preventDefault();
        event.stopPropagation();
        internalDropHandledRef.current = true;
        queueMicrotask(() => {
          internalDropHandledRef.current = false;
        });
        updateExplorerDragPoint(event.clientX, event.clientY);
        setIsDragOver(false);
        setDraggedExplorerPath(null);
        setLastExplorerDragPoint(null);
        void (async () => {
          for (const file of files) {
            const buffer = new Uint8Array(await file.arrayBuffer());
            const data = Array.from(buffer);
            try {
              const savePath = await invoke<string>('save_pasted_image', {
                name: file.name || `dropped-file-${Date.now()}`,
                data,
              });
              const normalized = savePath.replace(/\\/g, '/');
              if (isImagePath(normalized) || file.type.startsWith('image/')) {
                const objectUrl = URL.createObjectURL(
                  new Blob([new Uint8Array(buffer)], { type: file.type || 'image/png' })
                );
                const reader = new FileReader();
                reader.onload = () => {
                  setPastedImages((prev) => [
                    ...prev,
                    {
                      objectUrl,
                      dataUrl: typeof reader.result === 'string' ? reader.result : '',
                      name: file.name || 'dropped-image',
                      diskPath: normalized,
                    },
                  ]);
                };
                reader.readAsDataURL(new Blob([new Uint8Array(buffer)]));
              } else {
                addFileChip(normalized);
              }
            } catch (error) {
              console.error('Failed to attach dropped file:', error);
            }
          }
        })();
        return;
      }

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
      queueMicrotask(() => {
        internalDropHandledRef.current = false;
      });
      updateExplorerDragPoint(event.clientX, event.clientY);
      setIsDragOver(false);
      if (isImagePath(droppedPath)) {
        void addDiskImageChip(droppedPath);
      } else {
        addFileChip(droppedPath);
      }
      setDraggedExplorerPath(null);
      setLastExplorerDragPoint(null);
    },
    [
      draggedExplorerPath,
      updateExplorerDragPoint,
      addDiskImageChip,
      addFileChip,
      isImagePath,
    ]
  );

  // Clipboard image paste onto the bar (Ctrl+V while it has focus). The bar
  // has no text input, but pasted pixels still need somewhere to land — chip
  // them like a drop so they ride along with the staged prompt.
  const handleBarPaste = useCallback((event: React.ClipboardEvent) => {
    const files = Array.from(event.clipboardData?.files ?? []).filter((file) =>
      file.type.startsWith('image/')
    );
    const itemFile = !files.length
      ? Array.from(event.clipboardData?.items ?? [])
          .find((item) => item.type.startsWith('image/'))
          ?.getAsFile()
      : null;
    const imageFile = files[0] ?? itemFile;
    if (!imageFile) return;
    event.preventDefault();
    event.stopPropagation();
    const objectUrl = URL.createObjectURL(imageFile);
    const reader = new FileReader();
    reader.onload = () => {
      setPastedImages((prev) => [
        ...prev,
        {
          objectUrl,
          dataUrl: typeof reader.result === 'string' ? reader.result : '',
          name: (imageFile as File).name || `pasted-image-${Date.now()}.png`,
        },
      ]);
      setIsExpanded(true);
    };
    reader.readAsDataURL(imageFile);
  }, []);

  const lastFocusRequestRef = useRef(0);
  useEffect(() => {
    const req = $promptBarFocusRequest;
    if (req !== lastFocusRequestRef.current) {
      lastFocusRequestRef.current = req;
      if (req > 0) openPromptBar();
    }
  }, [$promptBarFocusRequest, openPromptBar]);

  // Text handed to the bar from elsewhere — Preview's "add element to prompt",
  // the goal of an agent spawned without auto-run. There is no text box for it
  // to land in any more, so it becomes the staged prompt and is shown in the
  // agent strip, where it can be sent as-is or spoken over.
  useEffect(() => {
    const text = $promptBarInput;
    if (!text) return;
    setInputValue((prev) => (prev.trim() ? `${prev.trim()} ${text}` : text));
    promptBarInput.set(null);
    setIsExpanded(true);
  }, [$promptBarInput, setInputValue]);

  // Watch for element screenshots injected from the Preview panel inspector
  useEffect(() => {
    const img = $promptBarImage;
    if (!img) return;
    promptBarImage.set(null);
    // Convert the dataUrl into an objectUrl so it renders in the chip. Decode
    // locally rather than fetch(dataUrl) — the CSP connect-src blocks data: URLs.
    try {
      const mime =
        img.dataUrl.slice(5, img.dataUrl.indexOf(';')) || 'image/png';
      const blob = new Blob([dataUrlToBytes(img.dataUrl)], { type: mime });
      const objectUrl = URL.createObjectURL(blob);
      setPastedImages((prev) => [
        ...prev,
        { objectUrl, dataUrl: img.dataUrl, name: img.name },
      ]);
      setIsExpanded(true);
    } catch {
      /* silently ignore */
    }
  }, [$promptBarImage]);

  const handleDocumentPointerDown = useCallback(
    (event: MouseEvent) => {
      const target = event.target as Node | null;
      const insideShell = Boolean(
        shellElRef.current && target && shellElRef.current.contains(target)
      );
      if (!isExpanded) return;
      if (!insideShell && !canStayOpen()) setIsExpanded(false);
    },
    [isExpanded, canStayOpen]
  );

  /**
   * Voice mode is toggled by a BARE TAP of left Alt — pressed and released with
   * nothing else in between.
   *
   * It fires on keyup, not keydown, and that is the whole point. Firing on
   * keydown meant every chord containing Alt opened voice mode as soon as Alt
   * went down: `Ctrl+Alt+M` (transcribe to the caret) toggled the voice call
   * before the `M` was ever delivered, which read as "the transcription hotkey
   * randomly opens voice mode" — randomly only because the gesture is armed by
   * clicking the bar. A modifier check on keydown alone would not be enough
   * either, since holding Alt *first* and adding Ctrl after produces a bare-Alt
   * keydown too.
   */
  const handleGlobalVoiceShortcut = useCallback(
    (event: KeyboardEvent) => {
      if (event.type === 'keydown') {
        altTapRef.current.keydown(event);
        return;
      }

      if (!altTapRef.current.keyup(event) || isRefining) return;

      event.preventDefault();
      // Bare Alt tap toggles dictation (single-shot speech-to-text into the
      // focused field or terminal). Dictation is available whether or not voice
      // mode was previously running.
      if (get(interactionMode) === 'chat') {
        toggleChatModeTranscription();
        return;
      }
      if (!startBarTranscription()) {
        showToast(
          'A transcription is already running. Finish it or press Escape first.',
          'warning'
        );
      }
    },
    [isRefining]
  );

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
      const custom = event as CustomEvent<{
        clientX?: number;
        clientY?: number;
      }>;
      if (!draggedExplorerPath) return;
      updateExplorerDragPoint(
        custom.detail?.clientX ?? -1,
        custom.detail?.clientY ?? -1
      );
    };
    handleExplorerDragEndRef.current = (event: Event) => {
      const custom = event as CustomEvent<{
        path?: string;
        clientX?: number;
        clientY?: number;
      }>;
      const endedPath = custom.detail?.path?.trim() || draggedExplorerPath;
      const droppedOverBar =
        typeof custom.detail?.clientX === 'number' &&
        typeof custom.detail?.clientY === 'number'
          ? updateExplorerDragPoint(
              custom.detail.clientX,
              custom.detail.clientY
            )
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
  }, [
    draggedExplorerPath,
    updateExplorerDragPoint,
    lastExplorerDragPoint,
    isPointInsideBar,
    isDragOver,
    attachPathsToInput,
  ]);

  const handleDocumentDragOver = useCallback(
    (event: DragEvent) => {
      if (!draggedExplorerPath) return;
      const overBar = updateExplorerDragPoint(event.clientX, event.clientY);
      if (overBar) {
        event.preventDefault();
        if (event.dataTransfer) {
          event.dataTransfer.dropEffect = 'copy';
        }
      }
    },
    [draggedExplorerPath, updateExplorerDragPoint]
  );

  const handleDocumentDrop = useCallback(
    (event: DragEvent) => {
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
    },
    [draggedExplorerPath, updateExplorerDragPoint, attachPathsToInput]
  );

  useEffect(() => {
    if (typeof document === 'undefined') return;
    const dragStartHandler = handleExplorerDragStart as EventListener;
    const dragMoveHandler = ((event: Event) =>
      handleExplorerDragMoveRef.current(event)) as EventListener;
    const dragEndHandler = ((event: Event) =>
      handleExplorerDragEndRef.current(event)) as EventListener;

    document.addEventListener('mousedown', handleDocumentPointerDown);
    // Observe the companion key before terminals/editors can stop propagation.
    // Otherwise Alt followed by a key that belongs to the focused surface can
    // look like a bare Alt tap when its keyup arrives.
    document.addEventListener('keydown', handleGlobalVoiceShortcut, true);
    document.addEventListener('keyup', handleGlobalVoiceShortcut, true);
    document.addEventListener('dragover', handleDocumentDragOver);
    document.addEventListener('drop', handleDocumentDrop);
    window.addEventListener('spacron-explorer-drag-start', dragStartHandler);
    window.addEventListener('spacron-explorer-drag-move', dragMoveHandler);
    window.addEventListener('spacron-explorer-drag-end', dragEndHandler);

    return () => {
      document.removeEventListener('mousedown', handleDocumentPointerDown);
      document.removeEventListener('keydown', handleGlobalVoiceShortcut, true);
      document.removeEventListener('keyup', handleGlobalVoiceShortcut, true);
      document.removeEventListener('dragover', handleDocumentDragOver);
      document.removeEventListener('drop', handleDocumentDrop);
      window.removeEventListener(
        'spacron-explorer-drag-start',
        dragStartHandler
      );
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
  useEffect(() => {
    draggedExplorerPathRef.current = draggedExplorerPath;
  }, [draggedExplorerPath]);
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

    getCurrentWindow()
      .onDragDropEvent((event) => {
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
          const pos = (event.payload as any).position as {
            x: number;
            y: number;
          };
          void dropPositionToCss(pos).then((css) => {
            const el = barElRef.current;
            if (!css || !el) return;
            const rect = el.getBoundingClientRect();
            setIsDragOver(
              css.x >= rect.left &&
                css.x <= rect.right &&
                css.y >= rect.top &&
                css.y <= rect.bottom
            );
          });
          return;
        }
        if (type === 'drop') {
          setIsGlobalFileDrag(false);
          const payload = event.payload as any;
          const paths: string[] = payload.paths ?? [];

          const barEl = barElRef.current;
          if (!barEl || !paths.length) {
            setIsDragOver(false);
            return;
          }

          const pos = payload.position as { x: number; y: number };
          void dropPositionToCss(pos).then((css) => {
            const el = barElRef.current;
            if (!css || !el) {
              setIsDragOver(false);
              return;
            }
            const rect = el.getBoundingClientRect();
            const isOverBar =
              css.x >= rect.left &&
              css.x <= rect.right &&
              css.y >= rect.top &&
              css.y <= rect.bottom;

            setIsDragOver(false);
            if (!isOverBar) return;

            addChipsForPathsRef.current(paths);
          });
        }
      })
      .then((u) => {
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

  const showDropOverlay = draggedExplorerPath
    ? isDragOver
    : isGlobalFileDrag || isDragOver;

  return (
    <div
      className={`floating-prompt-shell ${isActive ? 'active' : 'collapsed'}${transcribing ? ' transcribing' : ''}`}
      ref={shellElRef}
    >
      {isActive && (
        <>
          <div
            className={`floating-prompt-bar agent-mode${!canSend ? ' disabled' : ''}${isDragOver ? ' drag-over' : ''}${isGlobalFileDrag && !isDragOver ? ' global-drag' : ''}${transcribing ? ' transcribing' : ''}`}
            id="floating-prompt-bar"
            ref={barElRef}
            onDragEnter={handleInternalDragEnter}
            onDragOver={handleInternalDragOver}
            onDragLeave={handleInternalDragLeave}
            onDrop={handleInternalDrop}
            onPaste={handleBarPaste}
            onMouseEnter={() => setIsHovered(true)}
            onMouseLeave={() => setIsHovered(false)}
            onFocus={() => setIsFocused(true)}
            onBlur={handleShellFocusOut}
          >
            {showDropOverlay && (
              <div className="drop-overlay">
                <svg
                  width="16"
                  height="16"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                >
                  <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
                  <polyline points="17 8 12 3 7 8" />
                  <line x1="12" x2="12" y1="3" y2="15" />
                </svg>
                Drop file to add as context
              </div>
            )}
            {/* --- NORMAL & TRANSCRIBING MODE --- */}
              <>
                <button
                  type="button"
                  className={`voice-toggle agent-voice${transcribing ? ' listening' : ''}`}
                  onClick={toggleTranscriptionMode}
                  title={
                    transcribing
                      ? 'Stop dictation and insert the transcript'
                      : 'Transcribe: speech to text at the cursor'
                  }
                  aria-label={
                    transcribing
                      ? 'Stop dictation and insert the transcript'
                      : 'Transcribe: speech to text at the cursor'
                  }
                >
                  {transcribing ? (
                    <svg
                      width="15"
                      height="15"
                      viewBox="0 0 24 24"
                      fill="none"
                      stroke="none"
                      aria-hidden="true"
                    >
                      <rect x="5.5" y="5.5" width="13" height="13" rx="1.6" fill="currentColor" />
                    </svg>
                  ) : <VoiceInputIcon />}
                </button>

                <div className="prompt-copy">
                  <div className="prompt-meta">
                    {hasStagedContent && (
                      <div className="staged-prompt">
                        <span className="staged-prompt-label">Staged</span>
                        <p
                          className="staged-prompt-text"
                          title={inputValue || undefined}
                        >
                          {hasPromptText
                            ? inputValue
                            : `${attachmentCount} ${attachmentCount === 1 ? 'attachment' : 'attachments'}`}
                        </p>
                        <div className="staged-prompt-actions">
                          <button
                            type="button"
                            className="staged-prompt-btn send"
                            onClick={sendStagedPrompt}
                            disabled={!canSend}
                            title={
                              canSend
                                ? 'Send to the agent'
                                : 'Open a project to send'
                            }
                          >
                            Send
                          </button>
                          <button
                            type="button"
                            className="staged-prompt-btn clear"
                            onClick={clearStagedPrompt}
                            title="Discard"
                            aria-label="Discard staged prompt"
                          >
                            <svg
                              width="9"
                              height="9"
                              viewBox="0 0 24 24"
                              fill="none"
                              stroke="currentColor"
                              strokeWidth="3"
                              strokeLinecap="round"
                            >
                              <line x1="18" y1="6" x2="6" y2="18" />
                              <line x1="6" y1="6" x2="18" y2="18" />
                            </svg>
                          </button>
                        </div>
                      </div>
                    )}

                    {transcribing ? (
                      <div className="transcribe-pill-inner">
                        <div className="transcribe-spectrum-track">
                          <SpectrumVisualizer
                            phase="listening"
                            audioLevel={$transcriptionLevel}
                            barCount={18}
                            glow={true}
                            height={24}
                          />
                        </div>
                        <div className="transcribe-pill-info">
                          <span className="transcribe-live-badge">Listening…</span>
                          {$transcriptionWordCount > 0 && (
                            <span className="transcribe-word-count">
                              {$transcriptionWordCount} word{$transcriptionWordCount === 1 ? '' : 's'}
                            </span>
                          )}
                          <span className="transcribe-pill-hint">
                            <kbd>{transcribeKey}</kbd> to send · <kbd>Esc</kbd>
                          </span>
                        </div>
                      </div>
                    ) : (
                      <div className="transcript-empty">
                        <svg
                          width="16"
                          height="16"
                          viewBox="0 0 24 24"
                          fill="none"
                          stroke="currentColor"
                          strokeWidth="1.5"
                          strokeLinecap="round"
                          strokeLinejoin="round"
                          aria-hidden="true"
                        >
                          <path d="M3 18v-6a9 9 0 0 1 18 0v6" />
                          <path d="M21 19a2 2 0 0 1-2 2h-1a2 2 0 0 1-2-2v-3a2 2 0 0 1 2-2h3z" />
                          <path d="M3 19a2 2 0 0 0 2 2h1a2 2 0 0 0 2-2v-3a2 2 0 0 0-2-2H3z" />
                        </svg>
                        <span>
                          <kbd>{transcribeKey}</kbd> or mic = dictate into the
                          text input
                          {' · '}
                          <kbd>Alt</kbd> = voice conversation
                        </span>
                      </div>
                    )}
                  </div>

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
                          <button
                            className="chip-remove"
                            onClick={() => removeImage(i)}
                            title="Remove image"
                            aria-label="Remove image"
                          >
                            <svg
                              width="7"
                              height="7"
                              viewBox="0 0 24 24"
                              fill="none"
                              stroke="currentColor"
                              strokeWidth="3.5"
                              strokeLinecap="round"
                            >
                              <line x1="18" y1="6" x2="6" y2="18" />
                              <line x1="6" y1="6" x2="18" y2="18" />
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
                          <svg
                            className="file-chip-icon"
                            width="14"
                            height="14"
                            viewBox="0 0 24 24"
                            fill="none"
                            stroke="currentColor"
                            strokeWidth="2"
                            strokeLinecap="round"
                            strokeLinejoin="round"
                          >
                            <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
                            <polyline points="14 2 14 8 20 8" />
                          </svg>
                          <span className="file-chip-name" title={file.path}>
                            {file.name}
                          </span>
                          <button
                            className="chip-remove"
                            onClick={() => removeFile(i)}
                            title="Remove file"
                            aria-label="Remove file"
                          >
                            <svg
                              width="7"
                              height="7"
                              viewBox="0 0 24 24"
                              fill="none"
                              stroke="currentColor"
                              strokeWidth="3.5"
                              strokeLinecap="round"
                            >
                              <line x1="18" y1="6" x2="6" y2="18" />
                              <line x1="6" y1="6" x2="18" y2="18" />
                            </svg>
                          </button>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              </>

            {/* Layout and Tools stay put in voice mode: they sit at the tail of
                the bar either way, so switching modes never shuffles them. */}
            {trailingControls}
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
          <svg
            width="18"
            height="18"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2.2"
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <path d="m8 8 4 4-4 4" />
            <path d="M13 16h3.5" />
          </svg>
          {waitingTaskCount > 0 && (
            <span className="bubble-waiting-badge">{waitingTaskCount}</span>
          )}
        </button>
      )}

      <TranscriptionIndicator />

      {expandedImage && (
        <div
          className="image-preview-overlay"
          onClick={() => setExpandedImage(null)}
        >
          <div
            className="image-preview-content"
            onClick={(e) => e.stopPropagation()}
          >
            <img
              src={expandedImage}
              alt="Expanded preview"
              className="image-preview-img"
            />
            <button
              className="image-preview-close"
              onClick={() => setExpandedImage(null)}
            >
              ✕
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
