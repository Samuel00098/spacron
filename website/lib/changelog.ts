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

const RAW_CHANGELOG_URL =
  'https://raw.githubusercontent.com/Samuel00098/spacron/main/CHANGELOG.md';

export async function getChangelogContent(): Promise<string> {
  const filePath = findChangelog();
  if (filePath) return fs.readFileSync(filePath, 'utf-8');

  // Vercel builds this project with `website/` as its root. The parent
  // repository file is therefore outside the deployment and is also excluded
  // by the root .vercelignore. Fetch the public source at build time so a push
  // of CHANGELOG.md is reflected by the next website deployment.
  try {
    const response = await fetch(RAW_CHANGELOG_URL, {
      next: { revalidate: 300 },
    });
    if (response.ok) return await response.text();
  } catch (error) {
    console.warn('Failed to fetch the repository changelog:', error);
  }

  return '# Changelog\n\nUnable to locate CHANGELOG.md.';
}
