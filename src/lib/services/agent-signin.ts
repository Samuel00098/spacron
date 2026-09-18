import { showToast } from '$lib/stores/notification';
import { get } from '$lib/stores/storeCompat';
import {
  createTerminalSession,
  writeToSession,
  setActiveSession,
  onSessionExit,
  markSessionAgentPreset,
  getAgentDisplayName,
  updateSessionTitle,
  suppressSessionAgentDetection,
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
 * Beat after the sign-in session exits before forcing a re-scan. The login
 * flow writes its credential file while the CLI is shutting down; a scan a
 * moment later sees the finished file instead of a half-written one.
 */
const SIGNIN_REFRESH_DELAY_MS = 1200;

/**
 * Open a dedicated agent room running `command` so the user can complete the CLI's
 * sign-in flow. The one shared action behind every "Sign in" hint in the UI
 * (the spawn picker, the Agents settings pane, and the account switcher); each
 * surface closes its own overlay before calling.
 *
 * Spawns a standalone agent session with `assignPane: false` so it never occupies,
 * steals, or empties a slot in the personal terminal mosaic. Marks the session
 * briefed to prevent prompt-bar charter delivery during login, suppresses typed
 * detection during launch, and focuses the agent's dedicated room. When that session
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
   */
  extraEnv?: Record<string, string>;
  /** Appended to the launch line, e.g. `/login`. */
  args?: string;
  /** Overrides the "taking you to a terminal" toast when the context differs. */
  toast?: string;
}): Promise<void> {
  const isDev = opts.isDev ?? false;
  // Create a standalone session: it lives in `sessions` (so it surfaces as an
  // agent room) but is NOT assigned to any pane in the personal terminal mosaic.
  // Passing `assignPane: false` and `agentPreset` ensures the session is born an
  // agent and never claims or empties any pane in the user's terminal grid.
  const sessionId = await createTerminalSession(opts.cwd, undefined, opts.projectId, {
    assignPane: false,
    agentPreset: opts.command,
    isDev,
    extraEnv: opts.extraEnv,
  });
  if (sessionId === null || sessionId === undefined) {
    showToast(`Couldn't open a terminal to sign in to ${opts.name}`, 'error');
    return;
  }

  // Prevent auto-briefing during sign-in: setting briefed=true stops autoBriefSession
  // from attempting to paste charter/prompts into the CLI while it awaits login credentials.
  markSessionAgentPreset(sessionId, opts.command, true);
  const displayName = getAgentDisplayName(opts.command) ?? opts.name ?? opts.command;
  updateSessionTitle(sessionId, displayName);

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
  const launchCommand = resolveAgentLaunchCommand(opts.command, {
    agentCmdOverrides: get(agentCmdOverrides),
    agentDefaultArgs: get(agentDefaultArgs),
    agentDefaultEnv: get(agentDefaultEnv),
  });
  const launchLine = opts.args ? `${launchCommand} ${opts.args}` : launchCommand;

  const restoreDetection = suppressSessionAgentDetection(sessionId);
  try {
    writeToSession(sessionId, `${launchLine}\r`);
  } finally {
    restoreDetection();
  }

  setActiveSession(sessionId);
  // Bring the agent room on stage so the user actually lands in it —
  // keeping the personal terminal grid completely untouched.
  requestRoomControl('focus', `agent:${sessionId}`);
  showToast(
    opts.toast ??
      `Taking you to an agent room running \`${launchLine}\`. Complete the sign-in there; the list refreshes automatically when it closes.`,
    'info',
    6000
  );
}
