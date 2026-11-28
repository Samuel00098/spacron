import { create } from 'zustand';
import type { McpServer } from '$lib/services/mcp-servers';
import type { ChatAccessMode } from '$lib/types/chat';
import { DEFAULT_MEDIA_GENERATION, type MediaGenerationSettings } from '$lib/services/media-generation';
import {
  RETIRED_SHORTCUT_IDS,
  defaultShortcuts,
  mergeDefaultShortcuts,
  type KeyboardShortcut,
} from '../shortcuts';

export type { KeyboardShortcut };

export type CloseBehavior = 'quit' | 'minimize';
export type AiProviderId =
  | 'openrouter'
  | 'anthropic'
  | 'openai'
  | 'google'
  | 'groq'
  | 'xai'
  | 'kilocode'
  | 'vercel'
  | 'chatgpt'
  | 'ollama'
  | 'lmstudio';
export type VoiceInputProviderId = 'webspeech' | 'google' | 'openai' | 'openrouter' | 'vercel' | 'fish' | 'ollama' | 'lmstudio' | 'local';

const FONT_FALLBACK = "'JetBrains Mono', 'Fira Code', 'Cascadia Code', 'Ubuntu Mono', 'Noto Mono', Consolas, monospace";

function persistentValue<T>(key: string, defaultValue: T): T {
  if (typeof window === 'undefined') return defaultValue;
  try {
    const stored = localStorage.getItem(`forge_setting_${key}`);
    return stored !== null ? JSON.parse(stored) : defaultValue;
  } catch {
    return defaultValue;
  }
}

function persistValue(key: string, value: unknown) {
  try {
    localStorage.setItem(`forge_setting_${key}`, JSON.stringify(value));
  } catch {}
}

function migrateLegacySettings() {
  if (typeof localStorage === 'undefined') return;
  const legacy = localStorage.getItem('forge_setting_voiceRefinementModel');
  if (legacy) {
    try {
      const model = JSON.parse(legacy);
      if (typeof model === 'string' && model) {
        persistValue('voiceAiModelByProvider', { openrouter: model });
      }
    } catch {}
    localStorage.removeItem('forge_setting_voiceRefinementModel');
  }

  // Move webgl users to canvas once. WebGL has unreliable font-glyph atlas
  // invalidation after a font-family change, and — the reason this migration
  // exists — a page only gets 16 WebGL contexts before the oldest are evicted,
  // which a workspace full of never-unmounting panes will exceed.
  //
  // Deliberately does NOT touch a stored 'dom'. The previous version of this
  // migration swept dom → canvas as well, which silently overrode a choice the
  // user had made explicitly in Settings; DOM is the escape hatch for anyone
  // whose machine renders GPU text badly, so it has to stick. Users who never
  // chose anything have no stored key and simply take the canvas default.
  if (!localStorage.getItem('forge_terminalRendererMigrated')) {
    if (localStorage.getItem('forge_setting_terminalRenderer') === JSON.stringify('webgl')) {
      persistValue('terminalRenderer', 'canvas');
    }
    localStorage.setItem('forge_terminalRendererMigrated', '1');
  }

  // Ctrl+Alt+M never fired reliably: on Windows Ctrl+Alt IS AltGr, and the
  // chord also reaches xterm, which forwards it to the shell. The default moved
  // to F9 (a bare key nothing else claims). `mergeDefaultShortcuts` is
  // additive-only, so an existing install keeps its persisted binding forever
  // unless it is rewritten here. Guarded, so a later deliberate rebind sticks.
  if (!localStorage.getItem('forge_migration_transcribeF9_v1')) {
    try {
      const raw = localStorage.getItem('forge_setting_userShortcuts');
      if (raw) {
        const list = JSON.parse(raw);
        if (Array.isArray(list)) {
          let changed = false;
          for (const item of list) {
            if (item && item.id === 'transcribeToTerminal' && item.keys === 'Ctrl+Alt+M') {
              item.keys = 'F9';
              item.label = 'Transcribe (speech to text)';
              changed = true;
            }
          }
          if (changed) persistValue('userShortcuts', list);
        }
      }
    } catch {}
    localStorage.setItem('forge_migration_transcribeF9_v1', '1');
  }

  // "Send after transcribing" is opt-in now: auto-send fires a half-heard
  // sentence at a live shell before you can read it. Two things made a plain
  // default change insufficient. The key was never declared in
  // `createSettingsState`, so `persistentWritable`'s boot-time read hit
  // undefined and took its own default every launch — meaning a stored `true`
  // has been inert, and declaring the key (below) would suddenly resurrect it.
  // Clear that stale `true` once so every install lands on off; the guard means
  // a deliberate turn-on afterwards is never touched again.
  if (!localStorage.getItem('forge_migration_transcriptionAutoSendOff_v1')) {
    if (localStorage.getItem('forge_setting_transcriptionAutoSend') === 'true') {
      persistValue('transcriptionAutoSend', false);
    }
    localStorage.setItem('forge_migration_transcriptionAutoSendOff_v1', '1');
  }

  // The ChatGPT plan became the default chat-mode brain after installs had
  // already saved another provider. Move a saved choice onto it once; the
  // guard means a deliberate switch away afterwards is never touched again.
  if (!localStorage.getItem('forge_migration_chatgptDefault_v1')) {
    persistValue('aiProvider', 'chatgpt');
    localStorage.setItem('forge_migration_chatgptDefault_v1', '1');
  }

  // Shortcut audit migration: move defaults off F9 (OEM/Fn hijack on Windows
  // laptops), off Ctrl+Alt+<letter> (AltGr on Windows), and off Ctrl+Shift+B
  // (reassigned to Toggle Right Sidebar), and prune retired shortcuts. Only
  // rewrites bindings still on the old defaults so custom user rebindings stick.
  if (!localStorage.getItem('forge_migration_shortcutsAudit_v1')) {
    try {
      const raw = localStorage.getItem('forge_setting_userShortcuts');
      if (raw) {
        const list = JSON.parse(raw);
        if (Array.isArray(list)) {
          let changed = false;
          const filtered = list.filter((item) => {
            if (!item || typeof item.id !== 'string') {
              changed = true;
              return false;
            }
            if (RETIRED_SHORTCUT_IDS.has(item.id)) {
              changed = true;
              return false;
            }
            if (item.id.startsWith('custom_') && item.action && RETIRED_SHORTCUT_IDS.has(item.action)) {
              changed = true;
              return false;
            }
            return true;
          });
          for (const item of filtered) {
            const keysLower = typeof item.keys === 'string' ? item.keys.trim().toLowerCase() : '';
            if (item.id === 'transcribeToTerminal' && (keysLower === 'f9' || keysLower === 'ctrl+alt+m')) {
              item.keys = 'Ctrl+Shift+M';
              item.label = 'Dictate (speech to text)';
              changed = true;
            } else if (item.id === 'cycleAmbientLayout' && keysLower === 'ctrl+alt+a') {
              item.keys = 'Alt+Shift+L';
              item.label = 'Toggle Split / Focus Layout';
              changed = true;
            } else if (item.id === 'goToDb' && keysLower === 'ctrl+shift+b') {
              item.keys = 'Ctrl+Shift+D';
              changed = true;
            }
          }
          if (changed) persistValue('userShortcuts', filtered);
        }
      }
    } catch {}
    localStorage.setItem('forge_migration_shortcutsAudit_v1', '1');
  }
}

migrateLegacySettings();

const initialUserShortcuts = mergeDefaultShortcuts(persistentValue('userShortcuts', []));

function createSettingsState() {
  return {
    fontSize: persistentValue('fontSize', 14),
    fontFamily: persistentValue('fontFamily', FONT_FALLBACK),
    tabSize: persistentValue('tabSize', 2),
    wordWrap: persistentValue('wordWrap', true),
    minimap: persistentValue('minimap', false),
    vimMode: persistentValue('vimMode', false),
    columnSelection: persistentValue('columnSelection', true),
    enableLsp: persistentValue('enableLsp', true),
    showHidden: persistentValue('showHidden', false),
    notificationsEnabled: persistentValue('notificationsEnabled', true),
    closeBehavior: persistentValue<CloseBehavior>('closeBehavior', 'quit'),
    aiProvider: persistentValue<AiProviderId>('aiProvider', 'chatgpt'),
    aiModelByProvider: persistentValue<Record<string, string>>('aiModelByProvider', {}),
    aiBaseUrlByProvider: persistentValue<Record<string, string>>('aiBaseUrlByProvider', {}),
    aiGhostTextEnabled: persistentValue('aiGhostTextEnabled', false),
    aiCompletionProvider: persistentValue<AiProviderId>('aiCompletionProvider', 'groq'),
    aiCompletionModelByProvider: persistentValue<Record<string, string>>('aiCompletionModelByProvider', {}),
    voiceRefinementEnabled: persistentValue('voiceRefinementEnabled', true),
    dictationVocabulary: persistentValue('dictationVocabulary', ''),
    smartVadEnabled: persistentValue('smartVadEnabled', false),
    voiceInputProvider: persistentValue<VoiceInputProviderId>('voiceInputProvider', 'local'),
    voiceInputModelByProvider: persistentValue<Record<string, string>>('voiceInputModelByProvider', {}),
    voiceAiProvider: persistentValue<AiProviderId>('voiceAiProvider', 'groq'),
    voiceAiModelByProvider: persistentValue<Record<string, string>>('voiceAiModelByProvider', {}),
    // Off by default, and declared HERE on purpose — see the note in
    // stores/settings.ts. Undeclared, the wrapper's boot read hit undefined and
    // the toggle reset every launch, so turning it on could never stick.
    transcriptionAutoSend: persistentValue('transcriptionAutoSend', false),
    jevProvider: persistentValue('jevProvider', 'typesafe'),
    jevAgentTool: persistentValue('jevAgentTool', false),
    announceAgentCompletions: persistentValue('announceAgentCompletions', true),
    speakAgentCompletions: persistentValue('speakAgentCompletions', true),
    // Orchestrator skills (services/orchestrator/skills.ts): built-ins switched
    // off, and the user's own. Shape kept inline so this store stays leaf-level.
    orchestratorDisabledSkills: persistentValue<string[]>('orchestratorDisabledSkills', []),
    orchestratorCustomSkills: persistentValue<Array<{ id: string; title: string; instructions: string; enabled: boolean }>>('orchestratorCustomSkills', []),
    uiZoom: persistentValue('uiZoom', 100),
    uiFontSize: persistentValue('uiFontSize', 14),
    swipeNavigationEnabled: persistentValue('swipeNavigationEnabled', true),
    formatOnSave: persistentValue('formatOnSave', true),
    autoSave: persistentValue('autoSave', true),
    userShortcuts: initialUserShortcuts,
    appearance: persistentValue<'system' | 'light' | 'dark'>('appearance', 'system'),
    accentColor: persistentValue('accentColor', ''),
    interfaceTransparency: persistentValue('interfaceTransparency', 0),
    matchTerminalFont: persistentValue('matchTerminalFont', false),
    backgroundImageEnabled: persistentValue('backgroundImageEnabled', false),
    backgroundImageOpacity: persistentValue('backgroundImageOpacity', 100),
    backgroundImageBlur: persistentValue('backgroundImageBlur', 0),
    backgroundGlassOpacity: persistentValue('backgroundGlassOpacity', 60),
    uiVibrancy: persistentValue('uiVibrancy', 100),
    uiContrast: persistentValue('uiContrast', 100),
    terminalShell: persistentValue('terminalShell', ''),
    terminalCursorStyle: persistentValue<'bar' | 'block' | 'underline'>('terminalCursorStyle', 'bar'),
    terminalScrollback: persistentValue('terminalScrollback', 5000),
    terminalFontSize: persistentValue('terminalFontSize', 14),
    // See the note on `terminalRenderer` in stores/settings.ts for why canvas.
    terminalRenderer: persistentValue<'webgl' | 'canvas' | 'dom'>('terminalRenderer', 'canvas'),
    showSnapshotsTab: persistentValue('showSnapshotsTab', false),
    globalWorkspaceCleanupRule: persistentValue<'merged_unchanged' | 'merged_only' | 'never'>('globalWorkspaceCleanupRule', 'merged_unchanged'),
    // Where a newly opened Preview lands: docked in the right sidebar, or as a
    // room on the stage. Either can be moved to the other from its own header.
    previewPlacement: persistentValue<'sidebar' | 'room'>('previewPlacement', 'sidebar'),
    // Browser & Preview Settings (including Orca Design Mode)
    browserDefaultPort: persistentValue('browserDefaultPort', 3000),
    browserPreferredHost: persistentValue<'localhost' | '127.0.0.1'>('browserPreferredHost', 'localhost'),
    browserThemeMode: persistentValue<'system' | 'light' | 'dark'>('browserThemeMode', 'system'),
    browserOpenLinksIn: persistentValue<'preview' | 'external'>('browserOpenLinksIn', 'preview'),
    browserOpenLinksInBackground: persistentValue('browserOpenLinksInBackground', false),
    browserDesignModeAutoScreenshot: persistentValue('browserDesignModeAutoScreenshot', true),
    browserDesignModeIncludeStyles: persistentValue('browserDesignModeIncludeStyles', true),
    browserDesignModeIncludeHtml: persistentValue('browserDesignModeIncludeHtml', true),
    browserDesignModeMaxHtmlLength: persistentValue('browserDesignModeMaxHtmlLength', 2000),
    browserConsoleAutoOpenOnError: persistentValue('browserConsoleAutoOpenOnError', false),
    browserConsolePreserveLog: persistentValue('browserConsolePreserveLog', false),
    browserDefaultZoom: persistentValue<string>('browserDefaultZoom', 'fit'),
    browserDefaultViewport: persistentValue<string>('browserDefaultViewport', 'desktop'),
    // Agent permissions & launch overrides — see stores/settings.ts and
    // services/agent-permissions.ts for the full picture.
    agentPermissionMode: persistentValue<'yolo' | 'manual'>('agentPermissionMode', 'yolo'),
    agentCmdOverrides: persistentValue<Record<string, string>>('agentCmdOverrides', {}),
    agentDefaultArgs: persistentValue<Record<string, string>>('agentDefaultArgs', {}),
    agentDefaultEnv: persistentValue<Record<string, Record<string, string>>>('agentDefaultEnv', {}),
    // Agent worktree / auto-stage / browser-tools toggles. These live in
    // stores/settings.ts behind `persistentWritable` and were NOT declared here,
    // so that wrapper's boot-time `getState()[key]` read hit undefined and fell
    // back to its own default every launch — toggles survived a session but
    // silently reset on restart. Declaring them is what makes the persisted
    // `forge_setting_*` value (already written by `persistValue` on change)
    // rehydrate at boot. Defaults must stay in step with stores/settings.ts.
    agentWorktrees: persistentValue('agentWorktrees', true),
    autoStageAgentChanges: persistentValue('autoStageAgentChanges', false),
    agentBrowserTools: persistentValue('agentBrowserTools', false),
    agentPreviewBrowser: persistentValue('agentPreviewBrowser', false),
    // Computer use (stores/settings.ts): same trap as above. Undeclared, the
    // switch and the blocked-apps list reset on every launch.
    computerUse: persistentValue('computerUse', false),
    computerUseBlockedApps: persistentValue<string[]>('computerUseBlockedApps', []),
    agentWorkspaceTrustOverrides: persistentValue<Record<string, boolean>>('agentWorkspaceTrustOverrides', {}),
    agentStatusHooksEnabled: persistentValue('agentStatusHooksEnabled', true),
    agentAutoGenerateTitles: persistentValue('agentAutoGenerateTitles', false),
    agentCodexOwnServer: persistentValue('agentCodexOwnServer', true),
    agentWarnCodexSharedServer: persistentValue('agentWarnCodexSharedServer', true),
    // Failover: move unfinished work off an agent that is running out of usage,
    // rather than letting it stop mid-feature. See
    // `services/orchestrator/agent-failover.ts` for the ladder these three feed.
    agentFailover: persistentValue('agentFailover', true),
    agentFailoverHeadroomPercent: persistentValue('agentFailoverHeadroomPercent', 4),
    // A same-CLI account hop spends the user's own plan; a hop to a different
    // CLI may spend money on a different service. On by default, but a setting
    // rather than an assumption, and every hop lands in the activity log.
    agentFailoverCrossProvider: persistentValue('agentFailoverCrossProvider', true),
    mcpServers: persistentValue<McpServer[]>('mcpServers', []),
    // Image/video generation: provider pick and model overrides. See
    // `services/media-generation.ts`; the fallback order lives in Rust.
    mediaGeneration: { ...DEFAULT_MEDIA_GENERATION, ...persistentValue<Partial<MediaGenerationSettings>>('mediaGeneration', {}) },
    // Keep the machine awake while agents are mid-turn — see stores/settings.ts.
    keepSystemAwake: persistentValue('keepSystemAwake', false),
    keepAwakeMode: persistentValue<'off' | 'agent' | 'on'>('keepAwakeMode', 'off'),
    // Which source control provider Spacron uses for clone, push and PR.
    sourceControlProvider: persistentValue<'github' | 'gitlab' | 'bitbucket' | 'other'>('sourceControlProvider', 'github'),
    // Chat mode behavior.
    chatQueueWhileBusy: persistentValue('chatQueueWhileBusy', true),
    chatAutoAnswerInline: persistentValue('chatAutoAnswerInline', false),
    chatDefaultAccessMode: persistentValue<ChatAccessMode>('chatDefaultAccessMode', 'inherit'),
    // Auto-settle idle threads so they drop out of the active list after a
    // quiet period. T3 Code's "Working section" equivalent — settled threads
    // are one click from resumption but stop competing for attention.
    autoSettleEnabled: persistentValue('autoSettleEnabled', true),
    autoSettleIdleMs: persistentValue('autoSettleIdleMs', 5 * 60 * 1000),
  };
}

type SettingsValues = ReturnType<typeof createSettingsState>;

interface SettingsActions {
  __set: <K extends keyof SettingsValues>(key: K, value: SettingsValues[K]) => void;
  resetSettingsToDefault: () => void;
  updateSetting: (key: string, value: unknown) => void;
}

export type SettingsState = SettingsValues & SettingsActions;

const defaults: SettingsValues = {
  fontSize: 14,
  fontFamily: FONT_FALLBACK,
  tabSize: 2,
  wordWrap: true,
  minimap: false,
  vimMode: false,
  columnSelection: true,
  enableLsp: true,
  showHidden: false,
  notificationsEnabled: true,
  closeBehavior: 'quit',
  aiProvider: 'chatgpt',
  aiModelByProvider: {},
  aiBaseUrlByProvider: {},
  aiGhostTextEnabled: false,
  aiCompletionProvider: 'groq',
  aiCompletionModelByProvider: {},
  voiceRefinementEnabled: true,
  dictationVocabulary: '',
  smartVadEnabled: false,
  voiceInputProvider: 'local',
  voiceInputModelByProvider: {},
  voiceAiProvider: 'groq',
  voiceAiModelByProvider: {},
  transcriptionAutoSend: false,
  jevProvider: 'typesafe',
  jevAgentTool: false,
  announceAgentCompletions: true,
  speakAgentCompletions: true,
  orchestratorDisabledSkills: [],
  orchestratorCustomSkills: [],
  uiZoom: 100,
  uiFontSize: 14,
  swipeNavigationEnabled: true,
  formatOnSave: true,
  autoSave: true,
  userShortcuts: defaultShortcuts.map((s) => ({ ...s })),
  appearance: 'system',
  accentColor: '',
  interfaceTransparency: 0,
  matchTerminalFont: false,
  backgroundImageEnabled: false,
  backgroundImageOpacity: 100,
  backgroundImageBlur: 0,
  backgroundGlassOpacity: 60,
  uiVibrancy: 100,
  uiContrast: 100,
  terminalShell: '',
  terminalCursorStyle: 'bar',
  terminalScrollback: 5000,
  terminalFontSize: 14,
  terminalRenderer: 'canvas',
  showSnapshotsTab: false,
  globalWorkspaceCleanupRule: 'merged_unchanged',
  previewPlacement: 'sidebar',
  browserDefaultPort: 3000,
  browserPreferredHost: 'localhost' as const,
  browserThemeMode: 'system' as const,
  browserOpenLinksIn: 'preview' as const,
  browserOpenLinksInBackground: false,
  browserDesignModeAutoScreenshot: true,
  browserDesignModeIncludeStyles: true,
  browserDesignModeIncludeHtml: true,
  browserDesignModeMaxHtmlLength: 2000,
  browserConsoleAutoOpenOnError: false,
  browserConsolePreserveLog: false,
  browserDefaultZoom: 'fit',
  browserDefaultViewport: 'desktop',
  agentPermissionMode: 'yolo',
  agentCmdOverrides: {},
  agentDefaultArgs: {},
  agentDefaultEnv: {},
  agentWorktrees: true,
  autoStageAgentChanges: false,
  agentBrowserTools: false,
  agentPreviewBrowser: false,
  computerUse: false,
  computerUseBlockedApps: [],
  agentWorkspaceTrustOverrides: {},
  agentStatusHooksEnabled: true,
  agentAutoGenerateTitles: false,
  agentCodexOwnServer: true,
  agentWarnCodexSharedServer: true,
  agentFailover: true,
  agentFailoverHeadroomPercent: 4,
  agentFailoverCrossProvider: true,
  mcpServers: [],
  mediaGeneration: DEFAULT_MEDIA_GENERATION,
  keepSystemAwake: false,
  keepAwakeMode: 'off',
  autoSettleEnabled: true,
  autoSettleIdleMs: 5 * 60 * 1000,
  sourceControlProvider: 'github',
  chatQueueWhileBusy: true,
  chatAutoAnswerInline: false,
  chatDefaultAccessMode: 'inherit',
};

export const useSettingsStore = create<SettingsState>((set, getState) => ({
  ...createSettingsState(),

  __set: <K extends keyof SettingsValues>(key: K, value: SettingsValues[K]) => {
    set({ [key]: value });
    persistValue(key as string, value);
  },

  resetSettingsToDefault: () => {
    set(defaults);
    for (const [key, value] of Object.entries(defaults)) {
      persistValue(key, value);
    }
  },

  updateSetting: (key: string, value: unknown) => {
    const setters: Record<string, keyof SettingsValues> = {
      fontSize: 'fontSize',
      fontFamily: 'fontFamily',
      tabSize: 'tabSize',
      wordWrap: 'wordWrap',
      minimap: 'minimap',
      vimMode: 'vimMode',
      columnSelection: 'columnSelection',
      enableLsp: 'enableLsp',
      aiGhostTextEnabled: 'aiGhostTextEnabled',
      aiCompletionProvider: 'aiCompletionProvider',
      aiCompletionModelByProvider: 'aiCompletionModelByProvider',
      showHidden: 'showHidden',
      voiceRefinementEnabled: 'voiceRefinementEnabled',
      dictationVocabulary: 'dictationVocabulary',
      smartVadEnabled: 'smartVadEnabled',
      voiceInputProvider: 'voiceInputProvider',
      voiceInputModelByProvider: 'voiceInputModelByProvider',
      voiceAiProvider: 'voiceAiProvider',
      voiceAiModelByProvider: 'voiceAiModelByProvider',
      transcriptionAutoSend: 'transcriptionAutoSend',
      jevProvider: 'jevProvider',
      jevAgentTool: 'jevAgentTool',
      announceAgentCompletions: 'announceAgentCompletions',
      aiProvider: 'aiProvider',
      aiModelByProvider: 'aiModelByProvider',
      aiBaseUrlByProvider: 'aiBaseUrlByProvider',
      uiZoom: 'uiZoom',
      uiFontSize: 'uiFontSize',
      swipeNavigationEnabled: 'swipeNavigationEnabled',
      formatOnSave: 'formatOnSave',
      autoSave: 'autoSave',
      closeBehavior: 'closeBehavior',
      appearance: 'appearance',
      accentColor: 'accentColor',
      terminalShell: 'terminalShell',
      terminalFontSize: 'terminalFontSize',
      terminalRenderer: 'terminalRenderer',
      showSnapshotsTab: 'showSnapshotsTab',
      globalWorkspaceCleanupRule: 'globalWorkspaceCleanupRule',
      previewPlacement: 'previewPlacement',
      browserDefaultPort: 'browserDefaultPort',
      browserPreferredHost: 'browserPreferredHost',
      browserThemeMode: 'browserThemeMode',
      browserOpenLinksIn: 'browserOpenLinksIn',
      browserOpenLinksInBackground: 'browserOpenLinksInBackground',
      browserDesignModeAutoScreenshot: 'browserDesignModeAutoScreenshot',
      browserDesignModeIncludeStyles: 'browserDesignModeIncludeStyles',
      browserDesignModeIncludeHtml: 'browserDesignModeIncludeHtml',
      browserDesignModeMaxHtmlLength: 'browserDesignModeMaxHtmlLength',
      browserConsoleAutoOpenOnError: 'browserConsoleAutoOpenOnError',
      browserConsolePreserveLog: 'browserConsolePreserveLog',
      browserDefaultZoom: 'browserDefaultZoom',
      browserDefaultViewport: 'browserDefaultViewport',
      agentPermissionMode: 'agentPermissionMode',
      agentCmdOverrides: 'agentCmdOverrides',
      agentDefaultArgs: 'agentDefaultArgs',
      agentDefaultEnv: 'agentDefaultEnv',
      agentWorktrees: 'agentWorktrees',
      autoStageAgentChanges: 'autoStageAgentChanges',
      agentBrowserTools: 'agentBrowserTools',
      agentPreviewBrowser: 'agentPreviewBrowser',
      computerUse: 'computerUse',
      computerUseBlockedApps: 'computerUseBlockedApps',
      agentWorkspaceTrustOverrides: 'agentWorkspaceTrustOverrides',
      agentStatusHooksEnabled: 'agentStatusHooksEnabled',
      agentAutoGenerateTitles: 'agentAutoGenerateTitles',
      agentCodexOwnServer: 'agentCodexOwnServer',
      agentWarnCodexSharedServer: 'agentWarnCodexSharedServer',
      agentFailover: 'agentFailover',
      agentFailoverHeadroomPercent: 'agentFailoverHeadroomPercent',
      agentFailoverCrossProvider: 'agentFailoverCrossProvider',
      mcpServers: 'mcpServers',
      mediaGeneration: 'mediaGeneration',
      keepSystemAwake: 'keepSystemAwake',
      keepAwakeMode: 'keepAwakeMode',
      sourceControlProvider: 'sourceControlProvider',
      chatQueueWhileBusy: 'chatQueueWhileBusy',
      chatAutoAnswerInline: 'chatAutoAnswerInline',
      chatDefaultAccessMode: 'chatDefaultAccessMode',
    };
    const stateKey = setters[key];
    if (stateKey) {
      const s = getState();
      (s as any).__set(stateKey, value);
    }
  },
}));
