# Spacron

<p align="center">
  <img src="static/icon.png" width="80" height="80" alt="Spacron Logo"><br>
  <strong>One workspace. One goal. A fleet of agents that builds it.</strong>
</p>

<p align="center">
  <a href="LICENSE"><img src="https://img.shields.io/badge/License-Proprietary-red" alt="License"></a>
  <img src="https://img.shields.io/badge/Tauri-2-blue?logo=tauri" alt="Tauri">
  <img src="https://img.shields.io/badge/Rust-2021-orange?logo=rust" alt="Rust">
  <img src="https://img.shields.io/badge/React-19-blue?logo=react" alt="React">
  <img src="https://img.shields.io/badge/TypeScript-5.6-blue?logo=typescript" alt="TypeScript">
</p>

Spacron is a cross-platform desktop workspace that combines a real PTY terminal grid, a CodeMirror code editor, a hot-reloading web preview proxy, git integration, and a **conversational agent fleet** — all unified inside a single keyboard- and voice-driven window. Tell the orchestrator your goal and it reads your project, makes small direct edits itself (up to 3 files per task), and delegates larger work to coding CLIs (Claude Code, Codex, Cursor, OpenCode, Muse, and more) over explicit approval cards you accept or decline. Built with Tauri 2 (Rust) and React, it stays lean: no Electron, no Node.js runtime, sub-second startup.

**You are always in control.** Every automated action — an orchestrator edit, a spawned agent, an approval card, a generation — has a plain manual path. Agent work sits on branches you review yourself, nothing runs without your say-so, and all of the classic terminal/editor/preview/git features work exactly the same with zero AI connections configured. See **[Doing It Yourself](docs/FEATURES.md#18-doing-it-yourself)**.

---

## ⚡ Key Features

- **Agent Fleet & Orchestration** — A conversational orchestrator that reads your whole project. You hand it a goal and it: (1) plans the work into sub-tasks shown on a live plan ticker, (2) edits at most 3 project files itself per task, (3) proposes larger work as an agent hand-off that you must explicitly approve before anything starts, and (4) runs project verification (tests, typecheck, lint, build) after any file change before accepting the turn. Agents (Claude Code, Codex, Cursor, Antigravity, Grok, OpenCode, Muse, and more) run live as fleet tiles with review gates. Agent work lands on isolated branches you review yourself — nothing reaches `main` without your approval.
- **Native agent adapters** — Claude Code (`claude_chat_complete`), Codex (`chatgpt_chat_complete`), Cursor (`cursor_chat_complete`), OpenCode (`opencode_chat_complete`), and Muse (`muse_chat_complete`) all run through Tauri commands on the Rust side, spawning the user's own CLI. Each captures session IDs for resume, supports `--fork-session` for context handover, and never sees or stores API keys — the user's own CLI auth is used directly.
- **Hands-off the shared tree** — When several agents work alongside you in the same repo, a standing charter, disjoint file sets, coordinator sequencing, and mailbox file-claims keep them from clobbering each other — never revert changes that aren't yours, commit only the files you changed.
- **Voice-driven everything** — Tap **left Alt** anywhere for a live speech↔speech conversation; press **F9** to dictate into any field (terminals stay verbatim); the floating prompt bar is voice-first with staged prompts and file drag-and-drop.
- **Generations** — Images and videos generate into `<project>/generations` on your ChatGPT plan or your own API keys (OpenAI, Google/Veo, OpenRouter, fal, Replicate), with an inline image viewer and paint-masked edits.
- **Remote Workspace** — Attach Spacron to your own VPS/VM over Tailscale or SSH: the workspace (files, terminals, agents) lives on your box and reconnects mid-state from anywhere. No provisioned servers.
- **Mobile Emulator** — Boot an Android phone AVD (or iOS simulator) and drive it with tap/swipe/type/rotate from the panel — no adb window needed.
- **Terminal Grid** — Full PTY shell sessions (xterm.js), layouts from single to 9-grid, automatic per-platform shell detection, session roles, command blocks, and working-directory tracking.
- **Editor & Preview** — CodeMirror 6 with 15+ languages, Vim mode, minimap, format-on-save; a live dev-server preview proxy with WebSocket support, device viewports, a DOM inspector, and an in-panel console.
- **Tool Rooms** — One-click rooms for the HTTP client, SQLite database explorer, Docker containers, dev toolbox (JWT/JSON/regex/epoch/coder), environment manager, media player, sketch canvas, and project snapshots.
- **Source Control (multi-provider)** — Choose GitHub, GitLab, Bitbucket, or Other (PAT-only) as your provider. GitHub supports OAuth device flow and gh CLI import; GitLab/Bitbucket/Other accept a personal access token saved to the OS keychain per provider. Sign in once per provider to clone private repos and publish PRs without pasting a token every time.
- **Git Integration** — Diff, commit, push, discard, and ASCII commit history, all from the sidebar.
- **Chat Workspace Mode** (`Ctrl+Shift+J`) — Thread-aware conversations per project: persistent threads with durable state, composer with provider/model selection, streaming replies, live plan ticker, inline approval cards, concurrent prompts, and input requests. Threads can be forked with their agent session context carried over.
- **Isolated worktrees per agent/thread** — Each agent gets its own git worktree on its own branch off HEAD, under `.spacron/worktrees/`. Work is staged onto the branch and reviewed before anything reaches `main`. Main-repo mode keeps agents in the shared checkout with explicit no-touch-each-other rules.

---

## 📦 Installation

Download the latest build for your platform from the **[official website](https://spacron.app)**.

### Windows
Run the `.exe` setup installer: `x64-setup.exe` for Intel/AMD PCs, `arm64-setup.exe` for Windows on ARM (Snapdragon and other ARM laptops).

### macOS
Open the Apple Silicon `.dmg` disk image and drag Spacron into Applications.

### Linux
Download the `.AppImage`, make it executable, and run it:
```bash
chmod +x Spacron_x86_64.AppImage
./Spacron_x86_64.AppImage
```

Spacron renders through the system WebKitGTK, which plays video/audio via GStreamer. For the YouTube panel (and other media playback) install the codec packages if your distro doesn't ship them:

```bash
# Ubuntu / Debian
sudo apt install gstreamer1.0-plugins-good gstreamer1.0-plugins-bad gstreamer1.0-libav

# Fedora
sudo dnf install gstreamer1-plugins-good gstreamer1-plugins-bad-free gstreamer1-libav

# Arch
sudo pacman -S gst-plugins-good gst-plugins-bad gst-libav
```

Spacron ships **signed auto-updates**, so it keeps itself current after install.

---

## 🚀 Quick Start

1. **Open Spacron.** Use it however you like — type, dictate (tap **left Alt** for a live conversation, **F9** to transcribe), or just use your keyboard.
2. **Create a Workspace** (`Ctrl+N`) or open an existing code directory (`Ctrl+O`).
3. **Launch your Dev Server** inside the terminal (e.g., `npm run dev`).
4. **Activate the Preview Proxy** (`Ctrl+Alt+P`) to launch the live preview split pane with the DOM Inspector.
5. **Inspect elements** inside the preview and edit code in CodeMirror side-by-side.
6. **Commit & Push** changes directly from the Git integration in the sidebar.
7. **Bring in the fleet when you want it** — press `Ctrl+Shift+A` to spawn agents, or open the orchestrator, tell it your goal, and approve the plan. Or skip all of it: everything above is fully manual.

> Want the full surface area? Read **[docs/FEATURES.md](docs/FEATURES.md)** — it documents every user-facing feature, including the **Doing It Yourself** section that maps each automated action to its manual equivalent.

---

## 🤖 What the orchestrator actually does

Spacron's orchestrator is a conversation you open in **Chat mode** (`Ctrl+Shift+J`) or start from the CLI workspace. It is gated by your approval at every step — nothing runs without your say-so. Here is the exact flow:

### 1. You tell it a goal
Type or dictate a goal in the composer (`Ctrl+Shift+J`, or `F9` for dictation). The orchestrator reads your project's active files, open panes, current branch, and task board for context.

### 2. It plans and does small work itself
The orchestrator establishes a todo list (3–6 items) on a live plan ticker. For small changes — at most **3 project files per task** — it edits directly using `edit_file`/`write_file`, then runs the project's verification command (tests, typecheck, lint, or build) and reports the real result. If verification fails, it reports the failure rather than silently proceeding.

### 3. Big work requires your explicit approval
Work that needs more than 3 files (a new feature, module, refactor, or cross-cutting change) is **not** done by the orchestrator itself. Instead it produces a detailed agent brief (goal, context, requirements, constraints, acceptance criteria, verification steps) as a **delegation proposal**. The app shows you an approval card:
- **Approve once** — run this hand-off
- **Always allow** — run this kind of hand-off without re-asking in this conversation
- **Deny / type a reply** — "no, do this instead", delivered to the running turn as a steer

Only after you approve does the orchestrator spawn the agent (Claude Code, Codex, Cursor, OpenCode, Muse, etc.) on an isolated `thread/<slug>-<short>` worktree branch.

### 4. Agent work is reviewed before merging
The agent works in its own checkout under `.spacron/worktrees/`. When finished, its changes are staged onto its branch. You review the diff (`git diff main..<branch>`), run tests, then commit in Source Control. Nothing reaches `main` without your explicit commit.

### 5. Turn-completion reporting
A finished turn produces a card with what changed, verification results, and plan closure. You can undo orchestrator edits ("undo" restores files changed directly by the orchestrator, surviving restarts).

### Approval gates everywhere
Every operation with side effects raises an approval card first: file writes, shell commands with redirects/substitutions/braces/`, agent spawns, PR creation, generations. Strictly read-only commands run without a card. You can always decline or redirect.

### Agents are optional
You never have to spawn an agent or talk to the orchestrator — the terminal, editor, preview, and git all work exactly the same with zero AI connections configured.

| Feature | Spacron | VS Code | Warp |
|---|---|---|---|
| **Startup Speed** | **Sub-second (Native)** | 3–5 seconds | Fast |
| **Workspace Shell** | **Tauri 2 (Rust)** | Electron (Node) | Native (Rust) |
| **Agent Fleet & Orchestration** | **Yes (in shared repo)** | Extensions | No |
| **Native agent adapters** | **Claude, Codex, Cursor, OpenCode, Muse** | No | No |
| **Per-provider source control sign-in** | **GitHub / GitLab / Bitbucket / Other** | Extensions | No |
| **Isolated agent worktrees** | **Yes, per agent/thread** | No | No |
| **Voice Control** | **Yes (realtime + dictation)** | No | No |
| **Multi-pane PTY** | **Yes** | Integrated Tab | Primary focus |
| **Code Editor** | **CodeMirror 6** | Monaco Editor | None |
| **Port Preview Proxy** | **Yes + DOM Inspector** | Requires extension | None |
| **Resource Memory** | **~40–80 MB** | ~400–800+ MB | ~150–350 MB |

---

## 🛠️ Build from Source

For detailed instructions on setting up MSVC compiler tools, Apple signing certificates, or Linux webkit libraries, read **[docs/BUILDING.md](docs/BUILDING.md)**.

```bash
git clone https://github.com/Samuel00098/spacron.git
cd spacron
npm install
npm run tauri dev
```

---

## 🌳 Isolated Worktrees in Chat Mode

When a chat thread dispatches work to an agent (Claude Code, Codex, Cursor, OpenCode, Muse, or any registered CLI), Spacron gives that agent its own **isolated git worktree** by default:

1. **Branch off HEAD** — A new branch (`thread/<slug>-<short id>`) is created from the project's current HEAD commit.
2. **Separate checkout** — The worktree lives inside the project at `.spacron/worktrees/<branch>`, keeping its own files, index, and working directory while sharing Git history with the main checkout.
3. **Agent cwd follows** — The agent's terminal and every tool call run inside the isolated worktree path, so the agent never sees or touches files outside its own branch.
4. **No shared-tree collisions** — Parallel agents and the user can all edit simultaneously without overwriting each other, because each writes to its own checkout.
5. **Review before merge** — When the agent finishes, its work is staged onto its own branch. The user reviews the diff (`git diff main..<branch>`), runs tests, then commits in Source Control — nothing reaches `main` without explicit approval.

### Chat mode vs T3 Code

| Aspect | T3 Code | Spacron Chat mode |
|---|---|---|
| **Worktree creation** | Per-thread, isolated checkout | Per-thread, isolated worktree off HEAD |
| **Branch naming** | Thread-scoped | `thread/<slug>-<short id>`, stable per thread; renamed Orca-style from first real work when possible |
| **Context handover** | Separate thread with session fork | `forkChatThreadFrom` + `claude --fork-session` carries the agent session into the forked thread |
| **Where work lands** | Stay in thread until user merges | Staged onto agent branch, reviewed, then committed by user |
| **Cleanup** | Thread thread closes → worktree removed | `reclaimWorktree` stages pending work first, only removes when nothing is left unstaged |
| **Main-repo option** | Yes | Yes — agents can run directly in the project root when isolation is skipped |

This is **aligned with T3 Code**: both use separate threads/sessions with explicit context handover rather than mixing sub-agent turns into the same thread. Spacron carries over forked Claude sessions (and cursor/opencode/muse session IDs) so a forked thread resumes the source agent's conversation natively via `--resume`.

---

## ⌨️ Shortcut Cheat Sheet

Below are Spacron's default keyboard shortcuts. You can customize them in the settings panel (`Ctrl+,`).

| Command | Shortcut | Category |
|---|---|---|
| **Command Palette** | `Ctrl+Shift+P` | View |
| **Open Settings** | `Ctrl+,` | View |
| **New Workspace** | `Ctrl+N` | Workspace |
| **Open Folder** | `Ctrl+O` | Workspace |
| **Toggle Sidebar** | `Ctrl+B` | View |
| **Toggle Projects** | `Ctrl+K` | View |
| **Switch Code / Chat Mode** | `Ctrl+Shift+J` | Workspace |
| **Go to Terminal** | `Ctrl+`` ` ` | View |
| **Go to Editor** | `Ctrl+E` | View |
| **Go to Preview** | `Ctrl+Shift+V` | View |
| **Go to Agent Fleet** | `Ctrl+Shift+G` | View |
| **Go to HTTP Client** | `Ctrl+Shift+H` | View |
| **Go to Database** | `Ctrl+Shift+B` | View |
| **Go to Containers** | `Ctrl+Shift+C` | View |
| **Go to Dev Toolbox** | `Ctrl+Shift+X` | View |
| **Environment Manager** | `Ctrl+Shift+E` | View |
| **Tasks** | `Ctrl+Shift+T` | View |
| **Search in Files** | `Ctrl+Shift+F` | View |
| **Save File** | `Ctrl+S` | File |
| **New Terminal Tab** | `Ctrl+Shift+`` ` | Terminal |
| **Spawn Agents** | `Ctrl+Shift+A` | Agent |
| **Launch Voice Mode** | `Ctrl+Shift+M` | Voice |
| **Transcribe (dictation)** | `F9` | Voice |
| **Start Preview Proxy** | `Ctrl+Alt+P` | Preview |
| **Format Document** | `Alt+Shift+F` | Editor |

---

## 📊 Feature Comparison

| Feature | Spacron | VS Code | Warp |
|---|---|---|---|
| **Startup Speed** | **Sub-second (Native)** | 3–5 seconds | Fast |
| **Workspace Shell** | **Tauri 2 (Rust)** | Electron (Node) | Native (Rust) |
| **Agent Fleet & Orchestration** | **Yes (approval-gated)** | Extensions | No |
| **Native agent adapters** | **Claude, Codex, Cursor, OpenCode, Muse** | No | No |
| **Per-provider source control sign-in** | **GitHub / GitLab / Bitbucket / Other** | Extensions | No |
| **Isolated agent worktrees** | **Yes, per agent/thread** | No | No |
| **Voice Control** | **Yes (realtime + dictation)** | No | No |
| **Multi-pane PTY** | **Yes** | Integrated Tab | Primary focus |
| **Code Editor** | **CodeMirror 6** | Monaco Editor | None |
| **Port Preview Proxy** | **Yes + DOM Inspector** | Requires extension | None |
| **Resource Memory** | **~40–80 MB** | ~400–800+ MB | ~150–350 MB |

---

## 📄 License

Spacron is **proprietary software**. All rights reserved — see the [LICENSE](LICENSE) file for the full terms. The source code may not be copied, modified, or redistributed without written permission.

Copyright © 2026 Samuel Solesi
