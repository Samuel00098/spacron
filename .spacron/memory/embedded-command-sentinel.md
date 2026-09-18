# Embedded command completion sentinel

`runEmbeddedCommand` (src/lib/stores/embeddedRun.ts) knows a blocking command is
done by watching terminal output for a sentinel `buildEmbeddedCommand` appends
(src/lib/services/embeddedCommand.ts). The full reasoning lives in the code
comments; what the code cannot tell you:

- The sentinel is emitted on a **fresh second line** (`command\necho …`), not
  joined with `;` or `&`. On cmd, `%ERRORLEVEL%` is expanded at parse time, so
  `cmd & echo %ERRORLEVEL%` echoes the *previous* line's code — this made the
  `&`-suffix scheme silently always report the last command's exit code.
- Wrapping is shell-dialect-aware via `detectShellKind()` (reads
  `settings.terminalShell`; unset falls back to `navigator.platform`). Regex is
  global (`g` flag) because `String.prototype.matchAll` throws otherwise — the
  test suite caught this.
- Every run uses a random token so a stale sentinel from an earlier run in the
  same terminal session can't match (last-match-wins in `parseEmbeddedExitCode`).
- Interactive commands (serial monitor, remote shell) must be sent **unwrapped**;
  they run forever and never hit the echo line. That is intentional.

Related: [[terminal-cell-measure-stuck]] for terminal quirks in general.