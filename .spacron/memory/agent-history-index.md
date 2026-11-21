# Agent History index (Fleet → History tab)

`agent_history.rs` only **lists**; the CLIs own the transcripts, so nothing here deletes or edits them. It
supersedes the "scope decision pending" in [[agent-history-persistence]]: we index native stores (approach 2),
for Claude, Codex and OpenCode only.

Traps found on real files (not in any doc):
- Codex user turns are `response_item` messages, not `event_msg`. Most are injected context (`<environment_context>`,
  `# AGENTS.md`, …); only the first non-injected `input_text` is the prompt.
- Claude files mix harness lines into `type:"user"` (slash commands, hook output, tool results). A real prompt is
  text that does not start with `<`/`Caveat:`; sidechain (subagent) lines are skipped.
- Cache key is (mtime, size) per file; a >48 MB transcript is read for its opening only (message count 0).
- Adding any `.rs` file restarts a watching `tauri dev` ([[tauri-dev-restarts]]); the module was compiled and tested
  first in a scratch crate, then registered in one go.
- Spacron launches Codex (and Claude) under a managed **account home** (`<app config>/agent-accounts/<provider>/<id>`,
  env `CODEX_HOME` / `CLAUDE_CONFIG_DIR`). A session lives only in the home of the account that wrote it, so the index
  scans every home, rows carry `account`, and resume must pass that account (`default` = the CLI's own home). Passing
  nothing resumes under the *selected* account and Codex answers "no rollout found for thread id".
- The backend refuses to open a terminal outside an open project, so a session whose folder is elsewhere cannot be
  resumed from here (the History buttons are disabled for it).
