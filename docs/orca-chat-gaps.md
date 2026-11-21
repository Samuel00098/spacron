# Structured chat: current Spacron code vs Orca

## Current verdict (source rechecked 2026-11-20, gaps closed)

**The non-live gaps in the previous revision of this document are closed at the code-path level.** Child
agents are now owned by the parent's structured-session record (project, folder, status, reports, timeline
and end reason all persist with it), the capability table no longer claims native behavior a provider does
not have, the subagent UI says which system owns a child, and every Chat Settings option is mapped below.

What remains is **not** code parity work:

1. **Provider live verification** — re-run the per-provider acceptance pass (below) for every installed
   provider/version. Nothing in this document was checked against a live CLI in this pass.
2. **A current Orca product comparison** — the reference notes describe one inspected Orca build, not the
   latest release.
3. **One settings row is deliberately inapplicable** (queue follow-ups, below): a structured chat has no
   PTY, so a mid-turn message follows the provider's steering capability instead of a queue toggle.

This is a source audit, not a fresh live test. Orca behavior references come from
`.spacron/memory/orca-chat-view.md` and `.spacron/memory/structured-chat.md`. Source presence does not prove
provider/version compatibility.

## Previously open gaps, now closed

| Gap | What changed | Where |
|---|---|---|
| 1. Subagent state not durable | Children are written onto the parent record (`StructuredSessionRecord.subagents`) on spawn, report, answer, cancel and exit, and rebuilt by `restoreMcpSubagents` when the chat is restored or an earlier chat is resumed in the pane. They are pruned with the record (50 records, 20 children, 30 timeline entries each) instead of living in a second storage key. | `mcp-subagents.ts`, `session-store.ts` (`recordSubagentSnapshot`, `restoreRecordSubagents`) |
| 2. Child creation used the active project | `spawnMcpSubagent` reads the parent record's `projectId` and `cwd` (`resolveParentSession`) and passes both into worktree creation and `spawnAgentPreset`. The active project is only a fallback for a pane that has no record yet, and every child stores that record id as `parentRecordId`. | `mcp-subagents.ts` |
| 3. Runtime signals were the only source of truth | Each child keeps a short durable timeline (`log`: spawn, reports, answers, cancel, exit, restore). A `done` report is the only thing that marks a child `completed`; a process that goes away without one becomes `exited` with its exit code, and a child whose session is gone after a reload becomes `lost`. Neither is presented as a result. | `mcp-subagents.ts` (`handleSubagentReport`, session watcher, `reconcileRestoredChild`) |
| 4. Spacron-managed looked like provider-native | Every child carries `origin` (`native` / `spacron`), shown as a badge on its card; native spawning is only attempted when the adapter implements `spawnSubagent` **and** declares `subagents.spawn`; the create form says which one will be used; `/subagent` says which one happened. Antigravity no longer claims native subagents it does not implement. | `registry.ts` (`providerOwnsSubagents`), `StructuredChatView.tsx`, `acp-session.ts`, `commands.ts` |
| 5. Capability declarations vs wording | `rewindMode` / `forkMode` state *how* each operation is carried out: Codex is `native-provider`; Claude is `conversation-reset` / `journal-branch`. `/rewind` and `/fork` now name the fallback and say that files on disk are unchanged (rewind never reverts the workspace). `/compact` decides native vs local from the capability alone. | `provider.ts`, all adapters, `commands.ts` |
| 6. No behavior map for Chat Settings | The map is below. Every row is honoured by the structured view except queue follow-ups (no PTY) — appearance, turn diffs, pull requests/CI, link previews, timestamps, suggested prompts, new-message marker, spellcheck, scroll-to-latest and usage auto-continue included — and the two access stores now have controls in Settings → Chat. | `StructuredChatView.tsx`, `ChatSettingsPane.tsx`, this document |

## How a child's result reaches the parent

Deliberate: **it does not arrive as a chat message.** The child's final report, question, exit detail and
timeline stay on its card in the parent chat, are persisted on the parent record, and survive a reload. A
child's answer/question round-trip goes to the child (`answerMcpSubagent` → `sendOrchestratorFollowUpWhenReady`).
Injecting a child's report into the parent agent's own conversation would start a turn the user did not ask
for, so that stays a user action: read the card, or open the child's pane.

## Chat Settings behavior map

Every option in Settings → Chat (`ChatSettingsPane.tsx`), as it behaves inside a **structured** chat:

| Setting | In a structured chat |
|---|---|
| Open new agents in (Chat / CLI) | **Supported** at launch: it decides which kind of pane a new agent gets. |
| Default launch mode per agent | **Supported** at launch, same switch, per agent. |
| Appearance: match terminal | **Supported** (same `data-match-terminal` contract and CSS vars as the terminal-backed chat). |
| Appearance: contrast | **Supported** (shared `contrastVars`). |
| Appearance: font family / text size / code text size / width | **Supported** (same CSS vars: `--tc-font-family`, `--tc-font-size`, `--tc-code-size`, `--tc-col`). |
| Reset chat appearance | **Supported** (it only writes the appearance store). |
| Turn diffs | **Supported**: each turn ends with `TurnChanges`, built from the provider's tool calls. Claude sends edit arguments as `toolData`; Codex and the ACP agents send them as JSON or a patch in `toolInput`, which the view normalizes — a tool that reports neither shows no diff. |
| Opened pull requests / CI result lines | **Supported**: a tool row whose command opened a PR (`gh pr create` and the like) gets the same `PullRequestCard`, with CI checks when that setting is on. |
| Inline visuals | **Supported**: a chat pane asks the same backend for its visuals folder at launch and passes `SPACRON_CHAT_VISUALS_DIR` to the agent's own process; a reply's `::spacron-visual{…}` renders through the same `ChatVisual` frame as the terminal-backed chat. |
| Permissions for new chats (and per-agent permission mode) | **Supported**: `structuredAccessFor` maps the setting to the provider's access modes, intersected with the provider's `supportedAccessModes`. |
| Continue chats automatically when a usage limit resets | **Supported**: the usage-limit notice at the end of the conversation is read with the same parser as the terminal-backed chat, shown as `UsageLimitRow`, and continued once it resets. |
| Queue follow-ups | **Intentionally inapplicable**: there is no PTY to type into. A mid-turn message is steered or queued according to the provider's `steering` capability, shown in the composer placeholder. |
| Scroll to latest when sending | **Supported**. |
| Mark new messages when returning | **Supported**: the same "New" divider, above the first block that arrived while the reader was scrolled up or the window was hidden. |
| Link previews | **Supported**: the shared Markdown renderer's hover reaches the structured view through the same `RichContext` the terminal-backed chat uses. |
| Spellcheck and autocorrect | **Supported**. |
| Show timestamps | **Supported**, with a caveat: providers send no per-message time, so the time shown is when this view first saw the message in the current app run. |
| Suggested prompts | **Supported**: the empty state offers the same starter prompts. |
| Account selection (Settings → Agents → accounts) | **Supported**: the account is resolved at start and recorded on the session record. |

Two related stores that used to have no control at all now have rows in the same Behavior card:

- **Default access for new chats** (`chatDefaultAccessMode`) — inherit / asks for approval / auto-edit files /
  auto / full access; `structuredAccessFor` reads it first and falls back to the per-agent permissions.
- **Answer safe read-only requests automatically** (`chatAutoAnswerInline`) — read by the ACP, Claude and Pi
  approval paths; reads and searches are approved, commands and edits still ask.

## Provider live verification still open

Handshake/switch checks were previously recorded by hand for Claude, Codex, Pi, OpenCode, Grok, Antigravity
and Cursor; Copilot, Kimi, Hermes and OMP were never verified (not installed). Recent changes need a new
acceptance pass. For each provider/version, check: launch and successful response, account selection,
permissions/approvals, text/images, tools/activity, model/effort, steering/queue, compact, rewind/fork,
subagent creation/answer/cancel, context usage, restore/resume, and switching to/from the CLI. The
capability table below is what to check against.

| Provider | rewind | fork | compact | steering | subagents (native) |
|---|---|---|---|---|---|
| Codex | native thread rollback | native thread fork | native | inject | no |
| Claude | conversation reset | journal branch | native | inject | no |
| Pi | none | none | journal only | queue | no |
| Antigravity | none | none | journal only | queue | no |
| OpenCode | none | none | journal only | queue | no |
| Cursor | none | none | journal only | queue | no |
| Grok / Copilot / Kimi / Hermes / OMP | none | none | journal only | queue | no |

In every row, rewind changes conversation state only: no path reverts files in the workspace.

## Orca reference freshness

The comparison notes describe an inspected Orca build, not necessarily the latest release. A current
product comparison is still needed before claiming parity.

## Conclusion

The structured-chat and subagent workflows are present in code, and the durability, ownership, capability and
settings gaps from the previous revision are closed, including every Chat Settings row: each is supported in
the structured view except queue follow-ups, which has no meaning without a PTY. What is left is live provider
verification and a current Orca comparison.

## Orca chat parity pass (source comparison, November 2026)

Compared against Orca `main` (`src/renderer/src/components/native-chat/**`,
`src/shared/native-chat/input/commands/native-chat-slash-commands.ts`) and
`onorca.dev/docs/agents/native-chat`. Cross-surface items (paired remote servers, mobile Chat UI,
provider-native drivers for Grok/OpenCode/OMP) are out of scope for this pass.

Closed in the structured chat view:

- Find (`Ctrl/Cmd+F`), the message rail with one mark per prompt, select-a-reply → **Add to chat**,
  and jump-to-latest with a count.
- **Rewind to here** on the last prompt (slices the journal at that message and puts its text back in the
  composer) and **Fork** from the last reply. The fork now starts from the parent's folded history instead of
  an empty journal, and the rolled journal carries its snapshot instead of dropping it.
- Up/Down prompt recall in an empty draft; the unsent draft is kept per pane across reloads.
- `@` file mentions, and a `/` menu merging chat commands, agent-owned commands (`/goal`, `/plan`, `/mcp`,
  `/init`, `/review`, `/help`) and discovered skills (`$` skills for Codex).
- Command output renders (it used to be pushed into a memo and vanish); an answered approval leaves a
  receipt line; `/compact` typed mid-turn runs when the turn ends instead of being refused.
- To-do checklist from `TodoWrite`/`update_plan`, turn elapsed seconds, **Sending…/Not sent + Retry**, a
  searchable model list, and a context-ring tooltip with used/free tokens.
- Attachments: images attach as paths (chips with previews, clipboard paste supported) and other files go
  into the draft as paths. Each provider reads the file the way its protocol takes it: Codex sends
  `localImage`, while Claude and every ACP agent inline the bytes as base64 (the same image-only,
  size-capped `chat_image_preview` reader the chips use), so an ACP chat receives real `image` content
  blocks in `session/prompt` instead of dropping the attachment.
- Code-block **Copy** was already at parity: the shared Markdown renderer adds it in both views.

Also closed in this pass:

- **Question cards**: an ACP permission request's own options are shown as numbered answers (1…9 on the
  keyboard, or a click) and answered with the agent's exact `optionId`, instead of being flattened into
  Allow / Allow for this chat / Decline. Codex and Claude offer no option list and keep those three answers.
- **Inline visuals** in structured replies: a chat pane gets its own visuals folder at launch.
- **Crash recovery**: a send that was in flight when the app closed is reported on the next start with
  **Send again**, unless the restored transcript already shows that message.
- **Automatic chat naming**: a chat still carrying its agent's name is named after its first prompt; a
  rename, resume or fork keeps the title it was given.

Also closed (second pass, in the **mounted** view — see the note at the end):

- **Per-pane chat tabs**: a tab strip lists the pane's conversation plus every other open chat of the same
  agent and project. Clicking one resumes it here (the current chat is detached, not closed); `×` archives a
  chat that is not current; `+` starts a new conversation in the tab.
- **Background-task strip with per-task stop**: running children and in-flight tool calls show above the
  composer. A child has its own **Stop**. A tool row cannot be stopped alone by any of these protocols, so
  its button is labelled **Stop turn** and interrupts the turn — it does not claim to stop one tool.
- **Plan chip**: an ACP agent that advertises a `mode` config and is in its plan mode shows a `Plan` chip
  beside the model. Other ACP modes (OpenCode's build, Cursor's agent) are personas, so they are not shown.
  Plan *rows* were already the to-do dock.
- **Archive**: `/archive`, `/archived`, `/unarchive <n|id>` (also the tab `×`). An archived chat leaves the
  tabs, `/history` and cold restore but keeps its journal, native id and title on disk.
- **Side chats**: `/side [first message]` branches this conversation into its own tab and sends the message
  there. It is a real branch — the chat you came from is untouched and one tab click returns. It is not a
  drawer over the current chat, which is what Orca's side chat looks like.
- **Signed-out / auth card**: when a start fails with an auth-shaped error, the view shows which agent needs
  the sign-in, where to finish it, and Retry / Open terminal buttons. Spacron never invents a credential
  exchange for a CLI whose sign-in lives in its own process.
- **Automatic chat naming** now only applies to a chat Spacron opened (`origin: 'chat'`). A CLI conversation
  switched into chat keeps the title its terminal gave it, and a rename or fork keeps its title.

Also closed (third pass, against the current Orca native-chat docs):

- **Unsent draft + attachment paths persist with the pane** (`structured-chat/drafts.ts`, bounded to 60k
  characters and 12 attachments). Thumbnails are re-read through `chat_image_preview` after a reload.
- **Up/Down prompt recall** in the live composer, alongside the existing `/`, `@` and skill menus.
- **Answered request receipts**: the journal's paired `approval.requested` / `approval.resolved` events
  render as muted receipt lines under the transcript, with the option label that was actually chosen.
- **Goal mirror with controls**: `/goal <text>` still passes through to the agent, and now also records the
  objective; the panel above the composer shows it with state and elapsed, and Pause / Resume / Clear send
  `/goal …` to the agent before updating the mirror. Spacron never claims the agent's goal changed on its
  own.
- **Richer background panel**: one row per running child with a state dot, assignment, elapsed time and its
  own **Stop**; in-flight tool calls collapse into one row whose button says **Stop turn** (no protocol here
  can stop a single tool).
- **Unread dot** on the chat tab when a turn finishes while the window is hidden; focusing the composer
  clears it.
- **Drag and drop onto the composer**: an explorer drag (or any text drag carrying paths) attaches image
  paths as chips and quotes other paths into the draft; an image file dropped from a plain-browser session
  is saved and attached like a pasted one. `parseDroppedPaths` handles one-per-line and quoted paths.
- **`Settings → Chat → Chat names`**: automatic names from the first message can be turned off; renaming a
  chat always keeps your title, and a CLI conversation switched into chat is never renamed.

Still open, and why each is not built here:

- **Per-*command* stop, and rows for shells that outlive their tool call** — no adapter (Claude, Codex, ACP, Pi)
  lists background shells or monitors, and none can stop one tool, so a detached shell whose tool call has
  already returned is invisible and Stop stays **Stop turn**. (Closed part: running tool calls are now grouped
  by kind — Shell / File edits / Web / Tools — for every agent, with the command or path as detail and a
  `detached` note for Claude's `run_in_background`; `structured-chat/running-tools.ts`.)
- **Child agents as indented rows in the workspace sidebar** — closed: an agent row in the project sidebar
  that is a structured chat lists its running children (plus the last three ended ones, dimmed) as indented
  rows with a status dot; clicking one opens it. The row's icon carries an unread dot when the chat finished
  while the window was hidden (`SessionChatChildren.tsx`, rendered from `ProjectHUD.tsx`). A collapsed project card
  also shows an unread dot when any chat in it finished while the window was hidden
  (`ProjectChatUnreadDot`). Not done: the new rows and dots have not been viewed in the running app.
- **Chats to resume** — closed in part: a new, empty structured chat now lists up to five earlier chats of the
  same agent and project (`EarlierChats`), one click to resume, alongside `/resume <n>`. Not built: a
  status-bar item, which would need a global entry point outside the chat.
- **Model-generated chat names** — closed as an opt-in: Settings → Chat → "Model-written chat names"
  (`chatModelNames`, off by default). It keeps the first-message name, then asks the configured AI provider
  (`generateAiThreadTitle`) once per chat and renames only if the title is still the one Spacron set. It
  sends the first message to that provider and spends its credits, which the setting says.
- **Claude's `AskUserQuestion`** — closed: it arrives as a `can_use_tool` request, never auto-allowed, and each
  question is now a card whose options are the answers (`claude-questions.ts`); the answers go back as
  `updatedInput.answers` once every question is answered. Per agent (checked 2026-11-21):
  - **Claude** — verified live: the request shape matches and answering by question text made it report the
    choice.
  - **Grok** — verified live: it sends `_x.ai/ask_user_question`; replying
    `{outcome:'accepted', answers:{<question>:<label>}}` made it report the choice, and `{outcome:'skip'}` makes
    it ask in text (`acp-questions.ts`).
  - **Cursor** — `cursor/ask_question`, built from cursor-agent's source, **not run** (the account was out of
    plan). Until now its own fallback re-asked single-select questions as permission cards and dropped
    multi-select ones.
  - **Codex** — `item/tool/requestUserInput` (experimental), built from `codex app-server generate-json-schema`
    (codex-cli 0.171.0; `codex-questions.ts`), **not run**. Options-only: a free-text or secret question is
    still rejected rather than answered wrongly.
  - **Antigravity, OpenCode** — send no request. Antigravity prints the question and ends the turn; OpenCode
    (launched with its question tool disabled) says it "couldn't display" it and asks in text. You answer with
    an ordinary message, so there is nothing to add. A quick-reply chip row built from the tool call's input
    would be a different feature.
  - **Pi** — not checked. **Copilot, Kimi, Hermes, OMP** — not installed here, so not checked.

  Multi-select questions take one answer in every case.
- **Fast mode / provider speed pill, `Use your shell environment`, per-category context breakdown** — an earlier
  version of this bullet said no provider reports these. **That was wrong in two places** (re-checked
  2026-11-21): Claude's CLI answers a `get_context_usage` control request with per-category tokens (now shown in
  the context ring's tooltip, `contextUsageFrom` in `claude-session.ts`), and Codex's `model/list` carries
  `serviceTiers` / `defaultServiceTier` and `turn/start` takes `serviceTier` — so a Codex speed pill is
  buildable and **not built yet**. ACP agents and Pi were not re-checked for either. `Use your shell
  environment` has no equivalent here.
- **`AskUserQuestion` over ACP** — the question already arrives as a permission request whose options are the
  card's buttons, so there is no Submit step to add (Claude's own protocol is handled above).
- **Proving a crashed send from the provider's own transcript** — the journal records the send and the reply;
  the provider transcripts we can read do not carry a reliably matchable id, so the app keeps the message as
  unconfirmed and offers **Send again** rather than guessing it arrived.

## Which structured view is live

`TerminalChatView` (`structuredAgent` set) is the structured surface the app actually mounts, from
`TerminalPane`. `StructuredChatView.tsx` is **not referenced by any component** — it is dead code, and work
placed only there never runs. Everything in this document was therefore re-checked against the live view:
numbered question-card answers, the crash-recovery send marker, tabs, the background-task strip, the plan
chip, the sign-in card and archive all live in `TerminalChatView` / `StructuredChatExtras.tsx` /
`session-store.ts`, which are on screen. Inline visuals and message actions were already in the live view.
The dead file is left in place (not deleted) because it is not this pass's call to remove another agent's
work; nothing should be added to it.

## Comparison with Orca's current native-chat docs (2026-11-21)

Source: orca.dev/docs/agents/native-chat plus its Settings and tabs pages, read through a fetch agent (a
paraphrase, not the pages verbatim; the pages carry no version or date). The installed Orca build on this
machine was **not** inspected. "Aligned" below means found in our code, not exercised side by side.

**Aligned (found in code):** message rail; find; `@` files; Up/Down recall; add-to-chat quoting; drag-drop and
paste attachments; unsent draft kept; `/` menu merging commands and skills; `/clear`, `/compact` (queues when
sent mid-turn), `/fork`, `/goal`, `/plan`, `/mcp` passed through; rewind and fork from the last turn;
Sending…/Not sent + Retry (unconfirmed when not provably undelivered); answered requests kept as receipts;
numbered question options; to-do checklist; turn changed-file summary with diffs; chat tabs; unread dot;
usage-limit auto-continue; copy button on a sent message; background strip with per-child stop; child agents
under the session in the sidebar; automatic names; Chat/CLI per agent; hand off; inline visuals.

**Fixed in this pass:** `/btw` now works as an alias of `/side` (Orca's name for a side chat); the context ring
shows Claude's per-category breakdown; question cards for Claude, Grok, Cursor, Codex (above).

**Differs, by design:** the side chat is a branch in its own tab, where Orca's `/btw` opens a fork beside the
original; "Queue follow-ups" has no PTY meaning here; naming uses the first message unless the opt-in model
naming is on, where Orca names with the chat's own agent by default; question cards answer on the click or
number key, where Orca adds a **Submit** step.

**Not aligned (Orca documents it, we do not have it):**
- **Rewind to here** and **Fork from this response** on any finished turn; ours act on the last one only
  (Claude rewind is offered on any prompt; Fork only on the last reply).
- **Continue** on a reply that was cut off (no per-provider signal for "cut off" was found; the usage-limit
  continue exists).

**Corrected after re-checking (2026-11-21):** an earlier version of this section said Ctrl/Cmd+Enter and a
per-card Steer were missing. They are present: Ctrl/Cmd+Enter sends into the running turn, with an empty
composer it steers the first queued card, and each card has "Send now, into the running turn". The grep that
missed them looked for the key check and `ctrlKey` on one line.

**Closed in this pass:** long sent messages fold behind **Show more / Show less** (`chat-fold.ts`); a failed
structured turn puts queued follow-ups **on hold** with a **Resume** button instead of firing them into the
same failure.
- **Settings:** stop idle chat agents after a while; resume working chats after a restart; a chosen naming
  agent; "Use your shell environment".
- **Status-bar "chats to resume"** item.
- **Dedicated subagent view** with "Back to main agent" / Escape (ours: cards, and the child's own pane).
- **Fast mode / speed** for Codex (and Cursor): the data exists (see above), no pill yet.
- **Stop one Codex task or Grok background command from its row.** The Codex 0.171 schema has
  `command/exec/terminate`, which stops commands the *client* started, not the agent's own tool commands; no
  per-task stop method was found. Grok was not checked. Treat Orca's claim as unverified here.
- **Signed-out warning before send** for Codex, Pi, OMP (ours: the sign-in card appears after a failed start).
- **Remote/paired servers, mobile Chat UI, Hermes/Copilot/Kimi/OMP structured drivers** (out of scope, and the
  last four are not installed here).

## Agent History (Orca's "Agent Session History"), added 2026-11-21

Orca's panel is an index of past sessions read from each CLI's own transcripts, with Resume actions. Spacron's
equivalent is a **History tab inside the Sessions panel** (the former "Agent Fleet": Live keeps the review, merge and
discard cards unchanged). The panel and its Live / History switch now show even with no project or no agent open;
previously an early "No agents running" screen hid the switch, so History needed an agent open first.

- **Index** — `src-tauri/src/commands/agent_history.rs`, command `agent_history_list`. Read-only over Claude
  `~/.claude/projects/*/*.jsonl`, Codex `~/.codex/sessions/**.jsonl` and OpenCode's `session_v2` SQLite. Rows are
  cached by (modified time, size), so only changed files are re-parsed. Checked against this machine: 24 real
  sessions across the three agents listed in about half a second; 4 Rust unit tests.
- **Panel** — `AgentHistoryTab.tsx` and `services/agent-history.ts`: search, a Project / All scope (a project
  includes its worktrees), Refresh, "N shown · M recent", and an Orca-style **view-options menu**: Agents (check
  list with Select all / Clear), Group (Project, Folder, Agent), Sort (Last updated, Created) and Hide empty
  sessions. Row: **Resume** (new terminal with the CLI's resume flags, in the session's own folder); on expand:
  Resume in chat, **Hand off to another agent**, and Copy resume command / session ID / log path / first prompt.
- **Hand off** — "Hand off to another agent" opens a **modal** (`HandoffHistoryModal.tsx`): the source session,
  the agent to hand over to, Chat or Terminal, and the exact context that will be sent, **editable** (with Reset).
  Behind it, `readHistoryHandoffSource` reads the session back from the CLI's transcript by id,
  `buildHistoryHandoffPrompt` builds the text, and `handOffFromHistory` delivers what the person approved using the
  same delivery as a live handoff. The original session is untouched. Unit-tested with mocks (8 tests in
  `handoff-coordinator.test.ts`); not run against a real agent.
- **Row layout** — the button beside each row is **Show details** / **Hide details**; inside are Resume in
  terminal, Resume in chat, Hand off to another agent and the copy actions.
- **Resume in chat** shows the earlier conversation: a resumed CLI session is not replayed by the provider, so
  `quickSpawnAgent` reads the CLI's transcript by id into the pane's history (the same way switching a terminal
  to chat does) and names the chat after the session. Before this, it opened a blank chat that continued the
  conversation without showing it. Not seen against a real resume yet.
- **Empty chats are hidden** from the tab strip, `/history`, `/resume` and the "Pick up an earlier chat" list
  (`recordHasConversation`): a chat still on its default name with no prompt sent. They are hidden, not deleted.
- **Buttons** — `global.css` clears every button border and any class named `-chip`/`-menu`/`-card`, which is why
  the first version's buttons looked like plain text. They are now fills plus `box-shadow` rings.
- **Icons** — the brand marks have no size of their own (`.agent-brand-mark` fills its container), so each row
  and menu item wraps the mark in a fixed 16px box.
- **Resume plumbing** — `quickSpawnAgent` takes `resumeId`; both the terminal and chat paths use it.
- **Not built** — Cursor, Grok, Antigravity, Pi, Copilot and the other agents Orca lists (each needs its own
  parser); Open / Reveal log and Open cwd; drag a row into the workspace; the status-bar entry point; searching
  inside sessions across computers; Orca's "Resume" being unavailable once a conversation is reserved for chat
  (we do not track that).
- **Not seen in the running app.** The Rust side was run against real data and the TypeScript is tested and
  typechecked, but the tab itself has not been opened in the app window.

**Agent names without "CLI" (2026-11-21):** the preset and display names are now Codex, Grok, Gemini, GitHub Copilot
and Kimi (`stores/runs.ts`, `stores/terminal.ts`, Settings' Codex section, and the Rust usage and account lists in
`usage.rs` / `agent_accounts.rs`). Descriptive prose that says "the Codex CLI" (the program) is unchanged, as are the
"CLI" Chat/CLI view toggle and "CLI default" model labels. The orchestrator still understands "use Codex CLI".

### Live check of Resume in chat, and fixes from it (2026-11-21)

Driven in a second debug instance of the app over its debugging port (see `drive-the-real-app-at-any-size`).
- **Claude** — verified: a chat opened beside the terminal with the earlier conversation, the long first message
  folded behind "Show more".
- **Codex** — the earlier conversation showed, but Codex itself said "no rollout found for thread id". Cause:
  Spacron launches Codex under the selected **account's own home** (`<app config>/agent-accounts/codex/<id>`),
  while History read only `~/.codex`. Fixed by indexing every managed account home (Codex now lists 14 default-home
  and 19 account-home sessions on this machine, the 19 having been invisible), recording each row's `account`,
  and resuming under that account (`accountId` on `quickSpawnAgent` and the chat `start`; the transcript reader
  takes `account`). **Re-verified after the rebuild:** an account-home Codex session resumed in chat with no
  "no rollout" error and showed its earlier conversation; History for this project went from 21 to 37 sessions.
- **OpenCode** — verified: the earlier conversation loaded. It logged React "two children with the same key" for
  repeated `chatcmpl-tool-…` ids (not fixed; likely the transcript or view keys).
- **Sessions from another folder** — the backend refuses terminals outside an open project ("Access denied: path is
  outside any open project"), so Resume did nothing. The buttons are now disabled for those rows with an
  explanation, plus "Open <project>" when the folder belongs to another Spacron project.
- **Not checked live:** Hand off (still only mocked), and account-owned Claude sessions (no Claude account exists
  here).

### Diff panel and right drawer (2026-11-21)

- **Garbled diffs** — the diff tokenizer numbered its regex groups, but two patterns carried their own capture
  group, so every later index was off and spaces and punctuation were dropped. Lines glued into one unbreakable word
  and ran off the panel. It is now `diffTokenize.ts` with named groups and a test that no character is ever lost.
- **3D lip** — the global scroll-edge shadow (a recessed inset on every scroll area) and a 12px
  `padding-bottom` on the drawer body. The right drawer sets `--scroll-edge-color: transparent` (the global rule now
  reads that variable) and drops the padding, so every tab is flat and runs to the bottom edge.
- **History "All"** groups by project, and folders that are not Spacron projects get their own group.

### Chat tabs removed, Jump to latest fixed, History folders collapse (2026-11-21)

- **Removed from the chat:** the strip of chat tabs under the composer and the "Pick up an earlier chat" list.
  Clicking a tab swapped in a chat whose conversation was not loaded, so it landed on that empty list. Earlier
  conversations are resumed from Sessions > History, which loads them. This supersedes the earlier entries above
  for per-pane chat tabs and the resume list (`ChatTabStrip` is still defined but no longer rendered).
- **Jump to latest** shifted right on click: it was centred with `translateX(-50%)`, and `global.css` sets
  `transform: scale(0.96) !important` on every pressed button, which replaced the centring. It is now centred with
  margins. Verified by pressing it in the app (0 px shift; the old centring shifted 68 px).
- **History groups** collapse and expand (chevron, count kept), the choice is remembered, searching keeps every
  group open, and the view menu has Collapse all / Expand all.
