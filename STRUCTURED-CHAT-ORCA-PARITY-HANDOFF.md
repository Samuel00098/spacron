# Spacron Structured Chat and Context Handoff

## Purpose

Bring Spacron's structured chat behavior closer to Orca while keeping Spacron's existing UI, settings, slash commands, model pickers, effort controls, approval cards, tool rows, attachments, composer, and terminal/chat layout.

This document is an implementation brief for another agent. It describes the desired behavior, current implementation, architectural gaps, and acceptance criteria.

## Important product decision

Do **not** replace Spacron's UI with Orca's UI and do **not** copy the entire Orca repository.

The correct approach is to adapt Orca's structured-session concepts behind Spacron's existing UI:

- Keep `TerminalChatView` and its current visual design.
- Keep the existing settings and slash-command work.
- Keep the current model and effort pickers.
- Keep the existing ACP, Codex app-server, Claude stream-json, and Pi provider work.
- Improve the session, event, persistence, handoff, and reconnect layers underneath the UI.

The local Orca repository is available at:

`C:\Users\SMIDS MAN\Documents\Samuel Works\orca-main\orca-main`

Orca's repository contains an MIT license. If any Orca code is copied selectively, preserve the license notice and check the licenses of third-party dependencies. Prefer reimplementing the required behavior in Spacron's architecture instead of copying large unrelated modules.

## User-facing goal

The user should be able to:

1. Open an agent in the existing terminal UI.
2. Use the existing chat toggle to open structured chat.
3. See the same conversation, model controls, slash commands, tool activity, approvals, and streaming output in chat mode.
4. Switch back to terminal mode without losing the conversation.
5. Click a context-handoff button at the top of either terminal mode or chat mode.
6. Pick another configured agent.
7. Start that agent with bounded context from the current conversation and workspace.
8. Continue working with the new agent without manually copying the transcript.

The handoff button must be available in both:

- Normal terminal mode.
- Structured chat mode.

It should be placed in the top terminal/pane header, alongside the existing terminal/chat controls. If the chat body also has a header, the same shared action may be exposed there, but the primary control must remain in the top terminal header so it is available in both modes.

## Current Spacron implementation

### Existing structured-chat providers

Structured provider code is under:

`src/lib/services/structured-chat/`

Important files include:

- `provider.ts`
- `registry.ts`
- `state.ts`
- `panes.ts`
- `switch.ts`
- `acp-session.ts`
- `codex-session.ts`
- `claude-session.ts`
- `pi-session.ts`

The current adapters already handle much of the following:

- Streaming assistant text.
- Reasoning/thought output.
- Tool calls and tool updates.
- Usage information.
- Provider errors.
- Model lists and provider configuration options.
- Approval requests.
- Completion state.

Do not remove that work. Extend it behind a stable normalized session interface.

### Existing shared UI

The current rich terminal/chat UI is primarily in:

- `src/lib/components/terminal/TerminalPane.tsx`
- `src/lib/components/terminal/TerminalChatView.tsx`
- `src/lib/components/terminal/StructuredChatView.tsx`
- `src/lib/components/terminal/TerminalChatRich.tsx`
- `src/lib/components/terminal/TerminalChatContextMenu.tsx`
- `src/lib/components/terminal/TerminalChatToolRun.tsx`

`TerminalPane` already decides whether to show terminal content, the transcript chat view, or structured chat. The existing UI should remain the presentation layer.

### Existing terminal/chat switching

The relevant switching logic is in:

`src/lib/services/structured-chat/switch.ts`

The current behavior is approximately:

- Read the terminal transcript.
- Quit the terminal CLI.
- Start the protocol-backed structured provider.
- Store the structured provider in an in-memory pane map.
- When returning to terminal, close the structured provider and relaunch the terminal CLI using a resume argument.

This is useful functionality, but it is not yet a durable Orca-style session. The handoff implementation must work with this behavior now and should be compatible with a future first-class structured-session record.

### Existing context-handoff service

There is already a bounded context builder:

`src/lib/services/chat-context-handoff.ts`

It currently:

- Limits the handoff to a token budget.
- Includes the recent conversation.
- Identifies the previous and target agent.
- Tells the new agent to inspect the current workspace and continue.
- Omits pending/activity-only entries.
- Reports omitted message counts.

Reuse or extend this service instead of creating a second incompatible context format.

There is also existing handoff-related logic in:

- `src/lib/components/workspace/ChatModePanel.tsx`
- `src/lib/stores/chatThreads.ts`
- `src/lib/stores/orchestrator.ts`
- `src/lib/services/orchestrator/agent-handover.ts`
- `src/lib/services/acp-capabilities.ts`

Inspect these before adding new APIs. Avoid duplicating the existing chat-thread handoff path.

## Required context-handoff feature

### Button behavior

Add a clearly visible button in the top terminal header, for example:

- Icon: transfer/arrow/swap/agent icon from the existing icon system.
- Label/title: `Hand off to another agent`.
- Accessible label: `Hand off context to another agent`.

The button must:

- Work when the pane is in terminal mode.
- Work when the pane is in transcript chat mode.
- Work when the pane is in structured chat mode.
- Be disabled while a handoff is already in progress.
- Show a useful warning if no other configured agent exists.
- Avoid interrupting the current agent until the replacement is ready or the handoff policy explicitly requires it.
- Not silently discard the current conversation if the target agent fails to start.

### Agent picker

Clicking the button should open an agent picker using the existing agent roster/settings data.

The picker should show:

- Agent name and command.
- Account/provider where available.
- Model where available.
- Availability/authentication state where available.
- A disabled or warning state for agents that cannot accept this handoff.

Do not hard-code only `codex` and `claude`. Use the configured roster so ACP agents and other supported providers can participate where their capabilities permit it.

### Context included in the handoff

The handoff should contain:

- The current agent/provider.
- The target agent/provider.
- The current working directory.
- The active workspace/project.
- The recent user/assistant conversation.
- The latest user request or unfinished task.
- Relevant tool activity summary.
- Files created or edited when available.
- Current plan or incomplete work when available.
- Current model/effort/access mode when relevant.
- A clear instruction to inspect the actual workspace before acting.

The handoff must be bounded. Never send an unlimited transcript. Reuse `buildChatContextHandoff` and extend its input rather than bypassing its token budget.

The handoff prompt must make clear that transcript content is context, not executable instructions. It should say that the new agent must inspect the current workspace and continue the existing work rather than restarting or undoing completed changes.

### Handoff lifecycle

Use an explicit lifecycle:

1. `pending`: user selected a target and handoff preparation started.
2. `starting`: target agent/session is being created.
3. `delivering`: context is being sent.
4. `delivered`: target accepted the context and began/queued work.
5. `failed`: target could not be started or context could not be delivered.

The existing `ChatHandoffRecord` has `pending`, `delivered`, and `failed`. Either extend it carefully or add a separate pane-session handoff state without breaking persisted chat-thread records.

On failure:

- Keep the original agent and conversation available.
- Show the exact failure reason.
- Offer retry when safe.
- Do not mark the handoff delivered just because a target pane was created.

### Handoff target startup

The implementation must support two target paths:

#### Structured-chat target

When the target supports structured chat:

- Start the target provider through the structured provider registry.
- Send the bounded handoff context through the provider's structured send path.
- Render the target in the existing chat UI.
- Preserve the source conversation as history or a linked handoff record.

#### Terminal target

When the target is terminal-only or the user chooses terminal mode:

- Create/relaunch the target terminal session using the existing terminal session APIs.
- Deliver the context as the initial prompt/input using the existing safe terminal input path.
- Do not write raw context into a shell that is not ready to receive it.
- Wait for the session to be ready if the terminal API exposes readiness.
- Preserve a handoff record linking source session and target session.

## Orca-style structured-session work required

The handoff feature should be implemented in a way that moves Spacron toward the following Orca-style architecture.

### 1. First-class session identity

Create a normalized structured session record containing at least:

- Spacron session ID.
- Provider kind.
- Native provider session ID.
- Agent command/preset.
- Account ID when available.
- Working directory.
- Project/workspace ID.
- Current view: terminal or chat.
- Lifecycle state.
- Current model and effort.
- Current turn ID.
- Last event sequence/cursor.
- Handoff lineage.

Do not rely only on the in-memory `structuredChatPanes` map. It can remain a view cache, but it must not be the sole source of truth.

### 2. Normalized event journal

Every provider adapter should emit normalized events with:

- Stable event ID.
- Session ID.
- Monotonic sequence number.
- Turn ID when available.
- Event type.
- Timestamp.
- Provider metadata.
- Payload.

The journal should support:

- Append.
- Replay from a cursor.
- Snapshot/hydration.
- Duplicate-event protection.
- Out-of-order protection.
- Reconnect after provider or UI remount.
- History pagination.

### 3. Provider-specific translation

Keep protocol-specific parsing in provider adapters. The UI should consume normalized events/state, not raw ACP/Codex/Claude/Pi frames.

Required normalized categories:

- User message.
- Assistant text delta.
- Reasoning delta.
- Tool call started.
- Tool call update.
- Tool output.
- Approval/current request.
- Model/config update.
- Usage update.
- Plan update.
- File edit/diff.
- Image/artifact.
- Subagent/background task.
- Error.
- Turn completed.
- Turn interrupted.

### 4. Existing UI as a projection

Adapt the normalized session state into the existing `TerminalChatView` items and controls.

Do not redesign the UI to match Orca. Match Orca's behavior while retaining Spacron's visual language.

### 5. Commands and controls

Slash commands and controls should become explicit operations where appropriate:

- Clear conversation.
- Compact/summarize.
- Change model.
- Change effort.
- Change access/permission mode.
- Cancel turn.
- Retry failed turn.
- Queue a message.
- Pause/resume queue.
- Rename session.
- Continue in terminal.
- Continue in chat.
- Hand off to another agent.

Provider-native commands should be routed through the provider adapter when supported, with a safe fallback only when the provider cannot expose a native operation.

### 6. Account/model streaming

The model picker should be populated from the correct live source:

- ACP session config/model options.
- Codex app-server `model/list`.
- Claude provider/account model information.
- Pi RPC state/model information.

The app should distinguish:

- Model list not loaded yet.
- Model list loaded and empty.
- Model list request failed.
- Model unavailable for the current account.
- Model available but not compatible with the selected mode.

Never cache a failed model request as a valid empty catalog.

## Suggested implementation order

### Phase 1: Shared handoff action

1. Add a shared `ContextHandoffButton` or equivalent component.
2. Render it in the top header in `TerminalPane` for both terminal and chat states.
3. Add an agent picker/modal using existing roster/settings components.
4. Reuse `buildChatContextHandoff`.
5. Add a pane/session handoff coordinator that works for normal terminal and structured chat.
6. Add success/failure/pending UI.

### Phase 2: Reliable delivery

1. Add target-session readiness handling.
2. Add structured-provider delivery.
3. Add terminal-input delivery.
4. Preserve source and target session IDs.
5. Make failure recoverable.
6. Add tests for each mode and provider path.

### Phase 3: Durable structured session

1. Replace sole reliance on in-memory structured pane maps.
2. Persist structured session metadata.
3. Add normalized event records and cursors.
4. Hydrate chat UI from snapshots/history.
5. Reconnect provider subscriptions.
6. Restore session state after app restart.

### Phase 4: Orca-level behavior

1. Add tool batching/folding.
2. Add subagent/background-task rows.
3. Add plan, diff, image, and compaction projections.
4. Add current-request/approval lifecycle.
5. Add command discovery and native command routing.
6. Add session rename/history/resume.
7. Add live model catalog reconciliation.

## Files to inspect before editing

### Spacron

- `src/lib/components/terminal/TerminalPane.tsx`
- `src/lib/components/terminal/TerminalChatView.tsx`
- `src/lib/components/terminal/StructuredChatView.tsx`
- `src/lib/components/terminal/TerminalChatContextMenu.tsx`
- `src/lib/services/chat-context-handoff.ts`
- `src/lib/services/structured-chat/switch.ts`
- `src/lib/services/structured-chat/panes.ts`
- `src/lib/services/structured-chat/registry.ts`
- `src/lib/services/structured-chat/provider.ts`
- `src/lib/services/structured-chat/state.ts`
- `src/lib/services/acp-transport.ts`
- `src/lib/stores/terminal.ts`
- `src/lib/stores/chatThreads.ts`
- `src/lib/stores/agentAccounts.ts`
- `src/lib/stores/orchestrator.ts`
- `src/lib/services/orchestrator/agent-handover.ts`
- `src/lib/services/acp-capabilities.ts`

### Orca reference implementation

The relevant Orca concepts are spread across:

- `src/main/codex/structured/session-lifecycle/`
- `src/shared/agent-session/view/live-read/`
- `src/shared/native-chat/`
- `src/renderer/src/components/native-chat/session/structured/`
- `src/renderer/src/components/native-chat/composer/`
- `src/shared/agent-session/options/model-catalog/`

Use Orca as a behavior and architecture reference, not as a reason to replace Spacron's UI or copy unrelated application code.

## Acceptance criteria

The implementation is complete when:

- A handoff button is visible in the top header in terminal mode.
- The same button is visible in the top header in transcript chat mode.
- The same button is visible in the top header while structured chat is active.
- The button opens a picker of configured alternative agents.
- The selected target receives bounded context automatically.
- The context includes the current task, recent conversation, workspace, and relevant unfinished work.
- The target starts in the requested mode: structured chat or terminal.
- The original session is not destroyed before target startup succeeds, unless the user explicitly confirms replacement.
- A failed handoff leaves the original session usable.
- Handoff status is visible and persisted where the current thread/session persistence supports it.
- Chat-to-terminal and terminal-to-chat still preserve the conversation.
- ACP/server streaming continues to provide text, reasoning, tool activity, usage, approvals, model changes, errors, and completion state.
- Model lists come from the connected account/provider rather than a hard-coded list.
- No existing settings, slash-command, model-picker, approval, or composer functionality is regressed.
- Type checking and focused tests pass.
- Provider-specific handoff and terminal delivery tests pass.

## Verification checklist

Test at least these scenarios manually and in automated tests where possible:

1. Terminal Codex -> structured chat Codex.
2. Structured chat Codex -> terminal Codex.
3. Terminal agent -> another terminal agent.
4. Terminal agent -> another structured-chat agent.
5. Structured-chat agent -> another structured-chat agent.
6. Structured-chat agent -> terminal-only agent.
7. Handoff while the source is idle.
8. Handoff while the source has an unfinished turn.
9. Target authentication failure.
10. Target startup failure.
11. Target context delivery failure.
12. No alternative agent configured.
13. Large transcript requiring truncation.
14. Tool calls and file edits immediately before handoff.
15. App restart after a handoff.
16. Provider reconnect during or after handoff.

## Scope guard

Do not:

- Replace Spacron's current UI with Orca's UI.
- Copy the entire Orca application into Spacron.
- Remove the existing provider adapters.
- Send an unlimited transcript to the new agent.
- Destroy the source session before the target is known to be usable.
- Treat a created target pane as proof that context was delivered.
- Hide handoff failures.
- Hard-code the target agent list.
