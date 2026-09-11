# T3-style Chat Mode for Spacron

Status: Planning

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
  └─ Thread composer with agent, dictation, and voice controls
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
- Plan card
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

The first version should use simple ordering by active status and recent
activity. Pinning, manual reordering, archiving, and filtering can follow after
the core flow is stable.

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
- Themed agent/thread selector
- Send button
- Dictation/transcription button
- Realtime voice mode button
- Working/queued state
- Keyboard shortcut hint

### Agent selector

Do not use a native `<select>` as the final control. Use the shared themed
`Dropdown` component so the menu matches light mode, dark mode, custom themes,
focus styles, and the application’s existing picker language.

Each option may include:

- Agent name
- Provider
- Current status
- Current task title
- Whether it is running in a terminal

The selector chooses the current conversation target. It should not merely
choose a provider preset for a new spawn.

### Sending behavior

- Sending to a new thread routes through the orchestrator and creates/attaches
  an agent task.
- Sending to a running thread sends a follow-up directly to its live agent
  session.
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

## Voice and transcription

### Dictation

Add a microphone button inside the thread composer:

1. Focus the active thread’s textarea.
2. Start the existing transcription service.
3. Insert the transcript into the current draft.
4. Let the user edit the result.
5. Send only when the user presses Send or the configured shortcut.

The existing global transcription shortcut remains available. The chat button
is simply a direct entry point that guarantees the composer is the target.

### Realtime voice mode

Add a separate voice conversation button inside the composer.

- Show connecting, listening, thinking, speaking, and error states.
- Prevent duplicate realtime sessions.
- Preserve the existing voice history behavior.
- Include the active project, thread, and selected agent in the voice context.
- Route coding requests through the same orchestrator path as text chat.
- Append spoken user and assistant turns to the active thread.

The initial version should treat realtime voice as a conversation with
Spacron’s voice orchestrator. The orchestrator can then route work to the
selected agent. Direct speech-to-speech sessions with arbitrary CLI agents are
not assumed to be available.

Spacron’s existing voice implementation already follows this separation:
transcription is speech-to-text, while voice conversation is realtime
speech-to-speech. We should reuse that logic rather than create a second audio
pipeline.

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
- Add provider/status metadata to options.
- Test dark, light, system, and custom theme states.
- Add keyboard navigation and accessible labels.

### Phase 5 — Dictation

- Add composer microphone control.
- Focus the active thread before starting transcription.
- Insert and preserve draft text correctly.
- Test cancel, retry, pause, and target-field behavior.

### Phase 6 — Realtime voice

- Extract reusable voice-session control from the floating prompt bar.
- Add start/stop voice button to the Chat composer.
- Connect voice transcripts to the active thread.
- Pass selected thread/agent context to the orchestrator.
- Preserve voice history and prevent duplicate sessions.

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
- Voice mode starts, speaks, stops, and records the correct thread.
- Reloading restores projects, threads, messages, and drafts.
- `npm run check`, `npm run build`, and `npm test -- --run` pass.
- Manual native desktop testing confirms terminal liveness and microphone flow.

## Scope boundaries

The first release will not attempt to:

- Replace the native CLI experience.
- Parse every provider’s terminal output into perfect structured events.
- Create a separate realtime audio channel for every CLI agent.
- Add cross-device thread synchronization.
- Add complex thread splitting or multi-pane chat layouts.
- Automatically merge or publish agent work.

Those can be considered after the core project/thread/chat/CLI split is stable.

