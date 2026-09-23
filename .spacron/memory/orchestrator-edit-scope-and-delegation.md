# Orchestrator: edit small, delegate big (2026-09-19)

User rule: the orchestrator changes at most 3 project files per task itself;
anything bigger is handed to an agent, and **never without the user's OK**.

Three places must agree; change them together:

- `services/orchestrator/delegation-policy.ts` owns the limit
  (`DIRECT_EDIT_FILE_LIMIT`), `EXPLICIT_SPAWN_RE` (the brain imports it from
  here), what counts as user approval (`userApprovedDelegation`: explicit
  request, a running agent named in the message, or a short answer to the
  orchestrator's own question after an explicit request), and the proposal
  options/answer matching.
- The brain prompt (SCOPE RULE / NEVER DELEGATE ON YOUR OWN) tells the model a
  spawn in its FINAL is a *proposal*. If the prompt ever says spawns execute
  immediately again, the store gate will still hold them, and the model's
  "I started Claude" reply becomes a lie.
- The store (`sendChatMessage`) turns an unapproved spawn/send into a choice
  card and keeps the proposal in `pendingDelegations` (memory only). Voice
  stores nothing: realtime voice never delivers the literal answer, which is
  why an earlier confirmation hold was removed (see the voice placement tests).

The file limit is enforced in the executor before the approval card
(`checkDirectEditScope`); the scope lives per conversation in
`directEditScopes` so "okay, continue" cannot reset the count
(`isScopeContinuation`). "undo" restores `lastTurnEdits` only for files still
holding what the orchestrator wrote.

Related: [[orchestrator-tool-calling]].
