# How Orca's terminal ⇄ chat toggle works (studied 2026-11-19)

Source: the installed bundle `AppData/Local/Programs/orca/resources/app.asar`. `git clone stablyai/orca`
failed with `fetch-pack: invalid index-pack output`, so I unpacked the asar with `npx @electron/asar extract`.
The readable modules are in `out/shared/native-chat/**` and `out/shared/agent-session/**`.

- **It is a view of the terminal tab, not a second agent.** The real TUI CLI keeps running in the PTY.
  `canToggleNativeChat` only applies when `contentType === 'terminal'`. A tab can always go back from chat
  to terminal, but it can only enter chat for a supported agent whose transcript can be read:
  claude/openclaude, codex, grok, omp, opencode/opencode2/zcode (`native-chat-agent-support.js`).
- **Reading:** the view parses the CLI's own transcript file. Claude uses `~/.claude/projects/*.jsonl`,
  Codex uses `~/.codex/sessions`, OpenCode uses its SQLite db. Each pane learns its session id and
  `transcript_path` from **agent hooks** keyed to that pane (`agent-hook-listener/pane-provider-session.js`).
  Busy, idle and blocked state also comes from those hooks.
- **Writing:** everything goes into the PTY as keystrokes. A prompt is sanitized and sent as a bracketed
  paste, then Enter is sent as a **separate write after a short delay**, because a CR in the same write is
  read as pasted text. Images are sent the way a terminal drag-and-drop sends an image path. Approvals send
  `1` (OpenCode: `\r`). Question answers step through the menu with keys. Stop sends Esc, and a second Esc
  only for OpenCode, because Esc-Esc means rewind in Claude/Codex.
- **Echoes:** an optimistic "pending send" row stays until the real transcript row lands. It is then
  matched and removed, and the matching tolerates sends that got glued together.
- Separate from all this, Orca has a "Chat UI" structured runtime (`runtimeKind: 'native'`, leases,
  "Continue in Chat UI" handoff). That is a different feature that starts a second process. The toggle
  inside a terminal tab is the transcript view described above.

Compared with spacron's chat mode (2026-11-19): ours is a workspace-wide `interactionMode` that runs its own
headless provider processes (`chat-provider-adapters.ts`: stream-json, app-server, ACP). That is the
opposite design.

## T3 Code, for comparison (installed `t3code/resources/server.asar`, `apps/server/dist`)

T3 is a pure GUI chat with no TUI behind it. Each provider has a driver that runs its vendor's
structured protocol: Claude uses `claude-agent-sdk`/stream-json, Codex uses `app-server`, OpenCode uses
`serve` + SDK, Cursor uses `@cursor/sdk`, and Pi uses RPC. ACP is used for agents that have no protocol
of their own: `makeGrokAcpRuntime`, `Kiro`, `Antigravity`, `Fx` (`fx acp`). It also has an **ACP registry**
(`packages/provider-acp-registry`, `cdn.agentclientprotocol.com/registry/v1/latest/registry.json`) that
installs extra agents through npx/uvx/archives. Our `chat-provider-adapters.ts` follows the same pattern.
Orca's terminal view needs neither the vendor protocols nor ACP.


## Spacron's version (built 2026-11-19)

How the pieces connect: `agent_transcript.rs` (reader) → `services/terminal-chat.ts` (view state, binding) →
`TerminalChatView` (overlay inside `.xterm-container`), with the switch in the `TerminalPane` title bar.
Traps that no single file explains:
- The old app-wide Chat mode is **dormant, not deleted**. `interactionMode` is pinned to `'cli'`, and
  `setInteractionMode('chat')` does nothing, so ChatModePanel, standalone chats and the chat-mode branches
  in AppShell/ProjectHUD can no longer be reached. Delete them deliberately, not piecemeal.
- A pane is matched to its transcript by **cwd + the time the agent started** (`getSessionAgentStartedAt`,
  set in `markSessionAgentPreset`). No hook reports the session id. Panes that share a folder exclude each
  other's bound ids, but the first one to bind wins.
- The reader resolves config dirs from the **app's** environment (`CLAUDE_CONFIG_DIR`, `CODEX_HOME`, …).
  A pane launched under a non-default account gets its own env var, which the reader cannot see. That
  pane's transcript is not found.
- Grok's dir name is `encodeURIComponent(cwd)`. Grok hashes names longer than 255 bytes, which is not handled.
- Cursor, Antigravity, Copilot, Kimi and Hermes have **no chat view**, and Orca has none for them either.
  Orca's modules for those five parse hook events (status, tool names), not transcripts. On this machine,
  Antigravity keeps protobuf blobs in SQLite (`~/.gemini/antigravity/conversations/*.db`), Copilot's
  `session-state/<id>/` folders hold no message log, and Cursor's CLI had saved no chats. Building a
  reader for any of them means finding a stable format first.
- The chat lives in `.pane-body`, as a **sibling** of `.xterm-container`, and must stay there.
  global.css excludes `.xterm-container *` from app typography, so a chat placed inside it renders
  in terminal type.
- Model and effort changes are typed into the TUI as slash commands (`typeSlashCommand`), and only
  between turns. Codex only has its own `/model` picker, so picking there switches the pane to the
  terminal.
- Model, effort and permission changes happen **in place**, by driving the CLI's own pickers through the
  PTY (`terminal-chat-inplace.ts`, which carries the screens and keys it was built against). Never restart
  for a model change, because that lost the user's context. Codex's effort step must use `s` (this session
  only): Enter or a digit **saves it as the user's default in `~/.codex/config.toml`**. A restart (with
  resume) is only the fallback for permissions that have no in-place route (Grok, OpenCode, Claude bypass
  outside its Shift+Tab cycle).
- Picks live in module state (`setSessionPicks`), not component state, because the view unmounts when its tab
  hides. Picks are cleared once the transcript reports the same value (Codex: `thread_settings_applied`;
  Claude: `/model` and `/effort` command rows, `permissionMode`).
- **Inline visuals** (`::spacron-visual{file=… title=…}`, rule 8 of the agent brief): pages are served by
  `commands/chat_visuals.rs` from `127.0.0.1` with their own CSP. Do not switch to `iframe srcdoc`: a srcdoc
  document inherits the app CSP (`script-src 'self'`), so the page's scripts never run. The folder is per
  spawn (`$SPACRON_CHAT_VISUALS_DIR`, set in `spawnAgentPreset`). Agents started by typing in a shell, or
  restored after a restart, have no folder, and their visuals show a "can't be shown" card.
- **Ask cards** (`services/terminal-prompt.ts`, `PromptCard`): questions and approvals are read from the TUI's screen (footer hint + numbered rows with a highlight marker) and answered with arrows and Enter. A "Type something." row is answered by typing ON that row, then Enter. Pressing Enter on it while empty **declines the whole question** (verified on Claude Code 2.1). Multi-select checkbox prompts fall back to the terminal.
- Visuals talk back only through `window.spacron.compose(text)`, which fills the composer and **never sends**: the page is agent output, and auto-sending it could loop.
