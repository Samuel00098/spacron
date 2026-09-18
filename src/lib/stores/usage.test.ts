import { describe, it, expect } from 'vitest';
import {
  describeReset,
  hasNumbers,
  installedProviders,
  peakWindow,
  providerHeadlines,
  resetAtMs,
  severityOf,
  shortWindowLabel,
  type ProviderUsage,
  type UsageWindow,
} from './usage';

function window(partial: Partial<UsageWindow> = {}): UsageWindow {
  return {
    label: 'Session',
    usedPercent: 0,
    windowMinutes: 300,
    resetsAtIso: null,
    resetsAtEpochSecs: null,
    ...partial,
  };
}

function provider(partial: Partial<ProviderUsage> = {}): ProviderUsage {
  return {
    provider: 'claude',
    command: 'claude',
    name: 'Claude Code',
    status: 'ok',
    plan: 'max',
    account: null,
    windows: [],
    resetCreditsAvailable: null,
    resetCredits: [],
    error: null,
    note: null,
    fetchedAt: 0,
    ...partial,
  };
}

describe('resetAtMs', () => {
  it('reads an ISO reset, the shape Anthropic returns', () => {
    const at = resetAtMs(window({ resetsAtIso: '2026-08-10T21:30:00.907209+00:00' }));
    expect(at).toBe(Date.parse('2026-08-10T21:30:00.907209+00:00'));
  });

  it('reads a unix-seconds reset, the shape OpenAI returns', () => {
    expect(resetAtMs(window({ resetsAtEpochSecs: 1_787_080_318 }))).toBe(1_787_080_318_000);
  });

  it('prefers the numeric form when a provider somehow sends both', () => {
    const at = resetAtMs(
      window({ resetsAtEpochSecs: 1_787_080_318, resetsAtIso: '2020-01-01T00:00:00Z' })
    );
    expect(at).toBe(1_787_080_318_000);
  });

  it('returns null rather than NaN for an unparseable string', () => {
    expect(resetAtMs(window({ resetsAtIso: 'not a date' }))).toBeNull();
    expect(resetAtMs(window())).toBeNull();
  });
});

describe('describeReset', () => {
  const now = Date.parse('2026-08-10T12:00:00Z');
  const at = (iso: string) => window({ resetsAtIso: iso });

  it('describes minutes, hours and days', () => {
    expect(describeReset(at('2026-08-10T12:45:00Z'), now)).toBe('resets in 45m');
    expect(describeReset(at('2026-08-10T15:00:00Z'), now)).toBe('resets in 3h');
    expect(describeReset(at('2026-08-10T14:20:00Z'), now)).toBe('resets in 2h 20m');
    expect(describeReset(at('2026-08-13T12:00:00Z'), now)).toBe('resets in 3d');
  });

  it('never counts backwards once the window has already rolled over', () => {
    expect(describeReset(at('2026-08-10T11:00:00Z'), now)).toBe('resets now');
  });

  it('is null when the provider gave no reset time', () => {
    expect(describeReset(window(), now)).toBeNull();
  });
});

describe('severityOf', () => {
  it('bands a percentage', () => {
    expect(severityOf(27)).toBe('normal');
    expect(severityOf(74.9)).toBe('normal');
    expect(severityOf(75)).toBe('warn');
    expect(severityOf(94)).toBe('warn');
    expect(severityOf(95)).toBe('critical');
    expect(severityOf(100)).toBe('critical');
  });
});

describe('peakWindow', () => {
  it('picks the highest window across every provider, not the first', () => {
    const peak = peakWindow([
      provider({ windows: [window({ label: 'Session', usedPercent: 27 })] }),
      provider({
        provider: 'codex',
        command: 'codex',
        name: 'Codex CLI',
        windows: [window({ label: 'Monthly', usedPercent: 100 })],
      }),
    ]);
    expect(peak?.provider.provider).toBe('codex');
    expect(peak?.window.usedPercent).toBe(100);
  });

  it('ignores providers that are not reporting real numbers', () => {
    // The whole point of the status enum: a signed-out provider must not be
    // read as 0% and win the "lowest usage" story, nor contribute a window.
    const peak = peakWindow([
      provider({ status: 'signedOut', windows: [] }),
      provider({ status: 'expired', windows: [window({ usedPercent: 99 })] }),
      provider({ windows: [window({ usedPercent: 12 })] }),
    ]);
    expect(peak?.window.usedPercent).toBe(12);
  });

  it('is null when nothing is reporting', () => {
    expect(peakWindow([])).toBeNull();
    expect(peakWindow([provider({ status: 'notInstalled' })])).toBeNull();
  });
});

describe('shortWindowLabel', () => {
  it('names a window from its stated length', () => {
    expect(shortWindowLabel(window({ windowMinutes: 300 }))).toBe('5h');
    expect(shortWindowLabel(window({ windowMinutes: 10_080 }))).toBe('wk');
    expect(shortWindowLabel(window({ windowMinutes: 43_200 }))).toBe('mo');
    expect(shortWindowLabel(window({ windowMinutes: 60 }))).toBe('1h');
  });

  it('falls back to the distance to reset when no length is given', () => {
    // Gemini labels buckets by model and states no window length at all, so
    // the reset time is the only thing that can qualify the percentage.
    const now = Date.parse('2026-08-10T12:00:00Z');
    const daily = window({
      windowMinutes: null,
      resetsAtIso: '2026-08-11T12:00:00Z',
    });
    expect(shortWindowLabel(daily, now)).toBe('1d');
  });

  it('is null when a window can be qualified by nothing at all', () => {
    // Better to render a bare "27%" than to invent a window it might not be.
    expect(shortWindowLabel(window({ windowMinutes: null }))).toBeNull();
  });
});

describe('providerHeadlines', () => {
  it('orders agents by how constrained they are, worst first', () => {
    const headlines = providerHeadlines([
      provider({ windows: [window({ usedPercent: 27 })] }),
      provider({
        provider: 'codex',
        command: 'codex',
        windows: [window({ usedPercent: 100 })],
      }),
    ]);
    expect(headlines.map((h) => h.provider.provider)).toEqual(['codex', 'claude']);
  });

  it("orders each agent's own windows worst first", () => {
    // The titlebar drops trailing windows when space is tight, so the
    // constraint has to be the one that survives.
    const [headline] = providerHeadlines([
      provider({
        windows: [
          window({ label: 'Weekly', usedPercent: 6 }),
          window({ label: 'Session', usedPercent: 88 }),
        ],
      }),
    ]);
    expect(headline.windows.map((w) => w.label)).toEqual(['Session', 'Weekly']);
  });

  it('omits agents that are not reporting real numbers', () => {
    expect(
      providerHeadlines([
        provider({ status: 'signedOut' }),
        provider({ status: 'unsupported', windows: [] }),
      ])
    ).toEqual([]);
  });
});

describe('hasNumbers', () => {
  it('separates "reporting" from every other state', () => {
    expect(hasNumbers(provider({ windows: [window()] }))).toBe(true);
    // Status ok but no windows is a real backend case; it must not render as a
    // meter sitting at zero.
    expect(hasNumbers(provider({ windows: [] }))).toBe(false);
    expect(hasNumbers(provider({ status: 'signedOut', windows: [window()] }))).toBe(false);
    expect(hasNumbers(provider({ status: 'notInstalled' }))).toBe(false);
  });

  describe('installedProviders', () => {
    it('drops notInstalled rows so an uninstalled CLI clears the list', () => {
      const installed = provider({ status: 'ok' });
      const signedOut = provider({ status: 'signedOut' });
      const gone = provider({ status: 'notInstalled' });
      const rows = installedProviders([installed, gone, signedOut]);
      expect(rows).toEqual([installed, signedOut]);
    });

    it('keeps every other status — signed out still answers a question', () => {
      const all = ['signedOut', 'expired', 'unsupported', 'error'].map((status) =>
        provider({ status: status as ProviderUsage['status'] })
      );
      expect(installedProviders(all)).toHaveLength(all.length);
    });
  });
});
