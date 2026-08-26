import { describe, it, expect } from 'vitest';
import {
  validateDeployInput,
  deployServerUrl,
  platformLabel,
  binaryNotice,
} from './remoteSetup';

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

describe('binaryNotice', () => {
  const ready = { available: true, path: '/tmp/spacron-server', detail: null, downloadable: true };
  const missing = { available: false, path: null, detail: 'nope', downloadable: true };

  it('says nothing until the status is known', () => {
    expect(binaryNotice('linux', null, 'windows').kind).toBe('none');
  });

  it('stays quiet when deploying to the OS this app runs on', () => {
    expect(binaryNotice('windows', ready, 'windows').kind).toBe('none');
  });

  it('confirms a cross-OS build that is already present', () => {
    const notice = binaryNotice('linux', ready, 'windows');
    expect(notice.kind).toBe('ready');
    expect(notice.kind === 'ready' && notice.text).toMatch(/Linux server build is ready/);
  });

  it('offers the download when the target build is missing', () => {
    const notice = binaryNotice('linux', missing, 'windows');
    expect(notice.kind).toBe('download');
    // The button names the OS being deployed TO, never the host's.
    expect(notice.kind === 'download' && notice.action).toBe('Get the Linux server');
    expect(notice.kind === 'download' && notice.text).toMatch(/ships the Windows build/);
  });

  it('falls back to the resolver text when nothing can be downloaded', () => {
    const notice = binaryNotice('macos', { ...missing, downloadable: false }, 'windows');
    expect(notice.kind).toBe('blocked');
    expect(notice.kind === 'blocked' && notice.text).toBe('nope');
  });

  it('does not claim a host build when the host OS is unknown', () => {
    const notice = binaryNotice('linux', missing, null);
    expect(notice.kind === 'download' && notice.text).toMatch(/ships the host build/);
  });
});
