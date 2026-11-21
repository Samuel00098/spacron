import { useEffect, useMemo, useRef, useState, useCallback, type CSSProperties } from 'react';
import { createPortal } from 'react-dom';
import { useModalFocus } from '$lib/react/useModalFocus';
import packageJson from '../../../../package.json';
import { invoke } from '@tauri-apps/api/core';
import { customProviders, saveCustomProvider, deleteCustomProvider, type CustomProvider } from '$lib/stores/customProviders';
import { explainError, type ExplainedError } from '$lib/utils/explainError';
import { jevAgentUsage, type JevAgentUsage } from '$lib/stores/jevAgentTool';
import {
  READ_ALOUD_ENGINES, READ_ALOUD_MODELS, OPENAI_READ_ALOUD_VOICES, XAI_READ_ALOUD_VOICES,
  ELEVENLABS_DEFAULT_VOICE, readAloudSettings, readAloudModelFor, readAloudVoiceFor,
  type CloudReadAloudEngine, type ReadAloudEngine, type ReadAloudSettings,
} from '$lib/stores/readAloud';
import { previewReadAloud } from '$lib/services/read-aloud';
import { listen } from '@tauri-apps/api/event';
import {
  aiBaseUrlByProvider,
  aiCompletionModelByProvider,
  aiCompletionProvider,
  aiGhostTextEnabled,
  agentBrowserTools,
  computerUse,
  agentWorkspaceTrustOverrides,
  agentStatusHooksEnabled,
  agentAutoGenerateTitles,
  agentCodexOwnServer,
  agentWarnCodexSharedServer,
  mcpServers,
  aiProvider,
  aiProviders,
  accentColor,
  appearance,
  autoSave,
  agentFailover,
  agentFailoverCrossProvider,
  agentFailoverHeadroomPercent,
  backgroundImageBlur,
  backgroundGlassOpacity,
  uiVibrancy,
  uiContrast,
  backgroundImageEnabled,
  backgroundImageOpacity,
  closeBehavior,
  columnSelection,
  currentVoiceAiModel,
  currentVoiceInputModel,
  defaultShortcuts,
  enableLsp,
  fontFamily,
  fontSize,
  formatOnSave,
  getProviderBaseUrl,
  getProviderDef,
  getVoiceInputModelOptions,
  interfaceTransparency,
  isLocalProvider,
  keepSystemAwake,
  keepAwakeMode,
  minimap,
  notificationsEnabled,
  resetSettingsToDefault,
  shortcutActions,
  setProviderBaseUrl,
  setVoiceAiModel,
  setVoiceInputModel,
  showHidden,
  showSnapshotsTab,
  previewPlacement,
  type PreviewPlacement,
  tabSize,
  terminalCursorStyle,
  terminalFontSize,
  terminalRenderer,
  terminalScrollback,
  terminalShell,
  uiZoom,
  uiFontSize,
  userShortcuts,
  vimMode,
  voiceAiProvider,
  voiceInputProvider,
  voiceInputUsesModelTranscription,
  voiceRefinementEnabled,
  dictationVocabulary,
  smartVadEnabled,
  transcriptionAutoSend,
  announceAgentCompletions,
  speakAgentCompletions,
  autoSettleEnabled,
  autoSettleIdleMs,
  orchestratorCustomSkills,
  orchestratorDisabledSkills,
  jevProvider,
  jevAgentTool,
  wordWrap,
  sourceControlProvider,
  type AiModelOption,
  mediaGeneration,
  type AiProviderId,
  type KeyboardShortcut,
  type VoiceInputProviderId,
} from '$lib/stores/settings';
import {
  formatPairs,
  headersLostOnCodex,
  parseLines,
  parsePairs,
  validateServer,
  type McpServer,
} from '$lib/services/mcp-servers';
import { ADD_CURSOR_GESTURE, COLUMN_SELECT_GESTURE } from '$lib/services/editor/multi-cursor';
import { openChangelogPage } from '$lib/services/changelog';
import { activeProjectId, resetAllApplicationState } from '$lib/stores/workspace';
import { BRAIN_SKILLS, MAX_CUSTOM_SKILL_CHARS, sanitizeCustomSkills, type CustomSkill } from '$lib/services/orchestrator/skills';
import { FIRM_RULE_USES, clearLearnedProfile, globalOrchestratorProfile, orchestratorProfile, removeProfileEntry } from '$lib/services/orchestrator/evolve';
import { clearProviderApiKey, listProviderModels, providerApiKeyExists, saveProviderApiKey } from '$lib/services/ai-keychain';
import { MEDIA_PROVIDERS, type MediaGenerationSettings, type MediaKind, type MediaProviderInfo } from '$lib/services/media-generation';
import { requestNotificationPermission, showToast } from '$lib/stores/notification';
import { ChatGptSignIn } from './ChatGptSignIn';
import { checkForUpdate, installUpdate, pendingUpdate, updateChecking, updateDownloading, updateProgress } from '$lib/stores/updater';
import { get } from '$lib/stores/storeCompat';
import { computerUseSupported } from '$lib/stores/computerUse';
import ComputerUseDetails from './ComputerUseDetails';
import BrowserToolsDetails from './BrowserToolsDetails';
import { McpCatalog } from './McpCatalog';
import { ServerIcon } from './McpPlugins';
import { useStore } from '$lib/react/useStore';
import { isTauriRuntime } from '$lib/utils/tauri';
import { keepAwakeState } from '$lib/services/keep-awake';
import { AgentBrandMark } from './useAgentBrand';
import { ProviderBrandMark } from './providerBrands';
import AgentsPane from '$lib/components/agents/AgentsPane';
import VoiceHistoryPanel from './VoiceHistoryPanel';
import UsageStatsPane from '$lib/components/stats/UsageStatsPane';
import AgentAccountsSection from '$lib/components/shared/AgentAccountsSection';
import {
  customAgents,
  addCustomAgent,
  updateCustomAgent,
  deleteCustomAgent,
  removedPresetAgents,
} from '$lib/stores/customAgents';
import {
  acpRegistryEnabled,
  acpDisabledCommands,
  acpExplicitCommands,
  acpCommandOverrides,
  setAcpCommandEnabled,
  setAcpExplicit,
  setAcpCommandOverride,
} from '$lib/stores/acpRegistry';
import { getAgentRoster } from '$lib/stores/runs';
import { favouriteAgentCommands, toggleFavouriteAgent } from '$lib/stores/agentFavourites';
import { getAntigravityRuntimeStatus, installAntigravityRuntime, type AntigravityRuntimeStatus } from '$lib/services/antigravity-runtime';
import { isNativeAcpCommand } from '$lib/services/acp-capabilities';
import { commandForAcpDistribution, fetchAcpRegistry, type AcpRegistryAgent } from '$lib/services/acp-registry';
import { agentBinaryStatus, agentBinaryInstall, type AgentBinaryStatus } from '$lib/services/agent-binary';
import { activeTheme } from '$lib/stores/theme';
import { chooseBackgroundImage, removeBackgroundImage, backgroundImagePresent } from '$lib/stores/background';
import { getAvailableShells, type ShellInfo } from '$lib/services/pty-bridge';
import {
  detectRulesFileSupport,
  type RulesFileDetection,
} from '$lib/services/orchestrator/agent-rules-file';
import Dropdown, { type DropdownOption } from '$lib/components/shared/Dropdown.tsx';
import ChatSettingsPane from './ChatSettingsPane';
import { useGithubSignIn } from '$lib/react/useGithubSignIn';
import { useSourceControlSignIn } from '$lib/react/useSourceControlSignIn';
import {
  type SourceControlIdentity,
  SOURCE_CONTROL_PROVIDERS,
} from '$lib/services/source-control';
import './SettingsModal.css';

import { useLayoutStore } from '$lib/stores/zustand/layout';
import type { SettingsTab as Tab } from '$lib/types/layout';
import { formatShortcutLabel } from '$lib/utils/shortcut-label';

// App actions a custom shortcut can be bound to. Zoom actions are dispatched
// separately (window zoom in App.tsx, canvas zoom is view-local), so they're
// omitted here — every action listed is handled by AppShell's shortcut switch.
const assignableActions = shortcutActions.filter((a) => !a.id.toLowerCase().includes('zoom'));
const actionOptions: DropdownOption[] = assignableActions.map((a) => ({
  value: a.id,
  label: a.label,
  sublabel: a.category,
}));

type SettingsModalProps = {
  onclose: () => void;
};

/**
 * Settings > Agents > ACP Registry and Managed installs, and the "speaks ACP"
 * checkbox on the add form, are hidden while there is no Chat mode to use ACP agents in.
 * Hidden, not removed: the stored settings still apply, and flipping this
 * brings the section back unchanged.
 */
const SHOW_ACP_REGISTRY_SECTION = false;

/**
 * Settings > Agents > Long-running work (auto-settling idle Chat threads) is
 * hidden for the same reason: there is no Chat mode for it to act on.
 */
const SHOW_CHAT_THREAD_SETTINGS = false;

const tabs: { id: Tab; label: string; kicker: string; description: string }[] = [
  { id: 'general', label: 'General', kicker: 'Editor and app', description: 'Editor behaviour and everyday app preferences.' },
  { id: 'appearance', label: 'Appearance', kicker: 'Window and media', description: 'Visual style.' },
  { id: 'models', label: 'AI Providers', kicker: 'Accounts and keys', description: 'Your agent accounts, plus the API keys Spacron’s own AI features use.' },
  { id: 'voice', label: 'Voice', kicker: 'Transcription, conversation', description: 'Dictation, transcription and voice conversation.' },
  { id: 'terminal', label: 'Terminal', kicker: 'Shell and rendering', description: 'Default shell and how terminals render.' },
  { id: 'agents', label: 'Agents', kicker: 'Coding CLI tools', description: 'The coding CLI tools Spacron can launch.' },
  { id: 'chat', label: 'Chat', kicker: 'Agent chat view', description: 'How the chat view of an agent terminal opens, looks and behaves.' },
  { id: 'source-control', label: 'Source Control', kicker: 'GitHub and git', description: 'GitHub sign-in and source control provider choice.' },
  { id: 'orchestrator', label: 'Orchestrator', kicker: 'Skills and learning', description: 'Orchestrator skills and what it learns.' },
  { id: 'mcp', label: 'MCP & plugins', kicker: 'Tools and plugins', description: 'Tool servers and plugins available to your agents.' },
  { id: 'stats', label: 'Usage', kicker: 'Model usage and cost', description: 'Token and cost analytics across the agents.' },
  { id: 'shortcuts', label: 'Shortcuts', kicker: 'Keyboard map', description: 'Keyboard shortcuts across the app.' },
  { id: 'about', label: 'About', kicker: 'Version and reset', description: 'Version details and resetting Spacron.' },
];

const settingsNavGroups: { label?: string; tabs: Tab[] }[] = [
  { tabs: ['general', 'appearance', 'chat', 'voice', 'terminal', 'shortcuts', 'stats'] },
  // 'orchestrator' is left out while there is no Chat mode to configure; its
  // pane and search entries are kept so it can be listed here again.
  { label: 'Agents', tabs: ['agents', 'mcp'] },
  { label: 'Code', tabs: ['source-control'] },
  { label: 'Connections', tabs: ['models'] },
  { label: 'Maintenance', tabs: ['about'] },
];

const settingsTabIconPaths: Record<Tab, string> = {
  general: 'M4 7h10M18 7h2M4 17h2M10 17h10M14 4v6M8 14v6',
  appearance: 'M12 3a9 9 0 1 0 0 18h1a2 2 0 0 0 1.5-3.3 1.5 1.5 0 0 1 1.1-2.5H18a3 3 0 0 0 3-3c0-5.1-4-9.2-9-9.2Z M7.5 10h.01M10 7h.01M15 7.5h.01',
  models: 'M12 3 3 8l9 5 9-5-9-5ZM3 12l9 5 9-5M3 16l9 5 9-5',
  voice: 'M12 2a3 3 0 0 0-3 3v7a3 3 0 0 0 6 0V5a3 3 0 0 0-3-3ZM5 11a7 7 0 0 0 14 0M12 18v4M8 22h8',
  terminal: 'm5 7 5 5-5 5M13 17h6',
  agents: 'M8 7V5a4 4 0 0 1 8 0v2M5 7h14a2 2 0 0 1 2 2v10H3V9a2 2 0 0 1 2-2ZM8 12h.01M16 12h.01M9 16h6',
  chat: 'M4 4h16v13H9l-5 4V4Z M8 9h8M8 13h5',
  'source-control': 'M7 5v14M7 8c0 4 10 0 10 5v6M17 5v2M7 3a2 2 0 1 0 0 4 2 2 0 0 0 0-4ZM17 3a2 2 0 1 0 0 4 2 2 0 0 0 0-4ZM17 17a2 2 0 1 0 0 4 2 2 0 0 0 0-4Z',
  orchestrator: 'M12 3v3M12 18v3M3 12h3M18 12h3M5.6 5.6l2.1 2.1M16.3 16.3l2.1 2.1M18.4 5.6l-2.1 2.1M7.7 16.3l-2.1 2.1M12 8l2.5 5.5L9 11l3-3Z',
  mcp: 'M8 7V4M16 7V4M5 7h14v6a7 7 0 0 1-14 0V7ZM12 20v2M9 4h.01M15 4h.01',
  stats: 'M4 19V5M4 19h16M8 15l3-4 3 2 5-7',
  shortcuts: 'M3 6a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2v12H3V6ZM7 8h.01M11 8h.01M15 8h.01M7 12h.01M11 12h.01M15 12h.01M8 16h8',
  about: 'M12 11v6M12 7h.01M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0Z',
};

type SettingsSearchEntry = {
  id: string;
  tab: Tab;
  section: string;
  label: string;
  keywords?: string;
  target?: 'row' | 'section';
};

const settingsSearchEntries: SettingsSearchEntry[] = [
  { id: 'editor-font-size', tab: 'general', section: 'Editor', label: 'Font size', keywords: 'editor text code' },
  { id: 'editor-font-family', tab: 'general', section: 'Editor', label: 'Font family', keywords: 'editor terminal typeface' },
  { id: 'tab-size', tab: 'general', section: 'Editor', label: 'Tab size', keywords: 'spaces indentation' },
  { id: 'word-wrap', tab: 'general', section: 'Editor', label: 'Word wrap' },
  { id: 'format-on-save', tab: 'general', section: 'Editor', label: 'Format on save' },
  { id: 'auto-save', tab: 'general', section: 'Editor', label: 'Auto save', keywords: 'automatic save' },
  { id: 'language-server', tab: 'general', section: 'Editor', label: 'Language server', keywords: 'lsp' },
  { id: 'minimap', tab: 'general', section: 'Editor', label: 'Minimap' },
  { id: 'vim-mode', tab: 'general', section: 'Editor', label: 'Vim mode' },
  { id: 'hidden-files', tab: 'general', section: 'Workspace', label: 'Show hidden files', keywords: 'dot files explorer' },
  { id: 'snapshots', tab: 'general', section: 'Workspace', label: 'Show Workspace Snapshots', keywords: 'sidebar history' },
  { id: 'notifications', tab: 'general', section: 'Workspace', label: 'Notifications', keywords: 'alerts agents' },
  { id: 'appearance-mode', tab: 'appearance', section: 'Visual style', label: 'Mode', keywords: 'light dark system theme appearance', target: 'section' },
  { id: 'ui-zoom', tab: 'appearance', section: 'Appearance', label: 'UI zoom', keywords: 'scale size interface' },
  { id: 'ui-font-size', tab: 'appearance', section: 'Appearance', label: 'UI font size', keywords: 'application text size' },
  { id: 'accent-color', tab: 'appearance', section: 'Appearance', label: 'Accent color', keywords: 'colour highlight brand' },
  { id: 'ui-vibrancy', tab: 'appearance', section: 'Colour', label: 'Vibrancy', keywords: 'saturation color colour vivid pop' },
  { id: 'ui-contrast', tab: 'appearance', section: 'Colour', label: 'Contrast', keywords: 'color colour sharp readability' },
  { id: 'custom-background', tab: 'appearance', section: 'Background', label: 'Custom background', keywords: 'wallpaper image' },
  { id: 'background-blur', tab: 'appearance', section: 'Background', label: 'Blur', keywords: 'wallpaper image' },
  { id: 'agent-accounts', tab: 'models', section: 'Accounts', label: 'Accounts', keywords: 'account sign in login switch claude codex email add remove', target: 'section' },
  { id: 'ai-provider', tab: 'models', section: 'API keys', label: 'Provider', keywords: 'ai model service connection' },
  { id: 'ai-api-key', tab: 'models', section: 'API keys', label: 'API key', keywords: 'token secret credentials subscription', target: 'section' },
  { id: 'ghost-text', tab: 'models', section: 'Inline completion', label: 'Ghost text', keywords: 'inline completion suggestions' },
  { id: 'media-generation', tab: 'models', section: 'Image & video generation', label: 'Image & video generation', keywords: 'image video picture generate fal replicate veo sora dalle', target: 'section' },
  { id: 'jev', tab: 'models', section: 'Jev decisions', label: 'Jev decisions', keywords: 'jev typesafe openrouter vercel gateway decisions classifier system one fast routing', target: 'section' },
  { id: 'custom-providers', tab: 'models', section: 'Custom providers', label: 'Custom providers', keywords: 'custom openai compatible provider api key base url proxy litellm', target: 'section' },
  { id: 'local-speech-models', tab: 'models', section: 'Local Speech-to-Text (STT)', label: 'Local Speech-to-Text', keywords: 'offline private voice dictation', target: 'section' },
  { id: 'voice-input', tab: 'voice', section: 'Voice input', label: 'Voice input', keywords: 'speech transcription dictation', target: 'section' },
  { id: 'smart-voice-detection', tab: 'voice', section: 'Voice input', label: 'Smart voice detection', keywords: 'vad speaking silence' },
  { id: 'voice-refinement', tab: 'voice', section: 'Voice refinement', label: 'Voice refinement', keywords: 'transcript cleanup' },
  { id: 'read-aloud', tab: 'voice', section: 'Read aloud', label: 'Read aloud', keywords: 'agent completion voice tts text to speech elevenlabs openai minimax openrouter grok', target: 'section' },
  { id: 'conversation-engine', tab: 'voice', section: 'Conversation engine', label: 'Conversation engine', keywords: 'realtime voice assistant', target: 'section' },
  { id: 'terminal-font-size', tab: 'terminal', section: 'Appearance', label: 'Font size', keywords: 'terminal text' },
  { id: 'terminal-cursor', tab: 'terminal', section: 'Appearance', label: 'Cursor', keywords: 'terminal caret' },
  { id: 'terminal-renderer', tab: 'terminal', section: 'Appearance', label: 'Renderer', keywords: 'terminal webgl canvas dom' },
  { id: 'terminal-scrollback', tab: 'terminal', section: 'Appearance', label: 'Scrollback', keywords: 'terminal history lines' },
  { id: 'default-shell', tab: 'terminal', section: 'Default shell', label: 'Default shell', keywords: 'terminal command prompt', target: 'section' },
  { id: 'stay-awake', tab: 'agents', section: 'Power', label: 'Stay awake while agents work', keywords: 'sleep idle power' },
  { id: 'agent-status-hooks', tab: 'agents', section: 'Local Windows', label: 'Agent status hooks', keywords: 'claude turn status working waiting done' },
  { id: 'auto-agent-titles', tab: 'agents', section: 'Local Windows', label: 'Auto-generate agent titles', keywords: 'first prompt rename tab title' },
  { id: 'codex-own-server', tab: 'agents', section: 'Codex CLI', label: 'Run each Codex terminal on its own server', keywords: 'daemon shared app-server console windows isolate' },
  { id: 'codex-shared-server-warning', tab: 'agents', section: 'Codex CLI', label: 'Warn when a Codex tab shares a server', keywords: 'daemon app-server console windows warning' },
  { id: 'browser-tools', tab: 'agents', section: 'Browser', label: 'Browser tools', keywords: 'web agent' },
  { id: 'orchestrator-skills', tab: 'orchestrator', section: 'Built-in skills', label: 'Built-in skills', keywords: 'orchestrator assistant security engineering debugging review git' },
  { id: 'orchestrator-custom-skills', tab: 'orchestrator', section: 'Your skills', label: 'Add a skill', keywords: 'orchestrator custom instructions playbook prompt' },
  { id: 'orchestrator-learned', tab: 'orchestrator', section: 'What it has learned', label: 'What it has learned', keywords: 'orchestrator memory profile preferences forget' },
  { id: 'coding-cli-agents', tab: 'agents', section: 'Coding CLI agents', label: 'Coding CLI agents', keywords: 'custom agent command' },
  { id: 'chat-launch-view', tab: 'chat', section: 'Opening', label: 'Open new agents in', keywords: 'terminal chat default launch view' },
  { id: 'chat-font', tab: 'chat', section: 'Appearance', label: 'Font family', keywords: 'chat typeface typography terminal' },
  { id: 'chat-text-size', tab: 'chat', section: 'Appearance', label: 'Text size', keywords: 'chat font size bigger smaller' },
  { id: 'chat-code-size', tab: 'chat', section: 'Appearance', label: 'Code text size', keywords: 'chat code block inline monospace' },
  { id: 'chat-width', tab: 'chat', section: 'Appearance', label: 'Width', keywords: 'chat column wide full comfortable' },
  { id: 'chat-scroll-on-send', tab: 'chat', section: 'Behavior', label: 'Scroll to latest when sending', keywords: 'chat scroll position follow' },
  { id: 'chat-spellcheck', tab: 'chat', section: 'Behavior', label: 'Spellcheck and autocorrect', keywords: 'chat spelling message box' },
  { id: 'chat-inline-visuals', tab: 'chat', section: 'Turn activity', label: 'Inline visuals', keywords: 'chat charts diagrams mockups html' },
  { id: 'chat-queue', tab: 'chat', section: 'Behavior', label: 'Queue follow-ups', keywords: 'chat queue busy steer send later' },
  { id: 'chat-mark-new', tab: 'chat', section: 'Behavior', label: 'Mark new messages when returning to a chat', keywords: 'chat unread new line' },
  { id: 'chat-timestamps', tab: 'chat', section: 'Behavior', label: 'Show timestamps', keywords: 'chat time clock message' },
  { id: 'chat-suggested', tab: 'chat', section: 'Behavior', label: 'Suggested prompts', keywords: 'chat starters empty' },
  { id: 'chat-diffs', tab: 'chat', section: 'Turn activity', label: 'Turn diffs', keywords: 'chat diff changes files edited' },
  { id: 'chat-prs', tab: 'chat', section: 'Turn activity', label: 'Opened pull requests', keywords: 'chat pr github ci checks' },
  { id: 'chat-links', tab: 'chat', section: 'Behavior', label: 'Link previews', keywords: 'chat links cards url' },
  { id: 'chat-usage-continue', tab: 'chat', section: 'Behavior', label: 'Continue chats automatically when a usage limit resets', keywords: 'chat usage limit reset auto continue' },
  { id: 'chat-agent-launch', tab: 'chat', section: 'Default launch mode per agent', label: 'Default launch mode per agent', keywords: 'chat cli claude codex grok opencode per agent' },
  { id: 'chat-match-terminal', tab: 'chat', section: 'Appearance', label: 'Match terminal interface', keywords: 'chat terminal font colours colors theme' },
  { id: 'chat-contrast', tab: 'chat', section: 'Appearance', label: 'Contrast', keywords: 'chat brightness softer sharper text' },
  { id: 'chat-ci', tab: 'chat', section: 'Turn activity', label: 'CI result lines', keywords: 'chat ci checks github actions pull request' },
  { id: 'chat-permissions', tab: 'chat', section: 'Behavior', label: 'Permissions for new chats', keywords: 'chat permission full access approval' },
  { id: 'source-control-github', tab: 'source-control', section: 'Source control provider', label: 'Source control', keywords: 'git github provider clone publish' },
  { id: 'source-control-signin', tab: 'source-control', section: 'GitHub sign-in', label: 'GitHub sign-in', keywords: 'github sign in oauth gh cli personal access token' },
  { id: 'mcp-builtin', tab: 'mcp', section: 'Built in', label: 'Built-in servers', keywords: 'mcp spacron playwright browser tools' },
  { id: 'mcp-catalog', tab: 'mcp', section: 'Plugins', label: 'Plugins', keywords: 'mcp catalog plugins marketplace install github notion linear figma supabase stripe vercel sentry' },
  { id: 'mcp-servers', tab: 'mcp', section: 'Your servers', label: 'Add an MCP server', keywords: 'mcp model context protocol remote hosted stdio integration linear notion github' },
  { id: 'usage-stats', tab: 'stats', section: 'Usage', label: 'Usage', keywords: 'model tokens spending statistics cost', target: 'section' },
  { id: 'keyboard-shortcuts', tab: 'shortcuts', section: 'Keyboard shortcuts', label: 'Keyboard shortcuts', keywords: 'hotkeys keymap', target: 'section' },
  { id: 'custom-shortcuts', tab: 'shortcuts', section: 'Add custom navigation shortcut', label: 'Add custom navigation shortcut', keywords: 'hotkeys commands', target: 'section' },
  { id: 'version', tab: 'about', section: 'Spacron', label: 'Version', keywords: 'release changelog', target: 'section' },
  { id: 'factory-reset', tab: 'about', section: 'Maintenance', label: 'Factory reset', keywords: 'erase restore defaults', target: 'section' },
];

function settingsSearchKey(value: string): string {
  return value.trim().toLowerCase().replace(/\s+/g, '-');
}

const voiceInputProviders: { id: VoiceInputProviderId; label: string }[] = [
  { id: 'webspeech', label: 'System speech' },
  { id: 'google', label: 'Google Gemini' },
  { id: 'openai', label: 'OpenAI' },
  { id: 'openrouter', label: 'OpenRouter' },
  { id: 'vercel', label: 'Vercel AI Gateway' },
  { id: 'ollama', label: 'Ollama' },
  { id: 'lmstudio', label: 'LM Studio' },
  { id: 'local', label: 'Local Offline (Whisper/Parakeet)' },
];

const accentPresets = [
  { value: '#000000', label: 'Graphite' },
  { value: '#2563eb', label: 'Blue' },
  { value: '#7c3aed', label: 'Violet' },
  { value: '#0f766e', label: 'Teal' },
  { value: '#c2410c', label: 'Orange' },
  { value: '#be123c', label: 'Rose' },
];

function classNames(...parts: Array<string | false | null | undefined>) {
  return parts.filter(Boolean).join(' ');
}

/** Brand mark for an AI provider id, used in every provider/model select. */
function providerIcon(id: string) {
  const def = aiProviders.find((item) => item.id === id);
  return <ProviderBrandMark id={id} label={def?.label ?? id} />;
}

function GithubBrandIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
      <path fillRule="evenodd" clipRule="evenodd" d="M12 2C6.477 2 2 6.484 2 12.017c0 4.425 2.865 8.18 6.839 9.504.5.092.682-.217.682-.483 0-.237-.008-.868-.013-1.703-2.782.605-3.369-1.343-3.369-1.343-.454-1.158-1.11-1.466-1.11-1.466-.908-.62.069-.608.069-.608 1.003.07 1.53 1.032 1.53 1.032.892 1.53 2.341 1.088 2.91.832.092-.647.35-1.088.636-1.338-2.22-.253-4.555-1.113-4.555-4.951 0-1.093.39-1.988 1.029-2.688-.103-.253-.446-1.272.098-2.65 0 0 .84-.27 2.75 1.026A9.564 9.564 0 0112 6.844c.85.004 1.705.115 2.504.337 1.909-1.296 2.747-1.027 2.747-1.027.546 1.379.202 2.398.1 2.651.64.7 1.028 1.595 1.028 2.688 0 3.848-2.339 4.695-4.566 4.943.359.309.678.92.678 1.855 0 1.338-.012 2.419-.012 2.747 0 .268.18.58.688.482A10.019 10.019 0 0022 12.017C22 6.484 17.522 2 12 2z" />
    </svg>
  );
}

function GitlabBrandIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
      <path d="M23.6 9.58 22.3.96a.6.6 0 0 0-1.08-.2l-2.73 6.94H5.51L2.78.76a.6.6 0 0 0-1.08.2L.4 9.58a1.2 1.2 0 0 0 .44 1.35L12 23.33l11.16-12.4a1.2 1.2 0 0 0 .44-1.35Z" />
    </svg>
  );
}

function BitbucketBrandIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
      <path d="M2.66 3h18.68a.9.9 0 0 1 .89 1.03l-2.75 16.36a1.2 1.2 0 0 1-1.18 1H5.7a1.2 1.2 0 0 1-1.18-1L1.77 4.03A.9.9 0 0 1 2.66 3Zm11.83 11.53H9.51l-.78 4.6h6.54l.78-4.6Z" />
    </svg>
  );
}

function GitBrandIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <circle cx="18" cy="18" r="3" />
      <circle cx="6" cy="6" r="3" />
      <circle cx="18" cy="6" r="3" />
      <path d="M6 9v12M18 9a9 9 0 0 1-9 9" />
    </svg>
  );
}

/** Open a provider/help URL in the system default browser. A plain
 *  `<a href target="_blank">` is swallowed by the Tauri WebView, so route
 *  through the backend opener with a window.open fallback. */
function openExternalUrl(url: string) {
  void (async () => {
    try {
      await invoke('preview_open_in_browser', { url });
    } catch {
      window.open(url, '_blank', 'noopener,noreferrer');
    }
  })();
}

/** Human-readable byte size, e.g. 654311424 -> "624 MB". */
function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.min(units.length - 1, Math.floor(Math.log(bytes) / Math.log(1024)));
  const value = bytes / Math.pow(1024, i);
  return `${value >= 100 || i === 0 ? Math.round(value) : value.toFixed(1)} ${units[i]}`;
}

function Toggle({
  checked,
  onChange,
  label,
  disabled = false,
}: {
  checked: boolean;
  onChange: (checked: boolean) => void;
  label: string;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      className={classNames('settings-toggle', checked && 'active')}
      disabled={disabled}
      style={disabled ? { opacity: 0.45, cursor: 'not-allowed' } : undefined}
      onClick={() => onChange(!checked)}
      aria-label={label}
      aria-pressed={checked}
    >
      <span />
    </button>
  );
}

function StyledSelect<T extends string>({
  value,
  options,
  onChange,
  ariaLabel,
  showSearch = false,
  renderIcon,
}: {
  value: T;
  options: { id: T; label: string; disabled?: boolean; disabledReason?: string }[];
  onChange: (value: T) => void;
  ariaLabel: string;
  showSearch?: boolean;
  renderIcon?: (id: T) => React.ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const [panelStyle, setPanelStyle] = useState<CSSProperties>({});
  const [searchQuery, setSearchQuery] = useState('');
  const triggerRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const selectedLabel = options.find((o) => o.id === value)?.label ?? value;

  const close = useCallback(() => setOpen(false), []);

  useEffect(() => {
    if (!open) {
      setSearchQuery('');
    }
  }, [open]);

  // Compute panel position from trigger's rect relative to the settings modal
  const updatePosition = useCallback(() => {
    const trigger = triggerRef.current;
    if (!trigger) return;
    
    const modal = document.querySelector('.settings-modal');
    if (!modal) return;
    
    const modalRect = modal.getBoundingClientRect();
    const rect = trigger.getBoundingClientRect();
    
    const relativeTop = rect.bottom - modalRect.top;
    // The trigger sizes to its value and sits at the right of its row, so the
    // panel hangs from the trigger's right edge and may grow leftwards to fit
    // its longest option — never narrower than the trigger, never past the modal.
    const relativeRight = modalRect.right - rect.right;
    const horizontal = {
      right: relativeRight,
      width: 'max-content',
      minWidth: rect.width,
      maxWidth: Math.min(420, rect.right - modalRect.left - 12),
    } as const;

    const spaceBelow = modalRect.bottom - rect.bottom;
    const spaceAbove = rect.top - modalRect.top;
    const openDown = spaceBelow >= 200 || spaceBelow >= spaceAbove;

    if (openDown) {
      setPanelStyle({
        position: 'absolute',
        top: relativeTop + 6,
        ...horizontal,
        maxHeight: Math.min(240, spaceBelow - 12),
      });
    } else {
      setPanelStyle({
        position: 'absolute',
        bottom: modalRect.height - (rect.top - modalRect.top) + 6,
        ...horizontal,
        maxHeight: Math.min(240, spaceAbove - 12),
      });
    }
  }, []);

  // Open: measure position then show
  const toggle = useCallback(() => {
    if (!open) updatePosition();
    setOpen((v) => !v);
  }, [open, updatePosition]);

  useEffect(() => {
    if (!open) return;
    function onDown(e: MouseEvent) {
      const target = e.target as Node;
      if (
        triggerRef.current && !triggerRef.current.contains(target) &&
        panelRef.current && !panelRef.current.contains(target)
      ) close();
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') close();
    }
    function onScroll() { updatePosition(); }
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    window.addEventListener('scroll', onScroll, true);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
      window.removeEventListener('scroll', onScroll, true);
    };
  }, [open, close, updatePosition]);

  const filteredOptions = useMemo(() => {
    if (!showSearch || !searchQuery.trim()) return options;
    const q = searchQuery.toLowerCase();
    return options.filter((o) => o.label.toLowerCase().includes(q) || o.id.toLowerCase().includes(q));
  }, [options, showSearch, searchQuery]);

  const panel = open
    ? createPortal(
        <div
          ref={panelRef}
          className="sselect-panel"
          role="listbox"
          style={panelStyle}
        >
          {showSearch && (
            <div className="model-search-bar" onMouseDown={(e) => e.stopPropagation()}>
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ flexShrink: 0 }}>
                <circle cx="11" cy="11" r="8"/>
                <line x1="21" y1="21" x2="16.65" y2="16.65"/>
              </svg>
              <input
                className="model-search-input"
                type="text"
                placeholder="Search..."
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                spellCheck="false"
                autoComplete="off"
                autoFocus
              />
              {searchQuery && (
                <button type="button" className="model-search-clear" onClick={() => setSearchQuery('')} aria-label="Clear search">×</button>
              )}
            </div>
          )}
          <ul className="sselect-options-list">
            {filteredOptions.length === 0 ? (
              <div className="model-empty">No options found.</div>
            ) : (
              filteredOptions.map((opt) => (
                <li
                  key={opt.id}
                  role="option"
                  aria-selected={opt.id === value}
                  aria-disabled={opt.disabled}
                  className={`sselect-option${opt.id === value ? ' selected' : ''}${opt.disabled ? ' disabled' : ''}`}
                  title={opt.disabledReason}
                  onMouseDown={() => {
                    if (opt.disabled) return;
                    onChange(opt.id);
                    setOpen(false);
                  }}
                >
                  {renderIcon && (
                    <span className="sselect-icon" aria-hidden="true">{renderIcon(opt.id)}</span>
                  )}
                  {opt.id === value && (
                    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                      <polyline points="20 6 9 17 4 12" />
                    </svg>
                  )}
                  <span>{opt.label}</span>
                  {opt.disabled && <small>Not supported yet</small>}
                </li>
              ))
            )}
          </ul>
        </div>,
        document.querySelector('.settings-modal') || document.body,
      )
    : null;

  return (
    <div className={`sselect${open ? ' open' : ''}`} aria-label={ariaLabel}>
      <button
        ref={triggerRef}
        type="button"
        className="sselect-trigger"
        onClick={toggle}
        aria-haspopup="listbox"
        aria-expanded={open}
      >
        {renderIcon && (
          <span className="sselect-icon" aria-hidden="true">{renderIcon(value)}</span>
        )}
        <span className="sselect-value">{selectedLabel}</span>
        <svg className="sselect-chevron" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
          <polyline points="6 9 12 15 18 9" />
        </svg>
      </button>
      {panel}
    </div>
  );
}

// Alias — SelectField and ModelSelect both now use StyledSelect under the hood
function SelectField<T extends string>(props: {
  value: T;
  options: { id: T; label: string }[];
  onChange: (value: T) => void;
  ariaLabel: string;
  renderIcon?: (id: T) => React.ReactNode;
}) {
  return <StyledSelect {...props} />;
}

/** A miniature Spacron window for the Mode picker: sidebar, a few chat lines,
 *  and the composer. `half` shows only its right half, laid over a light mock
 *  to draw the split System thumbnail. */
function ModeMock({ tone, half = false }: { tone: 'light' | 'dark'; half?: boolean }) {
  return (
    <span className={`mode-mock mode-mock-${tone}${half ? ' mode-mock-half' : ''}`} aria-hidden="true">
      <span className="mode-mock-side"><span className="mode-mock-dot" /></span>
      <span className="mode-mock-main">
        <span className="mode-mock-line accent" style={{ width: '42%' }} />
        <span className="mode-mock-line" style={{ width: '64%' }} />
        <span className="mode-mock-line" style={{ width: '48%' }} />
        <span className="mode-mock-line accent" style={{ width: '38%' }} />
        <span className="mode-mock-input"><span className="mode-mock-send" /></span>
      </span>
    </span>
  );
}

function SettingRow({
  title,
  searchKey,
  detail,
  children,
}: {
  title: string | React.ReactNode;
  searchKey?: string;
  detail?: string;
  children: React.ReactNode;
}) {
  const key = searchKey ?? (typeof title === 'string' ? settingsSearchKey(title) : '');
  return (
    <div className="settings-control-row" data-settings-key={key}>
      <div className="settings-control-copy">
        <span>{title}</span>
        {detail && <small>{detail}</small>}
      </div>
      <div className="settings-control">{children}</div>
    </div>
  );
}

function SkillChevron({ open }: { open: boolean }) {
  return (
    <svg className={`skill-chevron${open ? ' open' : ''}`} width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="m6 9 6 6 6-6" />
    </svg>
  );
}

/** A settings row whose title opens a read-only panel under it (built-in skills). */
function SkillRow({
  title,
  detail,
  expanded,
  onToggleOpen,
  body,
  children,
}: {
  title: string;
  detail?: string;
  expanded: boolean;
  onToggleOpen: () => void;
  body: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <div className="settings-control-row skill-row" data-settings-key={settingsSearchKey(title)}>
      <button type="button" className="settings-control-copy skill-open-btn" aria-expanded={expanded} onClick={onToggleOpen} title={expanded ? 'Collapse' : 'Read what this skill does'}>
        <span>{title} <SkillChevron open={expanded} /></span>
        {detail && <small>{detail}</small>}
      </button>
      <div className="settings-control">{children}</div>
      {expanded && <div className="skill-body">{body}</div>}
    </div>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="settings-card" data-settings-section={settingsSearchKey(title)}>
      <h3>{title}</h3>
      <div className="settings-card-body">{children}</div>
    </section>
  );
}

function ReadAloudSection() {
  const settings = useStore(readAloudSettings);
  const speakCompletions = useStore(speakAgentCompletions);

  return (
    <Section title="Read aloud">
      <p className="shell-hint">Voice for chat replies and agent completion announcements.</p>
      <SettingRow title="Voice engine" detail={settings.engine === 'system' ? 'Uses the voices built into your computer. Free and offline.' : 'Uses AI-generated speech.'}>
        <SelectField
          value={settings.engine}
          options={[...READ_ALOUD_ENGINES]}
          onChange={(engine: ReadAloudEngine) => readAloudSettings.update((s) => ({ ...s, engine }))}
          ariaLabel="Read aloud voice engine"
        />
      </SettingRow>
      <SettingRow
        title="Read agent completions aloud"
        detail="Announce when an agent finishes, fails, or needs input."
      >
        <Toggle label="Read completions aloud" checked={speakCompletions} onChange={speakAgentCompletions.set} />
      </SettingRow>
      {settings.engine === 'system' ? (
        <div className="settings-action-row">
          <button className="settings-secondary" onClick={previewReadAloud}>Test voice</button>
        </div>
      ) : <ReadAloudCloudSettings key={settings.engine} engine={settings.engine} settings={settings} />}
    </Section>
  );
}

interface OpenRouterSpeechModel {
  id: string;
  name: string;
  voices: string[];
}

function ReadAloudCloudSettings({ engine, settings }: { engine: CloudReadAloudEngine; settings: ReadAloudSettings }) {
  const model = readAloudModelFor(settings, engine);
  const voice = readAloudVoiceFor(settings, engine);
  const vendor = READ_ALOUD_ENGINES.find(({ id }) => id === engine)?.label ?? engine;
  const keyUrl = engine === 'elevenlabs' ? 'https://elevenlabs.io/app/settings/api-keys'
    : engine === 'minimax' ? 'https://platform.minimax.io/console/keys' : null;
  const [keyInput, setKeyInput] = useState('');
  const [keyExists, setKeyExists] = useState<boolean | null>(null);
  const [savingKey, setSavingKey] = useState(false);
  const [keyError, setKeyError] = useState('');
  const [accountVoices, setAccountVoices] = useState<{ id: string; label: string }[]>([]);
  const [voicesError, setVoicesError] = useState('');
  const [openRouterModels, setOpenRouterModels] = useState<OpenRouterSpeechModel[] | null>(null);
  const [modelsError, setModelsError] = useState('');

  useEffect(() => {
    let active = true;
    void invoke<boolean>('provider_api_key_exists', { provider: engine })
      .then((exists) => { if (active) setKeyExists(exists); })
      .catch(() => { if (active) setKeyExists(false); });
    return () => { active = false; };
  }, [engine]);

  useEffect(() => {
    if (engine === 'openai' || engine === 'openrouter' || !keyExists || savingKey) return;
    let active = true;
    void invoke<{ id: string; name: string; detail?: string | null }[]>('read_aloud_voices', { provider: engine })
      .then((list) => { if (active) setAccountVoices(list.map((v) => ({ id: v.id, label: v.detail ? `${v.name} (${v.detail})` : v.name }))); })
      .catch((error) => { if (active) setVoicesError(explainError(error).summary); });
    return () => { active = false; };
  }, [engine, keyExists, savingKey]);

  useEffect(() => {
    if (engine !== 'openrouter') return;
    let active = true;
    void invoke<OpenRouterSpeechModel[]>('read_aloud_openrouter_models')
      .then((list) => { if (active) setOpenRouterModels(list); })
      .catch((error) => { if (active) setModelsError(explainError(error).summary); });
    return () => { active = false; };
  }, [engine]);

  const selectedRouterModel = openRouterModels?.find((item) => item.id === model);
  const setModel = (next: string) => {
    const routerModel = openRouterModels?.find((item) => item.id === next);
    readAloudSettings.update((s) => {
      const updated = { ...s, models: { ...s.models, [engine]: next } };
      if (!routerModel) return updated;
      const savedVoice = readAloudVoiceFor(updated, 'openrouter');
      return {
        ...updated,
        openRouterVoices: {
          ...s.openRouterVoices,
          [next]: routerModel.voices.includes(savedVoice) ? savedVoice : routerModel.voices[0],
        },
      };
    });
  };
  const setVoice = (next: string) => readAloudSettings.update((s) => engine === 'openrouter'
    ? { ...s, openRouterVoices: { ...s.openRouterVoices, [model]: next } }
    : { ...s, voices: { ...s.voices, [engine]: next } });

  const saveKey = async (value: string) => {
    const key = value.trim();
    setKeyError('');
    setSavingKey(true);
    try {
      await invoke(key ? 'provider_api_key_set' : 'provider_api_key_delete',
        key ? { provider: engine, apiKey: key } : { provider: engine });
      setAccountVoices([]);
      setVoicesError('');
      setKeyExists(Boolean(key));
      setKeyInput('');
    } catch (error) {
      setKeyError(explainError(error).summary);
    } finally {
      setSavingKey(false);
    }
  };

  const modelOptions = engine === 'openrouter'
    ? (openRouterModels ?? []).map(({ id, name }) => ({ id, label: name }))
    : engine === 'minimax' || engine === 'elevenlabs' ? READ_ALOUD_MODELS[engine] : [];
  const availableVoices = engine === 'openrouter'
    ? (selectedRouterModel?.voices ?? []).map((id) => ({ id, label: id }))
    : engine === 'openai' ? OPENAI_READ_ALOUD_VOICES
      : engine === 'xai' && !accountVoices.length ? XAI_READ_ALOUD_VOICES : accountVoices;
  const voiceOptions = voice && !availableVoices.some((option) => option.id === voice)
    ? [{ id: voice, label: voice === ELEVENLABS_DEFAULT_VOICE ? 'Rachel' : voice }, ...availableVoices]
    : availableVoices;
  const status = keyExists === null ? 'Checking for an API key…'
    : keyExists ? `Using the saved ${vendor} API key. Cloud speech uses your API balance.`
      : keyUrl ? `Add a ${vendor} API key below.` : `Add a ${vendor} API key under AI Providers > API keys.`;
  const routerSelectionUnavailable = engine === 'openrouter' && openRouterModels !== null
    && !selectedRouterModel?.voices.includes(voice);
  const routerModelDetail = engine === 'openrouter'
    ? modelsError || (openRouterModels === null ? 'Loading speech models…'
      : routerSelectionUnavailable ? 'Choose an available model and voice.' : undefined)
    : undefined;

  return (
    <>
      <p className="shell-hint">{status}</p>
      {(engine === 'openrouter' || modelOptions.length > 0) && (
        <SettingRow title="Speech model" detail={routerModelDetail}>
          <StyledSelect value={model} options={modelOptions} onChange={setModel} ariaLabel="Read aloud speech model" showSearch={engine === 'openrouter'} />
        </SettingRow>
      )}
      <SettingRow title="Voice" detail={voicesError || undefined}>
        <StyledSelect value={voice} options={voiceOptions} onChange={setVoice} ariaLabel="Read aloud voice" showSearch={voiceOptions.length > 10} />
      </SettingRow>
      {keyUrl && (
        <>
          <SettingRow title={`${vendor} API key`}>
            <input
              type="password"
              value={keyInput}
              onChange={(event) => setKeyInput(event.target.value)}
              placeholder={keyExists ? 'Key saved in OS keychain' : `Paste your ${vendor} key`}
            />
          </SettingRow>
          <div className="settings-action-row">
            <button className="settings-primary" onClick={() => void saveKey(keyInput)} disabled={savingKey || keyExists === null || !keyInput.trim()}>Save key</button>
            <button className="settings-secondary" onClick={() => void saveKey('')} disabled={savingKey || !keyExists}>Clear key</button>
            <button className="settings-link-button" onClick={() => openExternalUrl(keyUrl)}>Get a key</button>
          </div>
        </>
      )}
      <div className="settings-action-row">
        <button className="settings-secondary" onClick={previewReadAloud} disabled={!keyExists || savingKey || !voice || routerSelectionUnavailable}>Test voice</button>
      </div>
      {keyError && <p className="shell-hint">{keyError}</p>}
    </>
  );
}

/**
 * Settings > AI Providers > Jev decisions. Where the real Jev is reached
 * and which saved key pays for it: TypeSafe, OpenRouter, Vercel AI Gateway, or
 * a custom provider that serves `/systemone` (e.g. a LiteLLM proxy). Only
 * sources that run Jev are listed; custom ones are probed first.
 */
function JevConnectionSection() {
  const [typesafeKeyInput, setTypesafeKeyInput] = useState('');
  const [keyError, setKeyError] = useState('');
  const [sourceKeyExists, setSourceKeyExists] = useState<boolean | null>(null);
  const via = (useStore(jevProvider) as string) || 'typesafe';
  const agentTool = useStore(jevAgentTool) === true;
  const [agentUsage, setAgentUsage] = useState<JevAgentUsage | null>(null);
  useEffect(() => { void jevAgentUsage().then(setAgentUsage); }, [agentTool]);
  const customList = useStore(customProviders) as CustomProvider[];
  const [jevCustom, setJevCustom] = useState<{ id: string; label: string }[]>([]);

  // Custom providers are offered only once their /systemone route answers.
  useEffect(() => {
    let active = true;
    void Promise.all(
      customList.map(async (p): Promise<{ id: string; label: string } | null> => (
        (await invoke<boolean>('jev_source_supported', { provider: p.id }).catch(() => false)) ? { id: p.id, label: p.name } : null
      )),
    ).then((found) => {
      if (active) setJevCustom(found.filter((p): p is { id: string; label: string } => p !== null));
    });
    return () => { active = false; };
  }, [customList]);

  const jevOptions = [
    { id: 'typesafe', label: 'TypeSafe' },
    { id: 'openrouter', label: 'OpenRouter' },
    { id: 'vercel', label: 'Vercel AI Gateway' },
    ...jevCustom,
  ];
  const sourceLabel = jevOptions.find((o) => o.id === via)?.label
    ?? aiProviders.find((p) => p.id === via)?.label
    ?? via;

  useEffect(() => {
    let active = true;
    setSourceKeyExists(null);
    void invoke<boolean>('provider_api_key_exists', { provider: via })
      .then((exists) => { if (active) setSourceKeyExists(exists); })
      .catch(() => { if (active) setSourceKeyExists(false); });
    return () => { active = false; };
  }, [via]);

  const saveTypesafeKey = async (value: string) => {
    setKeyError('');
    try {
      await invoke(value.trim() ? 'provider_api_key_set' : 'provider_api_key_delete',
        value.trim() ? { provider: 'typesafe', apiKey: value.trim() } : { provider: 'typesafe' });
      setSourceKeyExists(Boolean(value.trim()));
      setTypesafeKeyInput('');
    } catch (error) {
      setKeyError(explainError(error).summary);
    }
  };

  const status = sourceKeyExists === null
    ? 'Checking…'
    : sourceKeyExists
      ? `On · using your ${sourceLabel} key.`
      : `Off · no ${sourceLabel} key is saved yet${via === 'typesafe' ? '' : '. Add it under API keys above'}.`;

  return (
    <Section title="Jev decisions">
      <p className="shell-hint">
        Fast, structured decisions for agent routing and status classification. Optional; built-in rules are used when off.
      </p>
      <SettingRow title="Answered by" detail="Select the service that powers Jev decisions.">
        <SelectField
          value={via}
          options={jevOptions}
          onChange={jevProvider.set}
          ariaLabel="Jev provider"
          renderIcon={(id) => (id === 'typesafe' ? null : providerIcon(id))}
        />
      </SettingRow>
      <SettingRow title="Key in use" detail={status}>
        {via === 'typesafe' && (
          <input
            type="password"
            value={typesafeKeyInput}
            onChange={(event) => setTypesafeKeyInput(event.target.value)}
            placeholder={sourceKeyExists ? 'TypeSafe key saved in OS keychain' : 'Paste your TypeSafe key'}
          />
        )}
      </SettingRow>
      {via === 'typesafe' && (
        <div className="settings-action-row">
          <button className="settings-primary" onClick={() => void saveTypesafeKey(typesafeKeyInput)} disabled={!typesafeKeyInput.trim()}>Save key</button>
          <button className="settings-secondary" onClick={() => void saveTypesafeKey('')} disabled={!sourceKeyExists}>Clear key</button>
          <button className="settings-link-button" onClick={() => openExternalUrl('https://console.typesafe.ai/')}>Get a key</button>
        </div>
      )}
      <SettingRow
        title="Let agents use Jev"
        detail={`Adds a jev_classify tool to coding agents for quick categorization.${agentUsage && agentUsage.calls > 0
          ? ` Used ${agentUsage.calls} time${agentUsage.calls === 1 ? '' : 's'} (${agentUsage.inputTokens.toLocaleString()} tokens).`
          : ''}`}
      >
        <Toggle label="Let agents use Jev" checked={agentTool} onChange={jevAgentTool.set} />
      </SettingRow>
      {keyError && <p className="shell-hint">{keyError}</p>}
    </Section>
  );
}

/**
 * Settings > AI Providers > Custom providers. Any OpenAI-compatible API: a
 * name, its address and a key. Once saved it joins every provider picker
 * (chat, completion, dictation, image and video, realtime voice), and its
 * models are always the live list its key returns.
 */
function CustomProvidersSection() {
  const list = useStore(customProviders) as CustomProvider[];
  const [editing, setEditing] = useState<CustomProvider | 'new' | null>(null);
  const [name, setName] = useState('');
  const [baseUrl, setBaseUrl] = useState('');
  const [apiKey, setApiKey] = useState('');
  const [busy, setBusy] = useState(false);
  const [formError, setFormError] = useState<ExplainedError | null>(null);
  const [models, setModels] = useState<Record<string, { count?: number; error?: ExplainedError; loading?: boolean }>>({});

  const refresh = useCallback(async (id: string) => {
    setModels((m) => ({ ...m, [id]: { ...m[id], loading: true } }));
    try {
      const found = await listProviderModels(id as AiProviderId);
      setModels((m) => ({ ...m, [id]: { count: found.length } }));
    } catch (error) {
      setModels((m) => ({ ...m, [id]: { error: explainError(error) } }));
    }
  }, []);

  // Live on open: every provider's list is fetched fresh, so a model the
  // provider added since last time is there without any manual step.
  useEffect(() => {
    for (const provider of list) void refresh(provider.id);
  }, [list, refresh]);

  const open = (target: CustomProvider | 'new') => {
    setEditing(target);
    setName(target === 'new' ? '' : target.name);
    setBaseUrl(target === 'new' ? '' : target.baseUrl);
    setApiKey('');
    setFormError(null);
  };

  const save = async () => {
    setBusy(true);
    setFormError(null);
    try {
      const saved = await saveCustomProvider({
        id: editing && editing !== 'new' ? editing.id : undefined,
        name,
        baseUrl,
        apiKey,
      });
      setEditing(null);
      void refresh(saved.id);
    } catch (error) {
      setFormError(explainError(error));
    } finally {
      setBusy(false);
    }
  };

  const remove = async (provider: CustomProvider) => {
    try {
      await deleteCustomProvider(provider.id);
    } catch (error) {
      setFormError(explainError(error));
    }
  };

  return (
    <Section title="Custom providers">
      <p className="shell-hint">
        Connect any OpenAI-compatible endpoint. Keys are encrypted in your OS keychain.
      </p>
      {list.length > 0 && (
        <ul className="custom-provider-list">
          {list.map((provider) => {
            const state = models[provider.id];
            return (
              <li key={provider.id} className="custom-provider-row">
                <span className="custom-provider-mark">
                  <ProviderBrandMark id={provider.id} label={provider.name} />
                </span>
                <span className="custom-provider-text">
                  <strong>{provider.name}</strong>
                  <span className="custom-provider-url">{provider.baseUrl}</span>
                  <span className={`custom-provider-status${state?.error ? ' bad' : ''}`}>
                    {state?.loading
                      ? 'Checking models…'
                      : state?.error
                        ? `${state.error.summary}${state.error.nextStep ? ` ${state.error.nextStep}` : ''}`
                        : state?.count !== undefined
                          ? `${state.count} model${state.count === 1 ? '' : 's'} available`
                          : ''}
                  </span>
                </span>
                <span className="custom-provider-actions">
                  <button className="settings-secondary" onClick={() => void refresh(provider.id)} disabled={state?.loading}>Refresh</button>
                  <button className="settings-secondary" onClick={() => open(provider)}>Edit</button>
                  <button className="settings-danger" onClick={() => void remove(provider)}>Remove</button>
                </span>
              </li>
            );
          })}
        </ul>
      )}
      {editing ? (
        <>
          <SettingRow title="Name">
            <input value={name} onChange={(event) => setName(event.target.value)} placeholder="e.g. My Proxy" />
          </SettingRow>
          <SettingRow title="API address" detail="The address that ends before /chat/completions, usually ending in /v1.">
            <input value={baseUrl} onChange={(event) => setBaseUrl(event.target.value)} placeholder="https://api.example.com/v1" />
          </SettingRow>
          <SettingRow title="API key" detail={editing === 'new' ? undefined : 'Leave blank to keep the saved key.'}>
            <input type="password" value={apiKey} onChange={(event) => setApiKey(event.target.value)} placeholder={editing === 'new' ? 'sk-...' : 'Key saved in OS keychain'} />
          </SettingRow>
          {formError && (
            <p className="shell-hint custom-provider-error">
              {formError.summary}
              {formError.nextStep ? ` ${formError.nextStep}` : ''}
            </p>
          )}
          <div className="settings-action-row">
            <button
              className="settings-primary"
              onClick={() => void save()}
              disabled={busy || !name.trim() || !baseUrl.trim() || (editing === 'new' && !apiKey.trim())}
            >
              {busy ? 'Saving…' : editing === 'new' ? 'Add provider' : 'Save changes'}
            </button>
            <button className="settings-secondary" onClick={() => setEditing(null)} disabled={busy}>Cancel</button>
          </div>
        </>
      ) : (
        <div className="settings-action-row">
          <button className="settings-primary" onClick={() => open('new')}>Add custom provider</button>
        </div>
      )}
    </Section>
  );
}

/**
 * Settings > AI Providers > Image & video generation. Generation tries the
 * ChatGPT plan first for images, then every provider with a key; this picks
 * which one goes first, per-provider models, and the two media-only keys.
 */
function MediaGenerationSection() {
  const settings = useStore(mediaGeneration) as MediaGenerationSettings;
  const [keys, setKeys] = useState<Record<string, boolean>>({});
  const [keyInput, setKeyInput] = useState<Record<string, string>>({});
  const [keyError, setKeyError] = useState('');
  const keyProviders = MEDIA_PROVIDERS.filter((p) => p.keyUrl);

  useEffect(() => {
    let live = true;
    void Promise.all(keyProviders.map(async (p) => [p.id, await invoke<boolean>('provider_api_key_exists', { provider: p.id }).catch(() => false)] as const))
      .then((entries) => { if (live) setKeys(Object.fromEntries(entries)); });
    return () => { live = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const update = (patch: Partial<MediaGenerationSettings>) => mediaGeneration.set({ ...settings, ...patch });

  // Live model ids for a picked custom provider, offered as suggestions.
  const [liveMediaModels, setLiveMediaModels] = useState<Record<string, string[]>>({});
  useEffect(() => {
    for (const id of [settings.imageProvider, settings.videoProvider]) {
      if (!id.startsWith('custom-') || liveMediaModels[id]) continue;
      void listProviderModels(id as AiProviderId)
        .then((found) => setLiveMediaModels((current) => ({ ...current, [id]: found.map((m) => m.id) })))
        .catch(() => {});
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [settings.imageProvider, settings.videoProvider]);

  const saveKey = async (provider: string, value: string) => {
    setKeyError('');
    try {
      await invoke(value.trim() ? 'provider_api_key_set' : 'provider_api_key_delete', value.trim() ? { provider, apiKey: value.trim() } : { provider });
      setKeys((current) => ({ ...current, [provider]: Boolean(value.trim()) }));
      setKeyInput((current) => ({ ...current, [provider]: '' }));
    } catch (error) {
      setKeyError(String(error ?? 'could not save the key'));
    }
  };

  const providerRow = (kind: MediaKind) => {
    const field = kind === 'video' ? 'videoProvider' : 'imageProvider';
    const modelsField = kind === 'video' ? 'videoModels' : 'imageModels';
    const chosen = settings[field];
    const custom = aiProviders.filter((p) => p.custom);
    const options = [
      { id: 'auto', label: kind === 'image' ? 'Auto (ChatGPT plan first)' : 'Auto (first with a key)' },
      ...MEDIA_PROVIDERS.filter((p) => (kind === 'video' ? p.video : p.image)).map((p) => ({ id: p.id, label: p.label })),
      // A custom provider is used only when picked here, and needs a model.
      ...custom.map((p) => ({ id: p.id, label: p.label })),
    ];
    const customDef = custom.find((p) => p.id === chosen);
    const info = MEDIA_PROVIDERS.find((p) => p.id === chosen)
      ?? (customDef ? { id: customDef.id, label: customDef.label, image: true, video: true } as MediaProviderInfo : undefined);
    const fallback = kind === 'video' ? info?.videoDefault : info?.imageDefault;
    return (
      <>
        <SettingRow title={kind === 'video' ? 'Video provider' : 'Image provider'} detail="Tried first; the others with a key are used if it is out of credit or not set up.">
          <SelectField value={chosen} options={options} onChange={(value) => update({ [field]: value } as Partial<MediaGenerationSettings>)} ariaLabel={`${kind} provider`} />
        </SettingRow>
        {info && info.id !== 'chatgpt' && (
          <SettingRow
            title={kind === 'video' ? 'Video model' : 'Image model'}
            detail={customDef ? `Required: the ${kind} model id on ${customDef.label}. Suggestions come from its live list.` : 'Leave blank for the default.'}
          >
            <input
              type="text"
              list={customDef ? `media-models-${customDef.id}` : undefined}
              value={settings[modelsField][info.id] ?? ''}
              placeholder={fallback ?? (kind === 'video' ? 'e.g. sora-2' : 'e.g. gpt-image-1')}
              onChange={(event) => update({ [modelsField]: { ...settings[modelsField], [info.id]: event.target.value } } as Partial<MediaGenerationSettings>)}
            />
            {customDef && (
              <datalist id={`media-models-${customDef.id}`}>
                {(liveMediaModels[customDef.id] ?? []).map((id) => <option key={id} value={id} />)}
              </datalist>
            )}
          </SettingRow>
        )}
      </>
    );
  };

  return (
    <Section title="Image & video generation">
      <p className="shell-hint">
        Generates media using your ChatGPT plan or API keys. Outputs save to the project&apos;s generations folder.
      </p>
      {providerRow('image')}
      {providerRow('video')}
      {keyProviders.map((p) => (
        <div key={p.id}>
          <SettingRow title={`${p.label} API key`} detail={keys[p.id] ? 'Saved' : 'Not saved'}>
            <input
              type="password"
              value={keyInput[p.id] ?? ''}
              placeholder={keys[p.id] ? 'Key saved in OS keychain' : 'Paste key'}
              onChange={(event) => setKeyInput((current) => ({ ...current, [p.id]: event.target.value }))}
              onKeyDown={(event) => { if (event.key === 'Enter') void saveKey(p.id, keyInput[p.id] ?? ''); }}
            />
          </SettingRow>
          <div className="settings-action-row">
            <button className="settings-primary" onClick={() => void saveKey(p.id, keyInput[p.id] ?? '')} disabled={!(keyInput[p.id] ?? '').trim()}>Save key</button>
            <button className="settings-secondary" onClick={() => void saveKey(p.id, '')} disabled={!keys[p.id]}>Clear key</button>
            <button className="settings-link-button" onClick={() => openExternalUrl(p.keyUrl!)}>Get a {p.label} key</button>
          </div>
        </div>
      ))}
      {keyError && <p className="shell-hint">{keyError}</p>}
    </Section>
  );
}

/**
 * Settings > MCP: the tool servers every agent is given.
 *
 * Spacron's own server and the Playwright one are shown but not editable here
 * — they are owned by the app and by the Browser tools setting respectively.
 * Everything below them is the user's list (typed in, or installed from the
 * catalog), written into each CLI's own config file as soon as it changes. See `services/mcp-servers.ts`
 * for the dialects and the namespace rule that makes removal safe.
 */
function McpSettingsPane() {
  const servers = useStore(mcpServers);
  const browserOn = useStore(agentBrowserTools);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [draft, setDraft] = useState<McpServer | null>(null);
  const [headersText, setHeadersText] = useState('');
  const [argsText, setArgsText] = useState('');
  const [envText, setEnvText] = useState('');
  const [error, setError] = useState('');

  const save = (next: McpServer[]) => mcpServers.set(next);
  const closeForm = () => {
    setEditingId(null);
    setDraft(null);
    setHeadersText('');
    setArgsText('');
    setEnvText('');
    setError('');
  };
  const startAdd = () => {
    setEditingId('new');
    setDraft({ id: `mcp-${Date.now().toString(36)}`, name: '', transport: 'http', url: '', enabled: true });
    setHeadersText('');
    setArgsText('');
    setEnvText('');
    setError('');
  };
  const startEdit = (server: McpServer) => {
    setEditingId(server.id);
    setDraft({ ...server });
    setHeadersText(formatPairs(server.headers, ':'));
    setArgsText((server.args ?? []).join('\n'));
    setEnvText(formatPairs(server.env, '='));
    setError('');
  };
  const submit = () => {
    if (!draft) return;
    // The text fields become structured values only here, so a half-typed
    // header line never reaches a config file.
    const candidate: McpServer = {
      ...draft,
      name: draft.name.trim(),
      url: draft.transport === 'stdio' ? undefined : draft.url?.trim(),
      headers: draft.transport === 'stdio' ? undefined : parsePairs(headersText, ':'),
      command: draft.transport === 'stdio' ? draft.command?.trim() : undefined,
      args: draft.transport === 'stdio' ? parseLines(argsText) : undefined,
      env: draft.transport === 'stdio' ? parsePairs(envText, '=') : undefined,
    };
    const problem = validateServer(candidate, servers);
    if (problem) { setError(problem); return; }
    save(editingId === 'new' ? [...servers, candidate] : servers.map((s) => (s.id === candidate.id ? candidate : s)));
    closeForm();
  };
  const remote = draft?.transport !== 'stdio';

  return (
    <>
      <Section title="Built in">
        <p className="shell-hint" style={{ marginTop: 0, marginBottom: '14px' }}>
          Core tool servers provided automatically by Spacron.
        </p>
        <div className="agent-list">
          <div className="agent-row">
            <div className="agent-meta">
              <div className="agent-name-row"><span className="agent-name">Spacron</span></div>
              <small className="shell-hint">
                Inter-agent communication and emulator controls.
              </small>
            </div>
          </div>
          <div className="agent-row">
            <div className="agent-meta">
              <div className="agent-name-row"><span className="agent-name">Playwright browser</span></div>
              <small className="shell-hint">
                Allows agents to inspect web pages and verify UI.
              </small>
            </div>
            <Toggle
              label="Toggle the Playwright browser server"
              checked={browserOn}
              onChange={(on) => agentBrowserTools.set(on)}
            />
          </div>
        </div>
      </Section>

      <Section title="Plugins">
        <McpCatalog
          onOpenUrl={openExternalUrl}
          onAddCustomServer={() => {
            startAdd();
            requestAnimationFrame(() =>
              document.querySelector('[data-settings-section="your-servers"]')?.scrollIntoView({ block: 'start', behavior: 'smooth' }),
            );
          }}
        />
      </Section>

      <Section title="Your servers">
        <p className="shell-hint" style={{ marginTop: 0, marginBottom: '14px' }}>
          Connect local or hosted MCP servers to add tools across all agent CLIs.
        </p>
        {servers.length > 0 && (
          <div className="agent-list">
            {servers.map((server) => {
              const problem = validateServer(server, servers);
              return (
                <div className="agent-row" key={server.id}>
                  <div className="agent-meta">
                    <div className="agent-name-row mcp-server-name-row">
                      <ServerIcon server={server} />
                      <span className="agent-name">{server.name || 'Unnamed server'}</span>
                      <span className="mcp-catalog-badge">
                        {server.transport === 'stdio' ? 'Local' : server.transport.toUpperCase()}
                      </span>
                    </div>
                    <small className="shell-hint">
                      {server.transport === 'stdio'
                        ? [server.command, ...(server.args ?? [])].filter(Boolean).join(' ')
                        : server.url}
                    </small>
                    {problem && <small className="shell-hint mcp-server-problem">{problem}</small>}
                    {headersLostOnCodex(server) && (
                      <small className="shell-hint">
                        Codex does not support request headers; other agents will receive them.
                      </small>
                    )}
                  </div>
                  <Toggle
                    label={`Toggle the ${server.name} server`}
                    checked={server.enabled}
                    onChange={(on) => save(servers.map((s) => (s.id === server.id ? { ...s, enabled: on } : s)))}
                  />
                  <button type="button" className="settings-secondary" onClick={() => startEdit(server)}>Edit</button>
                  <button
                    type="button"
                    className="agent-remove"
                    onClick={() => { save(servers.filter((s) => s.id !== server.id)); if (editingId === server.id) closeForm(); }}
                    aria-label={`Remove ${server.name}`}
                  >
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><path d="M3 6h18M8 6V4h8v2m-1 0v14H9V6"/></svg>
                  </button>
                </div>
              );
            })}
          </div>
        )}

        {draft ? (
          <div className="agent-add-container">
            <h4 className="agent-add-title">{editingId === 'new' ? 'Add a server' : `Edit ${draft.name || 'server'}`}</h4>
            <input
              className="agent-input"
              type="text"
              placeholder="Name (e.g. Linear)"
              value={draft.name}
              onChange={(e) => setDraft({ ...draft, name: e.target.value })}
              maxLength={60}
            />
            <div className="settings-action-row" style={{ marginTop: '8px' }}>
              {(['http', 'sse', 'stdio'] as const).map((transport) => (
                <button
                  key={transport}
                  type="button"
                  className={draft.transport === transport ? 'settings-primary' : 'settings-secondary'}
                  onClick={() => setDraft({ ...draft, transport })}
                >
                  {transport === 'http' ? 'Remote (HTTP)' : transport === 'sse' ? 'Remote (SSE)' : 'Local command'}
                </button>
              ))}
            </div>
            {remote ? (
              <>
                <input
                  className="agent-input mcp-field"
                  type="text"
                  placeholder="https://mcp.example.com/mcp"
                  value={draft.url ?? ''}
                  onChange={(e) => setDraft({ ...draft, url: e.target.value })}
                />
                <textarea
                  className="agent-input mcp-textarea"
                  placeholder={'Headers, one per line (optional):\nAuthorization: Bearer your-token'}
                  value={headersText}
                  onChange={(e) => setHeadersText(e.target.value)}
                  rows={3}
                />
              </>
            ) : (
              <>
                <input
                  className="agent-input mcp-field"
                  type="text"
                  placeholder="Command (e.g. npx)"
                  value={draft.command ?? ''}
                  onChange={(e) => setDraft({ ...draft, command: e.target.value })}
                />
                <textarea
                  className="agent-input mcp-textarea"
                  placeholder={'Arguments, one per line (optional):\n-y\n@some/mcp-server'}
                  value={argsText}
                  onChange={(e) => setArgsText(e.target.value)}
                  rows={3}
                />
                <textarea
                  className="agent-input mcp-textarea"
                  placeholder={'Environment, one per line (optional):\nAPI_TOKEN=your-token'}
                  value={envText}
                  onChange={(e) => setEnvText(e.target.value)}
                  rows={2}
                />
              </>
            )}
            {error && <p className="shell-hint mcp-server-problem">{error}</p>}
            <div className="settings-action-row">
              <button type="button" className="settings-primary" onClick={submit}>
                {editingId === 'new' ? 'Add server' : 'Save server'}
              </button>
              <button type="button" className="settings-secondary" onClick={closeForm}>Cancel</button>
            </div>
          </div>
        ) : (
          <div className="settings-action-row">
            <button type="button" className="settings-primary" onClick={startAdd}>Add a server</button>
          </div>
        )}
      </Section>
    </>
  );
}

function skillTitleCase(title: string): string {
  return title.toLowerCase().replace(/\b[a-z]/g, (c) => c.toUpperCase());
}

/**
 * Settings > Orchestrator: the brain's skills (built-in toggles plus the
 * user's own) and what it has learned about the user and project. Skills feed
 * `buildSkillsPrompt`; learned entries are the evolve.ts profile.
 */
function OrchestratorSettingsPane() {
  const disabled = useStore(orchestratorDisabledSkills);
  const customSkills = sanitizeCustomSkills(useStore(orchestratorCustomSkills));
  const learnedGlobal = useStore(globalOrchestratorProfile);
  const learnedByProject = useStore(orchestratorProfile);
  const projectId = useStore(activeProjectId);
  const learnedProject = projectId ? learnedByProject[projectId] ?? [] : [];
  const [editingId, setEditingId] = useState<string | null>(null);
  const [title, setTitle] = useState('');
  const [instructions, setInstructions] = useState('');
  const [error, setError] = useState('');
  const [openSkillId, setOpenSkillId] = useState<string | null>(null);

  const toggleBuiltIn = (id: string, on: boolean) => {
    orchestratorDisabledSkills.set(on ? disabled.filter((item) => item !== id) : [...new Set([...disabled, id])]);
  };
  const saveSkills = (next: CustomSkill[]) => orchestratorCustomSkills.set(sanitizeCustomSkills(next));
  const resetForm = () => { setEditingId(null); setTitle(''); setInstructions(''); setError(''); };
  const submit = () => {
    const cleanTitle = title.trim();
    const cleanText = instructions.trim();
    if (!cleanTitle || !cleanText) { setError('Give the skill a name and some instructions.'); return; }
    if (editingId) {
      saveSkills(customSkills.map((skill) => (skill.id === editingId ? { ...skill, title: cleanTitle, instructions: cleanText } : skill)));
    } else {
      if (customSkills.length >= 12) { setError('You can have up to 12 skills. Remove one to add another.'); return; }
      saveSkills([...customSkills, { id: `skill-${Date.now().toString(36)}`, title: cleanTitle, instructions: cleanText, enabled: true }]);
    }
    resetForm();
  };
  const learned = [
    ...learnedGlobal.map((entry) => ({ entry, where: 'About you' })),
    ...learnedProject.map((entry) => ({ entry, where: 'This project' })),
  ];

  return (
    <>
      <Section title="Built-in skills">
        <p className="shell-hint" style={{ marginTop: 0, marginBottom: '14px' }}>
          Core guidelines followed by the orchestrator on every turn.
        </p>
        {BRAIN_SKILLS.map((skill) => (
          <SkillRow
            key={skill.id}
            title={skillTitleCase(skill.title)}
            detail={skill.summary}
            expanded={openSkillId === skill.id}
            onToggleOpen={() => setOpenSkillId(openSkillId === skill.id ? null : skill.id)}
            body={
              <>
                <ul className="skill-rules">
                  {skill.rules.map((rule) => <li key={rule}>{rule}</li>)}
                </ul>
                <p className="skill-readonly-note">Built-in skills are read-only. Switch it off if you do not want it.</p>
              </>
            }
          >
            <Toggle
              label={`Toggle the ${skillTitleCase(skill.title)} skill`}
              checked={!disabled.includes(skill.id)}
              onChange={(on) => toggleBuiltIn(skill.id, on)}
            />
          </SkillRow>
        ))}
      </Section>

      <Section title="Your skills">
        <p className="shell-hint" style={{ marginTop: 0, marginBottom: '14px' }}>
          Custom instructions for your stack, workflow, and coding style.
        </p>
        {customSkills.length > 0 && (
          <div className="agent-list">
            {customSkills.map((skill) => (
              <div className="agent-row" key={skill.id}>
                <button
                  type="button"
                  className="agent-meta skill-open-btn"
                  aria-expanded={openSkillId === skill.id}
                  onClick={() => setOpenSkillId(openSkillId === skill.id ? null : skill.id)}
                  title={openSkillId === skill.id ? 'Collapse' : 'Read the full skill'}
                >
                  <div className="agent-name-row">
                    <span className="agent-name">{skill.title}</span>
                    <SkillChevron open={openSkillId === skill.id} />
                  </div>
                  {openSkillId === skill.id ? (
                    <small className="shell-hint skill-full-text">{skill.instructions}</small>
                  ) : (
                    <small className="shell-hint">{skill.instructions.length > 140 ? `${skill.instructions.slice(0, 140)}…` : skill.instructions}</small>
                  )}
                </button>
                <Toggle
                  label={`Toggle the ${skill.title} skill`}
                  checked={skill.enabled}
                  onChange={(on) => saveSkills(customSkills.map((item) => (item.id === skill.id ? { ...item, enabled: on } : item)))}
                />
                <button type="button" className="settings-secondary" onClick={() => { setEditingId(skill.id); setTitle(skill.title); setInstructions(skill.instructions); setError(''); }}>
                  Edit
                </button>
                <button
                  type="button"
                  className="agent-remove"
                  onClick={() => { saveSkills(customSkills.filter((item) => item.id !== skill.id)); if (editingId === skill.id) resetForm(); }}
                  aria-label={`Remove ${skill.title}`}
                >
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><path d="M3 6h18M8 6V4h8v2m-1 0v14H9V6"/></svg>
                </button>
              </div>
            ))}
          </div>
        )}
        <div className="agent-add-container">
          <h4 className="agent-add-title">{editingId ? 'Edit skill' : 'Add a skill'}</h4>
          <input
            className="agent-input"
            type="text"
            placeholder="Name (e.g. Our React conventions)"
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            maxLength={60}
          />
          <textarea
            className="agent-input"
            placeholder={'Instructions, one per line. For example:\n- Use function components and hooks, never classes.\n- Put API calls in src/api, never inside components.\n- Run npm test before saying a change is done.'}
            value={instructions}
            onChange={(e) => setInstructions(e.target.value)}
            maxLength={MAX_CUSTOM_SKILL_CHARS}
            rows={14}
            style={{ width: '100%', minHeight: '240px', marginTop: '8px', resize: 'vertical', fontFamily: 'inherit', lineHeight: 1.5, boxSizing: 'border-box' }}
          />
          <div className="settings-action-row">
            <button type="button" className="settings-primary" onClick={submit}>{editingId ? 'Save skill' : 'Add skill'}</button>
            {editingId && <button type="button" className="settings-secondary" onClick={resetForm}>Cancel</button>}
          </div>
          {error && <p className="agent-error">{error}</p>}
        </div>
      </Section>

      <Section title="What it has learned">
        <p className="shell-hint" style={{ marginTop: 0, marginBottom: '14px' }}>
          Preferences and project rules automatically learned from past conversations.
        </p>
        {learned.length === 0 ? (
          <p className="shell-hint">Nothing learned yet.</p>
        ) : (
          <div className="agent-list">
            {learned.map(({ entry, where }) => (
              <div className="agent-row" key={entry.id}>
                <div className="agent-meta">
                  <div className="agent-name-row">
                    <span className="agent-name">{entry.text}</span>
                  </div>
                  <small className="shell-hint">{where}{entry.uses >= FIRM_RULE_USES ? ' · firm rule' : ''}</small>
                </div>
                <button type="button" className="agent-remove" onClick={() => void removeProfileEntry(projectId, entry.id)} aria-label={`Forget: ${entry.text}`}>
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><path d="M3 6h18M8 6V4h8v2m-1 0v14H9V6"/></svg>
                </button>
              </div>
            ))}
          </div>
        )}
        {learned.length > 0 && (
          <div className="settings-action-row">
            <button type="button" className="settings-secondary" onClick={() => void clearLearnedProfile(projectId)}>Forget everything</button>
          </div>
        )}
      </Section>
    </>
  );
}

function ModelSelect({
  value,
  models,
  onChange,
  label,
  renderIcon,
}: {
  value: string;
  models: AiModelOption[];
  onChange: (value: string) => void;
  label: string;
  renderIcon?: (id: string) => React.ReactNode;
}) {
  return (
    <StyledSelect
      value={value}
      options={models.map((m) => ({
        id: m.id,
        label: m.label,
        disabled: m.supported === false,
        disabledReason: m.supportReason,
      }))}
      onChange={onChange}
      ariaLabel={label}
      showSearch={true}
      renderIcon={renderIcon}
    />
  );
}

function ShortcutEditor({
  shortcuts,
  onUpdate,
  onDelete,
}: {
  shortcuts: KeyboardShortcut[];
  onUpdate: (id: string, keys: string, when?: string) => void;
  onDelete: (id: string) => void;
}) {
  const grouped = useMemo(() => {
    const groups = new Map<string, KeyboardShortcut[]>();
    for (const shortcut of shortcuts) {
      const category = shortcut.id.startsWith('custom_')
        ? 'Custom Shortcuts'
        : shortcut.id.includes('Terminal') || shortcut.id === 'newTerminal'
          ? 'Terminal'
          : shortcut.id.includes('zoom') || shortcut.id.includes('Zoom')
            ? 'Window'
            : shortcut.id.includes('Preview') || shortcut.id.includes('proxy')
              ? 'Preview'
              : shortcut.id.includes('File') || shortcut.id.includes('Folder')
                ? 'File'
                : shortcut.id.includes('Voice')
                  ? 'Voice'
                  : 'Workspace';
      groups.set(category, [...(groups.get(category) ?? []), shortcut]);
    }
    return [...groups.entries()];
  }, [shortcuts]);

  return (
    <div className="shortcut-groups">
      {grouped.map(([group, items]) => (
        <div className="shortcut-group" key={group}>
          <h4>{group}</h4>
          {items.map((shortcut) => (
            <div className="shortcut-row-container" key={shortcut.id}>
              <label className="shortcut-row">
                <span>{shortcut.label}</span>
                {shortcut.when && (
                  <span style={{ fontSize: '10px', color: 'var(--text-muted)', marginRight: '6px' }}>{shortcut.when}</span>
                )}
                <div style={{ display: 'flex', gap: '8px', alignItems: 'center' }}>
                  <input value={shortcut.keys} onChange={(event) => onUpdate(shortcut.id, event.target.value, shortcut.when)} />
                  <input
                    type="text"
                    placeholder="when (optional)"
                    value={shortcut.when ?? ''}
                    onChange={(event) => onUpdate(shortcut.id, shortcut.keys, event.target.value || undefined)}
                    style={{
                      width: '130px',
                      background: 'var(--bg-secondary)',
                      border: '1px solid var(--border)',
                      borderRadius: '4px',
                      color: 'var(--text-primary)',
                      fontSize: '11px',
                      padding: '2px 6px',
                    }}
                  />
                  {shortcut.id.startsWith('custom_') && (
                    <button 
                      type="button"
                      className="settings-delete-btn"
                      onClick={() => onDelete(shortcut.id)}
                      title="Delete Custom Shortcut"
                      style={{
                        background: 'rgba(248, 113, 113, 0.1)',
                        color: 'var(--error)',
                        border: '1px solid rgba(248, 113, 113, 0.2)',
                        borderRadius: '6px',
                        padding: '4px 8px',
                        fontSize: '11px',
                        cursor: 'pointer'
                      }}
                    >
                      Delete
                    </button>
                  )}
                </div>
              </label>
              {shortcut.id.startsWith('custom_') && shortcut.action && (
                <div style={{ paddingLeft: '8px', fontSize: '11px', color: 'var(--text-muted)' }}>
                  Action: <code>{shortcutActions.find((a) => a.id === shortcut.action)?.label ?? shortcut.action}</code>
                </div>
              )}
            </div>
          ))}
        </div>
      ))}
    </div>
  );
}

/** The same pin the Chat picker shows, so either place can star an agent. */
function FavouriteStar({ command, name }: { command: string; name: string }) {
  const favourites = useStore(favouriteAgentCommands);
  const pinned = favourites.includes(command.trim().toLowerCase());
  return (
    <button
      type="button"
      onClick={() => toggleFavouriteAgent(command)}
      aria-pressed={pinned}
      aria-label={pinned ? `Unpin ${name}` : `Pin ${name} to the top of Chat`}
      title={pinned ? `Unpin ${name}` : `Pin ${name} to the top of Chat`}
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
        width: '26px',
        height: '26px',
        padding: 0,
        border: 0,
        borderRadius: '6px',
        background: 'transparent',
        color: pinned ? 'var(--accent)' : 'var(--text-tertiary)',
        cursor: 'pointer',
        opacity: pinned ? 1 : 0.7,
      }}
    >
      <svg viewBox="0 0 24 24" width="14" height="14" aria-hidden="true">
        <path
          d="M12 3.5l2.6 5.3 5.9.9-4.3 4.1 1 5.8-5.2-2.7-5.2 2.7 1-5.8L3.5 9.7l5.9-.9z"
          fill={pinned ? 'currentColor' : 'none'}
          stroke="currentColor"
          strokeWidth="1.6"
          strokeLinejoin="round"
        />
      </svg>
    </button>
  );
}

/**
 * Managed agent binary installs: lists ACP registry agents that have a binary
 * distribution for this platform, shows install status, and offers one-click
 * install with sha256 verification — matching T3 Code's registry-managed installs.
 */
function ManagedAgentInstalls() {
  const [statuses, setStatuses] = useState<Map<string, AgentBinaryStatus>>(new Map());
  const [agentEntries, setAgentEntries] = useState<Array<{ agent: AcpRegistryAgent; binary: any }>>([]);
  const [busy, setBusy] = useState<Set<string>>(new Set());
  const [note, setNote] = useState<string>('');

  useEffect(() => {
    void fetchAcpRegistry().then((agents) => {
      const next: Array<{ agent: AcpRegistryAgent; binary: any }> = [];
      for (const agent of agents) {
        const binary = agent.distribution.find((d: any) => d.kind === 'binary');
        if (binary) next.push({ agent, binary });
      }
      setAgentEntries(next);
      for (const { agent } of next) {
        void agentBinaryStatus(agent.id, agent.version).then((status) => {
          if (!status) return;
          setStatuses((prev) => new Map(prev).set(agent.id, status));
        });
      }
    }).catch(() => {});
  }, []);

  async function install(agent: AcpRegistryAgent, binary: any) {
    setBusy((prev) => new Set(prev).add(agent.id));
    setNote('');
    try {
      const url = binary.kind === 'binary' ? binary.url : '';
      const sha256 = binary.sha256 ?? '';
      const cmd = binary.cmd ?? binary.command ?? 'agent';
      const next = await agentBinaryInstall(agent.id, agent.version, url, sha256, cmd);
      setStatuses((prev) => new Map(prev).set(agent.id, next));
      const installedPath = next.path;
      if (installedPath) {
        void import('$lib/stores/acpRegistry').then(({ setAcpCommandOverride }) => {
          setAcpCommandOverride(agent.id, installedPath);
        });
        setNote(`Installed ${agent.name} v${agent.version}. Chat will launch ${installedPath}.`);
      } else {
        setNote(`Installed ${agent.name} v${agent.version}.`);
      }
    } catch (error) {
      setNote(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy((prev) => { const next = new Set(prev); next.delete(agent.id); return next; });
    }
  }

  if (agentEntries.length === 0) {
    return (
      <div className="agent-list" style={{ padding: '8px 0' }}>
        <p className="shell-hint">No managed binary installs available for this platform.</p>
      </div>
    );
  }

  return (
    <div className="agent-list">
      {agentEntries.map(({ agent, binary }) => {
        const status = statuses.get(agent.id);
        const installed = status?.installed === true;
        const detail = !status
          ? 'Checking install status…'
          : installed
            ? `v${status.version} · ${status.path ?? ''}`
            : status.supported
              ? `Not installed · v${agent.version}`
              : 'No binary for this platform';
        return (
          <div className="agent-row" key={agent.id}>
            <span className="agent-row-icon" aria-hidden="true">
              <AgentBrandMark command={binary.cmd ?? agent.id} name={agent.name} />
            </span>
            <div className="agent-meta">
              <div className="agent-name-row"><span className="agent-name">{agent.name}</span></div>
              <div className="agent-cmd">{binary.cmd ?? agent.id} · v{agent.version}</div>
              <span className="shell-hint">{agent.description}</span>
            </div>
            <div style={{ display: 'flex', gap: '8px', alignItems: 'center' }}>
              {note && <span className="shell-hint" style={{ maxWidth: '320px' }}>{note}</span>}
              <button
                className="agent-add-btn"
                type="button"
                onClick={() => void install(agent, binary)}
                disabled={busy.has(agent.id) || !status?.supported || installed}
              >
                {busy.has(agent.id) ? 'Installing…' : installed ? 'Reinstall' : 'Install'}
              </button>
            </div>
            <span className="shell-hint" style={{ fontSize: '11px', color: 'var(--text-muted)', marginTop: '4px', display: 'block' }}>
              {detail}
            </span>
          </div>
        );
      })}
    </div>
  );
}

/**
 * Antigravity's ACP server is a separate runtime (Google's `agy_acp_server`
 * archive), not the `agy` CLI, so its install lives here: one click downloads
 * the registry archive, verifies it, and points Chat at the result. A manual
 * binary path still wins, because the field below is what Chat actually spawns.
 */
function AntigravityRuntimeRow() {
  const [status, setStatus] = useState<AntigravityRuntimeStatus | null>(null);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState('');

  useEffect(() => {
    void getAntigravityRuntimeStatus().then(setStatus);
  }, []);

  async function install() {
    setBusy(true);
    setNote('');
    try {
      const next = await installAntigravityRuntime();
      setStatus(next);
      if (next.path) setAcpCommandOverride('agy', next.path);
      setNote(next.path ? `Installed ${next.version}. Chat will launch ${next.path}.` : `Installed ${next.version}.`);
    } catch (error) {
      setNote(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  }

  const installed = status?.installed === true;
  const detail = status === null
    ? 'Checking for the installed runtime…'
    : installed
      ? `v${status.version} · ${status.path}`
      : status.supported
        ? `Not installed · v${status.version}`
        : 'Google publishes no runtime for this platform';

  return (
    <SettingRow title="Antigravity runtime" detail={detail}>
      <div style={{ display: 'flex', gap: '12px', alignItems: 'center', justifyContent: 'flex-end', flexWrap: 'wrap' }}>
        {note && <span className="shell-hint" style={{ maxWidth: '320px' }}>{note}</span>}
        <button
          className="agent-add-btn"
          type="button"
          onClick={() => void install()}
          disabled={busy || status?.supported === false}
        >
          {busy ? 'Installing…' : installed ? 'Reinstall' : 'Install runtime'}
        </button>
      </div>
    </SettingRow>
  );
}

export default function SettingsModal({ onclose }: SettingsModalProps) {
  // Re-render when custom providers load or change: every provider picker
  // here reads `aiProviders`, which they are merged into.
  useStore(customProviders);
  // Seeded from the store so a caller can deep-link a section — the palette's
  // "Customize Theme…" opens straight onto Appearance instead of General.
  const [activeTab, setActiveTab] = useState<Tab>(
    () => useLayoutStore.getState().settingsInitialTab ?? 'general',
  );
  const [settingsQuery, setSettingsQuery] = useState('');

  const settingsSearchResults = useMemo(() => {
    // A tab hidden from the nav must not be reachable through search either.
    const query = settingsQuery.trim().toLowerCase();
    if (!query) return [];
    return settingsSearchEntries
      .filter((entry) => {
        if (!settingsNavGroups.some((group) => group.tabs.includes(entry.tab))) return false;
        const haystack = `${entry.label} ${entry.section} ${entry.tab} ${entry.keywords ?? ''}`.toLowerCase();
        return haystack.includes(query);
      })
      .slice(0, 8);
  }, [settingsQuery]);

  function selectSettingsSearchResult(result: SettingsSearchEntry) {
    setActiveTab(result.tab);
    setSettingsQuery('');
    window.setTimeout(() => {
      const modal = document.querySelector('.settings-modal');
      if (!modal) return;
      const attribute = result.target === 'section' ? 'data-settings-section' : 'data-settings-key';
      const key = settingsSearchKey(result.target === 'section' ? result.section : result.label);
      const target = Array.from(modal.querySelectorAll<HTMLElement>(`[${attribute}]`))
        .find((element) => element.getAttribute(attribute) === key);
      target?.scrollIntoView({ behavior: 'smooth', block: 'center' });
    }, 0);
  }

  // Which half of the Voice tab is showing. History lives INSIDE that tab
  // rather than as a tenth top-level tab — it is voice output, not its own
  // area of the app — and the choice sticks while the modal is open.
  const [voiceView, setVoiceView] = useState<'settings' | 'history'>('settings');

  // Local models downloader state
  const [localModels, setLocalModels] = useState<any[]>([]);
  const [downloadProgress, setDownloadProgress] = useState<Record<string, { progress: number; phase: string }>>({});
  const [localModelsLoading, setLocalModelsLoading] = useState(false);

  const loadLocalModels = useCallback(async () => {
    if (!isTauriRuntime()) return;
    setLocalModelsLoading(true);
    try {
      const models = await invoke<any[]>('list_downloadable_models');
      setLocalModels(models);
    } catch (err) {
      showToast(String(err), 'error');
    } finally {
      setLocalModelsLoading(false);
    }
  }, []);

  const handleDownloadModel = useCallback(async (modelId: string) => {
    if (!isTauriRuntime()) return;
    setDownloadProgress(prev => ({ ...prev, [modelId]: { progress: 0, phase: 'initiating' } }));
    try {
      await invoke('download_model', { modelId });
      showToast('Download started in background', 'info');
    } catch (err) {
      setDownloadProgress(prev => {
        const next = { ...prev };
        delete next[modelId];
        return next;
      });
      showToast(String(err), 'error');
    }
  }, []);

  const handleCancelDownload = useCallback(async (modelId: string) => {
    if (!isTauriRuntime()) return;
    try {
      await invoke('cancel_download', { modelId });
    } catch (err) {
      showToast(String(err), 'error');
    }
  }, []);

  const handleDeleteModel = useCallback(async (modelId: string) => {
    let confirmed = false;
    if (isTauriRuntime()) {
      try {
        const { ask } = await import('@tauri-apps/plugin-dialog');
        confirmed = await ask('Are you sure you want to delete this model?', {
          title: 'Delete Model',
          kind: 'warning',
        });
      } catch (err) {
        console.error('Failed to show Tauri ask dialog:', err);
        confirmed = window.confirm('Are you sure you want to delete this model?');
      }
    } else {
      confirmed = window.confirm('Are you sure you want to delete this model?');
    }

    if (!confirmed) return;
    try {
      await invoke('delete_model', { modelId });
      showToast('Model deleted successfully', 'success');
      void loadLocalModels();
    } catch (err) {
      showToast(String(err), 'error');
    }
  }, [loadLocalModels]);

  useEffect(() => {
    if (activeTab === 'models') {
      void loadLocalModels();
    }
  }, [activeTab, loadLocalModels]);

  useEffect(() => {
    if (!isTauriRuntime()) return;
    
    let unlistenProgress: (() => void) | undefined;
    let unlistenError: (() => void) | undefined;
    let unlistenCancelled: (() => void) | undefined;
    
    const setupListeners = async () => {
      unlistenProgress = await listen<any>('download-progress', (event) => {
        const { model_id, progress, phase } = event.payload;
        setDownloadProgress((prev) => ({
          ...prev,
          [model_id]: { progress, phase },
        }));
        
        if (phase === 'done') {
          void loadLocalModels();
          setDownloadProgress((prev) => {
            const next = { ...prev };
            delete next[model_id];
            return next;
          });
          showToast(`Model downloaded successfully`, 'success');
        }
      });

      unlistenError = await listen<any>('download-error', (event) => {
        const { model_id, error } = event.payload;
        setDownloadProgress((prev) => {
          const next = { ...prev };
          delete next[model_id];
          return next;
        });
        showToast(`Failed to download model: ${error}`, 'error');
      });

      unlistenCancelled = await listen<any>('download-cancelled', (event) => {
        const { model_id } = event.payload;
        setDownloadProgress((prev) => {
          const next = { ...prev };
          delete next[model_id];
          return next;
        });
        showToast('Download cancelled', 'info');
      });
    };
    
    void setupListeners();
    
    return () => {
      if (unlistenProgress) unlistenProgress();
      if (unlistenError) unlistenError();
      if (unlistenCancelled) unlistenCancelled();
    };
  }, [loadLocalModels]);

  const $customAgents = useStore(customAgents);
  const $acpExplicitCommands = useStore(acpExplicitCommands);
  const $acpCommandOverrides = useStore(acpCommandOverrides);
  // Every launchable agent not already listed above as a custom ACP agent. Any
  // of them can be declared ACP here — that is how a preset like Claude Code or
  // Antigravity reaches the native ACP transport — and each gets the Chat
  // enable switch whether it is native ACP or only declared so.
  const acpRoster = useMemo(
    () => getAgentRoster().filter((agent) => !$customAgents.some((custom) => custom.supportsAcp && custom.command === agent.command)),
    [$customAgents],
  );
  const acpRegistryOn = useStore(acpRegistryEnabled);
  const disabledAcpCommands = useStore(acpDisabledCommands);

  const [newAgentName, setNewAgentName] = useState('');
  const [newAgentCommand, setNewAgentCommand] = useState('');
  const [newAgentReadsRules, setNewAgentReadsRules] = useState(true);
  const [newAgentSupportsAcp, setNewAgentSupportsAcp] = useState(false);
  const [newAgentRegistryId, setNewAgentRegistryId] = useState('');
  const [acpAgents, setAcpAgents] = useState<AcpRegistryAgent[]>([]);
  const [acpLoading, setAcpLoading] = useState(false);
  const [acpError, setAcpError] = useState('');
  const [agentFormError, setAgentFormError] = useState('');
  // Result of asking the entered CLI whether it reads a rules file. `null` means
  // nothing has been checked yet (empty field, or a check in flight).
  const [rulesDetection, setRulesDetection] = useState<RulesFileDetection | null>(null);
  const [rulesDetecting, setRulesDetecting] = useState(false);
  // Set once the user clicks the checkbox themselves. Detection pre-fills the
  // box, but it must never yank a deliberate choice back — the user knows their
  // own CLI better than a byte scan does. A ref, not state: this is read when a
  // probe resolves, and making it a dependency would re-probe (relaunching a
  // process) every time the box is ticked.
  const rulesTouched = useRef(false);

  // Ask the entered CLI whether it reads a rules file, and pre-fill the
  // checkbox with the answer. Debounced because it launches a process: we want
  // one probe when typing settles, not one per keystroke. The generation guard
  // drops results from a command the user has already edited past.
  const rulesProbeGeneration = useRef(0);
  useEffect(() => {
    const command = newAgentCommand.trim();
    const generation = ++rulesProbeGeneration.current;
    if (!command) {
      setRulesDetection(null);
      setRulesDetecting(false);
      return;
    }
    setRulesDetecting(true);
    const timer = setTimeout(() => {
      void detectRulesFileSupport(command).then((detection) => {
        if (rulesProbeGeneration.current !== generation) return;
        setRulesDetection(detection);
        setRulesDetecting(false);
        if (!rulesTouched.current) setNewAgentReadsRules(detection.readsRulesFile);
      });
    }, 600);
    return () => clearTimeout(timer);
  }, [newAgentCommand]);

  const [customLabel, setCustomLabel] = useState('');
  const [customKeys, setCustomKeys] = useState('');
  const [customAction, setCustomAction] = useState('');
  const [customWhen, setCustomWhen] = useState('');
  const [apiKeyInput, setApiKeyInput] = useState('');
  // This selects which connection card is being managed. It deliberately does
  // not change the orchestrator: each Chat conversation owns that choice in
  // its composer.
  const [provider, setProvider] = useState<AiProviderId>(() => get(aiProvider));
  const [keyExists, setKeyExists] = useState(false);
  const [groqKeyExists, setGroqKeyExists] = useState(false);
  const [openaiKeyExists, setOpenaiKeyExists] = useState(false);
  const [xaiKeyExists, setXaiKeyExists] = useState(false);
  const [vercelKeyExists, setVercelKeyExists] = useState(false);
  const [providerLiveModels, setProviderLiveModels] = useState<Record<string, AiModelOption[]>>({});
  const [modelLoading, setModelLoading] = useState(false);
  const [providerModelError, setProviderModelError] = useState('');
  const [localUrlInput, setLocalUrlInput] = useState('');
  const providerLiveModelsRef = useRef<Record<string, AiModelOption[]>>({});

  useEffect(() => {
    providerLiveModelsRef.current = providerLiveModels;
  }, [providerLiveModels]);

  const [completionLiveModels, setCompletionLiveModels] = useState<Record<string, AiModelOption[]>>({});
  const completionLiveModelsRef = useRef<Record<string, AiModelOption[]>>({});

  useEffect(() => {
    completionLiveModelsRef.current = completionLiveModels;
  }, [completionLiveModels]);

  const [providerSttModels, setProviderSttModels] = useState<Record<string, AiModelOption[]>>({});
  const [sttModelLoading, setSttModelLoading] = useState(false);
  const [providerRealtimeModels, setProviderRealtimeModels] = useState<Record<string, AiModelOption[]>>({});
  const [realtimeModelLoading, setRealtimeModelLoading] = useState(false);
  const providerRealtimeModelsRef = useRef<Record<string, AiModelOption[]>>({});

  useEffect(() => {
    providerRealtimeModelsRef.current = providerRealtimeModels;
  }, [providerRealtimeModels]);

  const [updateMessage, setUpdateMessage] = useState('');
  const [availableShells, setAvailableShells] = useState<ShellInfo[]>([]);

  const currentActiveTheme = useStore(activeTheme);
  const bgPresent = useStore(backgroundImagePresent);
  const pageRef = useRef<HTMLDivElement | null>(null);
  const panelRef = useRef<HTMLDivElement | null>(null);

  const github = useGithubSignIn();
  const [githubCopied, setGithubCopied] = useState(false);

  const gitlabSc = useSourceControlSignIn('gitlab');
  const bitbucketSc = useSourceControlSignIn('bitbucket');
  const otherSc = useSourceControlSignIn('other');
  const [tokenDrafts, setTokenDrafts] = useState<Record<string, string>>({});

  async function copyGithubCode() {
    if (!github.device) return;
    try {
      await navigator.clipboard.writeText(github.device.user_code);
      setGithubCopied(true);
      window.setTimeout(() => setGithubCopied(false), 1500);
    } catch {
      // Clipboard unavailable — the code is still visible on screen.
    }
  }

  // The workspace stays mounted behind this page. Reuse the focus/shortcut
  // guard for the page's lifetime, with a separate ref for content scrolling.
  useModalFocus(pageRef);

  useEffect(() => {
    function handleSettingsKeyDown(event: KeyboardEvent) {
      const target = event.target;
      if (!(target instanceof Element)) return;
      if (!pageRef.current?.contains(target) && !target.closest('.sselect-panel, .dd-menu')) return;

      // Inert keeps the workspace out of focus, but its window key listeners
      // are still alive. Consume the page's keys before they reach those panes.
      event.stopPropagation();
      if (event.key !== 'Escape' || event.defaultPrevented) return;
      // Let a portaled picker close itself before leaving Settings.
      if (document.querySelector('.sselect-panel, .dd-menu')) return;
      event.preventDefault();
      const search = pageRef.current?.querySelector<HTMLInputElement>('.settings-search-input');
      if (search?.value) {
        setSettingsQuery('');
      } else {
        onclose();
      }
    }
    document.addEventListener('keydown', handleSettingsKeyDown);
    return () => document.removeEventListener('keydown', handleSettingsKeyDown);
  }, [onclose]);

  const currentFontSize = useStore(fontSize);
  const currentFontFamily = useStore(fontFamily);
  const currentTabSize = useStore(tabSize);
  const currentWordWrap = useStore(wordWrap);
  const currentMinimap = useStore(minimap);
  const currentVimMode = useStore(vimMode);
  const currentColumnSelection = useStore(columnSelection);
  const currentEnableLsp = useStore(enableLsp);
  const currentShowHidden = useStore(showHidden);
  const currentShowSnapshotsTab = useStore(showSnapshotsTab);
  const currentPreviewPlacement = useStore(previewPlacement);
  const currentNotifications = useStore(notificationsEnabled);
  const currentAgentBrowserTools = useStore(agentBrowserTools);
  const currentComputerUse = useStore(computerUse);
  const currentAgentWorkspaceTrustOverrides = useStore(agentWorkspaceTrustOverrides);
  const currentAgentStatusHooksEnabled = useStore(agentStatusHooksEnabled);
  const currentAgentAutoGenerateTitles = useStore(agentAutoGenerateTitles);
  const currentAgentCodexOwnServer = useStore(agentCodexOwnServer);
  const currentAgentWarnCodexSharedServer = useStore(agentWarnCodexSharedServer);
  const currentProjectId = useStore(activeProjectId);
  // Null until the backend answers; the row stays disabled until then.
  const [computerUseAvailable, setComputerUseAvailable] = useState<boolean | null>(null);
  const [computerUseExpanded, setComputerUseExpanded] = useState(false);
  useEffect(() => {
    let live = true;
    void computerUseSupported().then((ok) => {
      if (live) setComputerUseAvailable(ok);
    });
    return () => {
      live = false;
    };
  }, []);
  const currentAgentFailover = useStore(agentFailover);
  const currentFailoverHeadroom = useStore(agentFailoverHeadroomPercent);
  const currentFailoverCrossProvider = useStore(agentFailoverCrossProvider);
  const currentKeepAwakeMode = useStore(keepAwakeMode);
  const currentAutoSettleEnabled = useStore(autoSettleEnabled);
  const currentAutoSettleIdleMs = useStore(autoSettleIdleMs);
  const currentSourceControlProvider = useStore(sourceControlProvider);
  const keepAwake = useStore(keepAwakeState);
  const currentCloseBehavior = useStore(closeBehavior);
  const currentZoom = useStore(uiZoom);
  const currentUiFontSize = useStore(uiFontSize);
  const currentAccentColor = useStore(accentColor);
  const currentFormatOnSave = useStore(formatOnSave);
  const currentAutoSave = useStore(autoSave);
  const currentAppearance = useStore(appearance);
  const bgEnabled = useStore(backgroundImageEnabled);
  const bgBlur = useStore(backgroundImageBlur);
  const glassOpacity = useStore(backgroundGlassOpacity);
  const vibrancy = useStore(uiVibrancy);
  const contrast = useStore(uiContrast);
  const shortcuts = useStore(userShortcuts);
  const shell = useStore(terminalShell);
  const termFontSize = useStore(terminalFontSize);
  const scrollback = useStore(terminalScrollback);
  const cursorStyle = useStore(terminalCursorStyle);
  const renderer = useStore(terminalRenderer);
  const update = useStore(pendingUpdate);
  const checking = useStore(updateChecking);
  const downloading = useStore(updateDownloading);
  const progress = useStore(updateProgress);
  const completionEnabled = useStore(aiGhostTextEnabled);
  const completionProvider = useStore(aiCompletionProvider);
  const completionModelMap = useStore(aiCompletionModelByProvider);
  const voiceInput = useStore(voiceInputProvider);
  const voiceInputModel = useStore(currentVoiceInputModel);
  const voiceRefinement = useStore(voiceRefinementEnabled);
  const vocabulary = useStore(dictationVocabulary);
  const smartVad = useStore(smartVadEnabled);
  const transcriptionSend = useStore(transcriptionAutoSend);
  const refinementProvider = useStore(voiceAiProvider);
  const refinementModel = useStore(currentVoiceAiModel);
  const announceCompletions = useStore(announceAgentCompletions);
  const baseUrls = useStore(aiBaseUrlByProvider);
  const defaultAccentColor = currentActiveTheme?.colors?.accent ?? (currentAppearance === 'dark' ? '#ffffff' : '#000000');
  const displayedAccentColor = currentAccentColor || defaultAccentColor;

  const providerDef = getProviderDef(provider);
  const localProvider = isLocalProvider(provider);
  // A ChatGPT sign-in stands in for this provider's key, so the rest of
  // Settings (and the model list) can treat it exactly like a saved key.
  const handleChatGptSignedIn = useCallback((signedIn: boolean) => {
    setKeyExists(signedIn);
    if (signedIn) void loadLiveModels('chatgpt', true);
  }, []);
  const completionDef = getProviderDef(completionProvider);
  const completionModels = completionLiveModels[completionProvider] ?? completionDef.models;
  const completionModel = completionModelMap[completionProvider] || completionDef.defaultModel;
  const voiceInputModels = useMemo(() => {
    const curated = getVoiceInputModelOptions(voiceInput);
    const live = providerSttModels[voiceInput as AiProviderId];
    if (!live || live.length === 0) return curated;
    const seen = new Set(curated.map((m) => m.id));
    const merged = [...curated];
    for (const m of live) {
      if (!seen.has(m.id)) {
        merged.push(m);
        seen.add(m.id);
      }
    }
    return merged;
  }, [voiceInput, providerSttModels]);

  const refinementModels = useMemo(() => {
    return providerLiveModels[refinementProvider] ?? getProviderDef(refinementProvider).models;
  }, [refinementProvider, providerLiveModels]);

  useEffect(() => {
    panelRef.current?.scrollTo({ top: 0 });
  }, [activeTab]);

  // Load available shells once on mount
  useEffect(() => {
    getAvailableShells().then(setAvailableShells).catch(() => setAvailableShells([]));
  }, []);

  const loadLiveModels = useCallback(async (prov: AiProviderId, force = false) => {
    if (!isTauriRuntime()) return;
    
    const isLocal = isLocalProvider(prov);
    const hasKey = isLocal ? true : await providerApiKeyExists(prov).catch(() => false);
    
    if (!hasKey) {
      setProviderLiveModels((prev) => {
        if (!prev[prov]) return prev;
        const next = { ...prev };
        delete next[prov];
        return next;
      });
      return;
    }

    if (!force && providerLiveModelsRef.current[prov]) {
      return;
    }
    
    setModelLoading(true);
    try {
      const remote = await listProviderModels(prov);
      if (remote.length === 0) {
        throw new Error(`${getProviderDef(prov).label} returned no usable models.`);
      }
      const curated = new Map(getProviderDef(prov).models.map((m) => [m.id, m]));
      const merged: AiModelOption[] = remote.map((r) => {
        const c = curated.get(r.id);
        return {
          id: r.id,
          label: c?.label ?? r.label ?? r.id,
          description: c?.description ?? '',
          free: c?.free ?? r.id.endsWith(':free'),
          supported: r.supported,
          supportReason: r.supportReason,
        };
      });
      setProviderLiveModels((prev) => ({
        ...prev,
        [prov]: merged,
      }));
      if (prov === provider) setProviderModelError('');
    } catch (err) {
      console.error('Failed to load models for provider:', prov, err);
      if (prov === provider) {
        setProviderModelError(
          err instanceof Error ? err.message : 'Could not load the model list.',
        );
      }
    } finally {
      setModelLoading(false);
    }
  }, [provider]);

  const loadCompletionLiveModels = useCallback(async (prov: AiProviderId, force = false) => {
    if (!isTauriRuntime()) return;
    
    const isLocal = isLocalProvider(prov);
    const hasKey = isLocal ? true : await providerApiKeyExists(prov).catch(() => false);
    
    if (!hasKey) {
      setCompletionLiveModels((prev) => {
        if (!prev[prov]) return prev;
        const next = { ...prev };
        delete next[prov];
        return next;
      });
      return;
    }

    if (!force && completionLiveModelsRef.current[prov]) {
      return;
    }
    
    try {
      const remote = await listProviderModels(prov);
      if (remote.length === 0) {
        throw new Error(`${getProviderDef(prov).label} returned no usable models.`);
      }
      const curated = new Map(getProviderDef(prov).models.map((m) => [m.id, m]));
      const merged: AiModelOption[] = remote.map((r) => {
        const c = curated.get(r.id);
        return {
          id: r.id,
          label: c?.label ?? r.label ?? r.id,
          description: c?.description ?? '',
          free: c?.free ?? r.id.endsWith(':free'),
          supported: r.supported,
          supportReason: r.supportReason,
        };
      });
      setCompletionLiveModels((prev) => ({
        ...prev,
        [prov]: merged,
      }));
    } catch (err) {
      console.error('Failed to load completion models for provider:', prov, err);
    }
  }, []);

  const loadSttModels = useCallback(async (prov: VoiceInputProviderId, force = false) => {
    if (!isTauriRuntime() || prov === 'webspeech') return;
    const pid = prov as AiProviderId;
    const isLocal = isLocalProvider(pid);
    const hasKey = isLocal ? true : await providerApiKeyExists(pid).catch(() => false);
    if (!hasKey) return;
    if (!force && providerSttModels[pid]) return;

    setSttModelLoading(true);
    try {
      const remote = await listProviderModels(pid, 'stt');
      const curated = new Map(getVoiceInputModelOptions(prov).map((m) => [m.id, m]));
      const merged: AiModelOption[] = remote.map((r) => {
        const c = curated.get(r.id);
        return {
          id: r.id,
          label: c?.label ?? r.label ?? r.id,
          description: c?.description ?? '',
        };
      });
      if (merged.length) setProviderSttModels((prev) => ({ ...prev, [pid]: merged }));
    } catch (err) {
      console.error(`Failed to load speech-to-text models for ${pid}:`, err);
    } finally {
      setSttModelLoading(false);
    }
  }, [providerSttModels]);

  const loadRealtimeModels = useCallback(async (prov: AiProviderId, force = false) => {
    if (!isTauriRuntime()) return;

    const hasKey = await providerApiKeyExists(prov).catch(() => false);
    if (!hasKey) return;

    if (!force && providerRealtimeModelsRef.current[prov]) {
      return;
    }

    setRealtimeModelLoading(true);
    try {
      const remote = await listProviderModels(prov, 'realtime');
      const merged: AiModelOption[] = remote.map((r) => ({
        id: r.id,
        label: r.label ?? r.id,
        description: '',
      }));
      if (merged.length) {
        setProviderRealtimeModels((prev) => ({ ...prev, [prov]: merged }));
      }
    } catch (err) {
      console.error(`Failed to load realtime models for ${prov}:`, err);
    } finally {
      setRealtimeModelLoading(false);
    }
  }, []);

  useEffect(() => {
    setApiKeyInput('');
    setProviderModelError('');
    if (!isTauriRuntime()) {
      setKeyExists(false);
      return;
    }
    let active = true;
    providerApiKeyExists(provider)
      .then((exists) => {
        if (!active) return;
        setKeyExists(exists);
        const isLocal = isLocalProvider(provider);
        if (exists || isLocal) {
          void loadLiveModels(provider);
        }
      })
      .catch(() => {
        if (!active) return;
        setKeyExists(false);
      });
    return () => {
      active = false;
    };
  }, [provider, loadLiveModels]);

  useEffect(() => {
    const isLocal = isLocalProvider(completionProvider);
    let active = true;
    providerApiKeyExists(completionProvider)
      .then((exists) => {
        if (!active) return;
        if (exists || isLocal) {
          void loadCompletionLiveModels(completionProvider);
        }
      })
      .catch(() => {});
    return () => {
      active = false;
    };
  }, [completionProvider, loadCompletionLiveModels]);

  useEffect(() => {
    if (!isTauriRuntime()) return;
    let active = true;
    providerApiKeyExists('groq')
      .then((exists) => { if (active) setGroqKeyExists(exists); })
      .catch(() => { if (active) setGroqKeyExists(false); });
    providerApiKeyExists('openai')
      .then((exists) => { if (active) setOpenaiKeyExists(exists); })
      .catch(() => { if (active) setOpenaiKeyExists(false); });
    providerApiKeyExists('xai')
      .then((exists) => { if (active) setXaiKeyExists(exists); })
      .catch(() => { if (active) setXaiKeyExists(false); });
    providerApiKeyExists('vercel')
      .then((exists) => { if (active) setVercelKeyExists(exists); })
      .catch(() => { if (active) setVercelKeyExists(false); });
    return () => { active = false; };
  }, []);

  useEffect(() => {
    if (activeTab !== 'voice') return;
    const loadChatModels = async (prov: string) => {
      const pid = prov as AiProviderId;
      const isLocal = isLocalProvider(pid);
      const hasKey = isLocal ? true : await providerApiKeyExists(pid).catch(() => false);
      if (hasKey) {
        void loadLiveModels(pid);
      }
    };
    if (refinementProvider) void loadChatModels(refinementProvider);
    if (voiceInput && voiceInput !== 'webspeech') {
      void loadSttModels(voiceInput);
    }
    void loadRealtimeModels('openai');
    void loadRealtimeModels('xai');
    void loadRealtimeModels('vercel');
  }, [activeTab, refinementProvider, voiceInput, loadLiveModels, loadRealtimeModels, loadSttModels]);

  useEffect(() => {
    setLocalUrlInput(getProviderBaseUrl(provider, baseUrls) || '');
  }, [provider, baseUrls]);

  const handleSaveLocalUrl = useCallback((val: string) => {
    const trimmed = val.trim();
    setProviderBaseUrl(provider, trimmed);
    showToast(`${providerDef.label} server URL saved`, 'success');
    void loadLiveModels(provider, true);
    void loadCompletionLiveModels(provider, true);
  }, [provider, providerDef.label, loadLiveModels, loadCompletionLiveModels]);

  const handleResetLocalUrl = useCallback(() => {
    const defaultUrl = providerDef.defaultBaseUrl ?? '';
    setLocalUrlInput(defaultUrl);
    setProviderBaseUrl(provider, defaultUrl);
    showToast(`${providerDef.label} server URL reset to default`, 'info');
    void loadLiveModels(provider, true);
    void loadCompletionLiveModels(provider, true);
  }, [provider, providerDef, loadLiveModels, loadCompletionLiveModels]);

  async function saveKey() {
    if (!apiKeyInput.trim()) return;
    if (!isTauriRuntime()) {
      showToast('Keychain is available in the desktop app.', 'info');
      return;
    }
    await saveProviderApiKey(provider, apiKeyInput);
    setApiKeyInput('');
    setKeyExists(true);
    showToast(`${providerDef.label} key saved`, 'success');
    void loadLiveModels(provider, true);
    void loadCompletionLiveModels(provider, true);
  }

  async function clearKey() {
    if (!isTauriRuntime()) {
      showToast('Keychain is available in the desktop app.', 'info');
      return;
    }
    await clearProviderApiKey(provider);
    setKeyExists(false);
    setProviderLiveModels((prev) => {
      const next = { ...prev };
      delete next[provider];
      return next;
    });
    setCompletionLiveModels((prev) => {
      const next = { ...prev };
      delete next[provider];
      return next;
    });
    showToast(`${providerDef.label} key removed`, 'success');
  }

  async function checkUpdates() {
    setUpdateMessage('');
    if (!isTauriRuntime()) {
      setUpdateMessage('Update checks are available in the desktop app.');
      return;
    }
    try {
      await checkForUpdate();
      const latest = get(pendingUpdate);
      setUpdateMessage(latest ? `Update available: v${latest.version}` : 'Spacron is up to date.');
    } catch {
      setUpdateMessage('Could not check for updates.');
    }
  }

  function updateShortcut(id: string, keys: string, when?: string) {
    userShortcuts.set(shortcuts.map((shortcut) => (shortcut.id === id ? { ...shortcut, keys, ...(when !== undefined ? { when } : {}) } : shortcut)));
  }

  function handleAddShortcut() {
    if (!customLabel.trim() || !customKeys.trim() || !customAction) {
      showToast('Please fill out all fields to add a shortcut.', 'warning');
      return;
    }

    const keysLower = customKeys.trim().toLowerCase();
    const isConflict = shortcuts.some(s => s && s.keys.toLowerCase() === keysLower);
    if (isConflict) {
      showToast(`Shortcut '${customKeys}' is already assigned.`, 'warning');
      return;
    }

    const newId = `custom_${Math.random().toString(36).substring(2, 9)}`;
    const newShortcut = {
      id: newId,
      label: customLabel.trim(),
      keys: customKeys.trim(),
      action: customAction,
      ...(customWhen.trim() ? { when: customWhen.trim() } : {}),
    };

    userShortcuts.set([...shortcuts, newShortcut]);
    setCustomLabel('');
    setCustomKeys('');
    setCustomAction('');
    setCustomWhen('');
    showToast('Custom shortcut added successfully.', 'info');
  }

  function handleDeleteShortcut(id: string) {
    userShortcuts.set(shortcuts.filter((s) => s && s.id !== id));
    showToast('Shortcut deleted.', 'info');
  }

  function handleAddCustomAgent() {
    const name = newAgentName.trim();
    const command = newAgentCommand.trim();
    if (!name || !command) {
      setAgentFormError('Give the agent a name and a launch command.');
      return;
    }
    const created = addCustomAgent({
      name,
      command,
      readsRulesFile: newAgentReadsRules,
      supportsAcp: newAgentSupportsAcp,
      registryId: newAgentRegistryId,
    });
    if (!created) {
      setAgentFormError('An agent with that launch command already exists.');
      return;
    }
    setNewAgentName('');
    setNewAgentCommand('');
    setNewAgentReadsRules(true);
    setNewAgentSupportsAcp(false);
    setNewAgentRegistryId('');
    setRulesDetection(null);
    rulesTouched.current = false;
    setAgentFormError('');
    showToast(`Added "${created.name}". It's now in the spawn picker.`, 'success');
  }

  async function loadAcpAgents() {
    setAcpLoading(true);
    setAcpError('');
    try {
      setAcpAgents(await fetchAcpRegistry());
    } catch (error) {
      setAcpError(error instanceof Error ? error.message : String(error));
    } finally {
      setAcpLoading(false);
    }
  }

  function handleRemoveCustomAgent(id: string, name: string) {
    deleteCustomAgent(id);
    showToast(`Removed "${name}".`, 'info');
  }

  async function resetAllSettings() {
    let confirmed = false;
    const message =
      'This will erase all workspaces, projects, settings, and AI keys. This cannot be undone.';
    if (isTauriRuntime()) {
      try {
        const { ask } = await import('@tauri-apps/plugin-dialog');
        confirmed = await ask(message, {
          title: 'Factory Reset',
          kind: 'warning',
        });
      } catch (err) {
        console.error('Failed to show Tauri ask dialog:', err);
        confirmed = window.confirm(message);
      }
    } else {
      confirmed = window.confirm(message);
    }

    if (!confirmed) return;

    // Clear everything: workspaces, localStorage keys, and settings.
    await resetAllApplicationState();
    removedPresetAgents.set([]);

    if (typeof localStorage !== 'undefined') {
      localStorage.removeItem('forge_active_theme');
    }
    try {
      const { loadThemes } = await import('$lib/stores/theme');
      await loadThemes();
    } catch (e) {
      console.error('Failed to reload themes after reset:', e);
    }

    onclose();
    showToast('Application reset to factory defaults', 'success');
  }

  return (
    <div className="settings-page-host" onClick={(event) => { if (event.target === event.currentTarget) onclose(); }}>
      <div className="settings-modal settings-page" ref={pageRef} role="region" aria-label="Settings">
        <div className="settings-body">
          <aside className="settings-sidebar" aria-label="Settings navigation">
            <div className="settings-search-wrap">
              <svg className="settings-search-icon" width="15" height="15" viewBox="0 0 24 24" fill="none" aria-hidden="true">
                <circle cx="11" cy="11" r="6.5" stroke="currentColor" strokeWidth="1.8" />
                <path d="m16 16 4.5 4.5" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
              </svg>
              <input
                className="settings-search-input"
                value={settingsQuery}
                onChange={(event) => setSettingsQuery(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === 'Enter' && settingsSearchResults[0]) {
                    event.preventDefault();
                    selectSettingsSearchResult(settingsSearchResults[0]);
                  }
                }}
                placeholder="Search settings"
                aria-label="Search settings"
                autoComplete="off"
              />
              {settingsQuery && (
                <button
                  type="button"
                  className="settings-search-clear"
                  onClick={() => setSettingsQuery('')}
                  aria-label="Clear settings search"
                >
                  <svg width="13" height="13" viewBox="0 0 24 24" fill="none" aria-hidden="true">
                    <path d="M6 6l12 12M18 6 6 18" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
                  </svg>
                </button>
              )}
              {settingsQuery && (
                <div className="settings-search-results" role="listbox" aria-label="Matching settings">
                  {settingsSearchResults.length > 0 ? settingsSearchResults.map((result) => (
                    <button
                      type="button"
                      className="settings-search-result"
                      key={result.id}
                      onClick={() => selectSettingsSearchResult(result)}
                    >
                      <span>{result.label}</span>
                      <small>{tabs.find((tab) => tab.id === result.tab)?.label ?? result.tab} · {result.section}</small>
                    </button>
                  )) : (
                    <p className="settings-search-empty">No matching settings</p>
                  )}
                </div>
              )}
            </div>
            <nav className="settings-tabs" aria-label="Settings sections">
              {settingsNavGroups.map((group) => (
                <div className="settings-nav-group" key={group.label ?? 'general'}>
                  {group.label && <h3>{group.label}</h3>}
                  {group.tabs.map((tabId) => {
                    const tab = tabs.find((item) => item.id === tabId)!;
                    return (
                      <button key={tab.id} className={activeTab === tab.id ? 'active' : undefined} aria-current={activeTab === tab.id ? 'page' : undefined} onClick={() => setActiveTab(tab.id)}>
                        <svg className="settings-tab-icon" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                          <path d={settingsTabIconPaths[tab.id]} />
                        </svg>
                        <span>{tab.label}</span>
                      </button>
                    );
                  })}
                </div>
              ))}
            </nav>
          </aside>

          <main className="settings-panel" ref={panelRef}>
            <div className="settings-topbar">
              <div className="settings-breadcrumb"><span>Settings</span><span className="settings-breadcrumb-divider">/</span><strong>{tabs.find((tab) => tab.id === activeTab)?.label}</strong></div>
              <button className="settings-topbar-close" type="button" onClick={onclose} aria-label="Close settings" title="Close settings (Esc)">
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="m6 6 12 12M18 6 6 18" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" /></svg>
              </button>
            </div>
            {activeTab === 'general' && (
              <>
                <Section title="Editor">
                  <SettingRow title="Font size" detail={`${currentFontSize}px`}>
                    <div className="num-control">
                      <button className="num-btn" onClick={() => fontSize.set(Math.max(10, currentFontSize - 1))}>−</button>
                      <span className="num-val">{currentFontSize}</span>
                      <button className="num-btn" onClick={() => fontSize.set(Math.min(32, currentFontSize + 1))}>+</button>
                    </div>
                  </SettingRow>
                  <SettingRow title="Font family" detail="Editor and terminal">
                    <input value={currentFontFamily} onChange={(event) => fontFamily.set(event.target.value)} placeholder="'JetBrains Mono', monospace" spellCheck={false} />
                  </SettingRow>
                  <SettingRow title="Tab size" detail={`${currentTabSize} spaces`}>
                    <div className="num-control">
                      <button className="num-btn" onClick={() => tabSize.set(Math.max(1, currentTabSize - 1))}>−</button>
                      <span className="num-val">{currentTabSize}</span>
                      <button className="num-btn" onClick={() => tabSize.set(Math.min(8, currentTabSize + 1))}>+</button>
                    </div>
                  </SettingRow>
                  <SettingRow title="Word wrap">
                    <Toggle label="Toggle word wrap" checked={currentWordWrap} onChange={wordWrap.set} />
                  </SettingRow>
                  <SettingRow title="Format on save">
                    <Toggle label="Toggle format on save" checked={currentFormatOnSave} onChange={formatOnSave.set} />
                  </SettingRow>
                  <SettingRow title="Auto save" detail="Saves the active file ~1s after you stop typing">
                    <Toggle label="Toggle auto save" checked={currentAutoSave} onChange={autoSave.set} />
                  </SettingRow>
                  <SettingRow title="Language server">
                    <Toggle label="Toggle language server" checked={currentEnableLsp} onChange={enableLsp.set} />
                  </SettingRow>
                  <SettingRow title="Minimap">
                    <Toggle label="Toggle minimap" checked={currentMinimap} onChange={minimap.set} />
                  </SettingRow>
                  <SettingRow title="Vim mode">
                    <Toggle label="Toggle Vim mode" checked={currentVimMode} onChange={vimMode.set} />
                  </SettingRow>
                  <SettingRow
                    title="Column selection"
                    detail={`Box-select with ${COLUMN_SELECT_GESTURE}, and stack cursors with ${ADD_CURSOR_GESTURE}`}
                  >
                    <Toggle label="Toggle column selection" checked={currentColumnSelection} onChange={columnSelection.set} />
                  </SettingRow>
                </Section>

                <Section title="Workspace">
                  <SettingRow title="Show hidden files" detail="Include dot-prefixed files in the explorer">
                    <Toggle label="Toggle hidden files" checked={currentShowHidden} onChange={showHidden.set} />
                  </SettingRow>
                  <SettingRow title="Show Workspace Snapshots" detail="Show snapshots tab in the sidebar activity bar">
                    <Toggle label="Toggle workspace snapshots" checked={currentShowSnapshotsTab} onChange={showSnapshotsTab.set} />
                  </SettingRow>
                  <SettingRow title="Open Preview in" detail="Where the browser preview opens. You can move an open Preview from its header.">
                    <StyledSelect<PreviewPlacement>
                      value={currentPreviewPlacement}
                      options={[
                        { id: 'sidebar', label: 'Right sidebar' },
                        { id: 'room', label: 'Room' },
                      ]}
                      onChange={previewPlacement.set}
                      ariaLabel="Open Preview in"
                    />
                  </SettingRow>
                  <SettingRow title="Notifications" detail="System alerts for agent activity and process exits">
                    <Toggle
                      label="Toggle notifications"
                      checked={currentNotifications}
                      onChange={(checked) => {
                        notificationsEnabled.set(checked);
                        if (checked) void requestNotificationPermission();
                      }}
                    />
                  </SettingRow>
                </Section>

                <Section title="Window">
                  <div className="option-cards window-close-options" role="radiogroup" aria-label="When closing the window">
                    {([
                      { id: 'quit' as const,     label: 'Quit Spacron',    desc: 'Close the app and stop live terminals.' },
                      { id: 'minimize' as const, label: 'Keep running',  desc: 'Minimize and keep terminals and agents alive.' },
                    ]).map((opt) => (
                      <button
                        key={opt.id}
                        type="button"
                        role="radio"
                        aria-checked={currentCloseBehavior === opt.id}
                        className={`option-card window-close-option${currentCloseBehavior === opt.id ? ' selected' : ''}`}
                        onClick={() => closeBehavior.set(opt.id)}
                      >
                        <span className="option-title">
                          {opt.label}
                          <span className={`window-close-indicator${currentCloseBehavior === opt.id ? ' checked' : ''}`} aria-hidden="true">
                            {currentCloseBehavior === opt.id && <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round"><path d="m5 12 4 4 10-10" /></svg>}
                          </span>
                        </span>
                        <span className="option-desc">{opt.desc}</span>
                      </button>
                    ))}
                  </div>
                  <p className="window-close-status" aria-live="polite">
                    {currentCloseBehavior === 'minimize'
                      ? 'Runs in the background when closed.'
                      : 'Quits completely when closed.'}
                  </p>
                </Section>
              </>
            )}

            {activeTab === 'source-control' && (
              <>
                <Section title="Default provider">
                  <SettingRow
                    title="Source control provider"
                    detail="Primary provider used for cloning and publishing repositories."
                  >
                    <Dropdown
                      options={[
                        { value: 'github', label: 'GitHub' },
                        { value: 'gitlab', label: 'GitLab' },
                        { value: 'bitbucket', label: 'Bitbucket' },
                        { value: 'other', label: 'Other (PAT only)' },
                      ]}
                      value={currentSourceControlProvider}
                      onChange={(val) => sourceControlProvider.set(val as 'github' | 'gitlab' | 'bitbucket' | 'other')}
                    />
                  </SettingRow>
                </Section>

                <Section title="Accounts">
                  <div className="settings-sc-row">
                    <div className="settings-sc-copy">
                      <span className="settings-sc-brand-icon github">
                        <GithubBrandIcon />
                      </span>
                      <div className="settings-sc-meta">
                        <div className="settings-sc-title-row">
                          <span className="settings-sc-provider-name">GitHub</span>
                          {currentSourceControlProvider === 'github' && (
                            <span className="settings-sc-default-pill">Default</span>
                          )}
                          {github.identity ? (
                            <span className="settings-sc-badge connected">
                              <span className="settings-sc-dot" />
                              Connected
                            </span>
                          ) : (
                            <span className="settings-sc-badge disconnected">Not connected</span>
                          )}
                        </div>
                        <span className="settings-sc-detail">
                          {github.identity
                            ? `@${github.identity.login} · ${github.identity.source === 'oauth' ? 'GitHub OAuth' : github.identity.source === 'gh-cli' ? 'GitHub CLI' : 'Personal access token'}`
                            : 'Private repositories and pull requests.'}
                        </span>
                        {github.identity && github.identity.scopes.length > 0 && (
                          <div className="settings-github-scopes" style={{ marginTop: '2px' }}>
                            {github.identity.scopes.map((s) => (
                              <span key={s} className="settings-github-scope">
                                {s}
                              </span>
                            ))}
                          </div>
                        )}
                      </div>
                    </div>

                    <div className="settings-sc-control">
                      {github.identity ? (
                        <button
                          type="button"
                          className="settings-sc-disconnect-btn"
                          onClick={() => void github.signOut()}
                        >
                          Sign out
                        </button>
                      ) : github.signingIn ? (
                        github.device ? (
                          <div className="settings-sc-device-flow">
                            <div className="settings-github-device-row">
                              <code className="settings-github-device-code">
                                {github.device.user_code}
                              </code>
                              <button
                                type="button"
                                className="settings-secondary"
                                onClick={() => void copyGithubCode()}
                              >
                                {githubCopied ? 'Copied' : 'Copy'}
                              </button>
                            </div>
                            <div className="settings-github-device-waiting">
                              <span className="settings-github-spinner" aria-hidden="true" />
                              <button
                                type="button"
                                className="settings-link-button"
                                onClick={() => void github.openInBrowser(github.device!.verification_uri)}
                              >
                                Authorize on GitHub
                              </button>
                              <button type="button" className="settings-secondary" onClick={github.cancel}>
                                Cancel
                              </button>
                            </div>
                          </div>
                        ) : (
                          <div className="settings-github-signin">
                            <div className="settings-github-device-waiting">
                              <span className="settings-github-spinner" aria-hidden="true" />
                              <span>Signing in with GitHub CLI…</span>
                            </div>
                            <button type="button" className="settings-secondary" onClick={github.cancel}>
                              Cancel
                            </button>
                          </div>
                        )
                      ) : (
                        <div style={{ display: 'flex', gap: '8px', alignItems: 'center' }}>
                          {github.options?.oauth_available && (
                            <button
                              type="button"
                              className="settings-primary"
                              onClick={() => void github.start()}
                            >
                              Sign in with GitHub
                            </button>
                          )}
                          {github.options?.gh_cli_available && (
                            <button
                              type="button"
                              className="settings-secondary"
                              onClick={() => void github.importGhCli()}
                            >
                              Use GitHub CLI
                            </button>
                          )}
                          {!github.options?.oauth_available && !github.options?.gh_cli_available && (
                            <small className="settings-github-note">
                              Paste PAT in Clone dialog.
                            </small>
                          )}
                        </div>
                      )}
                    </div>
                  </div>

                  {SOURCE_CONTROL_PROVIDERS.filter((p) => p.value !== 'github').map((provider) => {
                    const sc =
                      provider.value === 'gitlab'
                        ? gitlabSc
                        : provider.value === 'bitbucket'
                          ? bitbucketSc
                          : otherSc;
                    const draft = tokenDrafts[provider.value] ?? '';
                    const isDefault = currentSourceControlProvider === provider.value;
                    const placeholder =
                      provider.value === 'gitlab'
                        ? 'glpat-...'
                        : provider.value === 'bitbucket'
                          ? 'App password'
                          : 'Personal access token';
                    const providerDesc =
                      provider.value === 'gitlab'
                        ? 'Personal access token (glpat-).'
                        : provider.value === 'bitbucket'
                          ? 'App password with repo access.'
                          : 'Personal access token for custom host.';

                    const handleSave = async () => {
                      await sc.saveToken(draft.trim());
                      setTokenDrafts({ ...tokenDrafts, [provider.value]: '' });
                    };

                    return (
                      <div className="settings-sc-row" key={provider.value}>
                        <div className="settings-sc-copy">
                          <span className={`settings-sc-brand-icon ${provider.value}`}>
                            {provider.value === 'gitlab' ? (
                              <GitlabBrandIcon />
                            ) : provider.value === 'bitbucket' ? (
                              <BitbucketBrandIcon />
                            ) : (
                              <GitBrandIcon />
                            )}
                          </span>
                          <div className="settings-sc-meta">
                            <div className="settings-sc-title-row">
                              <span className="settings-sc-provider-name">{provider.label}</span>
                              {isDefault && <span className="settings-sc-default-pill">Default</span>}
                              {sc.identity ? (
                                <span className="settings-sc-badge connected">
                                  <span className="settings-sc-dot" />
                                  Connected
                                </span>
                              ) : (
                                <span className="settings-sc-badge disconnected">Not connected</span>
                              )}
                            </div>
                            <span className="settings-sc-detail">
                              {sc.identity
                                ? `${sc.identity.login ? `@${sc.identity.login} · ` : ''}${sc.identity.source === 'oauth' ? 'OAuth' : 'Personal access token'}`
                                : providerDesc}
                            </span>
                          </div>
                        </div>

                        <div className="settings-sc-control">
                          {sc.identity ? (
                            <button
                              type="button"
                              className="settings-sc-disconnect-btn"
                              onClick={() => void sc.signOut()}
                            >
                              Sign out
                            </button>
                          ) : sc.signingIn ? (
                            <div className="settings-github-device-waiting">
                              <span className="settings-github-spinner" aria-hidden="true" />
                              <span>Saving token…</span>
                            </div>
                          ) : (
                            <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-end', width: '100%' }}>
                              <div className="settings-sc-input-group">
                                <input
                                  type="password"
                                  placeholder={placeholder}
                                  value={draft}
                                  onChange={(e) =>
                                    setTokenDrafts({ ...tokenDrafts, [provider.value]: e.target.value })
                                  }
                                  onKeyDown={(e) => {
                                    if (e.key === 'Enter' && draft.trim() && !sc.signingIn) {
                                      void handleSave();
                                    }
                                  }}
                                  disabled={sc.signingIn}
                                  aria-label={`${provider.label} token`}
                                />
                                <button
                                  type="button"
                                  className="settings-primary"
                                  onClick={handleSave}
                                  disabled={sc.signingIn || !draft.trim()}
                                >
                                  {sc.signingIn ? 'Connecting…' : 'Connect'}
                                </button>
                              </div>
                              {sc.error && <span className="settings-sc-error-msg">{sc.error}</span>}
                            </div>
                          )}
                        </div>
                      </div>
                    );
                  })}
                </Section>
              </>
            )}

            {activeTab === 'appearance' && (
              <>
                <Section title="Visual style">
                  <SettingRow title="Mode">
                    <div className="mode-picker" role="radiogroup" aria-label="Mode">
                      {([
                        { id: 'system' as const, label: 'System' },
                        { id: 'light' as const, label: 'Light' },
                        { id: 'dark' as const, label: 'Dark' },
                      ]).map(({ id, label }) => {
                        // System names the mode it resolved to, so the tooltip says what is on screen.
                        const name = id === 'system' && currentActiveTheme
                          ? `System (now ${currentActiveTheme.type === 'light' ? 'Light' : 'Dark'})`
                          : label;
                        return (
                          <button
                            key={id}
                            type="button"
                            role="radio"
                            aria-checked={currentAppearance === id}
                            aria-label={name}
                            title={name}
                            className={`mode-swatch${currentAppearance === id ? ' selected' : ''}`}
                            onClick={() => appearance.set(id)}
                          >
                            {id === 'system' ? (
                              <>
                                <ModeMock tone="light" />
                                <ModeMock tone="dark" half />
                              </>
                            ) : (
                              <ModeMock tone={id} />
                            )}
                          </button>
                        );
                      })}
                    </div>
                  </SettingRow>
                  <SettingRow title="UI zoom" detail={`${currentZoom}%`}>
                    <div className="num-control">
                      <button className="num-btn" onClick={() => uiZoom.set(Math.max(50, currentZoom - 10))}>−</button>
                      <span className="num-val">{currentZoom}%</span>
                      <button className="num-btn" onClick={() => uiZoom.set(Math.min(200, currentZoom + 10))}>+</button>
                      <button className="num-btn-reset" onClick={() => uiZoom.set(100)}>Reset</button>
                    </div>
                  </SettingRow>
                  <SettingRow title="UI font size" detail={`${currentUiFontSize}px · editor and terminal stay unchanged`}>
                    <div className="num-control">
                      <button className="num-btn" onClick={() => uiFontSize.set(Math.max(12, currentUiFontSize - 1))} aria-label="Decrease UI font size">−</button>
                      <span className="num-val">{currentUiFontSize}px</span>
                      <button className="num-btn" onClick={() => uiFontSize.set(Math.min(20, currentUiFontSize + 1))} aria-label="Increase UI font size">+</button>
                      <button className="num-btn-reset" onClick={() => uiFontSize.set(14)}>Reset</button>
                    </div>
                  </SettingRow>
                  <SettingRow title="Accent color" detail={currentAccentColor ? `${currentAccentColor} · custom` : `${defaultAccentColor} · theme default`}>
                    <div className="accent-picker">
                      <label className="accent-color-input" title="Choose accent color">
                        <input
                          type="color"
                          value={displayedAccentColor}
                          onChange={(event) => accentColor.set(event.target.value)}
                          aria-label="Choose accent color"
                        />
                        <span style={{ backgroundColor: displayedAccentColor }} />
                      </label>
                      <div className="accent-swatches" aria-label="Accent color presets">
                        {accentPresets.map((preset) => (
                          <button
                            key={preset.value}
                            type="button"
                            className={classNames('accent-swatch', currentAccentColor === preset.value && 'selected')}
                            style={{ backgroundColor: preset.value }}
                            onClick={() => accentColor.set(preset.value)}
                            aria-label={preset.label}
                            title={preset.label}
                          />
                        ))}
                      </div>
                      {currentAccentColor && (
                        <button className="num-btn-reset" onClick={() => accentColor.set('')}>Theme default</button>
                      )}
                    </div>
                  </SettingRow>
                </Section>

                <Section title="Colour">
                  <SettingRow title="Vibrancy" detail={`${vibrancy}%`}>
                    <div className="grading-control">
                      <input type="range" min="50" max="200" step="5" value={vibrancy} onChange={(event) => uiVibrancy.set(Number(event.target.value))} aria-label="Vibrancy" />
                      <button className="num-btn-reset" onClick={() => uiVibrancy.set(100)} disabled={vibrancy === 100}>Reset</button>
                    </div>
                  </SettingRow>
                  <SettingRow title="Contrast" detail={`${contrast}%`}>
                    <div className="grading-control">
                      <input type="range" min="75" max="150" step="5" value={contrast} onChange={(event) => uiContrast.set(Number(event.target.value))} aria-label="Contrast" />
                      <button className="num-btn-reset" onClick={() => uiContrast.set(100)} disabled={contrast === 100}>Reset</button>
                    </div>
                  </SettingRow>
                </Section>

                <Section title="Background">
                  <SettingRow title="Custom background" detail="Display a custom image behind the interface.">
                    <div className="bg-actions">
                      <button className="bg-btn" onClick={chooseBackgroundImage}>
                        {bgPresent ? 'Change…' : 'Choose…'}
                      </button>
                      {bgPresent && (
                        <button className="bg-btn bg-btn-danger" onClick={removeBackgroundImage}>Remove</button>
                      )}
                    </div>
                  </SettingRow>
                  {/* Only meaningful once a background exists: with no image the
                      toggle is a no-op, since a custom background shows on
                      `enabled && a file is set`. Turning it off falls back to the
                      theme's own wallpaper, which is what the label promises. */}
                  {bgPresent && (
                    <SettingRow title="Show custom background" detail="Temporarily show the default theme wallpaper.">
                      <Toggle label="Show custom background" checked={bgEnabled} onChange={backgroundImageEnabled.set} />
                    </SettingRow>
                  )}
                  <SettingRow title="Blur" detail={`${bgBlur}px`}>
                    <input type="range" min="0" max="24" step="1" value={bgBlur} onChange={(event) => backgroundImageBlur.set(Number(event.target.value))} disabled={!bgPresent} />
                  </SettingRow>
                  <SettingRow title="Panel opacity" detail={`${glassOpacity}% · lower increases translucency`}>
                    <input type="range" min="30" max="100" step="5" value={glassOpacity} onChange={(event) => backgroundGlassOpacity.set(Number(event.target.value))} disabled={!bgPresent || !bgEnabled} aria-label="Panel opacity" />
                  </SettingRow>
                </Section>
              </>
            )}

            {activeTab === 'models' && (
              <>
                <AgentAccountsSection />

                <Section title="API keys">
                  <SettingRow title="Provider" detail="Powers inline completion, voice refinement, and media generation.">
                    <SelectField value={provider} options={aiProviders.filter((item) => item.id !== 'local').map((item) => ({ id: item.id, label: item.label }))} onChange={(value) => setProvider(value as AiProviderId)} ariaLabel="AI provider connection" renderIcon={providerIcon} />
                  </SettingRow>

                  {providerDef.signIn === 'chatgpt' ? (
                    <ChatGptSignIn openUrl={openExternalUrl} onSignedInChange={handleChatGptSignedIn} />
                  ) : localProvider ? (
                    <>
                      <SettingRow title={providerDef.keyLabel}>
                        <input
                          value={localUrlInput}
                          onChange={(event) => setLocalUrlInput(event.target.value)}
                          placeholder={providerDef.keyPlaceholder}
                          onKeyDown={(event) => {
                            if (event.key === 'Enter') {
                              handleSaveLocalUrl(localUrlInput);
                            }
                          }}
                        />
                      </SettingRow>
                      <div className="settings-action-row">
                        <button className="settings-primary" onClick={() => handleSaveLocalUrl(localUrlInput)}>Save URL</button>
                        <button className="settings-secondary" onClick={handleResetLocalUrl}>Reset</button>
                      </div>
                    </>
                  ) : (
                    <>
                      <SettingRow title={providerDef.keyLabel} detail={keyExists ? 'Saved' : 'Not saved'}>
                        <input type="password" value={apiKeyInput} onChange={(event) => setApiKeyInput(event.target.value)} placeholder={keyExists ? 'Key saved in OS keychain' : providerDef.keyPlaceholder} />
                      </SettingRow>
                      {provider === 'kilocode' && !keyExists && (
                        <p className="shell-hint">
                          Free tier requires an API key from app.kilo.ai.
                        </p>
                      )}
                      <div className="settings-action-row">
                        <button className="settings-primary" onClick={() => void saveKey()} disabled={!apiKeyInput.trim()}>Save key</button>
                        <button className="settings-secondary" onClick={() => void clearKey()} disabled={!keyExists}>Clear key</button>
                        {providerDef.keyUrl && (
                          <button className="settings-link-button" onClick={() => openExternalUrl(providerDef.keyUrl)}>
                            {provider === 'kilocode' ? 'Create a free Kilo account' : 'Open provider'}
                          </button>
                        )}
                      </div>
                    </>
                  )}

                </Section>

                <CustomProvidersSection />

                <JevConnectionSection />

                <Section title="Inline completion">
                  <SettingRow title="Ghost text">
                    <Toggle label="Toggle ghost text" checked={completionEnabled} onChange={aiGhostTextEnabled.set} />
                  </SettingRow>
                  <SettingRow title="Provider">
                    <SelectField value={completionProvider} options={aiProviders.map((item) => ({ id: item.id, label: item.label }))} onChange={aiCompletionProvider.set} ariaLabel="Completion provider" renderIcon={providerIcon} />
                  </SettingRow>
                  <SettingRow title="Model">
                    <ModelSelect
                      value={completionModel}
                      models={completionModels}
                      onChange={(value) => aiCompletionModelByProvider.update((map) => ({ ...map, [completionProvider]: value }))}
                      label="Completion model"
                      renderIcon={() => providerIcon(completionProvider)}
                    />
                  </SettingRow>
                  <div className="settings-action-row">
                    <button className="settings-secondary" onClick={() => void loadCompletionLiveModels(completionProvider, true)} disabled={modelLoading}>
                      {modelLoading ? 'Refreshing...' : 'Refresh models'}
                    </button>
                  </div>
                </Section>

                <MediaGenerationSection />

                <Section title="Local Speech-to-Text (STT)">
                  <div className="local-models-info">
                    Offline Speech-to-Text models for private voice typing.
                  </div>
                  <div style={{ fontSize: '12px', background: 'rgba(78, 201, 176, 0.08)', color: 'var(--text-secondary)', padding: '8px 12px', borderRadius: '6px', marginTop: '8px', marginBottom: '12px', lineHeight: '1.5', border: '1px solid rgba(78, 201, 176, 0.15)' }}>
                    ⚡ Runs natively via ONNX Runtime for fast, private offline transcription.
                  </div>
                  <div className="local-models-list">
                    {localModelsLoading && localModels.length === 0 ? (
                      <div style={{ color: 'var(--text-muted)', fontSize: '13px' }}>Loading catalog...</div>
                    ) : (
                      localModels.filter(m => m.category === 'stt').map(model => {
                        const progressInfo = downloadProgress[model.id];
                        return (
                          <div key={model.id} className="local-model-card">
                            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                              <strong>{model.name} <span style={{ fontSize: '11px', color: 'var(--text-muted)', fontWeight: 'normal' }}>({model.downloaded && model.downloaded_size_bytes ? formatBytes(model.downloaded_size_bytes) : model.size})</span></strong>
                              {model.downloaded ? (
                                <span style={{ background: 'rgba(78, 201, 176, 0.1)', color: 'var(--success)', padding: '2px 8px', borderRadius: '4px', fontSize: '11px', fontWeight: 600 }}>Ready / Offline</span>
                              ) : progressInfo ? (
                                <span style={{ color: 'var(--accent)', fontSize: '11px', fontWeight: 600 }}>Downloading...</span>
                              ) : (
                                <span style={{ color: 'var(--text-muted)', fontSize: '11px' }}>Not installed</span>
                              )}
                            </div>
                            <p>{model.description}</p>
                            {progressInfo && (
                              <div style={{ width: '100%', marginTop: '4px' }}>
                                <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '10px', color: 'var(--text-muted)', marginBottom: '4px' }}>
                                  <span>Phase: {progressInfo.phase === 'main' ? 'Main Model' : progressInfo.phase === 'voices' ? 'Voices Package' : 'Initializing'}</span>
                                  <span>{Math.round(progressInfo.progress)}%</span>
                                </div>
                                <div style={{ height: '6px', width: '100%', background: 'var(--bg-active)', borderRadius: '3px', overflow: 'hidden' }}>
                                  <div style={{ height: '100%', width: `${progressInfo.progress}%`, background: 'var(--accent)', transition: 'width 0.15s ease' }} />
                                </div>
                              </div>
                            )}
                            <div style={{ display: 'flex', gap: '8px', marginTop: '4px' }}>
                              {model.downloaded ? (
                                <button type="button" className="settings-danger" style={{ padding: '6px 12px', fontSize: '12px', borderRadius: '6px', width: 'auto' }} onClick={() => handleDeleteModel(model.id)}>Delete</button>
                              ) : progressInfo ? (
                                <button type="button" className="settings-secondary" style={{ padding: '6px 12px', fontSize: '12px', borderRadius: '6px', width: 'auto' }} onClick={() => handleCancelDownload(model.id)}>Cancel</button>
                              ) : (
                                <button type="button" className="settings-primary" style={{ padding: '6px 12px', fontSize: '12px', borderRadius: '6px', width: 'auto' }} onClick={() => handleDownloadModel(model.id)}>Download</button>
                              )}
                            </div>
                          </div>
                        );
                      })
                    )}
                  </div>
                </Section>
              </>
            )}

            {activeTab === 'voice' && (
              <>
                {/* Voice settings and voice history are two views of the SAME
                    tab — history is not a top-level tab of its own. */}
                <div className="settings-subnav" role="tablist" aria-label="Voice section">
                  {([
                    { id: 'settings' as const, label: 'Settings' },
                    { id: 'history' as const, label: 'History' },
                  ]).map((view) => (
                    <button
                      key={view.id}
                      type="button"
                      role="tab"
                      aria-selected={voiceView === view.id}
                      className={classNames('settings-subnav-btn', voiceView === view.id && 'active')}
                      onClick={() => setVoiceView(view.id)}
                    >
                      {view.label}
                    </button>
                  ))}
                </div>

                {voiceView === 'history' && <VoiceHistoryPanel />}
              </>
            )}

            {activeTab === 'voice' && voiceView === 'settings' && (
              <>
                <ReadAloudSection />
                <Section title="Voice input">
                  <SettingRow title="Provider">
                    <SelectField value={voiceInput} options={[...voiceInputProviders, ...aiProviders.filter((item) => item.custom).map((item) => ({ id: item.id as VoiceInputProviderId, label: item.label }))]} onChange={voiceInputProvider.set} ariaLabel="Voice input provider" renderIcon={providerIcon} />
                  </SettingRow>
                  {voiceInputUsesModelTranscription(voiceInput) && (
                    <>
                      <SettingRow title="Transcription model">
                        <ModelSelect
                          value={voiceInputModel}
                          models={voiceInputModels}
                          onChange={(value) => setVoiceInputModel(voiceInput as Exclude<VoiceInputProviderId, 'webspeech'>, value)}
                          label="Voice input model"
                        />
                      </SettingRow>
                      <div className="settings-action-row">
                        <button className="settings-secondary" onClick={() => void loadSttModels(voiceInput, true)} disabled={sttModelLoading}>
                          {sttModelLoading ? 'Refreshing...' : 'Refresh models'}
                        </button>
                      </div>
                    </>
                  )}
                  <SettingRow
                    title="Smart voice detection"
                    detail="Uses Silero VAD to detect speech and filter background noise."
                  >
                    <Toggle label="Toggle smart voice detection" checked={smartVad} onChange={smartVadEnabled.set} />
                  </SettingRow>
                </Section>

                <Section title="Terminal transcription">
                  <SettingRow
                    title="Hotkey"
                    detail="Tap to speak, tap again or press Esc to finish, Ctrl+Esc to cancel."
                  >
                    <kbd>{formatShortcutLabel(shortcuts.find((s) => s && s.id === 'transcribeToTerminal')?.keys ?? 'F9')}</kbd>
                  </SettingRow>
                  <SettingRow
                    title="Send after transcribing"
                    detail="Automatically press Enter after dictating into a terminal."
                  >
                    <Toggle label="Toggle send after transcribing" checked={transcriptionSend} onChange={transcriptionAutoSend.set} />
                  </SettingRow>
                </Section>

                <Section title="Voice refinement">
                  <SettingRow
                    title="Refinement"
                    detail="Automatically formats and cleans up dictated text."
                  >
                    <Toggle label="Toggle voice refinement" checked={voiceRefinement} onChange={voiceRefinementEnabled.set} />
                  </SettingRow>
                  <SettingRow
                    title="Custom vocabulary"
                    detail="Comma-separated terms to preserve exactly (names, libraries, acronyms)."
                  >
                    <input
                      value={vocabulary}
                      onChange={(event) => dictationVocabulary.set(event.target.value)}
                      placeholder="Spacron, Parakeet, onnxruntime, zustand"
                      spellCheck={false}
                    />
                  </SettingRow>
                  <SettingRow title="Provider">
                    <SelectField value={refinementProvider} options={aiProviders.map((item) => ({ id: item.id, label: item.label }))} onChange={voiceAiProvider.set} ariaLabel="Voice refinement provider" renderIcon={providerIcon} />
                  </SettingRow>
                  <SettingRow title="Model">
                    <ModelSelect value={refinementModel} models={refinementModels} onChange={(value) => setVoiceAiModel(refinementProvider, value)} label="Voice refinement model" renderIcon={() => providerIcon(refinementProvider)} />
                  </SettingRow>
                  <div className="settings-action-row">
                    <button className="settings-secondary" onClick={() => void loadLiveModels(refinementProvider, true)} disabled={modelLoading}>
                      {modelLoading ? 'Refreshing...' : 'Refresh models'}
                    </button>
                  </div>
                </Section>

                <Section title="Notifications">
                  <SettingRow
                    title="Agent result nudge"
                    detail="Play a chime when an agent completes or requires input."
                  >
                    <Toggle label="Toggle agent result nudge" checked={announceCompletions} onChange={announceAgentCompletions.set} />
                  </SettingRow>
                </Section>
              </>
            )}

            {activeTab === 'terminal' && (
              <>
                <Section title="Default shell">
                  <div className="shell-cards">
                    {availableShells.length === 0 ? (
                      <div className="shell-loading">Detecting shells…</div>
                    ) : (
                      availableShells.map((sh) => {
                        const basename = sh.program.split(/[\/\\]/).pop() ?? sh.program;
                        const lc = basename.toLowerCase();
                        const isSelected = shell === sh.program || (shell === '' && sh === availableShells[0]);
                        const icon = lc.includes('pwsh') || lc.includes('powershell')
                          ? <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5"><rect x="2" y="3" width="20" height="18" rx="3"/><polyline points="8,9 4,12 8,15"/><line x1="12" y1="15" x2="20" y2="15"/></svg>
                          : lc.includes('cmd')
                          ? <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5"><rect x="2" y="3" width="20" height="18" rx="3"/><path d="M6 9l4 3-4 3"/><line x1="14" y1="15" x2="18" y2="15"/></svg>
                          : lc.includes('bash') || lc.includes('zsh') || lc.includes('sh')
                          ? <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5"><rect x="2" y="3" width="20" height="18" rx="3"/><path d="M8 8l4 4-4 4"/><line x1="14" y1="16" x2="18" y2="16"/></svg>
                          : <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5"><rect x="2" y="3" width="20" height="18" rx="3"/><circle cx="12" cy="12" r="3"/></svg>;
                        return (
                          <button
                            key={sh.program}
                            type="button"
                            className={`shell-card${isSelected ? ' selected' : ''}`}
                            onClick={() => terminalShell.set(sh.program)}
                          >
                            <span className="shell-icon">{icon}</span>
                            <div className="shell-info">
                              <span className="shell-name">{basename}</span>
                              <span className="shell-path">{sh.program}</span>
                            </div>
                            {isSelected && (
                              <svg width="14" height="14" viewBox="0 0 14 14" fill="none">
                                <path d="M2 7l3.5 3.5 6.5-7" stroke="var(--accent)" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"/>
                              </svg>
                            )}
                          </button>
                        );
                      })
                    )}
                  </div>
                  <p className="shell-hint">Applies to new and active terminal sessions.</p>
                </Section>

                <Section title="Appearance">
                  <SettingRow title="Font size" detail={`${termFontSize}px`}>
                    <div className="num-control">
                      <button className="num-btn" onClick={() => terminalFontSize.set(Math.max(9, termFontSize - 1))}>−</button>
                      <span className="num-val">{termFontSize}</span>
                      <button className="num-btn" onClick={() => terminalFontSize.set(Math.min(28, termFontSize + 1))}>+</button>
                    </div>
                  </SettingRow>
                  <SettingRow title="Cursor">
                    <SelectField
                      value={cursorStyle}
                      options={[
                        { id: 'bar', label: 'Bar' },
                        { id: 'block', label: 'Block' },
                        { id: 'underline', label: 'Underline' },
                      ]}
                      onChange={terminalCursorStyle.set}
                      ariaLabel="Terminal cursor"
                    />
                  </SettingRow>
                  <SettingRow title="Renderer" detail="Canvas is recommended. WebGL is faster; DOM provides software fallback.">
                    <SelectField
                      value={renderer}
                      options={[
                        { id: 'dom', label: 'DOM' },
                        { id: 'canvas', label: 'Canvas' },
                        { id: 'webgl', label: 'WebGL' },
                      ]}
                      onChange={(value) => terminalRenderer.set(value as 'webgl' | 'canvas' | 'dom')}
                      ariaLabel="Terminal renderer"
                    />
                  </SettingRow>
                  <SettingRow title="Scrollback" detail={`${scrollback.toLocaleString()} lines`}>
                    <div className="num-control">
                      <button className="num-btn" onClick={() => terminalScrollback.set(Math.max(100, scrollback - 1000))}>−</button>
                      <span className="num-val" style={{ minWidth: 54 }}>{scrollback.toLocaleString()}</span>
                      <button className="num-btn" onClick={() => terminalScrollback.set(Math.min(100000, scrollback + 1000))}>+</button>
                    </div>
                  </SettingRow>
                </Section>
              </>
            )}

            {activeTab === 'agents' && (
              <>
                <Section title="Folder trust">
                  <p className="shell-hint" style={{ marginTop: 0, marginBottom: '14px' }}>
                    Allow supported agent CLIs to load project configurations without interactive prompts.
                  </p>
                  <SettingRow
                    title="Trust this project when launching agents"
                    detail={currentProjectId ? 'Saved separately for this project.' : 'Open a project to change its trust preference.'}
                  >
                    <Toggle
                      label="Trust this project when launching agents"
                      checked={currentProjectId ? currentAgentWorkspaceTrustOverrides[currentProjectId] !== false : false}
                      disabled={!currentProjectId}
                      onChange={(enabled) => {
                        if (!currentProjectId) return;
                        agentWorkspaceTrustOverrides.update((overrides) => ({ ...overrides, [currentProjectId]: enabled }));
                      }}
                    />
                  </SettingRow>
                </Section>

                <Section title="Running out of usage">
                  <p className="shell-hint" style={{ marginTop: 0, marginBottom: '14px' }}>
                    Automatically transfer in-progress work to another agent before usage limits are reached.
                  </p>
                  <SettingRow
                    title="Hand work over before the limit"
                    detail="Safely commit and hand over tasks before hitting rate limits."
                  >
                    <Toggle
                      label="Toggle handing agent work over on usage limits"
                      checked={currentAgentFailover}
                      onChange={agentFailover.set}
                    />
                  </SettingRow>
                  <SettingRow
                    title="Move the work at"
                    detail={`Trigger handover when remaining quota drops below ${currentFailoverHeadroom}%.`}
                  >
                    <input
                      type="range"
                      min="1"
                      max="99"
                      step="1"
                      value={currentFailoverHeadroom}
                      disabled={!currentAgentFailover}
                      aria-label="Usage left at which work is handed over"
                      onChange={(event) => agentFailoverHeadroomPercent.set(Number(event.target.value))}
                    />
                  </SettingRow>
                  <SettingRow
                    title="Allow switching to a different CLI"
                    detail="Fall back to an alternative CLI if same-CLI accounts are exhausted."
                  >
                    <Toggle
                      label="Toggle handing agent work to a different CLI"
                      checked={currentFailoverCrossProvider}
                      onChange={agentFailoverCrossProvider.set}
                    />
                  </SettingRow>
                </Section>

                <Section title="Power">
                  <p className="shell-hint" style={{ marginTop: 0, marginBottom: '14px' }}>
                    Prevent your computer from going to sleep while agents are running.
                  </p>
                  <SettingRow
                    title="Keep computer awake"
                    detail="Keep awake continuously, only while agents work, or never."
                  >
                    <Dropdown
                      options={[
                        { value: 'on', label: 'On' },
                        { value: 'agent', label: 'Agent' },
                        { value: 'off', label: 'Off' },
                      ]}
                      value={currentKeepAwakeMode}
                      onChange={(value) => {
                        const mode = value as 'on' | 'agent' | 'off';
                        keepAwakeMode.set(mode);
                        keepSystemAwake.set(mode === 'agent');
                      }}
                    />
                  </SettingRow>
                  {currentKeepAwakeMode !== 'off' && (
                    <p
                      className="shell-hint"
                      style={{
                        marginTop: 0,
                        marginBottom: 0,
                        color: keepAwake.error
                          ? 'var(--warning)'
                          : keepAwake.holding
                          ? 'var(--success)'
                          : undefined,
                      }}
                    >
                      {keepAwake.error
                        ? `Couldn't hold the system awake: ${keepAwake.error}`
                        : !keepAwake.supported
                        ? 'This platform has no sleep inhibitor Spacron can use.'
                        : keepAwake.holding
                          ? currentKeepAwakeMode === 'on'
                            ? 'Holding the system awake continuously.'
                            : `Holding the system awake for ${keepAwake.workingAgents} agent${keepAwake.workingAgents === 1 ? '' : 's'} working.`
                        : currentKeepAwakeMode === 'on'
                          ? 'The system will stay awake continuously.'
                          : 'Idle, with nothing held. The hold is taken when an agent starts a turn.'}
                    </p>
                  )}
                </Section>

                {SHOW_CHAT_THREAD_SETTINGS && <Section title="Long-running work">
                  <p className="shell-hint" style={{ marginTop: 0, marginBottom: '14px' }}>
                    Threads that go quiet stop competing for attention. Auto-settle drops an idle thread
                    out of the active list after a quiet period — T3 Code's "Working section" equivalent.
                    Settled threads are one click from resumption, so nothing is lost: they just stop
                    reading as "in flight". The idle threshold is deliberately long; a thread still
                    producing output keeps its activity advancing and stays active.
                  </p>
                  <SettingRow
                    title="Auto-settle idle threads"
                    detail={`Threads idle for ${Math.round(currentAutoSettleIdleMs / 60000)} minutes settle out of the active list.`}
                  >
                    <Toggle
                      label="Toggle auto-settle idle threads"
                      checked={currentAutoSettleEnabled}
                      onChange={autoSettleEnabled.set}
                    />
                  </SettingRow>
                  <SettingRow
                    title="Idle threshold"
                    detail="Minutes of inactivity before a thread settles."
                  >
                    <input
                      type="range"
                      min="1"
                      max="120"
                      step="1"
                      value={currentAutoSettleIdleMs / 60000}
                      disabled={!currentAutoSettleEnabled}
                      aria-label="Auto-settle idle threshold in minutes"
                      onChange={(event) => autoSettleIdleMs.set(Number(event.target.value) * 60000)}
                    />
                  </SettingRow>
                </Section>}

                <Section title="Browser">
                  <p className="shell-hint" style={{ marginTop: 0, marginBottom: '14px' }}>
                    Enables agents to test web pages and inspect UI using an isolated Chromium browser.
                  </p>
                  <SettingRow
                    title="Let agents use a browser"
                    detail="Provides dedicated Playwright browser automation."
                  >
                    <Toggle
                      label="Toggle agent browser tools"
                      checked={currentAgentBrowserTools}
                      onChange={agentBrowserTools.set}
                    />
                  </SettingRow>
                  {currentAgentBrowserTools ? <BrowserToolsDetails /> : null}
                </Section>

                <Section title="Computer use">
                  <SettingRow
                    title="Allow computer use"
                    detail={
                      computerUseAvailable === false
                        ? 'Available on Windows only for now. macOS support is planned.'
                        : 'While off, desktop automation tools are disabled.'
                    }
                  >
                    <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
                      <button
                        type="button"
                        className={`settings-dropdown-toggle-btn${computerUseExpanded ? ' open' : ''}`}
                        onClick={() => setComputerUseExpanded((prev) => !prev)}
                        aria-expanded={computerUseExpanded}
                        aria-label={computerUseExpanded ? 'Collapse computer use details' : 'Show computer use details'}
                        title={computerUseExpanded ? 'Collapse details' : 'Show details'}
                      >
                        <span>{computerUseExpanded ? 'Hide details' : 'Show details'}</span>
                        <svg
                          className={`settings-dropdown-chevron${computerUseExpanded ? ' open' : ''}`}
                          width="12"
                          height="12"
                          viewBox="0 0 24 24"
                          fill="none"
                          stroke="currentColor"
                          strokeWidth="2.2"
                          strokeLinecap="round"
                          strokeLinejoin="round"
                          aria-hidden="true"
                        >
                          <path d="m6 9 6 6 6-6" />
                        </svg>
                      </button>
                      <Toggle
                        label="Toggle computer use"
                        checked={currentComputerUse && computerUseAvailable === true}
                        disabled={computerUseAvailable !== true}
                        onChange={computerUse.set}
                      />
                    </div>
                  </SettingRow>
                  {computerUseExpanded && (
                    <div className="settings-computer-use-dropdown">
                      <p className="shell-hint" style={{ margin: '14px 28px 6px', padding: 0 }}>
                        Allows agents to view and control desktop apps with your permission. Press <kbd>Ctrl+Alt+Esc</kbd> anytime to revoke.
                      </p>
                      <ComputerUseDetails />
                    </div>
                  )}
                </Section>

                <Section title="Agents">
                  <p className="shell-hint" style={{ marginTop: 0, marginBottom: '14px' }}>
                    Manage discovered and authenticated agent CLIs on your PATH.
                  </p>
                  <SettingRow
                    title="Agent status hooks"
                    detail="Report when Claude Code turns complete or need user input."
                  >
                    <Toggle
                      label="Enable Claude agent status hooks"
                      checked={currentAgentStatusHooksEnabled}
                      onChange={agentStatusHooksEnabled.set}
                    />
                  </SettingRow>
                  <SettingRow
                    title="Auto-generate tab titles"
                    detail="Use the first prompt as a short agent title."
                  >
                    <Toggle
                      label="Auto-generate agent tab titles"
                      checked={currentAgentAutoGenerateTitles}
                      onChange={agentAutoGenerateTitles.set}
                    />
                  </SettingRow>
                  <AgentsPane />
                </Section>

                <Section title="Codex CLI">
                  <SettingRow
                    title="Run each Codex terminal on its own server"
                    detail="Isolate Codex's app-server within its terminal on Windows."
                  >
                    <Toggle
                      label="Run each Codex terminal on its own server"
                      checked={currentAgentCodexOwnServer}
                      onChange={agentCodexOwnServer.set}
                    />
                  </SettingRow>
                  <SettingRow
                    title="Warn when a Codex tab may share a server"
                    detail="Notify when running Codex without --no-daemon on Windows."
                  >
                    <Toggle
                      label="Warn when a Codex tab may share a server"
                      checked={currentAgentWarnCodexSharedServer}
                      onChange={agentWarnCodexSharedServer.set}
                    />
                  </SettingRow>
                </Section>

                <Section title="Coding CLI agents">
                  <p className="shell-hint" style={{ marginTop: 0, marginBottom: '14px' }}>
                    Register custom agent CLIs to spawn them directly with automatic briefings.
                  </p>

                  <div className="agent-list">
                    {/* Custom Agents */}
                    {$customAgents.map((agent) => (
                      <div className="agent-row" key={agent.id}>
                        <span className="agent-row-icon" aria-hidden="true">
                          <AgentBrandMark command={agent.command} name={agent.name} />
                        </span>
                        <div className="agent-meta">
                          <div className="agent-name-row">
                            <span className="agent-name">{agent.name}</span>
                          </div>
                          <code className="agent-cmd">{agent.command}</code>
                        </div>
                        <label className="agent-rules-toggle" title="Reads a CLAUDE.md / AGENTS.md rules file at startup">
                          <input
                            type="checkbox"
                            checked={agent.readsRulesFile}
                            onChange={(e) => updateCustomAgent(agent.id, { readsRulesFile: e.target.checked })}
                          />
                          <span>Rules file</span>
                        </label>
                        <button
                          type="button"
                          className="agent-remove"
                          onClick={() => handleRemoveCustomAgent(agent.id, agent.name)}
                          aria-label={`Remove ${agent.name}`}
                        >
                          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><path d="M3 6h18M8 6V4h8v2m-1 0v14H9V6"/></svg>
                        </button>
                      </div>
                    ))}
                  </div>

                  {/* Add Agent Form Container */}
                  <div className="agent-add-container">
                    <h4 className="agent-add-title">Add Custom Agent</h4>
                    
                    <div className="agent-add-fields">
                      <input
                        className="agent-input agent-input-name"
                        type="text"
                        placeholder="Name (e.g. Aider)"
                        value={newAgentName}
                        onChange={(e) => setNewAgentName(e.target.value)}
                        maxLength={40}
                      />
                      <input
                        className="agent-input agent-input-cmd"
                        type="text"
                        placeholder="Launch command (e.g. aider --no-auto-commits)"
                        value={newAgentCommand}
                        onChange={(e) => setNewAgentCommand(e.target.value)}
                        maxLength={200}
                        onKeyDown={(e) => { if (e.key === 'Enter') handleAddCustomAgent(); }}
                      />
                      <button className="agent-add-btn" type="button" onClick={handleAddCustomAgent}>Add agent</button>
                    </div>

                    <label className="agent-rules-row">
                      <input
                        type="checkbox"
                        checked={newAgentReadsRules}
                        onChange={(e) => {
                          rulesTouched.current = true;
                          setNewAgentReadsRules(e.target.checked);
                        }}
                      />
                      <span>This CLI reads a <code>CLAUDE.md</code> / <code>AGENTS.md</code> rules file at startup</span>
                    </label>
                    {SHOW_ACP_REGISTRY_SECTION && <label className="agent-rules-row">
                      <input
                        type="checkbox"
                        checked={newAgentSupportsAcp}
                        onChange={(e) => setNewAgentSupportsAcp(e.target.checked)}
                      />
                      <span>This command speaks ACP and can be selected by Chat mode</span>
                    </label>}
                    {SHOW_ACP_REGISTRY_SECTION && newAgentSupportsAcp && (
                      <input
                        className="agent-input"
                        type="text"
                        placeholder="Optional ACP Registry agent id"
                        value={newAgentRegistryId}
                        onChange={(e) => setNewAgentRegistryId(e.target.value)}
                        maxLength={128}
                      />
                    )}

                    {/* What the check concluded, and on what basis — a pre-filled
                        box with no stated reason is just a guess the user can't
                        audit. */}
                    {(rulesDetecting || rulesDetection) && (
                      <p className={`agent-rules-detect${rulesDetecting ? ' checking' : ''}`}>
                        {rulesDetecting ? (
                          <>Checking <code>{newAgentCommand.trim().split(/\s+/)[0]}</code>…</>
                        ) : rulesDetection?.source === 'known' ? (
                          <>
                            Detected: <code>{rulesDetection.executable}</code> is a CLI Spacron already
                            knows reads these files, so the brief goes in the file.
                          </>
                        ) : rulesDetection?.source === 'probe' && rulesDetection.readsRulesFile ? (
                          <>Detected: {rulesDetection.evidence}, so the brief goes in the file.</>
                        ) : rulesDetection?.source === 'probe' ? (
                          <>
                            Checked <code>{rulesDetection.executable}</code>: nothing in its help or its
                            program files names a rules file, so the brief will be pasted into its prompt
                            instead. Tick the box if you know it reads one.
                          </>
                        ) : (
                          <>
                            Couldn&apos;t check ({rulesDetection?.error}), so it is left unticked and the brief gets
                            pasted. Tick the box if this CLI reads a rules file.
                          </>
                        )}
                      </p>
                    )}

                    {agentFormError && (
                      <p className="agent-error">{agentFormError}</p>
                    )}
                  </div>
                </Section>

                {SHOW_ACP_REGISTRY_SECTION && <Section title="Managed installs">
                  <p className="shell-hint" style={{ marginTop: 0, marginBottom: '14px' }}>
                    Agents from the ACP registry can be installed and managed directly.
                  </p>
                  <ManagedAgentInstalls />
                </Section>}

                {SHOW_ACP_REGISTRY_SECTION && <Section title="ACP Registry">
                  <p className="shell-hint" style={{ marginTop: 0, marginBottom: '14px' }}>
                    Use ACP-capable agents in Chat mode with their own models and credentials.
                  </p>
                  <SettingRow
                    title="Enable ACP agents in Chat"
                    detail="When enabled, ACP-capable local commands appear in the Chat agent/model picker."
                  >
                    <Toggle
                      label="Toggle ACP Chat agents"
                      checked={acpRegistryOn}
                      onChange={acpRegistryEnabled.set}
                    />
                  </SettingRow>
                  <div className="agent-add-container" style={{ marginTop: '12px' }}>
                    <div className="agent-name-row" style={{ justifyContent: 'space-between' }}>
                      <h4 className="agent-add-title">Official registry</h4>
                      <button className="agent-add-btn" type="button" onClick={() => void loadAcpAgents()} disabled={acpLoading}>
                        {acpLoading ? 'Loading…' : acpAgents.length ? 'Refresh' : 'Browse registry'}
                      </button>
                    </div>
                    {acpError && <p className="shell-hint" style={{ color: 'var(--error)' }}>{acpError}</p>}
                    {acpAgents.length > 0 && (
                      <div className="agent-list">
                        {acpAgents.slice(0, 40).map((agent) => {
                          const distribution = agent.distribution[0];
                          const command = commandForAcpDistribution(distribution);
                          const added = $customAgents.some((entry) => entry.registryId === agent.id);
                          return (
                            <div className="agent-row" key={`${agent.id}:${agent.version}`}>
                              <span className="agent-row-icon" aria-hidden="true"><AgentBrandMark command={command} name={agent.name} /></span>
                              <div className="agent-meta">
                                <div className="agent-name-row"><span className="agent-name">{agent.name}</span></div>
                                <code className="agent-cmd">{command}</code>
                              </div>
                              <button
                                type="button"
                                className="agent-add-btn"
                                disabled={added}
                                onClick={() => {
                                  setNewAgentName(agent.name);
                                  setNewAgentCommand(command);
                                  setNewAgentRegistryId(agent.id);
                                  setNewAgentSupportsAcp(true);
                                  showToast('Review the local command, then add it below.', 'info');
                                }}
                              >
                                {added ? 'Added' : 'Use command'}
                              </button>
                            </div>
                          );
                        })}
                      </div>
                    )}
                  </div>
                  {$customAgents.filter((agent) => agent.supportsAcp).map((agent) => (
                    <SettingRow
                      key={`acp-${agent.id}`}
                      title={agent.name}
                      detail={agent.command}
                    >
                      <div style={{ display: 'flex', gap: '12px', alignItems: 'center', justifyContent: 'flex-end' }}>
                        <FavouriteStar command={agent.command} name={agent.name} />
                        <Toggle
                          label={`Toggle ACP for ${agent.name}`}
                          checked={!disabledAcpCommands.includes(agent.command.toLowerCase())}
                          onChange={(enabled) => setAcpCommandEnabled(agent.command, enabled)}
                        />
                      </div>
                    </SettingRow>
                  ))}
                  <AntigravityRuntimeRow />
                  {acpRoster.map((agent) => {
                    const normalized = agent.command.trim().toLowerCase();
                    const native = isNativeAcpCommand(agent.command);
                    const explicit = $acpExplicitCommands.includes(normalized);
                    return (
                      <SettingRow
                        key={`acp-roster-${agent.command}`}
                        title={agent.name}
                        detail={native ? `${agent.command} · ACP by name` : agent.command}
                      >
                        <div style={{ display: 'flex', gap: '16px', alignItems: 'center', flexWrap: 'wrap', justifyContent: 'flex-end' }}>
                          <FavouriteStar command={agent.command} name={agent.name} />
                          <input
                            type="text"
                            style={{ minWidth: '240px', padding: '6px 8px', borderRadius: '6px', border: '1px solid var(--border)', background: 'var(--surface-2)', color: 'var(--text-primary)', fontSize: '12px' }}
                            value={$acpCommandOverrides[normalized] ?? ''}
                            placeholder="Local ACP command (e.g. agy_acp_server)"
                            aria-label={`ACP command for ${agent.name}`}
                            title="The command Chat launches for this agent over ACP. Clear it to use the agent's own ACP entry point."
                            onChange={(event) => setAcpCommandOverride(agent.command, event.target.value)}
                          />
                          {!native && (
                            <Toggle
                              label={`Treat ${agent.name} as an ACP agent`}
                              checked={explicit}
                              onChange={(enabled) => setAcpExplicit(agent.command, enabled)}
                            />
                          )}
                          <Toggle
                            label={`Enable ${agent.name} in Chat`}
                            checked={!disabledAcpCommands.includes(normalized)}
                            onChange={(enabled) => setAcpCommandEnabled(agent.command, enabled)}
                          />
                        </div>
                      </SettingRow>
                    );
                  })}
                </Section>}
              </>
            )}

            {activeTab === 'chat' && <ChatSettingsPane onOpenAgents={() => setActiveTab('agents')} />}

            {activeTab === 'orchestrator' && <OrchestratorSettingsPane />}
            {activeTab === 'mcp' && <McpSettingsPane />}
            {activeTab === 'stats' && <UsageStatsPane />}

            {activeTab === 'shortcuts' && (
              <>
                <Section title="Keyboard shortcuts">
                  <ShortcutEditor 
                    shortcuts={shortcuts} 
                    onUpdate={updateShortcut} 
                    onDelete={handleDeleteShortcut} 
                  />
                </Section>
                <Section title="Add custom navigation shortcut">
                  <div className="custom-shortcut-form">
                    <div style={{ display: 'flex', gap: '10px' }}>
                      <div style={{ flex: 1, display: 'flex', flexDirection: 'column', gap: '4px' }}>
                        <span style={{ fontSize: '11px', color: 'var(--text-secondary)', fontWeight: 500 }}>Label / Name</span>
                        <input 
                          type="text" 
                          placeholder="e.g. Jump to Editor"
                          value={customLabel}
                          onChange={(e) => setCustomLabel(e.target.value)} 
                          style={{
                            background: 'var(--bg-secondary)',
                            border: '1px solid var(--border)',
                            borderRadius: '6px',
                            color: 'var(--text-primary)',
                            padding: '6px 10px',
                            fontSize: '13px',
                            outline: 'none'
                          }}
                        />
                      </div>
                      <div style={{ flex: 1, display: 'flex', flexDirection: 'column', gap: '4px' }}>
                        <span style={{ fontSize: '11px', color: 'var(--text-secondary)', fontWeight: 500 }}>Key Combination</span>
                        <input 
                          type="text" 
                          placeholder="e.g. Ctrl+Alt+B" 
                          value={customKeys} 
                          onChange={(e) => setCustomKeys(e.target.value)} 
                          style={{
                            background: 'var(--bg-secondary)',
                            border: '1px solid var(--border)',
                            borderRadius: '6px',
                            color: 'var(--text-primary)',
                            padding: '6px 10px',
                            fontSize: '13px',
                            outline: 'none'
                          }}
                        />
                      </div>
                    </div>
                    
                    <div style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
                      <span style={{ fontSize: '11px', color: 'var(--text-secondary)', fontWeight: 500 }}>Application Action</span>
                      <Dropdown
                        options={actionOptions}
                        value={customAction}
                        onChange={(val) => setCustomAction(val)}
                        placeholder="Select an action…"
                        ariaLabel="Application Action"
                      />
                    </div>

                    <div style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
                      <span style={{ fontSize: '11px', color: 'var(--text-secondary)', fontWeight: 500 }}>When Clause (optional)</span>
                      <input 
                        type="text" 
                        placeholder="e.g. editorFocused"
                        value={customWhen}
                        onChange={(e) => setCustomWhen(e.target.value)} 
                        style={{
                          background: 'var(--bg-secondary)',
                          border: '1px solid var(--border)',
                          borderRadius: '6px',
                          color: 'var(--text-primary)',
                          padding: '6px 10px',
                          fontSize: '13px',
                          outline: 'none'
                        }}
                      />
                    </div>

                    <button 
                      type="button"
                      className="settings-primary" 
                      onClick={handleAddShortcut}
                      style={{
                        alignSelf: 'flex-start',
                        marginTop: '4px',
                        padding: '6px 14px',
                        fontSize: '12px',
                        borderRadius: '6px',
                        cursor: 'pointer'
                      }}
                    >
                      Add Shortcut
                    </button>
                  </div>
                </Section>
                <div className="settings-footer-actions">
                  <button className="settings-secondary" onClick={() => userShortcuts.set(defaultShortcuts)}>Reset shortcuts</button>
                </div>
              </>
            )}

            {activeTab === 'about' && (
              <>
                <Section title="Spacron">
                  <div className="settings-about-grid">
                    <span>Version</span>
                    <strong style={{ display: 'flex', alignItems: 'center' }}>
                      {packageJson.version}
                      <a 
                        href="#" 
                        onClick={(e) => { e.preventDefault(); void openChangelogPage(packageJson.version); }}
                        style={{ marginLeft: '10px', color: 'var(--accent)', textDecoration: 'underline', cursor: 'pointer', fontSize: '12px', fontWeight: 'normal' }}
                      >
                        see changelogs
                      </a>
                    </strong>
                    <span>Framework</span>
                    <strong>React</strong>
                    <span>Build</span>
                    <strong>Vite + Tauri</strong>
                  </div>
                  <div className="settings-action-row">
                    <button className="settings-primary" onClick={() => void checkUpdates()} disabled={checking}>
                      {checking ? 'Checking...' : 'Check for updates'}
                    </button>
                    {update && (
                      <button className="settings-secondary" onClick={() => void installUpdate()} disabled={downloading}>
                        {downloading ? `Installing ${progress}%` : `Install v${update.version}`}
                      </button>
                    )}
                  </div>
                  {updateMessage && <p className="settings-message">{updateMessage}</p>}
                </Section>

                <Section title="Maintenance">
                  <div className="settings-danger-row">
                    <div>
                      <span>Factory reset</span>
                      <small>Erase all workspaces, settings, and AI keys.</small>
                    </div>
                    <button className="settings-danger" onClick={resetAllSettings}>Factory Reset</button>
                  </div>
                </Section>
              </>
            )}
          </main>
        </div>
      </div>
    </div>
  );
}
