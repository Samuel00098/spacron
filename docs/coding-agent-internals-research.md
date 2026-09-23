# How Claude Code, OpenCode and Codex work inside

Research date: 2026-09-19. The goal is to shape Spacron's next orchestrator phase.

**Sources.** OpenCode and Codex are open source, so their sections come from the
current source code: `anomalyco/opencode` (formerly `sst/opencode`) on the `dev`
branch, and `openai/codex` (`codex-rs`) on `main`. Claude Code is closed source,
so its section comes from Anthropic's official docs (code.claude.com/docs) and
from the tool contracts Claude Code exposes to the model. Its internals are
documented behaviour, not code we read.

---

## 1. The shared core: every agent is one loop

All three run the same basic loop:

```
user message ─► build request (system prompt + instructions + history + tool schemas)
             ─► stream model output
             ─► model emits tool calls? ── yes ─► check permission ─► run tool ─► append result ─► loop
                                         └─ no ──► turn ends (final text)
```

They differ in four places:

1. **How the loop decides the turn is over.**
2. **Which tools exist**, and how narrow each one is.
3. **How context is kept under the limit** (pruning and compaction).
4. **How input that arrives mid-turn is handled** (queueing and steering).

None of them parses tool calls out of free text. All three use the provider's
native function/tool-calling API. Spacron's orchestrator does parse text today
(see §6).

---

## 2. Claude Code (Anthropic, closed source)

### Loop and internals
- The docs describe the loop as three blended phases: **gather context → take
  action → verify results**. It repeats until the model answers without a tool call.
- The whole session is written to a **JSONL transcript** under
  `~/.claude/projects/<project>/`. That transcript is what makes resume, fork
  (`--fork-session`, `/branch`) and rewind possible.
- **Checkpoints.** Before an edit, Claude Code snapshots the file's current
  contents, separately from git. `Esc Esc` rewinds. Only file changes are covered;
  side effects like databases or deploys are not.
- **Context management.** As the window fills it first clears old tool outputs,
  then summarizes the conversation. If one huge output keeps refilling the window
  right after each summary, it stops auto-compacting after a few attempts rather
  than loop. You can steer the summary with a "Compact Instructions" section in
  CLAUDE.md or `/compact <focus>`.
- **Deferred tools.** MCP tool definitions are not loaded up front. The model sees
  only their names and loads full schemas on demand through `ToolSearch`, which
  keeps the context small when there are hundreds of tools.
- **Memory layers** are loaded into every session: CLAUDE.md (user, project and
  local scopes; AGENTS.md is also read), auto-memory (the first 200 lines or 25KB
  of `MEMORY.md`), and skills (only their descriptions until one is invoked).
- **Subagents** (`Agent` tool) each get a fresh context window, or a copy of the
  conversation when forked. Only their final summary comes back to the parent,
  which is how the main context stays clean.
- **Permissions** are a mode (Manual / Accept edits / Plan / Auto, where Auto uses
  a background classifier) plus allow/deny rules in `settings.json`, plus hooks
  (PreToolUse and similar) that can block or rewrite a call.

### Reading files
- **`Read`**: absolute path, optional `offset`/`limit`. Output uses `cat -n` style
  line numbers. If a file is too big for the token limit it returns the first
  page with a `PARTIAL view` notice. It reads images (the model sees them), PDFs
  (in 20-page ranges) and notebooks.
- **Search is separate from reading**: `Glob` for filenames, `Grep` (ripgrep) for
  contents. On macOS and Linux these are now absent by default and the model uses
  `rg`/`find` through Bash.
- The harness **tracks which files were read**. Viewing a file through Bash
  (`cat`, `head`, `sed -n`, single-file `rg`) also counts as a read.

### Editing files
- **`Edit`** does an **exact string replacement**: `old_string` → `new_string`,
  with an optional `replace_all`. It enforces three rules:
  1. The file must have been read first (newer models may skip this when reading
     wouldn't need a permission prompt).
  2. `old_string` must match byte-exactly. There is no fuzzy fallback.
  3. `old_string` must occur exactly once unless `replace_all` is set. Otherwise
     it errors and asks for more surrounding context.
- If the file changed on disk after the last read, the edit still works as long
  as `old_string` matches the current contents exactly and only once.
- **`Write`** creates a file or overwrites a whole file. It also requires a prior
  read for existing files.
- Its design choice is **strict matching with loud failures**. A failed edit comes
  back to the model as an error, the model re-reads the file and retries, and
  nothing is ever applied to the wrong place.

### Todo lists / planning
- There are two generations of the planning tool:
  - **`TodoWrite`** (legacy): the model sends the **whole list** every call. Each
    item has `content`, `status` (`pending`/`in_progress`/`completed`) and
    `activeForm` (the present-tense label shown while the item runs). The rule is
    that exactly one item is `in_progress`.
  - **`TaskCreate` / `TaskUpdate` / `TaskGet` / `TaskList`** (current): tasks are
    individual records with IDs, status, **dependencies** (blocked-by), details
    and deletion. They **persist across compaction** and are stored under
    `~/.claude/tasks/`. Setting `CLAUDE_CODE_TASK_LIST_ID` shares one list between
    sessions, so several agents can work from the same board.
- `Ctrl+T` shows the list, up to five items at a time.
- **Notable trend.** These tools are on by default only for older models (Claude
  3.x, Opus 4.0–4.7, Sonnet 4.0–4.6, Haiku 4.5). Newer models get **no todo tool
  by default** (opt-in: `CLAUDE_CODE_ENABLE_TODO_TOOLS=1`). Anthropic has decided
  frontier models plan well enough without one.
- **Plan mode** is separate from todos. It is a permission mode where the agent
  can only read. `ExitPlanMode` then shows the plan to the user for approval
  before any edits happen.

### Handling orders (user input while working)
- **Queueing.** A message typed during a turn is **queued, not an interrupt**. If
  tool calls are running, it is handed to the model **as soon as those calls
  finish, inside the same turn** (a mid-turn steer). If the turn ends with
  messages still queued, **only the oldest** is sent as the next turn and the
  rest wait their turn.
- Slash commands and `!` shell commands are held until the turn ends, then run
  one at a time. Some settings (`/model`, `/effort`) apply to the very next
  request within the running turn.
- **`Esc`** cancels the running tool call and ends the turn. Anything queued is
  then sent right away.
- **`Up`** takes queued items back into the input box for editing.

---

## 3. OpenCode (open source, TypeScript/Effect)

### Loop and internals (`packages/opencode/src/session/`)
- `prompt.ts` holds the main `while (true)` loop. On every iteration it:
  1. **Re-reads the message list from the database.** Everything is persisted
     (SQLite via drizzle), so nothing lives only in memory.
  2. **Exits** when the last assistant message has a finish reason other than
     `tool-calls`/`unknown`, has no pending tool parts, *and* answers the latest
     user message (`parentID === lastUser.id`). The last check is how a new user
     message automatically keeps the loop going.
  3. Runs any queued **subtask** (a subagent) or **compaction** task first.
  4. Checks for **overflow**: `tokens ≥ context limit − min(20k, max output)`.
     If so it creates an auto-compaction task and loops again.
  5. Applies **reminders**, synthetic text injected into the last user message
     (for example the plan-mode prompt, or "you switched from plan to build, a
     plan file exists at X, execute it").
  6. Calls the model through the Vercel AI SDK and processes the stream.
- There is a per-agent **step cap** (`agent.steps`). On the final step a
  `MAX_STEPS` prompt tells the model to wrap up.
- `processor.ts` consumes the stream. It has two notable guards:
  - **Doom-loop detection**: if the last 3 tool calls are identical (same tool,
    same input), it raises a `doom_loop` permission prompt to the user instead of
    letting the loop spin.
  - **Snapshots**: a `snapshot.track()` before the stream and at each
    `step-finish`, backed by a **separate shadow git repo**, not the user's own.
    Every step produces a file diff, and `revert.ts` can restore the tree to any
    message.
- **Pruning** (`compaction.ts`) runs before full summarization. It walks back
  through old tool outputs, keeps the most recent ~40k tokens of them, and erases
  older ones once there are more than 20k tokens to reclaim. `skill` outputs are
  protected. Full compaction then summarizes and keeps 2k–15k tokens of recent
  context.
- **Instructions** (`instruction.ts`): it loads global `AGENTS.md` and
  `~/.claude/CLAUDE.md`, then walks **up** from the working directory to the first
  project `AGENTS.md` (or `CLAUDE.md`), with the first match winning so ancestors
  don't stack up. When a file is read, it also attaches any **nested** AGENTS.md
  found near that file.
- **Agents** are named configs (`build`, `plan`, plus user-defined ones), each
  with its own prompt, model, permission ruleset and step cap. `plan` has edits
  denied.

### Reading files (`tool/read.ts`)
- Takes a `filePath` (absolute), `offset` (1-indexed) and `limit` (default 2000
  lines). Output lines look like `<n>: <content>`. Lines longer than 2000
  characters are cut, and total output is **capped at 50KB** with a "use
  offset=N to continue" footer.
- Reads directories too: one entry per line, subfolders get a trailing `/`,
  paginated.
- Images (jpeg/png/gif/webp) and PDFs come back as attachments. Binary files are
  rejected.
- Paths outside the project trigger an `external_directory` permission prompt.
- On read it **warms up the LSP** for that file in the background, so
  diagnostics are ready when the model edits it.
- The tool prompt tells the model to read in parallel and **avoid tiny 30-line
  slices**.

### Editing files (`tool/edit.ts`, `write.ts`, `apply_patch.ts`)
- **`edit`** uses Claude-style `oldString`/`newString`/`replaceAll` with the same
  read-first and uniqueness rules, but it is **fuzzy**. Adapted from Cline's diff
  evals, it tries a chain of **9 replacers** in order until one matches uniquely:
  `Simple` (exact) → `LineTrimmed` → `BlockAnchor` (first and last lines anchor
  the block, middle lines scored with Levenshtein similarity) →
  `WhitespaceNormalized` → `IndentationFlexible` → `EscapeNormalized` →
  `TrimmedBoundary` → `ContextAware` → `MultiOccurrence`.
- It normalizes CRLF for matching, then **writes back in the file's original line
  ending**.
- A **per-file semaphore** serializes concurrent edits to the same path.
- Each edit builds a unified diff, which goes to the permission prompt (the user
  approves the actual diff) and into the UI.
- After writing, it runs the configured **formatter** (prettier and similar),
  then asks the **LSP for diagnostics** and appends `LSP errors detected in this
  file, please fix:` to the tool result. This is the key trick: the model gets
  type errors as immediate feedback, without spending a turn running `tsc`.
- **`write`**: full overwrite, read first if the file exists.
- **`apply_patch`**: the Codex patch format (§4), offered to OpenAI models, which
  are trained on it. OpenCode chooses the edit tool based on the model family.

### Todo lists / planning (`tool/todo.ts`, `session/todo.ts`)
- **`todowrite`** replaces the **whole list** each time. Each item has `content`,
  `status` (`pending`/`in_progress`/`completed`/`cancelled`) and `priority`.
- Storage **deletes all rows for the session and re-inserts them in order**
  inside one DB transaction, then publishes a `todo.updated` event for the UI.
- The tool returns the JSON list to the model and the title "N todos" (open
  items) to the UI.
- The prompt rules (`todowrite.txt`) are worth copying:
  - Use it for 3+ distinct steps or when the user lists several tasks. Skip it
    for single or informational asks.
  - **Exactly one `in_progress`.** Update in real time and don't batch
    completions.
  - **Mark `completed` only after the work *and its verification* are done,
    never based on intent.**
  - If blocked, keep the item `in_progress` and add a follow-up todo describing
    the blocker.
  - **Keep user-provided commands verbatim.**
- **Plan mode** (experimental flag) writes a **plan file** to disk. When the user
  switches back to `build`, a reminder tells the model the plan file exists and
  to execute it. The plan outlives the conversation because it is a file.

### Handling orders
- A new prompt is written to the DB first. Then `SessionRunState.ensureRunning`
  **joins the existing runner** if the session is already busy, and no second
  loop starts.
- Because the loop re-reads messages every step and only exits when the last
  assistant message answers the *latest* user message, a message sent mid-run is
  **picked up at the next step boundary**. That is steering for free, with no
  separate queue data structure.
- Cancel (`SessionPrompt.cancel`) interrupts the runner and also cancels the
  session's background jobs.

---

## 4. Codex (OpenAI, open source, Rust)

### Loop and internals (`codex-rs/core/src/session/turn.rs`)
- The **turn loop** runs roughly like this:
  1. Run **pre-sampling compaction** if the thread is near its limit.
  2. **Drain pending input** from the session's `input_queue` and record it into
     history.
  3. Capture a "step context" (tools, MCP servers, environment).
  4. Sample the model and run any tool calls.
  5. Continue while **`needs_follow_up = model_needs_follow_up || has_pending_input`**.
     A turn is not over while the user has queued something.
- **Compaction** comes in two forms: local (summarize with the model) and
  **remote** (the Responses API compacts server-side and returns opaque encrypted
  history). A token-budget compaction can also run mid-turn.
- Everything is event-sourced into a **rollout file** (JSONL) for resume.
- A **turn diff tracker** accumulates every file change in the turn into one
  unified diff for review.
- **Sandboxing is central.** Commands run under an OS sandbox (Seatbelt on macOS,
  Landlock/bwrap on Linux, a dedicated Windows sandbox) with approval policies
  (`untrusted` / `on-request` / `never`) and an `execpolicy` rules engine.
  Network access has its own approval path.
- **Architecture**: the core is a library. The TUI, `codex exec` and the IDE
  extension all talk to it through an **app-server protocol**. Multi-agent
  support exists (`multi_agents.rs`, `spawn.rs`, agent mailbox messages).
- The system prompt is short (about 80 lines for gpt-5.2-codex) and **per model**
  (`gpt_5_codex_prompt.md`, `gpt-5.2-codex_prompt.md`, …). It also contains
  dirty-worktree rules nearly identical to Spacron's agent brief: never revert
  changes you didn't make, and stop and ask if unexpected changes appear.

### Reading files
- **There is no read-file tool.** The model reads through the shell: `cat`,
  `sed -n 'a,bp'`, `rg`, `rg --files`, via `exec_command` (the "unified exec"
  handler, which supports a persistent PTY and background processes). The prompt
  says to prefer `rg`.
- The philosophy: GPT-5-codex is trained to use a terminal, so one general tool
  plus the sandbox replaces the whole read/glob/grep family. Output is truncated
  head+tail before it reaches the model.

### Editing files (`codex-rs/apply-patch/`, `tools/handlers/apply_patch.rs`)
- **`apply_patch`** is exposed as a **freeform (grammar-constrained) tool**, not
  a JSON function, so the model writes raw patch text:
  ```
  *** Begin Patch
  *** Update File: src/app.py
  *** Move to: src/main.py        (optional rename)
  @@ def greet():                 (context anchor: class/function line)
  -print("Hi")
  +print("Hello, world!")
  *** Add File: hello.txt
  +Hello world
  *** Delete File: obsolete.txt
  *** End Patch
  ```
- There are **no line numbers**. Hunks are found by content through
  `seek_sequence`, which drops strictness step by step: exact match, then ignore
  trailing whitespace, then ignore leading and trailing whitespace, then
  Unicode-normalized (smart quotes, dashes). End-of-file hunks are tried at the
  end first.
- **One patch can touch many files atomically** (add, update, rename, delete),
  and the patch is **verified before it runs**. It goes through the same
  approval and sandbox pipeline as shell commands: a patch that writes outside
  writable roots needs approval.
- The patch is **parsed while it streams** (`StreamingPatchParser`), so the UI
  shows `PatchApplyUpdated` events file by file as the model types.
- It can preserve the file's line endings (a feature flag) or normalize to LF.
- The prompt says to use `apply_patch` for hand edits, and to use scripts or
  formatters (not patches) for mechanical or generated changes.

### Todo lists / planning (`tools/handlers/plan.rs`)
- **`update_plan`** takes `{ explanation?, plan: [{ step, status }] }` with
  status `pending` | `in_progress` | `completed`, and **at most one
  `in_progress`**.
- The handler is almost nothing. It parses the arguments, emits an
  `EventMsg::PlanUpdate` for the UI, and returns the literal string **"Plan
  updated"** to the model. **No state is stored.** The plan exists only in the
  conversation (the model's own call arguments) and in the UI.
- It is **rejected in Plan mode** ("update_plan is a TODO/checklist tool and is
  not allowed in Plan mode"). Plan mode means a proposal for the user, not a
  checklist.
- Prompt rules: skip it for the easiest ~25% of tasks, **never write single-step
  plans**, and update it after finishing each sub-task.

### Handling orders (`session/input_queue.rs`, `inject.rs`)
- Input that arrives while a turn is active goes into a session-scoped
  **`input_queue`** (typed `TurnInput`: user input, injected response items,
  inter-agent mail).
- It is **drained into history at the top of every sampling iteration**, so a
  user message is a **steer inside the running turn**, not a new turn. Draining
  is deferred in two cases: at turn start, so the fresh input is sampled first,
  and right after auto-compaction, so the continuation resumes before the steer.
- `has_pending_input` keeps the loop going, so the model always sees what you
  sent before it ends the turn.
- The same queue carries **inter-agent mailbox messages** in delivery order.
  Sub-agents talk to the parent through the same channel as the user.
- Interrupts abort the turn (`TurnAborted`) and are recorded in history, so the
  model knows it was cut off.

---

## 5. Side-by-side

| | Claude Code | OpenCode | Codex |
|---|---|---|---|
| Tool-call format | Native tool use | Native (AI SDK, any provider) | Native Responses API + freeform grammar tool for patches |
| Read | `Read` tool, line-numbered, paged | `read` tool, `N: line`, 2000 lines / 50KB cap, dirs too | **No read tool**: `cat`/`sed`/`rg` in the sandboxed shell |
| Search | `Glob` + `Grep` (or `rg` via Bash) | `glob` + `grep` + `lsp` | `rg` via shell |
| Edit | Exact `old→new`, unique, read-first; **no fuzz** | `old→new` with **9-stage fuzzy matcher**; `apply_patch` for GPT | **`apply_patch`**, multi-file, context-anchored, lightly fuzzy |
| Post-edit feedback | Diagnostics via LSP plugin | **Formatter + LSP errors appended to the result** | Turn-level unified diff |
| Undo | File snapshots before each edit (checkpoints) | Shadow-git snapshot per step, revert per message | Turn diff; relies on git |
| Todo tool | `TodoWrite` → `Task*` (IDs, deps, persisted, shareable); **off by default for newest models** | `todowrite`, full replace, stored in DB, 4 states + priority | `update_plan`, **stateless**, returns "Plan updated" |
| Plan mode | Read-only mode + `ExitPlanMode` approval | `plan` agent, writes a **plan file** that `build` then executes | Plan mode; checklist tool forbidden inside it |
| Mid-turn message | Queued; delivered **after current tool calls, same turn**; leftovers become later turns one at a time | Persisted; picked up at the **next loop step** (exit check uses the latest user msg) | `input_queue` **drained every sampling step**; pending input forces follow-up |
| Loop guards | Compaction thrash stop | Step cap, **doom-loop (3 identical calls)**, overflow check | Pre-sampling compaction, sandbox and approvals |

---

## 6. What this means for Spacron

Spacron's orchestrator (`orchestrator-brain.ts`, `chat-turn.ts`,
`stores/orchestrator.ts`) today works like this, according to the
`orchestrator-tool-calling` memory note, checked against the file layout:

- **Text-protocol tools.** The brain asks for a JSON FINAL or `tool_calls` inside
  plain text through `ai_complete`, and needs recovery passes when a model
  answers in prose.
- **A 4-round tool cap.**
- **`update_todos`** with 5 states (`[ ]` `[~]` `[x]` `[!]` `[-]`) and a lot of
  merge and reconciliation logic (`mergeTodoItems`, `todoRowMatcher`,
  `findOmittedPlanItems`, and a single re-send request when rows are omitted).
- **Six single-use recovery flags** covering bare acks, deferrals, claimed writes
  without a write, missing verification, and similar failures.

What the three references suggest:

1. **Native tool calling removes most of the recovery machinery.** None of the
   three parses tool calls from text. Protocol recovery, bare-ack nets and
   deferral recovery all exist mostly because the model can reply in prose
   *instead of* calling a tool. With native `tools` and a loop that ends only on
   a turn with no tool calls, a prose reply is simply the final answer. The
   `model-request-param-dialects` note says native tools were deferred because
   of per-provider request shapes. OpenCode solves exactly that with the Vercel
   AI SDK, one adapter per provider. That is the highest-leverage change.

2. **Replace the 4-round cap** with a step cap plus a doom-loop guard (OpenCode:
   3 identical calls in a row, then ask the user) plus overflow-triggered
   compaction. Four rounds is far below what any of these agents allow. They run
   dozens of steps per turn.

3. **Simplify the todo contract.** All three references use a **full-list
   replace** with the rule that each call is the whole truth. None of them does
   row matching or merging. Spacron's merge and pairing logic exists to survive
   partial re-statements. Choose one:
   - *OpenCode/Codex style*: replace wholesale, keep the "one `in_progress`" and
     "complete only after verification" rules in the prompt, and drop
     `mergeTodoItems`. Or:
   - *Claude Code Task style*: give items **IDs**, and let `update` take
     `{id, status}` patches. Row matching then becomes an ID lookup and the
     omitted-row problem goes away.

   OpenCode's rule text (§3) is a good prompt baseline. Codex's rule to "never
   make single-step plans" and Claude's decision to drop the tool for frontier
   models both argue for making the plan tool **optional** rather than required
   for every broad review.

4. **Mid-turn input should steer, not queue behind the turn.** Both Codex and
   Claude Code deliver a message typed mid-turn **at the next tool boundary of
   the same turn**, and Codex won't let a turn end while input is pending. If
   Spacron's chat mode currently makes the user wait for the turn to finish,
   copy Codex's approach: a per-thread input queue drained at the top of each
   loop iteration, plus `needs_follow_up ||= has_pending_input`.

5. **Edits.** For the orchestrator's own writes, copy OpenCode's `edit`:
   exact-first matching with fuzzy fallbacks, keeping the original line endings,
   a per-file lock, and a diff returned for review. The most valuable part is
   **appending formatter and LSP diagnostics to the edit result**. It gives the
   model free verification and directly addresses the problem
   `verificationRecoveryUsed` currently has to catch after the fact. Offer
   `apply_patch` when the brain model is an OpenAI model, since those models are
   trained on the format.

6. **Undo.** OpenCode's shadow-git snapshot per step fits Spacron's shared
   working tree well: it captures the state without touching the user's repo,
   index or stash (which the agent brief forbids), and makes per-message revert
   cheap.

7. **Reads.** Page by lines with a byte cap and a "continue at offset=N" footer,
   discourage tiny slices, and allow parallel reads. Track which files were
   read so edits can require a read first.

## Sources
- Claude Code docs: https://code.claude.com/docs/en/how-claude-code-works ·
  https://code.claude.com/docs/en/tools-reference ·
  https://code.claude.com/docs/en/interactive-mode (queueing, task list)
- OpenCode: https://github.com/anomalyco/opencode/tree/dev/packages/opencode/src
  (`session/prompt.ts`, `session/processor.ts`, `session/compaction.ts`,
  `session/overflow.ts`, `session/instruction.ts`, `session/todo.ts`,
  `session/run-state.ts`, `tool/read.ts`, `tool/edit.ts`, `tool/todo.ts`,
  `tool/todowrite.txt`)
- Codex: https://github.com/openai/codex/tree/main/codex-rs
  (`core/src/session/turn.rs`, `core/src/session/input_queue.rs`,
  `core/src/tools/handlers/plan.rs`, `plan_spec.rs`, `apply_patch.rs`,
  `apply-patch/src/seek_sequence.rs`, `core/gpt-5.2-codex_prompt.md`)
