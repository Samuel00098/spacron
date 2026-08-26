# Agent inbox & unread state

Shipped 2026-08-10. Orca gap #16 — the queue behind the transient notification
stack, so a finished agent can't be missed by looking away.

## The one idea worth remembering: read ≠ dismissed

These are two separate bits and conflating them re-breaks the feature:

- **dismissed** — drop it from the floating stack. Set by an explicit close
  *and* by the 10s auto-clear timer on a plain "finished" card.
- **read** — the user actually saw it. Set **only** by a deliberate act: closing
  the card by hand, clicking the row in the panel, "Mark all read", or acting on
  a mailbox card (approve / merge / reply).

The auto-dismiss timer must **never** mark read — that timer firing is precisely
the "user was looking elsewhere" case the inbox exists for. The card leaves the
corner and stays bold in the list. `acknowledge()` is the both-bits helper;
`markDismissed()` is the timer's.

## Where things live

- `src/lib/services/orchestrator/inbox.ts` — the whole data layer (29 tests in
  `inbox.test.ts`). Stores **only** read/dismissed id lists, capped at
  `MAX_TRACKED_IDS` (500), persisted per project via `project-state` under the
  new `'inbox.json'` key (app config dir, never the repo).
- `InboxPanel.tsx` / `.css` — the popover. `InboxBell.tsx` / `.css` — the
  titlebar button + badge. Both under `components/orchestrator/`.

**It deliberately stores no message content.** The mailbox log and the chat
completion cards are already the persisted sources of truth for *what happened*;
`mergeInboxEntries(cards, completions, readIds)` is a pure function that presents
both as one newest-first list. Don't add a third copy of the messages.

## Three traps that are already handled — don't undo them

1. **Cold start.** A project with no `inbox.json` still has a full chat history
   of completion cards. Treating those as unread greets the user with a badge of
   forty. `loadProjectInbox(id, root, seedRead)` marks everything already present
   as read on first load only, then writes the file so the seed is decided once.
   The caller (`loadProjectOrchestratorTasks` in `stores/orchestrator.ts`) supplies
   the ids because `inbox.ts` importing `stores/orchestrator` would close a cycle
   — that store imports the mailbox. `CompletionLike` in `inbox.ts` is the
   structural stand-in for `ChatMessage` that keeps the cycle open.
2. **The bell is its own component, not markup in `TitleBar`.** The count
   subscribes to live chat + mailbox traffic; inlining it re-rendered the whole
   window chrome on every agent message. It also kept `TitleBar` off the static
   import list for the 3k-line orchestrator store.
3. **The panel is a popover, not a modal** — no `useModalFocus`. It must not trap
   Tab or suppress app shortcuts while open. Escape + outside-pointerdown only,
   and the outside handler skips `[data-inbox-toggle]` so the bell's own click
   doesn't cancel itself into a no-op.

## Side effect worth knowing

`mailboxSeen` (in `mailbox.ts`) is still session-only and global. Dismissal is
now *also* recorded per-project in the inbox, and the stack filters on both — so
a card handled yesterday no longer floats back up as a toast after a restart,
which it used to.

## 2026-08-12: premium pass — one notification per event, icons, burst grouping

Correlated against Orca's notification model (sonner toasts, one notification
per event, persisted unread). Three changes in `AgentNotifications.tsx` +
`stores/orchestrator.ts` + `stores/terminal.ts`:

1. **Dedupe.** A completion used to fire BOTH an orchestrator toast AND the
   floating card. The card is now the single visual surface: `completeLeasedTask`
   and `notifyAdoptedTurnEnd` keep only the chime, and `terminal.ts`'s exit toast
   is gated on `isOrchestratorTrackedSession`.
2. **SVG status glyphs.** `components/orchestrator/statusIcons.tsx` replaces the
   emoji in the inbox rows and the notification cards — `currentColor` + per-
   status CSS classes (`ok`/`bad`/`warn`/`info`/`accent`), so light/dark is
   automatic. Don't reintroduce emoji glyphs here.
3. **Burst grouping.** Plain "done" completions that land close together render
   as ONE "3 agents finished" card (members capped at 3 rows + "+N more"). The
   auto-dismiss timer is per-group, timed from the newest member, and still
   dismisses without marking read. Failed/blocked cards never group — each is an
   individual decision.

Cards also carry `completion.taskId` now, which lets a single-member card offer
"Show terminal" (`setActiveSession`) while the agent's session is still live.

Two follow-ups from review: (a) when `document.hidden`, a new completion raises
an **OS notification** (`showSystemNotification` in `zustand/notification.ts`,
once per card) so backgrounded users still get pinged — the floating card is
invisible then; (b) `markOrchestratorTrackedSession` is unmarked in
`unlinkOrchestratorTask`/`deleteOrchestratorTask`, so a deliberately released
terminal's later exit gets its normal toast again (never unmark on turn
completion — a card already landed).

## 2026-08-12: adopted agents land lightweight cards

Hand-launched (adopted) agents used to reach the inbox never — only a transient
toast. `appendAdoptedTurnCard` (in `stores/orchestrator.ts`) now drops a
completion card per turn end (and on process exit), with **no AI summary**, and
the task stays `in-progress`. Done turns are informational in the inbox;
blocked/failed ones are actionable.

## e2e wiring test

`inbox-wiring.test.ts` proves the sources land in the inbox view that
`InboxPanel`/`InboxBell` render: completions + handoff cards land unread,
read/acknowledge clears them, cold start seeds to zero, and session-only
dismissal (the pre-fix `AgentMailboxCards` behaviour) must not mark read.
Keep `MAX_ENTRIES` there in sync with the two components.

## 2026-08-12: every dismiss path must acknowledge

The "Needs you" strip (`AgentMailboxCards.tsx`) used to dismiss with
`dismissMailboxCard()` only. Because the inbox reads `includeSeen: true`,
`mailboxSeen` does not hide a card from the panel — so a strip-dismissed card
stayed listed *and* unread. Its `dismiss()` now also calls `acknowledge()`,
matching the notification stack (`AgentNotifications.tsx`). If a new dismiss
path is ever added, it must do both — `acknowledge` is the both-bits helper.

## 2026-08-12: inbox clear action (cleared state)

`InboxState` now includes a `cleared: string[]` list of entry IDs. Calling `clearInbox(projectId, ids)` marks entries as cleared (as well as read & dismissed), and `mergeInboxEntries` filters out any entries in `cleared`. The `InboxPanel` header provides a "Clear" button to clear all current inbox entries, and each row has a row-level clear button on hover.

[[per-project-persistence]]
