/**
 * Syntax highlighting for code in the chat view, using the editor's own
 * CodeMirror grammars (each a lazy chunk) and Lezer's class highlighter, so a
 * block costs a parse, not an editor. Tokens get `tok-*` classes that
 * `TerminalChatRich.css` colours from the editor's `--syntax-*` theme tokens.
 */

import type { Parser } from '@lezer/common';
import { classHighlighter, highlightCode } from '@lezer/highlight';

type Loader = () => Promise<Parser>;

const stream = async (load: () => Promise<unknown>) => {
  const { StreamLanguage } = await import('@codemirror/language');
  return StreamLanguage.define((await load()) as never).parser;
};

const LOADERS: Record<string, Loader> = {
  javascript: async () => (await import('@codemirror/lang-javascript')).javascript({ jsx: true }).language.parser,
  typescript: async () => (await import('@codemirror/lang-javascript')).javascript({ typescript: true, jsx: true }).language.parser,
  html: async () => (await import('@codemirror/lang-html')).html().language.parser,
  css: async () => (await import('@codemirror/lang-css')).css().language.parser,
  rust: async () => (await import('@codemirror/lang-rust')).rust().language.parser,
  json: async () => (await import('@codemirror/lang-json')).json().language.parser,
  python: async () => (await import('@codemirror/lang-python')).python().language.parser,
  java: async () => (await import('@codemirror/lang-java')).java().language.parser,
  cpp: async () => (await import('@codemirror/lang-cpp')).cpp().language.parser,
  php: async () => (await import('@codemirror/lang-php')).php().language.parser,
  sql: async () => (await import('@codemirror/lang-sql')).sql().language.parser,
  xml: async () => (await import('@codemirror/lang-xml')).xml().language.parser,
  yaml: async () => (await import('@codemirror/lang-yaml')).yaml().language.parser,
  go: async () => (await import('@codemirror/lang-go')).go().language.parser,
  sass: async () => (await import('@codemirror/lang-sass')).sass().language.parser,
  toml: () => stream(async () => (await import('@codemirror/legacy-modes/mode/toml')).toml),
  shell: () => stream(async () => (await import('@codemirror/legacy-modes/mode/shell')).shell),
  powershell: () => stream(async () => (await import('@codemirror/legacy-modes/mode/powershell')).powerShell),
  diff: () => stream(async () => (await import('@codemirror/legacy-modes/mode/diff')).diff),
  ruby: () => stream(async () => (await import('@codemirror/legacy-modes/mode/ruby')).ruby),
  swift: () => stream(async () => (await import('@codemirror/legacy-modes/mode/swift')).swift),
  csharp: () => stream(async () => (await import('@codemirror/legacy-modes/mode/clike')).csharp),
  kotlin: () => stream(async () => (await import('@codemirror/legacy-modes/mode/clike')).kotlin),
};

const ALIASES: Record<string, string> = {
  js: 'javascript', jsx: 'javascript', mjs: 'javascript', cjs: 'javascript', node: 'javascript',
  ts: 'typescript', tsx: 'typescript', mts: 'typescript',
  htm: 'html', svelte: 'html', vue: 'html',
  scss: 'sass', less: 'css',
  rs: 'rust', py: 'python', python3: 'python',
  c: 'cpp', 'c++': 'cpp', h: 'cpp', hpp: 'cpp', cc: 'cpp',
  yml: 'yaml', jsonc: 'json', json5: 'json',
  sh: 'shell', bash: 'shell', zsh: 'shell', console: 'shell', shellscript: 'shell',
  ps1: 'powershell', pwsh: 'powershell', ps: 'powershell',
  patch: 'diff', rb: 'ruby', cs: 'csharp', kt: 'kotlin', golang: 'go', svg: 'xml',
};

const EXTENSION_LANGS: Record<string, string> = {
  ts: 'typescript', tsx: 'typescript', mts: 'typescript', cts: 'typescript',
  js: 'javascript', jsx: 'javascript', mjs: 'javascript', cjs: 'javascript',
  rs: 'rust', py: 'python', json: 'json', css: 'css', scss: 'sass', sass: 'sass',
  html: 'html', htm: 'html', svelte: 'html', vue: 'html', xml: 'xml', svg: 'xml',
  yml: 'yaml', yaml: 'yaml', toml: 'toml', go: 'go', java: 'java', php: 'php', sql: 'sql',
  c: 'cpp', h: 'cpp', cpp: 'cpp', hpp: 'cpp', cc: 'cpp', sh: 'shell', bash: 'shell',
  ps1: 'powershell', rb: 'ruby', swift: 'swift', cs: 'csharp', kt: 'kotlin',
};

export function languageForFence(name: string | null | undefined): string | null {
  if (!name) return null;
  const key = name.trim().toLowerCase();
  const id = ALIASES[key] ?? key;
  return LOADERS[id] ? id : null;
}

export function languageForPath(path: string): string | null {
  const ext = path.split(/[\\/]/).pop()?.split('.').pop()?.toLowerCase() ?? '';
  return EXTENSION_LANGS[ext] ?? null;
}

const parsers = new Map<string, Promise<Parser | null>>();

function parserFor(lang: string): Promise<Parser | null> {
  let pending = parsers.get(lang);
  if (!pending) {
    pending = (LOADERS[lang]?.() ?? Promise.resolve(null)).catch(() => null);
    parsers.set(lang, pending);
  }
  return pending;
}

/** Longest code the chat highlights; longer blocks stay plain. */
const MAX_HIGHLIGHT_CHARS = 60_000;

function escapeHtml(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/** Highlighted HTML for `code`, one string per line; null when the language is unknown. */
export async function highlightLines(code: string, lang: string | null): Promise<string[] | null> {
  if (!lang || code.length > MAX_HIGHLIGHT_CHARS) return null;
  const parser = await parserFor(lang);
  if (!parser) return null;
  const lines: string[] = [''];
  try {
    highlightCode(
      code,
      parser.parse(code),
      classHighlighter,
      (text, classes) => {
        const html = escapeHtml(text);
        lines[lines.length - 1] += classes ? `<span class="${classes}">${html}</span>` : html;
      },
      () => lines.push(''),
    );
  } catch {
    return null;
  }
  return lines;
}

/** Highlight a rendered `<pre><code class="language-x">` block in place. */
export async function highlightCodeElement(code: HTMLElement): Promise<void> {
  const fence = /(?:^|\s)language-([\w+#-]+)/.exec(code.className)?.[1] ?? null;
  const lang = languageForFence(fence);
  const text = code.textContent ?? '';
  const lines = await highlightLines(text.replace(/\n$/, ''), lang);
  // The block may have been replaced while the grammar loaded.
  if (!lines || !code.isConnected || code.textContent !== text) return;
  code.innerHTML = lines.join('\n');
  code.dataset.highlighted = 'true';
}
