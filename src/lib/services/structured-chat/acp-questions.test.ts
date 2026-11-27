import { describe, expect, it } from 'vitest';
import { acpAskAnswer, acpAskSkip, askKindFor, parseAcpQuestions, askReplyText, parseAntigravityAsk } from './acp-questions';

// Captured from a live grok 1.0.77 request.
const grok = {
  sessionId: 's', toolCallId: 'c', mode: 'default',
  questions: [{ question: 'Which colour do you prefer?', options: [{ label: 'Red', description: 'You prefer red.' }, { label: 'Blue', description: 'You prefer blue.' }], multiSelect: null }],
};
// Built from cursor-agent's source.
const cursor = {
  toolCallId: 't', title: 'Setup',
  questions: [{ id: 'db', prompt: 'Which database?', options: [{ id: 'pg', label: 'Postgres' }, { id: 'sq', label: 'SQLite' }], allowMultiple: true }],
};

describe('ACP ask-question extensions', () => {
  it('recognises the two request methods only', () => {
    expect(askKindFor('_x.ai/ask_user_question')).toBe('grok');
    expect(askKindFor('cursor/ask_question')).toBe('cursor');
    expect(askKindFor('session/request_permission')).toBeNull();
  });

  it('parses a Grok request', () => {
    const parsed = parseAcpQuestions('grok', grok)!;
    expect(parsed.questions[0]).toMatchObject({ key: 'Which colour do you prefer?', multiple: false });
    expect(parsed.questions[0].options.map((o) => o.label)).toEqual(['Red', 'Blue']);
  });

  it('answers Grok by question text with the label, as accepted live', () => {
    const { questions } = parseAcpQuestions('grok', grok)!;
    expect(acpAskAnswer('grok', questions, [{ optionIds: ['1'], other: '' }]))
      .toEqual({ outcome: 'accepted', answers: { 'Which colour do you prefer?': 'Blue' } });
    expect(acpAskSkip('grok')).toEqual({ outcome: 'skip' });
  });

  it('parses and answers a Cursor request by question id and option id', () => {
    const parsed = parseAcpQuestions('cursor', cursor)!;
    expect(parsed.title).toBe('Setup');
    expect(parsed.questions[0]).toMatchObject({ key: 'db', multiple: true });
    expect(acpAskAnswer('cursor', parsed.questions, [{ optionIds: ['sq'], other: '' }]))
      .toEqual({ outcome: { outcome: 'answered', answers: [{ questionId: 'db', selectedOptionIds: ['sq'] }] } });
    expect(acpAskSkip('cursor')).toMatchObject({ outcome: { outcome: 'skipped' } });
  });

  it('refuses requests it cannot render from buttons', () => {
    expect(parseAcpQuestions('grok', { questions: [{ question: 'free text?', options: [] }] })).toBeNull();
    expect(parseAcpQuestions('cursor', { questions: [{ id: 'a', prompt: 'p', options: [{ label: 'no id' }] }] })).toBeNull();
    expect(parseAcpQuestions('grok', {})).toBeNull();
  });
});

describe('Antigravity ask_question', () => {
  // The tool call as agy 1.5.18 sent it.
  const update = { sessionUpdate: 'tool_call', toolCallId: 'call_1', name: 'ask_question', rawInput: { questions: [{ is_multi_select: false, options: ['Red', 'Blue'], question: 'Which color do you prefer?' }] } };

  it('reads the question and answers it as a message', () => {
    const questions = parseAntigravityAsk(update)!;
    expect(questions[0].options.map((o) => o.label)).toEqual(['Red', 'Blue']);
    expect(askReplyText(questions, [{ optionIds: ['1'], other: '' }])).toBe('Blue');
    expect(askReplyText(questions, [{ optionIds: [], other: 'Green' }])).toBe('Green');
  });

  it('ignores other tool calls', () => {
    expect(parseAntigravityAsk({ ...update, name: 'run_command' })).toBeNull();
  });
});
