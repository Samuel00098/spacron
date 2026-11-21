import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { EditorContent, NodeViewContent, NodeViewWrapper, ReactNodeViewRenderer, useEditor, useEditorState, type Editor, type NodeViewProps } from '@tiptap/react';
import StarterKit from '@tiptap/starter-kit';
import { CodeBlock } from '@tiptap/extension-code-block';
import { Markdown } from '@tiptap/markdown';
import { TableKit } from '@tiptap/extension-table';
import { TaskItem, TaskList } from '@tiptap/extension-list';
import Image from '@tiptap/extension-image';
import { Placeholder } from '@tiptap/extensions';
import { updateContent } from '$lib/stores/editor';
import '$lib/components/preview/MarkdownPreview.css';
import './RichMarkdownEditor.css';

/**
 * WYSIWYG Markdown editing, modelled on Orca's rich Markdown mode: TipTap with
 * the official `@tiptap/markdown` bridge (parse with `contentType: 'markdown'`,
 * write back with `getMarkdown()`), a formatting toolbar, and a heading outline
 * on the left that can be collapsed by level.
 *
 * The file is only re-serialised when the user actually edits here — opening a
 * file never rewrites it — but the first edit does normalise its Markdown to
 * TipTap's style (list markers, table padding).
 */

type IconName =
  | 'toc' | 'paragraph' | 'bold' | 'italic' | 'strike' | 'code' | 'codeBlock' | 'bullet'
  | 'ordered' | 'task' | 'quote' | 'link' | 'image' | 'table' | 'rule' | 'undo' | 'redo'
  | 'close' | 'chevron';

const ICON_PATHS: Record<IconName, ReactNode> = {
  toc: (
    <>
      <path d="M3 6h.01M3 12h.01M3 18h.01" />
      <path d="M8 6h13M12 12h9M12 18h9" />
    </>
  ),
  paragraph: <path d="M13 4v16M17 4v16M19 4H9.5a4.5 4.5 0 0 0 0 9H13" />,
  bold: <path d="M6 12h9a4 4 0 0 1 0 8H7a1 1 0 0 1-1-1V5a1 1 0 0 1 1-1h7a4 4 0 0 1 0 8" />,
  italic: <path d="M19 4h-9M14 20H5M15 4 9 20" />,
  strike: <path d="M16 4H9a3 3 0 0 0-2.83 4M14 12a4 4 0 0 1 0 8H6M4 12h16" />,
  code: <path d="m16 18 6-6-6-6M8 6l-6 6 6 6" />,
  codeBlock: (
    <>
      <rect x="3" y="3" width="18" height="18" rx="2" />
      <path d="m10 9-3 3 3 3M14 15l3-3-3-3" />
    </>
  ),
  bullet: <path d="M3 6h.01M3 12h.01M3 18h.01M8 6h13M8 12h13M8 18h13" />,
  ordered: <path d="M10 6h11M10 12h11M10 18h11M4 6h1v4M4 10h2M6 18H4c0-1 2-2 2-3s-1-1.5-2-1" />,
  task: (
    <>
      <path d="m3 7 2 2 4-4" />
      <path d="M13 6h8M13 12h8M13 18h8" />
      <rect x="3" y="14" width="6" height="6" rx="1" />
    </>
  ),
  quote: (
    <>
      <path d="M16 3a2 2 0 0 0-2 2v6a2 2 0 0 0 2 2 1 1 0 0 1 1 1v1a2 2 0 0 1-2 2 1 1 0 0 0-1 1v2a1 1 0 0 0 1 1 6 6 0 0 0 6-6V5a2 2 0 0 0-2-2z" />
      <path d="M5 3a2 2 0 0 0-2 2v6a2 2 0 0 0 2 2 1 1 0 0 1 1 1v1a2 2 0 0 1-2 2 1 1 0 0 0-1 1v2a1 1 0 0 0 1 1 6 6 0 0 0 6-6V5a2 2 0 0 0-2-2z" />
    </>
  ),
  link: (
    <>
      <path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71" />
      <path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71" />
    </>
  ),
  image: (
    <>
      <rect x="3" y="3" width="18" height="18" rx="2" />
      <circle cx="9" cy="9" r="2" />
      <path d="m21 15-3.09-3.09a2 2 0 0 0-2.82 0L6 21" />
    </>
  ),
  table: (
    <>
      <rect x="3" y="3" width="18" height="18" rx="2" />
      <path d="M3 9h18M3 15h18M12 3v18" />
    </>
  ),
  rule: <path d="M3 12h18" />,
  undo: <path d="M3 7v6h6M21 17a9 9 0 0 0-9-9 9 9 0 0 0-6 2.3L3 13" />,
  redo: <path d="M21 7v6h-6M3 17a9 9 0 0 1 9-9 9 9 0 0 1 6 2.3L21 13" />,
  close: <path d="M18 6 6 18M6 6l12 12" />,
  chevron: <path d="m6 9 6 6 6-6" />,
};

function Icon({ name, size = 15 }: { name: IconName; size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      {ICON_PATHS[name]}
    </svg>
  );
}

interface HeadingEntry {
  level: number;
  text: string;
  pos: number;
}

function collectHeadings(editor: Editor): HeadingEntry[] {
  const out: HeadingEntry[] = [];
  editor.state.doc.descendants((node, pos) => {
    if (node.type.name === 'heading') {
      out.push({ level: Number(node.attrs.level) || 1, text: node.textContent.trim(), pos });
      return false;
    }
    return true;
  });
  return out;
}

/** The index of each entry's nearest enclosing heading (or -1). */
function parentIndexes(entries: HeadingEntry[]): number[] {
  const stack: number[] = [];
  return entries.map((entry, i) => {
    while (stack.length && entries[stack[stack.length - 1]].level >= entry.level) stack.pop();
    const parent = stack.length ? stack[stack.length - 1] : -1;
    stack.push(i);
    return parent;
  });
}

const NORMALIZE_META = 'spacronSoftBreaks';

const FENCE_LANGUAGES = [
  ['plain', 'Plain text'], ['bash', 'Bash'], ['c', 'C'], ['cpp', 'C++'], ['css', 'CSS'],
  ['diff', 'Diff'], ['go', 'Go'], ['graphql', 'GraphQL'], ['html', 'HTML'], ['java', 'Java'],
  ['javascript', 'JavaScript'], ['json', 'JSON'], ['kotlin', 'Kotlin'], ['markdown', 'Markdown'],
  ['mermaid', 'Mermaid'], ['powershell', 'PowerShell'], ['python', 'Python'], ['ruby', 'Ruby'],
  ['rust', 'Rust'], ['scss', 'SCSS'], ['sql', 'SQL'],
] as const;

function MarkdownCodeBlock({ node, updateAttributes }: NodeViewProps) {
  const language = String(node.attrs.language ?? 'plain');
  const [copied, setCopied] = useState(false);

  const copyCode = async () => {
    try {
      await navigator.clipboard.writeText(node.textContent);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1200);
    } catch (error) {
      console.error('Could not copy code block:', error);
    }
  };

  return (
    <NodeViewWrapper className="rich-md-codeblock">
      <div className="rich-md-codeblock-toolbar" contentEditable={false}>
        <span />
        <button type="button" className="rich-md-code-copy" onClick={() => void copyCode()} aria-label={copied ? 'Code copied' : 'Copy code'} title={copied ? 'Copied' : 'Copy code'}>
          {copied ? 'Copied' : (
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <rect x="8" y="8" width="13" height="13" rx="2" /><path d="M16 8V5a2 2 0 0 0-2-2H5a2 2 0 0 0-2 2v9a2 2 0 0 0 2 2h3" />
            </svg>
          )}
        </button>
        <select
          className="rich-md-code-language"
          value={language}
          aria-label="Code block language"
          onChange={(event) => updateAttributes({ language: event.target.value === 'plain' ? null : event.target.value })}
        >
          {!FENCE_LANGUAGES.some(([id]) => id === language) && <option value={language}>{language}</option>}
          {FENCE_LANGUAGES.map(([id, label]) => <option key={id} value={id}>{label}</option>)}
        </select>
      </div>
      <NodeViewContent<'pre'> as="pre" spellCheck={false} />
    </NodeViewWrapper>
  );
}

const RichCodeBlock = CodeBlock.extend({
  addNodeView() {
    return ReactNodeViewRenderer(MarkdownCodeBlock);
  },
});

/**
 * A hard-wrapped Markdown paragraph is one paragraph: its line breaks are soft
 * and render as spaces. The Markdown parser keeps them as `\n` inside the text,
 * and ProseMirror's `pre-wrap` would then show every source line break, so they
 * are turned into spaces here (outside code). The transaction is tagged so it
 * neither enters undo history nor counts as an edit to the file.
 */
function joinSoftBreaks(editor: Editor) {
  const { state } = editor;
  const edits: { from: number; to: number; text: string; marks: readonly unknown[] }[] = [];
  state.doc.descendants((node, pos, parent) => {
    if (node.type.spec.code) return false;
    if (node.isText && node.text?.includes('\n') && !parent?.type.spec.code) {
      edits.push({ from: pos, to: pos + node.nodeSize, text: node.text.replace(/[ \t]*\n[ \t]*/g, ' '), marks: node.marks });
    }
    return true;
  });
  if (!edits.length) return;
  const tr = state.tr;
  for (const e of edits.reverse()) {
    tr.replaceWith(e.from, e.to, state.schema.text(e.text, e.marks as never));
  }
  tr.setMeta('addToHistory', false).setMeta(NORMALIZE_META, true);
  editor.view.dispatch(tr);
}

function TableOfContents({
  editor,
  scrollRef,
  onClose,
}: {
  editor: Editor;
  scrollRef: React.RefObject<HTMLDivElement | null>;
  onClose: () => void;
}) {
  const headings = useEditorState({
    editor,
    selector: ({ editor: e }) => (e ? collectHeadings(e) : []),
    equalityFn: (a, b) =>
      !!b &&
      a.length === b.length && a.every((h, i) => h.level === b[i].level && h.text === b[i].text && h.pos === b[i].pos),
  });
  const parents = useMemo(() => parentIndexes(headings), [headings]);
  const hasChildren = useMemo(() => {
    const set = new Set<number>();
    parents.forEach((p) => p >= 0 && set.add(p));
    return set;
  }, [parents]);

  // Collapsed state is keyed by "level:text" so it survives edits elsewhere.
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const keyOf = (h: HeadingEntry, i: number) => `${h.level}:${h.text}:${i}`;
  const [activeIndex, setActiveIndex] = useState(-1);

  const visible = useMemo(() => {
    return headings.map((_, i) => {
      for (let p = parents[i]; p >= 0; p = parents[p]) {
        if (collapsed.has(keyOf(headings[p], p))) return false;
      }
      return true;
    });
  }, [headings, parents, collapsed]);

  const collapseToLevel = (level: number) => {
    const next = new Set<string>();
    headings.forEach((h, i) => {
      if (h.level >= level && hasChildren.has(i)) next.add(keyOf(h, i));
    });
    setCollapsed(next);
  };

  const toggle = (h: HeadingEntry, i: number) => {
    setCollapsed((prev) => {
      const next = new Set(prev);
      const k = keyOf(h, i);
      if (next.has(k)) next.delete(k);
      else next.add(k);
      return next;
    });
  };

  const jump = (h: HeadingEntry) => {
    const dom = editor.view.nodeDOM(h.pos);
    if (dom instanceof HTMLElement) dom.scrollIntoView({ block: 'start', behavior: 'smooth' });
    editor.chain().setTextSelection(h.pos + 1).focus(undefined, { scrollIntoView: false }).run();
  };

  // Highlight the heading the reader is currently in.
  useEffect(() => {
    const scroller = scrollRef.current;
    if (!scroller) return;
    let frame = 0;
    const update = () => {
      frame = 0;
      const top = scroller.getBoundingClientRect().top + 24;
      let current = -1;
      headings.forEach((h, i) => {
        const dom = editor.view.nodeDOM(h.pos);
        if (dom instanceof HTMLElement && dom.getBoundingClientRect().top <= top) current = i;
      });
      setActiveIndex(current === -1 && headings.length ? 0 : current);
    };
    const onScroll = () => {
      if (!frame) frame = requestAnimationFrame(update);
    };
    update();
    scroller.addEventListener('scroll', onScroll, { passive: true });
    return () => {
      scroller.removeEventListener('scroll', onScroll);
      if (frame) cancelAnimationFrame(frame);
    };
  }, [editor, headings, scrollRef]);

  return (
    <aside className="rich-md-toc" aria-label="Table of contents">
      <div className="rich-md-toc-header">
        <span className="rich-md-toc-title" title="Table of Contents">
          <Icon name="toc" size={14} />
          <span>Table of Contents</span>
        </span>
        <span className="rich-md-toc-levels" title="Collapse by level">
          {[1, 2, 3, 4, 5].map((level) => (
            <button key={level} type="button" onClick={() => collapseToLevel(level)} title={`Show headings up to H${level}`}>
              H{level}
            </button>
          ))}
        </span>
        <button type="button" className="rich-md-toc-close" onClick={onClose} title="Hide table of contents" aria-label="Hide table of contents">
          <Icon name="close" size={13} />
        </button>
      </div>
      <nav className="rich-md-toc-list">
        {headings.length === 0 && <p className="rich-md-toc-empty">No headings yet</p>}
        {headings.map((h, i) =>
          visible[i] ? (
            <div
              key={`${h.pos}-${i}`}
              className={`rich-md-toc-item${i === activeIndex ? ' active' : ''}`}
              style={{ paddingLeft: 6 + (h.level - 1) * 12 }}
            >
              {hasChildren.has(i) ? (
                <button
                  type="button"
                  className={`rich-md-toc-chevron${collapsed.has(keyOf(h, i)) ? ' collapsed' : ''}`}
                  onClick={() => toggle(h, i)}
                  aria-label={collapsed.has(keyOf(h, i)) ? 'Expand section' : 'Collapse section'}
                >
                  <Icon name="chevron" size={12} />
                </button>
              ) : (
                <span className="rich-md-toc-chevron-spacer" />
              )}
              <button type="button" className="rich-md-toc-link" onClick={() => jump(h)} title={h.text}>
                {h.text || 'Untitled'}
              </button>
            </div>
          ) : null,
        )}
      </nav>
    </aside>
  );
}

function ToolButton({
  icon,
  label,
  text,
  active,
  disabled,
  onClick,
}: {
  icon?: IconName;
  label: string;
  text?: string;
  active?: boolean;
  disabled?: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      className={`rich-md-tool${active ? ' active' : ''}`}
      title={label}
      aria-label={label}
      aria-pressed={active}
      disabled={disabled}
      // Keep the editor's selection: a mousedown on the button would blur it.
      onMouseDown={(e) => e.preventDefault()}
      onClick={onClick}
    >
      {icon ? <Icon name={icon} /> : <span className="rich-md-tool-text">{text}</span>}
    </button>
  );
}

function Toolbar({
  editor,
  onAskUrl,
}: {
  editor: Editor;
  onAskUrl: (kind: 'link' | 'image') => void;
}) {
  const s = useEditorState({
    editor,
    selector: ({ editor: e }) => ({
      paragraph: e.isActive('paragraph'),
      h1: e.isActive('heading', { level: 1 }),
      h2: e.isActive('heading', { level: 2 }),
      h3: e.isActive('heading', { level: 3 }),
      h4: e.isActive('heading', { level: 4 }),
      h5: e.isActive('heading', { level: 5 }),
      bold: e.isActive('bold'),
      italic: e.isActive('italic'),
      strike: e.isActive('strike'),
      code: e.isActive('code'),
      codeBlock: e.isActive('codeBlock'),
      bullet: e.isActive('bulletList'),
      ordered: e.isActive('orderedList'),
      task: e.isActive('taskList'),
      quote: e.isActive('blockquote'),
      link: e.isActive('link'),
      canUndo: e.can().undo(),
      canRedo: e.can().redo(),
    }),
  });
  const c = () => editor.chain().focus();

  return (
    <div className="rich-md-toolbar" role="toolbar" aria-label="Formatting">
      <ToolButton icon="paragraph" label="Paragraph" active={s.paragraph} onClick={() => c().setParagraph().run()} />
      <ToolButton text="H1" label="Heading 1" active={s.h1} onClick={() => c().toggleHeading({ level: 1 }).run()} />
      <ToolButton text="H2" label="Heading 2" active={s.h2} onClick={() => c().toggleHeading({ level: 2 }).run()} />
      <ToolButton text="H3" label="Heading 3" active={s.h3} onClick={() => c().toggleHeading({ level: 3 }).run()} />
      <ToolButton text="H4" label="Heading 4" active={s.h4} onClick={() => c().toggleHeading({ level: 4 }).run()} />
      <ToolButton text="H5" label="Heading 5" active={s.h5} onClick={() => c().toggleHeading({ level: 5 }).run()} />
      <span className="rich-md-sep" />
      <ToolButton icon="bold" label="Bold (Ctrl+B)" active={s.bold} onClick={() => c().toggleBold().run()} />
      <ToolButton icon="italic" label="Italic (Ctrl+I)" active={s.italic} onClick={() => c().toggleItalic().run()} />
      <ToolButton icon="strike" label="Strikethrough" active={s.strike} onClick={() => c().toggleStrike().run()} />
      <ToolButton icon="code" label="Inline code" active={s.code} onClick={() => c().toggleCode().run()} />
      <span className="rich-md-sep" />
      <ToolButton icon="bullet" label="Bulleted list" active={s.bullet} onClick={() => c().toggleBulletList().run()} />
      <ToolButton icon="ordered" label="Numbered list" active={s.ordered} onClick={() => c().toggleOrderedList().run()} />
      <ToolButton icon="task" label="Task list" active={s.task} onClick={() => c().toggleTaskList().run()} />
      <span className="rich-md-sep" />
      <ToolButton icon="quote" label="Quote" active={s.quote} onClick={() => c().toggleBlockquote().run()} />
      <ToolButton icon="codeBlock" label="Code block" active={s.codeBlock} onClick={() => c().toggleCodeBlock().run()} />
      <ToolButton icon="link" label="Link" active={s.link} onClick={() => onAskUrl('link')} />
      <ToolButton icon="image" label="Image" onClick={() => onAskUrl('image')} />
      <ToolButton
        icon="table"
        label="Insert table"
        onClick={() => c().insertTable({ rows: 3, cols: 3, withHeaderRow: true }).run()}
      />
      <ToolButton icon="rule" label="Divider" onClick={() => c().setHorizontalRule().run()} />
      <span className="rich-md-sep" />
      <ToolButton icon="undo" label="Undo (Ctrl+Z)" disabled={!s.canUndo} onClick={() => c().undo().run()} />
      <ToolButton icon="redo" label="Redo (Ctrl+Shift+Z)" disabled={!s.canRedo} onClick={() => c().redo().run()} />
    </div>
  );
}

function UrlBar({
  kind,
  initial,
  onSubmit,
  onCancel,
}: {
  kind: 'link' | 'image';
  initial: string;
  onSubmit: (value: string) => void;
  onCancel: () => void;
}) {
  const [value, setValue] = useState(initial);
  return (
    <div className="rich-md-urlbar">
      <span>{kind === 'link' ? 'Link' : 'Image URL'}</span>
      <input
        autoFocus
        value={value}
        placeholder={kind === 'link' ? 'Paste or type a link…' : 'https://… or a path'}
        onChange={(e) => setValue(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            e.preventDefault();
            onSubmit(value.trim());
          } else if (e.key === 'Escape') {
            e.preventDefault();
            e.stopPropagation();
            onCancel();
          }
        }}
      />
      <button type="button" onClick={() => onSubmit(value.trim())}>
        {kind === 'link' && !value.trim() && initial ? 'Remove' : 'Apply'}
      </button>
      <button type="button" onClick={onCancel}>
        Cancel
      </button>
    </div>
  );
}

export default function RichMarkdownEditor({
  filePath,
  content,
  tocOpen,
  onTocOpenChange,
}: {
  filePath: string;
  content: string;
  tocOpen: boolean;
  onTocOpenChange: (open: boolean) => void;
}) {
  // The Markdown this editor last produced or loaded, so a store update that
  // merely echoes our own edit does not reset the document (and the caret).
  const lastMarkdownRef = useRef(content);
  const scrollRef = useRef<HTMLDivElement>(null);
  const [urlPrompt, setUrlPrompt] = useState<{ kind: 'link' | 'image'; initial: string } | null>(null);

  const editor = useEditor(
    {
      extensions: [
        StarterKit.configure({
          heading: { levels: [1, 2, 3, 4, 5, 6] },
          link: { openOnClick: false, autolink: true },
          codeBlock: false,
        }),
        RichCodeBlock,
        TableKit.configure({ table: { resizable: false } }),
        TaskList,
        TaskItem.configure({ nested: true }),
        Image,
        Placeholder.configure({ placeholder: 'Start writing…' }),
        Markdown,
      ],
      content,
      contentType: 'markdown',
      shouldRerenderOnTransaction: false,
      editorProps: {
        attributes: { class: 'markdown-body rich-md-prose', spellcheck: 'true' },
      },
      onCreate: ({ editor: e }) => joinSoftBreaks(e),
      onUpdate: ({ editor: e, transaction }) => {
        if (transaction.getMeta(NORMALIZE_META)) return;
        const md = e.getMarkdown();
        lastMarkdownRef.current = md;
        updateContent(filePath, md);
      },
    },
    [filePath],
  );

  // Content changed outside this editor (source mode, reload from disk).
  useEffect(() => {
    if (!editor || editor.isDestroyed) return;
    const norm = (s: string) => s.replace(/\r\n/g, '\n');
    if (norm(content) === norm(lastMarkdownRef.current)) return;
    lastMarkdownRef.current = content;
    editor.commands.setContent(content, { contentType: 'markdown', emitUpdate: false });
    joinSoftBreaks(editor);
  }, [content, editor]);

  const setToc = useCallback((open: boolean) => onTocOpenChange(open), [onTocOpenChange]);

  const askUrl = (kind: 'link' | 'image') => {
    const initial = kind === 'link' && editor ? String(editor.getAttributes('link').href ?? '') : '';
    setUrlPrompt({ kind, initial });
  };

  const applyUrl = (value: string) => {
    if (!editor || !urlPrompt) return;
    const chain = editor.chain().focus();
    if (urlPrompt.kind === 'link') {
      if (!value) chain.extendMarkRange('link').unsetLink().run();
      else if (editor.state.selection.empty && !editor.isActive('link'))
        chain.insertContent({ type: 'text', text: value, marks: [{ type: 'link', attrs: { href: value } }] }).run();
      else chain.extendMarkRange('link').setLink({ href: value }).run();
    } else if (value) {
      chain.setImage({ src: value }).run();
    }
    setUrlPrompt(null);
  };

  if (!editor) return null;

  return (
    <div className="rich-md-editor">
      {tocOpen && <TableOfContents editor={editor} scrollRef={scrollRef} onClose={() => setToc(false)} />}
      <div className="rich-md-main">
        <Toolbar editor={editor} onAskUrl={askUrl} />
        {urlPrompt && (
          <UrlBar
            kind={urlPrompt.kind}
            initial={urlPrompt.initial}
            onSubmit={applyUrl}
            onCancel={() => {
              setUrlPrompt(null);
              editor.commands.focus();
            }}
          />
        )}
        <div className="rich-md-scroll markdown-container markdown-preview" ref={scrollRef}>
          <EditorContent editor={editor} />
        </div>
      </div>
    </div>
  );
}
