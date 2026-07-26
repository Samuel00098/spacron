# Dev Tools Roadmap

Thirteen feature proposals scoped for a developer who wants Spacron to cover the
remaining daily workflow gaps. Each is independent; implement in any order.

Items 1–6 were the original set. Items 7–13 came out of a dogfooding pass on
2026-07-26 (driving the real app through a normal working session), so each of
them names the specific code that falls short today rather than describing a
feature in the abstract.

---

## Table of Contents

1. [Container Shell Access](#1-container-shell-access)
2. [Interactive Rebase Visualizer](#2-interactive-rebase-visualizer)
3. [Multi-Cursor / Column Editing](#3-multi-cursor--column-editing)
4. [Port Forwarding / Tunnel UI](#4-port-forwarding--tunnel-ui)
5. [Test Results Panel](#5-test-results-panel)
6. [Extension / Dynamic Tool Registration](#6-extension--dynamic-tool-registration)
7. [Hunk-Level Staging and Diff-First Source Control](#7-hunk-level-staging-and-diff-first-source-control)
8. [Blame and File History](#8-blame-and-file-history)
9. [Symbol Search and Go-to-Definition](#9-symbol-search-and-go-to-definition)
10. [Script Runner](#10-script-runner)
11. [Multi-Engine Database Support](#11-multi-engine-database-support)
12. [HTTP Client Completion](#12-http-client-completion)
13. [Agent Fleet Dashboard](#13-agent-fleet-dashboard)

---

## Already shipped

**Problems panel (LSP diagnostics)** — shipped 2026-07-26. Language servers
already streamed `textDocument/publishDiagnostics`, but
`codemirror-languageserver` consumed them privately as inline lint markers, so a
problem was only visible while that exact file was open. `stores/diagnostics.ts`
now taps the notification stream via `client.attachPlugin` on the shared client,
and `components/problems/ProblemsPanel.tsx` lists them grouped by file as a
left-drawer tab. Don't re-propose it — but see the blocker in
[§9](#9-symbol-search-and-go-to-definition), which the panel shares.

---

## 1. Container Shell Access

**Problem:** The Containers panel (`ContainersPanel.tsx`) lists Docker actions as
pre-baked shell commands sent to a terminal session. There is no way to open an
interactive shell *inside* a running container, attach to its STDOUT stream, or
view its logs in a dedicated pane.

**Scope:** ~1 week

**Implementation sketch:**

### Rust backend (`src-tauri/src/commands/containers.rs`)

New Tauri commands (or extend the existing `terminal.rs` family):

```
container_list   → docker ps --format json, parse into structured list
container_shell  → docker exec -it <id> <shell>, spawn as PTY session
container_logs   → docker logs --follow <id>, pipe to a terminal pane
container_inspect → docker inspect <id>, return JSON metadata
```

The `container_shell` command reuses the existing `portable-pty` crate — it
spawns `docker exec` as the child process instead of a user shell. The PTY
session ID is returned to the frontend so it can mount an xterm.

### Frontend (`ContainersPanel.tsx`)

- After listing containers (via the existing `docker ps` command), show each
  container as a card with: name, status, ports, image.
- Add an **"Attach Shell"** button per container that calls
  `createTerminalSession()` with `commandOverride: ["docker", "exec", "-it",
  <id>, "sh"]` and labels the session tab with the container name.
- Add a **"Logs"** toggle that streams `docker logs --tail=100 --follow` into a
  read-only terminal pane.
- The container list refreshes on a 5-second poll or via Docker events.

### Store (`terminal.ts` / new `containers.ts`)

- `containerSessions` — map of `containerId → sessionId` so the panel can track
  which containers have an open shell/logs pane.
- `containerList` — writable with the current parsed Docker ps output.

### Dependencies

None — relies on the system `docker` binary (same assumption as the existing
panel) and the existing PTY infrastructure (`pty-bridge.ts`,
`TerminalPane.tsx`).

---

## 2. Interactive Rebase Visualizer

**Problem:** The Source Control panel shows a text-based `git log --graph` but
has no interactive rebase UI. Developers performing squash, reword, reorder, or
drop operations must drop to a terminal and run `git rebase -i` manually.

**Scope:** ~2 weeks

**Implementation sketch:**

### Rust backend (`src-tauri/src/commands/workspace.rs`)

New Tauri commands:

```
git_rebase_todo   → git rebase --onto? no — read .git/rebase-merge/git-rebase-todo
git_rebase_start  → git rebase -i HEAD~N, but non-interactively write the todo list
git_rebase_edit   → rewrite the todo list file with new instructions
git_rebase_continue → git rebase --continue
git_rebase_abort  → git rebase --abort
git_log_oneline   → git log --oneline --decorate -N (for the commit picker)
```

The key insight: instead of spawning an editor for the todo list, let the
frontend build the list and write it via `git_rebase_start`. The rebase
operation itself runs in a hidden PTY or via `std::process::Command` with
status polling.

### Frontend

**New component:** `InteractiveRebasePanel.tsx` (opened from the Source Control
toolbar or via a "Rebase" button on a branch).

- **Commit picker:** shows the last N commits as a vertical list with
  checkboxes. Each commit shows hash, author, date, subject.
- **Drag-to-reorder:** commits are draggable within the list.
- **Action picker:** per-commit dropdown: `pick`, `reword`, `squash`, `fixup`,
  `drop`, `edit`.
- **Apply:** writes the modified todo list and starts the rebase. If conflicts
  arise, show a conflict-resolution banner (linking to the merge-conflict
  viewer).
- **Abort / Continue:** buttons visible while rebase is in progress.

Rendered as a right-drawer tool or a modal — whichever fits the layout better.

### Conflict integration

When `git rebase --continue` fails, surface the conflicted files in the diff
viewer (`ReviewPanel.tsx`). Add a "Resolved — Continue" button that stages the
fix and runs `git rebase --continue`.

### Dependencies

No new libraries. The `git` binary is already required by the app.

---

## 3. Multi-Cursor / Column Editing

**Problem:** CodeMirror 6 supports multiple selections natively, but Spacron
does not provide a UI gesture for column (box) selection — the `Alt+Shift+drag`
pattern every developer expects.

**Scope:** ~3 days

**Implementation sketch:**

### Editor integration (`CodeEditor.tsx`)

CodeMirror 6's `EditorView` has `allowMultipleSelections: true` set by the
codemirror package defaults, but column selection requires a custom extension
that translates `Alt+Shift` + mouse drag into rectangular range selections.

The standard approach:

```ts
import { keymap } from '@codemirror/view';
import { rectangularSelection } from '@codemirror/rectangular-selection';

// Already part of codemirror's view package — just add to extensions:
extensions: [
  rectangularSelection(),
  keymap.of([...]),
]
```

`@codemirror/rectangular-selection` ships with CodeMirror 6 and provides column
selection out of the box when `Alt` (or `Option` on macOS) is held during a
drag. No new dependencies.

### Settings toggle

Add an **Enable Column Selection** toggle in Settings > General (default: on)
so users who never use it can disable it.

### Shortcut display

The settings shortcut panel should show the platform-appropriate modifier:
`Alt+Shift+drag` (Windows/Linux) or `Option+Shift+drag` (macOS).

### Dependencies

`@codemirror/rectangular-selection` — it's already a transitive dependency of
`codemirror` (the main package), but may need to be listed explicitly in
`package.json` and imported.

---

## 4. Port Forwarding / Tunnel UI

**Problem:** The remote workspace feature connects to a remote box via WebSocket
and reuses the PTY core, but there is no UI to manage SSH port forwards or
tunnels. A developer working on a remote machine needs to forward ports (e.g.,
`:3000` on the remote → `:3000` locally) to use the preview proxy.

**Scope:** ~1.5 weeks

**Implementation sketch:**

### Rust backend (`src-tauri/src/commands/tunnels.rs`)

New Tauri commands:

```
tunnel_list         → list active tunnels (pid, local_port, remote_host, remote_port)
tunnel_create       → spawn ssh -L <local>:<remote_host>:<remote_port> <target>
tunnel_close        → kill the tunnel process by pid
tunnel_available    → scan if `ssh` is in PATH
```

Each tunnel is a child process (`std::process::Command`). Track pids in
`AppState` so they can be cleaned up on app close.

### Frontend

**New component:** `TunnelsPanel.tsx` (registered as a right-drawer tool —
add `'tunnels'` to `RIGHT_DRAWER_TOOLS`).

- **Active tunnels list:** table with columns: Local Port, Remote, Status
  (online/disconnected), Uptime. Each row has a disconnect (×) button.
- **New tunnel form:** text fields for Local Port, Remote Host (default
  `localhost`), Remote Port, SSH target (user@host). A "Create" button spawns
  the tunnel.
- **Status polling:** every 3 seconds, check if each tunnel's child process is
  still alive. Mark dead tunnels as "disconnected" and offer a reconnect button.
- **Integration with Preview Proxy:** when a tunnel is active, add the tunnel's
  local port to the preview panel's quick-navigate port list.

The panel is gated behind a "Remote workspace connected" flag — no point
showing it when everything is local.

### Store (`tunnels.ts`)

```
type TunnelEntry = {
  id: string;
  localPort: number;
  remoteHost: string;
  remotePort: number;
  target: string;
  status: 'connecting' | 'online' | 'disconnected' | 'error';
  errorMessage?: string;
};
activeTunnels: writable<TunnelEntry[]>
```

### Dependencies

Requires `ssh` on the system PATH. The existing `preview.rs` proxy logic can
consume a tunnel's local port the same way it consumes the dev server's port.

---

## 5. Test Results Panel

**Problem:** The app ships with vitest and 352 tests, but there is no GUI to
run tests or see results. A developer must alt-tab to a terminal, run
`npm run test`, and parse TAP output by eye.

**Scope:** ~2 weeks

**Implementation sketch:**

### Rust backend (`src-tauri/src/commands/tests.rs`)

New Tauri commands:

```
test_discover       → parse vitest config / jest config / package.json scripts
                     to find test runner and pattern
test_run            → spawn the test runner, stream stdout/stderr as structured events
test_run_file       → run tests in a specific file (vitest <file> / jest <file>)
test_cancel         → kill the test runner process
test_watch          → start in watch mode, stream result diffs
```

Each `test_run` invocation spawns `npx vitest --reporter json` (or the
configured runner) and captures its JSON output. The reporter emits structured
results per-file/per-test, which the frontend renders as a tree.

### Frontend

**New component:** `TestsPanel.tsx`

- **Project scripts detection:** reads `package.json` scripts and auto-detects
  test commands (`vitest`, `jest`, `mocha`, `ava`, `tape`). Shows detected
  runner at the top.
- **File tree:** lists test files from the project. Each file shows its status
  (pass/fail/pending) and a play button to run just that file.
- **Run all / Run file / Watch mode:** three primary actions. Watch mode
  re-runs on file changes (vitest's native `--watch`).
- **Results tree:** expandable per-file results. Each test case shows name,
  duration, status, and (on failure) the error message and stack trace.
- **Pass/fail bar:** a compact summary strip at the top (✓ 42 / ✗ 3 / ○ 0).

### Store (`tests.ts`)

```
type TestFileResult = {
  file: string;
  status: 'pass' | 'fail' | 'running' | 'skipped';
  duration: number;
  tests: TestResult[];
};
type TestResult = {
  name: string;
  status: 'pass' | 'fail' | 'skipped' | 'todo';
  duration?: number;
  errorMessage?: string;
  stackTrace?: string;
};
testResults: writable<Map<string, TestFileResult>>;
testRunning: writable<boolean>;
```

### Integration

- Parse `vitest --reporter json` output for structured results.
- Fall back to TAP or plain-text parsing for other runners.
- The panel auto-detects the test command from `package.json` scripts (looking
  for `"test"`, `"test:unit"`, `"vitest"`, etc.) so zero config is needed.

### Dependencies

No new npm packages. `npx vitest` is already available via the project's
`node_modules`. For vitest JSON output, the built-in reporter is used.

---

## 6. Extension / Dynamic Tool Registration

**Problem:** The right utility drawer's tool set (`RIGHT_DRAWER_TOOLS`) and the
left drawer's sidebar tabs are hardcoded in `layout.ts` and
`zustand/layout.ts`. Each tool needs boilerplate: a visibility flag on
`LayoutState`, a lazy-loaded component import in `AppShell.tsx`, a metadata
entry for the dock icon, a keyboard shortcut case, etc. There is no way for
third-party code or even first-party modules to register a new panel without
touching these core files.

**Scope:** ~3 weeks

**Implementation sketch:**

### Manifest format (`lib/types/extension.ts`)

```ts
type ExtensionManifest = {
  id: string;                    // unique slug, e.g. "my-panel"
  name: string;                  // display name
  version: string;
  description: string;
  icon: string;                  // SVG string or component path
  location: 'left-drawer' | 'right-drawer' | 'center-room' | 'floating';
  component: () => Promise<{ default: React.ComponentType }>; // lazy import
  onActivate?: (ctx: ExtensionContext) => void;
  onDeactivate?: (ctx: ExtensionContext) => void;
};

type ExtensionContext = {
  workspace: { projectId: string | null; rootPath: string | null };
  terminal: { write: (sessionId: number, data: string) => void };
  editor: { openFile: (path: string) => void };
  notifications: { showToast: (msg: string, type: string) => void };
  // sandboxed invoke for backend commands
  invoke: (cmd: string, args?: Record<string, unknown>) => Promise<unknown>;
};
```

### Registration API

A global registry in `lib/services/extensions/registry.ts`:

```ts
export function registerExtension(manifest: ExtensionManifest): void;
export function unregisterExtension(id: string): void;
export function getExtensions(location: ExtensionManifest['location']): ExtensionManifest[];
```

Extensions register themselves at import time. First-party tools (Toolbox, HTTP,
DB, Containers, Env) become regular extensions registered in their own module
file, proving the system works with the same API third-party code would use.

### Dynamic right-drawer integration

The `RIGHT_DRAWER_TOOLS` constant in `zustand/layout.ts` becomes a derived set:
the hardcoded entries **plus** every extension whose `location` is
`'right-drawer'`. The `AppShell.tsx` panel host (`PanelHost`) iterates over
`getExtensions('right-drawer')` and renders their lazy component.

Key changes to `zustand/layout.ts`:

- `LayoutState` gets a dynamic field: `extensionVisible: Record<string, boolean>`
  to track each registered panel's open state (replacing the individual
  `toolboxVisible`, `httpVisible`, etc. booleans).
- `RIGHT_DRAWER_TOOLS` is replaced by a function that returns the current set.
- The drawer toggle logic (`showRightDrawerTool`) treats extension IDs the same
  as built-in tools.

### Keyboard shortcut support

Shortcuts can target an extension by its `id`. The existing shortcut system in
`AppShell.tsx` treats every `case 'goToToolbox':` as hardcoded. Add a generic
`case 'toggleExtension':` that looks up `matched.action` in the registry and
toggles that panel.

### Security sandboxing

- Extensions run in the same JS context (no iframe) for simplicity, but
  `ExtensionContext.invoke` is a wrapper around `backendInvoke` that validates
  the command name against an allowlist declared in the manifest.
- The manifest's `component` is a dynamic `import()` — same as the existing
  lazy panels, so no new bundling concerns.

### Backend extension commands

An extension can declare backend `invoke` targets in its manifest. At build
time (or on first load), the Rust backend scans a well-known directory
(`~/.config/spacron/extensions/<id>/commands/`) and registers any `.rs` or
compiled commands found there. For v1, extensions use only existing backend
commands (filesystem, terminal write, etc.) — custom Rust commands come in a
later iteration.

### Migration

The five built-in right-drawer tools are migrated one by one into extension
modules under `src/lib/extensions/toolbox/`, `src/lib/extensions/http/`, etc.
Each exports a manifest and a component. The old `RIGHT_DRAWER_TOOLS` and
visibility flags are kept as aliases until the migration is complete.

### Dependencies

No new npm or crate dependencies. The system is built on existing primitives:
`lazy()` / `Suspense` for dynamic components, `backendInvoke` for IPC, zustand
for state, and the existing layout store for visibility flags.

---

## 7. Hunk-Level Staging and Diff-First Source Control

**Problem:** Two things make committing harder than it should be.

Committing is all-or-nothing. `SourceControl.tsx` stages with `git add -A` and
then commits, so there is no way to commit part of your work — you either take
every changed file or none. Anyone who curates commits has to drop to a terminal.

And the diff lives in the wrong place. Clicking a changed file in Source Control
opens the **raw file** in the editor, not its diff (`docs/FEATURES.md` §7 claims
otherwise — the docs are wrong). The actual diff viewer is the separate **Code
Review** panel (`ReviewSidebarPanel.tsx` / `ReviewPanel.tsx`), where you have to
find and click the file a second time. Review-before-commit, the single most
common git workflow, costs an extra hop and a panel switch.

**Scope:** ~2.5 weeks

**Implementation sketch:**

### Rust backend (`src-tauri/src/commands/workspace.rs`)

```
git_diff_file        → git diff --unified=3 -- <file>  (already partly present)
git_apply_patch      → git apply --cached [--reverse] < patch   (stage/unstage a hunk)
git_stage_paths      → git add -- <paths…>       (replaces the blanket add -A)
git_unstage_paths    → git reset HEAD -- <paths…>
git_commit_staged    → git commit -m <msg>       (no implicit add)
git_commit_amend     → git commit --amend -m <msg>
git_branch_list      → git branch --all --format=…
git_branch_create    → git switch -c <name> [<start-point>]
git_branch_switch    → git switch <name>
```

The load-bearing one is `git_apply_patch`. Staging a hunk means generating a
patch containing only that hunk and feeding it to `git apply --cached` on stdin;
unstaging is the same patch with `--reverse`. Line-level staging is the same
mechanism with a patch synthesised from the selected lines, which requires
rewriting the hunk header counts (`@@ -a,b +c,d @@`) — get that arithmetic wrong
and `git apply` rejects the patch, so it needs unit tests of its own.

### Frontend

- **Merge the two panels.** Clicking a file in Source Control shows its diff,
  reusing the existing `parseDiff` and the inline/split renderers already in
  `ReviewSidebarPanel.tsx` rather than writing a second diff view. Keep Code
  Review as the full-window presentation of the same data.
- **Per-hunk controls** in the diff gutter: `Stage hunk` / `Unstage hunk`, plus
  `Stage selection` when lines are selected.
- **Staged / unstaged split** in the changes list, so you can see what the next
  commit will actually contain.
- **Amend last commit** and a **branch switcher / create** control in the branch
  bar (it currently only displays the branch name and ahead-count).

### Store (`stores/sourceControl.ts`)

```
type FileDiff = { path: string; hunks: Hunk[]; staged: boolean };
type Hunk = { header: string; lines: DiffLine[]; staged: boolean };
stagedPaths:   writable<Set<string>>
fileDiffs:     writable<Map<string, FileDiff>>
```

### Dependencies

None — the `git` binary is already required.

### Note

`git add -A` also currently picks up files you never touched. Moving to explicit
path staging fixes that as a side effect.

---

## 8. Blame and File History

**Problem:** There is no way to answer "who changed this line and why" without
leaving the app. The commit graph shows project history, but nothing connects a
line of code to the commit that introduced it, and there is no way to view an
earlier revision of a file.

**Scope:** ~4 days

**Implementation sketch:**

### Rust backend (`src-tauri/src/commands/workspace.rs`)

```
git_blame        → git blame --line-porcelain -- <file>
git_file_log     → git log --follow --format=… -- <file>
git_show_file    → git show <rev>:<path>       (content at a revision)
```

`--line-porcelain` is the parseable form: one record per line carrying commit
hash, author, author-time and the line content. Parse it into a
`line → BlameEntry` array on the Rust side so the frontend receives structured
data rather than doing text surgery.

### Frontend (`CodeEditor.tsx`)

- **Gutter blame** as a CodeMirror gutter extension: short author + relative date
  per line, dimmed. Hover shows a tooltip with the full commit subject, hash and
  date; clicking opens that commit in the diff viewer.
- **Toggle** in the editor toolbar and a `Toggle Blame` command in the palette —
  blame is noisy, so it is off by default.
- **File history** as a dropdown listing this file's commits. Selecting one opens
  the file at that revision in a read-only tab (`git_show_file`), which reuses
  the existing editor with `readOnly: true`.

### Store (`stores/blame.ts`)

```
type BlameEntry = { line: number; hash: string; author: string; time: number; subject: string };
blameByFile: writable<Map<string, BlameEntry[]>>
```

Cache per `(path, headCommit)` and drop the entry when the file is saved or HEAD
moves, otherwise the gutter drifts out of sync with the buffer.

### Dependencies

None. High value for the effort — the git plumbing is already in place and this
is mostly a gutter renderer.

---

## 9. Symbol Search and Go-to-Definition

**Problem:** Navigation is text-only. The title-bar search
(`commands/search.rs`) greps the project, which is fine for finding a string but
not for jumping to a symbol. There is no `Ctrl+T` symbol jump and no F12
go-to-definition, which is the main thing that makes moving around a large
codebase feel slower here than in an IDE.

**Scope:** ~5 days once the blocker below is cleared

**Blocker — LSP never activates.** Verified 2026-07-26 with `rust-analyzer`
installed, `enableLsp` true, a `.rs` file open in CodeMirror and a project root
set: **no language-server process ever spawns, and the editor shows no lint
markers either.** This is not specific to any one feature — the existing LSP
integration appears inert, which also caps the value of the shipped Problems
panel. What is known:

- `lsp_check_server` reports the server as available.
- `lsp_start` binds the bridge port successfully.
- `LspServer::spawn` happens **per WebSocket connection** inside the bridge's WS
  handler (`lsp/bridge.rs`), and the connection token is **single-use with a
  short TTL**. So if the frontend's `WebSocketTransport` never connects, no
  server is launched and the token quietly expires.
- `createLspExtension` returns `null` silently on a bad root — every failure path
  in `services/lsp/client.ts` returns `null` without surfacing an error, which is
  why this has been invisible.

Fix the transport connection first, and make a failed connection raise a visible
error instead of failing silent. Start at the `ws://127.0.0.1:<port>/?token=…`
URL built by `resolveLspConnection`.

**Implementation sketch:**

### Most of this is already in the box

`codemirror-languageserver` already exports `jumpToDefinition`,
`jumpToDefinitionKeymap`, `jumpToDefinitionPos` and `renameSymbol`. None are
currently wired into `CodeEditor.tsx`. Adding the keymap gets F12 and rename
almost for free.

### Rust backend (`src-tauri/src/commands/lsp.rs`)

```
lsp_workspace_symbols → workspace/symbol request against the running server
```

The bridge currently only pumps bytes between the WebSocket and the server's
stdio. Either add a request/response path for one-off queries, or issue
`workspace/symbol` from the frontend over the existing `LanguageServerClient`
(it already has a generic `request` method) — the latter needs no Rust changes
and is the cheaper route.

### Frontend

- **Symbol palette** (`Ctrl+T`): a new mode in the existing `CommandPalette` /
  `FloatingSearch` surface, fed by `workspace/symbol`, fuzzy-filtered, showing
  symbol kind, name and containing file. Selecting one calls `openFile` then
  `jumpToLine` — the same jump path the Problems panel uses.
- **F12 / Go to Definition** and **Shift+F12 / Find References**, plus a
  right-click context menu on identifiers.
- **Breadcrumb** of enclosing symbols above the editor, via
  `textDocument/documentSymbol`.

### Fallback without a language server

For languages with no server installed, fall back to a ripgrep-style definition
heuristic (`^\s*(fn|function|class|const|type|interface)\s+<name>`) using the
existing search backend. Worse than real LSP, but better than nothing, and it
keeps the feature useful for the languages `SUPPORTED` doesn't cover.

### Dependencies

None new.

---

## 10. Script Runner

**Problem:** Running a project's own scripts is manual. The Shell Snippets panel
holds commands you typed in yourself; nothing reads `package.json` scripts or
`Cargo.toml` targets, so `npm run dev` / `npm test` / `cargo build` get retyped
into a terminal every session, and there is no record of what a run produced.

**Scope:** ~5 days

**Implementation sketch:**

### Rust backend (`src-tauri/src/commands/workspace.rs`)

```
scripts_discover → parse package.json "scripts", Cargo.toml [[bin]]/workspace
                   members, Makefile targets, and pyproject/justfile if present
```

Pure parsing — no execution. Runs are launched through the existing PTY layer, so
a script gets a real terminal (colour, progress bars, interactive prompts all
work) rather than a captured pipe.

### Frontend

**New component:** `ScriptsPanel.tsx` — a left-drawer tab beside Problems.

- **Discovered scripts** grouped by source (`package.json`, `Cargo.toml`, …),
  each with a play button.
- **Run into a labelled pane:** reuse `createTerminalSession` with the session
  `role` set to the script name, so `dev` and `test` become distinguishable panes
  instead of `Terminal 2` and `Terminal 3`. This builds directly on the shell /
  agent title separation already in `registerPtySession`.
- **Exit-code badge** per script (green tick / red cross with the code), driven
  by the existing `onSessionExit` broadcast.
- **Re-run** and **stop** per script; re-run reuses the same pane so scrollback
  accumulates in one place.
- **Long-running detection:** a script whose role is `dev`/`serve`/`watch` is
  marked as a server, which `sessionHasRunningProcess` already models — feed the
  detected dev-server port to the preview panel so starting `dev` from here wires
  up the preview automatically.

### Store (`stores/scripts.ts`)

```
type Script = { id: string; name: string; command: string; source: 'npm' | 'cargo' | 'make'; };
type ScriptRun = { scriptId: string; sessionId: number; startedAt: number; exitCode: number | null };
discoveredScripts: writable<Script[]>
scriptRuns:        writable<Map<string, ScriptRun>>
```

### Dependencies

`package.json` parsing needs nothing new (`serde_json` is already a dependency).
`Cargo.toml` / `pyproject.toml` parsing needs the `toml` crate added — it is
**not** currently a direct dependency of `src-tauri`, despite the workspace being
a Cargo project. Shipping npm-only discovery first avoids the new dependency
entirely and covers most projects.

---

## 11. Multi-Engine Database Support

**Problem:** The Database panel is **SQLite-only**. `commands/db.rs` uses
`rusqlite` directly — `db_list_tables` reads `sqlite_master` and
`db_execute_query` opens with `OpenFlags::SQLITE_OPEN_READ_ONLY` for anything
classified as a SELECT. Most web projects are on Postgres or MySQL, so for those
developers the panel does nothing at all. There is also no schema tree, no query
history, and no way to edit a row.

**Scope:** ~2 weeks

**Implementation sketch:**

### Rust backend (`src-tauri/src/commands/db.rs`)

Introduce a connection abstraction behind the existing command surface so the
frontend contract barely changes:

```rust
enum DbConnection { Sqlite(rusqlite::Connection), Postgres(..), MySql(..) }

trait DbDriver {
    fn list_schemas(&self) -> Result<Vec<Schema>>;   // schema → tables → columns
    fn execute(&self, sql: &str, read_only: bool) -> Result<DbQueryResult>;
}
```

```
db_connect      → open a connection from a URL/DSN, return a handle id
db_disconnect   → close a handle
db_list_schema  → structured schema (schemas, tables, columns, types, keys)
db_execute_query→ existing shape, now takes a handle instead of a path
```

**Keep the read-only guarantee per engine.** The SQLite path's safety comes from
an OS-level read-only open flag, not from the SELECT string match — that
belt-and-braces design is deliberate and must be reproduced, not dropped. For
Postgres use a `READ ONLY` transaction; for MySQL, `START TRANSACTION READ
ONLY`. The write path keeps the existing explicit confirmation.

### Credentials

DSNs contain passwords, so store them where secrets already live: the OS
keychain, via the same mechanism behind `commands/secrets.rs` and the Environment
panel — never in `localStorage` or per-project JSON.

### Frontend (`DbExplorerPanel.tsx`)

- **Connection manager:** saved connections per project with engine, host,
  database and user; password from the keychain.
- **Schema tree:** schemas → tables → columns with types and key markers,
  replacing the current flat table list.
- **Query history** per connection, and row-level editing for single-table
  SELECTs that include a primary key.
- Replace the two `alert()` calls at `DbExplorerPanel.tsx:164-165` with toasts —
  `window.alert` blocks the whole WebView2 and is inconsistent with the rest of
  the app.

### Dependencies

New Rust crates: `tokio-postgres` (or `sqlx` with the `postgres`/`mysql`
features) and a MySQL driver. `sqlx` covers all three engines behind one API and
would let `DbDriver` be thinner, at the cost of a large compile-time surface —
worth weighing against the current cold build time.

---

## 12. HTTP Client Completion

**Problem:** The HTTP client works but is missing the parts that make a REST
client usable day to day.

There is **no query-parameter editor at all** — and the code knows it:
`HttpClientPanel.tsx:51` declares `activeTab` as
`'params' | 'headers' | 'body' | 'auth'`, but `REQ_TABS` on line 26 is only
`['headers', 'body', 'auth']`. The `'params'` state is unreachable dead code.

There is also no cURL import/export, no request history, and no environment
switcher — even though `EnvManager` already stores secrets in the OS keychain and
advertises `{{VAR}}` templating for exactly this client.

**Scope:** ~6 days

**Implementation sketch:**

### Frontend (`HttpClientPanel.tsx`)

- **Query params tab:** fill in the dead state — an enabled/key/value table like
  the headers editor, kept in two-way sync with the URL's query string (editing
  either updates the other).
- **cURL import/export:** paste a `curl` command to populate method, URL,
  headers and body; copy any request back out as `curl`. This is how API examples
  actually arrive, and it is the single highest-value item here.
- **Request history** per project: method, URL, status, duration, timestamp, with
  one-click replay. Bounded (say 200 entries) and persisted per project.
- **Environment switcher:** a dropdown of named variable sets, resolving
  `{{VAR}}` at send time from the existing keychain-backed store. Show unresolved
  variables as a warning *before* sending rather than sending `{{VAR}}` literally.

### Store (`stores/http.ts`)

```
type HttpEnvironment = { id: string; name: string; vars: Record<string, string> };
activeEnvironmentId: writable<string | null>
requestHistory:      writable<HttpHistoryEntry[]>
```

### Security

`SENSITIVE_HEADER_RE` and `PRIVATE_IP_RE` already exist in the panel. Extend
them: never persist an `Authorization` header value into history — store a
`{{VAR}}` reference or a redaction marker instead, so history can't become a
plaintext credential store.

### Dependencies

None. cURL parsing is a small hand-rolled tokenizer (handle `-X`, `-H`, `-d`,
`--data-raw`, `-u`, quoting and line continuations); pulling in a dependency for
it is not worth the surface.

---

## 13. Agent Fleet Dashboard

**Problem:** Spacron's differentiator is running several coding agents at once,
each in an isolated git worktree under `.spacron/worktrees/<branch>` — but there
is no single view of what the fleet has actually produced. To judge one agent's
work you switch to its room, read its terminal, then go to Source Control, which
is scoped to the open project rather than to that agent's worktree. Reviewing and
landing four agents' changes means repeating that four times, and there is no
in-app way to merge or discard a worktree — the machinery in
`worktree-manager.ts` and `worktree-reconciler.ts` creates and reconciles them
but never surfaces a diff.

This is the feature with no equivalent elsewhere; the rest of this roadmap is
catching up to other editors.

**Scope:** ~1.5 weeks

**Implementation sketch:**

### Rust backend (`src-tauri/src/commands/workspace.rs`)

```
worktree_list        → git worktree list --porcelain
worktree_diff_stat   → git diff --stat <baseCommit>..HEAD   (inside the worktree)
worktree_diff        → git diff <baseCommit>..HEAD -- [path]
worktree_merge       → git merge --no-ff <branch>  (run in the MAIN tree)
worktree_remove      → git worktree remove --force <path> && git branch -D <branch>
```

`WorktreeInfo` already carries `path`, `branch`, `baseBranch` and `baseCommit`,
so the diff base is known without inferring it.

### Frontend

**New component:** `FleetDashboard.tsx` — a center room, reachable from the Fleet
ambient mode.

One card per agent, keyed by session, showing:

- Agent name and tool brand mark (reuse `AgentBrandMark`), plus live status from
  the existing turn signals — working / awaiting input / finished / exited.
- Its worktree branch and `+N/−M` diff stat against `baseCommit`.
- Changed-file list, clicking through to the diff viewer from
  [§7](#7-hunk-level-staging-and-diff-first-source-control) — pointed at the
  worktree rather than the open project. **This is the dependency to respect:
  the diff viewer must take a repo path, not assume the active project.**
- Actions: **Merge into `<baseBranch>`**, **Discard worktree**, **Open its
  terminal**.

### Safety

Merge and discard are destructive and act on real git state, so both need an
explicit confirmation naming the branch, and discard must refuse while the
agent's session is still running (`isRunning`) — killing an agent mid-write and
deleting its worktree is unrecoverable. Reuse the existing exit broadcast
(`onSessionExit`) to know when a worktree is safe to remove.

### Store

Extend the orchestrator store rather than adding a parallel one — it already
owns the agent/task/worktree relationships.

### Dependencies

None.

---

## Effort Summary

| # | Feature | Est. Days | Risk | Dependencies |
|---|---|---|---|---|
| 1 | Container Shell Access | 5 | Low | Existing PTY + Docker |
| 2 | Interactive Rebase Visualizer | 10 | Medium | Git binary |
| 3 | Multi-Cursor / Column Editing | 3 | Low | Built-in CM package |
| 4 | Port Forwarding / Tunnel UI | 7 | Low | SSH binary |
| 5 | Test Results Panel | 10 | Medium | Vitest/npx |
| 6 | Extension / Dynamic Tool Registration | 15 | High | Core layout refactor |
| 7 | Hunk-Level Staging + Diff-First Source Control | 12 | Medium | Git binary |
| 8 | Blame and File History | 4 | Low | Git binary |
| 9 | Symbol Search and Go-to-Definition | 5 | Medium | **Blocked: LSP activation** |
| 10 | Script Runner | 5 | Low | Existing PTY |
| 11 | Multi-Engine Database Support | 10 | Medium | sqlx / postgres + mysql crates |
| 12 | HTTP Client Completion | 6 | Low | None |
| 13 | Agent Fleet Dashboard | 8 | Medium | Depends on #7's diff viewer |

**Total:** ~100 days (rough order of magnitude, solo developer).

### Suggested order

1. **Fix the LSP transport** (not a feature — a bug, but it gates #9 and decides
   whether the shipped Problems panel is worth anything).
2. **#8 Blame** and **#12 HTTP completion** — small, self-contained, immediately
   useful.
3. **#7 Hunk staging** — the biggest workflow win, and #13 depends on its diff
   viewer taking an arbitrary repo path.
4. **#10 Script runner**, then **#13 Fleet dashboard**.
5. **#11 Multi-engine DB** and **#9 symbol search** once their prerequisites
   land.
6. **#6 Extension registration** last — it is a core refactor, and doing it after
   the panels above exist means the API is designed against seven real consumers
   instead of guessed ones.
