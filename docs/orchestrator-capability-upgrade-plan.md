# Orchestrator capability upgrade

Status: proposed implementation plan, 2026-09-14. Source inspection completed; no product changes or live provider certification performed.

## Objective

Make the existing Chat orchestrator reliably inspect projects, edit files, run and verify tasks, and continue multi-step work with the user's selected API model. The runtime can improve tool access and execution reliability; it cannot make every model equally capable or bypass provider quotas and context windows.

## Confirmed constraints in the current working tree

| Area | Current implementation | Consequence |
| --- | --- | --- |
| Tool transport | `orchestrator-brain.ts` calls plain-text `ai_complete`; `brain-tools.ts` describes tools in the prompt and parses JSON text | Native tool protocols and structured tool-result history are absent from this path |
| Execution | Default four tool rounds, maximum eight; eight accepted calls per response | Substantive tasks can stop before verification; surplus calls are dropped by parsing |
| Model input/output | `secrets.rs::ai_complete` rejects user text above 32,000 characters and requests 1,024 output tokens; some reasoning paths add headroom | Large context and structured edits compete with fixed budgets |
| Requests | `run_completion` uses a 45-second HTTP timeout | Slow inference can fail despite making progress |
| File access | `read_file` returns the first 4,000 characters, with no range argument | Later parts of large files cannot be deliberately retrieved through this tool |
| Review snapshot | Up to 60,000 characters collected, then context is compacted for the smaller request envelope | Gathering source does not establish that all of it reaches the model |
| Editing | Direct writes capped at 50,000 characters; some large edits instruct delegation | API orchestrator work can depend unnecessarily on another agent |
| Commands | Command text capped at 500 characters; bounded synchronous execution and clipped output | Longer commands and builds need a resumable execution path |
| Provider fallback | Brain prepares selected model plus curated provider alternatives | Audit retries after tool execution to prevent repeated mutations or unannounced model changes |

These observations come from the current files, which already contain substantial uncommitted work. Preserve that work and patch only the approved scope.

## Implementation sequence

### 1. Structured provider transport

- Add a dedicated agent-turn IPC contract so changes do not alter dictation, commit-message generation, or other short text consumers of `ai_complete`.
- Represent messages, text blocks, tool calls, call IDs, results, finish reasons, usage, and opaque provider continuation metadata explicitly.
- Implement native OpenAI-compatible, Anthropic, and Gemini adapters. Preserve complete assistant blocks and required continuation metadata across calls.
- Convert existing tool definitions to validated JSON schemas and share the existing executor. Validate names, argument types, IDs, and result matching before execution.
- Preserve provider-specific authentication and endpoint routing. Do not infer full compatibility solely from a successful model listing or an OpenAI-compatible URL.
- Keep the selected model fixed during a task unless a user-configured fallback policy permits a change. Never restart already executed mutations as a transport retry.
- Treat text-only fallback as an explicit, tested compatibility mode; unsupported models must show the limitation honestly.

### 2. Sustained execution and context

- Replace the four/eight-round forced ending with an interruptible loop that continues while making progress. Retain repeated-failure detection and user-configurable resource budgets; reaching a budget pauses with a resumable state.
- Allocate context and output using model metadata where available, with conservative configurable values where unavailable. Account for reasoning headroom without enabling expensive reasoning indiscriminately.
- Store full tool results and expose range/pagination retrieval. Summarize older context while preserving the task, constraints, pending calls, and evidence references.
- Add line-range file reads, paginated file/search listings, and explicit truncation markers with continuation arguments.
- Support chunked or patch-based edits so whole-file output size does not impose an artificial task-size limit. Check expected file contents before writing to avoid overwriting concurrent changes.
- Add cancellable background command handles, status/output reads, and completion evidence for long tasks. Preserve the existing terminal lifecycle.

### 3. Provider compatibility and diagnostics

Audit every registered provider: OpenRouter, Anthropic, OpenAI, Google, Groq, xAI, DeepSeek, Mistral, Together, Fireworks, Cerebras, NVIDIA, Moonshot, SambaNova, Perplexity, Cohere, OpenCode, OpenCode Go, Ollama, and LM Studio.

- Track capabilities per model and endpoint: text, native tools, structured output, images, context/output ceilings, and streaming where available. Unknown capability is distinct from unsupported capability.
- Keep non-chat models out of the orchestrator picker. Preserve the user's saved selections when valid.
- Distinguish bad credentials, insufficient quota, throttling, unavailable model, unsupported parameter/tool protocol, timeout, and context overflow.
- Respect retry-after guidance with bounded retries; never retry a file mutation because a later model request failed.
- Report connection, inference, and tool execution verification separately. A key being saved or models being listed is not a completed compatibility test.

### 4. Chat completion and verification

- Show tool activity and meaningful progress, with Stop and resumable incomplete work.
- Persist structured task/turn state per project and conversation; verify deletion cannot resurrect a task.
- Ask blocking questions only when required information prevents progress. Keep optional follow-ups conversational.
- Require actual tool results for claims that files changed, commands succeeded, or tests passed.

## Limits to replace and boundaries to retain

Replace arbitrary content/round ceilings with pagination, adaptive budgeting, resumable work, and observable resource controls. Keep workspace confinement, credential isolation, destructive-action policy, cancellation, and repeated-failure protection. Provider account quotas, model context windows, and model abilities remain external constraints.

## Validation and acceptance

1. Adapter fixture tests for every protocol and registered endpoint: tool-call/result round trips, multiple calls, invalid arguments, truncated responses, continuation metadata, and errors.
2. Runtime tests: work exceeding eight rounds, read a symbol beyond character 4,000, retrieve later search results, edit and verify a temporary project, wait for a long command, cancel, and resume.
3. Failure tests: context overflow, throttling, failed authentication, unsupported tools, repeated calls, and a network failure after a successful edit. No duplicate mutations or false completion.
4. Run TypeScript checks, focused Vitest suites, affected Rust tests/checks, and frontend build. Broaden only when failures or changed shared interfaces justify it.
5. Perform short real Tauri smoke tests against configured credentials: read a fixture, find a symbol, make an authorized temporary edit, run verification, and return evidence. Keep paid tests small and report untested providers explicitly. Do not claim certification for unavailable keys/models.

## Protocol references

- [Anthropic tool-call lifecycle](https://platform.claude.com/docs/en/agents-and-tools/tool-use/handle-tool-calls): tool-use blocks and matched tool-result blocks.
- [Gemini thought signatures](https://ai.google.dev/gemini-api/docs/generate-content/thought-signatures): preserve required metadata through function-call continuations.

Acceptance is reliable observed execution with each tested model, not a claim of ChatGPT product parity from a prompt change.
