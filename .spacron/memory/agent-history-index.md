# Agent History index (Fleet → History tab)

`agent_history.rs` only **lists**; the CLIs own the transcripts, so nothing here deletes or edits them. It
supersedes the "scope decision pending" in [[agent-history-persistence]]: we index native stores (approach 2),
for Claude, Codex, OpenCode, Grok, OpenClaude, Pi, OMP, Antigravity, Copilot and Cursor.
History options follow installed CLI detection plus custom agents and owners of old sessions; detection
refreshes on mount, focus and every visible minute without fetching usage meters. Other agents are listed
with no reader yet. An unknown CLI resume route must stay disabled rather than opening a fresh session.

Traps found on real files (not in any doc):
- Codex user turns are `response_item` messages, not `event_msg`. Most are injected context (`<environment_context>`,
  `# AGENTS.md`, …); only the first non-injected `input_text` is the prompt.
- Claude files mix harness lines into `type:"user"` (slash commands, hook output, tool results). A real prompt is
  text that does not start with `<`/`Caveat:`; sidechain (subagent) lines are skipped.
- Cache key is (mtime, size) per file; a >48 MB transcript is read for its opening only (message count 0).
- Adding any `.rs` file restarts a watching `tauri dev` ([[tauri-dev-restarts]]); the module was compiled and tested
  first in a scratch crate, then registered in one go.
- Spacron launches account-capable agents under a managed **account home** (`<app config>/agent-accounts/<provider>/<id>`,
  env from `agent_accounts::provider_spec`). Grok and Antigravity need those homes too. A session lives only in the home of the account that wrote it, so the index
  scans every home, rows carry `account`, and resume must pass that account (`default` = the CLI's own home). Passing
  nothing resumes under the *selected* account and Codex answers "no rollout found for thread id".
- The backend refuses to open a terminal outside an open project, so a session whose folder is elsewhere cannot be
  resumed from here (the History buttons are disabled for it).

Resume/account invariants across the index, launcher and adapters:
- Persisted structured records snapshot `accountLabel` at launch. History matches snapshots by provider + native id + cwd + account id. Current login is not historical ownership; older native sessions without identity show a profile/unknown label. A recorded owner that differs from the profile's current login blocks resume.
- History passes its explicit account through quick-spawn and every adapter. ACP must use `options.accountId`, and `session/load` failures must stay failures. Session-store restore also passes the recorded account and never substitutes a new native conversation after failure.
- Pi resumes via `--session`, and its transcript lookup uses the header id, not the timestamped filename. A bound transcript that is missing must return no match, never the newest different session.
- Cursor's missing cwd is recovered only when its encoded transcript folder uniquely matches a known project/worktree; reversing the encoding itself is ambiguous.
