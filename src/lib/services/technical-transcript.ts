/**
 * Technical normalization for dictated text.
 *
 * Speech models hear a developer saying "get hub", "type script", "dash dash
 * force", "the a p i returns jason" and write down exactly that. The words are
 * right; the spelling is amateur. Wispr Flow and Typeless close most of that
 * gap with an LLM rewrite pass, but a rewrite pass is slow, costs a request,
 * is not always configured, and must NEVER run over a shell command — so the
 * high-frequency, unambiguous half of the job is done here instead:
 * deterministically, in microseconds, on every path including terminals.
 *
 * The rules are deliberately conservative. Each one is word-bounded and only
 * fires on a form that is not ordinary English, because a wrong "correction"
 * in the middle of someone's sentence is worse than a term they have to fix
 * themselves. Anything genuinely ambiguous (a bare "sequel" for SQL, a bare
 * "jason" for JSON) is left to the rewrite pass, which has the context to
 * judge it.
 */

/**
 * Acronyms a developer spells out loud, and which should be upper-cased when
 * they arrive as an ordinary lowercase word.
 *
 * Every entry has to fail one test: could an English sentence contain this as
 * a word? That is why `it`, `us`, `on`, `or`, `so`, `no`, `at` and `cors`
 * (heard as "course") are absent, and why this list is much shorter than the
 * set of acronyms that exist.
 */
export const DEV_ACRONYMS = new Set([
  'ai', 'api', 'ascii', 'ast', 'aws', 'cdn', 'ci', 'cli', 'cpu', 'crud', 'css',
  'csv', 'dns', 'dom', 'dto', 'eof', 'gpu', 'gui', 'html', 'http', 'https',
  'id', 'ide', 'io', 'ip', 'jpeg', 'json', 'jsx', 'jwt', 'llm', 'mvp', 'orm',
  'os', 'pdf', 'php', 'png', 'pr', 'qa', 'ram', 'rest', 'rpc', 'sdk', 'seo',
  'sql', 'ssh', 'ssl', 'svg', 'tcp', 'tls', 'tsx', 'ttl', 'ui', 'url', 'ux',
  'uuid', 'vm', 'vpn', 'xml', 'yaml',
]);

/**
 * Terms whose canonical spelling is lowercase, so sentence capitalization has
 * to leave them alone. "Npm install" is not more professional than "npm
 * install"; it is wrong.
 */
export const LOWERCASE_LOCKED = new Set([
  'npm', 'npx', 'pnpm', 'nginx', 'kubectl', 'webpack', 'localhost',
  'ffmpeg', 'curl', 'git', 'grep', 'sed', 'awk', 'ls', 'cd', 'sudo', 'rustc',
  'cargo', 'pip', 'yarn', 'bun', 'deno', 'vite', 'tsc', 'gcc', 'clang', 'ssh',
  'esbuild', 'iphone', 'macos',
]);

/**
 * Words that can precede a spoken file extension without being the filename.
 * "open dot env" is a command and a file; "app dot ts" is one file.
 */
const FILENAME_STOP_WORDS = new Set([
  'a', 'an', 'the', 'in', 'to', 'at', 'of', 'on', 'and', 'or', 'is', 'it', 'as',
  'open', 'edit', 'read', 'write', 'run', 'check', 'see', 'with', 'from', 'into',
  'called', 'named', 'file', 'files', 'create', 'delete', 'add', 'update', 'my',
  'that', 'this', 'your', 'its', 'new', 'old', 'for',
]);

type Correction = { pattern: RegExp; replace: string | ((...args: string[]) => string) };

const c = (pattern: RegExp, replace: Correction['replace']): Correction => ({ pattern, replace });

/**
 * Ordered phrase corrections. ORDER MATTERS: longer phrases come first, so
 * "post gres sequel" resolves before "post gres" can claim half of it.
 *
 * The right-hand side is used verbatim — these terms have exactly one correct
 * casing, and how the speech model happened to capitalize them carries no
 * information at all.
 */
const PHRASE_CORRECTIONS: Correction[] = [
  // ── Spoken file extensions and flags ─────────────────────────────────────
  // These run first, while "dot" and "dash" are still words. The
  // spoken-punctuation table downstream rewrites both to bare symbols, after
  // which ". ts" is indistinguishable from the end of a sentence.
  c(
    /(\S*)\s*\bdot\s+(ts|tsx|js|jsx|mjs|cjs|py|rs|go|rb|java|json|yaml|yml|toml|md|css|scss|html|sh|sql|env|lock|txt|csv|svg|png|jpg)\b/gi,
    (_m, base: string, ext: string) => {
      const dotted = `.${ext.toLowerCase()}`;
      // "app dot ts" is one filename; "open dot env" is a verb and a filename.
      // Gluing the extension to whatever word came first would produce
      // "open.env", so a base that cannot be a filename keeps its space.
      const stem = base.trim();
      if (!stem || !/^[A-Za-z0-9_\-./\\]+$/.test(stem) || FILENAME_STOP_WORDS.has(stem.toLowerCase())) {
        return `${stem}${stem ? ' ' : ''}${dotted}`;
      }
      return `${stem}${dotted}`;
    },
  ),

  // ── Spelled-out product names ────────────────────────────────────────────
  c(/\bpost\s?gres\s?(?:sequel|s\.?\s?q\.?\s?l\.?)\b/gi, 'PostgreSQL'),
  c(/\bpostgres\b/gi, 'Postgres'),
  c(/\bmy\s?sequel\b/gi, 'MySQL'),
  c(/\bno\s?sequel\b/gi, 'NoSQL'),
  c(/\bsequel\s?(?:light|lite)\b/gi, 'SQLite'),
  c(
    /\bsequel\s+(server|query|queries|statement|statements|schema|database|databases|injection|migration|migrations)\b/gi,
    (_m, noun: string) => `SQL ${noun.toLowerCase()}`,
  ),
  c(/\bg(?:it|et)\s?hub\s+actions\b/gi, 'GitHub Actions'),
  c(/\bg(?:it|et)\s?hub\b/gi, 'GitHub'),
  c(/\bg(?:it|et)\s?lab\b/gi, 'GitLab'),
  c(/\bbit\s?bucket\b/gi, 'Bitbucket'),
  c(/\bjava\s?script\b/gi, 'JavaScript'),
  c(/\btype\s?script\b/gi, 'TypeScript'),
  c(/\bnode\s?(?:dot\s?)?j\.?\s?s\.?\b/gi, 'Node.js'),
  c(/\bnext\s?(?:dot\s?)?j\.?\s?s\.?\b/gi, 'Next.js'),
  c(/\bnuxt\s?(?:dot\s?)?j\.?\s?s\.?\b/gi, 'Nuxt'),
  c(/\breact\s?(?:dot\s?)?j\.?\s?s\.?\b/gi, 'React'),
  c(/\bv(?:ue|iew)\s?(?:dot\s?)?j\.?\s?s\.?\b/gi, 'Vue'),
  c(/\bthree\s?(?:dot\s?)?j\.?\s?s\.?\b/gi, 'Three.js'),
  c(/\bmongo\s?d\.?\s?b\.?\b/gi, 'MongoDB'),
  c(/\bdynamo\s?d\.?\s?b\.?\b/gi, 'DynamoDB'),
  c(/\bred\s?is\b/gi, 'Redis'),
  c(/\bgraph\s?q\.?\s?l\.?\b/gi, 'GraphQL'),
  c(/\bo\.?\s?auth\b/gi, 'OAuth'),
  c(/\bopen\s?a\.?\s?i\.?\b/gi, 'OpenAI'),
  c(/\banthropic\b/gi, 'Anthropic'),
  c(/\bweb\s?socket(s?)\b/gi, (_m, plural: string) => `WebSocket${plural}`),
  c(/\bweb\s?assembly\b/gi, 'WebAssembly'),
  c(/\bweb\s?pack\b/gi, 'webpack'),
  c(/\bes\s?lint\b/gi, 'ESLint'),
  c(/\bes\s?build\b/gi, 'esbuild'),
  c(/\btail\s?wind\b/gi, 'Tailwind'),
  c(/\bsup(?:a|er)\s?base\b/gi, 'Supabase'),
  c(/\bfire\s?base\b/gi, 'Firebase'),
  c(/\bengine\s?x\b/gi, 'nginx'),
  c(/\b[ck]ube\s?(?:ctl|control|cuddle)\b/gi, 'kubectl'),
  c(/\bkubernetes\b/gi, 'Kubernetes'),
  c(/\bdocker\s?-?\s?compose\b/gi, 'Docker Compose'),
  c(/\bdocker\b/gi, 'Docker'),
  c(/\b(?:v\.?\s?s\.?|visual\s?studio)\s?code\b/gi, 'VS Code'),
  c(/\bc\s?sharp\b/gi, 'C#'),
  c(/\bc\s?plus\s?plus\b/gi, 'C++'),
  c(/\bdot\s?net\b/gi, '.NET'),
  c(/\bgo\s?lang\b/gi, 'Go'),
  c(/\blocal\s?host\b/gi, 'localhost'),
  c(/\bc\.?\s?i\.?[\s/]+c\.?\s?d\.?\b/gi, 'CI/CD'),
  c(/\bp\s?npm\b/gi, 'pnpm'),
  c(/\bn\.?\s?p\.?\s?m\.?\b/gi, 'npm'),
  c(/\bhttp\s?s\b/gi, 'HTTPS'),
  c(/\bstack\s?overflow\b/gi, 'Stack Overflow'),
  c(/\bpy\s?torch\b/gi, 'PyTorch'),
  c(/\bnum\s?py\b/gi, 'NumPy'),

  // ── Terms only safe with a technical noun attached ───────────────────────
  // A bare "jason" is a person; "the jason payload" is not. Same reasoning as
  // "sequel" above: the neighbouring noun is what makes the edit safe.
  c(
    /\bjason\s+(file|files|object|objects|payload|payloads|response|responses|body|blob|schema|array|arrays|key|keys|field|fields|parser|parsing|output|data|config)\b/gi,
    (_m, noun: string) => `JSON ${noun.toLowerCase()}`,
  ),
  c(/\bdot\s?jason\b/gi, '.json'),
  c(/\byam+e?l\b/gi, 'YAML'),
];

/**
 * Spelled-out flags: "dash dash force" → "--force", "dash r" → "-r".
 *
 * Runs before spoken punctuation, which would otherwise rewrite each "dash" to
 * a bare hyphen and leave "- - force" behind. The body has to look like a flag
 * (one letter, or a lowercase word optionally hyphenated) or the rule stands
 * down — "a dash between the two numbers" must survive untouched.
 */
function reconstructFlags(text: string): string {
  return text
    // "dash dash dry dash run" — every word explicitly joined, which is how a
    // multi-word flag has to be dictated for this to be unambiguous.
    .replace(
      /\b(?:dash|hyphen)[\s-]+(?:dash|hyphen)\s+([a-z][a-z0-9]*(?:\s+(?:dash|hyphen)\s+[a-z0-9]+)+)\b/gi,
      (_m, body: string) => `--${body.toLowerCase().replace(/\s+(?:dash|hyphen)\s+/g, '-')}`,
    )
    // Otherwise a long flag claims exactly ONE word. "run dash dash strict and
    // check the tests" must not become "--strict-and": there is nothing in the
    // audio that separates a second flag word from the rest of the sentence,
    // so the conservative read is the only safe one.
    .replace(
      /\b(?:dash|hyphen)[\s-]+(?:dash|hyphen)\s+([a-z][a-z0-9]*)\b/gi,
      (_m, body: string) => `--${body.toLowerCase()}`,
    )
    .replace(/\b(?:dash|hyphen)\s+([a-z])\b(?!\s*(?:dash|hyphen)\b)/gi, (_m, letter: string) => `-${letter}`);
}

/**
 * Collapse a spelled-out acronym ("a p i", "c. l. i.") into one token.
 *
 * Membership in `DEV_ACRONYMS` is required, rather than a rule like "three
 * letters in a row": letters standing alone in prose ("plan A, B and C") are
 * common, and joining those is damage nobody can undo from the text.
 */
function collapseSpelledAcronyms(text: string): string {
  return text.replace(
    /\b([A-Za-z])\.?(?:[ \t]+[A-Za-z]\.?){1,5}(?![A-Za-z])/g,
    (match: string, _first: string, offset: number, whole: string) => {
      const letters = (match.match(/[A-Za-z]/g) ?? []).join('');
      if (!DEV_ACRONYMS.has(letters.toLowerCase())) return match;
      // The run swallows a trailing period, which is the dictated "c. l. i."
      // style — except when that period is the end of the sentence ("it uses
      // the A P I."), where dropping it would run two sentences together.
      const rest = whole.slice(offset + match.length);
      const endsSentence = match.endsWith('.') && /^\s*$|^\s+["'(\[]?[A-Z0-9]/.test(rest);
      return letters.toUpperCase() + (endsSentence ? '.' : '');
    },
  );
}

/**
 * Upper-case dev acronyms that arrived as a plain lowercase word.
 *
 * A plain word boundary is not enough: it fires inside `config.json` and
 * `src/api/routes`, turning a filename or a path into `config.JSON`. So the
 * word must not be glued to an identifier on either side — while a trailing
 * full stop still counts as the end of a sentence ("it goes through the api.").
 */
function normalizeAcronymCase(text: string): string {
  return text.replace(
    /(^|[^A-Za-z0-9._/\\-])([a-z]{2,5})(?![A-Za-z0-9_/\\-])(?!\.[A-Za-z0-9_])/g,
    (match, lead: string, word: string) =>
      DEV_ACRONYMS.has(word) ? `${lead}${word.toUpperCase()}` : match,
  );
}

/**
 * Immediate word repeats, which speech models transcribe faithfully from a
 * stumble ("we we need to"). Only function words qualify: "had had" and "that
 * that" are real English, and this must not start editing anyone's grammar.
 */
const STUTTER_WORDS = /\b(the|a|an|to|and|of|in|is|it|we|you|i|but|so|for|on|at|with|this)\s+\1\b/gi;

function removeStutters(text: string): string {
  let previous: string;
  let result = text;
  // One pass only removes one repeat out of "the the the".
  do {
    previous = result;
    result = result.replace(STUTTER_WORDS, '$1');
  } while (result !== previous);
  return result;
}

/**
 * Capitalize the first word of each sentence.
 *
 * TEXT FIELDS ONLY. A terminal payload has to survive byte for byte — "npm
 * install" is a command and "Npm install" is a typo. Even in prose, a word
 * whose canonical form is lowercase (`LOWERCASE_LOCKED`) is left alone, and
 * the pattern only matches all-lowercase words, so `useEffect` and `GitHub`
 * are never candidates in the first place.
 */
function capitalizeSentences(text: string): string {
  return text.replace(
    /(^|[.!?]["')\]]?\s+|\n[ \t]*)([a-z][a-z0-9]*)(?![A-Za-z])/g,
    (match, lead: string, word: string) => {
      if (LOWERCASE_LOCKED.has(word)) return match;
      return `${lead}${word.charAt(0).toUpperCase()}${word.slice(1)}`;
    },
  );
}

export type TechnicalNormalizeOptions = {
  /**
   * Capitalize sentence openings. Off for terminals, where the payload is a
   * command rather than prose.
   */
  capitalize?: boolean;
};

/**
 * Run the whole technical pass. The order is load-bearing:
 *
 * 1. flags, while "dash" is still a word;
 * 2. phrase corrections, longest first (file extensions lead, while "dot" is
 *    still a word);
 * 3. spelled acronyms collapsed, then lowercase ones upper-cased;
 * 4. stutters;
 * 5. capitalization (prose only) last, so it sees the final wording.
 */
export function normalizeTechnicalTranscript(
  input: string,
  options: TechnicalNormalizeOptions = {},
): string {
  const { capitalize = false } = options;
  if (!input) return '';

  let text = reconstructFlags(input);
  for (const { pattern, replace } of PHRASE_CORRECTIONS) {
    text = typeof replace === 'string' ? text.replace(pattern, replace) : text.replace(pattern, replace as never);
  }
  text = collapseSpelledAcronyms(text);
  text = normalizeAcronymCase(text);
  text = removeStutters(text);
  if (capitalize) text = capitalizeSentences(text);
  return text;
}
