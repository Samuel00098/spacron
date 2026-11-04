import { describe, expect, it } from 'vitest';
import { isAcpReplayIdle, normalizeAcpUpdate, parseAcpPlan, parseAcpUsage } from './acp-protocol';

describe('ACP protocol normalization', () => {
  it('normalizes v1 envelopes and array content', () => {
    const update = normalizeAcpUpdate({
      method: 'session/update',
      params: { update: { sessionUpdate: 'agent_message_chunk', content: [{ type: 'text', text: 'Hi' }] } },
    });
    expect(update).toMatchObject({ kind: 'agent_message_chunk', content: 'Hi' });
  });

  it('accepts v2-style update names and idle markers', () => {
    const update = normalizeAcpUpdate({ params: { update: { type: 'sessionIdle' } } });
    expect(update?.kind).toBe('session_idle');
    expect(isAcpReplayIdle(update)).toBe(true);
  });
});

describe('ACP v2 usage updates', () => {
  const envelope = (update: Record<string, unknown>) => ({ method: 'session/update', params: { update } });

  it('reads used, size and cost from usage_update', () => {
    expect(parseAcpUsage(envelope({
      sessionUpdate: 'usage_update',
      used: 53000,
      size: 200000,
      cost: { amount: 0.045, currency: 'USD' },
    }))).toEqual({ used: 53000, size: 200000, cost: { amount: 0.045, currency: 'USD' } });
  });

  it('leaves cost absent when the agent omits it, and clears it on null', () => {
    expect(parseAcpUsage(envelope({ sessionUpdate: 'usage_update', used: 1, size: 10 }))).toEqual({ used: 1, size: 10 });
    expect(parseAcpUsage(envelope({ sessionUpdate: 'usage_update', used: 1, size: 10, cost: null }))?.cost).toBeNull();
  });

  it('rejects an unusable window instead of showing 0%', () => {
    expect(parseAcpUsage(envelope({ sessionUpdate: 'usage_update', used: 5, size: 0 }))).toBeNull();
    expect(parseAcpUsage(envelope({ sessionUpdate: 'usage_update', size: 10 }))).toBeNull();
    expect(parseAcpUsage(envelope({ sessionUpdate: 'agent_message_chunk', used: 1, size: 10 }))).toBeNull();
  });

  it('accepts numeric strings and never reports used above size', () => {
    expect(parseAcpUsage(envelope({ sessionUpdate: 'usage_update', used: '12', size: '10' })))
      .toEqual({ used: 12, size: 12 });
  });
});

describe('ACP plans', () => {
  const envelope = (update: Record<string, unknown>) => ({ method: 'session/update', params: { update } });

  it('reads a v2 plan_update, keeping its planId and entry statuses', () => {
    expect(parseAcpPlan(envelope({
      sessionUpdate: 'plan_update',
      plan: {
        type: 'items',
        planId: 'plan-1',
        entries: [
          { content: 'Check for syntax errors', priority: 'high', status: 'pending' },
          { content: 'Run the tests', status: 'completed' },
        ],
      },
    }))).toEqual({
      planId: 'plan-1',
      entries: [
        { content: 'Check for syntax errors', status: 'pending', priority: 'high' },
        { content: 'Run the tests', status: 'completed' },
      ],
    });
  });

  it('reads a v1 plan and drops steps with no content', () => {
    expect(parseAcpPlan(envelope({
      sessionUpdate: 'plan',
      entries: [{ content: '  ', status: 'pending' }, { content: 'Ship it', status: 'in_progress' }],
    }))).toEqual({ planId: 'plan', entries: [{ content: 'Ship it', status: 'in_progress' }] });
  });

  it('ignores updates that carry no plan', () => {
    expect(parseAcpPlan(envelope({ sessionUpdate: 'plan_update', plan: { planId: 'x', entries: [] } }))).toBeNull();
    expect(parseAcpPlan(envelope({ sessionUpdate: 'agent_message_chunk', content: 'hi' }))).toBeNull();
  });
});
