# Side chat: how T3 Code and Orca do it, and what Spacron should do

Researched 2026-11-27. Research only, no code changed. Statements about Spacron come from reading
the working tree (which has uncommitted work); nothing here was run in the app.

## The short answer

Both products build a side chat as a **fork of the provider's own session**, shown **beside** the
parent while the parent keeps running. Neither starts a fresh agent and pastes the transcript in as
its main mechanism.

Spacron already has `/side` in two places, but from the code, the side chat's **agent often does not
receive the parent's context** even though the messages are on screen. Fix that before building new UI.

## T3 Code

- **Open:** `/side <question>` or `/btw <question>`, or Side chat in the right panel's + menu ([user doc](https://github.com/pingdotgg/t3code/blob/main/docs/user/thread-sidebar.md)).
- **Where:** a tab in the right panel; can be moved to the main view.
- **Context:** starts with the parent's context, folder, model and permissions. Forks at the latest stable point, so the parent can keep working ([useSideChat.ts](https://github.com/pingdotgg/t3code/blob/main/apps/web/src/components/chat/useSideChat.ts)). Native provider forks keep context; otherwise a "portable handoff" rebuilds it ([ThreadForkService.ts](https://github.com/pingdotgg/t3code/blob/main/apps/server/src/orchestration-v2/ThreadForkService.ts)).
- **Model:** the parent composer's current model and permission mode.
- **Persistence:** a real thread with a `sideChat` flag, hidden from the main sidebar. Closing an unused one deletes it. Deleting or archiving the parent does the same to its side chats.
- **Results back:** "Add to chat" (or `@` its title) links it into the parent's message and the parent agent reads what it needs. This replaced an earlier "Bring back" that copied a summary and only worked while the parent was idle ([PR 38323](https://github.com/pingdotgg/t3code/pull/38323), merged).
- **Limits:** no side chat of a side chat.
- **Trap they hit:** a forked Claude session inherited the parent's `/goal` and looped ([issue 32439](https://github.com/pingdotgg/t3code/issues/32439)).

## Orca

- **Open:** `/btw` or `/side` in its Chat UI ([docs](https://orca.dev/docs/agents/native-chat), [PR 39268](https://github.com/stablyai/orca/pull/39268), merged).
- **Where:** the pane next to the chat, or a new split to the right.
- **Context:** forked through the newest finished response. The original keeps running and is never changed.
- **Agents:** Claude, Codex, and OpenCode/OMP where the installed version can fork. Others (Antigravity, Pi, Grok, other ACP) keep their own `/btw`.
- **Persistence:** an ordinary saved fork, listed in Session History with a "Forked from" divider.
- **Limits:** text only. If it cannot start, the reason is shown and the draft is kept.
- **Results back:** no such action found; it is a user request ([issue 27408](https://github.com/stablyai/orca/issues/27408)).
- **Not merged yet:** a tab menu "New side chat" that forks during a running turn ([PR 44260](https://github.com/stablyai/orca/pull/44260)), and a throwaway terminal side chat using `claude --resume <id> --fork-session` plus a hidden "reference only, don't change things" instruction ([PR 35828](https://github.com/stablyai/orca/pull/35828)).

## What Spacron has today

| Surface | What exists | Gap |
| --- | --- | --- |
| Terminal-backed chat | Fork button spawns the CLI with `forkArgs` (`services/terminal-chat-rich.ts`) | Little: the CLI owns its own `/btw` / `/side` |
| Structured chat (`TerminalChatView` + `services/structured-chat/`) | `/side`, `/btw` in `commands.ts`; `forkStructuredSession` in `session-store.ts` | See below |
| Chat mode (`ChatModePanel.tsx`) | `/side`, `createSideChatThread`, `bringBackSideChat` (`stores/chatThreads.ts`), lineage banner | See below |

### Problems found by reading the code (not reproduced)

> **Now:** `/side` in structured chat opens as its own tab in the right sidebar (not a split pane), one
> tab per side chat. Closing the tab ends it; the conversation stays in `/history`. Tabs are not restored
> after a restart.

> **Update:** items 1, 3 and 4 (missing context) were fixed after this was written, and Chat mode's Pi path
> got the same fix. `claude --resume <id> --fork-session` was checked over stream-json and works. Items 2 and
> 6, and the "reference only" instruction from Phase 1, are still open. Not yet tried in the app.
>
> **Later:** item 2 is fixed too. `/side` in structured chat now opens beside the parent, including while it
> is replying; tried in the app with Claude Code. Other agents have not been tried.
>
> Item 6 is fixed: "Bring back" is now "Add to chat", which quotes the latest answer into the main
> thread's message box. The button was tried in the app with made-up messages.

1. **Structured chat, Claude and other non-Codex agents:** the fork is a `journal-branch` with `nativeSessionId: null`. It reopens with no resume id and I found nothing that feeds the journal to the agent, so the history shows but the agent starts blank. Codex forks natively (`thread/fork`).
2. **Structured chat:** `/side` is refused while a turn is running, and it replaces the current pane, closing the parent's agent process. So the parent does not keep working beside it.
3. **Chat mode, Claude / Cursor / OpenCode / Muse:** the side thread has no session id, and these paths send only the new message. The 12 copied messages are never sent.
4. **Chat mode, ACP agents:** transcript handoff happens only when the previous agent name differs from the current one, so a same-agent side chat may get nothing.
5. **Chat mode, Codex and the built-in assistant:** these do get context (last 40 and last 12 messages).
6. **Bring back:** it appends the side messages to the parent's transcript. A parent with a native session never sends them to its agent. Appending a user message also sets status `working`, so the parent may stay stuck on Working.

## Recommended design

### Phase 1: make the existing side chat correct

- **Claude, structured:** resume the parent id with `--fork-session` (an option on `claudeArgs` in `claude-session.ts`) and have `fork` use it. The flag exists in the CLI; its behaviour over stream-json is **not verified**.
- **Agents without a native fork:** send the transcript with the first message (`services/chat-context-handoff.ts` already builds one), or say side chat is unavailable.
- **Chat mode:** fork the native session where possible (`forkClaudeSession`, as `forkChatThreadFrom` does), otherwise hand off the transcript.
- **Instruction on every side chat:** inherited history is reference; answer, and change nothing unless asked.
- Tests: for each provider path, assert what the agent is actually sent, not what the screen shows.

### Phase 2: open it beside the parent

- Keep the parent pane and its process. Open the fork as a new structured-chat pane split to the right. Such a pane is already an ordinary terminal session. I have **not traced** the room split code.
- Fork from the last finished turn so it works while the parent is running. Codex and Claude behaviour mid-turn is **not verified**.
- Accept `/side <question>` and `/btw <question>`, with the question going only to the fork and the draft kept on failure.
- One side chat per parent; no side chat of a side chat.

### Phase 3: bring results back

Replace the copy-everything "Bring back" with "Add to chat": put the side chat's answer (or a selected part) into the parent's composer for you to send. It works while the parent is busy and the parent agent really receives it.

### Files likely to change

- `src/lib/services/structured-chat/`: `claude-session.ts`, `session-store.ts`, `commands.ts`, `provider.ts`
- `src/lib/stores/chatThreads.ts`, `src/lib/stores/orchestrator.ts`
- `src/lib/components/terminal/TerminalChatView.tsx`, `TerminalPane.tsx`
- `src/lib/components/workspace/ChatModePanel.tsx`

Several of these have uncommitted changes, so commit or settle that work before starting.

### Main risks

- Two agents in one folder can both edit files. Default the side chat to read-only or ask.
- A fork that silently loses context looks fine on screen. This is the bug there today.
- Forked sessions can carry parent state you do not want (T3's `/goal` loop).
- A side chat in Chat mode shares `parentThreadId` with sub-agents, so it also shows in the sub-agent list.

## Choices for you

1. **Which surface first?** Recommended: structured chat, then Chat mode.
2. **Where it opens?** Recommended: split pane (fits Spacron's rooms) rather than a new right panel.
3. **Permissions?** Recommended: ask before edits, whatever the parent allows. T3 inherits the parent's.
4. **Keep or discard?** Recommended: keep as a saved fork, delete if nothing was sent.

## Noticed in passing

- `StructuredChatView.tsx` appears not to be imported anywhere.
- `forkChatThreadFrom` gives a fork the source's Cursor, OpenCode and Muse session ids, so the two may write into one session.
