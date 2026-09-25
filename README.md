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

Spacron is a cross-platform desktop workspace that combines a real PTY terminal grid, a CodeMirror code editor, a hot-reloading web preview proxy, git integration, and a **conversational agent fleet** — all unified inside a single keyboard- and voice-driven window. Tell the orchestrator your goal and it plans the work, edits up to 3 files itself, and delegates the rest to a team of coding CLIs that work in your shared repo — each told explicitly not to touch the others' files. Built with Tauri 2 (Rust) and React, it stays lean: no Electron, no Node.js runtime, sub-second startup.

**You are always in control.** Every automated action — an orchestrator edit, a spawned agent, an approval card, a generation — has a plain manual path. Agent work sits on branches you review yourself, nothing runs without your say-so, and all of the classic terminal/editor/preview/git features work exactly the same with zero AI connections configured. See **[Doing It Yourself](docs/FEATURES.md#18-doing-it-yourself)**.

---

## ⚡ Key Features

- **Agent Fleet & Orchestration** — A conversational orchestrator that understands your whole project. It plans each goal into 2–4 sub-tasks with disjoint file sets, edits at most 3 files per task itself, and delegates big work to agents over approval cards. The fleet (Claude Code, Codex, Cursor, Antigravity, Grok, OpenCode, and more) runs live as tiles with `APPROVED`/bounce review gates. Agents default to your shared main repo; per-agent isolated worktrees remain an option.
- **Hands-off the shared tree** — When several agents work alongside you in the same repo, a standing charter, disjoint file sets, coordinator sequencing, and mailbox file-claims keep them from clobbering each other — never revert changes that aren't yours, commit only the files you changed.
- **Voice-driven everything** — Tap **left Alt** anywhere for a live speech↔speech conversation; press **F9** to dictate into any field (terminals stay verbatim); the floating prompt bar is voice-first with staged prompts and file drag-and-drop.
- **Generations** — Images and videos generate into `<project>/generations` on your ChatGPT plan or your own API keys (OpenAI, Google/Veo, OpenRouter, fal, Replicate), with an inline image viewer and paint-masked edits.
- **Remote Workspace** — Attach Spacron to your own VPS/VM over Tailscale or SSH: the workspace (files, terminals, agents) lives on your box and reconnects mid-state from anywhere. No provisioned servers.
- **Mobile Emulator** — Boot an Android phone AVD (or iOS simulator) and drive it with tap/swipe/type/rotate from the panel — no adb window needed.
- **Terminal Grid** — Full PTY shell sessions (xterm.js), layouts from single to 9-grid, automatic per-platform shell detection, session roles, command blocks, and working-directory tracking.
- **Editor & Preview** — CodeMirror 6 with 15+ languages, Vim mode, minimap, format-on-save; a live dev-server preview proxy with WebSocket support, device viewports, a DOM inspector, and an in-panel console.
- **Tool Rooms** — One-click rooms for the HTTP client, SQLite database explorer, Docker containers, dev toolbox (JWT/JSON/regex/epoch/coder), environment manager, media player, sketch canvas, and project snapshots.
- **Sign in with ChatGPT** — Run the whole fleet on your ChatGPT plan through Codex (no API key), or connect OpenAI/Anthropic/Google/OpenRouter/xAI keys and free Kilo Code models.
- **Git Integration** — Diff, commit, push, discard, and ASCII commit history, all from the sidebar.

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

Spacron renders through the system WebKitGTK, which plays video/audio via
GStreamer. For the YouTube panel (and other media playback) install the codec
packages if your distro doesn't ship them:

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

## 📊 Feature Comparison

| Feature | Spacron | VS Code | Warp |
|---|---|---|---|
| **Startup Speed** | **Sub-second (Native)** | 3–5 seconds | Fast |
| **Workspace Shell** | **Tauri 2 (Rust)** | Electron (Node) | Native (Rust) |
| **Agent Fleet & Orchestration** | **Yes (in shared repo)** | Extensions | No |
| **Voice Control** | **Yes (realtime + dictation)** | No | No |
| **Multi-pane PTY** | **Yes** | Integrated Tab | Primary focus |
| **Code Editor** | **CodeMirror 6** | Monaco Editor | None |
| **Port Preview Proxy** | **Yes + DOM Inspector** | Requires extension | None |
| **Resource Memory** | **~40–80 MB** | ~400–800+ MB | ~150–350 MB |

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
| **Go to YouTube** | `Ctrl+Shift+Y` | View |
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

## 🛠️ Build from Source

For detailed instructions on setting up MSVC compiler tools, Apple signing certificates, or Linux webkit libraries, read **[docs/BUILDING.md](docs/BUILDING.md)**.

```bash
git clone https://github.com/Samuel00098/spacron.git
cd spacron
npm install
npm run tauri dev
```

---

## 📄 License

Spacron is **proprietary software**. All rights reserved — see the [LICENSE](LICENSE) file for the full terms. The source code may not be copied, modified, or redistributed without written permission.

Copyright © 2026 Samuel Solesi