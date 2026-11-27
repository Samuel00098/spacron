/**
 * Questions that arrive the standard ACP way, for agents without an extension
 * of their own (OpenCode 2, and whichever of Kimi, OMP, Hermes or Copilot use
 * it). NOT RUN against any agent: built from the spec
 * (agentclientprotocol.com/protocol/v1/elicitation) and public reports.
 *
 * - `elicitation/create`, form mode: a flat object schema. A field is single
 *   choice (`enum` / `oneOf`), multi choice (`array` of those), boolean or
 *   typed. OpenCode pairs a choice field `<key>` with an optional typed
 *   `<key>_custom`, shown here as that question's "Other".
 * - Kimi, with no form support, instead asks through
 *   `session/request_permission` with option ids `q<n>_…`.
 */
import type { AskAnswer, AskQuestion } from './ask';

/** Advertised only to these: the others have a verified route of their own. */
export const ELICITATION_AGENTS: ReadonlySet<string> = new Set(['opencode', 'copilot', 'kimi', 'hermes', 'omp']);

type Json = Record<string, unknown>;
const rec = (value: unknown): Json | null => value && typeof value === 'object' && !Array.isArray(value) ? value as Json : null;
const text = (value: unknown): string => (typeof value === 'string' ? value.trim() : '');

interface Field {
  key: string;
  type: string;
  /** What to send back for each option id. */
  values: Map<string, unknown>;
  customKey: string | null;
}

export interface Elicitation {
  questions: AskQuestion[];
  fields: Field[];
}

function choices(schema: Json): { value: unknown; label: string; description: string | null }[] {
  const titled = Array.isArray(schema.oneOf) ? schema.oneOf : Array.isArray(schema.anyOf) ? schema.anyOf : null;
  if (titled) {
    return titled.flatMap((entry) => {
      const o = rec(entry);
      if (!o || o.const === undefined) return [];
      return [{ value: o.const, label: text(o.title) || String(o.const), description: text(o.description) || null }];
    });
  }
  return (Array.isArray(schema.enum) ? schema.enum : []).map((value) => ({ value, label: String(value), description: null }));
}

/** Null when the request is not a form this card can fill in. */
export function parseElicitation(params: unknown): Elicitation | null {
  const p = rec(params);
  if (!p || (p.mode !== undefined && p.mode !== 'form')) return null;
  const properties = rec(rec(p.requestedSchema)?.properties);
  if (!properties) return null;
  const keys = Object.keys(properties);
  const isCustom = (key: string) => key.endsWith('_custom') && keys.includes(key.slice(0, -'_custom'.length));
  const message = text(p.message);
  const questions: AskQuestion[] = [];
  const fields: Field[] = [];
  const shown = keys.filter((key) => !isCustom(key));
  for (const key of shown) {
    const schema = rec(properties[key]);
    if (!schema) return null;
    const type = text(schema.type) || 'string';
    if (type === 'object') return null;
    const multiple = type === 'array';
    const offered = type === 'boolean'
      ? [{ value: true, label: 'Yes', description: null }, { value: false, label: 'No', description: null }]
      : choices(multiple ? rec(schema.items) ?? {} : schema);
    if (multiple && !offered.length) return null;
    const title = text(schema.title);
    const body = text(schema.description) || (shown.length === 1 ? message : '') || title || key;
    const customKey = keys.includes(`${key}_custom`) ? `${key}_custom` : null;
    questions.push({
      header: title && title !== body ? title : null,
      text: body,
      options: offered.map((o, i) => ({ id: String(i), label: o.label, description: o.description })),
      multiple,
      allowOther: customKey !== null || !offered.length,
    });
    fields.push({ key, type, values: new Map(offered.map((o, i) => [String(i), o.value])), customKey });
  }
  return questions.length ? { questions, fields } : null;
}

/** The reply once the user has answered; `answers` follows `questions`. */
export function elicitationAccept({ fields }: Elicitation, answers: AskAnswer[]): Json {
  const content: Json = {};
  fields.forEach((field, i) => {
    const answer = answers[i];
    const chosen = (answer?.optionIds ?? []).filter((id) => field.values.has(id)).map((id) => field.values.get(id));
    const other = answer?.other.trim() ?? '';
    if (other && field.customKey) content[field.customKey] = other;
    if (field.type === 'array') content[field.key] = chosen;
    else if (chosen.length) content[field.key] = chosen[0];
    else if (other && !field.customKey) content[field.key] = field.type === 'number' || field.type === 'integer' ? Number(other) : other;
  });
  return { action: 'accept', content };
}

export const ELICITATION_DECLINE = { action: 'decline' };

/** Whether a permission request is really a question (Kimi's `q0_opt_1`, `q0_skip`). */
export function isPermissionQuestion(options: readonly { id: string }[]): boolean {
  return options.length > 0 && options.every((o) => /^q\d+_/.test(o.id));
}

/** That request as a card; the skip option is the card's own Skip. */
export function permissionQuestion(title: string, options: readonly { id: string; label: string; kind: string | null }[]): AskQuestion {
  return {
    header: null,
    text: title,
    options: options.filter((o) => !o.kind?.startsWith('reject') && !/_skip$/.test(o.id)).map((o) => ({ id: o.id, label: o.label, description: null })),
    multiple: false,
    allowOther: false,
  };
}
