import { describe, expect, it } from 'vitest';
import { codexAnswers, parseCodexQuestions } from './codex-questions';

describe('Codex request_user_input', () => {
  it('parses questions with options', () => {
    const parsed = parseCodexQuestions({
      isBlocking: true, itemId: 'i', threadId: 't', turnId: 'u',
      questions: [{ id: 'db', header: 'Database', question: 'Which one?', options: [{ label: 'Postgres', description: 'Relational' }, { label: 'SQLite', description: '' }] }],
    })!;
    expect(parsed[0]).toMatchObject({ id: 'db', header: 'Database', question: 'Which one?' });
    expect(parsed[0].options).toEqual([{ label: 'Postgres', description: 'Relational' }, { label: 'SQLite', description: null }]);
  });

  it('refuses anything it cannot answer from a button', () => {
    expect(parseCodexQuestions({ questions: [{ id: 'a', header: 'h', question: 'free text?', options: null }] })).toBeNull();
    expect(parseCodexQuestions({ questions: [{ id: 'a', header: 'h', question: 'pw?', isSecret: true, options: [{ label: 'x', description: '' }] }] })).toBeNull();
    expect(parseCodexQuestions({ questions: [] })).toBeNull();
    expect(parseCodexQuestions(undefined)).toBeNull();
  });

  it('answers by question id in the shape the schema requires', () => {
    expect(codexAnswers({ db: 'SQLite' })).toEqual({ answers: { db: { answers: ['SQLite'] } } });
  });
});
