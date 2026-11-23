import { useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { openUrlInPreviewPanel } from '$lib/stores/preview';
import type { ChatVisualsSpot } from '$lib/stores/terminal';
import { useModalFocus } from '$lib/react/useModalFocus';
import { get } from 'svelte/store';
import { bots as botsStore, openBots, queueBotDraft, visibleBots } from '$lib/services/bots/bots';
import { avatarUrl, BOT_AVATARS } from '$lib/services/bots/avatars';

const NEW_BOT_ID = '__new__';
const iconCache = new Map<string, Promise<string>>();

/** A bot's picture as a data URL: the sandboxed page has no way to load the app's own files. */
function iconData(avatar: string): Promise<string> {
  const url = avatarUrl(avatar);
  if (url.startsWith('data:')) return Promise.resolve(url);
  let cached = iconCache.get(url);
  if (!cached) {
    cached = fetch(url).then((r) => r.blob()).then((blob) => new Promise<string>((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result));
      reader.onerror = () => reject(reader.error);
      reader.readAsDataURL(blob);
    }));
    cached.catch(() => iconCache.delete(url));
    iconCache.set(url, cached);
  }
  return cached;
}

/** Every bot as `{ id, name, icon }`, with the same picture the app shows for it. */
async function botsForVisual(): Promise<{ id: string; name: string; icon: string }[]> {
  const list = visibleBots();
  const out = await Promise.all(list.map(async (bot) => {
    try { return { id: bot.id, name: bot.name, icon: await iconData(bot.avatar) }; } catch { return null; }
  }));
  return out.filter((b): b is { id: string; name: string; icon: string } => b !== null);
}

/** The 24 built-in bot pictures: the only icons a visual may use for a bot. */
async function avatarsForVisual(): Promise<{ id: string; label: string; icon: string }[]> {
  const out = await Promise.all(BOT_AVATARS.map(async ({ id, label }) => {
    try { return { id, label, icon: await iconData(id) }; } catch { return null; }
  }));
  return out.filter((a): a is { id: string; label: string; icon: string } => a !== null);
}

/** A visual's "send to this bot": open the bot and put the text in its message box. */
function sendToBot(bot: unknown, text: unknown): void {
  if (typeof bot !== 'string' || typeof text !== 'string' || !text.trim()) return;
  const want = bot.trim().toLowerCase();
  const match = get(botsStore).find((b) => b.id === bot || b.name.trim().toLowerCase() === want);
  queueBotDraft(match ? match.id : bot, text.slice(0, 4000));
  openBots(match ? match.id : null);
}

/** The page's `window.spacron.openBot(…)` and friends: take the user to the thing the visual is about. */
function openTarget(target: unknown): void {
  const t = target as { kind?: string; id?: string } | null;
  if (!t || typeof t !== 'object') return;
  if (t.kind === 'new-bot') openBots(NEW_BOT_ID);
  else if (t.kind === 'bots') openBots(null);
  else if (t.kind === 'bot' && typeof t.id === 'string') {
    const want = t.id.trim().toLowerCase();
    const match = get(botsStore).find((bot) => bot.id === t.id || bot.name.trim().toLowerCase() === want);
    openBots(match ? match.id : null);
  }
}

/**
 * Inline interactive visuals in agent replies (Orca's convention, Spacron's
 * name): a whole line `::spacron-visual{file="chart.html" title="Usage"}`
 * names an HTML page the agent wrote in `$SPACRON_CHAT_VISUALS_DIR`. The page
 * is served by `commands/chat_visuals.rs` on 127.0.0.1 with its own strict CSP
 * and shown in a sandboxed iframe (scripts on, no same-origin, no network).
 */

const DIRECTIVE = /^ {0,3}::spacron-visual\{([^\n]*)\}[ \t]*\r?$/;
const FILE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*\.html$/;
export const MAX_VISUALS_PER_REPLY = 8;

export interface VisualDirective {
  file: string;
  title: string | null;
}

/** The directive a whole line spells, or null. Unknown keys are ignored; `file` is required. */
export function parseVisualDirective(line: string): VisualDirective | null {
  const match = DIRECTIVE.exec(line);
  if (!match) return null;
  const attrs = new Map<string, string>();
  let rest = match[1].trim();
  while (rest) {
    const attr = /^([a-z]+)="([^"\\\u0000-\u001f]*)"\s*/.exec(rest);
    if (!attr || attrs.has(attr[1])) return null;
    attrs.set(attr[1], attr[2]);
    rest = rest.slice(attr[0].length);
  }
  const file = attrs.get('file') ?? '';
  if (!FILE_NAME.test(file) || file.includes('..') || file.length > 128) return null;
  return { file, title: attrs.get('title')?.slice(0, 120) || null };
}

export type ReplySegment = { type: 'text'; text: string } | { type: 'visual'; visual: VisualDirective };

export function visualReplyText(segments: ReplySegment[]): string {
  return segments.flatMap((segment) => segment.type === 'text' ? [segment.text] : []).join('\n\n').trim();
}

/** Split a reply into Markdown runs and visuals, leaving directives inside code fences alone. */
export function splitReply(text: string): ReplySegment[] {
  const segments: ReplySegment[] = [];
  let buffer: string[] = [];
  let inFence = false;
  let visuals = 0;
  const flush = () => {
    if (buffer.join('').trim()) segments.push({ type: 'text', text: buffer.join('\n') });
    buffer = [];
  };
  for (const line of text.split('\n')) {
    if (/^ {0,3}(```|~~~)/.test(line)) inFence = !inFence;
    const visual = inFence ? null : parseVisualDirective(line);
    if (visual && visuals < MAX_VISUALS_PER_REPLY) {
      flush();
      segments.push({ type: 'visual', visual });
      visuals += 1;
    } else if (!visual) {
      buffer.push(line);
    }
  }
  flush();
  return segments;
}

/** Whether a CSS colour has real hue; monochrome themes use a white or grey accent, which makes unreadable charts. */
function isColourful(value: string): boolean {
  const probe = document.createElement('span');
  probe.style.color = value;
  document.body.appendChild(probe);
  const rgb = getComputedStyle(probe).color.match(/\d+(\.\d+)?/g)?.slice(0, 3).map(Number) ?? [];
  probe.remove();
  if (rgb.length < 3) return false;
  return Math.max(...rgb) - Math.min(...rgb) > 40;
}

/** The app's theme as the token names visuals style against (Orca's set). */
function themeTokens(): Record<string, string> {
  const css = getComputedStyle(document.documentElement);
  const v = (name: string, fallback: string) => css.getPropertyValue(name).trim() || fallback;
  const light = document.documentElement.classList.contains('light-theme');
  const background = v('--app-surface', light ? '#efefef' : '#101010');
  const menu = v('--surface-menu', background);
  const foreground = v('--chat-surface-ink', light ? '#171717' : '#f4f4f5');
  const themeAccent = v('--accent', '#7c6af7');
  const onAccent = v('--on-accent', light ? '#ffffff' : '#101010');
  const tint = (amount: number) => `color-mix(in srgb, ${foreground} ${amount}%, ${background})`;
  return {
    'color-scheme': light ? 'light' : 'dark',
    '--background': background,
    '--foreground': foreground,
    '--card': background,
    '--card-foreground': foreground,
    '--popover': menu,
    '--popover-foreground': foreground,
    '--primary': themeAccent,
    '--primary-foreground': onAccent,
    '--secondary': tint(8),
    '--secondary-foreground': foreground,
    '--muted': tint(10),
    '--muted-foreground': v('--chat-surface-muted', light ? '#495467' : '#b0bac9'),
    '--accent': themeAccent,
    '--accent-foreground': onAccent,
    '--destructive': v('--error', '#ef4444'),
    '--destructive-foreground': '#ffffff',
    '--border': tint(16),
    '--input': tint(16),
    '--ring': themeAccent,
    '--radius': v('--bento-radius', '16px'),
    '--font-sans': v('--font-sans', 'system-ui, sans-serif'),
    '--font-mono': v('--terminal-font-family', 'ui-monospace, monospace'),
    '--chart-1': isColourful(themeAccent) ? themeAccent : light ? '#5345c7' : '#a49aff',
    '--chart-2': light ? '#08795d' : '#5cdbad',
    '--chart-3': light ? '#a75b00' : '#ffc76c',
    '--chart-4': light ? '#03788f' : '#59c8ef',
    '--chart-5': light ? '#b12d72' : '#f584b3',
  };
}

const MIN_HEIGHT = 60;
const MAX_INLINE_HEIGHT = 900;

function VisualFrame({ src, title, height, onHeight, onCompose, onNavigate, onEscape, botMode, className }: {
  src: string;
  title: string;
  height: number | null;
  onHeight?: (h: number) => void;
  /** Called after the page sent the user somewhere (a bot, the bot list); the expanded view closes. */
  onNavigate?: () => void;
  /** Bot chats only: the page gets the bots and the 24 avatars and may open or message a bot. */
  botMode?: boolean;
  /** The page's `window.spacron.compose(text)`: a request handed back to the chat composer. */
  onCompose?: (text: string) => void;
  onEscape?: () => void;
  className: string;
}) {
  const channel = useMemo(() => crypto.randomUUID(), []);
  const frameRef = useRef<HTMLIFrameElement | null>(null);
  const [initialTheme] = useState(() => encodeURIComponent(JSON.stringify(themeTokens())));
  const lastTheme = useRef('');

  function sendTheme(force = false) {
    const theme = themeTokens();
    const value = JSON.stringify(theme);
    if (!force && value === lastTheme.current) return;
    lastTheme.current = value;
    // Sandboxed documents have an opaque origin. The channel and window
    // identity are checked on both sides of the bridge.
    frameRef.current?.contentWindow?.postMessage({ spacronVisual: channel, action: 'theme', theme }, '*');
  }

  useEffect(() => {
    let pending: number | undefined;
    const refreshTheme = () => {
      if (pending !== undefined) return;
      pending = requestAnimationFrame(() => {
        pending = undefined;
        sendTheme();
      });
    };
    const observer = new MutationObserver(refreshTheme);
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ['class', 'style'] });
    observer.observe(document.body, { attributes: true, attributeFilter: ['class', 'style'] });
    return () => {
      observer.disconnect();
      if (pending !== undefined) cancelAnimationFrame(pending);
    };
  }, [channel]);

  function sendBots() {
    if (!botMode) return;
    void Promise.all([botsForVisual(), avatarsForVisual()]).then(([list, avatars]) => {
      frameRef.current?.contentWindow?.postMessage({ spacronVisual: channel, action: 'bots', bots: list, avatars }, '*');
    });
  }

  // Keep the page's bot list (names and pictures) current as bots change.
  useEffect(() => {
    const unsubscribe = botsStore.subscribe(() => sendBots());
    return unsubscribe;
  }, [channel]);

  useEffect(() => {
    const onMessage = (event: MessageEvent) => {
      const data = event.data as { spacronVisual?: string; height?: number; action?: string; text?: string; target?: unknown; bot?: unknown } | null;
      if (!data || data.spacronVisual !== channel || event.source !== frameRef.current?.contentWindow) return;
      if (data.action === 'send-to-bot') {
        if (!botMode) return;
        sendToBot(data.bot, data.text);
        onNavigate?.();
        return;
      }
      if (data.action === 'open') {
        if (!botMode) return;
        openTarget(data.target);
        onNavigate?.();
        return;
      }
      if (data.action === 'compose') {
        if (typeof data.text === 'string' && data.text.trim()) onCompose?.(data.text.slice(0, 4000));
        return;
      }
      if (data.action === 'escape') {
        onEscape?.();
        return;
      }
      if (onHeight && typeof data.height === 'number' && Number.isFinite(data.height)) onHeight(data.height);
    };
    window.addEventListener('message', onMessage);
    return () => window.removeEventListener('message', onMessage);
  }, [channel, onHeight, onCompose, onEscape]);

  return (
    <iframe
      ref={frameRef}
      className={className}
      aria-label={title}
      tabIndex={0}
      src={`${src}?c=${channel}${onHeight ? '&layout=inline' : ''}#${initialTheme}`}
      onLoad={() => { sendTheme(true); sendBots(); }}
      // Scripts run so the page can be interactive; no allow-same-origin, so it
      // cannot reach the app, its storage or the chat around it.
      sandbox="allow-scripts allow-downloads"
      referrerPolicy="no-referrer"
      style={height ? { height } : undefined}
    />
  );
}

export function ChatVisualStatus({ title, text }: { title: string; text: string }) {
  return (
    <div className="chat-visual missing" role="status">
      <div className="chat-visual-bar"><strong className="chat-visual-title">{title}</strong></div>
      <p className="chat-visual-status">{text}</p>
    </div>
  );
}

/** One visual in a reply: a card with the live page, sized to its content, with a full-size view. */
export function ChatVisual({ visual, spot, onCompose, botMode }: {
  visual: VisualDirective;
  spot: ChatVisualsSpot | null;
  onCompose?: (text: string) => void;
  /** Set only by the Bots chat; agent chats keep the plain visual. */
  botMode?: boolean;
}) {
  const [height, setHeight] = useState<number | null>(null);
  const [expanded, setExpanded] = useState(false);
  const dialogRef = useRef<HTMLDivElement>(null);
  const close = () => setExpanded(false);
  const title = visual.title ?? visual.file.replace(/\.html$/, '').replace(/[-_]+/g, ' ');
  useModalFocus(dialogRef, close, expanded);

  if (!spot) return <ChatVisualStatus title={title} text="This agent needs a Spacron visuals folder to display the interactive page." />;
  const src = `${spot.baseUrl}${visual.file}`;
  return (
    <div className="chat-visual">
      <div className="chat-visual-bar">
        <strong className="chat-visual-title">{title}</strong>
        <button
          type="button"
          className="chat-visual-btn"
          aria-label="Open in app browser"
          onClick={() => void openUrlInPreviewPanel(`${src}#${encodeURIComponent(JSON.stringify(themeTokens()))}`)}
        >
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M14 4h6v6M20 4l-9 9M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5" /></svg>
        </button>
        <button type="button" className="chat-visual-btn expand" aria-haspopup="dialog" aria-expanded={expanded} onClick={() => setExpanded(true)}>
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5" /></svg>
          Expand
        </button>
      </div>
      <VisualFrame
        src={src}
        title={title}
        className="chat-visual-frame"
        onCompose={onCompose}
        botMode={botMode}
        height={height}
        onHeight={(h) => setHeight(Math.min(MAX_INLINE_HEIGHT, Math.max(MIN_HEIGHT, h)))}
      />
      {expanded && createPortal(
        <div className="chat-visual-overlay" onMouseDown={(e) => { if (e.target === e.currentTarget) close(); }}>
          <div className="chat-visual-modal" ref={dialogRef} role="dialog" aria-modal="true" aria-label={title}>
            <div className="chat-visual-bar">
              <strong className="chat-visual-title">{title}</strong>
              <button type="button" className="chat-visual-btn" aria-label="Close visual" onClick={close}>
                <svg width="12" height="12" viewBox="0 0 12 12" aria-hidden="true"><path d="M2 2l8 8M10 2 2 10" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" /></svg>
              </button>
            </div>
            <VisualFrame
              src={src}
              title={title}
              className="chat-visual-frame full"
              height={null}
              onEscape={close}
              onNavigate={close}
              botMode={botMode}
              onCompose={(text) => {
                onCompose?.(text);
                close();
              }}
            />
          </div>
        </div>,
        document.body,
      )}
    </div>
  );
}
