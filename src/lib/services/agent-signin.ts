import { showToast } from '$lib/stores/notification';
import { get } from '$lib/stores/storeCompat';
import {
  createTerminalSession,
  ensureIdleOrCreateTerminal,
  writeToSession,
  setActiveSession,
  onSessionExit,
} from '$lib/stores/terminal';
import { refreshUsage, type DetectedAgent } from '$lib/stores/usage';
import { requestRoomControl } from '$lib/stores/layoutControl';
import { agentCmdOverrides, agentDefaultArgs, agentDefaultEnv } from '$lib/stores/settings';
import { resolveAgentLaunchCommand } from './agent-permissions';

/**
 * Whether a row should offer the one-click sign-in affordance.
 *
 * Only when we *know* credentials are missing: installed, sign-in detectable,
 * and not signed in. Keychain/API-key CLIs (`detectsSignIn: false`) report
 * "unknown" rather than "signed out", so offering to run them would launch a
 * CLI that might already be signed in — their badge tooltip covers that case
 * instead. Shared by the spawn picker and the Agents settings pane so both
 * surfaces agree on what "needs a sign-in" means.
 */
export function shouldOfferSignIn(det: DetectedAgent | undefined): boolean {
  return Boolean(det?.installed && det.detectsSignIn && !det.signedIn);
}

/**
 * Open a terminal running `command` so the user can complete the CLI's
 * sign-in flow. The one shared action behind every "Sign in" hint in the UI
 * (the spawn picker and the Agents settings pane); each surface closes its own
 * overlay before calling.
 *
 * Reuses an idle shell when there is one (`ensureIdleOrCreateTerminal`), runs
 * the CLI with a submitted newline, and focuses the pane.
 */
/**
 * Beat after the sign-in session exits before forcing a re-scan. The login
 * flow writes its credential file while the CLI is shutting down; a scan a
 * moment later sees the finished file instead of a half-written one.
 */
const SIGNIN_REFRESH_DELAY_MS = 1200;

/**
 * Open a terminal running `command` so the user can complete the CLI's
 * sign-in flow. The one shared action behind every "Sign in" hint in the UI
 * (the spawn picker and the Agents settings pane); each surface closes its own
 * overlay before calling.
 *
 * Reuses an idle shell when there is one (`ensureIdleOrCreateTerminal`), runs
 * the CLI with a submitted newline, and focuses the pane. When that session
 * exits, a forced detection scan runs so the install/sign-in badge updates
 * without a manual Rescan.
 */
export async function runAgentSignIn(opts: {
  command: string;
  name: string;
  cwd: string;
  projectId: string;
  isDev?: boolean;
  /**
   * Environment the sign-in must run under — the config-dir variable that
   * points a CLI at a managed account (`CLAUDE_CONFIG_DIR`, `CODEX_HOME`).
   *
   * Its presence forces a **fresh** session: a PTY's environment is fixed when
   * it is spawned, so reusing an idle shell would run the login with whatever
   * env that shell started with and quietly write the credential into the
   * default account — the exact mix-up account switching exists to prevent.
   */
  extraEnv?: Record<string, string>;
  /** Appended to the launch line, e.g. `/login`. */
  args?: string;
  /** Overrides the "taking you to a terminal" toast when the context differs. */
  toast?: string;
}): Promise<void> {
  const isDev = opts.isDev ?? false;
  const hasEnv = Boolean(opts.extraEnv && Object.keys(opts.extraEnv).length > 0);
  const sessionId = hasEnv
    ? await createTerminalSession(opts.cwd, undefined, opts.projectId, {
        isDev,
        extraEnv: opts.extraEnv,
      })
    : await ensureIdleOrCreateTerminal(opts.cwd, opts.projectId, isDev);
  if (sessionId === null) {
    showToast(`Couldn't open a terminal to sign in to ${opts.name}`, 'error');
    return;
  }

  // One-shot watch: when THIS session closes, force a fresh scan so the badge
  // flips to "Signed in" without the user hitting Rescan. The listener
  // unregisters itself after the first matching exit, and exits from other
  // sessions (a normal shell being closed elsewhere) are ignored. Tradeoff: if
  // the user signs in and keeps the CLI open (never closes the session), the
  // listener lives for the app session — bounded, and the exit fires whenever
  // that terminal is eventually closed.
  const unsubscribe = onSessionExit((info) => {
    if (info.sessionId !== sessionId) return;
    unsubscribe();
    setTimeout(() => void refreshUsage(true), SIGNIN_REFRESH_DELAY_MS);
  });

  // Respect a user command override (custom binary), but deliberately no
  // permission-mode args/env — sign-in wants the bare CLI, not a skip-flags
  // launch.
  //
  // The typed-launch detector is deliberately NOT suppressed: writing the
  // command is exactly what a user typing it would do, so the session is
  // adopted as the agent (and stays usable as one after sign-in). Suppressing
  // it would leave a shell running the CLI that the app doesn't recognize.
  const launchCommand = resolveAgentLaunchCommand(opts.command, {
    agentCmdOverrides: get(agentCmdOverrides),
    agentDefaultArgs: get(agentDefaultArgs),
    agentDefaultEnv: get(agentDefaultEnv),
  });
  const launchLine = opts.args ? `${launchCommand} ${opts.args}` : launchCommand;
  writeToSession(sessionId, `${launchLine}\r`);
  setActiveSession(sessionId);
  // Bring the terminal room on stage so the user actually lands in it — the
  // session is created either way, but the room may be closed (it defaults
  // to hidden), which would leave the CLI running somewhere invisible. The
  // room controller resolves 'terminal' → 'dev-terminal' in the development
  // ambient, matching the pool the session was created in.
  requestRoomControl('focus', 'terminal');
  showToast(
    opts.toast ??
      `Taking you to a terminal running \`${launchLine}\`. Complete the sign-in there; the list refreshes automatically when it closes.`,
    'info',
    6000
  );
}
