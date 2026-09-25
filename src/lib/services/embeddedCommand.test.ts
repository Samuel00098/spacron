import { describe, expect, it, beforeEach, vi, afterEach } from 'vitest';
import { writable, get } from '$lib/stores/storeCompat';

const terminalShellStore = writable('');
const platformValue = writable({ platform: 'Linux x86_64' });

vi.mock('$lib/stores/settings', () => ({
  get terminalShell() {
    return terminalShellStore;
  },
}));

import {
  buildEmbeddedCommand,
  detectShellKind,
  makeRunToken,
  parseEmbeddedExitCode,
  parseBoardListJson,
} from './embeddedCommand';

// Node only has a global `navigator` from v21; CI runs Node 20, where touching
// it threw "navigator is not defined". Install a stand-in there and remove it
// again, so the suite behaves the same on every Node version.
const hadNavigator = typeof globalThis.navigator !== 'undefined';

function stubPlatform(platform: string | undefined) {
  if (platform === undefined) {
    if (!hadNavigator) delete (globalThis as { navigator?: unknown }).navigator;
    else delete (navigator as { platform?: string }).platform;
    return;
  }
  if (!hadNavigator) {
    Object.defineProperty(globalThis, 'navigator', { configurable: true, value: {} });
  }
  Object.defineProperty(navigator, 'platform', { configurable: true, value: platform });
}

describe('detectShellKind', () => {
  beforeEach(() => {
    terminalShellStore.set('');
  });

  afterEach(() => {
    stubPlatform(undefined);
  });

  it('prefers the terminalShell setting over the platform', () => {
    stubPlatform('Win32');
    terminalShellStore.set('cmd');
    expect(detectShellKind()).toBe('cmd');
    terminalShellStore.set('/bin/bash');
    expect(detectShellKind()).toBe('sh');
    terminalShellStore.set('PowerShell 7');
    expect(detectShellKind()).toBe('pwsh');
  });

  it('defaults to pwsh on Windows', () => {
    stubPlatform('Win32');
    expect(detectShellKind()).toBe('pwsh');
  });

  it('defaults to sh on non-Windows platforms', () => {
    stubPlatform('Linux x86_64');
    expect(detectShellKind()).toBe('sh');
  });
});

describe('buildEmbeddedCommand', () => {
  it('emits the sentinel on a fresh line so cmd exit codes are correct', () => {
    const wrapped = buildEmbeddedCommand('arduino-cli compile --fqbn arduino:avr:uno .', 'cmd', 'tok1');
    expect(wrapped.text).toContain('\necho __SPACRON_EMBEDDED_DONE_tok1_%ERRORLEVEL%__');
  });

  it('uses $LASTEXITCODE for PowerShell', () => {
    const wrapped = buildEmbeddedCommand('pio run', 'pwsh', 'tok1');
    expect(wrapped.text).toContain('\necho "__SPACRON_EMBEDDED_DONE_tok1_${LASTEXITCODE}__"');
  });

  it('uses $? for sh-family shells', () => {
    const wrapped = buildEmbeddedCommand('ssh pi@x', 'sh', 'tok1');
    expect(wrapped.text).toContain('\necho "__SPACRON_EMBEDDED_DONE_tok1_$?__"');
  });
});

describe('parseEmbeddedExitCode', () => {
  it('finds the exit code after noisy terminal output', () => {
    const wrapped = buildEmbeddedCommand('rsync -av ./ pi@x:/t', 'sh', 'tok1');
    const output = `\x1b[1muser@host:\x1b[0m$ rsync -av ./ pi@x:/t\n...\n__SPACRON_EMBEDDED_DONE_tok1_0__`;
    expect(parseEmbeddedExitCode(output, wrapped.match)).toBe(0);
  });

  it('returns null when the sentinel never appeared', () => {
    const wrapped = buildEmbeddedCommand('pio run -t upload', 'pwsh', 'tok1');
    expect(parseEmbeddedExitCode('still compiling…', wrapped.match)).toBeNull();
  });

  it('only matches the current run token, never a sibling', () => {
    const wrapped = buildEmbeddedCommand('pio run', 'pwsh', 'tok1');
    const output = `__SPACRON_EMBEDDED_DONE_tok2_7__\n__SPACRON_EMBEDDED_DONE_tok1_0__`;
    expect(parseEmbeddedExitCode(output, wrapped.match)).toBe(0);
  });
});

describe('parseBoardListJson', () => {
  it('extracts the first port with a matching board', () => {
    const json = JSON.stringify([
      { port: { address: '/dev/ttyUSB99' }, matching_boards: [] },
      { port: { address: 'COM3' }, matching_boards: [{ name: 'Arduino Uno', fqbn: 'arduino:avr:uno' }] },
    ]);
    const found = parseBoardListJson(`$ arduino-cli board list --format json\n${json}\n`);
    expect(found).toEqual({ port: 'COM3', name: 'Arduino Uno', fqbn: 'arduino:avr:uno' });
  });

  it('returns null on malformed output', () => {
    expect(parseBoardListJson('error: no board found')).toBeNull();
    expect(parseBoardListJson('[not json')).toBeNull();
  });
});

describe('makeRunToken', () => {
  it('produces distinct tokens', () => {
    expect(makeRunToken()).not.toBe(makeRunToken());
  });
});