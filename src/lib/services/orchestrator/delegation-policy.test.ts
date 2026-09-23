import { describe, expect, it } from 'vitest';
import {
  DELEGATION_DECLINE_LABEL,
  DELEGATION_SELF_LABEL,
  buildDelegationProposal,
  checkDirectEditScope,
  createDirectEditScope,
  isExplicitDelegationRequest,
  isScopeContinuation,
  recordDirectEdit,
  resolveDelegationAnswer,
} from './delegation-policy';

const agents = [
  { command: 'aider', name: 'Aider' },
  { command: 'codex', name: 'Codex' },
  { command: 'claude', name: 'Claude Code' },
];

describe('direct edit scope', () => {
  it('allows three files, refuses the fourth, and keeps the first three writable', () => {
    const scope = createDirectEditScope();
    for (const path of ['a.ts', 'b.ts', 'c.ts']) {
      expect(checkDirectEditScope(scope, path)).toBeNull();
      recordDirectEdit(scope, path);
    }
    expect(checkDirectEditScope(scope, 'd.ts')).toMatch(/^error: scope limit/);
    expect(checkDirectEditScope(scope, 'B.ts')).toBeNull();
    expect(checkDirectEditScope(scope, './c.ts')).toBeNull();
  });

  it('lifts the limit when the user overrides it', () => {
    const scope = createDirectEditScope();
    ['a', 'b', 'c'].forEach((path) => recordDirectEdit(scope, path));
    scope.override = true;
    expect(checkDirectEditScope(scope, 'd')).toBeNull();
  });

  it('recognises short go-aheads as continuations, not new tasks', () => {
    expect(isScopeContinuation('okay')).toBe(true);
    expect(isScopeContinuation('continue with the program')).toBe(true);
    expect(isScopeContinuation('Add a settings page with a dark mode toggle')).toBe(false);
  });
});

describe('explicit delegation', () => {
  it('treats asking for an agent or a hand-off as the approval', () => {
    expect(isExplicitDelegationRequest('have codex build the login page')).toBe(true);
    expect(isExplicitDelegationRequest('delegate this')).toBe(true);
    expect(isExplicitDelegationRequest('hand it off to Iris')).toBe(true);
    expect(isExplicitDelegationRequest('build the login page')).toBe(false);
  });
});

describe('delegation proposals', () => {
  const proposal = buildDelegationProposal({
    id: 'p1',
    request: 'Add auth across the app',
    reply: 'This touches 7 files.',
    actions: [{ kind: 'spawn', agent: 'codex', prompt: 'Implement auth in src/auth/*' }],
    agents,
    now: 1,
  });

  it('offers the proposed agent first, then Claude Code, then the rest, then self/decline', () => {
    expect(proposal.choices.map((choice) => choice.label)).toEqual([
      'Delegate to Codex',
      'Delegate to Claude Code',
      'Delegate to Aider',
      DELEGATION_SELF_LABEL,
      DELEGATION_DECLINE_LABEL,
    ]);
    expect(proposal.question).toContain('This touches 7 files.');
    expect(proposal.question).toContain('> Implement auth in src/auth/*');
  });

  it('retargets the drafted brief to the agent the user picks', () => {
    const choice = resolveDelegationAnswer(proposal, 'Delegate to Claude Code');
    expect(choice).toMatchObject({ kind: 'delegate', actions: [{ kind: 'spawn', agent: 'claude', prompt: 'Implement auth in src/auth/*' }] });
  });

  it('understands typed answers', () => {
    expect(resolveDelegationAnswer(proposal, 'yes')?.label).toBe('Delegate to Codex');
    expect(resolveDelegationAnswer(proposal, 'use claude code')?.label).toBe('Delegate to Claude Code');
    expect(resolveDelegationAnswer(proposal, 'no thanks')?.kind).toBe('decline');
    expect(resolveDelegationAnswer(proposal, 'just do it yourself')?.kind).toBe('self');
    expect(resolveDelegationAnswer(proposal, 'what is the weather')).toBeNull();
  });

  it('offers a send to the running agent the model addressed', () => {
    const send = buildDelegationProposal({
      id: 'p2', request: 'fix it', reply: '', agents,
      actions: [{ kind: 'send', target: 'Iris', prompt: 'Fix the router' }],
    });
    expect(send.choices[0]).toMatchObject({ label: 'Send to Iris', actions: [{ kind: 'send', target: 'Iris' }] });
    expect(send.choices[1]).toMatchObject({ label: 'Delegate to Claude Code', actions: [{ kind: 'spawn', agent: 'claude', prompt: 'Fix the router' }] });
  });
});
