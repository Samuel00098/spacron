# How T3 Code gets agent state (and never scrapes a screen)

Reference notes from reading `github.com/pingdotgg/t3code` (MIT, Electron +
Node/Bun server + Expo mobile) on 2026-08-25, taken because it solves exactly
the problem [[agent-turn-detection]] solves with heuristics. Keep this as the
comparison point before extending the bell/regex/idle path again.

## The one structural difference

T3 never puts an agent in a PTY. It has PTYs (`apps/server/src/terminal/`) but
they are a *terminal feature*, unrelated to agents. Every agent is driven
through a structured protocol and the app is one side of that protocol:

| Provider | Transport | "needs input" arrives as |
|---|---|---|
| Claude Code | `@anthropic-ai/claude-agent-sdk` in-process | the `canUseTool` callback firing |
| Cursor / Grok / OpenCode | ACP JSON-RPC (`packages/effect-acp`) | `session/request_permission` |
| Codex | codex app-server JSON protocol | `codex.app-server.request` |

Because the agent *calls into their process and blocks on a promise*, "the agent
needs input" is not inferred at all — it is a function call they have not
returned from yet. `apps/server/src/provider/Layers/ClaudeAdapter.ts` (~line
4090) is the clearest example: `canUseTool` mints an `ApprovalRequestId`, emits
`request.opened`, parks a `Deferred`, and resolves it with the user's answer;
`AskUserQuestion` gets the same treatment as `user-input.requested`.

## Provenance is an envelope on every event

Every canonical event carries `raw: { source, method, payload }` where `source`
is a closed enum (`packages/contracts/src/providerRuntime.ts`):
`claude.sdk.message | claude.sdk.permission | codex.app-server.notification |
codex.app-server.request | codex.eventmsg | codex.sdk.thread-event |
opencode.sdk.event | acp.jsonrpc`. That field is the answer to "did this
message really come from the agent" — it names the channel it arrived on and
keeps the untouched provider payload beside the normalized form.

## The notification model

1. Provider events are normalized (`orchestration/Normalizer.ts`) and appended
   to an **event log**; a projection maintains a thread "shell" with two
   booleans, `hasPendingApprovals` / `hasPendingUserInput`.
2. `packages/shared/src/agentAwareness.ts` collapses the shell into one
   `AgentAwarenessPhase`: `starting | running | waiting_for_approval |
   waiting_for_input | completed | failed | stale`, via an ordered ladder
   (pending approvals first, then pending input, then error, then session
   status). Read the comments there — the ladder's fallbacks are all fixes for
   real races.
3. `apps/server/src/relay/AgentAwarenessRelay.ts` publishes phase changes to a
   cloud relay, which fans out **mobile push** (Expo) and iOS Live Activities.
   There is **no desktop OS notification anywhere in the repo** — desktop/web
   just render the phase inline (status dots, pills, sidebar).

Three details worth stealing regardless of transport:

- **Dedupe by payload identity, not by event.** `agentAwarenessPublishIdentity`
  JSON-stringifies the state minus `updatedAt`; an unchanged state never
  re-notifies. Same job as the burst grouping in [[agent-inbox-unread]].
- **Confirm-before-publish.** A first-ever `completed`, or a tombstone, is
  deferred 5s and re-checked, because a thread reads "ready" for an instant at
  birth and would fire a spurious "Done" (see `requiresConfirmation`).
- **Intent events do not notify.** `thread.message-sent` /
  `turn-start-requested` are skipped: the shell still holds the *previous*
  turn's terminal state until the provider acknowledges the new one.

## What this means for us

Our nonce sentinel channel (`agent-hook-signals.ts`) is the same trust idea and
is already correct — it is just narrow: Claude-only, and it carries a *turn
boundary*, not the agent's message. The two ways to widen it, in order of cost:

1. **ACP.** Cursor/Grok/OpenCode already speak it, so one ACP client would
   replace the heuristics for three CLIs at once.
2. **Per-session MCP identity.** `src-tauri/src/mcp/mod.rs` already gives agents
   an authenticated callback path, but every agent shares **one** token
   (`?token=…`), so a tool call proves "an agent on this box", not *which*
   agent. A per-session token minted at lease time (the nonce already exists)
   would make an MCP call as attributable as a hook sentinel.

Related: [[agent-turn-detection]], [[blocked-reason-is-raw-pty]],
[[agent-inbox-unread]], [[remote-invoke-seam-gap]]
