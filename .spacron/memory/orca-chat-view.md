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
  between turns. **Type one key per PTY write** (Orca's `agent-tui-command-typing.ts`): a multi-character
  write is read as a paste, and Codex then takes `/model` as prompt text and never opens its picker
  (model picks there "failed and fell back"). Mid-session routes follow Orca's option catalogs: Cursor
  `/model <id>`, Antigravity `/effort <level>` only; Pi and OMP have none (OMP's `/orca-model` is an Orca extension).
- A pane can switch CLIs under one chat view: the view is keyed by `agentPreset` in `TerminalPane`, or the
  last CLI's model list leaks into the next CLI's menu.
- Slash commands never switch the pane to its terminal (user request, 2026-11-20). The chat shows a row for
  each sent command; one that opens a TUI screen opens live in the chat (`LiveScreenCard`).
- **Model and effort follow Orca's catalogs (`SessionOptionApply` in `terminal-chat.ts`):** `command` kind
  for CLIs that take `/model <id>` (Claude, Grok, Cursor); `picker` kind for CLIs that only have an
  interactive picker (Codex `/model`, OpenCode `/models`): the chat opens that picker in the live panel and
  the person chooses. **Do not drive these pickers with simulated keys again.** It was tried on 2026-11-20 and
  broke repeatedly (Enter dropped within ~0.3s, title drawn before rows, per-version screens). Orca refuses
  for the same reason. In Codex's effort step, `s` applies a level to this session only; Enter or a digit
  **saves it as the user's default in `~/.codex/config.toml`**.
- Permissions still drive pickers in place (`terminal-chat-inplace.ts`: Codex `/permissions`, Claude
  Shift+Tab), with a restart (with resume) as the fallback.
- **OpenCode 2.3's TUI rejects `--model`** ("Unrecognized flag: --model", checked 2026-11-20), and
  `OPENCODE_CONFIG_CONTENT` did not change its model either. So a restart can't set the model. The spawn
  picker still passes `--model` for OpenCode (`chat-provider-adapters.ts`), which stops the launch on 2.3.
- Every write the chat makes to a pane goes through `serialPaneWrite` (Orca's PTY send queue); commands
  clear the input line with Ctrl+U first for Claude and Codex.
- `processSessionInput` only re-detects an agent launch when the typed line follows a shell prompt
  (`isShellPromptRow`). Before that, OpenCode model searches ("claude sonnet 4.5" + Enter) relabelled the
  pane as Claude Code.
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

## Orca's two chat systems, and where to read them (studied 2026-11-20)

- **Source:** `git clone` still fails, but `gh api repos/stablyai/orca/git/trees/main?recursive=1` and
  `gh api repos/stablyai/orca/contents/<path>` work. UI lives in `src/renderer/src/components/native-chat/`
  (≈250 components). The user docs are `docs/site/content/docs/agents/native-chat.mdx`, and the type and colour rules are in
  `docs/styleguide/native-chat.md`. The installed asar is still useful for the main-process registry
  (`out/main/chunks/agent-session-attachment-store-registry-*.js`, grep for ``agent:` ``).
- **Terminal-backed chat** (the one we copied): claude, openclaude, codex, grok, omp, opencode, opencode2, zcode.
- **Structured Chat UI** is Orca's default for *new* chats, and it does not use a PTY. Claude uses the Claude SDK and Codex uses the
  app-server. Both claim rewind, fork, compact and MCP, with mid-turn steering marked `inject`. Pi uses jsonl-rpc. Everything else goes over ACP
  (antigravity, copilot `--acp`, kimi `acp`, cursor `cursor-agent acp`, hermes `acp`, grok,
  opencode/opencode2, omp). These claim compact and context only, with steering marked `queue`. "Continue in Chat UI" and "Continue with
  Terminal Agent" move a conversation between the two kinds as a copy.

## Slash commands, skills and more agents (2026-11-20)

- Orca keeps a slash command in the chat; only a *bare* command flagged `opensInTerminal` in its catalog (`src/shared/native-chat/input/commands/native-chat-slash-commands.ts`) switches to the terminal. Our copy lives in `terminal-chat-rich.ts`. Claude Code's TUI writes almost no command replies to the transcript (only `/model`, `/effort`, `/compact` feedback); the chat shows any `<local-command-stdout>` it does get and otherwise tells the user the answer is on the terminal.
- Claude's real `/` list (built-ins, user/project/plugin skills) comes from `claude -p --input-format stream-json --output-format stream-json --verbose --no-session-persistence` fed one `control_request` `initialize` on stdin: no model turn, no session file. Trap: on Windows `which("claude")` finds npm's extension-less shell script; run the `.cmd` sibling through `cmd /d /c`, and read stdout lossily (skill descriptions can carry bytes that are not UTF-8).
- Skill folders per agent follow Orca's `skill-discovery-sources.ts` + `native-chat-agent-profiles.ts` (shared `.agents/skills`; Codex invokes `$name`; Pi `/skill:name`; OpenCode/Cursor also read Claude's folders).
- Transcript readers for Pi/OMP/Antigravity/Copilot/Cursor/OpenClaude follow Orca's `src/main/ai-vault/scanners/*`. Pi and Antigravity were checked against real files; Copilot and Cursor were not (no sessions on the dev machine). Kimi and Hermes are not read yet.

## Making every agent's chat behave like Claude's (2026-11-20, checked in a ConPTY via pywinpty + pyte)

- **Codex drops an Enter that lands within ~0.3s of a typed command** (its `/` popup is still settling): the
  command stays in the composer. `typeSlashCommand` waits 0.6s, which worked every time (0.171).
- **The live model comes from the footer, not the transcript.** Codex records a model only once a turn runs, and
  `config.toml` is not what a launch `-m` set. Codex: `GPT-6-Luna medium · ~\dir`. OpenCode: `Build · GPT-5.1 Abacus`
  (name + provider, mapped back to an id by `opencodeModelFromFooter`).
- OpenCode's `/models` search matches models.dev names, not ids (`claude sonnet 4.5`, not
  `abacus/claude-sonnet-4-5-20250929`); `opencodeSearchQuery` still maps ids to names for the footer.
- Command replies for CLIs that don't write them to a transcript are read off the screen
  (`terminal-command-output.ts`). Info dialogs (`closesAfterReading`) are closed with Esc after being read;
  pickers stay open and the chat says so.
- Commands flagged `opensInTerminal` open a live panel in the chat (`LiveScreenCard`) instead of a notice: it polls
  the screen, forwards keys, and closes when the composer rows (`atPrompt`) come back, when a dialog's title
  leaves the screen (OpenCode draws over its prompt), or on Esc. Sent commands and the open panel live in
  `terminal-chat-commands.ts`, so they survive the chat ⇄ terminal switch.
- Tool calls fold the Orca way (`toBlocks`): each run sits under the message before it, in the order it ran.
  One pill per turn was tried and dropped, because it moved later calls above text written before them.
- Commands typed straight into a non-Claude terminal reach the chat through `noteTerminalInput` (TerminalPane
  `onData` → `terminal-chat-commands.ts`): it follows the typed line, gives up after an arrow key, and resolves a
  prefix to the shortest catalog name (Codex's popup runs `/status` for `/stat`, checked on 0.171). Claude is
  skipped: its transcript already records them. The chat places them by time (`at: -1`, `sentAt`).
- Terminal-typed messages verified 2026-11-20 by driving each CLI in a ConPTY and running the ignored
  `smoke_reads_local_transcripts` test: Codex, OpenCode, Grok, Pi read fine. **Antigravity** newer CLIs drop
  `conversationId` from `history.jsonl`; the folder → conversation link is `cache/last_conversations.json`.
  Codex writes a failed turn's reason (usage limit) only as `task_complete.error.message`.
- The driver: `pywinpty` + `pyte` are installed. A path with a space ("SMIDS MAN") fails in `PtyProcess.spawn`
  even quoted; use the 8.3 form `C:\Users\SMIDSM~1\…`. Run Python with `-I`, which ignores `PYTHONIOENCODING`, so
  call `sys.stdout.reconfigure(encoding='utf-8')`.
