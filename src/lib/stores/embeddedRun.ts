import { writable, get } from '$lib/stores/storeCompat';
import {
  ensureIdleOrCreateTerminal,
  createTerminalSession,
  killSession,
  sendPromptToSession,
  setActiveSession,
  onSessionExit,
  getSessionOutputLength,
  getSessionOutputSince,
} from '$lib/stores/terminal';
import { activeProject } from '$lib/stores/workspace';
import { showTerminal } from '$lib/stores/layout';
import { requestRoomControl, layoutSnapshot } from '$lib/stores/layoutControl';
import { showToast } from '$lib/stores/notification';
import {
  buildEmbeddedCommand,
  detectShellKind,
  parseEmbeddedExitCode,
} from '$lib/services/embeddedCommand';

export type EmbeddedRunStatus = 'idle' | 'running' | 'success' | 'error';
export type EmbeddedRunState = {
  status: EmbeddedRunStatus;
  exitCode?: number | null;
  startedAt?: number;
  finishedAt?: number;
};

// Keyed by `${mode}:${actionLabel}` so the panel can render a live chip (and
// the Arduino-IDE-style "file has been sent" confirmation) per command.
export const embeddedRuns = writable<Record<string, EmbeddedRunState>>({});

export function getEmbeddedRun(key: string): EmbeddedRunState {
  return get(embeddedRuns)[key] ?? { status: 'idle' };
}

function setEmbeddedRun(key: string, patch: Partial<EmbeddedRunState>) {
  embeddedRuns.update((runs) => {
    const prev = runs[key] ?? { status: 'idle' as const };
    return { ...runs, [key]: { ...prev, ...patch } };
  });
}

export type RunEmbeddedCommandOptions = {
  key: string;
  command: string;
  label: string;
  successMessage?: string;
  // Interactive commands (serial monitor, SSH into a board…) run forever,
  // so they must NOT be wrapped with a completion sentinel — the shell would
  // never get to the echo line. The run stays "running" until the user stops
  // the terminal, and no completion toast fires.
  interactive?: boolean;
  // Run without steering the UI to the terminal (no focus grab, no room
  // switch). Used by background probes like "is a board plugged in?" so a
  // connectivity check doesn't yank the user off what they were doing.
  quiet?: boolean;
  // Run the command in a DEDICATED HIDDEN terminal session — no pane, no tab,
  // silence on exit. The session is created fresh for the run and killed once
  // the command settles, so the user's own terminal is never polluted with
  // probe output. Implies `quiet`.
  background?: boolean;
  // Show the completion toasts. Turn off for background probes, which update
  // a status chip instead of pinging the user.
  notify?: boolean;
  timeoutMs?: number;
};

export type RunEmbeddedCommandResult = {
  exitCode: number | null;
  output: string;
};

const POLL_INTERVAL_MS = 300;
const DEFAULT_TIMEOUT_MS = 10 * 60 * 1000;

// Sends a command into the project's terminal and watches the output for the
// completion sentinel emitted by `buildEmbeddedCommand`. Resolves with the
// exit code the command reported (0 = success) plus everything the command
// wrote, or `{ exitCode: null }` if the terminal closed first or the run was
// interactive. The sentinel wraps the command in the active shell's own
// dialect, so this works whether the user's shell is cmd, PowerShell, bash or
// zsh without the panel knowing anything about shells.
export async function runEmbeddedCommand(
  options: RunEmbeddedCommandOptions,
): Promise<RunEmbeddedCommandResult> {
  const {
    key,
    command,
    label,
    interactive,
    successMessage,
    quiet = false,
    background = false,
    notify = true,
    timeoutMs = DEFAULT_TIMEOUT_MS,
  } = options;
  const project = get(activeProject);
  if (!project) {
    showToast('Open a project before running embedded commands', 'warning');
    setEmbeddedRun(key, { status: 'error' });
    return { exitCode: null, output: '' };
  }

  const isDev = get(layoutSnapshot).ambient === 'development';
  // Background probes get their own hidden session so the terminal the user is
  // looking at never sees the probe's commands or output. Everything else runs
  // in the project shell (reusing an idle one where possible).
  let sessionId: number | null;
  if (background) {
    sessionId = await createTerminalSession(project.root_path, undefined, project.id, {
      isDev,
      assignPane: false,
      hidden: true,
    });
  } else {
    sessionId = await ensureIdleOrCreateTerminal(project.root_path, project.id, isDev);
  }
  if (sessionId === null) {
    showToast(`Could not start a terminal for "${label}"`, 'error');
    setEmbeddedRun(key, { status: 'error' });
    return { exitCode: null, output: '' };
  }

  // Background implies quiet: a hidden probe must never grab focus.
  const noSteer = quiet || background;
  if (!noSteer) {
    setActiveSession(sessionId);
    if (!isDev) showTerminal();
    requestRoomControl('focus', isDev ? 'dev-terminal' : 'terminal');
  }

  const startedAt = Date.now();
  setEmbeddedRun(key, { status: 'running', startedAt, exitCode: null });

  if (interactive) {
    sendPromptToSession(sessionId, command);
    showToast(`${label} opened in terminal`, 'info');
    // No completion sentinel for interactive runs — the command outlives the
    // sentinel. The run chip stays "running" so the user can see the board is
    // live in the terminal.
    return { exitCode: null, output: '' };
  }

  const shellKind = detectShellKind();
  const wrapper = buildEmbeddedCommand(command, shellKind);
  const outputStart = getSessionOutputLength(sessionId);

  sendPromptToSession(sessionId, wrapper.text);

  return new Promise<RunEmbeddedCommandResult>((resolve) => {
    let settled = false;
    let timer: ReturnType<typeof setInterval> | null = null;

    const settle = (
      result: RunEmbeddedCommandResult,
      status: EmbeddedRunStatus,
      exitCode: number | null,
    ) => {
      if (settled) return;
      settled = true;
      if (timer) clearInterval(timer);
      unlisten();
      setEmbeddedRun(key, { status, exitCode, finishedAt: Date.now() });

      if (notify && status === 'success' && successMessage) {
        showToast(successMessage, 'success', 5000, true);
      } else if (notify && status === 'error') {
        const detail = exitCode !== null ? ` (exit ${exitCode})` : '';
        showToast(`${label} failed${detail} — see terminal`, 'error', 6000);
      }
      // Background sessions are one-shot: reclaim the hidden terminal the
      // moment the command settles so no orphaned probe shells accumulate.
      if (background) void killSession(sessionId);
      resolve(result);
    };

    const unlisten = onSessionExit((info) => {
      if (info.sessionId === sessionId) settle({ exitCode: null, output: '' }, 'error', null);
    });

    const timeout = setTimeout(() => settle({ exitCode: null, output: '' }, 'error', null), timeoutMs);

    timer = setInterval(() => {
      const output = getSessionOutputSince(sessionId, outputStart);
      const exitCode = parseEmbeddedExitCode(output, wrapper.match);
      if (exitCode !== null) {
        clearTimeout(timeout);
        settle({ exitCode, output }, exitCode === 0 ? 'success' : 'error', exitCode);
      }
    }, POLL_INTERVAL_MS);
  });
}