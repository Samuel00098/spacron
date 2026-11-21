# Orca & T3 Code Feature Analysis & Recommendations for Spacron

A comprehensive feature comparison of **Orca** (`stablyai/orca`) and **T3 Code** (`pingdotgg/t3code`), evaluating capabilities that can be adopted into **Spacron** to enhance its multi-agent orchestration, developer workflows, and system performance.

---

## Executive Summary

Both **Orca** and **T3 Code** are modern developer control planes for supervising and orchestrating coding agents (Claude Code, OpenAI Codex, OpenCode, Cursor, Google Antigravity, Grok, etc.) running on local machines.

- **Orca** focuses on terminal splitting, agent isolation via Git worktrees, design mode / DOM inspection, diff review workflows, and mobile/remote companion tools.
- **T3 Code** focuses on a unified client-server architecture (desktop, web, mobile syncing over RPC), mid-execution follow-up queueing, provider handoffs, and streamlined 1-click PR shipping.

Spacron already possesses a high-performance foundation built on **Tauri 2 (Rust) + React 19 + CodeMirror 6**, with native PTY terminals, isolated worktrees, realtime voice & Whisper dictation, and structured chat. Adopting the highest-leverage features from Orca and T3 Code will significantly close remaining user-experience loops.

---

## Feature Comparison Matrix

### 1. Code Review, Git & Delivery Loop

| Feature | Seen In | Feature Description | Value to Spacron | Implementation Feasibility |
|---|---|---|---|---|
| **Interactive Diff Annotations (In-Diff Comments)** | **Orca** | Click any line or hunk in the diff viewer to leave a markdown comment. Send all annotations as a single batch back to the agent as revision feedback. | Eliminates the detour of switching to chat and manually typing line numbers. Closes the human reviewer loop. | **High Value / Medium Effort**<br>Extends `HunkDiffView` and feeds directly into Spacron's existing reviewer bounce-back flow. |
| **Start Work Directly from Issues / PRs** | **Orca & T3 Code** | Browse GitHub, Linear, or GitLab issues in-app. Click "Start Work" to automatically create an isolated worktree, branch, and brief a new agent on that issue. | Removes the manual context copy-paste detour between browser and desktop. | **High Value / Medium Effort**<br>Spacron already implements GitHub auth and PR/issue endpoints in `source_control.rs`. |
| **"Prompt Racing" (1 Prompt Across N Agents)** | **Orca** | Fan out the exact same prompt to multiple agents simultaneously in isolated worktrees (e.g. Claude Code vs Codex vs OpenCode), compare diffs side-by-side, and merge the winner. | Ideal for complex architectural tasks, benchmarks, or comparing reasoning approaches across model providers. | **Medium Effort**<br>Leverages existing multi-worktree dispatching. |
| **Worktree Snapshots & Checkpoints** | **Orca** | Create milestone snapshots/checkpoints of a worktree branch before risky agent turns, with 1-click rollback to any checkpoint if an agent veers off course. | Gives users confidence during autonomous multi-step runs without risking untracked state loss. | **Quick Win / Low Effort**<br>Lightweight Git tree/tag snapshot helper. |
| **1-Click Pull Request & CI Tracking** | **T3 Code** | From the worktree diff view, one button to generate a commit message, commit, push, create a GitHub PR, and watch CI test check runs live in the status strip. | Streamlines shipping without switching to browser or terminal. | **Medium Effort**<br>Builds on `source_control.rs` and `expectedHeadSha` merge safety. |

---

### 2. Multi-Device, Remote & Companion Access

| Feature | Seen In | Feature Description | Value to Spacron | Implementation Feasibility |
|---|---|---|---|---|
| **Mobile Companion App (iOS & Android)** | **Orca & T3 Code** | Dedicated mobile client paired via QR code or local network / Tailscale to monitor agent status, inspect terminal scrollback, receive push notifications when an agent asks for input, and reply from your phone. | The single most requested capability for multi-agent workflows. Lets developers step away while long-running agent tasks execute. | **Major Project**<br>Requires a lightweight Expo/React Native client connecting to Spacron's existing remote WebSocket PTY protocol. |
| **Headless Server & Web Client Mode** | **T3 Code** | Run the core engine headlessly (`spacron serve`) on a workstation or VPS and connect via any standard web browser with the exact same UI. | Allows running heavy agent fleets on a headless Linux machine while driving them from a lightweight laptop or tablet. | **Medium–Large Effort**<br>Expands `spacron-server` to serve the web UI bundle. |
| **QR Code Pairing** | **Orca** | Generate a pairing QR code on the desktop for the mobile app or remote client to scan for instant mutual authentication. | Eliminates manual copying of tokens and IP addresses. | **Quick Win / Low Effort** |

---

### 3. Agent Orchestration & Chat UX Polish

| Feature | Seen In | Feature Description | Value to Spacron | Implementation Feasibility |
|---|---|---|---|---|
| **First-Work Auto-Naming** | **Orca** | Automatically generate clean branch names, worktree directories, and thread titles from the agent's first real turn (e.g., `fix-auth-token-refresh` instead of `thread/feature-xyz-1`). | Transforms the sidebar and fleet overview into an easily scannable, meaningful task board. | **Quick Win / Low Effort**<br>Triggers a title/slug update upon completion of the agent's first turn. |
| **Unified Jump Palette (`Ctrl+J` / `Cmd+J`)** | **Orca** | A unified search/switcher indexed across running agents, worktrees, open files, past transcripts, and "jump to whoever needs input". | Combines Spacron's current command palette, floating search, and titlebar search into one predictable navigation surface. | **Medium Effort** |
| **Mid-Thread Agent & Model Handoff** | **T3 Code** | Switch agents or models mid-thread (e.g. brainstorm/plan with Claude 3.7 Sonnet, then hand the task context over to Codex or OpenCode to execute file changes). | Lets users optimize model usage and switch to cheaper or specialized models as a task shifts from design to implementation. | **Medium Effort**<br>Builds on `HandoffHistoryModal` and session context extraction. |
| **Rewind & Fork from Any Arbitrary Turn** | **Orca** | Hover any message in the transcript history to "Rewind to here" (re-open draft with state restored) or "Fork from here" (create an isolated branch of the conversation). | Gives full branching control over long conversational workflows. Spacron currently supports rewind/fork on the latest turn. | **Medium Effort** |
| **Provider Speed Pill (Fast / Service Tier Selection)** | **Orca & T3 Code** | A fast-mode toggle in the composer (e.g., Codex service tiers or Cursor fast/normal mode) directly accessible per turn. | Provides immediate control over latency vs reasoning depth. | **Quick Win / Low Effort**<br>Expose `serviceTier` in `turn/start` requests. |

---

### 4. Concurrency, Execution & System Resource Management

| Feature | Seen In | Feature Description | Value to Spacron | Implementation Feasibility |
|---|---|---|---|---|
| **Agent Hibernation (Sleep / Wake on Demand)** | **Orca** | Automatically pause/hibernate idle background agent PTY sessions to free system RAM and CPU, waking them instantly when focused or when new input is queued. | Essential when running fleets of 6–10+ parallel agents on local machines. | **Medium Effort**<br>Requires coordinating process suspension while maintaining PTY leases. |
| **Native WSL Runtime Bridge (Windows)** | **T3 Code** | Bundled WSL runtime launcher (`wsl-runtime.tar.gz`) to execute CLI agents inside Linux WSL while rendering natively on Windows. | Fixes many Windows-specific CLI quirks (path escaping, ANSI/ConPTY artifacts, npm `.cmd` shims). | **Medium Effort** |
| **System Resource & Runaway Loop Watchdog** | **T3 Code** | A background process monitor (`resource-monitor`) tracking CPU, memory, and disk I/O of child agent processes, warning if an agent gets stuck in an infinite loop. | Prevents silent machine freeze when an agent triggers recursive processes. | **Medium Effort**<br>Lightweight background sysinfo thread in Rust. |

---

### 5. Extensibility & Customization

| Feature | Seen In | Feature Description | Value to Spacron | Implementation Feasibility |
|---|---|---|---|---|
| **Terminal Theme Importer (Warp / Ghostty / iTerm2)** | **Orca** | Direct parser for Warp / Ghostty `.yaml` and standard `.itermcolors` theme files to customize the terminal color palette. | Terminal is currently dark-only; this allows users to import their favorite terminal aesthetics with zero friction. | **Quick Win / Low Effort**<br>Text parser mapping color keys to xterm.js theme options. |
| **Dynamic ACP Agent Registry** | **T3 Code** | A community agent registry (`packages/provider-acp-registry`) that can install new Agent Client Protocol tools via `npx` / `uvx` on the fly. | Expands the supported agent ecosystem automatically without hardcoding new presets. | **Medium Effort** |
| **Curated Agent Skills Catalog (`SKILL.md`)** | **Orca** | Built-in browser for discovering, toggling, and installing agent skills (e.g., web testing, modern web guidance, slack, vercel deployment). | Extends agent capabilities through modular, readable instructions. | **Medium Effort** |
| **Scriptable CLI (`spacron` CLI)** | **Orca** | A companion command-line utility (`spacron worktree create`, `spacron run`, `spacron snapshot`) allowing users and CI scripts to drive Spacron headlessly. | Makes Spacron automatable from bash scripts and developer workflows. | **Medium Effort** |

---

## Phased Implementation Roadmap for Spacron

To maximize impact while leveraging Spacron's existing Tauri 2 + Rust architecture, here is the recommended prioritization:

```mermaid
flowchart TD
    subgraph Phase 1: High-Impact Quick Wins
        A1[Interactive Diff Annotations]
        A2[First-Work Auto-Naming]
        A3[Terminal Theme Importer]
        A4[Worktree Snapshots & Checkpoints]
    end

    subgraph Phase 2: Workflow & Orchestration Upgrades
        B1[Start Work from GitHub/Linear Issues]
        B2[Unified Jump Palette Ctrl+J]
        B3[Prompt Racing Across N Agents]
        B4[Arbitrary Turn Rewind & Fork]
        B5[Provider Speed Pill / Service Tier]
    end

    subgraph Phase 3: System Performance & Multi-Device
        C1[Agent Hibernation / Sleep-Wake]
        C2[Runaway Loop Watchdog]
        C3[Mobile Companion App]
        C4[Dynamic ACP Agent Registry]
    end

    Phase 1 --> Phase 2
    Phase 2 --> Phase 3
```

### Phase 1: High-Impact Quick Wins (Days)
1. **Interactive Diff Annotations**: Add line-level comment triggers on `HunkDiffView` and a "Send comments to agent" batch action.
2. **First-Work Auto-Naming**: Generate meaningful branch and tab names from the agent's first completed goal.
3. **Terminal Theme Importer**: Enable import of Warp and Ghostty YAML color schemes into xterm.js.
4. **Worktree Snapshots**: Expose quick save-points and rollbacks for agent worktree branches.

### Phase 2: Workflow & Orchestration Upgrades (Weeks)
1. **GitHub & Linear Task-to-Worktree Flow**: 1-click agent dispatch directly from selected issues.
2. **Unified Jump Palette (`Ctrl+J`)**: Consolidated index of files, agents, worktrees, and tasks.
3. **Prompt Racing**: Send identical instructions to multiple agents and present a comparison review.
4. **Arbitrary Rewind & Fork**: Extend session-store rollback to any prior turn in the history journal.
5. **Fast-Mode / Service Tier Toggle**: Add speed pill in the composer for Codex and Cursor.

### Phase 3: System & Ecosystem Scale (Longer Term)
1. **Agent Hibernation**: Suspend idle terminal PTY processes to conserve RAM during massive concurrent runs.
2. **Mobile Companion App**: Standalone mobile app connecting to Spacron's WebSocket server for on-the-go notifications and steering.
3. **Dynamic ACP Registry**: Auto-install community agent adapters from registry JSON specifications.
