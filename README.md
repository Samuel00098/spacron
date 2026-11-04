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

Spacron is a cross-platform desktop workspace that combines a real PTY terminal grid, a CodeMirror code editor, a hot-reloading web preview proxy, git integration, and a **direct agent fleet** — all unified inside a single keyboard- and voice-driven window. Open Chat mode (`Ctrl+Shift+J`), pick an agent (Claude Code, Codex, Cursor, OpenCode, Muse, Pi, or any registered ACP agent), and talk to it directly. Your message goes to the agent; the agent's reply streams back. Built with Tauri 2 (Rust) and React, it stays lean: no Electron, no Node.js runtime, sub-second startup.

**You are always in control.** Everything works exactly the same with zero AI connections configured — terminal, editor, preview, and git are all fully manual. When you do use agents, each one runs through your own CLI with your own auth; Spacron never sees or stores API keys. See **[Doing It Yourself](docs/FEATURES.md#18-doing-it-yourself)**.

---

## ⚡ Key Features

- **Agent Fleet & Direct Access** — Open Chat mode (`Ctrl+Shift+J`), pick an agent (Claude Code, Codex, Cursor, OpenCode, Muse, Pi, or any registered ACP agent), and talk to it directly. Your message is the agent's prompt; the agent's own streamed reply is the response. There is no planner, no approval gate, and no supervision layer between you and the agent — if you want those, run agents from the terminal instead. Agents run as live tiles through your own CLI; nothing reaches `main` without your explicit commit.
- **Native agent adapters** — Claude Code (`claude_chat_complete`), Codex (`chatgpt_chat_complete`), Cursor (`cursor_chat_complete`), OpenCode (`opencode_chat_complete`), and Muse (`muse_chat_complete`) all run through Tauri commands on the Rust side, spawning the user's own CLI. Each captures session IDs for resume, supports `--fork-session` for context handover, and never sees or stores API keys — the user's own CLI auth is used directly.
- **Isolated agent worktrees** — Each agent gets its own git worktree on its own branch off HEAD, under `.spacron/worktrees/`. Work is staged onto the branch; you review the diff and commit when you're ready. Main-repo mode keeps agents in the shared checkout.
- **Voice-driven everything** — Tap **left Alt** anywhere for a live speech↔speech conversation; press **F9** to dictate into any field (terminals stay verbatim); the floating prompt bar is voice-first with staged prompts and file drag-and-drop.
- **Generations** — Images and videos generate into `<project>/generations` on your ChatGPT plan or your own API keys (OpenAI, Google/Veo, OpenRouter, fal, Replicate), with an inline image viewer and paint-masked edits.
- **Remote Workspace** — Attach Spacron to your own VPS/VM over Tailscale or SSH: the workspace (files, terminals, agents) lives on your box and reconnects mid-state from anywhere. No provisioned servers.
- **Mobile Emulator** — Boot an Android phone AVD (or iOS simulator) and drive it with tap/swipe/type/rotate from the panel — no adb window needed.
- **Terminal Grid** — Full PTY shell sessions (xterm.js), layouts from single to 9-grid, automatic per-platform shell detection, session roles, command blocks, and working-directory tracking.
- **Editor & Preview** — CodeMirror 6 with 15+ languages, Vim mode, minimap, format-on-save; a live dev-server preview proxy with WebSocket support, device viewports, a DOM inspector, and an in-panel console.
- **Tool Rooms** — One-click rooms for the HTTP client, SQLite database explorer, Docker containers, dev toolbox (JWT/JSON/regex/epoch/coder), environment manager, media player, sketch canvas, and project snapshots.
- **Source Control (multi-provider)** — Choose GitHub, GitLab, Bitbucket, or Other (PAT-only) as your provider. GitHub supports OAuth device flow and gh CLI import; GitLab/Bitbucket/Other accept a personal access token saved to the OS keychain per provider. Sign in once per provider to clone private repos and publish PRs without pasting a token every time.
- **Git Integration** — Diff, commit, push, discard, and ASCII commit history, all from the sidebar.
- **Chat Workspace Mode** (`Ctrl+Shift+J`) — Thread-aware conversations per project: persistent threads with durable state, composer with provider/model selection, streaming replies, concurrent prompts, and input requests. Threads can be forked with their agent session context carried over. Every agent turn ends with a completion notification (inbox entry, toast, chime, OS ping) so you're told when work finishes or an agent needs your input — even if you're away from the app.

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
7. **Bring in the fleet when you want it** — press `Ctrl+Shift+A` to spawn agents, or open Chat mode (`Ctrl+Shift+J`), pick an agent in the composer, and send your message. Or skip all of it: everything above is fully manual.

> Want the full surface area? Read **[docs/FEATURES.md](docs/FEATURES.md)** — it documents every user-facing feature.

---

## 📊 Feature Comparison

| Feature | Spacron | VS Code | Warp |
|---|---|---|---|
| **Startup Speed** | **Sub-second (Native)** | 3–5 seconds | Fast |
| **Workspace Shell** | **Tauri 2 (Rust)** | Electron (Node) | Native (Rust) |
| **Agent Fleet & Direct Access** | **Yes (direct to agent CLI)** | Extensions | No |
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

## 🌳 Isolated Worktrees

When an agent runs from the terminal, Spacron creates an isolated git worktree on its own branch off HEAD, under `.spacron/worktrees/`:

1. **Branch off HEAD** — A new branch (`thread/<slug>-<short id>`) is created from the project's current HEAD commit.
2. **Separate checkout** — The worktree lives inside the project at `.spacron/worktrees/<branch>`, keeping its own files, index, and working directory while sharing Git history with the main checkout.
3. **Agent cwd follows** — The agent's terminal and every tool call run inside the isolated worktree path, so the agent never sees or touches files outside its own branch.
4. **No shared-tree collisions** — Parallel agents and the user can all edit simultaneously without overwriting each other, because each writes to its own checkout.
5. **Review before merge** — When the agent finishes, its work is staged onto its own branch. The user reviews the diff (`git diff main..<branch>`), runs tests, then commits in Source Control — nothing reaches `main` without explicit approval.

### Chat mode vs T3 Code

| Aspect | T3 Code | Spacron Chat mode |
|---|---|---|
| **Worktree creation** | Per-thread, isolated checkout | Optional per thread; created on demand |
| **Branch naming** | Thread-scoped | `thread/<slug>-<short id>`, stable per thread |
| **Context handover** | Separate thread with session fork | `forkChatThreadFrom` + `claude --fork-session` carries the agent session into the forked thread |
| **Where work lands** | Stay in thread until user merges | Staged onto agent branch, reviewed, then committed by user |
| **Cleanup** | Thread closes → worktree removed | `reclaimWorktree` stages pending work first, only removes when nothing is left unstaged |
| **Main-repo option** | Yes | Yes — agents can run directly in the project root when isolation is skipped |

This is **aligned with T3 Code**: both use separate threads/sessions with explicit context handover rather than mixing sub-agent turns into the same thread. Spacron carries over forked Claude sessions (and cursor/opencode/muse session IDs) so a forked thread resumes the source agent's conversation natively via `--resume`.

---

## 🔔 Notifications

Every agent turn in Chat mode ends with a completion notification so you're never left wondering:

- **Done** — Inbox entry (`✅`), success toast, chime, OS ping
- **Failed** — Inbox entry (`📝`), error toast, chime, OS ping
- **Needs input** — Inbox entry (`📝`), warning toast, chime, OS ping — raised when an ACP agent pauses waiting for your permission or answer

OS notifications fire even when Spacron is hidden or another app has focus. Everything lands in the inbox panel as a durable row that waits for you when you return.

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

## 📄 License

Spacron is **proprietary software**. All rights reserved — see the [LICENSE](LICENSE) file for the full terms. The source code may not be copied, modified, or redistributed without written permission.

Copyright © 2026 Samuel Solesi
