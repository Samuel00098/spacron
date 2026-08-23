import { useEffect, useRef, useState } from 'react';
import { EditorState, Compartment, type Extension } from '@codemirror/state';
import {
  EditorView,
  keymap,
  lineNumbers,
  highlightActiveLineGutter,
  highlightSpecialChars,
  drawSelection,
  dropCursor,
  rectangularSelection,
  crosshairCursor,
  highlightActiveLine,
  scrollPastEnd,
} from '@codemirror/view';
import { defaultKeymap, history, historyKeymap, indentWithTab } from '@codemirror/commands';
import {
  foldGutter,
  foldKeymap,
  indentOnInput,
  bracketMatching,
  syntaxHighlighting,
  HighlightStyle,
  StreamLanguage,
} from '@codemirror/language';
import {
  autocompletion,
  completionKeymap,
  closeBrackets,
  closeBracketsKeymap,
} from '@codemirror/autocomplete';
import { searchKeymap, highlightSelectionMatches } from '@codemirror/search';
import { tags as t } from '@lezer/highlight';
import { addCursorAbove, addCursorBelow } from '$lib/services/editor/multi-cursor';

// Language support is loaded ON DEMAND — see LANGUAGE_LOADERS below. Importing
// all 20 grammars statically put every one of them in the editor chunk, so
// opening a .json file also paid for PHP, Java, Swift and Kotlin.

import { updateContent, updateCursorPosition, jumpToLine, activeSelection } from '$lib/stores/editor';
import { activeProject } from '$lib/stores/workspace';
import {
  fontSize,
  resolvedFontFamily,
  tabSize,
  wordWrap,
  minimap,
  vimMode,
  columnSelection,
  enableLsp,
} from '$lib/stores/settings';
import { vim } from '@replit/codemirror-vim';
import { createLspExtension, lspSupportsLanguage, lspReload, type LspHandle } from '$lib/services/lsp/client';
import { ghostText } from '$lib/services/completion/ghost-text';
import { useStore } from '$lib/react/useStore';
import './CodeEditor.css';

type CodeEditorProps = {
  filePath: string;
  initialContent: string;
  language: string;
};

const customTheme = EditorView.theme({
  "&": {
    color: "var(--text-primary)",
    backgroundColor: "transparent",
    height: "100%",
    fontSize: "var(--editor-font-size, 13.5px)",
    fontFamily: "var(--editor-font-family, monospace)",
  },
  ".cm-scroller": {
    fontFamily: "inherit",
    lineHeight: "1.62",
    overflow: "auto",
    padding: "0",
  },
  ".cm-content": {
    caretColor: "var(--accent)",
    fontFamily: "inherit",
    fontSize: "inherit",
    padding: "16px 24px 48px 8px",
  },
  ".cm-line": {
    padding: "1px 0",
    lineHeight: "1.62",
  },
  ".cm-cursor, .cm-dropCursor": {
    borderLeftWidth: "2px",
    borderLeftColor: "var(--accent)",
    borderRadius: "1px",
  },
  "&.cm-focused > .cm-scroller > .cm-selectionLayer .cm-selectionBackground, .cm-selectionBackground, ::selection": {
    backgroundColor: "var(--selection-bg)",
    borderRadius: "2px",
  },
  ".cm-gutters": {
    backgroundColor: "transparent",
    color: "var(--text-muted)",
    border: "none",
    borderRight: "none",
    paddingLeft: "8px",
    paddingRight: "2px",
    fontFamily: "inherit",
    opacity: 0.55,
    transition: "opacity 0.15s ease",
  },
  "&:hover .cm-gutters": {
    opacity: 0.85,
  },
  ".cm-gutterElement": {
    padding: "0 8px 0 4px",
    minWidth: "26px",
    textAlign: "right",
    fontSize: "0.85em",
  },
  ".cm-activeLine": {
    backgroundColor: "var(--editor-lineHighlight, rgba(255, 255, 255, 0.03))",
    borderRadius: "3px",
  },
  ".cm-activeLineGutter": {
    backgroundColor: "transparent",
    color: "var(--accent)",
    fontWeight: "600",
    opacity: 1,
  },
  ".cm-foldGutter .cm-gutterElement": {
    opacity: 0,
    transition: "opacity 0.15s ease",
    padding: "0 2px",
  },
  "&:hover .cm-foldGutter .cm-gutterElement": {
    opacity: 0.65,
  },
}, { dark: true });

const customHighlightStyle = HighlightStyle.define([
  { tag: t.keyword, color: "var(--syntax-keyword, #ff7b72)", fontWeight: "500" },
  { tag: t.operator, color: "var(--syntax-operator, #79c0ff)" },
  { tag: t.punctuation, color: "var(--syntax-punctuation, var(--text-muted))" },
  { tag: t.special(t.bracket), color: "var(--syntax-punctuation, var(--text-muted))" },
  { tag: t.string, color: "var(--syntax-string, #a5d6ff)" },
  { tag: t.number, color: "var(--syntax-number, #d2a8ff)" },
  { tag: t.bool, color: "var(--syntax-number, #ff7b72)" },
  { tag: t.variableName, color: "var(--syntax-variable, var(--text-primary))" },
  { tag: t.definition(t.variableName), color: "var(--syntax-variable, var(--text-primary))", fontWeight: "500" },
  { tag: t.function(t.variableName), color: "var(--syntax-function, #d2a8ff)" },
  { tag: t.typeName, color: "var(--syntax-type, #7ee787)" },
  { tag: t.className, color: "var(--syntax-type, #7ee787)" },
  { tag: t.comment, color: "var(--syntax-comment, var(--text-muted))", fontStyle: "italic" },
  { tag: t.meta, color: "var(--syntax-constant, #ffa657)" },
  { tag: t.heading, color: "var(--text-primary)", fontWeight: "600" },
]);

/**
 * Grammar loaders, keyed by the language ids `stores/editor.ts` produces. Each
 * is a dynamic import, so Vite emits one chunk per grammar and the editor
 * downloads only the language you actually opened.
 */
const LANGUAGE_LOADERS: Record<string, () => Promise<Extension>> = {
  javascript: async () => (await import('@codemirror/lang-javascript')).javascript(),
  typescript: async () =>
    (await import('@codemirror/lang-javascript')).javascript({ typescript: true }),
  html: async () => (await import('@codemirror/lang-html')).html(),
  css: async () => (await import('@codemirror/lang-css')).css(),
  rust: async () => (await import('@codemirror/lang-rust')).rust(),
  json: async () => (await import('@codemirror/lang-json')).json(),
  markdown: async () => (await import('@codemirror/lang-markdown')).markdown(),
  python: async () => (await import('@codemirror/lang-python')).python(),
  java: async () => (await import('@codemirror/lang-java')).java(),
  cpp: async () => (await import('@codemirror/lang-cpp')).cpp(),
  php: async () => (await import('@codemirror/lang-php')).php(),
  sql: async () => (await import('@codemirror/lang-sql')).sql(),
  xml: async () => (await import('@codemirror/lang-xml')).xml(),
  yaml: async () => (await import('@codemirror/lang-yaml')).yaml(),
  go: async () => (await import('@codemirror/lang-go')).go(),
  sass: async () => (await import('@codemirror/lang-sass')).sass(),
  scss: async () => (await import('@codemirror/lang-sass')).sass(),
  svelte: async () => (await import('@replit/codemirror-lang-svelte')).svelte(),
  toml: async () =>
    StreamLanguage.define((await import('@codemirror/legacy-modes/mode/toml')).toml),
  csharp: async () =>
    StreamLanguage.define((await import('@codemirror/legacy-modes/mode/clike')).csharp),
  kotlin: async () =>
    StreamLanguage.define((await import('@codemirror/legacy-modes/mode/clike')).kotlin),
  shell: async () =>
    StreamLanguage.define((await import('@codemirror/legacy-modes/mode/shell')).shell),
  swift: async () =>
    StreamLanguage.define((await import('@codemirror/legacy-modes/mode/swift')).swift),
};

/**
 * Resolved grammars, module-scoped so a language is fetched once per session.
 * A cache hit means `createEditorState` can bake the grammar straight in, so
 * only the FIRST file of a given language ever shows unhighlighted text.
 */
const languageCache = new Map<string, Extension>();

/** In-flight loads, so opening three .ts files at once fetches the pack once. */
const languageInFlight = new Map<string, Promise<Extension | null>>();

function loadLanguageExtension(lang: string): Promise<Extension | null> {
  const cached = languageCache.get(lang);
  if (cached) return Promise.resolve(cached);

  const pending = languageInFlight.get(lang);
  if (pending) return pending;

  const loader = LANGUAGE_LOADERS[lang];
  if (!loader) return Promise.resolve(null);

  const promise = loader()
    .then((extension) => {
      languageCache.set(lang, extension);
      return extension;
    })
    .catch((e) => {
      // A missing grammar must not break editing — you just get plain text.
      console.error(`Failed to load the "${lang}" grammar:`, e);
      return null;
    })
    .finally(() => {
      languageInFlight.delete(lang);
    });

  languageInFlight.set(lang, promise);
  return promise;
}

export default function CodeEditor({ filePath, initialContent, language }: CodeEditorProps) {
  const editorContainerRef = useRef<HTMLDivElement | null>(null);
  const minimapContainerRef = useRef<HTMLDivElement | null>(null);
  const viewRef = useRef<EditorView | null>(null);
  const isUpdatingFromStoreRef = useRef(false);
  const [currentText, setCurrentText] = useState(initialContent);

  const fontSizeValue = useStore(fontSize);
  const resolvedFontFamilyValue = useStore(resolvedFontFamily);
  const tabSizeValue = useStore(tabSize);
  const wordWrapValue = useStore(wordWrap);
  const minimapValue = useStore(minimap);
  const vimModeValue = useStore(vimMode);
  const columnSelectionValue = useStore(columnSelection);
  const enableLspValue = useStore(enableLsp);
  const jumpToLineValue = useStore(jumpToLine);
  const activeProjectValue = useStore(activeProject);
  const lspReloadValue = useStore(lspReload);

  // CodeMirror Compartments for dynamic configuration. Created once per mount,
  // mirroring the Svelte component's module-instance-scoped compartments.
  const tabSizeCompartmentRef = useRef<Compartment | null>(null);
  const wordWrapCompartmentRef = useRef<Compartment | null>(null);
  const vimModeCompartmentRef = useRef<Compartment | null>(null);
  // Box selection lives in a compartment so the toggle takes effect on the open
  // file rather than only on the next one you open.
  const columnSelectionCompartmentRef = useRef<Compartment | null>(null);
  // LSP extension is loaded asynchronously (server must spawn first), so it lives
  // in its own compartment that starts empty and gets reconfigured once ready.
  const lspCompartmentRef = useRef<Compartment | null>(null);
  // Same deal for the grammar: it is fetched on demand, so it starts as whatever
  // `languageCache` already has (usually the grammar, often nothing on the very
  // first file of a language) and is reconfigured when the import resolves.
  const languageCompartmentRef = useRef<Compartment | null>(null);
  const languageGenerationRef = useRef(0);

  // The active language-server document handle for the open file, and a
  // generation counter so a slow server start can't clobber a newer file switch.
  const lspHandleRef = useRef<LspHandle | null>(null);
  const lspGenerationRef = useRef(0);

  function createEditorState(content: string) {
    const tabSizeCompartment = tabSizeCompartmentRef.current!;
    const wordWrapCompartment = wordWrapCompartmentRef.current!;
    const vimModeCompartment = vimModeCompartmentRef.current!;
    const columnSelectionCompartment = columnSelectionCompartmentRef.current!;
    const lspCompartment = lspCompartmentRef.current!;
    const languageCompartment = languageCompartmentRef.current!;

    return EditorState.create({
      doc: content,
      extensions: [
        lineNumbers(),
        highlightActiveLineGutter(),
        highlightSpecialChars(),
        history(),
        foldGutter(),
        drawSelection(),
        dropCursor(),
        EditorState.allowMultipleSelections.of(true),
        indentOnInput(),
        syntaxHighlighting(customHighlightStyle),
        bracketMatching(),
        closeBrackets(),
        autocompletion(),
        highlightActiveLine(),
        highlightSelectionMatches(),
        languageCompartment.of(languageCache.get(language) ?? []),
        ghostText(language),
        customTheme,
        scrollPastEnd(),
        EditorView.editable.of(true),
        EditorState.readOnly.of(false),
        tabSizeCompartment.of(EditorState.tabSize.of(tabSizeValue)),
        wordWrapCompartment.of(wordWrapValue !== false ? EditorView.lineWrapping : []),
        vimModeCompartment.of(vimModeValue ? vim() : []),
        columnSelectionCompartment.of(
          columnSelectionValue ? [rectangularSelection(), crosshairCursor()] : [],
        ),
        lspCompartment.of([]),
        keymap.of([
          ...closeBracketsKeymap,
          // Cursor stacking, the one part of multi-cursor CodeMirror has no
          // built-in command for. Declared before `defaultKeymap` so these win
          // the binding; `Mod-d` occurrence-select comes from `searchKeymap`.
          { key: 'Ctrl-Alt-ArrowUp', mac: 'Cmd-Alt-ArrowUp', run: addCursorAbove, preventDefault: true },
          { key: 'Ctrl-Alt-ArrowDown', mac: 'Cmd-Alt-ArrowDown', run: addCursorBelow, preventDefault: true },
          ...defaultKeymap,
          ...searchKeymap,
          ...historyKeymap,
          ...foldKeymap,
          ...completionKeymap,
          indentWithTab,
        ]),
        EditorView.updateListener.of((update) => {
          if (update.docChanged && !isUpdatingFromStoreRef.current) {
            const doc = update.state.doc.toString();
            setCurrentText(doc);
            updateContent(filePath, doc);

            let insertedChars = 0;
            update.changes.iterChanges((fromA, toA, fromB, toB, inserted) => {
              insertedChars += inserted.length;
            });
          }
          if (update.selectionSet) {
            const sel = update.state.selection.main;
            const lineObj = update.state.doc.lineAt(sel.head);
            updateCursorPosition(lineObj.number, sel.head - lineObj.from + 1);
            // Surface the highlighted text (capped) so the assistant can see it.
            const selectedText = sel.empty ? '' : update.state.sliceDoc(sel.from, sel.to);
            activeSelection.set(selectedText.length > 2000 ? selectedText.slice(0, 2000) : selectedText);
          }
        }),
      ],
    });
  }

  function syncMinimapScroll() {
    const view = viewRef.current;
    const minimapContainer = minimapContainerRef.current;
    if (!view || !minimapContainer) return;
    const scrollEl = view.scrollDOM;
    const scrollPct = scrollEl.scrollTop / Math.max(1, scrollEl.scrollHeight - scrollEl.clientHeight);
    minimapContainer.scrollTop = scrollPct * (minimapContainer.scrollHeight - minimapContainer.clientHeight);
  }

  /**
   * (Re)load the language server extension for the current file. Tears down any
   * prior handle, then — if LSP is enabled, the language is supported, and a
   * project is open — asks the backend to start (or reuse) a server and swaps the
   * extension into `lspCompartment`. A generation guard discards a stale result
   * if the user switched files while the server was starting.
   */
  async function loadLsp(path: string, lang: string, root: string | undefined, enabled: boolean) {
    const gen = ++lspGenerationRef.current;

    const prev = lspHandleRef.current;
    lspHandleRef.current = null;
    if (prev) prev.dispose();
    const view = viewRef.current;
    const lspCompartment = lspCompartmentRef.current!;
    if (view) view.dispatch({ effects: lspCompartment.reconfigure([]) });

    if (!enabled || !root || !lspSupportsLanguage(lang)) return;

    let handle: LspHandle | null = null;
    try {
      handle = await createLspExtension(path, lang, root);
    } catch (e) {
      console.error('Failed to load LSP extension:', e);
      return;
    }

    // A newer load started, or the editor went away, while we were awaiting.
    if (gen !== lspGenerationRef.current || !viewRef.current) {
      handle?.dispose();
      return;
    }
    lspHandleRef.current = handle;
    if (handle) {
      viewRef.current.dispatch({ effects: lspCompartment.reconfigure(handle.extension) });
    }
  }

  // Mount CodeMirror once on initial mount, and tear it down on unmount.
  useEffect(() => {
    tabSizeCompartmentRef.current = new Compartment();
    wordWrapCompartmentRef.current = new Compartment();
    vimModeCompartmentRef.current = new Compartment();
    columnSelectionCompartmentRef.current = new Compartment();
    lspCompartmentRef.current = new Compartment();
    languageCompartmentRef.current = new Compartment();

    const view = new EditorView({
      state: createEditorState(initialContent),
      parent: editorContainerRef.current!,
    });
    viewRef.current = view;
    view.scrollDOM.addEventListener('scroll', syncMinimapScroll);

    return () => {
      if (lspHandleRef.current) {
        lspHandleRef.current.dispose();
        lspHandleRef.current = null;
      }
      view.scrollDOM.removeEventListener('scroll', syncMinimapScroll);
      view.destroy();
      viewRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Fetch the grammar for the open file and swap it in. Nothing to do when the
  // cache already has it — `createEditorState` baked it in synchronously, so
  // there is no flash on the second file of a language. A generation guard
  // discards a slow import if the user switched to another language meanwhile.
  useEffect(() => {
    if (languageCache.has(language)) return;
    const gen = ++languageGenerationRef.current;

    void loadLanguageExtension(language).then((extension) => {
      if (!extension) return;
      if (gen !== languageGenerationRef.current) return; // newer file won
      const view = viewRef.current;
      if (!view) return;
      view.dispatch({ effects: languageCompartmentRef.current!.reconfigure(extension) });
    });
  }, [language]);

  // Keep editor content in sync if initialContent changes from parent (e.g. file switched or saved)
  useEffect(() => {
    const view = viewRef.current;
    if (view && filePath) {
      const currentDoc = view.state.doc.toString();
      const normalize = (s: string) => s.replace(/\r\n/g, '\n');
      if (normalize(currentDoc) !== normalize(initialContent)) {
        isUpdatingFromStoreRef.current = true;
        view.setState(createEditorState(initialContent));
        setCurrentText(initialContent);
        isUpdatingFromStoreRef.current = false;
      }
    } else {
      setCurrentText(initialContent);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filePath, initialContent]);

  // React to dynamic settings changes in compartments
  useEffect(() => {
    const view = viewRef.current;
    if (view) {
      view.dispatch({
        effects: [
          tabSizeCompartmentRef.current!.reconfigure(EditorState.tabSize.of(tabSizeValue)),
          wordWrapCompartmentRef.current!.reconfigure(wordWrapValue ? EditorView.lineWrapping : []),
          vimModeCompartmentRef.current!.reconfigure(vimModeValue ? vim() : []),
          columnSelectionCompartmentRef.current!.reconfigure(
            columnSelectionValue ? [rectangularSelection(), crosshairCursor()] : [],
          ),
        ]
      });
    }
  }, [tabSizeValue, wordWrapValue, vimModeValue, columnSelectionValue]);

  // Jump to specific line when requested by search or other triggers
  useEffect(() => {
    const view = viewRef.current;
    if (view && jumpToLineValue && jumpToLineValue.path === filePath) {
      const lineNum = Math.min(jumpToLineValue.line, view.state.doc.lines);
      if (lineNum > 0) {
        try {
          const line = view.state.doc.line(lineNum);
          view.dispatch({
            selection: { anchor: line.from, head: line.to },
            scrollIntoView: true
          });
          view.focus();
        } catch (e) {
          console.error("Failed to jump to line in CodeMirror:", e);
        }
      }
      jumpToLine.set(null);
    }
  }, [jumpToLineValue, filePath]);

  // Load / reload the language server whenever the file, language, project root,
  // or the LSP toggle changes. Declared after the setState effect above so that,
  // on a file switch, it runs after the fresh editor state (with an empty LSP
  // compartment) is installed and reconfigures it for the new document.
  useEffect(() => {
    const enabled = enableLspValue;
    const root = activeProjectValue?.root_path;
    const path = filePath;
    const lang = language;
    // Re-run after a successful server install so LSP activates without a reopen.
    void lspReloadValue;
    if (!viewRef.current) return;
    void loadLsp(path, lang, root, enabled);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enableLspValue, activeProjectValue?.root_path, filePath, language, lspReloadValue]);

  return (
    <div className="editor-layout">
      <div
        className="code-editor-container"
        style={{
          '--editor-font-size': `${fontSizeValue}px`,
          '--editor-font-family': resolvedFontFamilyValue,
        } as React.CSSProperties}
        ref={editorContainerRef}
      ></div>

      {minimapValue && (
        <div className="minimap-container" ref={minimapContainerRef} aria-hidden="true">
          <pre className="minimap-content" style={{ fontFamily: resolvedFontFamilyValue }}>{currentText}</pre>
        </div>
      )}
    </div>
  );
}
