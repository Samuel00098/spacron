import { describe, expect, it } from 'vitest';
import type { TerminalChatItem } from '$lib/services/terminal-chat';
import {
  draftToPersist,
  filterModels,
  promptHistoryOf,
  quoteAsBlockquote,
  structuredDraftKey,
} from './composer';

const user = (id: string, text: string): TerminalChatItem => ({ id, kind: 'user', text });
const assistant = (id: string, text: string): TerminalChatItem => ({ id, kind: 'assistant', text });

describe('quoteAsBlockquote', () => {
  it('prefixes every line, including blank ones', () => {
    expect(quoteAsBlockquote('one\n\ntwo')).toBe('> one\n> \n> two');
  });

  it('trims the selection edge and normalizes CRLF', () => {
    expect(quoteAsBlockquote('\r\n  indented\r\n')).toBe('>   indented');
  });
});

describe('promptHistoryOf', () => {
  it('keeps only prompts, oldest first', () => {
    expect(promptHistoryOf([user('1', 'first'), assistant('2', 'reply'), user('3', 'second')]))
      .toEqual(['first', 'second']);
  });

  it('drops blank prompts and a repeat of the prompt before', () => {
    expect(promptHistoryOf([user('1', 'same'), user('2', 'same'), user('3', '  '), user('4', 'other')]))
      .toEqual(['same', 'other']);
  });
});

describe('filterModels', () => {
  const models = [
    { value: 'gpt-5-codex', label: 'GPT-5 Codex', hint: 'Deep work' },
    { value: 'gpt-5-mini', label: 'GPT-5 mini', hint: 'Quick answers' },
    { value: 'o4', label: 'o4', hint: undefined },
  ];

  it('returns everything for an empty query', () => {
    expect(filterModels(models, '   ')).toHaveLength(3);
  });

  it('matches the id, the label and the description, ignoring case', () => {
    expect(filterModels(models, 'MINI').map((m) => m.value)).toEqual(['gpt-5-mini']);
    expect(filterModels(models, 'deep').map((m) => m.value)).toEqual(['gpt-5-codex']);
    expect(filterModels(models, 'codex').map((m) => m.value)).toEqual(['gpt-5-codex']);
  });

  it('is empty when nothing matches', () => {
    expect(filterModels(models, 'opus')).toEqual([]);
  });
});

describe('drafts', () => {
  it('keys the draft by pane', () => {
    expect(structuredDraftKey(7)).toBe('spacron_structured_draft_7');
  });

  it('keeps real text and drops whitespace', () => {
    expect(draftToPersist('half a thought')).toBe('half a thought');
    expect(draftToPersist('  \n ')).toBeNull();
    expect(draftToPersist('')).toBeNull();
  });
});
