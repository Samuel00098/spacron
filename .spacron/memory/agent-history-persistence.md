# Agent history persistence — gap & two viable approaches

Spacron persists agent *structure* (which agents existed, where, in what layout)
but **not content**: `sessionOutputBuffers` and `commandBlocks` are in-memory only,
and there is **no archive directory** today. On restart, `restorePane` re-launches the
CLI into a fresh PTY with zero recalled context. `runHistory.ts` is a dead template
(`addRunEntry` has no caller) that already sketches the localStorage shape.

Orca (`stablyai/orca`) does **not** own history either — it is an *indexer*: it scans
each CLI's own transcript store (Claude `~/.claude/projects/*.jsonl`, Codex
`~/.codex/sessions`, OpenCode `~/.local/share/opencode/opencode.db` SQLite) and builds
a per-agent `--resume`/`--session` shell command queued into a live terminal tab. It
persists only acceleration caches (a JSON parse-cache + a 60s TTL result cache).

Two ways to give spacron continuous, resumable histories:
1. **Capture our own PTY scrollback** to disk at the `onData` boundary
   (`terminal.ts:1207` / `appendSessionOutputBuffer` L798). Most robust cross-agent
   because spacron owns the PTY, but raw bytes only (no structured turns).
2. **Index native transcript stores** like Orca, for rich resume of agents that keep
   their own history (OpenCode/Claude/Codex). More faithful to Orca, per-CLI parsing.

Recommended: do (1) first (durable `agentId` UUID + per-project JSONL under
`config_dir/project-state/<id>/sessions/<agentId>.jsonl`, replay in `restorePane`),
then layer (2) for structured resume. Project drop-down maps to existing first-class
`Project` model + `terminalPanes[].agentPreset/agentName`; no literal Orca-style
project picker needed because projects are already first-class.

Scope-decision pending with user (full vs slice). See plan in chat.
