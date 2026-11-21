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

Still open:

- A goal chip/row (`/goal` is still passed through to the agent as text; no provider protocol here reports
  the goal back, so showing one would be a guess).

## Which structured view is live

`TerminalChatView` (`structuredAgent` set) is the structured surface the app actually mounts, from
`TerminalPane`. `StructuredChatView.tsx` is **not referenced by any component** — it is dead code, and work
placed only there never runs. Everything in this document was therefore re-checked against the live view:
numbered question-card answers, the crash-recovery send marker, tabs, the background-task strip, the plan
chip, the sign-in card and archive all live in `TerminalChatView` / `StructuredChatExtras.tsx` /
`session-store.ts`, which are on screen. Inline visuals and message actions were already in the live view.
The dead file is left in place (not deleted) because it is not this pass's call to remove another agent's
work; nothing should be added to it.
