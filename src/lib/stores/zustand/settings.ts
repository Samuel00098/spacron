import { create } from 'zustand';
import type { McpServer } from '$lib/services/mcp-servers';
import { DEFAULT_MEDIA_GENERATION, type MediaGenerationSettings } from '$lib/services/media-generation';

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
export type VoiceInputProviderId = 'webspeech' | 'google' | 'openai' | 'openrouter' | 'vercel' | 'ollama' | 'lmstudio' | 'local';
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

// Built-in shortcut ids whose actions have been deleted. Listed so a persisted
// `userShortcuts` from an older build can be cleaned up rather than carrying
// them forever — see the prune in `mergeDefaultShortcuts`.
const RETIRED_SHORTCUT_IDS = new Set([
  'canvasZoomIn',
  'canvasZoomOut',
  'canvasResetZoom',
  'goToOrchestrator',
  'goToYoutube',
  'openDailyNote',
  'toggleSketch',
]);

function mergeDefaultShortcuts(initial: KeyboardShortcut[]): KeyboardShortcut[] {
  // Inlined defaultShortcuts to avoid circular import
  const defaultShortcuts: KeyboardShortcut[] = [
    { id: 'commandPalette', label: 'Command Palette', keys: 'Ctrl+Shift+P' },
    { id: 'openSettings', label: 'Open Settings', keys: 'Ctrl+,' },
    { id: 'toggleProjectHUD', label: 'Toggle Projects Sidebar', keys: 'Ctrl+K' },
    { id: 'toggleSidebar', label: 'Toggle Sidebar', keys: 'Ctrl+B' },
    { id: 'toggleInteractionMode', label: 'Switch Code / Chat Mode', keys: 'Ctrl+Shift+J' },
    { id: 'newWorkspace', label: 'Create Project', keys: 'Ctrl+N' },
    { id: 'goToTerminal', label: 'Go to Terminal', keys: 'Ctrl+`' },
    { id: 'goToEditor', label: 'Go to Editor', keys: 'Ctrl+E' },
    { id: 'goToPreview', label: 'Go to Preview', keys: 'Ctrl+Shift+V' },
    // goToOrchestrator removed
    { id: 'goToReview', label: 'Go to Code Review', keys: 'Ctrl+Shift+R' },
    { id: 'goToHttp', label: 'Go to HTTP Client', keys: 'Ctrl+Shift+H' },
    { id: 'goToTasks', label: 'Go to Tasks', keys: 'Ctrl+Shift+T' },
    { id: 'goToFleet', label: 'Go to Agent Fleet', keys: 'Ctrl+Shift+G' },
    { id: 'goToDb', label: 'Go to Database Explorer', keys: 'Ctrl+Shift+B' },
    { id: 'goToContainers', label: 'Go to Containers', keys: 'Ctrl+Shift+C' },
    { id: 'goToToolbox', label: 'Go to Dev Toolbox', keys: 'Ctrl+Shift+X' },
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
    { id: 'spawnAgent', label: 'Spawn Agents', keys: 'Ctrl+Shift+A' },
    // openDailyNote removed
    // toggleSketch removed
    { id: 'launchVoiceMode', label: 'Launch Voice Mode', keys: 'Ctrl+Shift+M' },
    { id: 'transcribeToTerminal', label: 'Transcribe (speech to text)', keys: 'F9' },
    // canvasZoomIn / canvasZoomOut / canvasResetZoom removed — the Canvas view
    // they drove no longer exists, so they were unbound keys occupying Alt+=,
    // Alt+- and Alt+0 while rendering a "Canvas" group in the shortcut map.
    { id: 'cycleAmbientLayout', label: 'Cycle Ambient Layout', keys: 'Ctrl+Alt+A' },
  ];
  if (!Array.isArray(initial)) return defaultShortcuts;
  // Prune before merging. This function is otherwise additive-only, so a binding
  // whose action has been deleted survives in every existing install forever —
  // still listed in the Settings shortcut map, still holding its keys hostage,
  // and doing nothing when pressed. Dropping an id here retires it for real.
  const merged = initial.filter((item) => item && !RETIRED_SHORTCUT_IDS.has(item.id));
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

  // The STT -> brain -> TTS 'pipeline' engine is gone; it silently routed to
  // OpenAI Realtime anyway, so make that explicit rather than leaving a value
  // no branch handles.
  if (persistentValue<string>('voiceConversationEngine', '') === 'pipeline') {
    persistValue('voiceConversationEngine', 'openai-realtime');
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
    // Vercel AI Gateway realtime voice picks (stores/settings.ts). Declared so
    // they survive a restart.
    vercelRealtimeModel: persistentValue('vercelRealtimeModel', 'openai/gpt-realtime-2'),
    vercelRealtimeVoice: persistentValue('vercelRealtimeVoice', ''),
    // Hands-free voice engine and its per-engine model/voice picks
    // (stores/settings.ts). Undeclared, they reset on every launch. The engine
    // union is inlined to keep this store leaf-level; keep it and every default
    // in step with stores/settings.ts.
    voiceConversationEngine: persistentValue<'openai-realtime' | 'xai-realtime' | 'openai-live' | 'vercel-realtime'>('voiceConversationEngine', 'openai-realtime'),
    openaiRealtimeModel: persistentValue('openaiRealtimeModel', 'gpt-realtime-2.1-mini'),
    openaiRealtimeVoice: persistentValue('openaiRealtimeVoice', 'marin'),
    openaiRealtimeConnection: persistentValue('openaiRealtimeConnection', 'openai'),
    jevProvider: persistentValue('jevProvider', 'typesafe'),
    jevModel: persistentValue('jevModel', ''),
    openaiLiveModel: persistentValue('openaiLiveModel', 'gpt-live-1'),
    openaiLiveVoice: persistentValue('openaiLiveVoice', 'marin'),
    xaiRealtimeModel: persistentValue('xaiRealtimeModel', 'grok-voice-latest'),
    xaiRealtimeVoice: persistentValue('xaiRealtimeVoice', 'eve'),
    announceAgentCompletions: persistentValue('announceAgentCompletions', true),
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
    backgroundImageEnabled: persistentValue('backgroundImageEnabled', false),
    backgroundImageOpacity: persistentValue('backgroundImageOpacity', 100),
    backgroundImageBlur: persistentValue('backgroundImageBlur', 0),
    terminalShell: persistentValue('terminalShell', ''),
    terminalCursorStyle: persistentValue<'bar' | 'block' | 'underline'>('terminalCursorStyle', 'bar'),
    terminalScrollback: persistentValue('terminalScrollback', 5000),
    terminalFontSize: persistentValue('terminalFontSize', 14),
    // See the note on `terminalRenderer` in stores/settings.ts for why canvas.
    terminalRenderer: persistentValue<'webgl' | 'canvas' | 'dom'>('terminalRenderer', 'canvas'),
    showSnapshotsTab: persistentValue('showSnapshotsTab', false),
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
    // Computer use (stores/settings.ts): same trap as above. Undeclared, the
    // switch and the blocked-apps list reset on every launch.
    computerUse: persistentValue('computerUse', false),
    computerUseBlockedApps: persistentValue<string[]>('computerUseBlockedApps', []),
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
  vercelRealtimeModel: 'openai/gpt-realtime-2',
  vercelRealtimeVoice: '',
  voiceConversationEngine: 'openai-realtime',
  openaiRealtimeModel: 'gpt-realtime-2.1-mini',
  openaiRealtimeVoice: 'marin',
  openaiRealtimeConnection: 'openai',
  jevProvider: 'typesafe',
  jevModel: '',
  openaiLiveModel: 'gpt-live-1',
  openaiLiveVoice: 'marin',
  xaiRealtimeModel: 'grok-voice-latest',
  xaiRealtimeVoice: 'eve',
  announceAgentCompletions: true,
  orchestratorDisabledSkills: [],
  orchestratorCustomSkills: [],
  uiZoom: 100,
  uiFontSize: 14,
  swipeNavigationEnabled: true,
  formatOnSave: true,
  autoSave: true,
  userShortcuts: [
    { id: 'commandPalette', label: 'Command Palette', keys: 'Ctrl+Shift+P' },
    { id: 'openSettings', label: 'Open Settings', keys: 'Ctrl+,' },
    { id: 'toggleProjectHUD', label: 'Toggle Projects Sidebar', keys: 'Ctrl+K' },
    { id: 'toggleSidebar', label: 'Toggle Sidebar', keys: 'Ctrl+B' },
    { id: 'toggleInteractionMode', label: 'Switch Code / Chat Mode', keys: 'Ctrl+Shift+J' },
    { id: 'newWorkspace', label: 'Create Project', keys: 'Ctrl+N' },
    { id: 'goToTerminal', label: 'Go to Terminal', keys: 'Ctrl+`' },
    { id: 'goToEditor', label: 'Go to Editor', keys: 'Ctrl+E' },
    { id: 'goToPreview', label: 'Go to Preview', keys: 'Ctrl+Shift+V' },
    // goToOrchestrator removed
    { id: 'goToReview', label: 'Go to Code Review', keys: 'Ctrl+Shift+R' },
    { id: 'goToHttp', label: 'Go to HTTP Client', keys: 'Ctrl+Shift+H' },
    { id: 'goToTasks', label: 'Go to Tasks', keys: 'Ctrl+Shift+T' },
    { id: 'goToFleet', label: 'Go to Agent Fleet', keys: 'Ctrl+Shift+G' },
    { id: 'goToDb', label: 'Go to Database Explorer', keys: 'Ctrl+Shift+B' },
    { id: 'goToContainers', label: 'Go to Containers', keys: 'Ctrl+Shift+C' },
    { id: 'goToToolbox', label: 'Go to Dev Toolbox', keys: 'Ctrl+Shift+X' },
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
    { id: 'spawnAgent', label: 'Spawn Agents', keys: 'Ctrl+Shift+A' },
    // openDailyNote removed
    // toggleSketch removed
    { id: 'launchVoiceMode', label: 'Launch Voice Mode', keys: 'Ctrl+Shift+M' },
    { id: 'transcribeToTerminal', label: 'Transcribe (speech to text)', keys: 'F9' },
    // canvasZoomIn / canvasZoomOut / canvasResetZoom removed — the Canvas view
    // they drove no longer exists, so they were unbound keys occupying Alt+=,
    // Alt+- and Alt+0 while rendering a "Canvas" group in the shortcut map.
    { id: 'cycleAmbientLayout', label: 'Cycle Ambient Layout', keys: 'Ctrl+Alt+A' },
  ],
  appearance: 'system',
  accentColor: '',
  interfaceTransparency: 0,
  backgroundImageEnabled: false,
  backgroundImageOpacity: 100,
  backgroundImageBlur: 0,
  terminalShell: '',
  terminalCursorStyle: 'bar',
  terminalScrollback: 5000,
  terminalFontSize: 14,
  terminalRenderer: 'canvas',
  showSnapshotsTab: false,
  agentPermissionMode: 'yolo',
  agentCmdOverrides: {},
  agentDefaultArgs: {},
  agentDefaultEnv: {},
  agentWorktrees: true,
  autoStageAgentChanges: false,
  agentBrowserTools: false,
  computerUse: false,
  computerUseBlockedApps: [],
  agentFailover: true,
  agentFailoverHeadroomPercent: 4,
  agentFailoverCrossProvider: true,
  mcpServers: [],
  mediaGeneration: DEFAULT_MEDIA_GENERATION,
  keepSystemAwake: false,
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
      vercelRealtimeModel: 'vercelRealtimeModel',
      vercelRealtimeVoice: 'vercelRealtimeVoice',
      voiceConversationEngine: 'voiceConversationEngine',
      openaiRealtimeModel: 'openaiRealtimeModel',
      openaiRealtimeVoice: 'openaiRealtimeVoice',
      openaiRealtimeConnection: 'openaiRealtimeConnection',
      jevProvider: 'jevProvider',
      jevModel: 'jevModel',
      openaiLiveModel: 'openaiLiveModel',
      openaiLiveVoice: 'openaiLiveVoice',
      xaiRealtimeModel: 'xaiRealtimeModel',
      xaiRealtimeVoice: 'xaiRealtimeVoice',
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
      agentPermissionMode: 'agentPermissionMode',
      agentCmdOverrides: 'agentCmdOverrides',
      agentDefaultArgs: 'agentDefaultArgs',
      agentDefaultEnv: 'agentDefaultEnv',
      agentWorktrees: 'agentWorktrees',
      autoStageAgentChanges: 'autoStageAgentChanges',
      agentBrowserTools: 'agentBrowserTools',
      computerUse: 'computerUse',
      computerUseBlockedApps: 'computerUseBlockedApps',
      agentFailover: 'agentFailover',
      agentFailoverHeadroomPercent: 'agentFailoverHeadroomPercent',
      agentFailoverCrossProvider: 'agentFailoverCrossProvider',
      mcpServers: 'mcpServers',
      mediaGeneration: 'mediaGeneration',
      keepSystemAwake: 'keepSystemAwake',
    };
    const stateKey = setters[key];
    if (stateKey) {
      const s = getState();
      (s as any).__set(stateKey, value);
    }
  },
}));
