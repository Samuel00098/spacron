/** Parsing for the GitHub URLs people paste into the clone dialog.
 *
 *  This is a mirror of `parse_repo_ref` in `src-tauri/src/commands/github.rs`,
 *  and exists only so the dialog can preview the destination folder and enable
 *  its button before shelling out to git. The backend re-parses every URL and is
 *  the authority — nothing here is a security boundary. Keep the two in sync:
 *  if this is stricter than the backend, a valid URL becomes unsubmittable.
 */

export type ParsedRepo = { owner: string; name: string };

const TRANSPORT_PREFIXES = [
  'git@github.com:',
  'ssh://git@github.com/',
  'https://github.com/',
  'http://github.com/',
  'github.com/',
];

export function parseGitHubRepo(input: string): ParsedRepo | null {
  const raw = input.trim();
  // A leading dash would be read by git as a flag rather than a URL.
  if (!raw || raw.startsWith('-') || raw.length > 300) return null;

  let rest: string | null = null;
  for (const prefix of TRANSPORT_PREFIXES) {
    if (raw.startsWith(prefix)) {
      rest = raw.slice(prefix.length);
      break;
    }
  }
  if (rest === null) {
    // A transport or userinfo that didn't match above points off github.com;
    // anything else is treated as bare `owner/repo`.
    if (raw.includes('://') || raw.includes('@')) return null;
    rest = raw;
  }

  rest = rest.split(/[?#]/)[0].replace(/\/+$/, '');
  if (rest.endsWith('.git')) rest = rest.slice(0, -4);

  const parts = rest.split('/');
  // Exactly owner/repo — a deep link like /owner/repo/tree/main is rejected
  // rather than guessed at.
  if (parts.length !== 2) return null;

  const owner = parts[0].trim();
  const name = parts[1].trim();
  if (!/^[A-Za-z0-9-]{1,39}$/.test(owner)) return null;
  if (!/^[A-Za-z0-9._-]{1,100}$/.test(name)) return null;
  if (name === '.' || name === '..') return null;

  return { owner, name };
}
