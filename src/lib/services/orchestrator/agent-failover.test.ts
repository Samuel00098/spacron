import { describe, it, expect } from 'vitest';
import {
  DEFAULT_FAILOVER_HEADROOM_PERCENT,
  buildAccountRoster,
  chooseSuccessor,
  describeNothingQualifies,
  earliestResetMs,
  findReading,
  headroomPercent,
  isExhausted,
  rankSuccessors,
  type AccountHeadroom,
} from './agent-failover';
import type { ProviderUsage, UsageWindow } from '$lib/stores/usage';
import type { AccountUsage } from '$lib/stores/agentAccounts';

function win(usedPercent: number, extra: Partial<UsageWindow> = {}): UsageWindow {
  return {
    label: 'Session',
    usedPercent,
    windowMinutes: 300,
    resetsAtIso: null,
    resetsAtEpochSecs: null,
    ...extra,
  };
}

function account(over: Partial<AccountHeadroom> = {}): AccountHeadroom {
  return {
    provider: 'claude',
    command: 'claude',
    accountId: 'default',
    label: 'me@example.com',
    active: true,
    distinctLogin: true,
    status: 'ok',
    windows: [win(10)],
    ...over,
  };
}

describe('headroomPercent', () => {
  it('reports the worst window, not the average', () => {
    // A weekly budget at 99% stops work just as completely as a session one, so
    // the binding constraint has to be the one that answers.
    expect(headroomPercent([win(20), win(99)])).toBe(1);
  });

  it('distinguishes "no windows" from "plenty of room"', () => {
    // Null, not 100. Treating an unread meter as a full tank is how a handover
    // lands somewhere with nothing left.
    expect(headroomPercent([])).toBeNull();
  });
});

describe('isExhausted', () => {
  it('fires at the threshold, not only past it', () => {
    expect(isExhausted(account({ windows: [win(96)] }), { headroomPercent: 4 })).toBe(true);
    expect(isExhausted(account({ windows: [win(95)] }), { headroomPercent: 4 })).toBe(false);
  });

  it('treats a failed reading as no evidence rather than as exhaustion', () => {
    // Stopping a healthy agent mid-feature every time a poll fails is the
    // expensive direction to be wrong in.
    expect(isExhausted(account({ status: 'error', windows: [] }))).toBe(false);
    expect(isExhausted(account({ status: 'ok', windows: [] }))).toBe(false);
    expect(isExhausted(null)).toBe(false);
  });
});

describe('the ladder', () => {
  const spent = account({ accountId: 'default', windows: [win(98)] });

  it('prefers another account of the same CLI over a different CLI', () => {
    const roster = [
      spent,
      account({ accountId: 'work', label: 'work@example.com', active: false, windows: [win(20)] }),
      // More headroom, but a different CLI — and the ladder is not a sort by
      // headroom, it is cheapest-hop-first.
      account({ provider: 'codex', command: 'codex', accountId: 'default', windows: [win(2)] }),
    ];
    const choice = chooseSuccessor(roster, { command: 'claude', accountId: 'default' });
    expect(choice?.hop).toBe('account');
    expect(choice?.candidate.accountId).toBe('work');
  });

  it('falls through to a different CLI when no sibling account has room', () => {
    const roster = [
      spent,
      account({ accountId: 'work', active: false, windows: [win(97)] }),
      account({ provider: 'codex', command: 'codex', accountId: 'default', windows: [win(30)] }),
    ];
    const choice = chooseSuccessor(roster, { command: 'claude', accountId: 'default' });
    expect(choice?.hop).toBe('cli');
    expect(choice?.candidate.command).toBe('codex');
  });

  it('never hands the work back to the account that ran out', () => {
    const roster = [spent];
    expect(chooseSuccessor(roster, { command: 'claude', accountId: 'default' })).toBeNull();
  });

  it('skips a macOS account that shares the default login', () => {
    // The login Keychain holds one item per CLI, so a relocated config dir has
    // no credential of its own — hopping there is hopping into the same limit
    // under a different name. Rust reports that as `distinctLogin: false`.
    const roster = [
      spent,
      account({ accountId: 'work', active: false, distinctLogin: false, windows: [win(0)] }),
    ];
    expect(chooseSuccessor(roster, { command: 'claude', accountId: 'default' })).toBeNull();
  });

  it('skips a CLI that cannot declare its own turn end', () => {
    // Failing over to an agent whose completion can only ever be guessed at
    // defeats the point of failing over for reliability.
    const roster = [
      spent,
      account({ provider: 'aider', command: 'aider', accountId: null, windows: [win(0)] }),
    ];
    expect(chooseSuccessor(roster, { command: 'claude', accountId: 'default' })).toBeNull();
  });

  it('skips a CLI that is not installed', () => {
    const roster = [
      spent,
      account({ provider: 'codex', command: 'codex', accountId: null, windows: [win(0)] }),
    ];
    const installedCommands = new Set(['claude']);
    expect(
      chooseSuccessor(roster, { command: 'claude', accountId: 'default' }, { installedCommands })
    ).toBeNull();
  });

  it('holds a cross-provider hop when the user has not allowed one', () => {
    const roster = [
      spent,
      account({ provider: 'codex', command: 'codex', accountId: null, windows: [win(0)] }),
    ];
    expect(
      chooseSuccessor(roster, { command: 'claude', accountId: 'default' }, { allowCrossProvider: false })
    ).toBeNull();
    // …and still allows the free hop, which spends only the user's own plan.
    const withSibling = [...roster, account({ accountId: 'work', active: false, windows: [win(5)] })];
    expect(
      chooseSuccessor(withSibling, { command: 'claude', accountId: 'default' }, { allowCrossProvider: false })?.hop
    ).toBe('account');
  });

  it('will not launch into an account with no reading at all', () => {
    const roster = [spent, account({ accountId: 'work', active: false, status: 'ok', windows: [] })];
    expect(chooseSuccessor(roster, { command: 'claude', accountId: 'default' })).toBeNull();
  });

  it('takes the roomiest sibling when several qualify', () => {
    const roster = [
      spent,
      account({ accountId: 'a', active: false, windows: [win(60)] }),
      account({ accountId: 'b', active: false, windows: [win(10)] }),
    ];
    expect(chooseSuccessor(roster, { command: 'claude', accountId: 'default' })?.candidate.accountId).toBe('b');
  });

  it('matches a CLI by its executable, not the whole launch line', () => {
    const roster = [
      account({ provider: 'opencode', command: 'opencode', accountId: null, windows: [win(1)] }),
      account({ accountId: 'work', active: false, windows: [win(5)] }),
      spent,
    ];
    // `npx opencode --foo` is opencode, so it must not be offered itself.
    const choice = chooseSuccessor(roster, { command: 'npx opencode --foo', accountId: null });
    expect(choice?.candidate.command).toBe('claude');
  });

  it('ranks every qualifying option so the choice can be audited', () => {
    const roster = [
      spent,
      account({ accountId: 'work', active: false, windows: [win(50)] }),
      account({ provider: 'codex', command: 'codex', accountId: null, windows: [win(1)] }),
    ];
    const ranked = rankSuccessors(roster, { command: 'claude', accountId: 'default' });
    expect(ranked.map((r) => r.hop)).toEqual(['account', 'cli']);
  });
});

describe('findReading', () => {
  it('falls back to the selected account when the launch recorded none', () => {
    // Tasks started before failover existed carry no account id; the account
    // they are running as is whichever one is selected.
    const roster = [
      account({ accountId: 'work', active: true, label: 'work@example.com' }),
      account({ accountId: 'default', active: false }),
    ];
    expect(findReading(roster, 'claude', null)?.accountId).toBe('work');
  });

  it('answers null for a CLI with no meter at all', () => {
    expect(findReading([account()], 'crush', null)).toBeNull();
    expect(findReading([account()], null, null)).toBeNull();
  });
});

describe('nothing qualifies', () => {
  const now = Date.UTC(2026, 8, 20, 12, 0, 0);

  it('names the earliest reset of an exhausted window', () => {
    const roster = [
      account({
        windows: [
          win(99, { resetsAtEpochSecs: now / 1000 + 3 * 3600 }),
          // Exhausted and sooner — this is the one that answers.
          win(100, { resetsAtEpochSecs: now / 1000 + 1800 }),
        ],
      }),
    ];
    expect(earliestResetMs(roster, {}, now)).toBe(now + 1800 * 1000);
    expect(describeNothingQualifies(roster, {}, now)).toContain('resets in 30m');
  });

  it('ignores the reset of a window that still has room', () => {
    // A weekly window resetting on Sunday is not the answer when it is the
    // 5-hour one that is blocking work.
    const roster = [
      account({
        windows: [
          win(10, { resetsAtEpochSecs: now / 1000 + 600 }),
          win(100, { resetsAtEpochSecs: now / 1000 + 7200 }),
        ],
      }),
    ];
    expect(earliestResetMs(roster, {}, now)).toBe(now + 7200 * 1000);
  });

  it('says so plainly when no provider reports a reset time', () => {
    const roster = [account({ windows: [win(100)] })];
    const told = describeNothingQualifies(roster, {}, now);
    expect(told).toContain('No signed-in agent has enough usage left');
    expect(told).not.toContain('resets');
  });
});

describe('buildAccountRoster', () => {
  const claudeUsage: ProviderUsage = {
    provider: 'claude',
    command: 'claude',
    name: 'Claude Code',
    status: 'ok',
    plan: 'max',
    account: 'me@example.com',
    windows: [win(50)],
    resetCreditsAvailable: null,
    resetCredits: [],
    error: null,
    note: null,
    fetchedAt: 0,
  };
  const geminiUsage: ProviderUsage = { ...claudeUsage, provider: 'gemini', command: 'gemini', name: 'Gemini CLI' };

  it('gives an account-capable CLI one row per account, and everything else one row', () => {
    const accounts: AccountUsage[] = [
      { provider: 'claude', accountId: 'default', label: 'me@example.com', active: true, distinctLogin: true, usage: claudeUsage },
      { provider: 'claude', accountId: 'work', label: 'work@example.com', active: false, distinctLogin: true, usage: { ...claudeUsage, windows: [win(5)] } },
    ];
    const roster = buildAccountRoster([claudeUsage, geminiUsage], accounts);
    expect(roster.filter((r) => r.provider === 'claude')).toHaveLength(2);
    // Gemini has no account switching, so the CLI *is* the login: one row, no id.
    const gemini = roster.find((r) => r.provider === 'gemini');
    expect(gemini?.accountId).toBeNull();
    expect(gemini?.distinctLogin).toBe(true);
  });

  it('does not double-count a provider that appears in both rosters', () => {
    const accounts: AccountUsage[] = [
      { provider: 'claude', accountId: 'default', label: 'me@example.com', active: true, distinctLogin: true, usage: claudeUsage },
    ];
    const roster = buildAccountRoster([claudeUsage], accounts);
    expect(roster).toHaveLength(1);
  });
});

describe('the default threshold', () => {
  it('sits inside the 3-5% band the feature was specified against', () => {
    expect(DEFAULT_FAILOVER_HEADROOM_PERCENT).toBeGreaterThanOrEqual(3);
    expect(DEFAULT_FAILOVER_HEADROOM_PERCENT).toBeLessThanOrEqual(5);
  });
});
