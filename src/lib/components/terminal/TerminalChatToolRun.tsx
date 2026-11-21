/**
 * An agent's tool activity drawn the way Orca's native chat draws it: a run
 * header that reads as a sentence ("Read 3 files, searched 2 times, and ran
 * 1 command") under one glyph, and inside it one line per call: glyph, verb,
 * target, muted context, line counts. A line opens to its detail: the diff for
 * an edit, the subagent's own work, the plan, or the command and its output.
 */

import { useEffect, useState } from 'react';
import {
  fileChangesFor,
  runGlyph,
  runSentence,
  subagentFor,
  todosFor,
  toolLine,
  TOOL_GLYPHS,
  type ToolGlyph,
} from '$lib/services/terminal-chat-rich';
import type { TerminalChatItem } from '$lib/services/terminal-chat';
import { DiffCard, SubagentRow } from './TerminalChatRich';

const GLYPH_PATHS: Record<ToolGlyph, React.ReactNode> = {
  eye: <><path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12z" /><circle cx="12" cy="12" r="3" /></>,
  search: <><circle cx="11" cy="11" r="7" /><path d="m20 20-3.5-3.5" /></>,
  folder: <path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" />,
  terminal: <><rect x="3" y="4" width="18" height="16" rx="2.5" /><path d="m7.5 9.5 3 2.5-3 2.5M13 15h3.5" /></>,
  pencil: <path d="M12 20h9M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4z" />,
  globe: <><circle cx="12" cy="12" r="9" /><path d="M3 12h18M12 3a14 14 0 0 1 0 18M12 3a14 14 0 0 0 0 18" /></>,
  plug: <path d="M12 22v-5M9 8V2M15 8V2M18 8v4a6 6 0 0 1-12 0V8z" />,
  bot: <><rect x="4" y="8" width="16" height="12" rx="2.5" /><path d="M12 8V4.5M9 13v2M15 13v2" /><circle cx="12" cy="4" r="1" /></>,
  'list-checks': <path d="m3 6 2 2 3.5-3.5M3 13l2 2 3.5-3.5M12 6h9M12 13h9M12 20h9" />,
  wrench: <path d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94z" />,
  brain: <path d="M9.5 3A3 3 0 0 0 6.5 6a3 3 0 0 0-2 5.2A3 3 0 0 0 6.5 16a3 3 0 0 0 3 3 2.5 2.5 0 0 0 2.5-2.5v-11A2.5 2.5 0 0 0 9.5 3zM14.5 3A3 3 0 0 1 17.5 6a3 3 0 0 1 2 5.2 3 3 0 0 1-2 4.8 3 3 0 0 1-3 3 2.5 2.5 0 0 1-2.5-2.5" />,
};

/** A fixed 16px slot, so every row's text starts in the same column. */
export function ToolGlyphIcon({ glyph, className = '' }: { glyph: ToolGlyph; className?: string }) {
  return (
    <span className={`tcr-glyph ${className}`} aria-hidden="true">
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round">
        {GLYPH_PATHS[glyph]}
      </svg>
    </span>
  );
}

function Chevron() {
  return (
    <svg className="tcr-chevron" width="10" height="10" viewBox="0 0 10 10" aria-hidden="true">
      <path d="M3.5 2 6.5 5l-3 3" stroke="currentColor" strokeWidth="1.5" fill="none" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function firstLine(text: string): string {
  return text.split('\n').find((line) => line.trim())?.trim() ?? '';
}

export interface ToolRunContext {
  cwd: string | null;
  parentSessionId: string | null;
  diffs: boolean;
  onOpenFile: (path: string) => void;
  renderNested: (items: TerminalChatItem[]) => React.ReactNode;
}

/** One run of tool calls and thinking between two replies. */
export function ToolRun({ items, live, context }: { items: TerminalChatItem[]; live: boolean; context: ToolRunContext | null }) {
  const [open, setOpen] = useState(false);
  const tools = items.filter((i) => i.kind === 'tool');
  const failed = tools.filter((i) => i.toolStatus === 'error').length;
  const last = items[items.length - 1];
  const running = live && (last.kind === 'reasoning' || (last.toolStatus ?? 'running') === 'running');
  const sentence = runSentence(tools, running) ?? (running ? 'Thinking' : 'Thought');
  const glyph: ToolGlyph = tools.length ? runGlyph(tools) : 'brain';
  // While the run is live, its newest line shows under the header so you can
  // follow along without opening it.
  const current = running && !open ? last : null;

  return (
    <div className={`tcr-run${open ? ' open' : ''}${running ? ' live' : ''}`}>
      <button type="button" className="tcr-run-head" aria-expanded={open} onClick={() => setOpen((v) => !v)}>
        <ToolGlyphIcon glyph={glyph} className={running ? 'live' : ''} />
        <span className={`tcr-run-sentence${running ? ' shimmer' : ''}`}>{sentence}</span>
        {failed > 0 && <span className="tcr-run-failed">{failed} failed</span>}
        <Chevron />
      </button>
      {current && (
        <div className="tcr-run-current">
          {current.kind === 'reasoning'
            ? <ReasoningLine text={current.text} live />
            : <ToolLineRow item={current} live context={context} />}
        </div>
      )}
      {open && (
        <div className="tcr-run-lines">
          {items.map((item) => (item.kind === 'reasoning'
            ? <ReasoningLine key={item.id} text={item.text} live={live && item === last} />
            : <ToolLineRow key={item.id} item={item} live={live} context={context} />))}
        </div>
      )}
    </div>
  );
}

function ReasoningLine({ text, live }: { text: string; live: boolean }) {
  const [open, setOpen] = useState(false);
  return (
    <div className={`tcr-line reasoning${open ? ' open' : ''}`}>
      <button type="button" className="tcr-line-head" aria-expanded={open} onClick={() => setOpen((v) => !v)}>
        <ToolGlyphIcon glyph="brain" />
        <span className={`tcr-line-verb${live ? ' shimmer' : ''}`}>{live ? 'Thinking' : 'Thought'}</span>
        {!open && <span className="tcr-line-context">{firstLine(text)}</span>}
      </button>
      {open && <div className="tcr-line-body"><div className="terminal-chat-reasoning">{text}</div></div>}
    </div>
  );
}

/** One tool call: glyph, verb, target, context; opens to its detail. */
export function ToolLineRow({ item, live, context }: { item: TerminalChatItem; live: boolean; context: ToolRunContext | null }) {
  const line = toolLine(item, live);
  const changes = line.category === 'fileChange' && context?.diffs !== false ? fileChangesFor(item) : [];
  const subagent = line.category === 'subagent' ? subagentFor(item) : null;
  const todos = line.category === 'todoList' ? todosFor(item) : null;
  // Small edits show their diff without a click, the way Orca opens them.
  const [open, setOpen] = useState(() => changes.length > 0 && changes.reduce((n, c) => n + c.lines.length, 0) <= 24);
  useEffect(() => { if (line.failed) setOpen(false); }, [line.failed]);

  if (subagent && context) {
    return (
      <SubagentRow
        item={item}
        call={subagent}
        cwd={context.cwd}
        parentSessionId={context.parentSessionId}
        live={live}
        renderTranscript={context.renderNested}
      />
    );
  }

  const hasDetail = changes.length > 0 || Boolean(todos?.length) || Boolean(item.toolInput) || Boolean(item.toolOutput);
  return (
    <div className={`tcr-line ${line.category}${open ? ' open' : ''}${line.failed ? ' failed' : ''}${line.running ? ' running' : ''}`}>
      <button type="button" className="tcr-line-head" aria-expanded={open} disabled={!hasDetail} onClick={() => setOpen((v) => !v)}>
        <ToolGlyphIcon glyph={TOOL_GLYPHS[line.category]} />
        <span className={`tcr-line-verb${line.running ? ' shimmer' : ''}`}>{line.verb}</span>
        {line.target && <span className={`tcr-line-target${line.code ? ' code' : ''}`}>{line.target}</span>}
        {line.context && <span className="tcr-line-context">{line.context}</span>}
        {(line.added > 0 || line.removed > 0) && (
          <span className="tcr-counts">
            {line.added > 0 && <span className="add">+{line.added}</span>}
            {line.removed > 0 && <span className="del">−{line.removed}</span>}
          </span>
        )}
        {line.failed && <span className="tcr-line-failed">Failed</span>}
      </button>
      {open && (
        <div className="tcr-line-body">
          {changes.length > 0 ? (
            changes.map((change, index) => (
              <div key={index} className="tcr-line-diff">
                {changes.length > 1 && <div className="tcr-line-diff-name">{change.path}</div>}
                <DiffCard change={change} bare />
                {context && change.kind !== 'delete' && (
                  <button type="button" className="tcr-link-btn" onClick={() => context.onOpenFile(change.path)}>Open {change.path.split(/[\\/]/).pop()}</button>
                )}
              </div>
            ))
          ) : todos?.length ? (
            <ul className="tcr-todos-list inline">
              {todos.map((todo, index) => (
                <li key={index} className={todo.status}>
                  <span className="tcr-todo-box" aria-hidden="true">
                    {todo.status === 'completed' && <svg width="9" height="9" viewBox="0 0 12 12"><path d="m2.5 6.2 2.3 2.3 4.7-5" stroke="currentColor" strokeWidth="1.8" fill="none" strokeLinecap="round" strokeLinejoin="round" /></svg>}
                  </span>
                  <span>{todo.text}</span>
                </li>
              ))}
            </ul>
          ) : (
            <>
              {item.toolInput && <pre className="tcr-line-input">{item.toolInput}</pre>}
              {item.toolOutput
                ? <pre className={`tcr-line-output${line.failed ? ' error' : ''}`}>{item.toolOutput}</pre>
                : line.running ? <div className="tcr-muted">Running…</div> : null}
            </>
          )}
        </div>
      )}
    </div>
  );
}
