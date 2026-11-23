import { useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { openUrlInPreviewPanel } from '$lib/stores/preview';
import type { ChatVisualsSpot } from '$lib/stores/terminal';
import { useModalFocus } from '$lib/react/useModalFocus';

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

function VisualFrame({ src, title, height, onHeight, onCompose, onEscape, className }: {
  src: string;
  title: string;
  height: number | null;
  onHeight?: (h: number) => void;
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

  useEffect(() => {
    const onMessage = (event: MessageEvent) => {
      const data = event.data as { spacronVisual?: string; height?: number; action?: string; text?: string } | null;
      if (!data || data.spacronVisual !== channel || event.source !== frameRef.current?.contentWindow) return;
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
      onLoad={() => sendTheme(true)}
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
export function ChatVisual({ visual, spot, onCompose }: {
  visual: VisualDirective;
  spot: ChatVisualsSpot | null;
  onCompose?: (text: string) => void;
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
