import { describe, expect, it } from 'vitest';
import {
  knowledgeGraph,
  slugify,
  parseWikiLinks,
  parseNote,
  serializeNote,
  formatNoteLine,
  getKnowledgeLines,
} from './knowledge';

describe('slugify', () => {
  it('lowercases, hyphenates, and trims', () => {
    expect(slugify('  Auth Flow & Sessions! ')).toBe('auth-flow-sessions');
  });

  it('falls back to "note" for empty input', () => {
    expect(slugify('   ')).toBe('note');
    expect(slugify('!!!')).toBe('note');
  });
});

describe('parseWikiLinks', () => {
  it('extracts and dedupes link targets as slugs', () => {
    const links = parseWikiLinks('See [[Auth Flow]] and [[db-schema]], plus [[auth-flow]] again.');
    expect(links).toEqual(['auth-flow', 'db-schema']);
  });

  it('returns nothing when there are no links', () => {
    expect(parseWikiLinks('plain text, no links')).toEqual([]);
  });
});

describe('parseNote', () => {
  it('takes the title from the first level-1 heading and body after it', () => {
    const note = parseNote('auth-flow', '# Auth Flow\n\nUses JWT. See [[db-schema]].', 100);
    expect(note.title).toBe('Auth Flow');
    expect(note.body).toBe('Uses JWT. See [[db-schema]].');
    expect(note.links).toEqual(['db-schema']);
    expect(note.updatedAt).toBe(100);
  });

  it('humanizes the slug when there is no heading', () => {
    const note = parseNote('db-schema', 'Tables: users, sessions.', 1);
    expect(note.title).toBe('Db Schema');
    expect(note.body).toBe('Tables: users, sessions.');
  });
});

describe('serializeNote', () => {
  it('round-trips through parseNote', () => {
    const md = serializeNote({ title: 'Auth Flow', body: 'Uses JWT. See [[db-schema]].' });
    const note = parseNote('auth-flow', md, 5);
    expect(note.title).toBe('Auth Flow');
    expect(note.body).toBe('Uses JWT. See [[db-schema]].');
    expect(note.links).toEqual(['db-schema']);
  });
});

describe('formatNoteLine', () => {
  it('renders title, first sentence, and outgoing links', () => {
    const line = formatNoteLine({
      slug: 'auth-flow',
      title: 'Auth Flow',
      body: 'Uses JWT tokens signed with RS256. More detail here.',
      links: ['db-schema', 'sessions'],
      updatedAt: 1,
    });
    expect(line).toBe('Auth Flow: Uses JWT tokens signed with RS256. [→ db-schema, sessions]');
  });

  it('omits the link suffix when there are none', () => {
    const line = formatNoteLine({ slug: 'x', title: 'X', body: 'Just a fact.', links: [], updatedAt: 1 });
    expect(line).toBe('X: Just a fact.');
  });
});

describe('getKnowledgeLines', () => {
  it('returns note lines newest-first, capped by the limit', () => {
    knowledgeGraph.set({
      p1: [
        { slug: 'a', title: 'A', body: 'Old fact.', links: [], updatedAt: 1 },
        { slug: 'b', title: 'B', body: 'New fact.', links: ['a'], updatedAt: 3 },
        { slug: 'c', title: 'C', body: 'Mid fact.', links: [], updatedAt: 2 },
      ],
    });
    expect(getKnowledgeLines('p1', 2)).toEqual(['B: New fact. [→ a]', 'C: Mid fact.']);
  });

  it('returns nothing for an unknown project', () => {
    knowledgeGraph.set({});
    expect(getKnowledgeLines('nope')).toEqual([]);
  });
});
