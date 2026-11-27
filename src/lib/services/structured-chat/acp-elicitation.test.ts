import { describe, expect, it } from 'vitest';
import { elicitationAccept, isPermissionQuestion, parseElicitation, permissionQuestion } from './acp-elicitation';

const form = {
  mode: 'form',
  message: 'A few questions',
  requestedSchema: {
    type: 'object',
    properties: {
      db: { type: 'string', title: 'Database', description: 'Which one?', oneOf: [{ const: 'pg', title: 'Postgres' }, { const: 'sq', title: 'SQLite' }] },
      db_custom: { type: 'string', title: 'Database (other)' },
      tests: { type: 'array', title: 'Tests', items: { enum: ['unit', 'e2e'] } },
      name: { type: 'string', title: 'Name' },
    },
  },
};

describe('ACP elicitation', () => {
  it('folds a _custom field into its question', () => {
    const { questions } = parseElicitation(form)!;
    expect(questions.map((q) => [q.text, q.multiple, q.allowOther])).toEqual([
      ['Which one?', false, true],
      ['Tests', true, false],
      ['Name', false, true],
    ]);
  });

  it('answers with the schema values and keys', () => {
    expect(elicitationAccept(parseElicitation(form)!, [
      { optionIds: ['1'], other: '' },
      { optionIds: ['0', '1'], other: '' },
      { optionIds: [], other: 'demo' },
    ])).toEqual({ action: 'accept', content: { db: 'sq', tests: ['unit', 'e2e'], name: 'demo' } });
    expect(elicitationAccept(parseElicitation(form)!, [{ optionIds: [], other: 'Mongo' }, { optionIds: [], other: '' }, { optionIds: [], other: 'x' }]))
      .toMatchObject({ content: { db_custom: 'Mongo' } });
  });

  it('refuses URL mode and nested schemas', () => {
    expect(parseElicitation({ mode: 'url', url: 'https://example.test' })).toBeNull();
    expect(parseElicitation({ requestedSchema: { type: 'object', properties: { a: { type: 'object' } } } })).toBeNull();
  });

  it('tells a question sent as a permission request from a real permission', () => {
    const options = [{ id: 'q0_opt_0', label: 'Red', kind: 'allow_once' }, { id: 'q0_skip', label: 'Skip', kind: 'reject_once' }];
    expect(isPermissionQuestion(options)).toBe(true);
    expect(permissionQuestion('Colour?', options).options.map((o) => o.label)).toEqual(['Red']);
    expect(isPermissionQuestion([{ id: 'allow_once' }])).toBe(false);
  });
});
