# Dev Tools Roadmap

Six feature proposals scoped for a developer who wants Spacron to cover the
remaining daily workflow gaps. Each is independent; implement in any order.

---

## Table of Contents

1. [Container Shell Access](#1-container-shell-access)
2. [Interactive Rebase Visualizer](#2-interactive-rebase-visualizer)
3. [Multi-Cursor / Column Editing](#3-multi-cursor--column-editing)
4. [Port Forwarding / Tunnel UI](#4-port-forwarding--tunnel-ui)
5. [Test Results Panel](#5-test-results-panel)
6. [Extension / Dynamic Tool Registration](#6-extension--dynamic-tool-registration)

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

## Effort Summary

| # | Feature | Est. Days | Risk | Dependencies |
|---|---|---|---|---|
| 1 | Container Shell Access | 5 | Low | Existing PTY + Docker |
| 2 | Interactive Rebase Visualizer | 10 | Medium | Git binary |
| 3 | Multi-Cursor / Column Editing | 3 | Low | Built-in CM package |
| 4 | Port Forwarding / Tunnel UI | 7 | Low | SSH binary |
| 5 | Test Results Panel | 10 | Medium | Vitest/npx |
| 6 | Extension / Dynamic Tool Registration | 15 | High | Core layout refactor |

**Total:** ~50 days (rough order of magnitude, solo developer).
