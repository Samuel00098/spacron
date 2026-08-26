import { get } from '$lib/stores/storeCompat';
import { activeFile, fileCache } from '$lib/stores/editor';

/**
 * Editor-symbol context for dictation (the Wispr Flow "Variable Recognition"
 * idea): the identifiers in the file you have open are exactly the terms a
 * speech model mangles, so we lift them out and feed them to the STT layer's
 * hotword biasing next to the user's own vocabulary list.
 *
 * Deliberately STT-only — these names ride into the transcription bias, NOT
 * into the AI polish prompt. The polish pass rewrites prose, and seeding it
 * with random code identifiers invites the model to sprinkle them where they
 * were never spoken.
 */

// Tokens that are language plumbing rather than nameable symbols. Keeping this
// list broad-and-shallow is fine: worst case a miss just means a generic word
// ranks lower, never that real code is dropped.
const KEYWORDS = new Set([
  // JS / TS
  'abstract', 'any', 'as', 'asserts', 'async', 'await', 'boolean', 'break', 'case',
  'catch', 'class', 'const', 'constructor', 'continue', 'debugger', 'declare',
  'default', 'delete', 'do', 'else', 'enum', 'export', 'extends', 'false', 'finally',
  'for', 'from', 'function', 'get', 'if', 'implements', 'import', 'in', 'infer',
  'instanceof', 'interface', 'is', 'keyof', 'let', 'namespace', 'never', 'new',
  'null', 'number', 'object', 'of', 'override', 'package', 'private', 'protected',
  'public', 'readonly', 'record', 'return', 'satisfies', 'set', 'static', 'string',
  'super', 'switch', 'symbol', 'this', 'throw', 'true', 'try', 'type', 'typeof',
  'undefined', 'union', 'unique', 'unknown', 'var', 'void', 'while', 'with', 'yield',
  // Rust
  'crate', 'dyn', 'impl', 'loop', 'match', 'mod', 'move', 'mut',
  'pub', 'ref', 'self', 'str', 'struct', 'trait', 'use', 'where',
  // Python
  'and', 'assert', 'def', 'del', 'elif', 'except', 'global', 'lambda', 'nonlocal',
  'not', 'or', 'pass', 'print', 'raise', 'None',
  // General
  'data', 'item', 'items', 'value', 'values', 'result', 'results', 'params',
  'props', 'state', 'index', 'length', 'name', 'text', 'test', 'tests', 'error',
]);

/** A word that looks like a named thing rather than prose. */
function isCodeShaped(token: string): boolean {
  if (token.length < 4) return false;
  // camelCase, PascalCase, snake_case, SCREAMING_SNAKE, dotted-path fragments
  // like "onnxruntime_web" — anything with internal structure.
  return /[a-z][A-Z]|[A-Z][a-z].*[A-Z]|_\w/.test(token);
}

/** A line that introduces a symbol: declarations, definitions, imports. */
const DECLARATION_RE =
  /^\s*(?:export\s+|default\s+|declare\s+|pub(?:\(crate\))?\s+|async\s+)*(?:function|class|interface|type|enum|struct|trait|impl|fn|def|const|let|var|module)\b|^\s*(?:import|use)\b/;

/**
 * Pull candidate symbol names out of one document, best-first. Order matters:
 * the result is truncated downstream, so declarations rank above incidental
 * code-shaped words.
 */
export function collectEditorSymbols(content: string): string[] {
  if (!content) return [];
  // Cap the scan: an enormous file must not make dictation startup slow, and
  // the first 200 KB holds more relevant names than anyone dictates against.
  const text = content.length > 200_000 ? content.slice(0, 200_000) : content;

  const seen = new Set<string>();
  const declared: string[] = [];
  const shaped: string[] = [];

  for (const line of text.split('\n')) {
    const isDecl = DECLARATION_RE.test(line);
    for (const match of line.matchAll(/[A-Za-z_$][\w$]*/g)) {
      const token = match[0];
      if (token.length < 4 || KEYWORDS.has(token) || seen.has(token)) continue;
      seen.add(token);
      if (!isCodeShaped(token) && !isDecl) continue;
      (isDecl ? declared : shaped).push(token);
      if (declared.length + shaped.length >= 120) break;
    }
    if (declared.length + shaped.length >= 120) break;
  }

  return [...declared, ...shaped].slice(0, 80);
}

/**
 * The symbols worth biasing dictation with right now: whatever is in the
 * active editor tab. Empty when nothing usable is open — the caller merges
 * this with the user's own vocabulary list.
 */
export function getActiveEditorVocabulary(): string[] {
  const path = get(activeFile);
  if (!path) return [];
  const file = get(fileCache).get(path);
  if (!file || file.kind !== 'text') return [];
  return collectEditorSymbols(file.content);
}
