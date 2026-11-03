# T3-style Conversational Mode for Spacron

Status: Revised for orchestrator conversational mode. Conversational mode is the
user-facing interface to the existing Spacron orchestrator, with multiple
independent conversations inside each project. Each conversation keeps its own
transcript, draft, AI provider, model, and access policy while sharing the
project's tasks, agents, memory, and knowledge.

Status update: shipped in Spacron 5.0/5.1. The plan below is kept as the record
of the design; where the shipped app deliberately diverges from it (the plan
card, realtime voice, queued messages) the divergence is called out inline and
summarised under [Post-launch divergences](#post-launch-divergences).

This document describes the step-by-step plan for adding a project-scoped,
T3-style chat experience to Spacron while preserving the existing CLI mode.

## Product decision

Spacron will have two separate ways to work:

1. **CLI mode** — the existing terminal-first workspace. Users see and
   interact with live agent terminals directly.
2. **Chat mode** — a chat-first workspace organized around projects, threads,
   and selected agents. Users interact with agents through a conversation
   interface similar to T3 Code, Codex, and other agent chat applications.

Switching modes changes the presentation, not the underlying work. Running
agents, terminal sessions, projects, tasks, and conversations must remain live
and available when the user switches between CLI and Chat mode.

## CLI freeze boundary

The existing CLI mode is considered complete and is out of scope for this
project. The implementation must not redesign, refactor, or otherwise change:

- Terminal pane layout or resizing
- PTY creation, lifetime, fitting, repainting, or input delivery
- Agent CLI launch commands or provider detection
- Terminal session stores or session restoration
- CLI room behavior, terminal shortcuts, or terminal-specific voice targeting
- Existing agent worktree, lease, or terminal lifecycle behavior

Chat work must be implemented in Chat-mode components, thread/message stores,
and narrowly scoped orchestration/voice integration seams. An AppShell change
is allowed only when it is strictly necessary to switch surfaces without
unmounting the existing CLI rooms. If the existing mode switch already
provides that seam, AppShell and all terminal code should remain unchanged.

The current interaction-mode switch and the mounted CLI/chat surfaces are the
starting point for this separation. The existing terminal instances must stay
mounted while the visible surface changes.

## What “T3-style” means here

The chat mode is not one large project-wide conversation with an activity
sidebar. It is a thread workspace:

```text
Project
  ├─ Planning thread
  ├─ Implementation thread · Working
  ├─ Review thread · Needs input
  └─ + New thread

Main panel
  ├─ Thread header and selected agent
  ├─ User and agent messages
  ├─ Plans, tool activity, approvals, and questions inline
  └─ Thread composer with agent, dictation, and file attachments
```

Each thread represents a focused task or conversation. A user can switch to a
different thread or agent while another thread continues working in the
background.

T3 Code’s own documentation describes project-scoped threads, background
thread creation, and thread organization in the sidebar:

- https://github.com/pingdotgg/t3code/blob/main/docs/user/thread-sidebar.md
- https://github.com/pingdotgg/t3code/blob/main/docs/user/install.md

## User experience requirements

### CLI mode

- Preserve the existing terminal layout, agent panes, room controls, and CLI
  interaction.
- Do not replace terminal sessions with chat sessions.
- Do not stop, unmount, or recreate a live terminal merely because the user
  switches to Chat mode.
- Keep all CLI-specific features available through the actual CLI.

### Chat mode

- The left project sidebar contains the project’s threads and active agents.
- The main panel is dedicated to the selected thread.
- Remove the current right-side activity/context column from the main chat
  panel.
- Show the selected agent, provider, task, and status in the thread header.
- Keep the composer inside the selected thread, not in a detached global bar.
- Preserve drafts independently for each thread.
- Keep the composer available while other agents are working.
- Allow a user to select another agent/thread and send a message without
  interrupting the first agent.
- Keep the composer visually centered when a new message is being started,
  while still allowing normal transcript scrolling.

### Inline agent interaction

Agent questions and approvals should appear inside the thread as chat cards,
not as unexplained global toasts or detached activity rows.

Examples:

- “I need permission to continue.”
- “Which implementation should I use?”
- “Choose isolated worktree or main repository.”
- “Review these changes before I continue.”
- “The agent is blocked and needs a file path.”

Inline cards should support the interaction required by the agent:

- Yes/no or approval buttons
- Choice buttons
- A short text response
- Open terminal / focus agent action
- Dismiss or defer where safe

Destructive or application-wide actions may still use a modal confirmation when
necessary. The normal agent conversation should stay inside the thread.

## Thread and message model

The current project-level flat chat history needs to become thread-aware.

### Thread

Each thread should contain:

- `id`
- `projectId`
- `title`
- `agentName`
- `agentPreset`
- `taskId`
- `sessionId`
- `status`
- `createdAt`
- `updatedAt`
- `lastActivityAt`
- `unreadCount`
- `draft`
- optional pin/order metadata

Suggested statuses:

- `draft`
- `idle`
- `working`
- `needs-input`
- `complete`
- `failed`
- `archived`

### Message

Messages should support more than plain user/assistant text:

- User message
- Agent response
- Orchestrator response
- Plan progress (the live `update_todos` ticker above the composer, not a
  transcript message)
- Tool/activity event
- Approval request
- Input request
- Completion summary
- Failure or blocked state
- System/thread event

Every message must carry its `threadId`. Legacy messages without a thread ID
should migrate into a default project thread instead of being deleted.

### Drafts and queued messages

- Each thread gets its own draft.
- Drafts survive switching threads and projects.
- A user can prepare a message for Agent B while Agent A is still working.
- A user can send a follow-up to a running agent without disabling the
  composer.
- If the target agent cannot accept the message immediately, show it as queued
  in the thread rather than silently dropping it.

## Sidebar design

The existing project list already knows about projects, running sessions, open
rooms, and orchestrator tasks. It should become the navigation surface for
Chat mode.

For each expanded project, show:

- Project name and active state
- New thread button
- Active/working threads
- Threads needing user input
- Recently completed threads
- Existing agent/session rows where no chat thread exists yet

Each row should show:

- Agent or thread name
- Short task title
- Provider icon or label
- Working/waiting/complete status
- Unread marker
- Optional terminal-open marker

Selecting a row should open the matching Chat thread in Chat mode. A separate
action should remain available to open the underlying CLI terminal.

### Thread lifecycle actions

Thread rows should expose the standard conversation actions without leaving
Chat mode:

- Create a new thread
- Edit or rename a thread
- Pin or unpin a thread
- Delete a thread with confirmation
- Keep the active-thread selection valid after deletion, choosing the nearest
  remaining thread or creating a fresh empty thread when none remain

The first version should use simple ordering by pinned state, active status,
and recent activity. Manual reordering, archiving, and filtering can follow
after the core flow is stable.

## Main chat panel

The full room should contain:

1. A compact terminal-style thread header
2. Selected agent identity and status
3. New thread / thread navigation controls
4. The full transcript
5. Inline plan, tool, approval, and input cards
6. A composer that belongs to the active thread

The empty-thread state should center the composer and offer a small set of
useful actions. Once messages exist, the transcript should occupy the main
space and the composer should remain easy to reach without permanently
consuming the whole lower edge of the room.

## Composer design

The composer should include:

- Multiline text input
- Themed AI provider and model selectors inside the composer
- Per-thread Default or Full agent-access selector
- Send button
- Dictation/transcription button
- File attachment button with removable attachment chips
- Working/queued state
- Keyboard shortcut hint

### Provider and model selection

Provider and model are separate composer controls. The user must be able to
choose the exact model for the next message, including free models exposed by
OpenAI-compatible providers and models from other configured providers. The
composer should:

- Show providers available to the current installation/configuration.
- Update the model options when the provider changes.
- Prefer the live provider model catalogue when available, with curated models
  as a fallback.
- Mark free models clearly when the provider reports that metadata.
- Preserve the selected provider/model with the conversation, while falling
  back to the last composer choice for new conversations.
- Pass the selected provider and model through the orchestrator request so the
  choice affects the message being sent, rather than only changing display.

Settings manages provider connections and API keys; it does not select the
orchestrator model. API providers call their native endpoint. ChatGPT-plan
access is a separate Codex-account connector because ChatGPT subscriptions and
OpenAI API billing are separate. OpenCode Go uses its subscription API key.
Reasoning is provider-default and is not exposed in the composer.

### Sending behavior

- Sending to a new thread routes through the orchestrator and creates/attaches
  an agent task.
- Every message first returns to the orchestrator brain. The orchestrator may
  send a follow-up to a live agent, open another agent, or answer directly.
- Sending to another agent while the first is working is allowed.
- The composer is disabled only when there is no valid project/target or the
  draft is empty—not simply because another message is pending.
- Each pending send displays its own working or queued state.

## Agent responses and activity

Spacron agents currently run through live terminal sessions, so not every CLI
provides structured chat events. The first implementation should provide a
reliable unified experience from the data Spacron already owns:

- Live working status
- Structured task activity events
- Cleaned transcript output where available
- Inline needs-input/blocked cards
- Final completion response or summary
- A clear link to focus the underlying terminal

The response bridge should be adapter-based:

1. A common thread interface in the Chat UI
2. An orchestrator adapter for Spacron-managed tasks
3. A terminal/transcript adapter for agents without structured events
4. Future provider-specific adapters when a CLI exposes richer message data

The UI must not invent an agent response from a missing transcript. When only
status is known, it should say that the agent is working or waiting and offer
the terminal view.

## Dictation and attachments

### Dictation

Add a microphone button inside the thread composer:

1. Focus the active thread’s textarea.
2. Start the existing transcription service.
3. Insert the transcript into the current draft.
4. Let the user edit the result.
5. Send only when the user presses Send or the configured shortcut.

The existing global transcription shortcut remains available. The chat button
is simply a direct entry point that guarantees the composer is the target.

The composer also has a realtime voice button (and the global bare-Alt gesture
routes into it while Chat mode is active). Voice exchanges stream into the
thread as normal messages. The original plan kept live voice out of Chat mode;
that restriction was dropped after launch, so dictation is no longer the only
voice input here.

### File attachments

The composer accepts up to five files at a time, with a per-file size limit.
Text-like files are read into bounded prompt context and every attachment is
kept on the user message so the thread remains auditable. Binary files retain
their name, type, and size without being copied into local storage as a large
blob; the agent can still be directed to inspect them from the project.

## Persistence and migration

- Add thread metadata storage keyed by project.
- Add thread-aware message storage.
- Preserve existing `spacron_orchestrator_chat` messages through migration.
- Move legacy messages into a default thread.
- Persist per-thread drafts with a small debounce.
- Restore the selected thread per project.
- Reconcile working threads against live terminal sessions on startup.
- Never show a thread as working when its session no longer exists.
- Keep task and terminal persistence separate from visual thread state.

The one-time prototype-message reset should be removed or replaced by an
explicit migration. Real user history must never be cleared automatically once
the new thread model ships.

## Implementation phases

### Phase 0 — Contracts and migration

- Define thread, message, status, and inline-request types.
- Decide the local persistence format.
- Migrate legacy project chat into a default thread.
- Add pure store tests for migration and project isolation.

### Phase 1 — Sidebar thread navigation

- Add thread rows below expanded projects.
- Show live agent/task status.
- Add new-thread action.
- Add thread rename/edit, pin/unpin, and delete actions.
- Preserve a valid active-thread selection after delete.
- Select and restore the active thread.
- Keep CLI terminal actions available separately.

### Phase 2 — Full T3-style Chat room

- Remove the right-side activity/context column.
- Add selected-thread header.
- Render thread-aware messages.
- Add inline plan, activity, approval, and input cards.
- Preserve centered empty-thread composer behavior.

### Phase 3 — Direct agent routing

- Export a safe shared follow-up function for live agent sessions.
- Associate threads with tasks and terminal sessions.
- Send directly to the selected running agent.
- Support multiple simultaneous pending messages.
- Add response attribution and completion updates.

### Phase 4 — Themed composer controls

- Replace the native agent selector with the shared `Dropdown`.
- Add composer-level provider and model selectors.
- Add per-thread Default and Full access selectors.
- Load live model catalogues when available and fall back to curated models.
- Mark free models and pass the selected provider/model into the orchestrator.
- Persist the composer’s provider/model choice per thread, with global defaults
  for new threads.
- Add provider/status metadata to options.
- Test dark, light, system, and custom theme states.
- Add keyboard navigation and accessible labels.

### Phase 5 — Dictation

- Add composer microphone control.
- Focus the active thread before starting transcription.
- Insert and preserve draft text correctly.
- Test cancel, retry, pause, and target-field behavior.

### Phase 6 — Attachments and integration hardening

- Keep attachment metadata with user messages and thread persistence.
- Pass bounded text-file context through both new dispatches and live-agent
  follow-ups.
- Keep the existing realtime voice implementation out of Chat mode.

### Phase 7 — Polish and verification

- Responsive sidebar and main panel behavior.
- Empty, loading, working, waiting, failed, and completed states.
- Smooth thread switching without terminal unmounts.
- Keyboard shortcuts and focus restoration.
- Performance review for many projects, agents, and threads.
- Final check, build, test suite, and manual desktop smoke testing.

## Likely files

These are expected touch points, not a commitment to edit every file:

- `src/lib/components/workspace/ChatModePanel.tsx`
- `src/lib/components/workspace/ChatModePanel.css`
- `src/lib/components/workspace/ProjectHUD.tsx`
- `src/lib/components/workspace/ProjectHUD.css`
- `src/lib/components/shared/Dropdown.tsx` only if a small extension is needed
- `src/lib/stores/orchestrator.ts`
- A new thread store, likely under `src/lib/stores/`
- A shared voice controller/service extracted from
  `src/lib/components/terminal/FloatingPromptBar.tsx`
- Tests for thread persistence, routing, migration, and concurrency

## Acceptance criteria

The work is ready for normal use when:

- CLI mode still feels exactly like the current terminal workspace.
- Switching to Chat mode never stops or unmounts running agents.
- A project can contain multiple independent threads.
- Selecting a thread never mixes another thread’s messages.
- An agent can ask for input and receive the answer inside its thread.
- Agent A can keep working while the user chats with Agent B.
- Running agents produce visible, correctly attributed activity and responses.
- The agent selector is visually correct in every application theme.
- Dictation inserts into the active composer draft.
- File attachments remain visible on the user message and readable text reaches
  the selected agent as prompt context.
- Reloading restores projects, threads, messages, and drafts.
- `npm run check`, `npm run build`, and `npm test -- --run` pass.
- Manual native desktop testing confirms terminal liveness, dictation targeting,
  and file attachment flow.

## Post-launch divergences

These are intentional differences between this plan and the shipped Chat mode.
Keep them in mind when reading the phases above:

- **The plan card is gone.** A turn's plan is the ephemeral `update_todos`
  ticker above the composer (`chatTurnTicker`), not a transcript message. Old
  transcripts that carry a `plan` row have it dropped on load.
- **Realtime voice lives in the composer.** The plan kept live voice out of Chat
  mode; it now ships next to dictation, with its exchanges written into the
  thread.
- **Queued messages are memory-only.** The per-thread FIFO queue (`chatQueues`)
  survives stop and lets a message be steered into the running turn, but it is
  not persisted, so a reload drops what was still waiting.
- **Unread counts are project-sidebar only.** A reply or request that lands in a
  thread you are not looking at increments `unreadCount`; selecting the thread
  clears it. Standalone chats show working state instead of a count.

## Scope boundaries

The first release will not attempt to:

- Replace the native CLI experience.
- Change the existing CLI model or terminal workspace behavior.
- Parse every provider’s terminal output into perfect structured events.
- Start a realtime voice call implicitly or from dictation: the composer's
  voice button is the only way into a live call.
- Add cross-device thread synchronization.
- Add complex thread splitting or multi-pane chat layouts.
- Automatically merge or publish agent work.

Those can be considered after the core project/thread/chat/CLI split is stable.
