// Prints the CHANGELOG section for one version, for the release workflow: it
// becomes the GitHub release body and the updater's notes in latest.json, which
// the app shows before an update is installed.
//   node scripts/release-notes.js v5.2.0
import { readFileSync } from 'node:fs';

const version = (process.argv[2] ?? '').replace(/^v/, '');
const lines = readFileSync(new URL('../CHANGELOG.md', import.meta.url), 'utf8')
  .replace(/\r\n/g, '\n')
  .split('\n');
const start = lines.findIndex((line) => /^## \[v?([^\]]+)\]/.exec(line)?.[1] === version);
const end = lines.findIndex((line, i) => i > start && line.startsWith('## '));
const section = start < 0 ? '' : lines.slice(start + 1, end < 0 ? undefined : end).join('\n').trim();

console.log(section || 'See the changelog for what is new in this release.');
