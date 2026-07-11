import { describe, expect, it } from 'vitest';
import {
  mailbox,
  mailboxSeen,
  dismissMailboxCard,
  createMailboxMessage,
  appendMailboxMessage,
  formatMailboxMessage,
  getMailboxCards,
  activeClaims,
  findClaimConflicts,
  MAX_MAILBOX_MESSAGES,
  type MailboxMessage,
} from './mailbox';

function msg(over: Partial<MailboxMessage>): MailboxMessage {
  return {
    id: over.id ?? `mb_${Math.random()}`,
    from: over.from ?? 'Neo',
    to: over.to ?? null,
    kind: over.kind ?? 'note',
    taskId: over.taskId ?? null,
    files: over.files,
    text: over.text ?? '',
    createdAt: over.createdAt ?? 1,
  };
}

describe('createMailboxMessage', () => {
  it('normalizes sender, recipient, files, and text', () => {
    const m = createMailboxMessage({
      from: '  Trinity ',
      to: '  ',
      kind: 'claim',
      files: ['./src/a.ts', 'src/a.ts', '  ', 'src/b.ts'],
      text: '  hold   these  ',
    });
    expect(m.from).toBe('Trinity');
    expect(m.to).toBeNull(); // blank recipient ⇒ broadcast
    expect(m.files).toEqual(['src/a.ts', 'src/b.ts']); // trimmed, deduped, leading ./ stripped
    expect(m.text).toBe('hold these');
    expect(m.id).toMatch(/^mb_/);
  });

  it('defaults an empty sender to the orchestrator', () => {
    expect(createMailboxMessage({ from: '', kind: 'note', text: 'x' }).from).toBe('orchestrator');
  });
});

describe('appendMailboxMessage', () => {
  it('caps the log to the most recent messages', () => {
    let log: MailboxMessage[] = [];
    for (let i = 0; i < MAX_MAILBOX_MESSAGES + 10; i += 1) {
      log = appendMailboxMessage(log, msg({ id: `m${i}`, createdAt: i }));
    }
    expect(log).toHaveLength(MAX_MAILBOX_MESSAGES);
    expect(log[0].id).toBe('m10');
    expect(log[log.length - 1].id).toBe(`m${MAX_MAILBOX_MESSAGES + 9}`);
  });
});

describe('formatMailboxMessage', () => {
  it('renders sender, target, kind, and claimed files', () => {
    const line = formatMailboxMessage(
      msg({ from: 'Neo', to: 'Trinity', kind: 'handoff', text: 'ready for review', createdAt: Date.now() }),
      Date.now()
    );
    expect(line).toContain('Neo');
    expect(line).toContain('→Trinity');
    expect(line).toContain('handoff');
    expect(line).toContain('ready for review');
  });

  it('marks broadcasts as →team', () => {
    expect(formatMailboxMessage(msg({ to: null }), Date.now())).toContain('→team');
  });
});

describe('activeClaims', () => {
  it('tracks an open claim', () => {
    const claims = activeClaims([msg({ kind: 'claim', taskId: 't1', from: 'Neo', files: ['a.ts', 'b.ts'] })]);
    expect(claims).toEqual([{ taskId: 't1', owner: 'Neo', files: ['a.ts', 'b.ts'], claimedAt: 1 }]);
  });

  it('drops a claim when the task is done', () => {
    const claims = activeClaims([
      msg({ kind: 'claim', taskId: 't1', files: ['a.ts'] }),
      msg({ kind: 'done', taskId: 't1' }),
    ]);
    expect(claims).toHaveLength(0);
  });

  it('releases only the named files on a partial release', () => {
    const claims = activeClaims([
      msg({ kind: 'claim', taskId: 't1', from: 'Neo', files: ['a.ts', 'b.ts'] }),
      msg({ kind: 'release', taskId: 't1', files: ['a.ts'] }),
    ]);
    expect(claims).toEqual([{ taskId: 't1', owner: 'Neo', files: ['b.ts'], claimedAt: 1 }]);
  });
});

describe('getMailboxCards', () => {
  it('returns structured cards newest-first and flags actionable ones', () => {
    mailbox.set({
      p1: [
        msg({ id: 'a', kind: 'done', from: 'Neo', text: 'finished', createdAt: 1 }),
        msg({ id: 'b', kind: 'handoff', from: 'Neo', to: 'Trinity', text: 'review please', createdAt: 2 }),
        msg({ id: 'c', kind: 'note', from: 'orchestrator', text: 'fyi', createdAt: 3 }),
      ],
    });
    const cards = getMailboxCards('p1');
    expect(cards.map((c) => c.id)).toEqual(['c', 'b', 'a']); // newest first
    expect(cards.find((c) => c.id === 'b')?.actionable).toBe(true); // handoff
    expect(cards.find((c) => c.id === 'a')?.actionable).toBe(false); // done
  });

  it('can filter to only actionable cards', () => {
    mailbox.set({
      p1: [
        msg({ id: 'a', kind: 'done', createdAt: 1 }),
        msg({ id: 'b', kind: 'report', createdAt: 2 }),
        msg({ id: 'c', kind: 'ask', createdAt: 3 }),
      ],
    });
    const cards = getMailboxCards('p1', { actionableOnly: true });
    expect(cards.map((c) => c.id)).toEqual(['c', 'b']);
  });

  it('omits pure user chatter and returns nothing for an unknown project', () => {
    mailbox.set({ p1: [msg({ id: 'u', from: 'user', kind: 'note', createdAt: 1 })] });
    expect(getMailboxCards('p1')).toEqual([]);
    expect(getMailboxCards('nope')).toEqual([]);
  });

  it('hides dismissed cards but keeps them with includeSeen', () => {
    mailboxSeen.set(new Set());
    mailbox.set({
      p1: [
        msg({ id: 'a', kind: 'ask', createdAt: 1 }),
        msg({ id: 'b', kind: 'handoff', createdAt: 2 }),
      ],
    });
    expect(getMailboxCards('p1', { actionableOnly: true }).map((c) => c.id)).toEqual(['b', 'a']);
    dismissMailboxCard('a');
    expect(getMailboxCards('p1', { actionableOnly: true }).map((c) => c.id)).toEqual(['b']);
    // The message still exists in the log — includeSeen surfaces it again.
    expect(getMailboxCards('p1', { actionableOnly: true, includeSeen: true }).map((c) => c.id)).toEqual(['b', 'a']);
    mailboxSeen.set(new Set());
  });
});

describe('findClaimConflicts', () => {
  const log = [msg({ kind: 'claim', taskId: 't1', from: 'Neo', files: ['src/a.ts', 'src/b.ts'] })];

  it('flags overlap owned by another task', () => {
    const conflicts = findClaimConflicts(log, ['src/b.ts', 'src/c.ts']);
    expect(conflicts).toEqual([{ file: 'src/b.ts', owner: 'Neo', taskId: 't1' }]);
  });

  it('lets a task re-claim its own files', () => {
    expect(findClaimConflicts(log, ['src/a.ts'], 't1')).toEqual([]);
  });

  it('returns nothing when files are free', () => {
    expect(findClaimConflicts(log, ['src/z.ts'])).toEqual([]);
  });

  it('normalizes wanted paths before comparing', () => {
    expect(findClaimConflicts(log, ['./src/a.ts'])).toHaveLength(1);
  });
});
