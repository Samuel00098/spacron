# Spacron Architecture Document

## Application Overview

**Spacron** — a native, local-first, keyboard-driven developer workspace where you talk to one orchestrator that drives a fleet of coding agents inside a real IDE (terminal grid + CodeMirror editor + web preview proxy + git + DB tools). Built with Tauri 2 (Rust) + React 19 + TypeScript.

**Core identity:** "Your machine, your keys, works offline" — the one claim competitors structurally cannot make.

---

## 1. Tech Stack

| Layer | Technology | Role |
|-------|-----------|------|
| **Desktop shell** | Tauri 2 | System webview, native menus, file I/O, process spawning |
| **Rust backend** | Rust 2021 | PTY sessions, git operations, preview proxy, theme loading, file watching, worktree management |
| **Frontend** | React 19 + TypeScript 5.6 | UI, state management, component rendering |
| **Editor** | CodeMirror 6 | Syntax highlighting (15+ languages), Vim mode, LSP integration |
| **Terminal** | xterm.js | PTY terminal rendering with WebGL/Canvas renderers |
| **State (legacy)** | Svelte-like stores (`storeCompat.ts`) | Reactive writable/derived/get (vanilla TS, no Svelte runtime) |
| **State (modern)** | Zustand 5 | Simpler state slices migrated from legacy stores |
| **Build** | Vite 8 + `@vitejs/plugin-react` | Dev server, bundling, HMR |
| **Tauri commands** | `@tauri-apps/api` | IPC bridge to Rust |

---

## 2. Project Structure

```
spacron/
├── src-tauri/                          # Rust backend (Tauri 2)
│   ├── Cargo.toml
│   ├── tauri.conf.json                 # CSP, bundle config, asset protocol scope
│   ├── build.rs                        # Stamps a placeholder sidecar; see the memory note
│   ├── capabilities/
│   │   └── default.json                # Tauri capabilities (the IPC allowlist)
│   ├── src/
│   │   ├── main.rs                     # Entry point
│   │   ├── lib.rs                      # Tauri invoke setup, command registration, init
│   │   ├── state.rs                    # AppState (managed via tauri::State)
│   │   ├── error/                      # Unified error types
│   │   ├── commands/                   # ~40 command modules. The load-bearing ones:
│   │   │   ├── terminal.rs             # PTY session management
│   │   │   ├── file_system.rs          # File ops + the two-layer path confinement
│   │   │   ├── fs_watch.rs             # Debounced watching for the file explorer
│   │   │   ├── workspace.rs            # Git operations, worktree isolation, search
│   │   │   ├── project_state.rs        # App-private per-project state (config dir)
│   │   │   ├── agent_signals.rs        # Turn-signal channels (the sentinel files)
│   │   │   ├── preview.rs              # Web preview proxy management
│   │   │   ├── remote_deploy.rs        # Provisioning/deploying a remote workspace
│   │   │   ├── remote_relay.rs         # Relay transport for remote workspaces
│   │   │   ├── usage_stats.rs          # Token/usage accounting across CLIs
│   │   │   ├── whisper.rs, parakeet.rs, vad.rs         # Local speech models (ONNX)
│   │   │   ├── mobile.rs, ios_sim.rs, emulator_grpc.rs # Device panes
│   │   │   └── theme.rs                # Theme loading & switching
│   │   ├── pty/                        # PTY backend
│   │   │   ├── session.rs              # PTY session lifecycle
│   │   │   ├── manager.rs              # Session registry
│   │   │   └── shell.rs                # Shell detection & config
│   │   ├── workspace/                  # Workspace domain logic
│   │   │   ├── project.rs              # Project model
│   │   │   └── manager.rs              # Multi-project orchestration
│   │   ├── preview/                    # Web preview subsystem (Axum HTTP/WS proxy)
│   │   │   ├── mod.rs
│   │   │   └── cookies.rs
│   │   ├── remote/                     # spacron-server: WS protocol + invoke dispatch
│   │   ├── mcp/                        # MCP server (report_status, agent tools)
│   │   ├── theme/                      # Theme system (models, loader, registry)
│   │   └── lsp/                        # LSP client (bridge, registry, server)
│   ├── icons/
│   └── themes/
├── src/                                # React + TypeScript frontend
│   ├── main.tsx                        # React entry point
│   ├── App.tsx                         # Root component
│   ├── styles/
│   │   ├── global.css                  # CSS custom properties, glass system, themes
│   │   └── themes/                     # Theme style files
│   └── lib/
│       ├── components/                 # UI components
│       │   ├── layout/                 # AppShell, StatusBar, TitleBar, ActivityBar
│       │   ├── terminal/               # TerminalPane, TerminalPanel, FloatingPromptBar
│       │   ├── editor/                 # CodeEditor, EditorPanel, EditorTabs
│       │   ├── explorer/               # FileExplorer, FileTree, SourceControl, SearchPanel
│       │   ├── preview/                # PreviewPanel, MarkdownPreview
│       │   ├── review/                 # ReviewPanel (diff viewer)
│       │   ├── orchestrator/           # FleetDashboard, agent cards, completion copy
│       │   ├── agents/                 # AgentsPane
│       │   ├── shared/                 # SettingsModal, CommandPalette, Dropdown, Toasts
│       │   ├── workspace/              # ProjectHUD, TasksPanel, WelcomeScreen
│       │   ├── sketch/                 # SketchPanel
│       │   ├── mobile/                 # MobilePanel (emulator / device streaming)
│       │   ├── stats/, usage/          # UsageStatsPane and friends
│       │   ├── db/, http/              # DbExplorerPanel, HttpClientPanel
│       │   ├── problems/               # Diagnostics list
│       │   ├── toolbox/                # ToolboxPanel, EmbeddedPanel
│       │   └── containers/             # ContainersPanel
│       ├── stores/                     # State management
│       │   ├── storeCompat.ts          # Svelte-compatible writable/derived/get (vanilla TS)
│       │   ├── orchestrator.ts         # Main orchestrator store (being decomposed)
│       │   ├── terminal.ts             # PTY session state
│       │   ├── workspace.ts            # Active projects state
│       │   ├── remoteWorkspace.ts      # Remote connections; `remoteTarget` is the seam
│       │   ├── mcpBridge.ts            # MCP config injection per agent CLI
│       │   ├── settings.ts, editor.ts, preview.ts, theme.ts, layout.ts, ...
│       │   └── zustand/                # Zustand stores (migration target)
│       ├── services/                   # Business logic, not UI state
│       │   ├── backend.ts              # `backendInvoke` - the local/remote transport seam
│       │   ├── project-state.ts        # App-private state accessors (bare `invoke`)
│       │   ├── pty-bridge.ts           # PTY IPC helpers
│       │   ├── pty-bridge-remote.ts    # The same over the remote WebSocket
│       │   ├── orchestrator-brain.ts   # LLM brain routing user messages -> actions
│       │   ├── orchestrator/           # Orchestrator service modules
│       │   │   ├── task-lifecycle.ts     # Task types, state machine, transitions
│       │   │   ├── terminal-lease.ts     # Terminal session leasing
│       │   │   ├── worktree-manager.ts   # Git worktree isolation per task
│       │   │   ├── agent-hook-signals.ts # Declared turn ends (hooks + shell sentinel)
│       │   │   ├── agent-capabilities.ts # Whether an agent had a way to report
│       │   │   ├── agent-turn-watch.ts   # Detect agent turn completion
│       │   │   ├── agent-charter.ts      # Agent standing brief/instructions
│       │   │   ├── inbox.ts, mailbox.ts, memory.ts, evolve.ts, recon.ts
│       │   │   └── review-gate.ts        # Human review gate for agent output
│       │   ├── voice-input.ts          # Voice capture & STT pipeline
│       │   ├── realtime-voice.ts       # Speech-to-speech realtime engines
│       │   ├── voice-refinement.ts     # Dictation polish pass
│       │   ├── transcription-hotkey.ts # F9 dictation lifecycle
│       │   ├── ai-keychain.ts          # AI provider key management
│       │   ├── github.ts               # GitHub integration helpers
│       │   ├── lsp/                    # LSP client (frontend side)
│       │   ├── completion/             # Ghost text / autocomplete
│       │   ├── editor/, git/           # Editor and git helpers
│       │   └── app-flags.ts            # Feature flags
│       ├── types/                      # TypeScript type definitions
│       ├── utils/                      # Shared utilities (path, storage, etc.)
│       └── actions/                    # App action dispatchers
├── .spacron/memory/                    # Shared agent notes (INDEX.md + one file per topic)
├── docs/                               # Design specs, plans, research
│   ├── BUILDING.md                     # Build instructions
│   ├── SECURITY.md                     # Threat model, IPC boundary, audit procedure
│   ├── FEATURES.md
│   ├── remote-workspace.md             # The remote workspace design
│   ├── redesign-spec.md                # "The Flow" visual redesign spec
│   ├── redesign-mockup-*.html          # Interactive HTML mockups
│   └── superpowers/                    # Feature specs and plans
├── website/                            # Marketing site (Next.js App Router)
├── scripts/                            # Build/release scripts (ESM)
├── CHANGELOG.md                        # Rendered by the site's /changelog route
├── package.json
├── vite.config.js
├── tsconfig.json
└── README.md
```

---

## 3. State Management (Dual System)

### 3.1 `storeCompat.ts` (Legacy — Svelte-compatible, vanilla TS)

The app was originally built with Svelte 5 stores. After the Svelte→React migration, the store API was reimplemented as pure TypeScript in `src/lib/stores/storeCompat.ts`:

- **`writable<T>(initial)`** — Creates a reactive container with `.set(val)` / `.update(fn)` / `.subscribe(cb)`.
- **`get<T>(store)`** — Synchronous one-shot read.
- **`derived<S, T>(stores, fn)`** — Computes a value from one or more source stores.

These are **not Svelte runes** — they are plain consumer-producer reactive stores. Components subscribe via `useEffect` + unsubscribe callback, or through custom React hooks.

All major stores (`orchestrator.ts`, `terminal.ts`, `workspace.ts`) still use this system.

### 3.2 Zustand Stores (Modern — migration target)

Zustand stores live in `src/lib/stores/zustand/` and follow the standard Zustand `create()` pattern. These are simpler, have no subscription boilerplate, and are gradually replacing legacy stores where appropriate:

- `orchestrator.ts` — Thin wrapper over orchestrator state (chat messages, agent UI state)
- `settings.ts` — App settings (17KB — settings was migrated early)
- `layout.ts` — Layout configuration
- `editor.ts` — Editor state
- `gitStatus.ts`, `explorer.ts`, `theme.ts`, `notification.ts`, `snapshot.ts`, etc.

**Status:** Both systems coexist. New components should prefer Zustand. Legacy store migration is incremental.

---

## 4. Key Services Architecture

### 4.1 Orchestrator System (`src/lib/services/orchestrator/`)

The orchestrator is the central agent-dispatch system. It manages task state, terminal leases, agent communication, worktree isolation, and the review gate.

**Data flow:**
```
User message → orchestrator-brain.ts (LLM routing)
  → task-lifecycle.ts (create task, transition state)
  → terminal-lease.ts (lease a PTY terminal, spawn agent)
  → worktree-manager.ts (create isolated git worktree)
  → agent-adapter.ts (deliver goal to agent's terminal)
  → agent-turn-watch.ts (detect turn completion)
  → review-gate.ts (human reviews agent output)
  → completeLeasedTask / transition task
```

**Task lifecycle states:**
```
todo → in-progress → in-review → complete
                ↘ blocked
                ↘ failed
                ↘ cancelled
```

**Key service modules:**

| Module | Responsibility |
|--------|---------------|
| `task-lifecycle.ts` | Task type definitions, state machine transitions, task CRUD |
| `terminal-lease.ts` | Spawning agent terminals, recording leases, sending goals |
| `worktree-manager.ts` | Git worktree create/remove/status for per-task isolation |
| `review-gate.ts` | Human-in-the-loop review before agent changes are finalized |
| `activity-log.ts` | Structured timeline of agent actions per task |
| `agent-adapter.ts` | Abstracted I/O channel per agent session |
| `agent-turn-watch.ts` | Detecting when an agent finishes a turn (output signal analysis) |
| `evolve.ts` | Task rephrasing and refinement logic |
| `memory.ts` | Cross-session agent memory |
| `recon.ts` | Project structure reconnaissance before dispatching an agent |
| `app-context.ts` | Snapshot of current app state (open files, terminals, preview URL) |
| `agent-charter.ts` | Standing brief/instructions delivered to each agent on launch |
| `agent-rules-file.ts` | Management of agent-specific rules files |
| `agent-names.ts` | Agent naming/labeling utilities |
| `agent-signals.ts` | Signal definitions for agent lifecycle events |

### 4.2 Orchestrator Brain (`orchestrator-brain.ts`)

The LLM-powered routing layer. Takes a user's natural language message and decides:
- Which agent (or agents) to dispatch the work to
- How to phrase the task prompt
- Whether any app-control action needs to run first (open file, switch view, etc.)
- How to summarize completed work for the user

Uses the AI provider configured in the app (BYO-key).

### 4.3 Voice Pipeline

Voice is two separate paths, and they deliberately do not share an engine.

**Dictation (F9)** — speech into the focused field, editor or terminal.

| Module | Role |
|--------|------|
| `services/transcription-hotkey.ts` | F9 lifecycle: caret capture, retargeting, pause/end semantics |
| `services/voice-input.ts` | Microphone capture, voice activity detection, turn orchestration |
| `services/voice-refinement.ts` | The polish pass over dictated prose (never over terminal payloads) |
| `commands/whisper.rs`, `commands/parakeet.rs` | Local STT models, run natively through ONNX Runtime |
| `commands/vad.rs` | Silero neural voice detection, in place of the RMS level gate |
| `commands/onnx_runtime.rs` | Shared ONNX session management for the above |

**Conversation** — speech-to-speech, handled by `services/realtime-voice.ts`, which
talks to a provider's realtime engine directly.

**Design principle:** local STT runs *natively* (ONNX in Rust), not as WASM in the
webview. There is no TTS anywhere in the app: the old STT -> brain -> TTS pipeline
was removed in v2.0, and spoken replies exist only inside a realtime
speech-to-speech session. See `.spacron/memory/voice-is-realtime-only.md`.

### 4.4 AI Provider System (`ai-keychain.ts`, `agent-access.ts`)

Manages API keys for AI providers (OpenRouter, Anthropic, Google, OpenAI, etc.) and detects agent availability. Supports:
- BYO-key (user provides their own API key)
- Local speech models (Whisper/Parakeet via ONNX) for offline dictation
- Hybrid: cloud LLM + local voice

---

## 5. Rust Backend Architecture

### 5.1 AppState Structure

```
AppState (managed via tauri::State)
├── workspace_manager: WorkspaceManager
│   ├── projects: DashMap<Uuid, Project>
│   ├── active_project_id: RwLock<Option<Uuid>>
│   └── recent_projects: Vec<RecentProjectEntry>
├── pty_manager: PtyManager
│   ├── sessions: DashMap<String, PtySession>
│   └── shell_config: ShellConfig
├── preview_manager: PreviewManager
│   ├── proxies: DashMap<String, PreviewProxy>
│   └── server_handle: Option<ServerHandle>
├── theme_registry: ThemeRegistry
│   ├── themes: HashMap<String, Theme>
│   ├── active_theme: RwLock<String>
│   └── custom_themes_path: PathBuf
└── settings: RwLock<AppSettings>
```

### 5.2 Command Modules

| Module | Key Commands |
|--------|-------------|
| `terminal.rs` | PTY create/resize/write/kill, session lifecycle |
| `workspace.rs` | Git operations (status, diff, commit, push, fetch, log, branches), worktree isolation, file search, daily notes |
| `file_system.rs` | Read/write/list/tree, binary detection |
| `preview.rs` | Preview proxy start/stop, port detection |
| `theme.rs` | Theme list, activate, get/save |

### 5.3 Agent Worktree Isolation

Each orchestrator agent can work in its own isolated git worktree (defined in `workspace.rs` and driven from `worktree-manager.ts`):

- `workspace_git_create_worktree` — Fork from HEAD into a dedicated branch
- `workspace_git_remove_worktree` — Clean up the worktree (and optionally delete the branch)
- `workspace_git_worktree_status` — Live changed-files / branch status

Worktrees live in `.spacron/worktrees/<branch>` **inside** the project, so agents never pollute each other's state. They must be inside the project root: terminals and file ops are confined to the open project roots, so a worktree outside can be created but never used as a shell cwd. `.spacron/` is added to `.git/info/exclude` so the checkouts stay out of the user's git status.

### 5.4 PTY Architecture

Actor model with async channels. Each terminal tab gets a `PtySession` with its own tokio task for non-blocking I/O. Output is streamed to the frontend via Tauri events. Cross-platform using `portable-pty` with ConPTY fallback on Windows.

---

## 6. Design System

### 6.1 CSS Custom Properties (`src/styles/global.css`)

- **Base:** `--bg-0:#07080b` → `--bg-2:#12141b` (deep slate)
- **Glass:** `rgba(255,255,255,.04–.065)` surfaces, `22px` blur, `140%` saturate, white rim, deep shadow
- **Ambient bloom:** Blurred radial-gradient fields behind glass surfaces
- **Accent palette (semantic):**
  - `--teal #22d3c7` — orchestrator / builder / primary action
  - `--sky #60a5fa` — reviewer / info
  - `--amber #f5b045` — scout / attention
  - `--green #34d399` — terminal / success / live
  - `--pink #f472b6` — keywords / accent pop
- **Typography:** Inter for UI, JetBrains Mono for code/terminal
- **Roundness:** 4px corners for most UI, 8px for elevated surfaces

### 6.2 Theme System

Themes stored as JSON with color tokens and syntax highlighting rules. Managed via Rust commands (`theme_list`, `theme_activate`, `theme_get_active`, `theme_save`). Users can create custom themes through the ThemeCustomizer panel.

---

## 7. Redesign Direction: "The Flow"

The app is moving toward **"The Flow"** — a living stream of work replacing the fixed-panel IDE layout (spec'd in `docs/redesign-spec.md`):

- **Default frame = the stream** — Interactive cards (diffs, terminal runs, previews, query results)
- **Orchestrator as the hero** — Talk/type to direct your agent fleet
- **Named agent characters** — Personality layer for agents (Ada, Wren, Sol, etc.)
- **Cards expand → full IDE** — Editor/terminal/preview summoned on demand
- **Pin cards** — Keep important work in an ambient pinned column
- **Layout presets** — Focus / Split / Canvas / Preview replace manual window management
- **Ambient neon bloom** — The signature visual differentiator

**Build phases (post-design-sign-off):**
1. Shell: AppShell + title bar + rail + layout presets with new tokens
2. Orchestrator hero: Promote orchestrator/voice/pet to centerpiece
3. Panels: Port existing panels into card-stream layout
4. Polish: Pet states, motion (View Transitions API), first-run states

The redesign is driven by the market wedge: **voice-driven + multi-agent + native + BYO-key/local-first + personality** — the combination no competitor fully occupies.

---

## 8. Build & Verification

- **Dev:** `npm run dev` — Vite dev server on port 1420
- **Type check:** `npm run check` — `tsc --noEmit`
- **Test:** `npm test` — Vitest runner
- **Tauri:** `npm run tauri dev` / `npm run tauri build`
- **Scripts:** Cross-platform build, version sync, changelog generation

---

## 9. Key Architectural Decisions

| Decision | Rationale |
|----------|-----------|
| **Tauri 2 over Electron** | 40-80MB vs 400-800MB, native performance, no Node.js runtime |
| **React 19 over Svelte 5** | Ecosystem maturity, type-safe TSX, wider hiring pool (migrated v0.4.4) |
| **Dual store system (storeCompat + Zustand)** | Gradual migration from Svelte-flavored stores to Zustand; both coexist |
| **Service modules over monolithic store** | Decomposed orchestrator into 20+ focused services with individual tests |
| **Local-first dictation (native ONNX)** | Whisper/Parakeet STT and Silero VAD run natively in Rust, so dictation works offline with no cloud dependency. TTS was removed in v2.0; spoken replies exist only inside a realtime speech-to-speech session |
| **Git worktree isolation per agent** | Multiple agents edit same repo without conflict (Rust backend + TS service) |
| **BYO-key architecture** | Users bring their own API keys or run local models; no meter, no subscription |
| **`storeCompat.ts` custom implementation** | Avoids shipping Svelte runtime just for reactive stores; ~100 LOC vanilla TS |
