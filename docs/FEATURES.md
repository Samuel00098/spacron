# Spacron Feature Reference

This document covers every user-facing feature in Spacron. It is organized by surface area. Settings defaults are shown in parentheses.

> **You are always in control.** Spacron wraps all of this in a *manual-first* design: every automated action —
> an orchestrator edit, a spawned agent, an image generation, a commit — can also be performed by hand from the
> terminal, the editor, or the Source Control panel. AI never runs anything it hasn't asked you about first. See
> [Doing It Yourself](#18-doing-it-yourself).

---

## Table of Contents

1. [Workspaces](#1-workspaces)
2. [File Explorer](#2-file-explorer)
3. [Code Editor](#3-code-editor)
4. [Terminal](#4-terminal)
5. [Floating Prompt Bar](#5-floating-prompt-bar)
6. [Preview Panel](#6-preview-panel)
7. [Git Integration](#7-git-integration)
8. [Themes, Backgrounds and Appearance](#8-themes-backgrounds-and-appearance)
9. [Keyboard Shortcuts](#9-keyboard-shortcuts)
10. [Command Palette and Codebase Search](#10-command-palette-and-codebase-search)
11. [Agent Fleet & Orchestration](#11-agent-fleet--orchestration)
12. [Chat Workspace Mode](#12-chat-workspace-mode)
13. [Voice & Speech](#13-voice--speech)
14. [Image & Video Generation](#14-image--video-generation)
15. [Remote Workspace](#15-remote-workspace)
16. [Mobile Emulator](#16-mobile-emulator)
17. [Tool Rooms](#17-tool-rooms)
18. [Doing It Yourself](#18-doing-it-yourself)
19. [Settings](#19-settings)
20. [UI Zoom and Scaling](#20-ui-zoom-and-scaling)
21. [State Persistence](#21-state-persistence)
22. [Notifications](#22-notifications)

---

## 1. Workspaces

Spacron organizes your work around **workspaces**. A workspace is a named container that can hold one or more open project folders. Workspaces are displayed in the welcome screen and in the project switcher at the top of the sidebar.

### Welcome Screen

When no workspace is active, Spacron shows the welcome screen. From here you can:

- **Open a folder** — opens a system folder picker and creates a new workspace for that folder
- **New workspace** (`Ctrl+N`) — creates an empty workspace ready for you to add projects
- **New Folder** — creates a brand-new empty project folder from inside the app (name + native location picker), then opens it as a project
- **Clone a repository** — clone a remote git repository into a folder of your choice and open it as a project
- **Resume a recent workspace** — click any card in the recent list to re-open it

Recent workspace cards show:
- Workspace name (editable inline)
- Project folder paths (shortened to last two segments)
- Last-opened timestamp ("3h ago", "just now", etc.)
- A remove button to delete the entry from the list

### Multiple Projects per Workspace

Inside a workspace you can open several project folders simultaneously. Each project gets its own tab in the project switcher. The currently active project determines:
- Which folder the file explorer shows
- Which git repository is used for Source Control operations
- Which path the codebase search is scoped to
- Which port `workspace_detect_port` reads when auto-detecting a dev server

### Project Dashboard (Projects HUD)

The Projects panel (left sidebar) gives every open project a card showing its active agents, terminals, rooms, and task status without requiring the project to be active first. Projects can be created, moved between workspace groups, collapsed, filtered, and removed. Workspace groups are collapsible and their state is retained.

### Workspace Naming

Click the workspace label in the sidebar header (or the pencil icon beside it) to rename the workspace inline. Press `Enter` to save or `Escape` to cancel.

---

## 2. File Explorer

The file explorer lives in the sidebar's **Files** tab.

### Reading Directories

The backend reads directory contents via `fs_read_dir`, which:
- Returns files sorted with **directories first**, then files, both alphabetically (case-insensitive)
- Exposes `name`, `path`, `is_dir`, `size` (bytes), and `modified` (Unix timestamp in ms) for each entry
- Only returns entries inside at least one open project root (path scoping enforced in Rust)

### Hidden Files

By default, hidden files (names starting with `.`) are not shown. Toggle them with the **Show Hidden Files** setting in Settings > General. Git-ignored files are shown to the orchestrator's listings and marked; credential files are withheld entirely.

### File Operations

Right-click any file or folder in the tree to access the context menu:

| Action | Description |
|---|---|
| New File | Creates a new empty file in the selected directory |
| New Folder | Creates a new directory |
| Rename | Renames the file or folder inline; press `Enter` to confirm, `Escape` to cancel |
| Delete | Permanently removes the file or folder (and all its contents if a directory) |
| Copy | Copies a file or entire directory tree to a new location |

All operations are path-scoped: the Rust backend rejects any path that falls outside an open project root.

### File Size Limits

- **Read**: Files larger than 50 MB cannot be opened in the editor
- **Write**: Writes are rejected if the content exceeds 100 MB

---

## 3. Code Editor

The editor uses **CodeMirror 6** and opens whenever you click a file in the explorer.

### Language Support

Syntax highlighting and language-aware behaviour is available for:

| Language | Extension(s) |
|---|---|
| JavaScript / JSX | `.js`, `.jsx`, `.mjs`, `.cjs` |
| TypeScript / TSX | `.ts`, `.tsx` |
| CSS | `.css` |
| SCSS / Sass | `.scss`, `.sass` |
| HTML | `.html`, `.htm` |
| JSON | `.json`, `.jsonc` |
| Markdown | `.md`, `.mdx` |
| Python | `.py` |
| Rust | `.rs` |
| Go | `.go` |
| Java | `.java` |
| C / C++ | `.c`, `.cpp`, `.h`, `.hpp` |
| PHP | `.php` |
| SQL | `.sql` |
| YAML | `.yml`, `.yaml` |
| XML | `.xml` |

### Editor Settings

All editor settings are accessible via **Settings > General**.

| Setting | Default | Description |
|---|---|---|
| Font Size | `14` | Editor font size in px |
| Font Family | Auto-detected | Checked against a list of popular monospace fonts installed on the system; falls back to Consolas/monospace |
| Tab Size | `2` | Number of spaces per indent level |
| Word Wrap | Off | Wraps long lines instead of scrolling horizontally |
| Minimap | Off | Shows a scaled-down overview of the file on the right edge |
| Vim Mode | Off | Enables a full Vim key binding layer via `@replit/codemirror-vim` |
| Format on Save | On | Runs the built-in formatter when you save (`Ctrl+S`) |
| Auto Save | Off | Saves the active file automatically |

### Language Server (LSP)

Spacron can attach language servers to the active project. When **Settings > General > Language server** is enabled, supported languages get hover information, go-to-definition, and diagnostics through a bundled LSP bridge.

### Font Auto-Detection

When the app starts, Spacron probes a list of preferred monospace fonts using the Canvas API's `measureText`. The first font detected as installed becomes the default. The full candidate list, in priority order:

JetBrains Mono, Fira Code, Cascadia Code, Cascadia Mono, Victor Mono, IBM Plex Mono, Source Code Pro, Consolas, Monaco, Menlo, DejaVu Sans Mono, Liberation Mono, Courier New.

### Saving Files

Press `Ctrl+S` to save (or rely on **Auto Save**). If **Format on Save** is enabled, the file is formatted first. The file is written to disk via `fs_write_file`, which enforces project-root scoping.

### Inline Completion

With **Ghost text** enabled (Settings > Models > Inline completion), Spacron offers in-editor AI completions as you type.

### Tabs

Multiple files can be open simultaneously. Each open file gets a tab above the editor. Click a tab to switch to it; middle-click or click the close button to close it.

### Format Document

Press `Alt+Shift+F` (or open the command palette and choose **Format Document**) to manually trigger formatting on the active file.

---

## 4. Terminal

The terminal is the primary surface in Spacron — it occupies the left/main section of the workspace and is always visible.

### PTY Sessions

Each terminal tab is backed by a native PTY session created with the `portable-pty` Rust crate. Sessions are real processes — not simulated — so programs behave identically to a native terminal.

### Shell Detection

Spacron automatically detects the best available shell for your platform:

**Windows (in priority order):**
1. PowerShell 7 (`pwsh`) — launched with `-NoLogo -NoProfile`
2. Windows PowerShell 5 (`powershell`) — launched with `-NoLogo -NoProfile`
3. Command Prompt (`cmd.exe` / `%COMSPEC%`)
4. Git Bash (`C:\Program Files\Git\bin\bash.exe`)
5. WSL (`wsl`)

**macOS / Linux (in priority order):**
1. The user's configured login shell (`$SHELL` environment variable)
2. `/bin/zsh`
3. `/bin/bash`
4. `/bin/sh`
5. `fish` (if found in `PATH`)

You can override the shell in **Settings > Terminal**.

### Multi-Pane Layouts

Click the layout picker in the terminal panel to choose from:

| Layout | Panes |
|---|---|
| Single | 1 (default) |
| 2 Horizontal | 2 side by side |
| 2 Vertical | 2 stacked |
| 3 Horizontal | 3 side by side |
| 3 Vertical | 3 stacked |
| 4-grid | 2x2 grid |
| 9-grid | 3x3 grid |

Each pane can hold a different terminal session. Click a pane to focus it (the focused pane receives keyboard input). Sessions can be reassigned to different panes.

### Session Lifecycle

- **Create** — `Ctrl+Shift+`` opens a new terminal tab; the session starts in the current project directory (or the home directory if no project is open)
- **Close** — Click the × button on the session tab or type `exit` in the shell
- **Kill all** — Handled automatically on app close/reload; all PTY child processes are killed

Internal background sessions (for example the Dev Toolbox's connection probe) never take a pane, never show in the tab bar, exit silently, and are killed as soon as their job settles.

Exit notifications appear as toasts in the bottom-right corner:
- Clean exit (code 0): brief "closed" info toast
- Non-zero exit: "process died (exit N)" error toast (6 s)

### Scrollback Buffer

The xterm.js scrollback buffer defaults to **5000 lines**. Change this in Settings > Terminal.

### Terminal Renderer

Two rendering modes are available:

| Mode | Description |
|---|---|
| `dom` (default) | Renders using DOM elements; compatible with all systems |
| `canvas` | Hardware-accelerated canvas renderer; may offer smoother scrolling on high-DPI displays |

The app automatically migrates `webgl` settings from older versions to `dom` on first launch.

### Terminal Font

Terminal font size defaults to **13 px** and inherits the same font family detected for the code editor. Configurable separately in Settings > Terminal.

### Cursor Styles

Three cursor styles are available: `bar` (default), `block`, and `underline`. Change in Settings > Terminal.

### Session Roles

Each pane can be tagged with a role label (Server, Tests, Agent, or a custom string). This helps you identify what each terminal is doing at a glance. Duplicate role names are numbered automatically ("Agent 1", "Agent 2").

### Command Blocks

When you run commands via the Floating Prompt Bar, Spacron tracks the command and its output in collapsible "command blocks" displayed above the terminal. Blocks auto-collapse when the command finishes, keeping the interface tidy. Up to 10 blocks are kept per session; output is capped at 4000 characters.

### Working Directory Tracking

The terminal pane tracks the current working directory via shell integration (OSC sequences or heuristic parsing) and exposes it to the rest of the app. The detected CWD is used when spinning up the preview proxy auto-detection.

### Shell Snippets

The **Snippets** sidebar tab stores frequently-used shell commands. Each command is one click away from being sent to the active terminal session, and snippets can be organized per project.

---

## 5. Floating Prompt Bar

The Floating Prompt Bar is a semi-transparent overlay at the bottom of the terminal area. It is **voice-only**: that is, it has no text box — the microphone is the only way to compose input into it. See [Voice & Speech](#13-voice--speech).

### What it can do

- **Voice mode on a tap** — a bare tap of **left Alt** (press and release, no other key) starts a live voice conversation from anywhere in the app, including while the caret is in a text field or a dialog.
- **Staged prompts** — other parts of the app can hand text to the bar. For example, the Preview panel's "send element to the prompt" and the orchestrator's hand-off of a goal to an agent that was spawned without auto-run. The handed-over text is rendered as a read-only **staged prompt** with **Send** and **Discard**; anything you then say is folded *together with* the staged text rather than replacing it.
- **Attachment chips** — images or screenshots sent to the bar (for example an element screenshot from the Preview DOM Inspector) appear as chips and go out with the next message.
- **Drag-and-drop files** — drag one or more files from your OS file manager onto the bar. Each file's absolute path is appended to the staged content or sent along with your spoken input, which is handy for passing file arguments to CLI tools.
- **Tools menu** — the bar hosts the Tools trigger that opens the menu of rooms and utility panels (Fleet, HTTP Client, Database, Containers, Environment, Mobile Emulator, Code Review, Dev Toolbox, and the room dock).

### Opening the Prompt Bar

The prompt bar is always visible at the bottom of the terminal panel.

### Sending Input

Send the staged prompt (or speak, and it is sent along with the staged text) to the selected terminal session or the active agent. History is kept for what you've sent.

> **Note**: the bar's old text area, terminal-target picker, and `@`-mention file attach were removed in favour of voice — typing into it and selecting a target session is no longer a supported path.

---

## 6. Preview Panel

The preview panel loads your running dev server inside a sandboxed iframe, proxied through Spacron's built-in HTTP server. Open it with `Ctrl+Shift+V` or click the globe icon in the sidebar view tabs.

### Proxy System

When you start the proxy (`Ctrl+Alt+P` or the Start button in the panel), Spacron:

1. Binds an Axum HTTP server on a random free port (the "proxy port")
2. Forwards all HTTP requests to your dev server at the configured "target port" (default: 5173)
3. Injects the inspector script into every HTML response
4. Transparently proxies WebSocket connections (required for HMR in Vite, webpack-dev-server, etc.)

The proxy automatically tries both `127.0.0.1` and `localhost` as the upstream host, in the order configured by **Preferred Local Host** setting.

### Port Auto-Detection

When you open a project, Spacron reads `package.json` scripts and `vite.config.ts` / `vite.config.js` to determine the most likely dev server port:

| Source | Detected port |
|---|---|
| `--port N` or `-p N` in any npm script | N |
| `port: N` in vite config | N |
| `next` or `nuxt` in dependencies | 3000 |
| `astro` in dependencies | 4321 |
| Fallback | 5173 |

You can override the detected port manually in the preview panel.

### Browser Tabs

The preview panel supports multiple browser-style tabs. Each tab maintains its own:
- URL and navigation history (back/forward)
- Load state (loading indicator, slow-load feedback)

Common ports are listed as quick-navigate shortcuts: 3000, 3001, 4173, 4200, 5000, 5173, 6006, 7000, 8000, 8080, 8081, 8888, 9000, and more.

### Device Viewports

Three viewport modes are available via the toolbar:

| Mode | Width |
|---|---|
| Responsive | Full panel width |
| Tablet | 768 px |
| Mobile | 375 px |

In tablet and mobile modes, the iframe is displayed inside a device-shaped chrome to simulate how your app looks on smaller screens.

### Theme Sync

The preview can follow the application theme (light/dark) or be overridden per-panel, and the chosen theme is carried into the rendered page through the preview bridge.

### DOM Inspector

Activate the inspector by clicking the crosshair icon in the preview toolbar. While active:
- The cursor changes to a crosshair
- Hovering over any element shows a blue highlight overlay with a label
- Clicking an element sends its full details to the Spacron inspector pane

The inspector reports:
- CSS selector path
- Tag name
- Inner text (up to 500 characters)
- Outer HTML (up to 3000 characters)
- All HTML attributes
- CSS classes
- Computed styles (display, position, color, backgroundColor, font, margin, padding, width, height)
- Ancestor path (up to 6 levels)
- Page URL and title
- Bounding rect (x, y, width, height)

The inspector works via a small script injected into every proxied HTML response. It does **not** modify your source files.

Click **Send to prompt** to hand the inspected element (with a screenshot) to the prompt bar as context for an agent or the orchestrator.

### Preview Console

Click the console button in the preview toolbar to open the in-panel console log. The injected script intercepts `console.log`, `console.info`, `console.warn`, `console.error`, and `console.debug` in the previewed page and forwards each message (with level, text, URL, and timestamp) to the Spacron console pane. Uncaught errors and unhandled promise rejections are also captured. A **Copy** button copies the visible messages; hovering a row reveals a per-row copy button.

### Screenshot

Click the camera icon to capture the current preview as a PNG. The capture mechanism is platform-specific:
- **Windows**: uses GDI `BitBlt` to copy the screen region matching the preview panel
- **macOS / Linux**: captures the webview content directly and crops to the panel bounds

The PNG is saved to a location of your choice via the system save dialog.

### Opening in Browser

Click the external-link icon to open the current preview URL in your default system browser.

### External URL Proxy

You can enter any `http://` or `https://` URL in the URL bar to proxy an external site through Spacron. This strips `X-Frame-Options` and `Content-Security-Policy` headers so the page can load in the iframe. External URLs that point to private IP ranges (RFC 1918, loopback, link-local) are blocked.

---

## 7. Git Integration

Git operations use the system `git` binary. Spacron requires `git` to be installed and available in `PATH`.

### Source Control Sidebar Tab

Click the git icon in the sidebar to open the Source Control panel for the active project. The panel displays:

**Branch name** — shown at the top

**Changed files** — grouped into:
- Modified (tracked files with changes)
- Added (newly staged files)
- Deleted
- Untracked (new files not yet tracked by git)

Each file entry shows:
- Relative path
- Addition/deletion line counts from `git diff HEAD --numstat`

**Total additions and deletions** — summed across all changed files

### Viewing Diffs

Click any file in the changed list to open its diff in the diff viewer. Untracked files are shown as an all-additions diff (every line prefixed with `+`).

### Committing

1. Type a commit message in the text area at the bottom of the Source Control panel
2. Press `Ctrl+Enter` or click **Commit**

Spacron stages all changes (`git add -A`) then runs `git commit -m "..."`. Commit messages have a maximum length of 10,000 characters.

### Pushing

Click the **Push** button to push the current branch to `origin`. The branch name is determined via `git branch --show-current`.

### Fetching

Click the **Fetch** button to run `git fetch origin`.

### Discarding Changes

- **Discard file** — right-click a file and choose Discard. For untracked files this deletes the file. For tracked files this runs `git reset HEAD -- <file>` then `git checkout -- <file>`.
- **Discard all** — click the discard-all button to run `git reset --hard HEAD` followed by `git clean -fd`. **This is destructive and cannot be undone.**

### Commit History (Log)

Click the **History** tab in the Source Control panel to see the last 50 commits as an ASCII graph (`git log --graph`). Each entry shows:
- Abbreviated commit hash
- Author name
- Date and relative time ("2 hours ago")
- Refs (branch/tag labels)
- Commit subject

---

## 8. Themes, Backgrounds and Appearance

### Appearance Modes

Three appearance modes are available in Settings > Appearance: `system`, `light`, and `dark`. The accent color is separate and adjustable; readable foregrounds are recalculated for the active surface.

### Preset Themes

Spacron ships with several built-in themes selectable from **Settings > Appearance > Theme**:

| Theme | Style |
|---|---|
| Default Dark | Dark background, muted accents |
| Default Light | Light background |
| Terax Dark | Deep dark with purple accents |

### Custom Theme Editor

The custom theme editor lets you edit any CSS custom property that drives the UI. Editable color fields include:

- Background layers (`--bg-primary`, `--bg-secondary`, `--bg-tertiary`, `--bg-hover`, `--bg-active`)
- Text colors (`--text-primary`, `--text-secondary`, `--text-muted`)
- Border colors (`--border`, `--border-subtle`)
- Accent and interactive colors (`--accent`, `--accent-hover`, `--accent-light`)
- Status colors (`--success`, `--warning`, `--error`, `--info`)
- Sidebar, titlebar, and editor backgrounds
- Terminal colors (foreground, background, and the full 16-color ANSI palette)

Changes are applied live as you type in the color pickers.

### Importing and Exporting Themes

- **Export** — saves the current custom theme as a JSON file via the system save dialog
- **Import** — loads a previously exported JSON theme file

The theme JSON file is a flat object mapping CSS variable names to color values.

### Background Wallpapers

Beyond color, you can set a **custom background image** (wallpaper) with an adjustable **blur**. Spacron dims it with two scrims rather than an opacity slider so text stays readable in both light and dark appearances. Custom wallpapers remain user-owned when you switch between built-in appearances.

### Interface Transparency (Frost)

A separate **Interface transparency** control applies a frosted-glass effect to panels so the wallpaper shows through subtly.

### Theme Persistence

Themes are stored in the platform config directory under `spacron/themes/`. The active theme name is persisted in app state. Custom themes are saved as JSON files in the same directory.

---

## 9. Keyboard Shortcuts

All shortcuts are configurable. The defaults are:

| Action | Default Shortcut | Category |
|---|---|---|
| Command Palette | `Ctrl+Shift+P` | View |
| Open Settings | `Ctrl+,` | View |
| Toggle Projects Sidebar | `Ctrl+K` | View |
| Toggle Sidebar | `Ctrl+B` | View |
| Switch Code / Chat Mode | `Ctrl+Shift+J` | Workspace |
| Create Project | `Ctrl+N` | Workspace |
| Open Folder | `Ctrl+O` | Workspace |
| New Terminal Tab | `Ctrl+Shift+\`` | Terminal |
| Go to Terminal | `Ctrl+\`` | View |
| Go to Editor | `Ctrl+E` | View |
| Go to Preview | `Ctrl+Shift+V` | View |
| Go to Code Review | `Ctrl+Shift+R` | View |
| Go to HTTP Client | `Ctrl+Shift+H` | View |
| Go to Tasks | `Ctrl+Shift+T` | View |
| Go to Agent Fleet | `Ctrl+Shift+G` | View |
| Go to Database Explorer | `Ctrl+Shift+B` | View |
| Go to Containers | `Ctrl+Shift+C` | View |
| Go to Dev Toolbox | `Ctrl+Shift+X` | View |
| Go to YouTube | `Ctrl+Shift+Y` | View |
| Search in Files | `Ctrl+Shift+F` | View |
| Environment Manager | `Ctrl+Shift+E` | View |
| Save File | `Ctrl+S` | File |
| Spawn Agents | `Ctrl+Shift+A` | Agent |
| Launch Voice Mode | `Ctrl+Shift+M` | Voice |
| Transcribe (speech to text) | `F9` | Voice |
| Format Document | `Alt+Shift+F` | Editor |
| Start Preview Proxy | `Ctrl+Alt+P` | Preview |
| Stop Preview Proxy | `Ctrl+Alt+O` | Preview |
| Cycle Ambient Layout | `Ctrl+Alt+A` | View |
| Zoom In | `Ctrl+=` | Window |
| Zoom Out | `Ctrl+-` | Window |
| Reset Zoom | `Ctrl+0` | Window |

### Contextual Shortcuts (not configurable)

| Keys | Action | Context |
|---|---|---|
| `Left Alt` (bare tap) | Toggle live voice | Anywhere in the app |
| `Ctrl+Enter` | Commit changes | Source Control commit message box |
| `F9` / `Escape` | End dictation and paste | While dictating |
| `Ctrl+Escape` | Discard dictation without pasting | While dictating |
| `Enter` | Confirm create or rename | Explorer / other modal inputs |
| `↑` / `↓` / `Enter` | Switch and confirm agent placement | Agent Placement dialog |
| `Escape` | Cancel create, rename, recording, or placement | Explorer inputs, dictation, dialogs |

### Customizing Shortcuts

Open Settings > Shortcuts. Click the binding for any action and press the key combination you want. The recorder listens for the next key event and saves it. Click **Reset to Defaults** to restore all defaults at once.

You can also add entirely new bindings for the same action by clicking the + button beside it.

---

## 10. Command Palette and Codebase Search

### Title Bar Search

The search box in the title bar doubles as the codebase search:

1. Click the search box (or press `Ctrl+Shift+P`)
2. Start typing — Spacron searches all text files in the active project with a 200 ms debounce
3. Results appear in a dropdown showing the relative file path, line number, and a snippet of the matching line
4. Click a result (or press `Enter` for the first one) to jump directly to that file and line in the editor

**Search limits:**
- Maximum 150 results returned
- Files larger than 10 MB are skipped
- Binary files (containing null bytes) are skipped
- The following directories are excluded: `.git`, `node_modules`, `dist`, `build`, `target`, `out`, `.svelte-kit`

### Command Palette

When no project is open, the title bar search filters the recent workspace list instead of searching code.

---

## 11. Agent Fleet & Orchestration

This is the heart of modern Spacron: a conversational **orchestrator** that can work on your project itself, and a **fleet** of agent CLIs (Claude Code, Codex, Cursor, Antigravity, Grok, OpenCode, Aider, and more) it can steer as a team.

### The orchestrator

The orchestrator is a conversation you open in Chat mode (or start a turn from the CLI workspace). It reads what you watch — the active file, your cursor, every open pane, the current branch, the task board — and answers questions about the whole deck with evidence. Hand it a goal and it:

1. **Plans** — splits the goal into 2–4 sub-tasks with **disjoint file sets**, shown live in a plan ticker (`update_todos`)
2. **Does small work itself** — it edits at most **3 project files per task** directly; anything larger is proposed as a handoff to an agent
3. **Delegates big work to agents** — never without your OK (an explicit request, naming a running agent, or a short answer to its own question)
4. **Verifies** — any project-file change must be followed by a verification command before the turn is accepted
5. **Reports** — a finished card with what changed, verification results, and the plan closure

### Approval cards

When the orchestrator wants to do something with side effects, it asks first with an **approval card**: **Approve**, **Decline**, or **Always allow … in this conversation**. Strictly read-only commands run without a card; anything with a redirect, a command substitution, braces, or a single `&` falls back to asking. Typing a reply instead of clicking reaches the running turn as "no, do this instead". Your decision is recorded on that operation's activity row.

### Undo

Files the orchestrator changed directly can be restored by saying **"undo"**. The record of what was changed is stored with the conversation, so the offer survives a restart.

### Where agents work: shared main repo or isolated worktrees

At spawn time Spacron asks **where each agent should run** — per agent, not per batch, so a mixed answer (one in the main repo, two isolated) is the normal case:

| Option | What it means |
|---|---|
| **Main repo** | Runs directly in the project root on your current branch. You see every edit immediately; `git tag` and `git push` work. This is the primary model. |
| **Isolated worktree** | Its own branch off HEAD in a separate folder under `.spacron/worktrees/`. Safe for parallel agents, but edits stay out of the main checkout until you merge. |

In **main-repo mode** several agents and you all share one working tree, so Spacron gives every agent an explicit instruction **not to touch each other** — four layers:

1. **Standing brief** — every agent receives a charter/rules file whose scope rule says *do only your task, never undo another agent's or the user's work*, and whose git rule says *never revert changes that aren't yours — commit only the files you changed* (shared-checkout wording: "touch only your files, never revert anyone else's").
2. **Disjoint file sets** — the orchestrator brief forces the planner to split a goal into sub-tasks with *disjoint* file sets and "keep file sets disjoint".
3. **Roles** — the Coordinator role must *"sequence shared work so two agents never own the same file at once"*, and a Builder must *"implement your ONE sub-task only, state up front which files you will change"*.
4. **Mailbox file-claims** — each builder posts a **claim** naming its files to the shared project mailbox; the orchestrator refuses to dispatch any task whose files overlap a live claim, and a finished task releases its claim.

### The fleet dashboard

The **Agent Fleet** panel (`Ctrl+Shift+G`) tiles every running agent as a live card: its CLI and name, its worktree branch, live terminal output, and current state (planning, working, awaiting review, bounced back). "Tile all agents" turns the whole stage into the fleet grid and back.

### Agent work and review

- **Worktrees** — agents placed in a worktree run on their own branch under `.spacron/worktrees/`; their work is staged onto that branch and reviewed before anything reaches `main`.
- **Review gate** — a Reviewer role (or the manual Code Review flow) inspects the diff (`git diff main..<branch>`), runs the project tests, and either says `APPROVED <branch>` (auto-approves and merges) or bounces the work back with required fixes.
- **Agent changes list** — per-agent diff summaries that you can review and selectively accept.
- **Mailbox cards** — agents post `report`, `handoff`, and `ask` messages to a shared per-project mailbox; actionable ones surface in a "Needs you" strip with **Approve / Reply / Dismiss**. Approving tells the sender to proceed; replying delivers your words straight into its live prompt. Handoffs to a Reviewer need no user relay.

### Roles

When the orchestrator plans a goal it assigns each agent a role-charter:

| Role | Charter |
|---|---|
| **Coordinator** | Split the goal into ordered sub-tasks and assign them; sequence shared work so two agents never own the same file at once |
| **Builder** | Implement your ONE sub-task only; state up front which files you will change (your claim) |
| **Scout** | Read-only recon — explore and report (paths, structure, risks) without editing |
| **Reviewer** | Gate the handoff you are given — inspect the diff, run the tests, approve or bounce back |

Roles sit alongside personality: every agent still has a name.

### Orchestration memory & knowledge graph

- **Memory log** — Spacron keeps a per-project log of finished task outcomes (≤40 one-line notes) and injects the top ones into the orchestrator's context, so what one turn learned the next one starts with.
- **Knowledge graph** — agents can author wikilinked markdown notes under `.spacron/memory/*.md`; a graph view (`Memory Graph…` from the palette) visualizes the notes and their `[[wikilinks]]` with a deterministic force layout.

### Skills and app commands

- **Skills** — Settings > Orchestrator toggles built-in skills off (security, engineering, debugging, review, git) and lets you add your own freeform skill/playbook instructions, injected into the orchestrator's system prompt every turn.
- **App commands** — the orchestrator can list and run any command-palette command (`list_app_commands` / `run_app_command`). Commands whose ids or names mark them as **risky** always need your approval, in every access mode — Full access included.

### Your own MCP servers

Settings > MCP lets you add MCP servers, which Spacron writes into all agent CLI configs. Every entry Spacron writes is prefixed `spacron-`, and writes reconcile that namespace rather than only adding — a server you renamed or removed is cleaned up, and anything you wrote into those configs by hand is never touched.

### Agent providers and brains

- **Sign in with ChatGPT** — the orchestrator can run on your ChatGPT plan through the Codex CLI (`codex app-server`), so no API key is needed. Each turn is a new, temporary, read-only thread, and the orchestrator's own tool loop and approval cards stay in charge of anything that changes your project.
- **Kilo Code (free models)** — a free Kilo account key unlocks its `:free` models over the AI connections.
- **API-key providers** — OpenAI, Anthropic, Google, OpenRouter, xAI, and other providers connect by API key (or local server URL), with live model discovery where the provider exposes its models.
- **DeepSeek Harness** — the `dsh` CLI runs as an agent, headless or as a web panel inside Spacron, connected to Spacron's MCP server.
- **Per-agent launch settings** — the spawn/placement dialogs show a model and reasoning-effort picker filled from the installed CLI's own live model list; nothing is pre-listed and unsupported levels are disabled.
- **Agent failover** — when an agent is close to running out of usage, Spacron can hand its work to a successor (first another signed-in account of the same CLI, then a different CLI), switching at roughly 3–5% headroom, reusing the same task, worktree, and branch, and handing the successor a handover brief. The old agent's loose edits are committed onto its own branch first.
- **Stay awake** — Settings > Agents > "Stay awake while agents work" uses a power-management hold so the machine doesn't sleep mid-run.

### Agents are optional

Everything in this section is opt-in. You never have to spawn an agent or talk to the orchestrator — the rest of Spacron works exactly the same without them. See [Doing It Yourself](#18-doing-it-yourself).

---

## 12. Chat Workspace Mode

Spacron has two workspace modes, switched with `Ctrl+Shift+J` or the left-rail control: **Code mode** (the CLI workspace described above) and **Chat mode**.

### Chat mode

A full-panel, thread-aware workspace for working with your AI providers without leaving the project shell:

- **Persistent threads** — create, restore, rename, select, and delete conversation threads with durable local state. Threads are scoped per project, and follow-ups stay attached to the conversation that created them.
- **Composer** — send prompts typed or dictated, choose the provider and live model per thread, attach images (including generated ones, for edits or as reference), and see streaming replies.
- **Concurrent prompts & input requests** — keep multiple prompts in flight and surface agent requests for input inside the composer, so a workflow can pause for an answer without losing the conversation.
- **Live ticker** — the current turn's plan (`update_todos`) is rendered live above the composer.
- **Thread-aware follow-ups** — a follow-up message goes to the selected thread and keeps the conversation's history and routing.
- **Grouped tool calls** — a run of tool calls in an agent's turn renders as one expandable card (count, live status, last call), not one row per notification.
- **ACP agents** — ACP-capable commands (installable from Settings → Agents → ACP Registry) run a native ACP session inside the thread: streamed replies, one live row per tool call, and approval cards answered in place. In the same pane any other local command — a preset like Claude Code or Antigravity, or an agent you added by hand — can be declared ACP with its switch, and Chat then drives it the same way instead of dispatching it as a terminal task.

The orchestrator's conversation lives here too: Chat mode is where you steer the fleet, approve cards, and review each agent's turn.

---

## 13. Voice & Speech

Spacron is fully voice-driven. There are two distinct speech paths:

### Live voice conversation (speech ⇄ text/brain)

- **Start it anywhere with a bare tap of left Alt** (press and release; cancelled by any modifier or other key). `Ctrl+Shift+M` is a second, explicit entry point.
- Uses a **realtime** speech engine — OpenAI Realtime over WebRTC, or xAI Grok Realtime over WebSocket — where the model owns the mic and speaks directly. Barge-in (interrupting the model) is handled server-side.
- Voice turns go through the same orchestrator as typed messages, with the same approval cards, plan ticker, and activity log.
- Engine and voice selection live in Settings > Voice > Conversation engine.

### Dictation / transcription (speech-to-text only)

Press **`F9`** to dictate. Speak for as long as you like (pauses do **not** end it), then press `F9` or `Escape` to deliver everything at once. `Ctrl+Escape` discards without pasting. Unlike voice mode, dictation never speaks anything back.

Delivery targets the **box you interact with**: a focused text field (including fields inside dialogs), the active terminal, or an editable field inside the preview — the field you click last is the field it lands in.

Quality features:

- **Smart voice detection** (off by default) — a local Silero VAD model replaces the simple RMS gate for turning detection
- **Voice refinement** (on by default) — transcript cleanup strips fillers; text-field dictation additionally gets an AI polish pass. **Terminals are never reworded** — shell commands stay verbatim.
- **Custom vocabulary** — a comma-separated list in Settings > Voice that both the polish pass and the speech-recognition layer use (the hotword trick that fixes names speech models mangle). Editor symbols are also merged into the recognizer's bias automatically.
- **Voice history** — a durable log of what you dictated.

### The floating prompt bar

The bar is the voice-first composer strip at the bottom of the terminal area and the host of the Tools menu. See [Floating Prompt Bar](#5-floating-prompt-bar).

---

## 14. Image & Video Generation

The orchestrator (or you, via the chat composer) can generate images and videos into `<project>/generations`.

### Provider fallback

Generation tries, in order:
1. Your **ChatGPT plan** through the Codex CLI (images only)
2. API-key providers: **OpenAI (incl. DALL·E / Sora), Google (Veo), OpenRouter, fal, Replicate**

On quota, auth, or missing-key errors it falls back to the next provider and reports what each one said if none works.

### Image viewer

Generated images open in an image viewer offering:
- **Save** — copy the file somewhere of your choice
- **Show in folder** — reveal it in the OS file manager
- **Use as input** — attach it to the next message as reference
- **Edit** — painted-mask edits (restyle, change, or combine images you attach)

Generated and pasted images render inline in the chat; only ones marked `generated` survive a restart (pasted paths live in a temp folder).

---

## 15. Remote Workspace

Run Spacron in the interactive-remote model: the **workspace** (files, terminals, LSP, git, agents) lives on a box you own (a VPS / cloud VM / home server), and the app on your laptop is a thin client that attaches to it.

- **Your box, your keys** — Spacron connects to a machine you provide; it never provisions or bills for servers.
- **Live connection, remote is the source of truth** — files and processes live on the box full-time, so any client that reconnects sees the same state. Close the laptop, reopen anywhere, reconnect — the workspace is still there, mid-state.
- **Networking over Tailscale** (or SSH tunnel) — no port-forwarding, no publicly exposed daemon.
- **Saved connections** — add as many remotes as you like; the token lives in the OS keychain, never in localStorage. **Opt-in auto-reconnect on startup** brings a workspace whose agents are still running on the box back on its own.
- **Remote Setup Wizard** — walks you through key generation, `spacron-server` download for the target OS, and the daemon install on the box.
- The whole app — terminals, editor, preview proxy, agents, git — operates on the remote machine through a single connection, and flips back to Local instantly when you switch.

Status is shown in the title bar; a dropped socket (sleep/network blip) backs off and reconnects automatically.

---

## 16. Mobile Emulator

Drive a mobile device from inside Spacron — no separate adb window needed.

- **Boot** a phone AVD; the panel streams the device screen in real time (MJPEG or scrcpy).
- **Interact** with normalized tap, swipe, text-entry, and hardware-key input, mapped to the device's real pixel coordinates.
- **Rotate** the device; flex between phone, tablet, foldable, and Wear OS form factors as needed.
- **iOS simulators** are supported as view-only mirrors (streaming or polled screenshots) with a rotate control.
- **Auto-focus** — newly booted devices appear in the panel; serial selection is remembered.
- The orchestrator can also drive the same emulator through its tools (boot, screenshot, tap, swipe, type, rotate) using the exact same MCP handlers the CLI agents use, so coordinates and target checks behave identically whichever one drives.

---

## 17. Tool Rooms

The right dock and the Tools menu (`Tools` trigger on the prompt bar) open one-click utility rooms:

| Room | Shortcut | What it does |
|---|---|---|
| **Agent Fleet** | `Ctrl+Shift+G` | Live cards for every running agent, tiling and review — see [Agent Fleet & Orchestration](#11-agent-fleet--orchestration) |
| **HTTP Client** | `Ctrl+Shift+H` | Build and send HTTP requests (GET/POST/PUT/PATCH/DELETE/HEAD/OPTIONS) with headers, JSON/text/form bodies, and auth; saved requests per project; shows status, size, and timing; blocks private-network targets |
| **Database Explorer** | `Ctrl+Shift+B` | Open a SQLite database, browse tables, and run queries. Read-only queries run freely; destructive statements (DROP/TRUNCATE/table-wide DELETE or UPDATE) are blocked behind an explicit warning |
| **Containers** | `Ctrl+Shift+C` | Docker command launcher: check Docker/Compose, compose up/down, list containers, open logs, and more — run in the terminal with one click |
| **Dev Toolbox** | `Ctrl+Shift+X` | Developer utilities: JWT decode, JSON format/validate, regex tester, epoch/date converter, coder text helpers, plus the **Embedded panel** for quick embedded commands and probes |
| **Media Player** | `Ctrl+Shift+Y` | A free-floating media window — e.g. a YouTube panel for watch-along while working |
| **Environment Manager** | `Ctrl+Shift+E` | Inspect and edit environment variables for the active project/session |
| **Mobile Emulator** | — | The device-driving panel, see [Mobile Emulator](#16-mobile-emulator) |
| **Code Review** | `Ctrl+Shift+R` | Review agent changes and uncommitted work: per-agent diffs, test gate, approve/merge or bounce back |
| **Tasks** | `Ctrl+Shift+T` | A simple agenda scoped to the current project — create, check off, reorder, delete |
| **Sketch** | — | A full canvas sketch surface (its own room) with drawing tools |
| **DeepSeek Harness** | — | The `dsh` agent's web panel, embedded as a room |
| **Problems** | — | Diagnostics/errors panel fed by the LSP (and project checks) |
| **Project Snapshots** | — | Capture the current project state (open files, editor positions, terminal layout, preview state) and restore it with one click |

Room tiles in the stage can be dragged, zoomed to full stage, minimized, and reordered; the stage supports Focus / Development / Gallery (split) / Vibe / Preview ambient layouts (`Ctrl+Alt+A` cycles them).

---

## 18. Doing It Yourself

Spacron is **manual-first by design**. Every automated capability has a plain hand path, and nothing forces itself on you:

| Automated path | Do it yourself instead |
|---|---|
| Orchestrator edits 3 files directly | Edit them in the CodeMirror editor and save (`Ctrl+S`) |
| Orchestrator delegates a goal to an agent | Run the same commands yourself in the terminal and build it by hand |
| Agent commits work to a branch | Commit from the Source Control panel (`Ctrl+Enter`) |
| Orchestrator verifies after changes | Run your test suite yourself in the terminal |
| Orchestrator generates an image/video | Use any tool from your own terminal; the `<project>/generations` folder is just a normal folder (or generate from the chat composer manually) |
| Agent boots and taps an emulator | Open the Mobile Emulator tool and drive it yourself |
| Voice types for you | Type with your keyboard |
| The orchestrator answers questions about your project | Use Command Palette search and read the files yourself |

The guarantees behind it:

- **Nothing runs without your say-so.** Approval cards appear before anything risky; a spawned agent proposal is always a choice, never a quiet launch. Full access mode still requires your approval for risky app commands.
- **You can always stop it.** Every agent turn can be interrupted, every queued or running command cancelled, and agent worktrees reclaimed safely on close.
- **Using AI is entirely optional.** No feature depends on it: you can use Spacron as a plain terminal + editor + preview + git workspace with zero AI connections configured, and nothing you would expect from those classic surfaces is missing.
- **Your work stays yours.** Direct orchestrator edits can be undone ("undo"), and agent work sits on branches you review and merge yourself.

---

## 19. Settings

Open with `Ctrl+,` or the gear icon in the title bar. The settings modal has eleven tabs, and its search box finds settings by name as you type.

| Tab | Covers |
|---|---|
| **General** | Editor font/size/tab/word-wrap, minimap, Vim mode, hidden files, format-on-save, auto-save, notifications, snapshots tab |
| **Appearance** | Light/dark/system appearance, accent color, UI zoom, UI font size, theme presets + custom theme editor, wallpaper and blur, interface transparency |
| **Models** | AI provider connections & API keys (incl. ChatGPT sign-in), live model lists, ghost-text inline completion, image & video generation, local speech-to-text models |
| **Voice** | Voice input, smart voice detection (VAD), voice refinement + custom vocabulary, conversation engine (OpenAI/xAI realtime) |
| **Terminal** | Shell override, font size, cursor style, renderer, scrollback lines |
| **Agents** | Isolate agents in worktrees, auto-stage agent changes, stay awake while agents work, browser tools, coding-CLI catalogue & custom agents |
| **Orchestrator** | Built-in skills (toggle per skill), your custom skills, "what it has learned" |
| **MCP** | Built-in servers (Spacron, Playwright browser tools) + your own MCP servers, written into all agent CLI configs |
| **Stats** | Usage meters and statistics |
| **Shortcuts** | Every configurable binding + the custom navigation shortcuts |
| **About** | Version, check for updates, factory reset |

---

## 20. UI Zoom and Scaling

Spacron supports global UI scaling via the CSS `zoom` property applied to the main content wrapper.

| Action | Shortcut | Description |
|---|---|---|
| Zoom in | `Ctrl+=` | Increases zoom by 10% |
| Zoom out | `Ctrl+-` | Decreases zoom by 10% |
| Reset zoom | `Ctrl+0` | Returns zoom to 100% |

**Range:** 50% – 200% (enforced by the slider in Settings > General).

Zoom affects the layout engine: at higher zoom levels the sidebar will auto-collapse sooner (to avoid overflow), and the auxiliary panel width is clamped to prevent it from exceeding the available space. The **UI font size** is a separate control so scaling the interface doesn't distort the editor or terminal text size.

The current zoom level is stored in `localStorage` and restored on next launch.

---

## 21. State Persistence

Spacron persists a significant amount of state across sessions using `localStorage`. All keys are prefixed with `forge_setting_` (settings) or `forge_ws_` (workspace state) or `spacron_layout` (layout).

### Persisted Settings

All values in the Settings modal (font, tab size, vim mode, shortcuts, theme selection, appearance, background, terminal options, notifications, zoom level, etc.) are persisted individually under `forge_setting_<key>`.

### Persisted Layout

The full layout state (`spacron_layout`) includes:
- Sidebar visibility and width
- Active view and split mode
- Editor/preview split mode
- Project snapshots tab visibility

### Persisted Workspace State

Per-workspace state is stored under `forge_ws_<key>`:
- Active workspace ID
- Recent workspaces list (name, project paths, last-opened timestamp)
- Open project IDs within each workspace

### Per-Project State

When you switch away from a project, Spacron snapshots and restores:
- Open files and active file in the editor
- Active line and column position
- Terminal session count, grid layout, and pane assignments
- Preview proxy state (target port, proxy port, current URL, preferred host)
- File explorer expanded paths and selected path

### Chat Threads

Chat conversations are persisted per project with durable local state, including each thread's provider/model selection.

### Secrets Never Persisted

Remote workspace tokens live in the OS keychain, not localStorage. AI API keys are cached in session memory and read from the keychain. Password-like values are never written to disk in plaintext.

---

## 22. Notifications

Spacron shows two kinds of notifications:

### In-App Toasts

Toast notifications appear in the bottom-right corner. They are categorized:

| Type | Default Duration | Color |
|---|---|---|
| Info | 3 s | Blue |
| Success | 3 s | Green |
| Warning | 3 s | Amber |
| Error | 6 s | Red |

Duplicate toasts (same message + type) are suppressed while a matching toast is already visible.

Toasts can have an action button (e.g., "Open File") that triggers a callback when clicked.

### Agent & Inbox Notifications

Agent turns notify you through the **Inbox** (spacron inbox panel with unread/dismissed states) and small floating cards, with events like terminal exit and agent completion also triggering OS-level desktop notifications. Email-style agent activity is surfaced even when an agent is tucked away in a panel.

### Desktop Notifications

Some events (terminal exit, agent completion) also trigger OS-level desktop notifications, provided:
1. The **Notifications** setting is enabled (default: on)
2. The browser/WebView has been granted notification permission

Spacron requests notification permission on startup.