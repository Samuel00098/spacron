import { describe, expect, it, beforeEach, vi } from 'vitest';
import { get, writable } from '$lib/stores/storeCompat';

const terminalShellStore = writable('');
const activeProjectStore = writable<{ id: string; root_path: string } | null>(null);
const layoutAmbient = writable('focus');

const ensureIdleOrCreateTerminal = vi.hoisted(() => vi.fn(async () => 7));
const createTerminalSession = vi.hoisted(() => vi.fn(async () => 21));
const killSession = vi.hoisted(() => vi.fn(async () => {}));
const sendPromptToSession = vi.hoisted(() => vi.fn());
const setActiveSession = vi.hoisted(() => vi.fn());
const showTerminal = vi.hoisted(() => vi.fn());
const requestRoomControl = vi.hoisted(() => vi.fn());
const showToast = vi.hoisted(() => vi.fn());
const onSessionExit = vi.hoisted(() => vi.fn(() => () => {}));
const getSessionOutputLength = vi.hoisted(() => vi.fn(() => 0));
const getSessionOutputSince = vi.hoisted(() => vi.fn(() => ''));

vi.mock('$lib/stores/settings', () => ({
  get terminalShell() {
    return terminalShellStore;
  },
}));

vi.mock('$lib/stores/workspace', () => ({
  get activeProject() {
    return activeProjectStore;
  },
}));

vi.mock('$lib/stores/layoutControl', () => ({
  requestRoomControl,
  get layoutSnapshot() {
    return { subscribe: (cb: any) => { cb({ ambient: get(layoutAmbient) }); return () => {}; } };
  },
}));

vi.mock('$lib/stores/layout', () => ({ showTerminal }));

vi.mock('$lib/stores/notification', () => ({ showToast }));

vi.mock('$lib/stores/terminal', () => ({
  ensureIdleOrCreateTerminal,
  createTerminalSession,
  killSession,
  sendPromptToSession,
  setActiveSession,
  onSessionExit,
  getSessionOutputLength,
  getSessionOutputSince,
}));

import { runEmbeddedCommand, embeddedRuns } from './embeddedRun';
import { get as realGet } from '$lib/stores/storeCompat';

describe('runEmbeddedCommand', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useRealTimers();
    terminalShellStore.set('');
    activeProjectStore.set({ id: 'p1', root_path: '/proj' });
    layoutAmbient.set('focus');
    getSessionOutputLength.mockReturnValue(0);
    getSessionOutputSince.mockReturnValue('');
    embeddedRuns.set({});
  });

  it('refuses to run without an open project', async () => {
    activeProjectStore.set(null);
    await runEmbeddedCommand({ key: 'arduino:Upload', command: 'arduino-cli upload', label: 'Upload' });
    expect(showToast).toHaveBeenCalledWith('Open a project before running embedded commands', 'warning');
    expect(sendPromptToSession).not.toHaveBeenCalled();
  });

  it('opens the terminal and marks the run running for interactive commands', async () => {
    await runEmbeddedCommand({
      key: 'arduino:Serial monitor',
      command: 'arduino-cli monitor -p COM3',
      label: 'Serial monitor',
      interactive: true,
    });
    expect(ensureIdleOrCreateTerminal).toHaveBeenCalledWith('/proj', 'p1', false);
    expect(setActiveSession).toHaveBeenCalledWith(7);
    expect(showTerminal).toHaveBeenCalled();
    expect(requestRoomControl).toHaveBeenCalledWith('focus', 'terminal');
    expect(sendPromptToSession).toHaveBeenCalledWith(7, 'arduino-cli monitor -p COM3');
    expect(realGet(embeddedRuns)['arduino:Serial monitor']?.status).toBe('running');
  });

  it('sends a sentinel-wrapped command and flips to success on exit code 0', async () => {
    vi.useFakeTimers();

    // Whatever the wrapper's random token is, resolve it and mirror a matching
    // sentinel back through the pty output, plus a red herring from a sibling
    // run with a different token.
    sendPromptToSession.mockImplementation((_id: number, text: string) => {
      const tokenMatch = text.match(/__SPACRON_EMBEDDED_DONE_([a-z0-9]+)_/);
      const token = tokenMatch?.[1] ?? 'abcd';
      getSessionOutputSince.mockReturnValue(
        `build noise\n__SPACRON_EMBEDDED_DONE_aaaa_1__\n__SPACRON_EMBEDDED_DONE_${token}_0__`,
      );
    });

    let settled = false;
    const promise = runEmbeddedCommand({
      key: 'pio:Upload',
      command: 'pio run -t upload',
      label: 'Upload',
      successMessage: 'Done uploading ✓',
    }).then((result) => {
      settled = true;
      return result;
    });

    await vi.advanceTimersByTimeAsync(400);
    const result = await promise;

    expect(settled).toBe(true);
    expect(sendPromptToSession).toHaveBeenCalled();
    const sentText: string = sendPromptToSession.mock.calls[0][1] as string;
    expect(sentText).toContain('\n');
    expect(sentText).toContain('SPACRON_EMBEDDED_DONE');
    expect(result.exitCode).toBe(0);
    expect(showToast).toHaveBeenCalledWith('Done uploading ✓', 'success', 5000, true);
    expect(realGet(embeddedRuns)['pio:Upload']?.status).toBe('success');
    expect(realGet(embeddedRuns)['pio:Upload']?.exitCode).toBe(0);
  });

  it('marks the run failed when the sentinel reports a non-zero exit', async () => {
    vi.useFakeTimers();

    sendPromptToSession.mockImplementation((_id: number, text: string) => {
      const tokenMatch = text.match(/__SPACRON_EMBEDDED_DONE_([a-z0-9]+)_/);
      const token = tokenMatch?.[1] ?? 'abcd';
      getSessionOutputSince.mockReturnValue(`__SPACRON_EMBEDDED_DONE_${token}_1__`);
    });

    const promise = runEmbeddedCommand({
      key: 'pi:Sync',
      command: 'rsync -av ./ pi@x:/t/',
      label: 'Sync',
    });

    await vi.advanceTimersByTimeAsync(400);
    const result = await promise;

    expect(result.exitCode).toBe(1);
    expect(showToast).toHaveBeenCalledWith('Sync failed (exit 1): see terminal', 'error', 6000);
    expect(realGet(embeddedRuns)['pi:Sync']?.status).toBe('error');
    expect(realGet(embeddedRuns)['pi:Sync']?.exitCode).toBe(1);
  });

  it('runs quietly without stealing terminal focus', async () => {
    vi.useFakeTimers();

    sendPromptToSession.mockImplementation((_id: number, text: string) => {
      const tokenMatch = text.match(/__SPACRON_EMBEDDED_DONE_([a-z0-9]+)_/);
      const token = tokenMatch?.[1] ?? 'abcd';
      getSessionOutputSince.mockReturnValue(`__SPACRON_EMBEDDED_DONE_${token}_0__`);
    });

    const promise = runEmbeddedCommand({
      key: 'arduino:Connection probe',
      command: 'arduino-cli board list --format json',
      label: 'Check connection',
      quiet: true,
    });

    await vi.advanceTimersByTimeAsync(400);
    const result = await promise;

    expect(result.exitCode).toBe(0);
    expect(setActiveSession).not.toHaveBeenCalled();
    expect(showTerminal).not.toHaveBeenCalled();
    expect(requestRoomControl).not.toHaveBeenCalled();
  });

  it('suppresses toasts for background probes', async () => {
    vi.useFakeTimers();

    sendPromptToSession.mockImplementation((_id: number, text: string) => {
      const tokenMatch = text.match(/__SPACRON_EMBEDDED_DONE_([a-z0-9]+)_/);
      const token = tokenMatch?.[1] ?? 'abcd';
      getSessionOutputSince.mockReturnValue(`__SPACRON_EMBEDDED_DONE_${token}_1__`);
    });

    const promise = runEmbeddedCommand({
      key: 'pi:Connection probe',
      command: 'ssh pi@host "echo ok"',
      label: 'Check connection',
      notify: false,
    });

    await vi.advanceTimersByTimeAsync(400);
    const result = await promise;

    expect(result.exitCode).toBe(1);
    expect(showToast).not.toHaveBeenCalled();
  });

  it('runs background commands in a hidden session that is killed on settle', async () => {
    vi.useFakeTimers();

    sendPromptToSession.mockImplementation((_id: number, text: string) => {
      const tokenMatch = text.match(/__SPACRON_EMBEDDED_DONE_([a-z0-9]+)_/);
      const token = tokenMatch?.[1] ?? 'abcd';
      getSessionOutputSince.mockReturnValue(`__SPACRON_EMBEDDED_DONE_${token}_0__`);
    });

    const promise = runEmbeddedCommand({
      key: 'arduino:Connection probe',
      command: 'arduino-cli board list --format json',
      label: 'Check connection',
      background: true,
      notify: false,
    });

    await vi.advanceTimersByTimeAsync(400);
    const result = await promise;

    // A fresh hidden session is created for the probe — the user's shell is
    // never reused, so no terminal focus/pane is touched.
    expect(createTerminalSession).toHaveBeenCalledWith('/proj', undefined, 'p1', {
      isDev: false,
      assignPane: false,
      hidden: true,
    });
    expect(ensureIdleOrCreateTerminal).not.toHaveBeenCalled();
    expect(setActiveSession).not.toHaveBeenCalled();
    expect(showTerminal).not.toHaveBeenCalled();
    expect(requestRoomControl).not.toHaveBeenCalled();
    expect(sendPromptToSession).toHaveBeenCalledWith(21, expect.stringContaining('SPACRON_EMBEDDED_DONE'));
    expect(result.exitCode).toBe(0);
    expect(killSession).toHaveBeenCalledWith(21);
  });

  it('runs background commands in development ambient against the dev store', async () => {
    vi.useFakeTimers();
    layoutAmbient.set('development');

    sendPromptToSession.mockImplementation((_id: number, text: string) => {
      const tokenMatch = text.match(/__SPACRON_EMBEDDED_DONE_([a-z0-9]+)_/);
      const token = tokenMatch?.[1] ?? 'abcd';
      getSessionOutputSince.mockReturnValue(`__SPACRON_EMBEDDED_DONE_${token}_0__`);
    });

    const promise = runEmbeddedCommand({
      key: 'arduino:Connection probe',
      command: 'arduino-cli board list --format json',
      label: 'Check connection',
      background: true,
      notify: false,
    });

    await vi.advanceTimersByTimeAsync(400);
    await promise;

    expect(createTerminalSession).toHaveBeenCalledWith('/proj', undefined, 'p1', {
      isDev: true,
      assignPane: false,
      hidden: true,
    });
  });
});