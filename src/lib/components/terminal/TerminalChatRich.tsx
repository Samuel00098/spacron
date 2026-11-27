/**
 * The richer parts of the terminal chat view, after Orca's native chat:
 * diff cards and each turn's changed files, the docked to-do list, subagent
 * runs, opened pull requests with CI, link previews, the find bar, the message
 * rail, jump-to-latest, queued follow-ups, the `/` and `@` menus, the
 * usage-limit row and message actions. `TerminalChatView` composes them.
 */

import { useEffect, useMemo, useRef, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { openUrlInPreviewPanel } from '$lib/stores/preview';
import { copyTextToClipboard } from '$lib/utils/clipboard';
import { useStore } from '$lib/react/useStore';
import { readAloudMessageId, readAloudSupported, toggleReadAloud } from '$lib/services/read-aloud';
import { readAloudSettings } from '$lib/stores/readAloud';
import { highlightLines, languageForPath } from '$lib/services/chat-highlight';
import {
  formatClock,
  parsePullRequestUrl,
  withContext,
  type DiffLine,
  type FileChange,
  type FileRollup,
  type SlashCommand,
  type SubagentCall,
  type TodoItem,
  type UsageLimit,
} from '$lib/services/terminal-chat-rich';
import type { TerminalChatItem, TranscriptResult } from '$lib/services/terminal-chat';
import type { QueuedMessage } from '$lib/services/terminal-chat-queue';
import './TerminalChatRich.css';

function openExternal(url: string) {
  void openUrlInPreviewPanel(url);
}

function baseName(path: string): string {
  return path.replace(/[\\/]+$/, '').split(/[\\/]/).pop() ?? path;
}

function dirName(path: string): string {
  const parts = path.replace(/\\/g, '/').split('/');
  parts.pop();
  return parts.join('/');
}

function Counts({ added, removed }: { added: number; removed: number }) {
  return (
    <span className="tcr-counts">
      {added > 0 && <span className="add">+{added}</span>}
      {removed > 0 && <span className="del">−{removed}</span>}
    </span>
  );
}

// ---------------------------------------------------------------------------
// Diffs
// ---------------------------------------------------------------------------

const DIFF_PREVIEW_ROWS = 80;

/** One file's change as a unified diff, highlighted in the file's language. */
export function DiffCard({ change, onOpen, defaultOpen = true, bare = false }: { change: FileChange; onOpen?: (path: string) => void; defaultOpen?: boolean; bare?: boolean }) {
  const [openState, setOpen] = useState(defaultOpen);
  // Bare: just the diff, under a tool line that already names the file.
  const open = bare || openState;
  const [all, setAll] = useState(false);
  const rows = useMemo(() => withContext(change.lines), [change.lines]);
  const shown = useMemo(() => (all ? rows : rows.slice(0, DIFF_PREVIEW_ROWS)), [rows, all]);
  const lang = languageForPath(change.path);
  const [html, setHtml] = useState<Map<DiffLine, string> | null>(null);

  useEffect(() => {
    if (!open || !lang) return;
    let cancelled = false;
    const lines = shown.filter((r): r is DiffLine => r != null);
    // Each side highlighted as one text, so strings and comments that span lines colour right.
    const side = (keep: (l: DiffLine) => boolean) => lines.filter(keep);
    const before = side((l) => l.type !== 'add');
    const after = side((l) => l.type !== 'del');
    void Promise.all([
      highlightLines(before.map((l) => l.text).join('\n'), lang),
      highlightLines(after.map((l) => l.text).join('\n'), lang),
    ]).then(([b, a]) => {
      if (cancelled || !b || !a) return;
      const map = new Map<DiffLine, string>();
      before.forEach((l, i) => map.set(l, b[i] ?? ''));
      after.forEach((l, i) => { if (!map.has(l)) map.set(l, a[i] ?? ''); });
      setHtml(map);
    });
    return () => { cancelled = true; };
  }, [open, lang, shown]);

  const label = change.kind === 'write' ? 'Created' : change.kind === 'delete' ? 'Deleted' : 'Edited';
  return (
    <div className={`tcr-diff${open ? ' open' : ''}${bare ? ' bare' : ''}`}>
      {!bare && <div className="tcr-diff-head">
        <button type="button" className="tcr-diff-toggle" aria-expanded={open} onClick={() => setOpen((v) => !v)}>
          <svg className="tcr-chevron" width="10" height="10" viewBox="0 0 10 10" aria-hidden="true"><path d="M3.5 2 6.5 5l-3 3" stroke="currentColor" strokeWidth="1.5" fill="none" strokeLinecap="round" strokeLinejoin="round" /></svg>
          <span className="tcr-diff-kind">{label}</span>
          <span className="tcr-diff-name">{baseName(change.path)}</span>
          {dirName(change.path) && <span className="tcr-diff-dir">{dirName(change.path)}</span>}
          <Counts added={change.added} removed={change.removed} />
        </button>
        {onOpen && change.kind !== 'delete' && (
          <button type="button" className="tcr-link-btn" onClick={() => onOpen(change.path)}>Open</button>
        )}
      </div>}
      {open && (
        <div className="tcr-diff-body" role="table" aria-label={`Changes to ${change.path}`}>
          {shown.map((row, index) => (row == null
            ? <div key={`gap-${index}`} className="tcr-diff-gap">⋯</div>
            : (
              <div key={index} className={`tcr-diff-row ${row.type}`}>
                <span className="tcr-diff-sign" aria-hidden="true">{row.type === 'add' ? '+' : row.type === 'del' ? '−' : ' '}</span>
                {html?.has(row)
                  ? <code dangerouslySetInnerHTML={{ __html: html.get(row) || ' ' }} />
                  : <code>{row.text || ' '}</code>}
              </div>
            )))}
          {!all && rows.length > DIFF_PREVIEW_ROWS && (
            <button type="button" className="tcr-diff-more" onClick={() => setAll(true)}>Show {rows.length - DIFF_PREVIEW_ROWS} more lines</button>
          )}
        </div>
      )}
    </div>
  );
}

/** The files one agent turn changed, under its last reply. Each opens to its diffs. */
export function TurnChanges({ files, changesFor, onOpen }: { files: FileRollup[]; changesFor: (path: string) => FileChange[]; onOpen: (path: string) => void }) {
  const [open, setOpen] = useState<string | null>(null);
  const added = files.reduce((n, f) => n + f.added, 0);
  const removed = files.reduce((n, f) => n + f.removed, 0);
  return (
    <div className="tcr-turn-changes">
      <div className="tcr-turn-changes-head">
        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z" /><path d="M14 3v5h5M9 14h6M12 11v6" /></svg>
        <span>{files.length === 1 ? 'Changed 1 file' : `Changed ${files.length} files`}</span>
        <Counts added={added} removed={removed} />
      </div>
      {files.map((file) => (
        <div key={file.path} className="tcr-turn-file">
          <button type="button" className="tcr-turn-file-row" title={file.path} aria-expanded={open === file.path} onClick={() => setOpen((v) => (v === file.path ? null : file.path))}>
            <span className={`tcr-file-badge${file.created ? ' new' : file.deleted ? ' gone' : ''}`}>{file.created ? 'A' : file.deleted ? 'D' : 'M'}</span>
            <span className="tcr-diff-name">{baseName(file.path)}</span>
            {dirName(file.path) && <span className="tcr-diff-dir">{dirName(file.path)}</span>}
            <Counts added={file.added} removed={file.removed} />
          </button>
          {!file.deleted && <button type="button" className="tcr-link-btn" onClick={() => onOpen(file.path)}>Open</button>}
          {open === file.path && (
            <div className="tcr-turn-file-diffs">
              {changesFor(file.path).map((change, i) => change.lines.length
                ? <DiffCard key={i} change={change} />
                : <div key={i} className="tcr-muted">Line changes unavailable</div>)}
            </div>
          )}
        </div>
      ))}
    </div>
  );
}

// ---------------------------------------------------------------------------
// To-do list
// ---------------------------------------------------------------------------

export function TodoDock({ todos }: { todos: TodoItem[] }) {
  const [open, setOpen] = useState(true);
  const done = todos.filter((t) => t.status === 'completed').length;
  const current = todos.find((t) => t.status === 'in_progress');
  return (
    <div className={`tcr-todos${open ? ' open' : ''}`}>
      <button type="button" className="tcr-todos-head" aria-expanded={open} onClick={() => setOpen((v) => !v)}>
        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M9 6h11M9 12h11M9 18h11M4 6l1 1 2-2M4 12l1 1 2-2M4 18l1 1 2-2" /></svg>
        <span className="tcr-todos-title">{done === todos.length ? 'All tasks done' : `${done} of ${todos.length} done`}</span>
        {!open && current && <span className="tcr-todos-current">{current.text}</span>}
        <svg className="tcr-chevron" width="10" height="10" viewBox="0 0 10 10" aria-hidden="true"><path d="M3.5 2 6.5 5l-3 3" stroke="currentColor" strokeWidth="1.5" fill="none" strokeLinecap="round" strokeLinejoin="round" /></svg>
      </button>
      {open && (
        <ul className="tcr-todos-list">
          {todos.map((todo, index) => (
            <li key={index} className={todo.status}>
              <span className="tcr-todo-box" aria-hidden="true">
                {todo.status === 'completed' && <svg width="9" height="9" viewBox="0 0 12 12"><path d="m2.5 6.2 2.3 2.3 4.7-5" stroke="currentColor" strokeWidth="1.8" fill="none" strokeLinecap="round" strokeLinejoin="round" /></svg>}
              </span>
              <span>{todo.text}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Subagents
// ---------------------------------------------------------------------------

/**
 * A subagent run: what it was asked, and (Claude Code) its own transcript,
 * read from the file it writes beside the parent conversation.
 */
export function SubagentRow({
  item,
  call,
  cwd,
  parentSessionId,
  live,
  renderTranscript,
}: {
  item: TerminalChatItem;
  call: SubagentCall;
  cwd: string | null;
  parentSessionId: string | null;
  live: boolean;
  renderTranscript: (items: TerminalChatItem[]) => React.ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const [transcript, setTranscript] = useState<TerminalChatItem[] | null>(null);
  const status = item.toolStatus ?? 'running';
  const canRead = Boolean(item.subagentId && cwd && parentSessionId);

  useEffect(() => {
    if (!open || !canRead) return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const load = async () => {
      try {
        const result = await invoke<TranscriptResult>('agent_subagent_transcript_read', {
          query: { cwd, sessionId: parentSessionId, agentId: item.subagentId },
        });
        if (!cancelled) setTranscript(result.messages);
      } catch {
        if (!cancelled) setTranscript([]);
      }
      // A running subagent keeps writing; follow it while open.
      if (!cancelled && (live || status === 'running')) timer = setTimeout(load, 2000);
    };
    void load();
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, [open, canRead, cwd, parentSessionId, item.subagentId, live, status]);

  const steps = transcript?.filter((i) => i.kind === 'tool').length ?? 0;
  return (
    <div className={`tcr-subagent ${status}${open ? ' open' : ''}`}>
      <button type="button" className="tcr-subagent-head" aria-expanded={open} onClick={() => setOpen((v) => !v)}>
        <span className={`terminal-chat-status-dot ${status}`} aria-hidden="true" />
        <span className="tcr-subagent-kind">{call.type ? call.type : 'Subagent'}</span>
        <span className="tcr-subagent-desc">{call.description}</span>
        {transcript && steps > 0 && <span className="tcr-subagent-steps">{steps === 1 ? '1 step' : `${steps} steps`}</span>}
        <svg className="tcr-chevron" width="10" height="10" viewBox="0 0 10 10" aria-hidden="true"><path d="M3.5 2 6.5 5l-3 3" stroke="currentColor" strokeWidth="1.5" fill="none" strokeLinecap="round" strokeLinejoin="round" /></svg>
      </button>
      {open && (
        <div className="tcr-subagent-body">
          {call.prompt && (
            <details className="tcr-subagent-prompt">
              <summary>Instructions</summary>
              <pre>{call.prompt}</pre>
            </details>
          )}
          {canRead && transcript == null && <div className="tcr-muted">Loading the subagent's work…</div>}
          {transcript && transcript.length > 0 && <div className="tcr-subagent-transcript">{renderTranscript(transcript)}</div>}
          {(!canRead || (transcript && transcript.length === 0)) && item.toolOutput && (
            <div className="tcr-subagent-result">
              <div className="tcr-muted">Result</div>
              <pre>{item.toolOutput}</pre>
            </div>
          )}
          {status === 'running' && !transcript?.length && !item.toolOutput && <div className="tcr-muted">Working…</div>}
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Pull requests
// ---------------------------------------------------------------------------

interface PullRequestStatus {
  number: number | null;
  title: string | null;
  state: string | null;
  draft: boolean;
  checksTotal: number;
  checksPassed: number;
  checksFailed: number;
  checksPending: number;
}

const prCache = new Map<string, { at: number; status: PullRequestStatus | null; error: string | null }>();

/** An opened pull request, with its state and CI checks from `gh`, refreshed while checks run. */
export function PullRequestCard({ url, ciLines = true }: { url: string; ciLines?: boolean }) {
  const ref = parsePullRequestUrl(url);
  const [state, setState] = useState(() => prCache.get(url) ?? null);

  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const load = async () => {
      let next: { at: number; status: PullRequestStatus | null; error: string | null };
      try {
        next = { at: Date.now(), status: await invoke<PullRequestStatus>('chat_pr_status', { url }), error: null };
      } catch (err) {
        next = { at: Date.now(), status: null, error: err instanceof Error ? err.message : String(err) };
      }
      prCache.set(url, next);
      if (cancelled) return;
      setState(next);
      const pending = next.status && next.status.state === 'OPEN' && (next.status.checksPending > 0 || next.status.checksTotal === 0);
      if (pending) timer = setTimeout(load, 45_000);
    };
    const cached = prCache.get(url);
    if (!cached || Date.now() - cached.at > 30_000) void load();
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, [url]);

  const status = state?.status ?? null;
  const prState = status?.draft ? 'DRAFT' : status?.state ?? null;
  let ci: { tone: string; text: string } | null = null;
  if (status && status.checksTotal > 0) {
    if (status.checksFailed) ci = { tone: 'error', text: `${status.checksFailed} of ${status.checksTotal} checks failed` };
    else if (status.checksPending) ci = { tone: 'running', text: `Checks running · ${status.checksPassed} of ${status.checksTotal} passed` };
    else ci = { tone: 'done', text: `All ${status.checksTotal} checks passed` };
  }
  const finished = ciLines && status && status.checksTotal > 0 && status.checksPending === 0;
  return (
    <>
    <button type="button" className="tcr-pr" onClick={() => openExternal(url)} title={url}>
      <svg className="tcr-pr-icon" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><circle cx="6" cy="6" r="2.2" /><circle cx="6" cy="18" r="2.2" /><circle cx="18" cy="18" r="2.2" /><path d="M6 8.2v7.6M18 15.8V9a3 3 0 0 0-3-3h-4m0 0 2.5-2.5M11 6l2.5 2.5" /></svg>
      <span className="tcr-pr-main">
        <span className="tcr-pr-title">{status?.title ?? (ref ? `${ref.owner}/${ref.repo} #${ref.number}` : url)}</span>
        <span className="tcr-pr-meta">
          {ref && <span>{ref.repo} #{ref.number}</span>}
          {prState && <span className={`tcr-pr-state ${prState.toLowerCase()}`}>{prState === 'OPEN' ? 'Open' : prState.charAt(0) + prState.slice(1).toLowerCase()}</span>}
          {ci && ciLines && <span className={`tcr-pr-ci ${ci.tone}`}><span className={`terminal-chat-status-dot ${ci.tone}`} />{ci.text}</span>}
          {state?.error && !status && <span className="tcr-muted">{state.error}</span>}
        </span>
      </span>
    </button>
    {finished && (
      <div className={`tcr-ci-line ${status.checksFailed ? 'error' : 'done'}`} role="status">
        <span className={`terminal-chat-status-dot ${status.checksFailed ? 'error' : 'done'}`} aria-hidden="true" />
        {status.checksFailed
          ? `CI failed on #${status.number ?? ref?.number ?? ''}: ${status.checksFailed} of ${status.checksTotal} checks failed`
          : `CI passed on #${status.number ?? ref?.number ?? ''}: all ${status.checksTotal} checks passed`}
      </div>
    )}
    </>
  );
}

// ---------------------------------------------------------------------------
// Link previews
// ---------------------------------------------------------------------------

interface LinkPreview { url: string; title: string | null; description: string | null; siteName: string | null; image: string | null }

const previewCache = new Map<string, Promise<LinkPreview | null>>();

function loadPreview(url: string): Promise<LinkPreview | null> {
  let pending = previewCache.get(url);
  if (!pending) {
    pending = invoke<LinkPreview>('chat_link_preview', { url }).catch(() => null);
    previewCache.set(url, pending);
  }
  return pending;
}

/** Web links in a reply, up to three, a sentence or two about each. */
export function LinkPreviews({ urls }: { urls: string[] }) {
  return (
    <div className="tcr-links">
      {urls.slice(0, 3).map((url) => <LinkPreviewCard key={url} url={url} />)}
    </div>
  );
}

function githubLabel(url: string): { title: string; meta: string } | null {
  const m = /^https:\/\/github\.com\/([\w.-]+)\/([\w.-]+)(?:\/(pull|issues|blob|tree|commit)\/([^?#]+))?/.exec(url);
  if (!m) return null;
  const [, owner, repo, kind, rest] = m;
  if (!kind) return { title: `${owner}/${repo}`, meta: 'GitHub repository' };
  if (kind === 'pull') return { title: `${owner}/${repo} #${rest.split('/')[0]}`, meta: 'Pull request' };
  if (kind === 'issues') return { title: `${owner}/${repo} #${rest.split('/')[0]}`, meta: 'Issue' };
  if (kind === 'commit') return { title: `${owner}/${repo}@${rest.slice(0, 7)}`, meta: 'Commit' };
  return { title: rest.split('/').slice(1).join('/') || repo, meta: `${owner}/${repo}` };
}

function LinkPreviewCard({ url }: { url: string }) {
  const github = githubLabel(url);
  const [preview, setPreview] = useState<LinkPreview | null>(null);
  useEffect(() => {
    if (github) return;
    let cancelled = false;
    void loadPreview(url).then((p) => { if (!cancelled) setPreview(p); });
    return () => { cancelled = true; };
  }, [url, github]);
  let host = url;
  try { host = new URL(url).hostname.replace(/^www\./, ''); } catch { /* keep the url */ }
  if (!github && (!preview || (!preview.title && !preview.description))) return null;
  return (
    <button type="button" className="tcr-link-card" onClick={() => openExternal(url)} title={url}>
      {preview?.image && <img src={preview.image} alt="" loading="lazy" referrerPolicy="no-referrer" onError={(e) => { (e.target as HTMLImageElement).style.display = 'none'; }} />}
      <span className="tcr-link-text">
        <span className="tcr-link-site">{github ? github.meta : preview?.siteName ?? host}</span>
        <span className="tcr-link-title">{github ? github.title : preview?.title ?? host}</span>
        {!github && preview?.description && <span className="tcr-link-desc">{preview.description}</span>}
      </span>
    </button>
  );
}

/** Web links in markdown text, in order, without images and duplicates. */
export function linksIn(text: string): string[] {
  const found: string[] = [];
  const re = /(!?)\[[^\]]*\]\((https?:\/\/[^\s)]+)\)|(?<![(\w])(https?:\/\/[^\s<>()[\]"'`]+[^\s<>()[\]"'`.,;:!?])/g;
  for (const m of text.matchAll(re)) {
    if (m[1] === '!') continue;
    const url = m[2] ?? m[3];
    if (url && !found.includes(url)) found.push(url);
  }
  return found;
}

// ---------------------------------------------------------------------------
// Find bar
// ---------------------------------------------------------------------------

type HighlightRegistry = { set: (name: string, h: unknown) => void; delete: (name: string) => void };
const highlights = (): HighlightRegistry | null =>
  typeof CSS !== 'undefined' && 'highlights' in CSS ? ((CSS as unknown as { highlights: HighlightRegistry }).highlights) : null;
const HighlightCtor = (): (new (...ranges: Range[]) => unknown) | null =>
  (typeof window !== 'undefined' && (window as unknown as { Highlight?: new (...r: Range[]) => unknown }).Highlight) || null;

/** Search the conversation on screen; matches are highlighted and stepped through. */
export function FindBar({ root, onClose, revision }: { root: HTMLElement | null; onClose: () => void; revision: unknown }) {
  const [query, setQuery] = useState('');
  const [ranges, setRanges] = useState<Range[]>([]);
  const [index, setIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => { inputRef.current?.focus(); inputRef.current?.select(); }, []);

  useEffect(() => {
    const needle = query.trim().toLowerCase();
    if (!root || needle.length < 1) {
      setRanges([]);
      return;
    }
    const found: Range[] = [];
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
      acceptNode: (node) => (node.parentElement?.closest('.tcr-skip-find, button, script, style') ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT),
    });
    for (let node = walker.nextNode(); node && found.length < 2000; node = walker.nextNode()) {
      const text = node.textContent?.toLowerCase() ?? '';
      for (let at = text.indexOf(needle); at >= 0 && found.length < 2000; at = text.indexOf(needle, at + needle.length)) {
        const range = document.createRange();
        range.setStart(node, at);
        range.setEnd(node, at + needle.length);
        found.push(range);
      }
    }
    setRanges(found);
    setIndex((i) => Math.min(i, Math.max(0, found.length - 1)));
  }, [query, root, revision]);

  useEffect(() => {
    const registry = highlights();
    const Ctor = HighlightCtor();
    if (!registry || !Ctor) return;
    registry.set('tc-find', new Ctor(...ranges));
    const current = ranges[index];
    if (current) registry.set('tc-find-current', new Ctor(current));
    else registry.delete('tc-find-current');
    return () => {
      registry.delete('tc-find');
      registry.delete('tc-find-current');
    };
  }, [ranges, index]);

  useEffect(() => {
    const current = ranges[index];
    const el = current?.startContainer.parentElement;
    if (!current || !el) return;
    // Open folded activity so a match inside it can be seen.
    el.scrollIntoView({ block: 'center' });
  }, [ranges, index]);

  const step = (delta: number) => {
    if (!ranges.length) return;
    setIndex((i) => (i + delta + ranges.length) % ranges.length);
  };

  return (
    <div className="tcr-find tcr-skip-find" role="search">
      <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true"><circle cx="11" cy="11" r="7" /><path d="m20 20-3.5-3.5" /></svg>
      <input
        ref={inputRef}
        value={query}
        placeholder="Find in chat"
        aria-label="Find in chat"
        onChange={(e) => { setQuery(e.target.value); setIndex(0); }}
        onKeyDown={(e) => {
          e.stopPropagation();
          if (e.key === 'Enter') { e.preventDefault(); step(e.shiftKey ? -1 : 1); }
          if (e.key === 'Escape') { e.preventDefault(); onClose(); }
        }}
      />
      <span className="tcr-find-count">{query.trim() ? (ranges.length ? `${index + 1} of ${ranges.length}` : 'No results') : ''}</span>
      <button type="button" title="Previous (Shift+Enter)" aria-label="Previous match" disabled={!ranges.length} onClick={() => step(-1)}>
        <svg width="11" height="11" viewBox="0 0 10 10" aria-hidden="true"><path d="M2.5 6.2 5 3.7l2.5 2.5" stroke="currentColor" strokeWidth="1.5" fill="none" strokeLinecap="round" strokeLinejoin="round" /></svg>
      </button>
      <button type="button" title="Next (Enter)" aria-label="Next match" disabled={!ranges.length} onClick={() => step(1)}>
        <svg width="11" height="11" viewBox="0 0 10 10" aria-hidden="true"><path d="M2.5 3.8 5 6.3l2.5-2.5" stroke="currentColor" strokeWidth="1.5" fill="none" strokeLinecap="round" strokeLinejoin="round" /></svg>
      </button>
      <button type="button" title="Close (Esc)" aria-label="Close find" onClick={onClose}>
        <svg width="9" height="9" viewBox="0 0 8 8" aria-hidden="true"><path d="M1 1l6 6M7 1 1 7" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" /></svg>
      </button>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Message rail and jump to latest
// ---------------------------------------------------------------------------

/**
 * A tick down the right edge for each of your messages, placed where it sits
 * in the conversation; click one to jump there. Hover shows its first words.
 */
export function MessageRail({ scroller, turns, revision }: { scroller: HTMLElement | null; turns: { id: string; text: string }[]; revision: unknown }) {
  const [marks, setMarks] = useState<{ id: string; top: number; text: string }[]>([]);
  const [viewport, setViewport] = useState({ top: 0, height: 1 });
  useEffect(() => {
    if (!scroller) return;
    let frame = 0;
    const updateViewport = () => {
      const height = Math.max(1, scroller.scrollHeight);
      setViewport({ top: scroller.scrollTop / height, height: scroller.clientHeight / height });
    };
    const measure = () => {
      const height = scroller.scrollHeight || 1;
      const origin = scroller.getBoundingClientRect().top;
      const next = turns
        .map((turn) => {
          const el = scroller.querySelector<HTMLElement>(`[data-turn-id="${CSS.escape(turn.id)}"]`);
          // offsetTop can be relative to a card or pane rather than this scroll
          // container. Rects plus scrollTop stay correct in every chat layout.
          return el ? { id: turn.id, top: (el.getBoundingClientRect().top - origin + scroller.scrollTop) / height, text: turn.text } : null;
        })
        .filter((m): m is { id: string; top: number; text: string } => m != null);
      setMarks(next);
      updateViewport();
    };
    const onScroll = () => {
      if (frame) return;
      frame = requestAnimationFrame(() => { frame = 0; updateViewport(); });
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(scroller);
    observer.observe(scroller.firstElementChild ?? scroller);
    scroller.addEventListener('scroll', onScroll, { passive: true });
    return () => {
      observer.disconnect();
      scroller.removeEventListener('scroll', onScroll);
      cancelAnimationFrame(frame);
    };
  }, [scroller, turns, revision]);
  if (marks.length < 2 || viewport.height >= 1) return null;
  const current = marks.filter((mark) => mark.top <= viewport.top + viewport.height * 0.3).at(-1)?.id ?? marks[0]?.id;
  return (
    <nav className="tcr-rail tcr-skip-find" aria-label="Your messages">
      <span className="tcr-rail-viewport" aria-hidden="true" style={{ top: `${viewport.top * 100}%`, height: `${viewport.height * 100}%` }} />
      {marks.map((mark) => (
        <button
          key={mark.id}
          type="button"
          className="tcr-rail-mark"
          style={{ top: `clamp(9px, ${Math.min(100, Math.max(0, mark.top * 100))}%, calc(100% - 9px))` }}
          aria-current={current === mark.id ? 'location' : undefined}
          title={mark.text.slice(0, 120)}
          aria-label={`Jump to: ${mark.text.slice(0, 60)}`}
          onClick={() => {
            const target = scroller?.querySelector(`[data-turn-id="${CSS.escape(mark.id)}"]`);
            if (scroller && target) scroller.scrollTo({ top: target.getBoundingClientRect().top - scroller.getBoundingClientRect().top + scroller.scrollTop - 16, behavior: 'smooth' });
          }}
        />
      ))}
    </nav>
  );
}

export function JumpToLatest({ unread, onClick }: { unread: number; onClick: () => void }) {
  return (
    <button type="button" className="tcr-jump" onClick={onClick} title="Jump to latest (End)">
      <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M12 5v14M5 12l7 7 7-7" /></svg>
      {unread > 0 ? (unread === 1 ? '1 new message' : `${unread} new messages`) : 'Jump to latest'}
    </button>
  );
}

// ---------------------------------------------------------------------------
// Composer menus
// ---------------------------------------------------------------------------

/** A skill or custom command an agent CLI loads (backend `chat_list_skills`). */
export interface ChatSkillEntry {
  name: string;
  description: string;
  /** `builtin`: one of the CLI's own commands, from Claude Code's live list. */
  kind: 'skill' | 'command' | 'builtin';
  source: string;
  insert: string;
}

export type ComposerSuggestion =
  | { kind: 'command'; command: SlashCommand }
  | { kind: 'skill'; skill: ChatSkillEntry }
  | { kind: 'file'; path: string };

function suggestionKey(item: ComposerSuggestion): string {
  if (item.kind === 'command') return `c:${item.command.name}`;
  if (item.kind === 'skill') return `s:${item.skill.name}`;
  return `f:${item.path}`;
}

function suggestionSection(item: ComposerSuggestion): string {
  if (item.kind === 'command') return 'Commands';
  if (item.kind === 'skill') return item.skill.kind === 'skill' ? 'Skills' : 'Custom commands';
  return 'Files and folders';
}

function sourceLabel(source: string): string {
  if (source === 'project') return 'Project';
  if (source === 'user') return 'Personal';
  if (source === 'system') return 'Built in';
  return source;
}

/** The composer's `/`, `$` and `@` menu, in sections: commands, skills, custom commands, files. */
export function ComposerMenu({
  items,
  active,
  onPick,
  onHover,
  title,
  onOpenFolder,
}: {
  items: ComposerSuggestion[];
  active: number;
  onPick: (item: ComposerSuggestion) => void;
  onHover: (index: number) => void;
  title: string;
  onOpenFolder?: (path: string) => void;
}) {
  const listRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    listRef.current?.querySelector<HTMLElement>('.tcr-suggest-item.active')?.scrollIntoView({ block: 'nearest' });
  }, [active]);
  const sections = new Set(items.map(suggestionSection));
  return (
    <div className="tcr-suggest terminal-chat-menu" role="listbox" aria-label={title} ref={listRef}>
      {sections.size <= 1 && <div className="tcr-suggest-title">{title}</div>}
      {items.map((item, index) => {
        const section = suggestionSection(item);
        const header = sections.size > 1 && (index === 0 || suggestionSection(items[index - 1]) !== section);
        return [
          header ? <div key={`h-${section}`} className="tcr-suggest-section">{section}</div> : null,
          <button
            key={suggestionKey(item)}
            type="button"
            role="option"
            aria-selected={index === active}
            className={`tcr-suggest-item${index === active ? ' active' : ''}`}
            onMouseDown={(e) => e.preventDefault()}
            onMouseEnter={() => onHover(index)}
            onClick={() => onPick(item)}
            title={item.kind === 'skill' ? item.skill.description : undefined}
          >
            {item.kind === 'command' && (
              <>
                <span className="tcr-suggest-name">{item.command.name}</span>
                <span className="tcr-suggest-desc">{item.command.description}</span>
              </>
            )}
            {item.kind === 'skill' && (
              <>
                <span className="tcr-suggest-name">{item.skill.name}</span>
                <span className="tcr-suggest-desc">{item.skill.description}</span>
                <span className="tcr-suggest-badge">{sourceLabel(item.skill.source)}</span>
              </>
            )}
            {item.kind === 'file' && (item.path.endsWith('/') ? (
              <>
                <svg className="tcr-suggest-folder" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" /></svg>
                <span className="tcr-suggest-name">{baseName(item.path.slice(0, -1))}/</span>
                <span className="tcr-suggest-desc">{dirName(item.path.slice(0, -1))}</span>
                {onOpenFolder && (
                  <span
                    className="tcr-suggest-open"
                    title="Open this folder (Right arrow)"
                    onClick={(e) => { e.stopPropagation(); onOpenFolder(item.path); }}
                  >
                    Open ›
                  </span>
                )}
              </>
            ) : (
              <>
                <span className="tcr-suggest-name">{baseName(item.path)}</span>
                <span className="tcr-suggest-desc">{dirName(item.path)}</span>
              </>
            ))}
          </button>,
        ];
      })}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Queued follow-ups
// ---------------------------------------------------------------------------

export function QueueCards({
  queue,
  onEdit,
  onDelete,
  onMove,
  onSendNow,
  paused = false,
  onResume,
}: {
  queue: QueuedMessage[];
  onEdit: (id: number, text: string) => void;
  onDelete: (id: number) => void;
  onMove: (id: number, delta: -1 | 1) => void;
  onSendNow: (id: number) => void;
  /** The last turn failed, so nothing is sent until Resume. */
  paused?: boolean;
  onResume?: () => void;
}) {
  const [editing, setEditing] = useState<number | null>(null);
  const [text, setText] = useState('');
  return (
    <div className="tcr-queue" aria-label="Queued messages">
      <div className="tcr-queue-title">
        {paused
          ? `${queue.length === 1 ? '1 message is' : `${queue.length} messages are`} on hold because the last turn failed`
          : queue.length === 1 ? '1 message waits for this turn to end' : `${queue.length} messages wait for this turn to end`}
        {paused && onResume && (
          <button type="button" className="tcr-link-btn" onClick={onResume} style={{ marginLeft: 8 }}>Resume</button>
        )}
      </div>
      {queue.map((message, index) => (
        <div key={message.id} className="tcr-queue-card">
          {editing === message.id ? (
            <textarea
              className="tcr-queue-edit"
              value={text}
              autoFocus
              rows={Math.min(6, Math.max(1, text.split('\n').length))}
              onChange={(e) => setText(e.target.value)}
              onKeyDown={(e) => {
                e.stopPropagation();
                if (e.key === 'Enter' && !e.shiftKey) {
                  e.preventDefault();
                  if (text.trim()) onEdit(message.id, text.trim());
                  setEditing(null);
                } else if (e.key === 'Escape') {
                  e.preventDefault();
                  setEditing(null);
                }
              }}
              onBlur={() => {
                if (text.trim()) onEdit(message.id, text.trim());
                setEditing(null);
              }}
            />
          ) : (
            <div className="tcr-queue-text" onDoubleClick={() => { setEditing(message.id); setText(message.text); }}>
              {message.images.length > 0 && <span className="tcr-queue-images">{message.images.length === 1 ? '1 image' : `${message.images.length} images`}</span>}
              {message.text}
            </div>
          )}
          <div className="tcr-queue-actions">
            <button type="button" title="Edit" aria-label="Edit queued message" onClick={() => { setEditing(message.id); setText(message.text); }}>
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M12 20h9M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4z" /></svg>
            </button>
            <button type="button" title="Move up" aria-label="Move up" disabled={index === 0} onClick={() => onMove(message.id, -1)}>
              <svg width="11" height="11" viewBox="0 0 10 10" aria-hidden="true"><path d="M2.5 6.2 5 3.7l2.5 2.5" stroke="currentColor" strokeWidth="1.5" fill="none" strokeLinecap="round" strokeLinejoin="round" /></svg>
            </button>
            <button type="button" title="Move down" aria-label="Move down" disabled={index === queue.length - 1} onClick={() => onMove(message.id, 1)}>
              <svg width="11" height="11" viewBox="0 0 10 10" aria-hidden="true"><path d="M2.5 3.8 5 6.3l2.5-2.5" stroke="currentColor" strokeWidth="1.5" fill="none" strokeLinecap="round" strokeLinejoin="round" /></svg>
            </button>
            <button type="button" title="Send now, into the running turn" aria-label="Send now" onClick={() => onSendNow(message.id)}>
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M12 19V5M5 12l7-7 7 7" /></svg>
            </button>
            <button type="button" title="Delete" aria-label="Delete queued message" onClick={() => onDelete(message.id)}>
              <svg width="9" height="9" viewBox="0 0 8 8" aria-hidden="true"><path d="M1 1l6 6M7 1 1 7" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" /></svg>
            </button>
          </div>
        </div>
      ))}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Usage limit
// ---------------------------------------------------------------------------

function countdown(ms: number): string {
  const minutes = Math.max(0, Math.ceil(ms / 60_000));
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.floor(minutes / 60);
  return `${hours} h ${minutes % 60} min`;
}

export function UsageLimitRow({
  limit,
  autoContinue,
  onToggleAuto,
  onContinue,
}: {
  limit: UsageLimit;
  autoContinue: boolean;
  onToggleAuto: (on: boolean) => void;
  onContinue: () => void;
}) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(timer);
  }, []);
  const waiting = limit.resetsAt != null && limit.resetsAt > now;
  return (
    <div className="tcr-limit" role="status">
      <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="9" /><path d="M12 7v5l3 2" /></svg>
      <span className="tcr-limit-text">
        <strong>Usage limit reached</strong>
        <span>
          {limit.resetsAt
            ? waiting ? `Resets at ${formatClock(limit.resetsAt, now)} (in ${countdown(limit.resetsAt - now)})` : 'The limit should have reset'
            : limit.text}
        </span>
      </span>
      <label className="tcr-limit-auto" title={limit.resetsAt ? 'Send "Continue where you left off." when the limit resets' : 'The reset time is unknown, so it cannot continue on its own'}>
        <input type="checkbox" checked={autoContinue} disabled={!limit.resetsAt} onChange={(e) => onToggleAuto(e.target.checked)} />
        Continue when it resets
      </label>
      <button type="button" className="tcr-link-btn" onClick={onContinue}>Continue now</button>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Message actions, timestamps, selection quote, suggestions
// ---------------------------------------------------------------------------

/**
 * Which message the pointer is on, tracked from pointer MOVEMENT rather than CSS
 * `:hover`. `:hover` follows whatever is under a still pointer, so while a reply
 * streams and the chat scrolls to the newest text, the "hovered" message kept
 * changing and each message's timestamp flickered on and off. Here the mark only
 * changes when the pointer actually moves (or leaves), so scrolling cannot
 * change it. CSS reads `[data-hot]` on the `.tcr-msg`.
 */
const hotMessage = new WeakMap<HTMLElement, HTMLElement | null>();

export function markPointerMessage(event: React.PointerEvent<HTMLElement>): void {
  const root = event.currentTarget;
  const next = event.target instanceof Element ? event.target.closest<HTMLElement>('.tcr-msg') : null;
  const previous = hotMessage.get(root) ?? null;
  if (previous === next) return;
  previous?.removeAttribute('data-hot');
  next?.setAttribute('data-hot', '');
  hotMessage.set(root, next);
}

export function clearPointerMessage(event: React.PointerEvent<HTMLElement>): void {
  const root = event.currentTarget;
  hotMessage.get(root)?.removeAttribute('data-hot');
  hotMessage.set(root, null);
}

export function MessageActions({
  text,
  time,
  replyId,
  onResend,
  canResend = true,
  onFork,
  onRewind,
  align = 'start',
}: {
  text: string;
  time?: number | null;
  replyId?: string;
  onResend?: (text: string) => Promise<boolean | void>;
  canResend?: boolean;
  onFork?: () => void;
  onRewind?: () => void;
  align?: 'start' | 'end';
}) {
  const [copied, setCopied] = useState(false);

  const [copyError, setCopyError] = useState(false);
  const [edit, setEdit] = useState<string | null>(null);
  const [sending, setSending] = useState(false);
  const [editError, setEditError] = useState('');
  const editButton = useRef<HTMLButtonElement>(null);
  const editedText = edit?.trim() ?? '';
  const changed = Boolean(editedText && editedText !== text.trim());

  function closeEditor() {
    setEdit(null);
    setEditError('');
    requestAnimationFrame(() => editButton.current?.focus({ preventScroll: true }));
  }

  async function resend() {
    if (!onResend || !canResend || !changed || sending) return;
    setSending(true);
    setEditError('');
    try {
      if (await onResend(editedText) !== false) closeEditor();
    } catch (error) {
      setEditError(error instanceof Error ? error.message : 'Could not send the edited request.');
    } finally {
      setSending(false);
    }
  }

  return (
    <>
      <div className={`tcr-actions ${align} tcr-skip-find`}>
        {time != null && <span className="tcr-time">{formatClock(time)}</span>}
        {text.trim() && <button
          type="button"
          title={copied ? 'Copied' : copyError ? 'Copy failed. Try again' : 'Copy message'}
          aria-label={copied ? 'Copied message' : 'Copy message'}
          onClick={() => {
            setCopyError(false);
            void copyTextToClipboard(text).then(() => {
              setCopied(true);
              setTimeout(() => setCopied(false), 1400);
            }, () => setCopyError(true));
          }}
        >
          {copied
            ? <svg width="12" height="12" viewBox="0 0 12 12" aria-hidden="true"><path d="m2.5 6.2 2.3 2.3 4.7-5" stroke="currentColor" strokeWidth="1.6" fill="none" strokeLinecap="round" strokeLinejoin="round" /></svg>
            : <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><rect x="9" y="9" width="12" height="12" rx="2" /><path d="M5 15V5a2 2 0 0 1 2-2h10" /></svg>}
        </button>}
        {replyId && text.trim() && <ReplyPlayback id={replyId} text={text} />}
        {onResend && text.trim() && (
          <button ref={editButton} type="button" aria-label="Edit request" title="Edit request" aria-expanded={edit !== null}
            onClick={() => { if (edit === null) setEdit(text); else if (!sending) closeEditor(); }}>
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="m14 6 4 4M4 20l4.5-1 11-11a2.8 2.8 0 0 0-4-4l-11 11L4 20Z" /></svg>
          </button>
        )}
        {onRewind && (
          <button type="button" title="Go back to here (opens the agent's rewind in the terminal)" aria-label="Rewind to here" onClick={onRewind}>
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M3 12a9 9 0 1 0 3-6.7L3 8" /><path d="M3 3v5h5" /></svg>
          </button>
        )}
        {onFork && (
          <button type="button" title="Fork this conversation into a new pane" aria-label="Fork conversation" onClick={onFork}>
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><circle cx="6" cy="5" r="2" /><circle cx="18" cy="5" r="2" /><circle cx="12" cy="19" r="2" /><path d="M6 7v2a3 3 0 0 0 3 3h6a3 3 0 0 0 3-3V7M12 12v5" /></svg>
          </button>
        )}
      </div>
      {edit !== null && <form className="tcr-request-editor tcr-skip-find" onSubmit={(event) => { event.preventDefault(); void resend(); }}>
        <textarea autoFocus aria-label="Edit request" rows={3} value={edit} disabled={sending}
          onChange={(event) => setEdit(event.currentTarget.value)}
          onKeyDown={(event) => {
            if (event.key === 'Escape' && !sending) {
              event.preventDefault();
              event.stopPropagation();
              closeEditor();
            }
          }} />
        {editError && <p role="alert">{editError}</p>}
        <div className="tcr-request-editor-footer">
          <span>Sends as a new message.</span>
          <button type="button" disabled={sending} onClick={closeEditor}>Cancel</button>
          <button className="tcr-send-revision" type="submit" disabled={!canResend || !changed || sending}>{sending ? 'Sending…' : 'Send revision'}</button>
        </div>
      </form>}
    </>
  );
}

function ReplyPlayback({ id, text }: { id: string; text: string }) {
  const reading = useStore(readAloudMessageId) === id;
  const { engine } = useStore(readAloudSettings);
  if (!reading && engine === 'system' && !readAloudSupported()) return null;
  const label = reading ? 'Stop reading' : 'Read reply aloud';
  return (
    <button type="button" title={label} aria-label={label} aria-pressed={reading} onClick={() => toggleReadAloud(id, text)}>
      <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
        {reading ? <rect x="6" y="6" width="12" height="12" rx="2" /> : <path d="M7 5a1 1 0 0 1 1.5-.9l12 7a1 1 0 0 1 0 1.8l-12 7A1 1 0 0 1 7 19Z" />}
      </svg>
    </button>
  );
}

/** A "Quote" button over text selected in the conversation. */
export function SelectionQuote({ container, onQuote }: { container: HTMLElement | null; onQuote: (text: string) => void }) {
  const [spot, setSpot] = useState<{ x: number; y: number; text: string } | null>(null);
  useEffect(() => {
    if (!container) return;
    const update = () => {
      const selection = window.getSelection();
      const text = selection?.toString().trim() ?? '';
      if (!selection || !text || selection.rangeCount === 0 || !container.contains(selection.anchorNode)) {
        setSpot(null);
        return;
      }
      const rect = selection.getRangeAt(0).getBoundingClientRect();
      const box = container.getBoundingClientRect();
      setSpot({ x: Math.min(box.width - 90, Math.max(8, rect.left - box.left + rect.width / 2 - 40)), y: rect.top - box.top - 34, text });
    };
    const onUp = () => requestAnimationFrame(update);
    container.addEventListener('mouseup', onUp);
    document.addEventListener('selectionchange', onUp);
    return () => {
      container.removeEventListener('mouseup', onUp);
      document.removeEventListener('selectionchange', onUp);
    };
  }, [container]);
  if (!spot) return null;
  return (
    <button
      type="button"
      className="tcr-quote tcr-skip-find"
      style={{ left: spot.x, top: Math.max(4, spot.y) }}
      onMouseDown={(e) => e.preventDefault()}
      onClick={() => {
        onQuote(spot.text);
        window.getSelection()?.removeAllRanges();
        setSpot(null);
      }}
    >
      <svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M7 7h4v4c0 3-1.5 5-4 6l-.8-1.4C7.6 14.8 8.3 13.6 8.4 12H7zm8 0h4v4c0 3-1.5 5-4 6l-.8-1.4c1.4-.8 2.1-2 2.2-3.6H15z" /></svg>
      Add to chat
    </button>
  );
}

const STARTERS = [
  'Explain how this project is structured',
  'Review my uncommitted changes',
  'Find and fix a bug in',
  'Write tests for',
];

export function SuggestedPrompts({ onPick }: { onPick: (text: string) => void }) {
  return (
    <div className="tcr-starters">
      {STARTERS.map((text) => (
        <button key={text} type="button" onClick={() => onPick(text.endsWith(' in') || text.endsWith(' for') ? `${text} ` : text)}>{text}</button>
      ))}
    </div>
  );
}

/** A thin divider above the first message that arrived while you were away. */
export function NewMessagesLine() {
  return <div className="tcr-new-line tcr-skip-find" role="separator"><span>New</span></div>;
}

/**
 * The preview card for a link the pointer rests on (Settings > Chat > Link
 * previews), placed under the link and kept on screen.
 */
export function LinkHoverCard({ url, rect, onEnter, onLeave }: { url: string; rect: DOMRect; onEnter: () => void; onLeave: () => void }) {
  const width = 340;
  const left = Math.max(8, Math.min(window.innerWidth - width - 8, rect.left));
  const below = rect.bottom + 6;
  const top = below + 120 > window.innerHeight ? Math.max(8, rect.top - 126) : below;
  return (
    <div className="tcr-link-hover tcr-skip-find" style={{ left, top }} onMouseEnter={onEnter} onMouseLeave={onLeave}>
      <LinkPreviewCard url={url} />
    </div>
  );
}

/** A slash command the user ran, as a compact row rather than a message bubble. */
export function CommandRow({ text }: { text: string }) {
  const [name, ...rest] = text.trim().split(/\s+/);
  return (
    <div className="tcr-command">
      <span className="tcr-command-chip">
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="m7 20 10-16" /></svg>
        <span className="tcr-command-name">{name.replace(/^\//, '')}</span>
        {rest.length > 0 && <span className="tcr-command-args">{rest.join(' ')}</span>}
      </span>
    </div>
  );
}

/** What a slash command printed, as Orca's command-output card. */
export function CommandOutput({ text }: { text: string }) {
  const lines = text.split('\n');
  const [open, setOpen] = useState(lines.length <= 18);
  return (
    <div className={`tcr-command-output${open ? ' open' : ''}`}>
      <pre>{open ? text : lines.slice(0, 18).join('\n')}</pre>
      {!open && <button type="button" className="tcr-link-btn" onClick={() => setOpen(true)}>Show all</button>}
    </div>
  );
}
