/**
 * A small, dependency-free tokenizer for diff lines.
 *
 * It uses NAMED groups on purpose. The first version numbered its groups, but the
 * keyword and type patterns carry a capture group of their own, which shifted
 * every later index by two: the whitespace and "any other character" branches
 * were never reached, so spaces and punctuation vanished from every diff line.
 * Lines then glued into one unbreakable word that could not wrap and ran off the
 * edge of the panel.
 *
 * Invariant (tested): joining the tokens' text gives back the input exactly.
 */
export interface DiffToken {
  type: string;
  text: string;
}

const RUST_KEYWORDS = /\b(?:as|async|await|break|const|continue|crate|dyn|else|enum|extern|fn|for|if|impl|in|let|loop|match|mod|move|mut|pub|ref|return|self|Self|static|struct|super|trait|type|union|unsafe|use|where|while|macro_rules)\b/;
const JS_KEYWORDS = /\b(?:break|case|catch|class|const|continue|default|else|for|function|if|import|new|return|switch|this|throw|try|while|async|await|let|export|from|type|interface|implements|extends)\b/;
const TYPES = /\b(?:String|str|Option|Result|Vec|HashMap|number|string|boolean|any|void|unknown|never|Record|Promise|ReactNode|ReactElement)\b/;
const TAG = /<\/?[\w:-]+/;
const ATTRIBUTE = /\b[\w-]+(?=\s*=)/;

function commentFor(ext: string): RegExp {
  if (['rs', 'js', 'ts', 'tsx', 'jsx', 'json', 'css', 'svelte'].includes(ext)) return /\/\/.*|\/\*[\s\S]*?\*\//;
  if (['toml', 'yaml', 'yml', 'py', 'sh'].includes(ext)) return /#.*/;
  if (ext === 'html') return /<!--[\s\S]*?-->/;
  return /\/\/.*|#.*/;
}

export function tokenizeDiffLine(text: string, filePath: string): DiffToken[] {
  const ext = filePath.split('.').pop()?.toLowerCase() || '';
  const markup = ext === 'html' || ext === 'svelte';
  const rules: [string, RegExp][] = [
    ['comment', commentFor(ext)],
    ['string', /"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|`(?:\\.|[^`\\])*`/],
    ['number', /\b\d+(?:\.\d+)?\b/],
    ...(markup ? ([['tag', TAG], ['attribute', ATTRIBUTE]] as [string, RegExp][]) : []),
    ['keyword', ext === 'rs' ? RUST_KEYWORDS : JS_KEYWORDS],
    ['type', TYPES],
    ['function', /\b[a-zA-Z_][a-zA-Z0-9_]*(?=\()/],
    ['operator', /[+\-*/%&|^!=<>~?:]+/],
    ['identifier', /[a-zA-Z_][a-zA-Z0-9_]*/],
    ['space', /\s+/],
    ['other', /[\s\S]/],
  ];
  const tokenRegex = new RegExp(rules.map(([name, re]) => `(?<${name}>${re.source})`).join('|'), 'g');
  const tokens: DiffToken[] = [];
  for (const match of text.matchAll(tokenRegex)) {
    const groups = match.groups ?? {};
    const name = rules.find(([n]) => groups[n] !== undefined)?.[0] ?? 'other';
    // Whitespace, identifiers and stray characters are plain text, drawn without a span:
    // colouring every word made prose (Markdown) read as a wall of one colour.
    tokens.push({ type: name === 'space' || name === 'other' || name === 'identifier' ? 'text' : name, text: match[0] });
  }
  return tokens;
}
