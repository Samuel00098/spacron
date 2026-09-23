# Orchestrator approval cards (Default access)

Policy lives in `services/orchestrator/command-policy.ts`: read-only commands
(strict allowlist; any redirect, substitution, braces or single `&` falls back
to asking) run without a card, and "Always allow … in this conversation"
stores a rule in the store's `conversationApprovalRules` (memory only).

Transcript contract, split across two files — change them together:

- Store (`executeToolWithActivity`): the card is a *question*, not transcript.
  Answering it removes the card and records the decision on the operation's
  activity row (`· approved by you`, `· allowed for this conversation`,
  `· declined by you`). A clicked option posts no user bubble; typed text is
  "no, do this instead" and reaches the running turn as a steered message. The
  pending reply bubble is moved to the end after every card/activity so the
  live answer sits below the work.
- `ChatModePanel` (`activityRunOwner`): a run of activity rows has ONE owner,
  the reply after it, else the reply before it; approval/input cards never
  own a run. Attaching a run to both neighbours is what rendered "Work details
  34 operations" twice around a card.

Related: [[orchestrator-edit-scope-and-delegation]].
