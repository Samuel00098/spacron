import { create } from 'zustand';
import { getAppFlag, setAppFlag } from '$lib/services/app-flags';

export type CloseBehavior = 'quit' | 'minimize';
export type AiProviderId =
  | 'openrouter'
  | 'anthropic'
  | 'openai'
  | 'google'
  | 'groq'
  | 'xai'
  | 'ollama'
  | 'lmstudio';
export type VoiceInputProviderId = 'webspeech' | 'google' | 'openai' | 'openrouter' | 'ollama' | 'lmstudio' | 'local';
export interface KeyboardShortcut {
  id: string;
  label: string;
  keys: string;
  action?: string; // For custom shortcuts: id of the app action (see shortcutActions) this key triggers
}

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

function mergeDefaultShortcuts(initial: KeyboardShortcut[]): KeyboardShortcut[] {
  // Inlined defaultShortcuts to avoid circular import
  const defaultShortcuts: KeyboardShortcut[] = [
    { id: 'commandPalette', label: 'Command Palette', keys: 'Ctrl+Shift+P' },
    { id: 'openSettings', label: 'Open Settings', keys: 'Ctrl+,' },
    { id: 'toggleProjectHUD', label: 'Toggle Project Launcher HUD', keys: 'Ctrl+K' },
    { id: 'toggleSidebar', label: 'Toggle Sidebar', keys: 'Ctrl+B' },
    { id: 'newWorkspace', label: 'New Workspace', keys: 'Ctrl+N' },
    { id: 'goToTerminal', label: 'Go to Terminal', keys: 'Ctrl+`' },
    { id: 'goToEditor', label: 'Go to Editor', keys: 'Ctrl+E' },
    { id: 'goToPreview', label: 'Go to Preview', keys: 'Ctrl+Shift+V' },
    // goToOrchestrator removed
    { id: 'goToReview', label: 'Go to Code Review', keys: 'Ctrl+Shift+R' },
    { id: 'goToHttp', label: 'Go to HTTP Client', keys: 'Ctrl+Shift+H' },
    { id: 'goToTasks', label: 'Go to Tasks', keys: 'Ctrl+Shift+T' },
    { id: 'goToFleet', label: 'Go to Agent Changes', keys: 'Ctrl+Shift+G' },
    { id: 'goToDb', label: 'Go to Database Explorer', keys: 'Ctrl+Shift+B' },
    { id: 'goToContainers', label: 'Go to Containers', keys: 'Ctrl+Shift+C' },
    { id: 'goToToolbox', label: 'Go to Dev Toolbox', keys: 'Ctrl+Shift+X' },
    { id: 'goToYoutube', label: 'Go to YouTube', keys: 'Ctrl+Shift+Y' },
    { id: 'openSearch', label: 'Search in Files', keys: 'Ctrl+Shift+F' },
    { id: 'openEnvManager', label: 'Environment Manager', keys: 'Ctrl+Shift+E' },
    { id: 'saveFile', label: 'Save File', keys: 'Ctrl+S' },
    { id: 'openFolder', label: 'Open Folder', keys: 'Ctrl+O' },
    { id: 'newTerminal', label: 'New Terminal Tab', keys: 'Ctrl+Shift+`' },
    { id: 'formatDocument', label: 'Format Document', keys: 'Alt+Shift+F' },
    { id: 'startProxy', label: 'Start Preview Proxy', keys: 'Ctrl+Alt+P' },
    { id: 'stopProxy', label: 'Stop Preview Proxy', keys: 'Ctrl+Alt+O' },
    { id: 'zoomIn', label: 'Zoom In', keys: 'Ctrl+=' },
    { id: 'zoomOut', label: 'Zoom Out', keys: 'Ctrl+-' },
    { id: 'resetZoom', label: 'Reset Zoom', keys: 'Ctrl+0' },
    { id: 'quickCapture', label: 'Quick Capture', keys: 'Ctrl+Shift+Space' },
    { id: 'spawnAgent', label: 'Spawn Agents', keys: 'Ctrl+Shift+A' },
    // openDailyNote removed
    // toggleSketch removed
    { id: 'launchVoiceMode', label: 'Launch Voice Mode', keys: 'Ctrl+Shift+M' },
    { id: 'canvasZoomIn', label: 'Canvas Zoom In', keys: 'Alt+=' },
    { id: 'canvasZoomOut', label: 'Canvas Zoom Out', keys: 'Alt+-' },
    { id: 'canvasResetZoom', label: 'Canvas Reset Zoom', keys: 'Alt+0' },
    { id: 'cycleAmbientLayout', label: 'Cycle Ambient Layout', keys: 'Ctrl+Alt+A' },
  ];
  if (!Array.isArray(initial)) return defaultShortcuts;
  const merged = [...initial];
  for (const def of defaultShortcuts) {
    if (!merged.some((item) => item && item.id === def.id)) {
      merged.push(def);
    }
  }
  return merged;
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

  // Seed the reply provider from the main AI provider if not yet set.
  if (persistentValue('voiceReplyProvider', '') === '') {
    const existing = localStorage.getItem('forge_setting_aiProvider');
    if (existing) {
      try {
        const p = JSON.parse(existing);
        if (typeof p === 'string' && p) persistValue('voiceReplyProvider', p);
      } catch {}
    }
  }

  if (persistentValue('voiceConversationAiModelByProvider', null) === null) {
    const legacyMap = localStorage.getItem('forge_setting_aiModelByProvider');
    if (legacyMap) {
      try {
        const m = JSON.parse(legacyMap);
        if (m && typeof m === 'object' && !Array.isArray(m)) persistValue('voiceConversationAiModelByProvider', m);
      } catch {}
    }
  }

  const legacyTts = localStorage.getItem('forge_setting_ttsVoice');
  if (legacyTts) {
    try {
      const voice = JSON.parse(legacyTts);
      if (!localStorage.getItem('forge_setting_voiceConversationTtsVoiceByProvider')) {
        const next = voice === 'Arista-PlayAI' ? 'austin' : voice;
        if (typeof next === 'string' && next) persistValue('voiceConversationTtsVoiceByProvider', { groq: next });
      }
      if (voice === 'Arista-PlayAI') persistValue('ttsVoice', 'austin');
    } catch {}
  }

  const ttsModelMap = persistentValue('voiceConversationTtsModelByProvider', {}) as Record<string, string>;
  if (ttsModelMap.google === 'gemini-3.1-flash-tts-preview') {
    persistValue('voiceConversationTtsModelByProvider', { ...ttsModelMap, google: 'gemini-2.5-flash-preview-tts' });
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
    aiProvider: persistentValue<AiProviderId>('aiProvider', 'openrouter'),
    aiModelByProvider: persistentValue<Record<string, string>>('aiModelByProvider', {}),
    aiBaseUrlByProvider: persistentValue<Record<string, string>>('aiBaseUrlByProvider', {}),
    aiGhostTextEnabled: persistentValue('aiGhostTextEnabled', false),
    aiCompletionProvider: persistentValue<AiProviderId>('aiCompletionProvider', 'groq'),
    aiCompletionModelByProvider: persistentValue<Record<string, string>>('aiCompletionModelByProvider', {}),
    voiceRefinementEnabled: persistentValue('voiceRefinementEnabled', false),
    voiceInputProvider: persistentValue<VoiceInputProviderId>('voiceInputProvider', 'local'),
    voiceInputModelByProvider: persistentValue<Record<string, string>>('voiceInputModelByProvider', {}),
    voiceAiProvider: persistentValue<AiProviderId>('voiceAiProvider', 'groq'),
    voiceAiModelByProvider: persistentValue<Record<string, string>>('voiceAiModelByProvider', {}),
    voiceConversationAiModelByProvider: persistentValue<Record<string, string>>('voiceConversationAiModelByProvider', {}),
    voiceConversationTtsModelByProvider: persistentValue<Record<string, string>>('voiceConversationTtsModelByProvider', {}),
    voiceConversationTtsVoiceByProvider: persistentValue<Record<string, string>>('voiceConversationTtsVoiceByProvider', {}),
    voiceReplyProvider: persistentValue<AiProviderId>('voiceReplyProvider', 'openrouter'),
    ttsVoice: persistentValue('ttsVoice', 'austin'),
    announceAgentCompletions: persistentValue('announceAgentCompletions', true),
    uiZoom: persistentValue('uiZoom', 100),
    swipeNavigationEnabled: persistentValue('swipeNavigationEnabled', true),
    formatOnSave: persistentValue('formatOnSave', true),
    userShortcuts: initialUserShortcuts,
    appearance: persistentValue<'system' | 'light' | 'dark'>('appearance', 'system'),
    interfaceTransparency: persistentValue('interfaceTransparency', 0),
    backgroundImageEnabled: persistentValue('backgroundImageEnabled', false),
    backgroundImageOpacity: persistentValue('backgroundImageOpacity', 100),
    backgroundImageBlur: persistentValue('backgroundImageBlur', 0),
    onboardingCompleted: persistentValue('onboardingCompleted', false),
    terminalShell: persistentValue('terminalShell', ''),
    terminalCursorStyle: persistentValue<'bar' | 'block' | 'underline'>('terminalCursorStyle', 'bar'),
    terminalScrollback: persistentValue('terminalScrollback', 5000),
    terminalFontSize: persistentValue('terminalFontSize', 14),
    // See the note on `terminalRenderer` in stores/settings.ts for why canvas.
    terminalRenderer: persistentValue<'webgl' | 'canvas' | 'dom'>('terminalRenderer', 'canvas'),
    showSnapshotsTab: persistentValue('showSnapshotsTab', false),
  };
}

type SettingsValues = ReturnType<typeof createSettingsState>;

interface SettingsActions {
  __set: <K extends keyof SettingsValues>(key: K, value: SettingsValues[K]) => void;
  resetSettingsToDefault: () => void;
  updateSetting: (key: string, value: unknown) => void;
  markOnboardingCompleted: () => void;
  markOnboardingIncomplete: () => void;
}

export type SettingsState = SettingsValues & SettingsActions;

const ONBOARDING_FLAG = 'onboardingCompleted';

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
  aiProvider: 'openrouter',
  aiModelByProvider: {},
  aiBaseUrlByProvider: {},
  aiGhostTextEnabled: false,
  aiCompletionProvider: 'groq',
  aiCompletionModelByProvider: {},
  voiceRefinementEnabled: false,
  voiceInputProvider: 'local',
  voiceInputModelByProvider: {},
  voiceAiProvider: 'groq',
  voiceAiModelByProvider: {},
  voiceConversationAiModelByProvider: {},
  voiceConversationTtsModelByProvider: {},
  voiceConversationTtsVoiceByProvider: {},
  voiceReplyProvider: 'groq',
  ttsVoice: 'austin',
  announceAgentCompletions: true,
  uiZoom: 100,
  swipeNavigationEnabled: true,
  formatOnSave: true,
  userShortcuts: [
    { id: 'commandPalette', label: 'Command Palette', keys: 'Ctrl+Shift+P' },
    { id: 'openSettings', label: 'Open Settings', keys: 'Ctrl+,' },
    { id: 'toggleProjectHUD', label: 'Toggle Project Launcher HUD', keys: 'Ctrl+K' },
    { id: 'toggleSidebar', label: 'Toggle Sidebar', keys: 'Ctrl+B' },
    { id: 'newWorkspace', label: 'New Workspace', keys: 'Ctrl+N' },
    { id: 'goToTerminal', label: 'Go to Terminal', keys: 'Ctrl+`' },
    { id: 'goToEditor', label: 'Go to Editor', keys: 'Ctrl+E' },
    { id: 'goToPreview', label: 'Go to Preview', keys: 'Ctrl+Shift+V' },
    // goToOrchestrator removed
    { id: 'goToReview', label: 'Go to Code Review', keys: 'Ctrl+Shift+R' },
    { id: 'goToHttp', label: 'Go to HTTP Client', keys: 'Ctrl+Shift+H' },
    { id: 'goToTasks', label: 'Go to Tasks', keys: 'Ctrl+Shift+T' },
    { id: 'goToFleet', label: 'Go to Agent Changes', keys: 'Ctrl+Shift+G' },
    { id: 'goToDb', label: 'Go to Database Explorer', keys: 'Ctrl+Shift+B' },
    { id: 'goToContainers', label: 'Go to Containers', keys: 'Ctrl+Shift+C' },
    { id: 'goToToolbox', label: 'Go to Dev Toolbox', keys: 'Ctrl+Shift+X' },
    { id: 'goToYoutube', label: 'Go to YouTube', keys: 'Ctrl+Shift+Y' },
    { id: 'openSearch', label: 'Search in Files', keys: 'Ctrl+Shift+F' },
    { id: 'openEnvManager', label: 'Environment Manager', keys: 'Ctrl+Shift+E' },
    { id: 'saveFile', label: 'Save File', keys: 'Ctrl+S' },
    { id: 'openFolder', label: 'Open Folder', keys: 'Ctrl+O' },
    { id: 'newTerminal', label: 'New Terminal Tab', keys: 'Ctrl+Shift+`' },
    { id: 'formatDocument', label: 'Format Document', keys: 'Alt+Shift+F' },
    { id: 'startProxy', label: 'Start Preview Proxy', keys: 'Ctrl+Alt+P' },
    { id: 'stopProxy', label: 'Stop Preview Proxy', keys: 'Ctrl+Alt+O' },
    { id: 'zoomIn', label: 'Zoom In', keys: 'Ctrl+=' },
    { id: 'zoomOut', label: 'Zoom Out', keys: 'Ctrl+-' },
    { id: 'resetZoom', label: 'Reset Zoom', keys: 'Ctrl+0' },
    { id: 'quickCapture', label: 'Quick Capture', keys: 'Ctrl+Shift+Space' },
    { id: 'spawnAgent', label: 'Spawn Agents', keys: 'Ctrl+Shift+A' },
    // openDailyNote removed
    // toggleSketch removed
    { id: 'launchVoiceMode', label: 'Launch Voice Mode', keys: 'Ctrl+Shift+M' },
    { id: 'canvasZoomIn', label: 'Canvas Zoom In', keys: 'Alt+=' },
    { id: 'canvasZoomOut', label: 'Canvas Zoom Out', keys: 'Alt+-' },
    { id: 'canvasResetZoom', label: 'Canvas Reset Zoom', keys: 'Alt+0' },
    { id: 'cycleAmbientLayout', label: 'Cycle Ambient Layout', keys: 'Ctrl+Alt+A' },
  ],
  appearance: 'system',
  interfaceTransparency: 0,
  backgroundImageEnabled: false,
  backgroundImageOpacity: 100,
  backgroundImageBlur: 0,
  onboardingCompleted: false,
  terminalShell: '',
  terminalCursorStyle: 'bar',
  terminalScrollback: 5000,
  terminalFontSize: 14,
  terminalRenderer: 'canvas',
  showSnapshotsTab: false,
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
    setAppFlag(ONBOARDING_FLAG, 'false');
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
      voiceInputProvider: 'voiceInputProvider',
      voiceInputModelByProvider: 'voiceInputModelByProvider',
      voiceAiProvider: 'voiceAiProvider',
      voiceAiModelByProvider: 'voiceAiModelByProvider',
      voiceConversationAiModelByProvider: 'voiceConversationAiModelByProvider',
      voiceConversationTtsModelByProvider: 'voiceConversationTtsModelByProvider',
      voiceConversationTtsVoiceByProvider: 'voiceConversationTtsVoiceByProvider',
      voiceReplyProvider: 'voiceReplyProvider',
      announceAgentCompletions: 'announceAgentCompletions',
      aiProvider: 'aiProvider',
      aiModelByProvider: 'aiModelByProvider',
      aiBaseUrlByProvider: 'aiBaseUrlByProvider',
      uiZoom: 'uiZoom',
      swipeNavigationEnabled: 'swipeNavigationEnabled',
      formatOnSave: 'formatOnSave',
      closeBehavior: 'closeBehavior',
      appearance: 'appearance',
      onboardingCompleted: 'onboardingCompleted',
      terminalShell: 'terminalShell',
      terminalFontSize: 'terminalFontSize',
      terminalRenderer: 'terminalRenderer',
      showSnapshotsTab: 'showSnapshotsTab',
    };
    const stateKey = setters[key];
    if (stateKey) {
      const s = getState();
      (s as any).__set(stateKey, value);
    }
  },

  markOnboardingCompleted: () => {
    set({ onboardingCompleted: true });
    persistValue('onboardingCompleted', true);
    setAppFlag(ONBOARDING_FLAG, 'true');
  },

  markOnboardingIncomplete: () => {
    set({ onboardingCompleted: false });
    persistValue('onboardingCompleted', false);
    setAppFlag(ONBOARDING_FLAG, 'false');
  },
}));
