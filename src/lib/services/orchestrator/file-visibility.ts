/**
 * What the orchestrator may see of a file that exists.
 *
 * Every file is LISTED — a missing entry used to read as "the file does not
 * exist", which is how a review claimed there was no `.env.local` when it was
 * only git-ignored. Secret files are listed but their values never reach a
 * model provider: an env file shows its variable names and whether each is
 * set, and key/credential files show only that they exist.
 *
 * Pure: the store does the I/O.
 */

const ENV_TEMPLATE_RE = /\.(?:example|sample|template|defaults?|dist)$/i;
const SECRET_NAME_RE = /^(?:id_(?:rsa|dsa|ecdsa|ed25519)(?:\.pub)?|\.npmrc|\.pypirc|\.netrc|\.pgpass|credentials(?:\.json)?|service[-_]?account.*\.json|secrets?\.(?:json|ya?ml|toml))$/i;
const SECRET_EXT_RE = /\.(?:pem|key|p12|pfx|keystore|jks|asc|gpg)$/i;

export type SecretKind = 'env' | 'credential';

/** 'env' for dotenv files (values withheld), 'credential' for keys and tokens, else null. */
export function secretKind(path: string): SecretKind | null {
  const name = path.split(/[\\/]/).pop() ?? '';
  if (/^\.env(?:\..+)?$/i.test(name) || /\.env$/i.test(name)) return ENV_TEMPLATE_RE.test(name) ? null : 'env';
  if (SECRET_NAME_RE.test(name) || SECRET_EXT_RE.test(name)) return 'credential';
  return null;
}

/** The marker a listing puts after a file the orchestrator cannot read in full. */
export function visibilityNote(path: string, ignored: boolean): string {
  const kind = secretKind(path);
  if (kind === 'env') return 'secret: read_file shows variable names only, never values';
  if (kind === 'credential') return 'secret: exists, contents withheld';
  return ignored ? 'git-ignored, readable with read_file' : '';
}

/**
 * An env file with every value replaced by whether it is set, so the model
 * can check configuration ("CLERK_SECRET_KEY is set, CONVEX_URL is empty")
 * without a secret ever leaving the machine.
 */
export function redactEnvFile(content: string): string {
  return content.replace(/\r\n/g, '\n').split('\n').map((line) => {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) return line;
    const match = /^(\s*(?:export\s+)?[A-Za-z_][A-Za-z0-9_.-]*\s*[=:])\s*(.*)$/.exec(line);
    if (!match) return '<line withheld>';
    const value = match[2].trim().replace(/^(['"])(.*)\1$/, '$2');
    return `${match[1]}${value ? ` <set, ${value.length} chars>` : ' <empty>'}`;
  }).join('\n');
}
