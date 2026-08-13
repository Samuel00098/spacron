import { describe, expect, it } from 'vitest';
import { installDocsFor } from './agent-install';

describe('installDocsFor', () => {
  it('returns the CLI\'s own documentation when one is known', () => {
    const claude = installDocsFor('claude', 'Claude Code');
    expect(claude.known).toBe(true);
    expect(claude.url).toContain('docs.claude.com');
  });

  it('falls back to a search rather than guessing a URL', () => {
    // The roster carries CLIs whose docs URL has never been verified. Inventing
    // one would send someone to a parked domain and call it the install page.
    const unknown = installDocsFor('totally-made-up', 'Totally Made Up');
    expect(unknown.known).toBe(false);
    expect(unknown.url).toContain('Totally%20Made%20Up');
  });

  it('matches the command case-insensitively', () => {
    expect(installDocsFor('Claude', 'Claude Code').url).toBe(
      installDocsFor('claude', 'Claude Code').url
    );
  });

  it('only ever hands back an https URL', () => {
    // These land in a webview; a `javascript:` or `file:` entry slipped into
    // the map would be a navigation the user didn't ask for.
    for (const command of ['claude', 'codex', 'gemini', 'aider', 'nope']) {
      expect(installDocsFor(command, command).url.startsWith('https://')).toBe(true);
    }
  });
});
