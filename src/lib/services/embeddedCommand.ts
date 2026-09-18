import { get } from '$lib/stores/storeCompat';
import { terminalShell } from '$lib/stores/settings';

export type EmbeddedShellKind = 'cmd' | 'pwsh' | 'sh';

export const EMBEDDED_DONE_PREFIX = '__SPACRON_EMBEDDED_DONE_';

// The shell that will receive an embedded command. The terminal store defaults
// to PowerShell on Windows (shell.rs prefers pwsh → powershell → cmd) and an sh
// family everywhere else, but the user can pin one via the `terminalShell`
// setting — that value wins when it names a shell.
export function detectShellKind(): EmbeddedShellKind {
  const setting = (get(terminalShell) || '').toLowerCase();
  if (setting.includes('cmd')) return 'cmd';
  if (setting.includes('powershell') || setting.includes('pwsh')) return 'pwsh';
  if (setting.includes('bash') || setting.includes('zsh') || setting.includes('sh')) return 'sh';
  const platform = typeof navigator !== 'undefined' ? navigator.platform.toLowerCase() : '';
  return /win/.test(platform) ? 'pwsh' : 'sh';
}

// A unique token per run. The completion line includes it so a stale sentinel
// from an earlier command can never satisfy the matcher for the current one —
// the typed-echo of a previous run lingers in the output window during long
// commands, and a token is what keeps it from looking alive.
export function makeRunToken(): string {
  return Math.random().toString(36).slice(2, 8);
}

// Wraps an embedded command so the shell prints a completion sentinel carrying
// the command's own exit code. The sentinel is a SECOND line, not a `;`/`&`
// suffix, for two reasons:
//   - `%ERRORLEVEL%` in cmd.exe is expanded when the whole compound line is
//     parsed, so `cmd & echo ...%ERRORLEVEL%` reports the PREVIOUS result.
//     A fresh line resolves it after the command actually runs.
//   - it reads identically in cmd, PowerShell, bash and zsh, so the wrapper
//     never depends on which separator a shell accepts.
// The typed echo of the sentinel line has no digits in it (`$?`, `$LASTEXITCODE`,
// `%ERRORLEVEL%`), so the matcher only ever lands on the executed echo. Expects
// `command` to be a single logical line (it is, for every embedded preset).
export function buildEmbeddedCommand(
  command: string,
  shellKind: EmbeddedShellKind = detectShellKind(),
  token: string = makeRunToken(),
): { text: string; match: RegExp } {
  const trimmed = command.trim();
  const marker = `${EMBEDDED_DONE_PREFIX}${token}_`;
  if (shellKind === 'cmd') {
    return { text: `${trimmed}\necho ${marker}%ERRORLEVEL%__`, match: sentinelMatcher(marker) };
  }
  const codeExpr = shellKind === 'pwsh' ? '${LASTEXITCODE}' : '$?';
  return { text: `${trimmed}\necho "${marker}${codeExpr}__"`, match: sentinelMatcher(marker) };
}

function sentinelMatcher(marker: string): RegExp {
  return new RegExp(`${escapeRegExp(marker)}(\\d+)__`, 'g');
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// The last matching exit code in `output`. `.matchAll(...)` and take the last,
// because the executed completion line always trails the typed echo of it, and
// an old identical line from a previous run is the one case a token can't
// fully rule out (buffer window slid past the `from` snapshot).
export function parseEmbeddedExitCode(output: string, match: RegExp): number | null {
  let found: number | null = null;
  match.lastIndex = 0;
  for (const m of output.matchAll(match)) {
    found = Number(m[1]);
  }
  return found;
}

export type DetectedPortEntry = {
  port: string;
  name: string | null;
  fqbn: string | null;
};

// Parses `arduino-cli board list --format json` output. The command echoes its
// own text (typed echo) plus ANSI noise around the JSON, so slice from the
// first `[` to the last `]` before parsing. Returns the first port that has a
// matching board, which is the one worth auto-selecting.
export function parseBoardListJson(output: string): DetectedPortEntry | null {
  const start = output.indexOf('[');
  const end = output.lastIndexOf(']');
  if (start < 0 || end <= start) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(output.slice(start, end + 1));
  } catch {
    return null;
  }
  if (!Array.isArray(parsed)) return null;
  for (const entry of parsed) {
    const address = entry?.port?.address;
    const board = entry?.matching_boards?.[0];
    if (typeof address === 'string' && address && board) {
      return {
        port: address,
        name: typeof board.name === 'string' ? board.name : null,
        fqbn: typeof board.fqbn === 'string' ? board.fqbn : null,
      };
    }
  }
  return null;
}