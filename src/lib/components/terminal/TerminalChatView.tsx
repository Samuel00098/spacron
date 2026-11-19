import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import ChatDocument from '$lib/components/workspace/ChatDocument';
import {
  getAgentDisplayName,
  getSessionAgentStartedAt,
  getSessionRoot,
  sendAgentPromptDirect,
  writeToSession,
} from '$lib/stores/terminal';
import {
  bindTranscript,
  readTerminalTranscript,
  sendMatchKey,
  setTerminalChatView,
  transcriptAgentFor,
  type TerminalChatItem,
} from '$lib/services/terminal-chat';
import './TerminalChatView.css';

const POLL_MS = 900;
const POLL_HIDDEN_MS = 4000;

type PendingSend = { id: number; text: string; key: string; seenBefore: number; at: number };

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

/**
 * The chat face of an agent terminal. It reads the CLI's own transcript and
 * types into the same PTY; the terminal underneath stays mounted and live.
 */
export default function TerminalChatView({
  sessionId,
  agentPreset,
  isExecuting,
  isRunning,
}: {
  sessionId: number;
  agentPreset: string;
  isExecuting: boolean;
  isRunning: boolean;
}) {
  const agent = transcriptAgentFor(agentPreset);
  const agentLabel = getAgentDisplayName(agentPreset) ?? agentPreset;
  const [items, setItems] = useState<TerminalChatItem[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [transcriptBusy, setTranscriptBusy] = useState<boolean | null>(null);
  const [truncated, setTruncated] = useState(false);
  const [pending, setPending] = useState<PendingSend[]>([]);
  const [draft, setDraft] = useState('');
  const [sending, setSending] = useState(false);
  const [showKeys, setShowKeys] = useState(false);

  const boundRef = useRef<string | null>(null);
  const revisionRef = useRef<string | null>(null);
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const stickToBottomRef = useRef(true);
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
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
        setError('This terminal has no working folder, so its transcript cannot be found.');
        setLoaded(true);
      } else {
        try {
          const result = await readTerminalTranscript({
            sessionId,
            agent,
            cwd,
            sinceMs,
            boundSessionId: boundRef.current,
            knownRevision: revisionRef.current,
          });
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

  const busy = isExecuting || transcriptBusy === true || pending.length > 0;

  // Follow the conversation while the reader is at the bottom.
  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (el && stickToBottomRef.current) el.scrollTop = el.scrollHeight;
  }, [items, pending]);

  const onScroll = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;
    stickToBottomRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 48;
  }, []);

  async function send() {
    const text = draft.trim();
    if (!text || sending || !isRunning) return;
    const key = sendMatchKey(text);
    const seenBefore = userKeys.filter((k) => k === key || k.startsWith(key.slice(0, 60))).length;
    const id = ++pendingIdRef.current;
    setPending((list) => [...list, { id, text, key, seenBefore, at: Date.now() }]);
    setDraft('');
    stickToBottomRef.current = true;
    setSending(true);
    try {
      const ok = await sendAgentPromptDirect(sessionId, text);
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

  const empty = loaded && items.length === 0 && pending.length === 0;
  // Relative links in a reply resolve against the agent's folder.
  const docPath = `${(getSessionRoot(sessionId) ?? '').replace(/[\\/]+$/, '')}/chat.md`;

  return (
    <div
      className="terminal-chat-view"
      // The terminal container's own mouse handlers (middle-click paste,
      // copy-on-select) belong to xterm; keep chat clicks out of them.
      onMouseDown={(e) => { if (e.button === 1) e.stopPropagation(); }}
      onMouseUp={(e) => e.stopPropagation()}
    >
      <div className="terminal-chat-scroll" ref={scrollRef} onScroll={onScroll}>
        {truncated && <div className="terminal-chat-notice">Earlier messages are in the terminal history.</div>}
        {!loaded && <div className="terminal-chat-empty">Loading conversation…</div>}
        {empty && (
          <div className="terminal-chat-empty">
            <strong>No conversation yet</strong>
            <span>Send a message to start, or switch to the terminal to see what {agentLabel} is doing.</span>
          </div>
        )}
        {items.map((item) => (
          <ChatRow key={item.id} item={item} docPath={docPath} />
        ))}
        {pending.map((p) => (
          <div key={`pending-${p.id}`} className="terminal-chat-row user pending">
            <div className="terminal-chat-bubble">{p.text}</div>
          </div>
        ))}
        {busy && isRunning && (
          <div className="terminal-chat-working">
            <span className="terminal-chat-dots" aria-hidden="true"><i /><i /><i /></span>
            {agentLabel} is working
          </div>
        )}
      </div>

      {error && (
        <div className="terminal-chat-error" role="alert">
          <span>{error}</span>
          <button type="button" onClick={() => setTerminalChatView(sessionId, false)}>Open terminal</button>
        </div>
      )}

      <div className="terminal-chat-composer">
        {showKeys && (
          <div className="terminal-chat-keys" role="group" aria-label="Send keys to the terminal">
            <span className="terminal-chat-keys-hint">Answer a terminal prompt:</span>
            {PROMPT_KEYS.map((k) => (
              <button key={k.label} type="button" title={k.title} onClick={() => writeToSession(sessionId, k.data)}>
                {k.label}
              </button>
            ))}
          </div>
        )}
        <div className="terminal-chat-input">
          <textarea
            ref={textareaRef}
            value={draft}
            rows={1}
            placeholder={isRunning ? `Message ${agentLabel}…` : `${agentLabel} has exited`}
            disabled={!isRunning}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={onKeyDown}
          />
          <button
            type="button"
            className={`terminal-chat-keys-toggle${showKeys ? ' active' : ''}`}
            title="Keys for terminal prompts (approvals, pickers)"
            aria-pressed={showKeys}
            onClick={() => setShowKeys((v) => !v)}
          >
            ⌨
          </button>
          {busy && isRunning && !draft.trim() ? (
            <button type="button" className="terminal-chat-send stop" title="Stop (Esc)" onClick={stop}>
              <svg width="10" height="10" viewBox="0 0 10 10"><rect width="10" height="10" rx="2" fill="currentColor" /></svg>
            </button>
          ) : (
            <button
              type="button"
              className="terminal-chat-send"
              title="Send (Enter)"
              disabled={!draft.trim() || sending || !isRunning}
              onClick={() => void send()}
            >
              <svg width="12" height="12" viewBox="0 0 12 12"><path d="M6 10V2M2.5 5.5 6 2l3.5 3.5" stroke="currentColor" strokeWidth="1.6" fill="none" strokeLinecap="round" strokeLinejoin="round" /></svg>
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

function ChatRow({ item, docPath }: { item: TerminalChatItem; docPath: string }) {
  if (item.kind === 'user') {
    return (
      <div className="terminal-chat-row user">
        <div className="terminal-chat-bubble">{item.text}</div>
      </div>
    );
  }
  if (item.kind === 'assistant') {
    return (
      <div className="terminal-chat-row assistant">
        <ChatDocument source={item.text} filePath={docPath} />
      </div>
    );
  }
  if (item.kind === 'reasoning') {
    return (
      <details className="terminal-chat-row reasoning">
        <summary>Thinking</summary>
        <div className="terminal-chat-reasoning-body">{item.text}</div>
      </details>
    );
  }
  if (item.kind === 'tool') {
    const status = item.toolStatus ?? 'running';
    return (
      <details className={`terminal-chat-row tool ${status}`}>
        <summary>
          <span className={`terminal-chat-tool-dot ${status}`} aria-hidden="true" />
          <span className="terminal-chat-tool-name">{item.toolName}</span>
          {item.toolInput && <span className="terminal-chat-tool-input">{item.toolInput}</span>}
        </summary>
        {item.toolInput && <pre className="terminal-chat-tool-block">{item.toolInput}</pre>}
        {item.toolOutput && <pre className="terminal-chat-tool-block output">{item.toolOutput}</pre>}
      </details>
    );
  }
  return <div className="terminal-chat-notice">{item.text}</div>;
}
