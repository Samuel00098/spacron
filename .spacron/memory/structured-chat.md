# Structured chat (Orca's "Codex Chat" tabs)

Started 2026-11-20. Orca has two chat kinds (see [[orca-chat-view]]): the terminal-backed view (ours since
2026-11-19) and **structured chat**, where the agent runs over its own protocol with no terminal. Only the
structured kind can offer every model and reasoning level, because the choice rides on each turn
(`turn/start { model, effort }`), while a terminal view can only type into the CLI's picker.

How it is wired (Codex, stage 1):
- A structured chat is an **ordinary pane** (`createTerminalSession`) marked in
  `services/structured-chat/panes.ts`. `TerminalPane` then shows the existing `TerminalChatView` with
  `structuredAgent` set, so the current rich chat UI is shared while the provider, not the PTY/transcript,
  owns messages, settings and turns. A new pane type was ruled out: rooms, splits, survival and close all
  key on terminal sessions.
- `quickSpawnAgent(command, { view: 'chat' })` opens one for agents `structuredChatAgentFor` lists.
- The process goes through the generic JSON-RPC stdio bridge (`acp_start`/`acp_request`, `src-tauri/src/acp.rs`).
  `acp_request` had to become **async**: as a sync Tauri command it waited on the main thread (UI freeze).
- Codex starts from its native binary (`codex_app_server_launch` in `chatgpt.rs`), never the npm shim.

Verified live (Codex 0.171, in a second debug instance over CDP): start, `model/list` (3 models with
per-model levels, Terra up to Ultra), a turn sent as Terra + Ultra was accepted, the error notice rendered,
and closing the pane killed its app-server. **Not seen yet:** a successful reply, command and file-change
items, or approval requests, because the account was usage-limited until 2026-12-16. Those mappings
(`chatItemFor`, approvals) come from `codex app-server generate-ts` types and are unit-tested only.

The current rich chat composer is now also wired to structured state: model/effort/access picks call the
provider directly, prompts and interrupts use the provider, and structured approvals render in the same
chat surface. Slash commands remain presented by the shared menu and are sent through the provider prompt
channel; provider-native command semantics still need to be added where a protocol does not expose them.

Not done yet: persistence across app restart (the pane comes back as a plain shell), and live verification
of every provider's rich item mapping and command behavior.

Update 2026-11-20 (durable sessions): `session-store.ts` gives each structured conversation a record with a
stable `ss_…` id (pane ids reset every launch) and an event journal (`event-journal.ts`). It **watches
`structuredChatPanes`** rather than being called by launchers, so any new way of opening a chat gets a record
for free; don't add per-launcher record calls. Events come from diffing successive provider states, not from
the adapters, so adapters stay protocol-only. Persistence is localStorage (journal capped ~1.5 MB per record,
image bytes stripped, 50 records). Restore: `workspace.ts` calls `restoreStructuredSessions` on cold project
restore; only `origin: 'chat'` records come back, because a CLI pane switched into chat (`converted`) is
relaunched as its CLI by the workspace restore and would otherwise appear twice. Shutdown is told apart from a
user closing the pane by a `beforeunload` flag. Unit-tested only; restart restore not yet seen live.

Converted panes (a CLI pane switched into chat) are matched on cold restore by project + preset + normalized
cwd, because the workspace snapshot has no record id; `workspace.ts` claims the record, then either reopens it
as chat in the agent room or relaunches the CLI with `resumeArgs` and adopts the pane. Two converted panes of
the same agent in the same folder can swap records; that is the accepted cost of not adding a field to the
workspace pane sanitiser. Slash commands in a structured chat go through `commands.ts` first (model, effort,
permissions, clear, stop, retry, rename, history, resume, terminal, handoff); anything else is sent to the
agent as text. Approval answers must go through `session-store.answerStructuredApproval` so the decision is
journaled once. `model-catalog.ts` caches only non-empty, successful catalogs per provider.

Update 2026-11-20 (connection fixes, verified by handshake on Windows for Claude 2.1.329, Codex, Pi, OpenCode,
Grok, Antigravity, Cursor; copilot/kimi/hermes/omp not installed, unverified):
- Every agent but Codex (native binary) is started through `openAgentSession`, which on Windows runs
  `cmd.exe /d /s /c <name> args` so npm `.cmd` shims resolve ([[windows-pathext-shims]]). Bare `opencode`,
  `cursor-agent` and `pi` could not start at all before. `acp_close` now `taskkill /T`s the tree, or the agent
  behind `cmd.exe` keeps running.
- Claude: a session id with no completed turn cannot be `--resume`d ("No conversation found…", exit 1), so the
  adapter reports its id only after the first `result`. Without `--permission-prompt-tool stdio` tool prompts are
  denied silently. Model efforts are in `supportedEffortLevels`.
- Cursor's `session/new` never answers until `authenticate { methodId: 'cursor_login' }` is sent.
- Pi answers `{type:'response', id, data}`; models are in `get_available_models.data.models`, ids repeat
  across providers (catalog ids are `provider/id`).
- Failures now carry the agent's last stderr line instead of a bare "X stopped."
- Trap (seen in the app, not in a shell): "'claude' is not recognized…" from `cmd.exe` although `where claude`
  finds it. cmd stops resolving once PATH exceeds 8191 chars, and the app's PATH can. `acp.rs` now gives every
  ACP child `agent_probe::search_path()` (registry PATH first, bounded). Reproduced with a 11.9k PATH.

Switching traps (2026-11-20, from a user screenshot: launch line, then a column of empty `C:\…>` prompts):
- Each Ctrl+C that reaches cmd after the CLI is gone prints an empty prompt. `quitAgentCli` used to wait only
  2.5 s, but Claude can take longer to exit (SessionEnd hooks, MCP shutdown), so it fired up to six more and then
  reported failure with the CLI already dead. It now skips Ctrl+C when the prompt is already back, sends at most
  four, and waits 8 s per round.
- `continueInTerminal` called `markSessionAgentPreset(id, preset)` after `relaunchAgentInSession` had marked the
  pane briefed; that reset `briefed` and fired the auto-brief into the new CLI. Don't re-mark after a relaunch.
- Both directions now fall back instead of stranding a bare shell: chat start fails -> the CLI relaunches with its
  resume id; CLI exits right after relaunch -> the chat reopens.

Verified live 2026-11-20 in a second debug instance over CDP (see [[drive-the-real-app-at-any-size]]):
Claude terminal->chat->terminal twice on one conversation, a fact given in the terminal and one given in chat
both recalled after the round trip; Codex the same; handoff Claude terminal -> Codex chat and Codex chat ->
Claude terminal, both delivered. Causes found only live:
- A long cwd prompt wraps in a narrow pane; reading 8 screen rows started mid-prompt, so the prompt was never
  recognised and the switch kept sending Ctrl+C. Read enough rows (`shellPromptShowing`).
- Codex/Claude create the conversation when the chat opens but save it only after a message; going back to the
  terminal resumed the unsaved id and the CLI exited. `switch.ts` resumes only a saved conversation.
- `relaunchAgentInSession`'s args replace the permission args; pass `permissionArgs` with the resume flag.
- Spacron started from a Claude Code terminal passes `CLAUDECODE`/`CLAUDE_CODE_*` to every agent; Claude then
  disables transcript saving. `acp.rs`/`pty/session.rs` drop those vars when Spacron runs inside a Claude session.
Second live pass 2026-11-20 (OpenCode, Pi, Cursor, Grok, Antigravity: terminal->chat->terminal all pass; OpenCode
chat message answered):
- ACP `clientCapabilities.terminal` must be a boolean. As an object, Cursor and Grok rejected `initialize` with
  "Invalid params". The structured chat declares no client fs/terminal (`ACP_NO_CLIENT_TOOLS`) because it answers
  none of those requests; only the orchestrator's ACP path implements them.
- Most ACP agents have no permission *mode* (OpenCode build/plan, Cursor agent/plan/ask, Grok none); only
  Antigravity has default/accept-edits/auto. Access is enforced by auto-answering permission requests
  (`autoApproves`); never send a guessed mode, and never let a mode failure abort the start.
- Pi RPC answers carry an `id`; the Rust reader dropped any id it had no waiter for. It now forwards them.
- The Pi provider adapter's runtime args (`--mode rpc --no-session`) leaked into terminal launches, so a Pi
  terminal pane ran the RPC protocol (blank, ignores Ctrl+C). RPC flags live in `PI_RPC_ARGS`, used only by the
  orchestrator's Pi chat thread.

Update 2026-11-20 (subagents own a record): a child belongs to the parent's `ss_…` record, not the active
project — `spawnMcpSubagent` reads project/cwd from `recordForPane` and `recordSubagentSnapshot` writes the
children back onto that record, so `restoreMcpSubagents` can rebuild the panel. Two traps: only a `done`
report completes a child (a process exit is `exited`, a child missing after a reload is `lost`), and a
session id absent from `sessions` means "not created yet" as often as "gone" — panes are added after their
process starts, so the exit watcher ignores an absent id. Capability booleans no longer mean "native": use
`rewindMode` / `forkMode` (`native-provider` vs `conversation-reset` / `journal-branch`) before wording a
fallback, and only attempt provider-native subagents when `providerOwnsSubagents` is true.

Testing traps: in a hidden room the pane's screen reads empty; after HMR, `import()` of a store from the
console can get a stale copy, and a composer query must use `.terminal-chat-composer textarea`, not the
first textarea (that is xterm's hidden helper).

Trap: saving a `.rs` file restarts the user's `tauri dev` app and ends its terminals
([[tauri-dev-restarts]]). Batch Rust edits, and test in a separate debug instance
([[drive-the-real-app-at-any-size]]).

Update 2026-11-20 (merge): worker Rama's branch `thread/codex-67j9fj` (commit 0e67eca) added the provider
contract (`provider.ts`, `registry.ts`, `state.ts`) plus Claude stream-json, ACP and Pi drivers; merged
into the main folder file by file. Its `acp.rs` did not compile (E0597 in `write_raw`, fixed), and
`acp_write_raw` had to be registered in `lib.rs`. None of the new drivers has been run live yet, and
"Continue in chat" and restart persistence are still not wired.

Update 2026-11-20 (Orca parity gaps closed):
- `StructuredChatProvider` exports `capabilities: StructuredProviderCapabilities` (rewind, fork, compact, steering, contextUsage, mcp, subagents, nativeCommands, supportedAccessModes).
- Rewind (`/rewind`), Fork (`/fork`, tracking `forkMode`), and Steering (`/steer` with inject vs queue) wired across providers, registry, and session-store.
- Compact separates native context compaction from local journal compaction.
- Continuity (`restoredMode`: native vs journal-only) tracked in records and surfaced in UI and `/context`.
- Subagents: `StructuredSubagentSession` contract, child-run cards, and `renderNested` added to `StructuredChatView`.
- Update 2026-11-20 (Spacron MCP Subagents integration): Rather than relying on external agent skills or fractured per-provider subagent protocols, structured chat delegates sub-agents directly to the application's native MCP engine (`mcp-subagents.ts`). Spawns agents in isolated git worktrees via `spawnAgentPreset` + `createTaskWorktree`, registers them with Spacron MCP (`registerAgent`), opens their stage pane via `requestRoomControl('focus', 'agent:<id>')`, delivers instructions and answers via `sendOrchestratorFollowUpWhenReady`, and listens to `mcp:agent-report` turn signals for live state transitions. Exposed via UI creation bar, active card controls, and `/subagent [preset] <task>`.
- Update 2026-11-20 (Rewind, Fork & Steering/Queue parity closure):
  - Rewind (`/rewind`): For Codex, uses native backend rollback (`thread/rollback`). For Claude and ACP/Pi providers without an in-place rollback RPC, `session-store.ts` rolls back the journal and resets the provider process cleanly with re-seeded history so prior undone turns are truly eliminated from the model's server-side context window.
  - Fork (`/fork`): Codex uses native `thread/fork`. For Claude/ACP, thread ID aliasing is blocked; `session-store` establishes an isolated journal branch (`forkMode: 'journal-branch'`) with `nativeSessionId: null`, ensuring that resumed forks run in independent sessions and never overwrite the parent's session file.
  - Steering & Queue (`/steer`): `StructuredChatView.tsx` mounts `<QueueCards>` from `TerminalChatRich` using `$lib/services/terminal-chat-queue`. Follow-ups typed mid-turn when steering is `queue` are enqueued and displayed with full inline edit/delete/move/send-now controls. The queue drains automatically turn-by-turn when the agent becomes ready. Composer placeholders and send buttons adapt dynamically between steer injection and queue mode.
