# CLIs that announce their own turn end (Codex `notify`)

`report_status` and the shell channel both depend on the agent choosing to speak. A CLI's own hook does not, so where one exists Spacron
installs it per launch and has it write into the SAME channel file ([[agent-report-status]]). Nothing downstream changed: the tailer, `parseSignalLine`,
`deliverTurnSignal` and the cards are shared.

Today only Codex: `agent_turn_signal_flags` (`agent_signals.rs`) returns ` -c "notify=[...]"`, appended in `spawnAgentPreset`. The helper script reads
`SPACRON_TURN_FILE` / `SPACRON_TURN_TOKEN` from its environment and appends `SPACRON-NOTIFY:<nonce> <json>`; the JSON is parsed in TS, not in the script.

Traps:
- The program must NOT be a `.cmd`: Rust refuses JSON arguments to batch files ("batch file arguments are invalid", the same error that broke bot runs of
  `claude.cmd`). Windows uses `powershell.exe -File`, others `sh`.
- `notify` is ignored in a project's `.codex/config.toml`, and a user's own top-level `notify` is respected (flag omitted), so we never replace their notifier.
- **Not yet seen firing live**: the account hit its usage limit during verification. The script and the `-c` parse were checked; the turn-complete event was not.
- **Antigravity (`agy`)** is the exception to "per launch": `--settings` rejects a `hooks` key and hooks load only from `.agents/hooks.json` or
  `~/.gemini/config/hooks.json`. Spacron therefore adds ONE entry named `spacron-status` to the user's global file (merged, atomic write, other hook names
  untouched, a file that is not a JSON object is left alone) and removes it when status hooks are turned off. The script is env-gated, so it is inert outside
  a Spacron launch. Seen working live in print mode (`-p`): `Stop` fires with JSON on stdin (`fullyIdle`, `terminationReason`, `error`) and inherits the env.
  Not checked: whether `Stop` fires once per turn or only when a whole interactive session goes idle; the docs do not say.
- Gemini CLI (`AfterAgent`/`Notification`), OpenCode (plugin `session.idle`) and Cursor (`stop` in hooks.json) are not wired. Gemini was not installed to test;
  OpenCode 2.x runs a background server so a terminal-env helper may not inherit `SPACRON_TURN_FILE`; Cursor's user hooks.json is shared with other tools.
