import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Regression tests for the wrapper-only settings keys (agentWorktrees,
// autoStageAgentChanges, agentBrowserTools). They are declared in
// stores/settings.ts behind `persistentWritable` but were missing from this
// store's `createSettingsState()`, so `persistentWritable`'s boot-time
// `getState()[key]` read hit undefined and fell back to the wrapper default
// every launch — toggles survived a session but silently reset on restart.
//
// Vitest runs in `node` (no jsdom), so `window` and `localStorage` are stubbed
// per test. `vi.resetModules()` gives every test a fresh module graph, which is
// the only way to exercise the at-import boot read.
//
// The stored key format must match `persistValue` in this file:
// `forge_setting_<key>` with a JSON-encoded value.

function stubWebStorage(): Map<string, string> {
  const store = new Map<string, string>();
  vi.stubGlobal('window', {});
  vi.stubGlobal('localStorage', {
    getItem: (k: string) => (store.has(k) ? store.get(k)! : null),
    setItem: (k: string, v: string) => void store.set(String(k), String(v)),
    removeItem: (k: string) => void store.delete(k),
    clear: () => void store.clear(),
  });
  return store;
}

beforeEach(() => {
  vi.resetModules();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('zustand settings boot rehydration', () => {
  it('rehydrates the wrapper-only keys from persisted localStorage at boot', async () => {
    const storage = stubWebStorage();
    storage.set('forge_setting_agentWorktrees', JSON.stringify(false));
    storage.set('forge_setting_autoStageAgentChanges', JSON.stringify(true));
    storage.set('forge_setting_agentBrowserTools', JSON.stringify(true));

    const { useSettingsStore } = await import('./settings');
    const s = useSettingsStore.getState();
    expect(s.agentWorktrees).toBe(false);
    expect(s.autoStageAgentChanges).toBe(true);
    expect(s.agentBrowserTools).toBe(true);
  });

  it('falls back to the same defaults as stores/settings.ts when nothing is persisted', async () => {
    stubWebStorage();

    const { useSettingsStore } = await import('./settings');
    const s = useSettingsStore.getState();
    expect(s.agentWorktrees).toBe(true);
    expect(s.autoStageAgentChanges).toBe(false);
    expect(s.agentBrowserTools).toBe(false);
  });

  it('persists in-app browser control independently of Playwright', async () => {
    const storage = stubWebStorage();
    const { useSettingsStore } = await import('./settings');
    expect(useSettingsStore.getState().agentPreviewBrowser).toBe(false);

    useSettingsStore.getState().__set('agentPreviewBrowser', true);
    expect(storage.get('forge_setting_agentPreviewBrowser')).toBe('true');
    vi.resetModules();

    const { useSettingsStore: reloaded } = await import('./settings');
    expect(reloaded.getState().agentPreviewBrowser).toBe(true);
    expect(reloaded.getState().agentBrowserTools).toBe(false);
  });

  it('round-trips a toggle through __set into persisted storage', async () => {
    stubWebStorage();

    const { useSettingsStore } = await import('./settings');
    useSettingsStore.getState().__set('agentWorktrees', false);

    const s = useSettingsStore.getState();
    expect(s.agentWorktrees).toBe(false);
    expect(globalThis.localStorage.getItem('forge_setting_agentWorktrees')).toBe('false');
  });
});

/**
 * "Send after transcribing" is opt-in: auto-send presses Enter on a half-heard
 * sentence in a live shell before the user can read it, so off is the safe
 * landing and on is a deliberate click that has to stick.
 *
 * It was one of the undeclared wrapper-only keys above, which is why a plain
 * default change would not have been enough — the stored value was inert, and
 * declaring the key resurrects it. Hence the one-time migration.
 */
describe('transcriptionAutoSend defaults to off', () => {
  const KEY = 'forge_setting_transcriptionAutoSend';
  const FLAG = 'forge_migration_transcriptionAutoSendOff_v1';

  it('is off on a fresh install', async () => {
    stubWebStorage();

    const { useSettingsStore } = await import('./settings');
    expect(useSettingsStore.getState().transcriptionAutoSend).toBe(false);
  });

  it('clears a stale persisted `true` once, so existing installs land on off', async () => {
    const storage = stubWebStorage();
    storage.set(KEY, JSON.stringify(true));

    const { useSettingsStore } = await import('./settings');
    expect(useSettingsStore.getState().transcriptionAutoSend).toBe(false);
    expect(storage.get(KEY)).toBe('false');
    expect(storage.get(FLAG)).toBe('1');
  });

  it('leaves a deliberate turn-on alone — the migration only ever runs once', async () => {
    const storage = stubWebStorage();
    // The user switched it back on after the migration had already run.
    storage.set(FLAG, '1');
    storage.set(KEY, JSON.stringify(true));

    const { useSettingsStore } = await import('./settings');
    expect(useSettingsStore.getState().transcriptionAutoSend).toBe(true);
  });

  it('keeps a turn-on across a restart', async () => {
    const storage = stubWebStorage();
    storage.set(FLAG, '1');

    const first = await import('./settings');
    first.useSettingsStore.getState().__set('transcriptionAutoSend', true);
    expect(storage.get(KEY)).toBe('true');

    // Boot again against the same storage.
    vi.resetModules();
    const second = await import('./settings');
    expect(second.useSettingsStore.getState().transcriptionAutoSend).toBe(true);
  });
});

/**
 * The dictation polish pass's custom vocabulary (WhisperFlow-style hotwords).
 * A brand-new key, so no migration is needed — but it must be declared here in
 * all three places, or the boot read resets it like the wrapper-only keys.
 */
describe('dictationVocabulary custom terms', () => {
  it('is empty on a fresh install', async () => {
    stubWebStorage();

    const { useSettingsStore } = await import('./settings');
    expect(useSettingsStore.getState().dictationVocabulary).toBe('');
  });

  it('round-trips an edited list into persisted storage', async () => {
    const storage = stubWebStorage();

    const { useSettingsStore } = await import('./settings');
    useSettingsStore.getState().__set('dictationVocabulary', 'Spacron, Parakeet');

    expect(useSettingsStore.getState().dictationVocabulary).toBe('Spacron, Parakeet');
    expect(storage.get('forge_setting_dictationVocabulary')).toBe(
      JSON.stringify('Spacron, Parakeet'),
    );
  });

  it('rehydrates a saved list at boot', async () => {
    const storage = stubWebStorage();
    storage.set('forge_setting_dictationVocabulary', JSON.stringify('onnxruntime'));

    const { useSettingsStore } = await import('./settings');
    expect(useSettingsStore.getState().dictationVocabulary).toBe('onnxruntime');
  });
});

/**
 * Smart VAD is opt-in: it needs the Silero model downloaded, and until then
 * dictation must run exactly as before (level gate).
 */
describe('smartVadEnabled defaults to off', () => {
  it('is off on a fresh install', async () => {
    stubWebStorage();

    const { useSettingsStore } = await import('./settings');
    expect(useSettingsStore.getState().smartVadEnabled).toBe(false);
  });

  it('round-trips a turn-on into persisted storage and back', async () => {
    const storage = stubWebStorage();

    const first = await import('./settings');
    first.useSettingsStore.getState().__set('smartVadEnabled', true);
    expect(storage.get('forge_setting_smartVadEnabled')).toBe('true');

    vi.resetModules();
    const second = await import('./settings');
    expect(second.useSettingsStore.getState().smartVadEnabled).toBe(true);
  });
});

describe('browser and Orca design mode settings', () => {
  it('falls back to expected default browser preferences when nothing is persisted', async () => {
    stubWebStorage();

    const { useSettingsStore } = await import('./settings');
    const s = useSettingsStore.getState();
    expect(s.browserDefaultPort).toBe(3000);
    expect(s.browserPreferredHost).toBe('localhost');
    expect(s.browserThemeMode).toBe('system');
    expect(s.browserOpenLinksIn).toBe('preview');
    expect(s.browserDesignModeAutoScreenshot).toBe(true);
    expect(s.browserDesignModeIncludeStyles).toBe(true);
    expect(s.browserDesignModeIncludeHtml).toBe(true);
    expect(s.browserDesignModeMaxHtmlLength).toBe(2000);
    expect(s.browserConsoleAutoOpenOnError).toBe(false);
  });

  it('rehydrates saved browser and design mode settings at boot', async () => {
    const storage = stubWebStorage();
    storage.set('forge_setting_browserDefaultPort', JSON.stringify(5173));
    storage.set('forge_setting_browserThemeMode', JSON.stringify('dark'));
    storage.set('forge_setting_browserDesignModeAutoScreenshot', JSON.stringify(false));
    storage.set('forge_setting_browserDesignModeMaxHtmlLength', JSON.stringify(3000));

    const { useSettingsStore } = await import('./settings');
    const s = useSettingsStore.getState();
    expect(s.browserDefaultPort).toBe(5173);
    expect(s.browserThemeMode).toBe('dark');
    expect(s.browserDesignModeAutoScreenshot).toBe(false);
    expect(s.browserDesignModeMaxHtmlLength).toBe(3000);
  });

  it('round-trips browser settings updates through updateSetting into persisted storage', async () => {
    const storage = stubWebStorage();

    const { useSettingsStore } = await import('./settings');
    useSettingsStore.getState().updateSetting('browserDefaultPort', 8080);
    useSettingsStore.getState().updateSetting('browserThemeMode', 'light');

    expect(storage.get('forge_setting_browserDefaultPort')).toBe('8080');
    expect(storage.get('forge_setting_browserThemeMode')).toBe('"light"');
  });
});

describe('userShortcuts defaults and audit migration', () => {
  const KEY = 'forge_setting_userShortcuts';
  const FLAG = 'forge_migration_shortcutsAudit_v1';

  it('seeds fresh installs with canonical defaultShortcuts', async () => {
    stubWebStorage();
    const { defaultShortcuts } = await import('../shortcuts');
    const { useSettingsStore } = await import('./settings');
    expect(useSettingsStore.getState().userShortcuts).toEqual(defaultShortcuts);
  });

  it('migrates legacy F9/AltGr/DB shortcuts and prunes retired ones once', async () => {
    const storage = stubWebStorage();
    storage.set(
      KEY,
      JSON.stringify([
        { id: 'launchVoiceMode', label: 'Launch Voice Mode', keys: 'Ctrl+Shift+M' },
        { id: 'toggleProjectHUD', label: 'Toggle Projects Sidebar', keys: 'Ctrl+K' },
        { id: 'startProxy', label: 'Start Preview Proxy', keys: 'Ctrl+Alt+P' },
        { id: 'stopProxy', label: 'Stop Preview Proxy', keys: 'Ctrl+Alt+O' },
        { id: 'transcribeToTerminal', label: 'Transcribe (speech to text)', keys: 'F9' },
        { id: 'cycleAmbientLayout', label: 'Cycle Ambient Layout', keys: 'Ctrl+Alt+A' },
        { id: 'goToDb', label: 'Go to Database Explorer', keys: 'Ctrl+Shift+B' },
        { id: 'goToEditor', label: 'Go to Editor', keys: 'Alt+Shift+E' },
      ]),
    );

    const { useSettingsStore } = await import('./settings');
    const shortcuts = useSettingsStore.getState().userShortcuts;

    expect(storage.get(FLAG)).toBe('1');
    expect(shortcuts.find((s) => s.id === 'transcribeToTerminal')?.keys).toBe('Ctrl+Shift+M');
    expect(shortcuts.find((s) => s.id === 'cycleAmbientLayout')?.keys).toBe('Alt+Shift+L');
    expect(shortcuts.find((s) => s.id === 'goToDb')?.keys).toBe('Ctrl+Shift+D');
    expect(shortcuts.find((s) => s.id === 'toggleRightSidebar')?.keys).toBe('Ctrl+Shift+B');
    // Custom rebind on goToEditor is preserved
    expect(shortcuts.find((s) => s.id === 'goToEditor')?.keys).toBe('Alt+Shift+E');
    // Retired ids are gone
    expect(shortcuts.some((s) => s.id === 'launchVoiceMode')).toBe(false);
    expect(shortcuts.some((s) => s.id === 'toggleProjectHUD')).toBe(false);
    expect(shortcuts.some((s) => s.id === 'startProxy')).toBe(false);
    expect(shortcuts.some((s) => s.id === 'stopProxy')).toBe(false);
  });

  it('preserves a user-chosen dictation key if already customized before migration', async () => {
    const storage = stubWebStorage();
    storage.set(
      KEY,
      JSON.stringify([
        { id: 'transcribeToTerminal', label: 'Transcribe (speech to text)', keys: 'Alt+Shift+D' },
      ]),
    );

    const { useSettingsStore } = await import('./settings');
    expect(useSettingsStore.getState().userShortcuts.find((s) => s.id === 'transcribeToTerminal')?.keys).toBe('Alt+Shift+D');
  });
});
