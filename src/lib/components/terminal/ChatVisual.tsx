import { useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { invoke } from '@tauri-apps/api/core';
import type { ChatVisualsSpot } from '$lib/stores/terminal';

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
  const themeAccent = v('--accent', '#7c6af7');
  const accent = isColourful(themeAccent) ? themeAccent : '#6366f1';
  return {
    'color-scheme': light ? 'light' : 'dark',
    '--background': v('--bg-primary', light ? '#ffffff' : '#0f0f12'),
    '--foreground': v('--text-primary', light ? '#171717' : '#e5e7eb'),
    '--card': v('--bg-secondary', light ? '#f8fafc' : '#16161a'),
    '--card-foreground': v('--text-primary', light ? '#171717' : '#e5e7eb'),
    '--popover': v('--bg-secondary', light ? '#ffffff' : '#16161a'),
    '--popover-foreground': v('--text-primary', light ? '#171717' : '#e5e7eb'),
    '--primary': themeAccent,
    '--primary-foreground': '#ffffff',
    '--secondary': light ? '#f1f5f9' : '#1f2937',
    '--secondary-foreground': v('--text-primary', light ? '#171717' : '#e5e7eb'),
    '--muted': light ? '#f1f5f9' : '#1c1c22',
    '--muted-foreground': v('--text-muted', light ? '#64748b' : '#9ca3af'),
    '--accent': themeAccent,
    '--accent-foreground': '#ffffff',
    '--destructive': v('--error', '#ef4444'),
    '--destructive-foreground': '#ffffff',
    '--border': v('--border', light ? '#e2e8f0' : '#27272f'),
    '--input': v('--border', light ? '#e2e8f0' : '#27272f'),
    '--ring': themeAccent,
    '--radius': '10px',
    '--font-sans': v('--font-sans', 'system-ui, sans-serif'),
    '--font-mono': v('--terminal-font-family', 'ui-monospace, monospace'),
    '--chart-1': accent,
    '--chart-2': v('--success', '#22c55e'),
    '--chart-3': '#f59e0b',
    '--chart-4': '#06b6d4',
    '--chart-5': '#ec4899',
  };
}

const MIN_HEIGHT = 60;
const MAX_INLINE_HEIGHT = 900;

function VisualFrame({ src, title, height, onHeight, onCompose, className }: {
  src: string;
  title: string;
  height: number | null;
  onHeight?: (h: number) => void;
  /** The page's `window.spacron.compose(text)`: a request handed back to the chat composer. */
  onCompose?: (text: string) => void;
  className: string;
}) {
  const channel = useMemo(() => crypto.randomUUID(), []);
  const frameRef = useRef<HTMLIFrameElement | null>(null);
  const theme = useMemo(() => encodeURIComponent(JSON.stringify(themeTokens())), []);

  useEffect(() => {
    const onMessage = (event: MessageEvent) => {
      const data = event.data as { spacronVisual?: string; height?: number; action?: string; text?: string } | null;
      if (!data || data.spacronVisual !== channel || event.source !== frameRef.current?.contentWindow) return;
      if (data.action === 'compose') {
        if (typeof data.text === 'string' && data.text.trim()) onCompose?.(data.text.slice(0, 4000));
        return;
      }
      if (onHeight && typeof data.height === 'number' && Number.isFinite(data.height)) onHeight(data.height);
    };
    window.addEventListener('message', onMessage);
    return () => window.removeEventListener('message', onMessage);
  }, [channel, onHeight, onCompose]);

  return (
    <iframe
      ref={frameRef}
      className={className}
      title={title}
      src={`${src}?c=${channel}#${theme}`}
      // Scripts run so the page can be interactive; no allow-same-origin, so it
      // cannot reach the app, its storage or the chat around it.
      sandbox="allow-scripts allow-downloads"
      referrerPolicy="no-referrer"
      style={height ? { height } : undefined}
    />
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
  const title = visual.title ?? visual.file;

  useEffect(() => {
    if (!expanded) return undefined;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.stopPropagation();
        setExpanded(false);
      }
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [expanded]);

  if (!spot) {
    return (
      <div className="chat-visual missing">
        <span>{title}</span>
        <em>This visual can't be shown: the agent wasn't started from Spacron's launcher, so it has no visuals folder.</em>
      </div>
    );
  }
  const src = `${spot.baseUrl}${visual.file}`;
  return (
    <div className="chat-visual">
      <div className="chat-visual-bar">
        <span className="chat-visual-title" title={visual.file}>{title}</span>
        <button
          type="button"
          className="chat-visual-btn"
          title="Open in your browser"
          aria-label="Open in your browser"
          onClick={() => void invoke('preview_open_in_browser', { url: src }).catch(() => window.open(src, '_blank', 'noopener'))}
        >
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M14 4h6v6M20 4l-9 9M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5" /></svg>
        </button>
        <button type="button" className="chat-visual-btn" title="Full size" aria-label="Full size" onClick={() => setExpanded(true)}>
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5" /></svg>
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
        <div className="chat-visual-overlay" role="dialog" aria-label={title} onMouseDown={(e) => { if (e.target === e.currentTarget) setExpanded(false); }}>
          <div className="chat-visual-modal">
            <div className="chat-visual-bar">
              <span className="chat-visual-title">{title}</span>
              <button type="button" className="chat-visual-btn" title="Close (Esc)" aria-label="Close" onClick={() => setExpanded(false)}>
                <svg width="12" height="12" viewBox="0 0 12 12" aria-hidden="true"><path d="M2 2l8 8M10 2 2 10" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" /></svg>
              </button>
            </div>
            <VisualFrame
              src={src}
              title={title}
              className="chat-visual-frame full"
              height={null}
              onCompose={(text) => {
                onCompose?.(text);
                setExpanded(false);
              }}
            />
          </div>
        </div>,
        document.body,
      )}
    </div>
  );
}
