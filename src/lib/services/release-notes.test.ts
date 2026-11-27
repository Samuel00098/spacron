import { describe, expect, it } from 'vitest';
import { releaseHighlights } from './release-notes';

const notes = `A release about things.

### Added

- **First thing** — does [this](https://example.com) with \`code\`.
- plain bullet
`;

describe('release notes', () => {
  it('takes the bold lead-in as the headline and counts the rest', () => {
    const out = releaseHighlights(notes, 1);
    expect(out.items).toEqual([{ title: 'First thing', text: 'does this with code.' }]);
    expect(out.more).toBe(1);
  });

  it('shows nothing for the old placeholder notes', () => {
    expect(releaseHighlights('See the changelog for what is new in this release.').items).toEqual([]);
    expect(releaseHighlights(null).items).toEqual([]);
  });
});
