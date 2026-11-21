import { describe, expect, it } from 'vitest';
import { answeredInput, isAskUserQuestion, parseAskUserQuestion } from './claude-questions';

const input = {
  questions: [
    { question: 'Which database?', header: 'DB', multiSelect: false, options: [{ label: 'Postgres', description: 'Relational' }, { label: 'SQLite' }] },
    { question: 'Which tests?', multiSelect: true, options: [{ label: 'Unit' }, { label: 'E2E' }] },
  ],
};

describe('AskUserQuestion', () => {
  it('recognises the tool by name only', () => {
    expect(isAskUserQuestion('AskUserQuestion')).toBe(true);
    expect(isAskUserQuestion('Bash')).toBe(false);
  });

  it('parses questions, options and flags', () => {
    const parsed = parseAskUserQuestion(input)!;
    expect(parsed).toHaveLength(2);
    expect(parsed[0]).toMatchObject({ question: 'Which database?', header: 'DB', multiSelect: false });
    expect(parsed[0].options).toEqual([{ label: 'Postgres', description: 'Relational' }, { label: 'SQLite', description: null }]);
    expect(parsed[1].multiSelect).toBe(true);
  });

  it('rejects input it cannot render so the generic card is used', () => {
    expect(parseAskUserQuestion({})).toBeNull();
    expect(parseAskUserQuestion({ questions: [] })).toBeNull();
    expect(parseAskUserQuestion({ questions: [{ question: 'x', options: [] }] })).toBeNull();
    expect(parseAskUserQuestion(null)).toBeNull();
  });

  it('adds answers keyed by question text without losing the original input', () => {
    expect(answeredInput(input, { 'Which database?': 'SQLite' })).toEqual({ ...input, answers: { 'Which database?': 'SQLite' } });
  });
});
