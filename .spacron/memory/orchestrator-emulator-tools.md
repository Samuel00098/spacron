# Orchestrator emulator tools (2026-09-20)

The orchestrator drives devices through the **same MCP handlers the CLI agents
call**, not a second implementation. `mcp::call_emulator_tool` (Rust) routes to
the existing `emulator_*` handlers and unwraps their JSON-RPC envelope; the
frontend reaches it through the `mcp_call_emulator_tool` Tauri command.

Why it matters: target validation and the normalized(0–1)→pixel conversion live
in those handlers. A parallel TS implementation would drift, and the symptom
would be the orchestrator tapping a different spot than an agent given the same
coordinates.

Four places must agree when a tool is added or removed — a Rust test
(`orchestrator_allowlist_matches_the_served_emulator_tools`) fails if the first
two drift, but the last two are on you:

- `mcp/mod.rs` — `ORCHESTRATOR_EMULATOR_TOOLS` and the match in
  `call_emulator_tool`.
- `brain-tools.ts` — `BrainToolName`, `BRAIN_TOOL_DEFS`, the readonly/write
  sets, and `brainToolProfile`.
- `agent-transport.ts` — `definitions`. **A tool with no entry there is
  rejected as "Unknown tool" on the native tool-calling path**, so it is
  advertised and unusable. Coordinates use the `dec` (`type: 'number'`)
  property: `num` is integer-only and rejects every tap but the corners.
- `stores/orchestrator.ts` — the executor case, and the `mutating` list (which
  is NOT `BRAIN_WRITE_TOOLS`; the two lists are separate on purpose).

Traps that are already handled, and would come back if the code is rewritten:

- **The brain has no vision.** No provider path in this repo sends images.
  `emulator_screenshot` therefore writes a file to the OS temp dir and returns
  its path and size; it never returns base64, which would blow the 32k tool
  cap with characters the model cannot read. The model is told in its tool
  description that the file is for the user and that logcat is how *it* learns
  what happened.
- **Arg types are exact on the Rust side** (`as_f64`, `as_str`). A stringified
  `"0.5"` reads as absent, and the resulting "needs 'x' and 'y'" error names
  arguments the model can see it sent — so it retries identically until the
  doom-loop guard kills the turn. `normalizeEmulatorArgs` coerces before the
  invoke; `emulator_key` goes the other way, needing a raw keycode as a string.
- Input tools are write-class so they run sequentially; a tap racing a swipe
  lands somewhere nobody intended.

Approval: input and lifecycle tools ask like an edit does outside Full access.
The loop stays usable because `approvalRuleKey` returns the bare tool name, so
one "Always allow" covers every later `emulator_tap` in the conversation.

Related: [[orchestrator-tool-calling]], [[orchestrator-approval-cards]].
