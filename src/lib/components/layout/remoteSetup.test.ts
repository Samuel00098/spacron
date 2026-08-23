import { describe, it, expect } from 'vitest';
import { validateDeployInput, deployServerUrl, platformLabel } from './remoteSetup';

const valid = {
  host: 'vps.example.com',
  username: 'samue',
  sshPort: 22,
  keyPath: '',
  workspace: 'code',
  serverPort: 9000,
  platform: 'linux' as const,
};

describe('platformLabel', () => {
  it('uses proper nouns, never raw enum values', () => {
    expect(platformLabel('linux')).toBe('Linux');
    expect(platformLabel('macos')).toBe('macOS');
    expect(platformLabel('windows')).toBe('Windows');
  });
});

describe('validateDeployInput', () => {
  it('accepts a normal input', () => {
    expect(validateDeployInput(valid)).toBeNull();
  });

  it('requires host and username', () => {
    expect(validateDeployInput({ ...valid, host: '' })).toMatch(/Host is required/);
    expect(validateDeployInput({ ...valid, username: '' })).toMatch(/username is required/i);
  });

  it('rejects characters that could confuse ssh', () => {
    expect(validateDeployInput({ ...valid, host: 'evil; rm -rf /' })).toMatch(/Host may only/);
    expect(validateDeployInput({ ...valid, host: 'user@host' })).toMatch(/Host may only/);
    expect(validateDeployInput({ ...valid, username: 'samue x' })).toMatch(/Username may only/);
  });

  it('rejects a workspace path that escapes the home dir', () => {
    expect(validateDeployInput({ ...valid, workspace: '../escape' })).toMatch(/Workspace folder/);
    expect(validateDeployInput({ ...valid, workspace: 'my app' })).toMatch(/Workspace folder/);
  });

  it('rejects out-of-range ports', () => {
    expect(validateDeployInput({ ...valid, sshPort: 0 })).toMatch(/SSH port/);
    expect(validateDeployInput({ ...valid, serverPort: 65536 })).toMatch(/Server port/);
    expect(validateDeployInput({ ...valid, sshPort: NaN })).toMatch(/SSH port/);
  });

  it('accepts every supported platform and rejects unknown ones', () => {
    for (const platform of ['linux', 'macos', 'windows'] as const) {
      expect(validateDeployInput({ ...valid, platform })).toBeNull();
    }
    expect(validateDeployInput({ ...valid, platform: 'plan9' as never })).toMatch(/platform/i);
  });
});

describe('deployServerUrl', () => {
  it('builds the /pty endpoint from host and port', () => {
    expect(deployServerUrl('vps.example.com', 9000)).toBe('ws://vps.example.com:9000/pty');
    expect(deployServerUrl(' 1.2.3.4 ', 8123)).toBe('ws://1.2.3.4:8123/pty');
  });
});
