import { describe, expect, it } from 'vitest';
import { redactEnvFile, secretKind, visibilityNote } from './file-visibility';

describe('secretKind', () => {
  it.each(['.env', '.env.local', 'apps/web/.env.production', 'config/app.env'])('treats %s as an env secret', (path) => {
    expect(secretKind(path)).toBe('env');
  });

  it.each(['.env.example', '.env.sample', '.env.template'])('keeps the %s template readable', (path) => {
    expect(secretKind(path)).toBeNull();
  });

  it.each(['certs/server.pem', 'id_rsa', '.npmrc', 'credentials.json', 'service-account-prod.json', 'secrets.yaml'])('withholds %s as a credential', (path) => {
    expect(secretKind(path)).toBe('credential');
  });

  it('leaves ordinary files alone', () => {
    expect(secretKind('src/env.ts')).toBeNull();
    expect(secretKind('README.md')).toBeNull();
  });
});

describe('visibilityNote', () => {
  it('says why a listed file cannot be read in full', () => {
    expect(visibilityNote('.env.local', true)).toBe('secret: read_file shows variable names only, never values');
    expect(visibilityNote('server.key', false)).toBe('secret: exists, contents withheld');
    expect(visibilityNote('debug.log', true)).toBe('git-ignored, readable with read_file');
    expect(visibilityNote('src/app.ts', false)).toBe('');
  });
});

describe('redactEnvFile', () => {
  it('shows names and whether each value is set, never the value', () => {
    const redacted = redactEnvFile([
      '# Convex',
      'NEXT_PUBLIC_CONVEX_URL=https://happy-otter-123.convex.cloud',
      'CLERK_SECRET_KEY="sk_live_abc123"',
      'EMPTY_ONE=',
      'export API_TOKEN=xyz',
      'garbage line',
      '',
    ].join('\r\n'));

    expect(redacted).toBe([
      '# Convex',
      'NEXT_PUBLIC_CONVEX_URL= <set, 36 chars>',
      'CLERK_SECRET_KEY= <set, 14 chars>',
      'EMPTY_ONE= <empty>',
      'export API_TOKEN= <set, 3 chars>',
      '<line withheld>',
      '',
    ].join('\n'));
    expect(redacted).not.toContain('sk_live');
    expect(redacted).not.toContain('convex.cloud');
  });
});
