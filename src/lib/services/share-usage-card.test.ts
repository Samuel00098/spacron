import { describe, it, expect } from 'vitest';
import { buildShareCard, type ShareCardInput } from './share-usage-card';

function input(partial: Partial<ShareCardInput> = {}): ShareCardInput {
  return {
    providerLabel: 'Overview',
    rangeLabel: 'All time',
    hasPartialCost: false,
    figures: [
      { label: 'Total tokens', value: '1.3B' },
      { label: 'Est. cost', value: '$412' },
      { label: 'Active days', value: '61' },
      { label: 'Cache share', value: '88%' },
    ],
    ...partial,
  };
}

describe('buildShareCard', () => {
  it('names the range the figures cover', () => {
    // A shared image carries no filter controls, so the window has to be on it.
    expect(buildShareCard(input({ rangeLabel: 'Last 30 days' })).subtitle).toBe(
      'Overview · Last 30 days'
    );
  });

  it('states the scope only when it narrows the figures', () => {
    expect(buildShareCard(input({ scopeNote: 'managed worktrees only' })).subtitle).toBe(
      'Overview · All time · managed worktrees only'
    );
    expect(buildShareCard(input({ scopeNote: null })).subtitle).toBe('Overview · All time');
  });

  it('marks a cost that could only be a floor', () => {
    // Unpriced models make the number a lower bound; sharing it as a flat
    // figure would overstate its precision.
    expect(buildShareCard(input({ hasPartialCost: true })).footnote).toContain('unpriced');
    expect(buildShareCard(input()).footnote).not.toContain('unpriced');
  });

  it('omits the activity strip when nothing has been recorded', () => {
    expect(buildShareCard(input({ activity: null })).activity).toBeNull();
    expect(
      buildShareCard(
        input({ activity: { agentsSpawned: 12, turns: 340, workedLabel: '3d 4h' } })
      ).activity
    ).toBe('12 agents · 3d 4h worked · 340 turns');
  });

  it('passes the figures through untouched', () => {
    const figures = [{ label: 'Sessions', value: '9' }];
    expect(buildShareCard(input({ figures })).figures).toEqual(figures);
  });
});
