import { describe, it, expect } from 'vitest';
import { parseGitHubRepo } from './github-repo-url';

describe('parseGitHubRepo', () => {
  it('accepts the forms people actually paste', () => {
    for (const input of [
      'https://github.com/anthropics/claude-code',
      'https://github.com/anthropics/claude-code.git',
      'https://github.com/anthropics/claude-code/',
      'http://github.com/anthropics/claude-code',
      'github.com/anthropics/claude-code',
      'git@github.com:anthropics/claude-code.git',
      'ssh://git@github.com/anthropics/claude-code.git',
      'anthropics/claude-code',
      '  https://github.com/anthropics/claude-code  ',
    ]) {
      expect(parseGitHubRepo(input), input).toEqual({ owner: 'anthropics', name: 'claude-code' });
    }
  });

  it('strips query strings and fragments', () => {
    expect(parseGitHubRepo('https://github.com/owner/repo?tab=readme#install'))
      .toEqual({ owner: 'owner', name: 'repo' });
  });

  it('keeps dots, dashes and underscores in repo names', () => {
    expect(parseGitHubRepo('owner/my_repo.js-v2')).toEqual({ owner: 'owner', name: 'my_repo.js-v2' });
  });

  it('rejects hosts other than github.com', () => {
    for (const input of [
      'https://gitlab.com/owner/repo',
      'https://evil.example/owner/repo',
      'https://github.com.evil.example/owner/repo',
      'git@gitlab.com:owner/repo.git',
      'file:///etc/passwd',
    ]) {
      expect(parseGitHubRepo(input), input).toBeNull();
    }
  });

  it('rejects strings git would read as options', () => {
    for (const input of ['--upload-pack=whatever', '-u', '--config=x']) {
      expect(parseGitHubRepo(input), input).toBeNull();
    }
  });

  it('rejects traversal in the repo name, which becomes the folder name', () => {
    for (const input of ['owner/..', 'owner/.', '../../etc']) {
      expect(parseGitHubRepo(input), input).toBeNull();
    }
  });

  it('rejects deep links rather than guessing the repo', () => {
    expect(parseGitHubRepo('https://github.com/owner/repo/tree/main/src')).toBeNull();
  });

  it('rejects incomplete references', () => {
    for (const input of ['', '   ', 'owner', 'https://github.com/', 'https://github.com/owner']) {
      expect(parseGitHubRepo(input), JSON.stringify(input)).toBeNull();
    }
  });

  // The backend accepts up to 300 chars; anything longer is rejected on both
  // sides, so the button must not offer to submit it.
  it('rejects absurdly long input', () => {
    expect(parseGitHubRepo(`owner/${'a'.repeat(400)}`)).toBeNull();
  });
});
