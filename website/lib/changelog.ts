import fs from 'fs';
import path from 'path';

function findChangelog(): string {
  const candidates = [
    path.join(process.cwd(), '..', 'CHANGELOG.md'),
    path.join(process.cwd(), 'CHANGELOG.md'),
  ];
  for (const p of candidates) {
    if (fs.existsSync(p)) return p;
  }
  return '';
}

export type VersionEntry = {
  version: string;
  date: string;
  body: string;
};

export function parseChangelog(markdown: string): VersionEntry[] {
  const entries: VersionEntry[] = [];
  const normalized = markdown.replace(/\r\n/g, '\n');
  const lines = normalized.split('\n');
  let current: VersionEntry | null = null;
  let bodyLines: string[] = [];

  for (const line of lines) {
    const heading = line.match(/^##\s+\[v?(\d+\.\d+\.\d+(?:-\w+)?)\]\s*-\s*(.+)$/);
    if (heading) {
      if (current) {
        current.body = bodyLines.join('\n').trim();
        entries.push(current);
      }
      current = { version: heading[1], date: heading[2].trim(), body: '' };
      bodyLines = [];
      continue;
    }

    if (current) {
      bodyLines.push(line);
    }
  }

  if (current) {
    current.body = bodyLines.join('\n').trim();
    entries.push(current);
  }

  return entries;
}

export function getChangelogContent(): string {
  const filePath = findChangelog();
  if (!filePath) return '# Changelog\n\nUnable to locate CHANGELOG.md.';
  return fs.readFileSync(filePath, 'utf-8');
}
