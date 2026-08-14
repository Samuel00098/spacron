import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { resolve } from 'path';

const host = process.env.TAURI_DEV_HOST;

export default defineConfig({
  plugins: [react({ include: '**/*.tsx' })],
  publicDir: 'static',
  resolve: {
    alias: {
      $lib: resolve('./src/lib'),
    },
    extensions: ['.ts', '.tsx', '.js'],
  },
  clearScreen: false,
  build: {
    // CSS minification is disabled because the minifier corrupts multi-function
    // `backdrop-filter` / `-webkit-backdrop-filter` values — it strips the space
    // between filter functions (e.g. `blur(18px) saturate(130%)` → the invalid
    // `blur(18px)saturate(130%)`), which WebView2 rejects. That silently killed
    // every frosted-glass panel in packaged builds while dev (unminified) looked
    // correct. Leaving CSS unminified keeps the built stylesheet byte-faithful to
    // what dev serves; the size cost is irrelevant for a locally-loaded desktop
    // app. JS minification is unaffected. See src/lib/components/layout/AppShell.css.
    cssMinify: false,
    // Monaco is the largest thing the app ships (editor.browser ~500 kB,
    // several ~440 kB language bundles, plus the main chunk it shares). It
    // cannot be split safely with manualChunks — its workers are created from
    // blob URLs over its own module graph, so a vendor chunk for it breaks the
    // worker bootstrap. Size is a non-issue here anyway: the bundle is loaded
    // from disk by a desktop WebView, not a network. 800 kB keeps the warning
    // off while still flagging genuine regressions.
    chunkSizeWarningLimit: 800,
    rollupOptions: {
      input: resolve('./index.html'),
      output: {
        // Split the largest third-party libraries into their own vendor chunks
        // so they stay cached across app-code changes and parse independently.
        // A vendor chunk is only fetched when something that imports it loads —
        // CodeMirror is used solely by the lazy editor, so its chunk stays
        // deferred; xterm rides with the (eager) terminal at first paint.
        manualChunks(id) {
          if (!id.includes('node_modules')) return;
          // Grammars get a chunk EACH, not a shared vendor chunk. CodeEditor
          // imports them with dynamic import() so you only download the language
          // you opened; sweeping them into vendor-codemirror would undo that and
          // ship all 20 to anyone who opens a single .json file. Only
          // CodeMirror/Lezer CORE — the runtime every language shares — belongs
          // in the vendor chunk below.
          //
          // Each grammar is named `lang-<language>` so the build output stays
          // readable, and a Lezer parser is deliberately given the same name as
          // its language wrapper so the two travel together (@lezer/javascript
          // rides with @codemirror/lang-javascript). Languages that share a
          // parser — TypeScript and JavaScript, SCSS and Sass — therefore share
          // one chunk, which is what we want.
          const lang =
            /node_modules[\\/](?:@codemirror[\\/]lang-|@replit[\\/]codemirror-lang-)([a-z0-9+-]+)/.exec(id) ||
            /node_modules[\\/]@lezer[\\/](?!common[\\/]|lr[\\/]|highlight[\\/])([a-z0-9+-]+)/.exec(id);
          if (lang) return `lang-${lang[1]}`;

          // Legacy stream-parser modes are imported one mode at a time
          // (@codemirror/legacy-modes/mode/toml), so key the chunk on the mode.
          const legacy = /node_modules[\\/]@codemirror[\\/]legacy-modes[\\/]mode[\\/]([a-z0-9+-]+)/.exec(id);
          if (legacy) return `lang-${legacy[1]}`;
          if (/node_modules[\\/](@codemirror|@lezer|@replit[\\/]codemirror|codemirror|codemirror-languageserver|vscode-languageserver)/.test(id)) {
            return 'vendor-codemirror';
          }
          if (id.includes('node_modules/@xterm') || id.includes('node_modules\\@xterm')) {
            return 'vendor-xterm';
          }
          if (/node_modules[\\/](marked|dompurify)/.test(id)) {
            return 'vendor-markdown';
          }
        },
      },
    },
  },
  server: {
    port: 1420,
    strictPort: true,
    host: host || false,
    hmr: host ? { protocol: 'ws', host, port: 1421 } : undefined,
    // NOTE: COOP/COEP (cross-origin isolation) headers are intentionally NOT set
    // here. They would let Kokoro TTS run multi-threaded WASM (SharedArrayBuffer),
    // but cross-origin isolation BLOCKS cross-origin iframes that don't send their
    // own COEP header — which breaks the web preview (127.0.0.1 proxy) and YouTube
    // embeds (youtube-nocookie.com can't opt in). Kokoro already falls back to
    // single-threaded synthesis when not isolated (see kokoro-local.ts), so we
    // favour working web/YouTube embedding over a TTS speed-up. If multi-threaded
    // TTS is needed later, isolate a dedicated WASM host context instead of the
    // whole app document.
    // Ignore directories the app itself writes into at runtime. Without this,
    // spawning an orchestrator agent — which writes .spacron/orchestrator.json and
    // creates .spacron/worktrees/* (full repo copies) — trips Vite's file watcher
    // and triggers a full page reload of the app while you're dogfooding inside
    // the Spacron repo. .worktrees is a legacy location; so is the sibling
    // ../.spacron-worktrees, which is outside the project and never watched.
    watch: {
      ignored: ['**/src-tauri/**', '**/.spacron/**', '**/.worktrees/**'],
    },
  },
});
