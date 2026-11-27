import { describe, expect, it } from 'vitest';
import { changelogSection, releaseHighlights } from './release-notes';

const log = `# Changelog

## [Unreleased]

## [v1.2.0] - 2026-01-02

A release about things.

### Added

- **First thing** — does [this](https://example.com) with \`code\`.
- plain bullet

## [v1.1.0] - 2026-01-01

- **Old** — old.
`;

describe('release notes', () => {
  it('reads one version section, with or without the v', () => {
    expect(changelogSection(log, '1.2.0')).toContain('First thing');
    expect(changelogSection(log, 'v1.2.0')).not.toContain('Old');
    expect(changelogSection(log, '9.9.9')).toBeNull();
  });

  it('takes the bold lead-in as the headline and counts the rest', () => {
    const out = releaseHighlights(changelogSection(log, '1.2.0'), 1);
    expect(out.items).toEqual([{ title: 'First thing', text: 'does this with code.' }]);
    expect(out.more).toBe(1);
  });

  it('shows nothing for the old placeholder notes', () => {
    expect(releaseHighlights('See the changelog for what is new in this release.').items).toEqual([]);
    expect(releaseHighlights(null).items).toEqual([]);
  });
});
