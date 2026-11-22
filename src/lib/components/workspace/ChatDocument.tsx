import { useLayoutEffect, useMemo, useRef } from 'react';
import { invoke, convertFileSrc } from '@tauri-apps/api/core';
import { marked } from 'marked';
import DOMPurify from 'dompurify';
import { highlightCode, classHighlighter } from '@lezer/highlight';
import type { Parser } from '@lezer/common';
import { loadLanguageExtension } from '$lib/components/editor/CodeEditor';
import { detectLanguage } from '$lib/stores/editor';
import { copyTextToClipboard } from '$lib/utils/clipboard';
import { isTauriRuntime } from '$lib/utils/tauri';
import { openUrlInPreviewPanel } from '$lib/stores/preview';
import './ChatDocument.css';

/** Fence names models use that are not file extensions `detectLanguage` knows. */
const FENCE_ALIASES: Record<string, string> = {
  javascript: 'js', typescript: 'ts', python: 'py', rust: 'rs', bash: 'sh', shell: 'sh', zsh: 'sh',
  console: 'sh', powershell: 'sh', ps1: 'sh', yml: 'yaml', golang: 'go', csharp: 'cs', 'c++': 'cpp',
  kotlin: 'kt', markdown: 'md', text: '', plaintext: '', txt: '',
};

function fenceLanguage(info: string): string {
  const name = info.trim().toLowerCase().split(/\s+/)[0] ?? '';
  const ext = name in FENCE_ALIASES ? FENCE_ALIASES[name] : name;
  if (!ext) return 'plaintext';
  const language = detectLanguage(`file.${ext}`);
  return language === 'image' ? 'plaintext' : language;
}

/** The lezer parser inside a grammar extension (LanguageSupport or a bare Language). */
function parserOf(extension: unknown): Parser | null {
  const value = extension as { language?: { parser?: Parser }; parser?: Parser } | null;
  return value?.language?.parser ?? value?.parser ?? null;
}

/** Colour a <code> element in place with the editor's grammar for `language`. */
async function highlightBlock(code: HTMLElement, language: string): Promise<void> {
  const extension = await loadLanguageExtension(language);
  const parser = parserOf(extension);
  if (!parser || !code.isConnected) return;
  const text = code.textContent ?? '';
  const fragment = document.createDocumentFragment();
  highlightCode(text, parser.parse(text), classHighlighter, (chunk, classes) => {
    if (!classes) { fragment.appendChild(document.createTextNode(chunk)); return; }
    const span = document.createElement('span');
    span.className = classes;
    span.textContent = chunk;
    fragment.appendChild(span);
  }, () => fragment.appendChild(document.createTextNode('\n')));
  code.replaceChildren(fragment);
}

function slug(text: string): string {
  return text.toLowerCase().trim().replace(/[^\w\s-]/g, '').replace(/\s+/g, '-');
}

function isAbsolutePath(path: string): boolean {
  return /^(?:[a-zA-Z]:)?[\\/]/.test(path);
}

/**
 * A Markdown file rendered as a document (GitHub-flavoured: tables, task
 * lists, fenced code with highlighting), for the chat's file viewer. Links
 * never navigate the app window: web links open in the browser, links to
 * other files go to `onOpenFile`, `#anchors` scroll.
 */
export default function ChatDocument({ source, filePath, onOpenFile }: {
  source: string;
  /** Absolute path of the file, to resolve relative links and images. */
  filePath: string;
  onOpenFile?: (absolutePath: string) => void;
}) {
  const ref = useRef<HTMLElement | null>(null);
  const folder = filePath.replace(/\\/g, '/').replace(/\/[^/]*$/, '');
  const html = useMemo(() => {
    try {
      return DOMPurify.sanitize(marked.parse(source, { gfm: true, breaks: false }) as string);
    } catch {
      return DOMPurify.sanitize(source);
    }
  }, [source]);
  const innerHtml = useMemo(() => ({ __html: html }), [html]);

  useLayoutEffect(() => {
    const root = ref.current;
    if (!root) return;
    const seen = new Map<string, number>();
    root.querySelectorAll<HTMLElement>('h1, h2, h3, h4, h5, h6').forEach((heading) => {
      const base = slug(heading.textContent ?? '') || 'section';
      const count = seen.get(base) ?? 0;
      seen.set(base, count + 1);
      heading.id = count ? `${base}-${count}` : base;
    });
    root.querySelectorAll<HTMLImageElement>('img').forEach((image) => {
      const src = image.getAttribute('src') ?? '';
      if (!src || /^(?:https?:|data:|blob:|asset:)/i.test(src) || !isTauriRuntime()) return;
      const path = isAbsolutePath(src) ? src : `${folder}/${src.replace(/^\.\//, '')}`;
      image.src = convertFileSrc(decodeURI(path));
    });
    root.querySelectorAll<HTMLTableElement>('table').forEach((table) => {
      if (table.parentElement?.classList.contains('chat-doc-table')) return;
      const wrap = document.createElement('div');
      wrap.className = 'chat-doc-table';
      table.replaceWith(wrap);
      wrap.appendChild(table);
    });
    root.querySelectorAll<HTMLElement>('pre > code').forEach((code) => {
      const pre = code.parentElement!;
      if (pre.dataset.enhanced) return;
      pre.dataset.enhanced = 'true';
      const info = /language-([\w+#-]+)/.exec(code.className)?.[1] ?? '';
      const language = fenceLanguage(info);
      const bar = document.createElement('div');
      bar.className = 'chat-doc-code-bar';
      const label = document.createElement('span');
      label.textContent = info || 'text';
      const copy = document.createElement('button');
      copy.type = 'button';
      copy.textContent = 'Copy';
      copy.addEventListener('click', () => {
        void copyTextToClipboard(code.textContent ?? '').then(() => {
          copy.textContent = 'Copied';
          setTimeout(() => { copy.textContent = 'Copy'; }, 1400);
        });
      });
      bar.append(label, copy);
      pre.prepend(bar);
      if (language !== 'plaintext') void highlightBlock(code, language);
    });
  }, [html, folder]);

  return (
    <article
      ref={ref}
      className="chat-file-viewer-doc chat-doc"
      onClick={(event) => {
        const anchor = (event.target as HTMLElement).closest('a');
        if (!anchor) return;
        const href = anchor.getAttribute('href') ?? '';
        event.preventDefault();
        if (href.startsWith('#')) {
          ref.current?.querySelector(`#${CSS.escape(decodeURIComponent(href.slice(1)))}`)?.scrollIntoView({ behavior: 'smooth', block: 'start' });
        } else if (/^(?:https?:|mailto:)/i.test(href)) {
          if (/^https?:/i.test(href)) void openUrlInPreviewPanel(href);
          else void invoke('preview_open_in_browser', { url: href }).catch(() => window.open(href, '_blank', 'noopener,noreferrer'));
        } else if (href && onOpenFile) {
          const path = decodeURI(href.split('#')[0]);
          onOpenFile(isAbsolutePath(path) ? path : `${folder}/${path.replace(/^\.\//, '')}`);
        }
      }}
      dangerouslySetInnerHTML={innerHtml}
    />
  );
}
