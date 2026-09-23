/**
 * Who should finish the work when the agent holding it runs out of headroom.
 *
 * Deliberately pure: everything here is a function of a usage roster and a few
 * settings, with no I/O and no store reads. That is not tidiness for its own
 * sake — the decision it makes is "kill a working agent and move a half-built
 * feature to a different one", and the only way to have confidence in that is
 * to be able to test every branch of it without a running agent and a real
 * rate limit. The side effects live in `agent-handover.ts`, which calls this.
 *
 * ## The ladder
 *
 * Cheapest hop first. Another account of the *same* CLI costs nothing new, has
 * identical tools and identical prompt handling, and the CLI's own session
 * resume may still carry the conversation — so it is always tried before a
 * different CLI.
 *
 *   1. Same CLI, another signed-in account with headroom.
 *   2. A different CLI with headroom.
 *   3. Nothing qualifies → stop, and say when the earliest limit resets.
 *
 * Two exclusions apply throughout, and both exist to stop a handover that only
 * *looks* like one:
 *
 * - **No shared login.** A managed Claude account on macOS has no credential of
 *   its own (the login Keychain holds one item per CLI), so it resolves to the
 *   default account's login. Hopping to it hands the work back to the account
 *   that just ran out. `distinctLogin` is how Rust reports that.
 * - **No silent CLIs.** Outside `MCP_CONFIGURABLE_EXECUTABLES` an agent has no
 *   way to declare its own turn end, so the orchestrator is back to inferring
 *   one — which defeats the point of failing over for reliability. Those are
 *   excluded from *automatic* failover; the user can still dispatch them by
 *   hand, where the weaker completion claim is a choice they made.
 */

import type { ProviderUsage, UsageWindow } from '$lib/stores/usage';
import type { AccountUsage } from '$lib/stores/agentAccounts';
import { MCP_CONFIGURABLE_EXECUTABLES } from './agent-capabilities';
import { agentExecutable } from './agent-rules-file';

/**
 * Default headroom, in percent, at which work is moved.
 *
 * The brief asked for "roughly 3-5%, mid-feature". Four sits in the middle of
 * that, and the number matters less than the direction: switching *before* the
 * wall means the outgoing agent still has enough left to be asked to wrap up
 * and commit, which is the whole difference between a handover and a crash.
 */
export const DEFAULT_FAILOVER_HEADROOM_PERCENT = 4;

/**
 * A candidate's headroom, flattened from the two rosters Rust reports.
 *
 * One row per *account* for the CLIs that switch accounts, and one row per CLI
 * for the ones that don't — because "which login is this" is the unit the
 * decision turns on, not "which CLI".
 */
export interface AccountHeadroom {
  /** Stable provider key: "claude", "codex". */
  provider: string;
  /** Launch command — the join key to the preset catalogue ("cursor-agent"). */
  command: string;
  /** Null for a CLI that has no account switching at all. */
  accountId: string | null;
  /** Email where the CLI records one, else the account id. Never a token. */
  label: string;
  /** Whether this is the account the user currently works as for this CLI. */
  active: boolean;
  /** False when this account shares another's login — see the module docs. */
  distinctLogin: boolean;
  status: ProviderUsage['status'];
  windows: UsageWindow[];
}

/** A chosen successor, and the sentence explaining why it was chosen. */
export interface SuccessorChoice {
  candidate: AccountHeadroom;
  /** `account` = same CLI, another login. `cli` = a different CLI entirely. */
  hop: 'account' | 'cli';
  /** Headroom the successor has, in percent. */
  headroomPercent: number;
}

export interface SuccessorPolicy {
  /** Move the work once headroom falls to or below this percentage. */
  headroomPercent?: number;
  /**
   * Whether a hop to a *different* CLI may happen automatically. A same-CLI
   * account hop spends the user's own plan and is always allowed; a
   * cross-provider hop may spend money on a different service, so it is a
   * setting rather than an assumption.
   */
  allowCrossProvider?: boolean;
  /**
   * Commands that are actually installed on this machine. A candidate not on
   * PATH cannot be launched, and offering it would turn "your work moved" into
   * "your work stopped somewhere new".
   */
  installedCommands?: ReadonlySet<string> | null;
}

/**
 * Headroom left on an account, in percent — 100 minus its *most* used window.
 *
 * The worst window is what binds: a CLI reports several at once (a 5-hour
 * session window, a weekly one), and an exhausted weekly budget stops work just
 * as completely as an exhausted session one. Taking the maximum used percentage
 * means any one of them crossing the line is enough, which is the conservative
 * reading and the one that cannot strand a task at a wall it could see coming.
 *
 * Null when the account reports no windows at all — which is not "plenty of
 * room", it is "no reading", and every caller here has to treat the two
 * differently.
 */
export function headroomPercent(windows: readonly UsageWindow[]): number | null {
  if (!windows.length) return null;
  const worst = windows.reduce((max, w) => Math.max(max, w.usedPercent), 0);
  return Math.max(0, 100 - worst);
}

/** Unix ms at which a window resets, whichever form the provider gave. */
function resetAtMs(window: UsageWindow): number | null {
  if (window.resetsAtEpochSecs != null) return window.resetsAtEpochSecs * 1000;
  if (window.resetsAtIso) {
    const parsed = Date.parse(window.resetsAtIso);
    if (!Number.isNaN(parsed)) return parsed;
  }
  return null;
}

/**
 * When the first of these accounts gets its headroom back.
 *
 * This is what turns "everything is out of room" from a shrug into a fact the
 * user can plan around: the meters already carry a reset instant per window, so
 * there is no reason to make them wait and find out.
 *
 * Only windows that are actually exhausted count. A weekly window resetting on
 * Sunday is not the answer when the 5-hour one that is blocking work comes back
 * in twenty minutes.
 */
export function earliestResetMs(
  readings: readonly AccountHeadroom[],
  policy: SuccessorPolicy = {},
  now = Date.now()
): number | null {
  const limit = policy.headroomPercent ?? DEFAULT_FAILOVER_HEADROOM_PERCENT;
  let earliest: number | null = null;
  for (const reading of readings) {
    for (const window of reading.windows) {
      if (100 - window.usedPercent > limit) continue;
      const at = resetAtMs(window);
      if (at == null || at <= now) continue;
      if (earliest == null || at < earliest) earliest = at;
    }
  }
  return earliest;
}

/**
 * Flatten the two rosters Rust reports into one list of candidate logins.
 *
 * `accounts` covers the CLIs that hold several logins (Claude Code, Codex);
 * `providers` covers everything else, where the CLI *is* the login. Merging
 * them here rather than in the ranking keeps the ranking a pure sort over one
 * shape, and means a CLI that gains account switching later needs no change
 * below this line.
 */
export function buildAccountRoster(
  providers: readonly ProviderUsage[],
  accounts: readonly AccountUsage[]
): AccountHeadroom[] {
  const roster: AccountHeadroom[] = accounts.map((account) => ({
    provider: account.provider,
    command: account.usage.command,
    accountId: account.accountId,
    label: account.label,
    active: account.active,
    distinctLogin: account.distinctLogin,
    status: account.usage.status,
    windows: account.usage.windows,
  }));

  const covered = new Set(accounts.map((account) => account.provider));
  for (const provider of providers) {
    if (covered.has(provider.provider)) continue;
    roster.push({
      provider: provider.provider,
      command: provider.command,
      accountId: null,
      label: provider.account ?? provider.name,
      active: true,
      distinctLogin: true,
      status: provider.status,
      windows: provider.windows,
    });
  }
  return roster;
}

/**
 * Whether the login currently holding the work has run out of room.
 *
 * Returns false when there is no reading at all. A missing meter is not
 * evidence of exhaustion, and acting on it would stop a healthy agent
 * mid-feature every time a poll failed — the expensive direction to be wrong in.
 */
export function isExhausted(
  reading: AccountHeadroom | null | undefined,
  policy: SuccessorPolicy = {}
): boolean {
  if (!reading || reading.status !== 'ok') return false;
  const left = headroomPercent(reading.windows);
  if (left == null) return false;
  return left <= (policy.headroomPercent ?? DEFAULT_FAILOVER_HEADROOM_PERCENT);
}

/** Find the roster row for a running agent's CLI and account. */
export function findReading(
  roster: readonly AccountHeadroom[],
  command: string | null | undefined,
  accountId: string | null | undefined
): AccountHeadroom | null {
  if (!command) return null;
  const executable = agentExecutable(command);
  const forCli = roster.filter((row) => agentExecutable(row.command) === executable);
  if (!forCli.length) return null;
  if (accountId) {
    const exact = forCli.find((row) => row.accountId === accountId);
    if (exact) return exact;
  }
  // No account was recorded for this launch (an agent started before failover
  // existed, or a CLI with no switching): the selected account is the one it is
  // running as.
  return forCli.find((row) => row.active) ?? forCli[0];
}

/** Whether this CLI can declare its own turn end — see the module docs. */
function canDeclareTurnEnd(command: string): boolean {
  return MCP_CONFIGURABLE_EXECUTABLES.has(agentExecutable(command));
}

function isUsable(
  candidate: AccountHeadroom,
  policy: SuccessorPolicy,
  limit: number
): boolean {
  if (candidate.status !== 'ok') return false;
  // A login that is not its own cannot have headroom of its own.
  if (!candidate.distinctLogin) return false;
  if (!canDeclareTurnEnd(candidate.command)) return false;
  if (policy.installedCommands && !policy.installedCommands.has(candidate.command)) return false;
  const left = headroomPercent(candidate.windows);
  // No windows is no reading. Launching into an unknown is how a handover turns
  // into a second stop nobody saw coming, so an unmeasured account is not a
  // candidate — it is simply not evidence.
  return left != null && left > limit;
}

/**
 * Every account that could take the work, best first.
 *
 * Returned rather than just the winner so the caller can say *what else it
 * considered* — a handover the user cannot audit is a handover they cannot
 * trust. Ordering, in strict precedence:
 *
 *   1. same CLI before a different CLI (the ladder's whole point);
 *   2. more headroom before less (finishing the feature is the goal);
 *   3. the user's selected account before a managed one, as a tiebreak, so a
 *      hop with nothing to choose between it lands somewhere unsurprising.
 */
export function rankSuccessors(
  roster: readonly AccountHeadroom[],
  current: { command: string | null | undefined; accountId?: string | null },
  policy: SuccessorPolicy = {}
): SuccessorChoice[] {
  const limit = policy.headroomPercent ?? DEFAULT_FAILOVER_HEADROOM_PERCENT;
  const executable = agentExecutable(current.command ?? '');
  const allowCrossProvider = policy.allowCrossProvider ?? true;

  const choices: SuccessorChoice[] = [];
  for (const candidate of roster) {
    const sameCli = Boolean(executable) && agentExecutable(candidate.command) === executable;
    // Never hand work back to the login that just ran out of it.
    if (sameCli && (candidate.accountId ?? null) === (current.accountId ?? null)) continue;
    // A CLI with no account switching has one login, so "the same CLI, another
    // account" does not exist for it — there is nothing to hop to.
    if (sameCli && candidate.accountId == null) continue;
    if (!sameCli && !allowCrossProvider) continue;
    if (!isUsable(candidate, policy, limit)) continue;

    choices.push({
      candidate,
      hop: sameCli ? 'account' : 'cli',
      headroomPercent: headroomPercent(candidate.windows) ?? 0,
    });
  }

  return choices.sort((a, b) => {
    if (a.hop !== b.hop) return a.hop === 'account' ? -1 : 1;
    if (a.headroomPercent !== b.headroomPercent) return b.headroomPercent - a.headroomPercent;
    if (a.candidate.active !== b.candidate.active) return a.candidate.active ? -1 : 1;
    return a.candidate.command.localeCompare(b.candidate.command);
  });
}

/** The single best successor, or null when nothing qualifies. */
export function chooseSuccessor(
  roster: readonly AccountHeadroom[],
  current: { command: string | null | undefined; accountId?: string | null },
  policy: SuccessorPolicy = {}
): SuccessorChoice | null {
  return rankSuccessors(roster, current, policy)[0] ?? null;
}

/** "in 2h 14m" / "in 3d". Null when no reset instant is known. */
export function describeWait(atMs: number, now = Date.now()): string | null {
  const mins = Math.round((atMs - now) / 60000);
  if (mins <= 0) return null;
  if (mins < 60) return `in ${mins}m`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) {
    const rest = mins % 60;
    return rest ? `in ${hours}h ${rest}m` : `in ${hours}h`;
  }
  return `in ${Math.round(hours / 24)}d`;
}

/**
 * What to tell the user when the ladder has no rung left.
 *
 * Ends with a real time wherever the meters carry one, because "everything is
 * out of room" without a "back at" is the answer that leaves someone refreshing
 * a panel all afternoon.
 */
export function describeNothingQualifies(
  roster: readonly AccountHeadroom[],
  policy: SuccessorPolicy = {},
  now = Date.now()
): string {
  const reset = earliestResetMs(roster, policy, now);
  const wait = reset == null ? null : describeWait(reset, now);
  const base = 'No signed-in agent has enough usage left to finish this.';
  return wait ? `${base} The earliest limit resets ${wait}.` : base;
}

/** How a hop reads in an activity row or a completion card. */
export function describeHop(choice: SuccessorChoice, fromLabel: string | null): string {
  const to = choice.candidate.accountId
    ? `${choice.candidate.command} (${choice.candidate.label})`
    : choice.candidate.command;
  const left = Math.round(choice.headroomPercent);
  return choice.hop === 'account'
    ? `another ${choice.candidate.command} account, ${to}, with ${left}% left`
    : `${to}${fromLabel ? ` instead of ${fromLabel}` : ''}, with ${left}% left`;
}
