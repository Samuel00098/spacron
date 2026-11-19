import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { marked } from 'marked';
import DOMPurify from 'dompurify';
import { AgentBrandMark } from '$lib/components/shared/useAgentBrand';
import { copyTextToClipboard } from '$lib/utils/clipboard';
import {
  getAgentDisplayName,
  getSessionAgentStartedAt,
  getSessionRoot,
  sendAgentPromptDirect,
  writeToSession,
} from '$lib/stores/terminal';
import {
  bindTranscript,
  contextUsageFor,
  effortApplyFor,
  formatTokens,
  modelApplyFor,
  readTerminalTranscript,
  sendMatchKey,
  setTerminalChatView,
  transcriptAgentFor,
  permissionDescription,
  permissionModesFor,
  applyModelChange,
  applyPermissionChange,
  clearSessionPicks,
  setSessionPicks,
  sessionPermissionMode,
  useSessionPicks,
  PERMISSION_MODE_COPY,
  type ChatPermissionMode,
  type ContextUsage,
  type SessionOptionApply,
  type TerminalChatItem,
} from '$lib/services/terminal-chat';
import { loadLiveAgentProviderModels, peekLiveAgentProviderModels } from '$lib/services/live-agent-models';
import type { AgentProviderModel } from '$lib/services/chat-provider-adapters';
import { REASONING_LABELS } from '$lib/services/orchestrator/reasoning-levels';
import type { ChatReasoningEffort } from '$lib/types/chat';
import { useStore } from '$lib/react/useStore';
import { toggleTerminalTranscription, transcriptionActive } from '$lib/services/transcription-hotkey';
import type { WorktreeInfo } from '$lib/services/orchestrator/worktree-manager';
import ImageViewer, { type ViewerImage } from '$lib/components/shared/ImageViewer';
import { requestTerminalInput, terminalInputRequest } from '$lib/stores/terminal';
import { get } from '$lib/stores/storeCompat';
import './TerminalChatView.css';

const POLL_MS = 900;
const POLL_HIDDEN_MS = 4000;
const READ_TIMEOUT_MS = 8000;

type PendingSend = { id: number; text: string; key: string; seenBefore: number; at: number; images: string[] };

/** An image waiting in the composer: saved to disk (the CLI gets the path) with a preview to show. */
type Attachment = { id: number; path: string; name: string; preview: string | null; revoke?: string };

const IMAGE_EXTENSIONS = /\.(png|jpe?g|gif|webp|bmp)$/i;

/** Quote a path only when it has spaces, with forward slashes, as a terminal drop does. */
function terminalPath(path: string): string {
  const normalized = path.replace(/\\/g, '/');
  return normalized.includes(' ') ? `"${normalized}"` : normalized;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Paste a path into the pane through xterm (bracketed, no Enter) and wait until it has gone in. */
async function pasteIntoPane(sessionId: number, text: string): Promise<void> {
  requestTerminalInput(sessionId, text);
  const started = Date.now();
  while (Date.now() - started < 3000) {
    const pending = get(terminalInputRequest);
    if (!pending || pending.sessionId !== sessionId) break;
    await sleep(50);
  }
  await sleep(250);
}

/** A send whose row never lands (no transcript found, CLI rejected it) stops counting as busy. */
const PENDING_EXPIRY_MS = 90_000;

/** Keys a TUI prompt (approval, picker, question) answers to, sent straight to the PTY. */
const PROMPT_KEYS: { label: string; title: string; data: string }[] = [
  { label: '1', title: 'Send 1 (usually “Yes”)', data: '1' },
  { label: '2', title: 'Send 2', data: '2' },
  { label: '3', title: 'Send 3', data: '3' },
  { label: '↑', title: 'Arrow up', data: '\x1b[A' },
  { label: '↓', title: 'Arrow down', data: '\x1b[B' },
  { label: 'Enter', title: 'Press Enter', data: '\r' },
  { label: 'Esc', title: 'Press Escape', data: '\x1b' },
];

/** The transcript as a reader sees it: turns, with each run of tool calls folded into one activity block. */
type Block =
  | { type: 'user'; item: TerminalChatItem }
  | { type: 'assistant'; item: TerminalChatItem; leads: boolean }
  | { type: 'activity'; id: string; items: TerminalChatItem[]; leads: boolean }
  | { type: 'notice'; item: TerminalChatItem };

function toBlocks(items: TerminalChatItem[]): Block[] {
  const blocks: Block[] = [];
  // Whether the agent has written since the last user turn; its first block
  // after one carries its name.
  let agentSpoke = false;
  for (const item of items) {
    if (item.kind === 'user') {
      blocks.push({ type: 'user', item });
      agentSpoke = false;
    } else if (item.kind === 'notice') {
      blocks.push({ type: 'notice', item });
    } else if (item.kind === 'assistant') {
      blocks.push({ type: 'assistant', item, leads: !agentSpoke });
      agentSpoke = true;
    } else {
      const last = blocks[blocks.length - 1];
      if (last?.type === 'activity') last.items.push(item);
      else {
        blocks.push({ type: 'activity', id: item.id, items: [item], leads: !agentSpoke });
        agentSpoke = true;
      }
    }
  }
  return blocks;
}

/**
 * The chat face of an agent terminal. It reads the CLI's own transcript and
 * types into the same PTY; the terminal beside it stays mounted and live.
 */
export default function TerminalChatView({
  sessionId,
  agentPreset,
  isRunning,
  worktree = null,
}: {
  sessionId: number;
  agentPreset: string;
  isRunning: boolean;
  worktree?: WorktreeInfo | null;
}) {
  const agent = transcriptAgentFor(agentPreset);
  const agentLabel = getAgentDisplayName(agentPreset) ?? agentPreset;
  const textareaRefEarly = useRef<HTMLTextAreaElement | null>(null);
  const [items, setItems] = useState<TerminalChatItem[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [transcriptBusy, setTranscriptBusy] = useState<boolean | null>(null);
  const [truncated, setTruncated] = useState(false);
  const [pending, setPending] = useState<PendingSend[]>([]);
  const [draft, setDraft] = useState('');
  const [sending, setSending] = useState(false);
  const [showKeys, setShowKeys] = useState(false);
  const [attachments, setAttachments] = useState<Attachment[]>([]);
  const [viewer, setViewer] = useState<{ images: ViewerImage[]; index: number } | null>(null);
  const attachmentIdRef = useRef(0);
  const picks = useSessionPicks(sessionId);
  const [relaunching, setRelaunching] = useState(false);
  const dictationOn = useStore(transcriptionActive);
  // Dictation is app-wide; only show it as recording here when it aims at this composer.
  const dictating = dictationOn && document.activeElement === textareaRefEarly.current;
  const root = getSessionRoot(sessionId);
  // What the transcript says the session runs on, and what was picked here
  // since (shown until a later turn records it).
  const [reported, setReported] = useState<{
    model: string | null; effort: string | null; used: number | null; window: number | null; permission: ChatPermissionMode | null;
  }>({ model: null, effort: null, used: null, window: null, permission: null });
  const [models, setModels] = useState<AgentProviderModel[]>(() => peekLiveAgentProviderModels(agentPreset) ?? []);

  const boundRef = useRef<string | null>(null);
  const revisionRef = useRef<string | null>(null);
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const stickToBottomRef = useRef(true);
  const textareaRef = textareaRefEarly;
  const pendingIdRef = useRef(0);
  // The started-at time is fixed for this agent run; read it once per mount.
  const sinceMs = useMemo(() => getSessionAgentStartedAt(sessionId) ?? Date.now(), [sessionId, agentPreset]);

  // Poll the transcript. The backend answers "unchanged" cheaply from file size
  // and mtime, so a steady poll costs a stat, not a parse.
  useEffect(() => {
    if (!agent) return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const tick = async () => {
      const cwd = getSessionRoot(sessionId);
      if (!cwd) {
        setError('This terminal has no working folder, so its conversation cannot be found.');
        setLoaded(true);
      } else {
        try {
          // Bounded: a call that never settles must not stop the polling for good.
          const result = await Promise.race([
            readTerminalTranscript({
              sessionId,
              agent,
              cwd,
              sinceMs,
              boundSessionId: boundRef.current,
              knownRevision: revisionRef.current,
            }),
            new Promise<never>((_, reject) => setTimeout(() => reject(new Error('Reading the conversation timed out.')), READ_TIMEOUT_MS)),
          ]);
          if (cancelled) return;
          setError(null);
          if (result.sessionId !== boundRef.current) {
            boundRef.current = result.sessionId;
            bindTranscript(sessionId, result.sessionId);
          }
          revisionRef.current = result.revision;
          if (!result.unchanged) {
            setItems(result.messages);
            setTranscriptBusy(result.busy);
            setTruncated(result.truncated);
            setReported({
              model: result.model,
              effort: result.effort,
              used: result.contextUsed,
              window: result.contextWindow,
              permission: isChatPermission(result.permission) ? result.permission : null,
            });
          }
        } catch (err) {
          if (cancelled) return;
          setError(err instanceof Error ? err.message : String(err));
        }
        setLoaded(true);
      }
      setPending((list) => (list.some((p) => Date.now() - p.at > PENDING_EXPIRY_MS)
        ? list.filter((p) => Date.now() - p.at <= PENDING_EXPIRY_MS)
        : list));
      if (!cancelled) timer = setTimeout(tick, document.hidden ? POLL_HIDDEN_MS : POLL_MS);
    };
    void tick();
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, [agent, sessionId, sinceMs]);

  // The CLI's own model list (the spawn picker's catalogue), for the model menu.
  useEffect(() => {
    let cancelled = false;
    loadLiveAgentProviderModels(agentPreset)
      .then((list) => { if (!cancelled && list.length) setModels(list); })
      .catch(() => {});
    return () => { cancelled = true; };
  }, [agentPreset]);

  // A pick stays shown until a later turn reports that value.
  useEffect(() => {
    const confirmed: ('model' | 'effort' | 'permission')[] = [];
    if (picks.model && reported.model && sameModel(reported.model, picks.model)) confirmed.push('model');
    if (picks.effort && reported.effort === picks.effort) confirmed.push('effort');
    if (picks.permission && reported.permission === picks.permission) confirmed.push('permission');
    if (confirmed.length) clearSessionPicks(sessionId, confirmed);
  }, [reported.model, reported.effort, reported.permission, picks.model, picks.effort, picks.permission, sessionId]);

  // The pane closed or the agent changed: release the transcript binding.
  useEffect(() => () => bindTranscript(sessionId, null), [sessionId]);

  // Entering chat moves focus off the (now hidden) terminal onto the composer,
  // so typing never lands in the TUI behind it.
  useEffect(() => {
    textareaRef.current?.focus();
  }, []);

  const userKeys = useMemo(() => items.filter((i) => i.kind === 'user').map((i) => sendMatchKey(i.text)), [items]);

  // A pending send disappears once its own row lands in the transcript.
  useEffect(() => {
    if (!pending.length) return;
    setPending((list) =>
      list.filter((p) => userKeys.filter((k) => k === p.key || k.startsWith(p.key.slice(0, 60))).length <= p.seenBefore),
    );
  }, [userKeys, pending.length]);

  const blocks = useMemo(() => toBlocks(items), [items]);
  // Busy comes from the conversation itself (a turn started and has not ended)
  // and from sends not yet in it, never from terminal output: TUIs repaint on
  // focus, resize and clicks, and the pane's output-based `isExecuting` blinked
  // "Working" on with every one of them. Orca reads the same turn records.
  const busy = isRunning && (transcriptBusy === true || pending.length > 0);

  // Follow the conversation while the reader is at the bottom.
  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (el && stickToBottomRef.current) el.scrollTop = el.scrollHeight;
  }, [items, pending, busy]);

  const onScroll = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;
    stickToBottomRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 48;
  }, []);

  async function send() {
    const text = draft.trim();
    const images = attachments;
    if ((!text && !images.length) || sending || !isRunning) return;
    const key = sendMatchKey(text);
    const seenBefore = userKeys.filter((k) => k === key || k.startsWith(key.slice(0, 60))).length;
    const id = ++pendingIdRef.current;
    setPending((list) => [...list, { id, text, key, seenBefore, at: Date.now(), images: images.map((a) => a.preview).filter((u): u is string => Boolean(u)) }]);
    setDraft('');
    setAttachments([]);
    stickToBottomRef.current = true;
    setSending(true);
    try {
      // Images first, each pasted as a path the way a terminal drop delivers
      // it, so the CLI attaches it ("[Image #1]") to the prompt that follows.
      for (const image of images) await pasteIntoPane(sessionId, `${terminalPath(image.path)} `);
      for (const image of images) if (image.revoke) URL.revokeObjectURL(image.revoke);
      let ok: boolean;
      if (text) {
        ok = await sendAgentPromptDirect(sessionId, text);
      } else {
        writeToSession(sessionId, '\r');
        ok = true;
      }
      revisionRef.current = null;
      if (!ok) {
        // Not re-filled into the composer: the text may still have reached the
        // CLI, and a blind retry would send it twice.
        setError(`${agentLabel} did not confirm the message. Check the terminal view before sending it again.`);
        setPending((list) => list.filter((p) => p.id !== id));
      }
    } finally {
      setSending(false);
      textareaRef.current?.focus();
    }
  }

  function stop() {
    writeToSession(sessionId, '\x1b');
  }

  function onKeyDown(event: React.KeyboardEvent<HTMLTextAreaElement>) {
    event.stopPropagation();
    if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
      event.preventDefault();
      void send();
    } else if (event.key === 'Escape' && busy && !draft) {
      event.preventDefault();
      stop();
    }
  }

  const modelApply: SessionOptionApply = agent ? modelApplyFor(agent) : { kind: 'none' };
  const effortApply: SessionOptionApply = agent ? effortApplyFor(agent) : { kind: 'none' };
  const currentModelId = picks.model ?? reported.model;
  // Until the CLI answers with its own list (or if it can't), Claude Code still
  // takes its aliases, so a model can be picked before any conversation.
  const menuModels: AgentProviderModel[] = models.length ? models : agent === 'claude' ? CLAUDE_ALIAS_MODELS : [];
  const currentModel = menuModels.find((m) => currentModelId && sameModel(currentModelId, m.id)) ?? null;
  const modelLabel = currentModel?.label ?? (currentModelId ? prettyModel(currentModelId) : 'Default model');
  const efforts = (currentModel?.reasoningEfforts ?? (agent === 'claude' ? CLAUDE_EFFORTS : []))
    .filter((e) => e !== 'default');
  const currentEffort = picks.effort ?? reported.effort;
  const permissionMode: ChatPermissionMode = picks.permission ?? reported.permission ?? sessionPermissionMode(sessionId);
  const context = agent ? contextUsageFor(agent, currentModelId, reported.used, reported.window) : null;
  // A slash command typed mid-turn would queue as prompt text, so options
  // change between turns.
  const optionsLocked = busy || !isRunning || relaunching;

  async function applyOption(apply: SessionOptionApply, value: string | null, which: 'model' | 'effort') {
    if (apply.kind === 'none' || optionsLocked || !value || !agent) return;
    const before = { model: picks.model, effort: picks.effort };
    setSessionPicks(sessionId, { [which]: value });
    await runSetting(async () => {
      const label = which === 'model' ? menuModels.find((m) => m.id === value)?.label ?? null : currentModel?.label ?? null;
      return applyModelChange(sessionId, agent, {
        model: which === 'model' ? value : null,
        modelLabel: which === 'model' ? label : null,
        effort: which === 'effort' ? value : null,
      });
    }, () => setSessionPicks(sessionId, before));
  }

  async function applyPermission(mode: ChatPermissionMode) {
    if (optionsLocked) return;
    const before = picks.permission;
    setSessionPicks(sessionId, { permission: mode });
    await runSetting(
      () => applyPermissionChange(sessionId, agentPreset, boundRef.current, mode),
      () => (before ? setSessionPicks(sessionId, { permission: before }) : clearSessionPicks(sessionId, ['permission'])),
    );
    revisionRef.current = null;
  }

  /** Run a settings change inside the CLI; on failure, show why and undo the pick. */
  async function runSetting(apply: () => Promise<string | null>, undo: () => void) {
    if (relaunching) return;
    setRelaunching(true);
    setError(null);
    try {
      const problem = await apply();
      if (problem) {
        setError(problem);
        undo();
      }
    } finally {
      setRelaunching(false);
    }
  }

  // The F9 dictation, aimed at this composer: focus it first so the capture's
  // field target is this textarea (it inserts React-safely, see transcription-hotkey).
  function dictate() {
    textareaRef.current?.focus();
    toggleTerminalTranscription();
  }

  // Agents read files by path; images given as a path are attached by Claude
  // Code and Codex the way a dropped file is.
  async function attachFiles() {
    try {
      const { open } = await import('@tauri-apps/plugin-dialog');
      const picked = await open({ multiple: true, directory: false });
      const paths = (Array.isArray(picked) ? picked : picked ? [picked] : []).map(String);
      if (!paths.length) return;
      const images = paths.filter((p) => IMAGE_EXTENSIONS.test(p));
      const others = paths.filter((p) => !IMAGE_EXTENSIONS.test(p));
      for (const path of images) {
        const preview = await invoke<string>('chat_image_preview', { path }).catch(() => null);
        addAttachment({ path, name: path.split(/[\\/]/).pop() ?? path, preview });
      }
      if (others.length) {
        const quoted = others.map((p) => (/\s/.test(p) ? `"${p}"` : p)).join(' ');
        setDraft((current) => (current.trim() ? `${current.replace(/\s+$/, '')} ${quoted} ` : `${quoted} `));
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      textareaRef.current?.focus();
    }
  }

  function addAttachment(attachment: Omit<Attachment, 'id'>) {
    const id = ++attachmentIdRef.current;
    setAttachments((list) => [...list, { ...attachment, id }]);
  }

  function removeAttachment(id: number) {
    setAttachments((list) => {
      const gone = list.find((a) => a.id === id);
      if (gone?.revoke) URL.revokeObjectURL(gone.revoke);
      return list.filter((a) => a.id !== id);
    });
  }

  // A pasted image is saved to disk (the CLI gets its path) and shown as a chip;
  // text pastes are left to the textarea.
  async function onPaste(event: React.ClipboardEvent<HTMLTextAreaElement>) {
    const files = Array.from(event.clipboardData?.files ?? []).filter((f) => f.type.startsWith('image/'));
    const fromItems = files.length
      ? []
      : Array.from(event.clipboardData?.items ?? [])
        .filter((item) => item.type.startsWith('image/'))
        .map((item) => item.getAsFile())
        .filter((f): f is File => Boolean(f));
    const images = files.length ? files : fromItems;
    if (!images.length) return;
    event.preventDefault();
    event.stopPropagation();
    for (const file of images) {
      try {
        const ext = (file.type.split('/')[1] || 'png').replace('jpeg', 'jpg');
        const name = file.name && IMAGE_EXTENSIONS.test(file.name) ? file.name : `pasted-image-${Date.now()}.${ext}`;
        const path = await invoke<string>('save_pasted_image', { name, data: Array.from(new Uint8Array(await file.arrayBuffer())) });
        const url = URL.createObjectURL(file);
        addAttachment({ path, name, preview: url, revoke: url });
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      }
    }
  }

  // Previews are blob: URLs; release them when the view goes away.
  const attachmentsRef = useRef(attachments);
  attachmentsRef.current = attachments;
  useEffect(() => () => {
    for (const a of attachmentsRef.current) if (a.revoke) URL.revokeObjectURL(a.revoke);
  }, []);

  function openViewer(images: string[], index: number) {
    setViewer({ images: images.map((src, i) => ({ src, name: `Image ${i + 1}` })), index });
  }

  const folderName = root ? root.replace(/[\\/]+$/, '').split(/[\\/]/).pop() ?? null : null;
  const empty = loaded && items.length === 0 && pending.length === 0;
  const canSend = (Boolean(draft.trim()) || attachments.length > 0) && !sending && isRunning;
  const lastBlock = blocks[blocks.length - 1];

  return (
    <div
      className="terminal-chat-view"
      // The terminal's own mouse handlers (middle-click paste, copy-on-select)
      // belong to xterm; keep chat clicks out of them.
      onMouseDown={(e) => { if (e.button === 1) e.stopPropagation(); }}
      onMouseUp={(e) => e.stopPropagation()}
    >
      {/* The agent's mark lives only here, large and faint behind the thread. */}
      <div className="terminal-chat-watermark" aria-hidden="true">
        <AgentBrandMark command={agentPreset} name={agentLabel} className="terminal-chat-watermark-mark" />
      </div>
      <div className="terminal-chat-scroll" ref={scrollRef} onScroll={onScroll}>
        <div className="terminal-chat-thread">
          {truncated && <div className="terminal-chat-notice">Earlier messages are in the terminal history</div>}
          {!loaded && <div className="terminal-chat-loading"><Dots /></div>}
          {blocks.map((block) => {
            if (block.type === 'user') {
              return <UserTurn key={block.item.id} text={block.item.text} images={block.item.images ?? []} onOpenImage={openViewer} />;
            }
            if (block.type === 'notice') return <div key={block.item.id} className="terminal-chat-notice">{block.item.text}</div>;
            if (block.type === 'assistant') {
              return (
                <div key={block.item.id} className="terminal-chat-agent">
                  <Markdown text={block.item.text} />
                </div>
              );
            }
            return (
              <div key={block.id} className="terminal-chat-agent">
                <Activity items={block.items} live={busy && block === lastBlock} />
              </div>
            );
          })}
          {pending.map((p) => <UserTurn key={`pending-${p.id}`} text={p.text} images={p.images} onOpenImage={openViewer} pending />)}
          {relaunching && (
            <div className="terminal-chat-working">
              <Dots />
              <span>Applying the new settings in {agentLabel}</span>
            </div>
          )}
          {busy && !relaunching && (
            <div className="terminal-chat-working">
              <Dots />
              <span>Working</span>
            </div>
          )}
        </div>
      </div>

      <div className="terminal-chat-dock">
        {error && (
          <div className="terminal-chat-error" role="alert">
            <span>{error}</span>
            <button type="button" onClick={() => setTerminalChatView(sessionId, false)}>Open terminal</button>
          </div>
        )}
        <div className={`terminal-chat-composer${isRunning ? '' : ' exited'}`}>
          {showKeys && (
            <div className="terminal-chat-keys" role="group" aria-label="Send keys to the terminal">
              <span className="terminal-chat-keys-hint">Answer a prompt in the terminal</span>
              <div className="terminal-chat-keys-row">
                {PROMPT_KEYS.map((k) => (
                  <button key={k.label} type="button" title={k.title} onClick={() => writeToSession(sessionId, k.data)}>
                    {k.label}
                  </button>
                ))}
              </div>
            </div>
          )}
          {attachments.length > 0 && (
            <div className="terminal-chat-attachments">
              {attachments.map((a, index) => (
                <div key={a.id} className="terminal-chat-attachment" title={a.name}>
                  <button
                    type="button"
                    className="terminal-chat-attachment-thumb"
                    aria-label={`Preview ${a.name}`}
                    onClick={() => {
                      const previews = attachments.map((x) => x.preview).filter((u): u is string => Boolean(u));
                      if (a.preview) openViewer(previews, Math.max(0, previews.indexOf(a.preview)));
                    }}
                  >
                    {a.preview ? <img src={a.preview} alt="" /> : <span className="terminal-chat-attachment-icon">IMG</span>}
                  </button>
                  <button type="button" className="terminal-chat-attachment-remove" aria-label={`Remove ${a.name}`} onClick={() => removeAttachment(a.id)}>
                    <svg width="8" height="8" viewBox="0 0 8 8" aria-hidden="true"><path d="M1 1l6 6M7 1 1 7" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" /></svg>
                  </button>
                  {index === 0 && attachments.length > 1 && <span className="terminal-chat-attachment-count">{attachments.length}</span>}
                </div>
              ))}
            </div>
          )}
          <textarea
            ref={textareaRef}
            value={draft}
            onPaste={(e) => void onPaste(e)}
            rows={1}
            placeholder={isRunning ? `Message ${agentLabel}` : `${agentLabel} has exited`}
            disabled={!isRunning}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={onKeyDown}
          />
          <div className="terminal-chat-composer-bar">
            <button
              type="button"
              className="terminal-chat-icon-btn"
              title="Attach files (their paths go into the message)"
              aria-label="Attach files"
              disabled={!isRunning}
              onClick={() => void attachFiles()}
            >
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" aria-hidden="true"><path d="M12 5v14M5 12h14" /></svg>
            </button>
            {agent && (
              <AccessMenu
                agent={agent}
                mode={permissionMode}
                disabled={optionsLocked}
                title={optionsLocked ? 'Change permissions between turns' : 'Permissions'}
                onPick={(mode) => void applyPermission(mode)}
              />
            )}
            <button
              type="button"
              className={`terminal-chat-icon-btn${showKeys ? ' active' : ''}`}
              title="Keys for terminal prompts (approvals, pickers)"
              aria-label="Keys for terminal prompts"
              aria-pressed={showKeys}
              onClick={() => setShowKeys((v) => !v)}
            >
              <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <rect x="2" y="6" width="20" height="12" rx="2.5" />
                <path d="M6 10h.01M10 10h.01M14 10h.01M18 10h.01M7 14h10" />
              </svg>
            </button>
            <span className="terminal-chat-bar-spacer" />
            {context && <ContextRing usage={context} />}
            <ModelMenu
              modelLabel={modelLabel}
              effortLabel={currentEffort ? shortEffort(currentEffort) : null}
              title={modelApply.kind === 'none'
                ? `${agentLabel} can't switch models mid-session`
                : optionsLocked ? 'Change the model between turns' : 'Model and reasoning'}
              disabled={modelApply.kind === 'none' || optionsLocked}
              models={menuModels.filter((m) => m.supported !== false).map((m) => ({ value: m.id, label: m.label, hint: m.description }))}
              model={currentModel?.id ?? null}
              onModel={(value) => void applyOption(modelApply, value, 'model')}
              efforts={effortApply.kind !== 'none' ? efforts.map((e) => ({ value: e, label: shortEffort(e) })) : []}
              effort={currentEffort}
              onEffort={(value) => void applyOption(effortApply, value, 'effort')}
            />
            <button
              type="button"
              className={`terminal-chat-icon-btn${dictating ? ' recording' : ''}`}
              title={dictating ? 'Stop dictation (F9)' : 'Dictate (F9)'}
              aria-label={dictating ? 'Stop dictation' : 'Dictate'}
              aria-pressed={dictating}
              disabled={!isRunning}
              onClick={dictate}
            >
              <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <rect x="9" y="3" width="6" height="11" rx="3" />
                <path d="M5.5 11a6.5 6.5 0 0 0 13 0M12 17.5V21" />
              </svg>
            </button>
            {busy && !draft.trim() ? (
              <button type="button" className="terminal-chat-send stop" title="Stop (Esc)" aria-label="Stop" onClick={stop}>
                <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true"><rect width="10" height="10" rx="2.2" fill="currentColor" /></svg>
              </button>
            ) : (
              <button
                type="button"
                className="terminal-chat-send"
                title="Send (Enter)"
                aria-label="Send"
                disabled={!canSend}
                onClick={() => void send()}
              >
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                  <path d="M12 19V5M5 12l7-7 7 7" />
                </svg>
              </button>
            )}
          </div>
        </div>
        {viewer && (
          <ImageViewer images={viewer.images} startIndex={viewer.index} projectRoot={root} onClose={() => setViewer(null)} />
        )}
        <div className="terminal-chat-context-line">
          {folderName && (
            <span title={root ?? undefined}>
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" /></svg>
              {folderName}
              <em>· {worktree ? 'Worktree' : 'Main checkout'}</em>
            </span>
          )}
          {worktree?.branch && (
            <span className="branch">
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><circle cx="6" cy="5" r="2" /><circle cx="6" cy="19" r="2" /><circle cx="18" cy="8" r="2" /><path d="M6 7v10M18 10c0 4-6 3-12 7" /></svg>
              {worktree.branch}
            </span>
          )}
        </div>
      </div>
    </div>
  );
}

const CLAUDE_EFFORTS: ChatReasoningEffort[] = ['low', 'medium', 'high', 'xhigh', 'max'];

/** Claude Code's model aliases (always the latest of each family), for when no live list is available. */
const CLAUDE_ALIAS_MODELS: AgentProviderModel[] = [
  { id: 'opus', label: 'Opus', description: 'Most capable, for complex work' },
  { id: 'sonnet', label: 'Sonnet', description: 'Fast and capable for everyday tasks' },
  { id: 'haiku', label: 'Haiku', description: 'Fastest, for quick answers' },
];

function effortLabel(value: string): string {
  return REASONING_LABELS[value as ChatReasoningEffort] ?? value.charAt(0).toUpperCase() + value.slice(1);
}

/** Transcript ids carry versions and vendor prefixes the catalogue may not ("claude-opus-5-5" vs "opus"). */
function sameModel(a: string, b: string): boolean {
  const norm = (v: string) => v.toLowerCase().replace(/\[1m\]$/, '').replace(/^.*\//, '');
  const x = norm(a);
  const y = norm(b);
  if (x === y || x.startsWith(`${y}-`) || y.startsWith(`${x}-`)) return true;
  // A Claude family alias ("opus") names the latest model of that family.
  const family = (alias: string, id: string) => /^(opus|sonnet|haiku)$/.test(alias) && new RegExp(`(^|-)${alias}(-|$)`).test(id);
  return family(x, y) || family(y, x);
}

/** "claude-opus-5-5" → "Opus 5.5", "gpt-6-luna" → "Gpt 6 Luna". */
function prettyModel(id: string): string {
  const bare = id.replace(/^.*\//, '');
  // OpenAI names read as written: "gpt-6-luna" → "GPT-6-Luna".
  if (/^(gpt|o\d)/i.test(bare)) {
    return bare.split('-').map((part, i) => (i === 0 ? part.toUpperCase() : part.charAt(0).toUpperCase() + part.slice(1))).join('-');
  }
  const parts = id.replace(/^.*\//, '').replace(/^claude-/, '').replace(/\[1m\]$/i, '').split('-');
  let out = '';
  parts.forEach((part, i) => {
    const joinsVersion = /^\d+$/.test(part) && /^\d+$/.test(parts[i - 1] ?? '');
    out += joinsVersion ? `.${part}` : `${i ? ' ' : ''}${part.charAt(0).toUpperCase()}${part.slice(1)}`;
  });
  return out;
}

function isChatPermission(value: string | null): value is ChatPermissionMode {
  return value === 'ask' || value === 'accept-edits' || value === 'auto' || value === 'full-access';
}

function shortEffort(value: string): string {
  const short: Record<string, string> = { minimal: 'Min', low: 'Low', medium: 'Med', high: 'High', xhigh: 'XHigh', max: 'Max', ultra: 'Ultra' };
  return short[value] ?? effortLabel(value);
}

type MenuOption = { value: string; label: string; hint?: string };

/** Close a popover on outside click or Escape. */
function useDismiss(open: boolean, setOpen: (v: boolean) => void, rootRef: React.RefObject<HTMLDivElement | null>) {
  useEffect(() => {
    if (!open) return;
    const onDown = (event: MouseEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false);
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.stopPropagation();
        setOpen(false);
      }
    };
    document.addEventListener('mousedown', onDown, true);
    document.addEventListener('keydown', onKey, true);
    return () => {
      document.removeEventListener('mousedown', onDown, true);
      document.removeEventListener('keydown', onKey, true);
    };
  }, [open, setOpen, rootRef]);
}

function PermissionIcon({ mode }: { mode: ChatPermissionMode }) {
  const common = { width: 15, height: 15, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 1.9, strokeLinecap: 'round' as const, strokeLinejoin: 'round' as const, 'aria-hidden': true };
  if (mode === 'ask') {
    return <svg {...common}><path d="M8 13V5.5a1.5 1.5 0 0 1 3 0V12M11 11.5V4a1.5 1.5 0 0 1 3 0v8M14 11.5V5.5a1.5 1.5 0 0 1 3 0V14a7 7 0 0 1-7 7h-.5a6 6 0 0 1-4.6-2.2L3 16.5a1.6 1.6 0 0 1 2.4-2.1L8 17" /></svg>;
  }
  if (mode === 'accept-edits') {
    return <svg {...common}><path d="M12 20h9M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4z" /></svg>;
  }
  if (mode === 'auto') {
    return <svg {...common}><path d="M12 3 5 6v5c0 4.5 3 8.2 7 10 4-1.8 7-5.5 7-10V6l-7-3z" /><path d="m9 12 2 2 4-4" /></svg>;
  }
  return <svg {...common}><path d="M12 3 5 6v5c0 4.5 3 8.2 7 10 4-1.8 7-5.5 7-10V6l-7-3z" /><path d="M12 8v4M12 16h.01" /></svg>;
}

/**
 * The permission pill and its menu (Orca's modes and copy). A pick restarts the
 * CLI in its terminal with the new flags and resumes the same conversation.
 */
function AccessMenu({
  agent,
  mode,
  disabled,
  title,
  onPick,
}: {
  agent: NonNullable<ReturnType<typeof transcriptAgentFor>>;
  mode: ChatPermissionMode;
  disabled: boolean;
  title: string;
  onPick: (mode: ChatPermissionMode) => void;
}) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement | null>(null);
  useDismiss(open, setOpen, rootRef);
  useEffect(() => { if (disabled) setOpen(false); }, [disabled]);
  const modes = permissionModesFor(agent);
  return (
    <div className="terminal-chat-option" ref={rootRef}>
      <button
        type="button"
        className={`terminal-chat-pill access${mode === 'full-access' ? ' full' : ''}${open ? ' open' : ''}`}
        title={title}
        disabled={disabled}
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
      >
        <PermissionIcon mode={mode} />
        <span className="terminal-chat-pill-label">{PERMISSION_MODE_COPY[mode].label}</span>
        <svg className="terminal-chat-pill-caret" width="9" height="9" viewBox="0 0 10 10" aria-hidden="true">
          <path d="M2.5 3.8 5 6.3l2.5-2.5" stroke="currentColor" strokeWidth="1.5" fill="none" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </button>
      {open && (
        <div className="terminal-chat-menu access" role="menu">
          {modes.map((value) => (
            <button
              key={value}
              type="button"
              role="menuitemradio"
              aria-checked={value === mode}
              className={`terminal-chat-access-item${value === mode ? ' selected' : ''}${value === 'full-access' ? ' full' : ''}`}
              onClick={() => {
                setOpen(false);
                if (value !== mode) onPick(value);
              }}
            >
              <span className="terminal-chat-access-bullet" aria-hidden="true" />
              <span className="terminal-chat-access-icon"><PermissionIcon mode={value} /></span>
              <span className="terminal-chat-menu-text">
                <span className="terminal-chat-menu-label">{PERMISSION_MODE_COPY[value].label}</span>
                <span className="terminal-chat-access-desc">{permissionDescription(agent, value)}</span>
              </span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}


/**
 * The composer's model pill: search, the leading models, "More models (n)",
 * and the effort levels along the bottom, as Orca and T3 Code draw it.
 */
function ModelMenu({
  modelLabel,
  effortLabel: effortText,
  title,
  disabled,
  models,
  model,
  onModel,
  efforts,
  effort,
  onEffort,
}: {
  modelLabel: string;
  effortLabel: string | null;
  title: string;
  disabled?: boolean;
  models: MenuOption[];
  model: string | null;
  onModel: (value: string) => void;
  efforts: MenuOption[];
  effort: string | null;
  onEffort: (value: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const rootRef = useRef<HTMLDivElement | null>(null);
  const searchRef = useRef<HTMLInputElement | null>(null);
  const listRef = useRef<HTMLDivElement | null>(null);
  useDismiss(open, setOpen, rootRef);
  useEffect(() => { if (disabled) setOpen(false); }, [disabled]);
  useEffect(() => {
    if (!open) return;
    setQuery('');
    requestAnimationFrame(() => {
      searchRef.current?.focus();
      // Bring the current model into view without moving anything else.
      listRef.current?.querySelector<HTMLElement>('.terminal-chat-menu-item.selected')?.scrollIntoView({ block: 'nearest' });
    });
  }, [open]);

  const needle = query.trim().toLowerCase();
  const matches = needle
    ? models.filter((m) => `${m.label} ${m.value} ${m.hint ?? ''}`.toLowerCase().includes(needle))
    : models;
  // Firm: the list keeps the CLI's order and a fixed height, and only scrolls.
  const visible = matches;
  const hasMenu = models.length > 0 || efforts.length > 0;

  return (
    <div className="terminal-chat-option" ref={rootRef}>
      <button
        type="button"
        className={`terminal-chat-pill model${open ? ' open' : ''}`}
        title={title}
        disabled={disabled}
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => hasMenu && setOpen((v) => !v)}
      >
        <span className="terminal-chat-pill-label">{modelLabel}</span>
        {effortText && <span className="terminal-chat-pill-effort">{effortText}</span>}
        <svg className="terminal-chat-pill-caret" width="9" height="9" viewBox="0 0 10 10" aria-hidden="true">
          <path d="M2.5 3.8 5 6.3l2.5-2.5" stroke="currentColor" strokeWidth="1.5" fill="none" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </button>
      {open && (
        <div className="terminal-chat-menu right model" role="menu">
          {models.length > 0 && (
            <>
              <label className="terminal-chat-model-search">
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true"><circle cx="11" cy="11" r="7" /><path d="m20 20-3.5-3.5" /></svg>
                <input
                  ref={searchRef}
                  value={query}
                  placeholder="Search models..."
                  onChange={(e) => setQuery(e.target.value)}
                  onKeyDown={(e) => {
                    e.stopPropagation();
                    if (e.key === 'Enter' && visible[0]) {
                      setOpen(false);
                      if (visible[0].value !== model) onModel(visible[0].value);
                    }
                  }}
                />
              </label>
              <div
                className="terminal-chat-model-list"
                ref={listRef}
                // Sized from the whole list, not the search results, so typing never resizes the menu.
                style={{ height: `${Math.min(models.length, 5) * 54 + 4}px` }}
              >
                {visible.map((option) => (
                  <MenuItem key={option.value} option={option} selected={option.value === model} onPick={() => {
                    setOpen(false);
                    if (option.value !== model) onModel(option.value);
                  }} />
                ))}
                {!visible.length && <div className="terminal-chat-menu-empty">No models match</div>}
              </div>
            </>
          )}
          {efforts.length > 0 && (
            <div className="terminal-chat-effort-bar" role="group" aria-label="Reasoning effort">
              <span>Effort</span>
              <div className="terminal-chat-effort-segments">
                {efforts.map((option) => (
                  <button
                    key={option.value}
                    type="button"
                    role="menuitemradio"
                    aria-checked={option.value === effort}
                    className={option.value === effort ? 'selected' : ''}
                    onClick={() => {
                      setOpen(false);
                      if (option.value !== effort) onEffort(option.value);
                    }}
                  >
                    {option.label}
                  </button>
                ))}
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function MenuItem({ option, selected, onPick }: { option: MenuOption; selected: boolean; onPick: () => void }) {
  return (
    <button
      type="button"
      role="menuitemradio"
      aria-checked={selected}
      className={`terminal-chat-menu-item${selected ? ' selected' : ''}`}
      onClick={onPick}
    >
      <span className="terminal-chat-menu-text">
        <span className="terminal-chat-menu-label">{option.label}</span>
        {option.hint && <span className="terminal-chat-menu-hint">{option.hint}</span>}
      </span>
      {selected && (
        <svg className="terminal-chat-menu-check" width="12" height="12" viewBox="0 0 12 12" aria-hidden="true">
          <path d="m2.5 6.2 2.3 2.3 4.7-5" stroke="currentColor" strokeWidth="1.6" fill="none" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      )}
    </button>
  );
}

/** How much of the model's context window the conversation fills. */
function ContextRing({ usage }: { usage: ContextUsage }) {
  const percent = usage.window ? Math.min(100, (usage.used / usage.window) * 100) : null;
  const r = 7;
  const circumference = 2 * Math.PI * r;
  const tone = percent == null ? '' : percent >= 90 ? ' critical' : percent >= 75 ? ' warn' : '';
  const title = usage.window
    ? `Context: ${formatTokens(usage.used)} of ${formatTokens(usage.window)} tokens (${Math.round(percent ?? 0)}%)${usage.estimated ? ', window estimated' : ''}`
    : `Context: ${formatTokens(usage.used)} tokens`;
  return (
    <div className={`terminal-chat-context${tone}`} title={title} aria-label={title}>
      <svg width="18" height="18" viewBox="0 0 18 18" aria-hidden="true">
        <circle cx="9" cy="9" r={r} className="track" />
        {percent != null && (
          <circle
            cx="9"
            cy="9"
            r={r}
            className="fill"
            strokeDasharray={circumference}
            strokeDashoffset={circumference * (1 - percent / 100)}
            transform="rotate(-90 9 9)"
          />
        )}
      </svg>
      <span>{usage.window ? `${formatTokens(usage.used)} / ${formatTokens(usage.window)}` : formatTokens(usage.used)}</span>
    </div>
  );
}

function Dots() {
  return <span className="terminal-chat-dots" aria-hidden="true"><i /><i /><i /></span>;
}

function UserTurn({
  text,
  images,
  onOpenImage,
  pending = false,
}: {
  text: string;
  images: string[];
  onOpenImage: (images: string[], index: number) => void;
  pending?: boolean;
}) {
  // Codex and Claude write an "[Image #1]" marker for each attachment; the
  // thumbnails stand in for it.
  const words = images.length ? text.replace(/\[Image #\d+\]\s*/g, '').trim() : text;
  return (
    <div className={`terminal-chat-user${pending ? ' pending' : ''}`}>
      {images.length > 0 && (
        <div className="terminal-chat-user-images">
          {images.map((src, index) => (
            <button key={index} type="button" className="terminal-chat-user-image" aria-label={`Open image ${index + 1}`} onClick={() => onOpenImage(images, index)}>
              <img src={src} alt="" loading="lazy" />
            </button>
          ))}
        </div>
      )}
      {words && <div className="terminal-chat-user-bubble">{words}</div>}
    </div>
  );
}

function firstLine(text: string): string {
  return text.split('\n').find((line) => line.trim())?.trim() ?? '';
}

/** A run of tool calls and thinking, folded to one line until opened. */
function Activity({ items, live }: { items: TerminalChatItem[]; live: boolean }) {
  const [open, setOpen] = useState(false);
  const tools = items.filter((i) => i.kind === 'tool');
  const failed = tools.filter((i) => i.toolStatus === 'error').length;
  const last = items[items.length - 1];
  const running = live && (last.kind === 'reasoning' || last.toolStatus === 'running');
  let summary: string;
  if (running) {
    const detail = last.kind === 'tool' ? firstLine(last.toolInput ?? '') : '';
    summary = `${last.kind === 'reasoning' ? 'Thinking' : last.toolName ?? 'Tool'}${detail ? ` · ${detail}` : ''}`;
  } else if (tools.length) {
    summary = `${tools.length === 1 ? 'Used 1 tool' : `Used ${tools.length} tools`}${failed ? ` · ${failed} failed` : ''}`;
  } else {
    summary = 'Thought';
  }

  return (
    <div className={`terminal-chat-activity${open ? ' open' : ''}`}>
      <button type="button" className="terminal-chat-activity-head" onClick={() => setOpen((v) => !v)} aria-expanded={open}>
        <span className={`terminal-chat-status-dot${running ? ' running' : failed ? ' error' : ' done'}`} aria-hidden="true" />
        <span className="terminal-chat-activity-summary">{summary}</span>
        <svg className="terminal-chat-chevron" width="10" height="10" viewBox="0 0 10 10" aria-hidden="true">
          <path d="M3.5 2 6.5 5l-3 3" stroke="currentColor" strokeWidth="1.5" fill="none" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </button>
      {open && (
        <div className="terminal-chat-activity-list">
          {items.map((item) => (item.kind === 'reasoning'
            ? <Reasoning key={item.id} text={item.text} />
            : <ToolRow key={item.id} item={item} />))}
        </div>
      )}
    </div>
  );
}

function Reasoning({ text }: { text: string }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="terminal-chat-step">
      <button type="button" className="terminal-chat-step-head" onClick={() => setOpen((v) => !v)} aria-expanded={open}>
        <span className="terminal-chat-step-icon" aria-hidden="true">
          <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><path d="M9 18h6M10 22h4M12 2a7 7 0 0 0-4 12.7V17h8v-2.3A7 7 0 0 0 12 2z" /></svg>
        </span>
        <span className="terminal-chat-step-name">Thinking</span>
        {!open && <span className="terminal-chat-step-detail">{firstLine(text)}</span>}
      </button>
      {open && <div className="terminal-chat-reasoning">{text}</div>}
    </div>
  );
}

function ToolRow({ item }: { item: TerminalChatItem }) {
  const [open, setOpen] = useState(false);
  const status = item.toolStatus ?? 'running';
  return (
    <div className={`terminal-chat-step ${status}`}>
      <button type="button" className="terminal-chat-step-head" onClick={() => setOpen((v) => !v)} aria-expanded={open}>
        <span className="terminal-chat-step-icon" aria-hidden="true">
          <span className={`terminal-chat-status-dot ${status}`} />
        </span>
        <span className="terminal-chat-step-name">{item.toolName}</span>
        <span className="terminal-chat-step-detail">{firstLine(item.toolInput ?? '')}</span>
      </button>
      {open && (
        <div className="terminal-chat-step-body">
          {item.toolInput && <pre>{item.toolInput}</pre>}
          {item.toolOutput
            ? <pre className="output">{item.toolOutput}</pre>
            : status === 'running' ? <div className="terminal-chat-step-wait">Running…</div> : null}
        </div>
      )}
    </div>
  );
}

/** An agent reply as Markdown. Links never navigate the app window. */
function Markdown({ text }: { text: string }) {
  const ref = useRef<HTMLDivElement | null>(null);
  const html = useMemo(() => {
    try {
      return DOMPurify.sanitize(marked.parse(text, { gfm: true, breaks: true }) as string);
    } catch {
      return DOMPurify.sanitize(text);
    }
  }, [text]);
  // One object per `html`, so React doesn't rewrite the markup (and drop the copy buttons) every render.
  const innerHtml = useMemo(() => ({ __html: html }), [html]);

  useLayoutEffect(() => {
    const root = ref.current;
    if (!root) return;
    root.querySelectorAll<HTMLElement>('pre > code').forEach((code) => {
      const pre = code.parentElement!;
      if (pre.dataset.enhanced) return;
      pre.dataset.enhanced = 'true';
      const copy = document.createElement('button');
      copy.type = 'button';
      copy.className = 'terminal-chat-code-copy';
      copy.textContent = 'Copy';
      copy.addEventListener('click', () => {
        void copyTextToClipboard(code.textContent ?? '').then(() => {
          copy.textContent = 'Copied';
          setTimeout(() => { copy.textContent = 'Copy'; }, 1400);
        });
      });
      pre.appendChild(copy);
    });
    root.querySelectorAll('table').forEach((table) => {
      if (table.parentElement?.classList.contains('terminal-chat-table')) return;
      const wrap = document.createElement('div');
      wrap.className = 'terminal-chat-table';
      table.replaceWith(wrap);
      wrap.appendChild(table);
    });
  }, [html]);

  return (
    <div
      ref={ref}
      className="terminal-chat-md"
      onClick={(event) => {
        const anchor = (event.target as HTMLElement).closest('a');
        if (!anchor) return;
        event.preventDefault();
        const href = anchor.getAttribute('href') ?? '';
        if (/^(?:https?:|mailto:)/i.test(href)) {
          void invoke('preview_open_in_browser', { url: href }).catch(() => window.open(href, '_blank', 'noopener,noreferrer'));
        }
      }}
      dangerouslySetInnerHTML={innerHtml}
    />
  );
}
