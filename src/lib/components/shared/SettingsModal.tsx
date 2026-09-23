import { useEffect, useMemo, useRef, useState, useCallback, type CSSProperties } from 'react';
import { createPortal } from 'react-dom';
import { useModalFocus } from '$lib/react/useModalFocus';
import packageJson from '../../../../package.json';
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import {
  aiBaseUrlByProvider,
  aiCompletionModelByProvider,
  aiCompletionProvider,
  aiGhostTextEnabled,
  agentBrowserTools,
  mcpServers,
  agentWorktrees,
  aiProvider,
  aiProviders,
  accentColor,
  appearance,
  autoSave,
  autoStageAgentChanges,
  agentFailover,
  agentFailoverCrossProvider,
  agentFailoverHeadroomPercent,
  backgroundImageBlur,
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
  minimap,
  notificationsEnabled,
  resetSettingsToDefault,
  shortcutActions,
  setProviderBaseUrl,
  setVoiceAiModel,
  setVoiceInputModel,
  showHidden,
  showSnapshotsTab,
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
  voiceConversationEngine,
  voiceInputProvider,
  voiceInputUsesModelTranscription,
  voiceRefinementEnabled,
  dictationVocabulary,
  smartVadEnabled,
  transcriptionAutoSend,
  announceAgentCompletions,
  orchestratorCustomSkills,
  orchestratorDisabledSkills,
  openaiRealtimeModel,
  openaiRealtimeModelOptions,
  openaiRealtimeVoice,
  openaiRealtimeVoiceOptions,
  openaiLiveModel,
  openaiLiveModelOptions,
  openaiLiveVoice,
  openaiLiveVoiceOptions,
  xaiRealtimeModel,
  xaiRealtimeModelOptions,
  xaiRealtimeVoice,
  xaiRealtimeVoiceOptions,
  wordWrap,
  type AiModelOption,
  mediaGeneration,
  type AiProviderId,
  type KeyboardShortcut,
  type VoiceConversationEngine,
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
import { MEDIA_PROVIDERS, type MediaGenerationSettings, type MediaKind } from '$lib/services/media-generation';
import { requestNotificationPermission, showToast } from '$lib/stores/notification';
import { ChatGptSignIn } from './ChatGptSignIn';
import { checkForUpdate, installUpdate, pendingUpdate, updateChecking, updateDownloading, updateProgress } from '$lib/stores/updater';
import { get } from '$lib/stores/storeCompat';
import { useStore } from '$lib/react/useStore';
import { isTauriRuntime } from '$lib/utils/tauri';
import { keepAwakeState } from '$lib/services/keep-awake';
import { AgentBrandMark } from './useAgentBrand';
import { ProviderBrandMark } from './providerBrands';
import AgentsPane from '$lib/components/agents/AgentsPane';
import VoiceHistoryPanel from './VoiceHistoryPanel';
import UsageStatsPane from '$lib/components/stats/UsageStatsPane';
import {
  customAgents,
  addCustomAgent,
  updateCustomAgent,
  deleteCustomAgent,
  removedPresetAgents,
} from '$lib/stores/customAgents';
import { activeTheme } from '$lib/stores/theme';
import { chooseBackgroundImage, removeBackgroundImage, backgroundImagePresent } from '$lib/stores/background';
import { getAvailableShells, type ShellInfo } from '$lib/services/pty-bridge';
import {
  detectRulesFileSupport,
  type RulesFileDetection,
} from '$lib/services/orchestrator/agent-rules-file';
import Dropdown, { type DropdownOption } from '$lib/components/shared/Dropdown.tsx';
import { useGithubSignIn } from '$lib/react/useGithubSignIn';
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

const tabs: { id: Tab; label: string; kicker: string }[] = [
  { id: 'general', label: 'General', kicker: 'Editor and app' },
  { id: 'appearance', label: 'Appearance', kicker: 'Window and media' },
  { id: 'models', label: 'AI Connections', kicker: 'Providers and keys' },
  { id: 'voice', label: 'Voice', kicker: 'Transcription, conversation' },
  { id: 'terminal', label: 'Terminal', kicker: 'Shell and rendering' },
  { id: 'agents', label: 'Agents', kicker: 'Coding CLI tools' },
  { id: 'orchestrator', label: 'Orchestrator', kicker: 'Skills and learning' },
  { id: 'mcp', label: 'MCP', kicker: 'Tool servers' },
  { id: 'stats', label: 'Usage', kicker: 'Model usage and cost' },
  { id: 'shortcuts', label: 'Shortcuts', kicker: 'Keyboard map' },
  { id: 'about', label: 'About', kicker: 'Version and reset' },
];

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
  { id: 'appearance-mode', tab: 'appearance', section: 'Theme', label: 'Appearance mode', keywords: 'light dark system theme', target: 'section' },
  { id: 'ui-zoom', tab: 'appearance', section: 'Appearance', label: 'UI zoom', keywords: 'scale size interface' },
  { id: 'ui-font-size', tab: 'appearance', section: 'Appearance', label: 'UI font size', keywords: 'application text size' },
  { id: 'accent-color', tab: 'appearance', section: 'Appearance', label: 'Accent color', keywords: 'colour highlight brand' },
  { id: 'custom-background', tab: 'appearance', section: 'Background', label: 'Custom background', keywords: 'wallpaper image' },
  { id: 'background-blur', tab: 'appearance', section: 'Background', label: 'Blur', keywords: 'wallpaper image' },
  { id: 'ai-provider', tab: 'models', section: 'Provider connections', label: 'Provider', keywords: 'ai model service connection' },
  { id: 'ai-api-key', tab: 'models', section: 'Provider connections', label: 'API key', keywords: 'token secret credentials subscription', target: 'section' },
  { id: 'ghost-text', tab: 'models', section: 'Inline completion', label: 'Ghost text', keywords: 'inline completion suggestions' },
  { id: 'media-generation', tab: 'models', section: 'Image & video generation', label: 'Image & video generation', keywords: 'image video picture generate fal replicate veo sora dalle', target: 'section' },
  { id: 'local-speech-models', tab: 'models', section: 'Local Speech-to-Text (STT)', label: 'Local Speech-to-Text', keywords: 'offline private voice dictation', target: 'section' },
  { id: 'voice-input', tab: 'voice', section: 'Voice input', label: 'Voice input', keywords: 'speech transcription dictation', target: 'section' },
  { id: 'smart-voice-detection', tab: 'voice', section: 'Voice input', label: 'Smart voice detection', keywords: 'vad speaking silence' },
  { id: 'voice-refinement', tab: 'voice', section: 'Voice refinement', label: 'Voice refinement', keywords: 'transcript cleanup' },
  { id: 'conversation-engine', tab: 'voice', section: 'Conversation engine', label: 'Conversation engine', keywords: 'realtime voice assistant', target: 'section' },
  { id: 'terminal-font-size', tab: 'terminal', section: 'Appearance', label: 'Font size', keywords: 'terminal text' },
  { id: 'terminal-cursor', tab: 'terminal', section: 'Appearance', label: 'Cursor', keywords: 'terminal caret' },
  { id: 'terminal-renderer', tab: 'terminal', section: 'Appearance', label: 'Renderer', keywords: 'terminal webgl canvas dom' },
  { id: 'terminal-scrollback', tab: 'terminal', section: 'Appearance', label: 'Scrollback', keywords: 'terminal history lines' },
  { id: 'default-shell', tab: 'terminal', section: 'Default shell', label: 'Default shell', keywords: 'terminal command prompt', target: 'section' },
  { id: 'agent-isolation', tab: 'agents', section: 'Isolation & changes', label: 'Isolate agents in worktrees', keywords: 'git branches checkout' },
  { id: 'auto-stage', tab: 'agents', section: 'Isolation & changes', label: 'Auto-stage agent changes', keywords: 'git review' },
  { id: 'stay-awake', tab: 'agents', section: 'Power', label: 'Stay awake while agents work', keywords: 'sleep idle power' },
  { id: 'browser-tools', tab: 'agents', section: 'Browser', label: 'Browser tools', keywords: 'web agent' },
  { id: 'orchestrator-skills', tab: 'orchestrator', section: 'Built-in skills', label: 'Built-in skills', keywords: 'orchestrator assistant security engineering debugging review git' },
  { id: 'orchestrator-custom-skills', tab: 'orchestrator', section: 'Your skills', label: 'Add a skill', keywords: 'orchestrator custom instructions playbook prompt' },
  { id: 'orchestrator-learned', tab: 'orchestrator', section: 'What it has learned', label: 'What it has learned', keywords: 'orchestrator memory profile preferences forget' },
  { id: 'coding-cli-agents', tab: 'agents', section: 'Coding CLI agents', label: 'Coding CLI agents', keywords: 'custom agent command' },
  { id: 'mcp-builtin', tab: 'mcp', section: 'Built in', label: 'Built-in servers', keywords: 'mcp spacron playwright browser tools' },
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

function Toggle({ checked, onChange, label }: { checked: boolean; onChange: (checked: boolean) => void; label: string }) {
  return (
    <button
      type="button"
      className={classNames('settings-toggle', checked && 'active')}
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
    const relativeLeft = rect.left - modalRect.left;
    
    const spaceBelow = modalRect.bottom - rect.bottom;
    const spaceAbove = rect.top - modalRect.top;
    const openDown = spaceBelow >= 200 || spaceBelow >= spaceAbove;
    
    if (openDown) {
      setPanelStyle({
        position: 'absolute',
        top: relativeTop + 6,
        left: relativeLeft,
        width: rect.width,
        maxHeight: Math.min(240, spaceBelow - 12),
      });
    } else {
      setPanelStyle({
        position: 'absolute',
        bottom: modalRect.height - (rect.top - modalRect.top) + 6,
        left: relativeLeft,
        width: rect.width,
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

function SettingRow({
  title,
  detail,
  children,
}: {
  title: string;
  detail?: string;
  children: React.ReactNode;
}) {
  return (
    <div className="settings-control-row" data-settings-key={settingsSearchKey(title)}>
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

/**
 * Settings > AI Connections > Image & video generation. Generation tries the
 * ChatGPT plan first for images, then every provider with a key; this picks
 * which one goes first, per-provider models, and the two media-only keys.
 */
function JevConnectionSection() {
  const [keyExists, setKeyExists] = useState(false);
  const [keyInput, setKeyInput] = useState('');
  const [keyError, setKeyError] = useState('');

  useEffect(() => {
    let active = true;
    void invoke<boolean>('provider_api_key_exists', { provider: 'typesafe' })
      .then((exists) => { if (active) setKeyExists(exists); })
      .catch(() => { if (active) setKeyExists(false); });
    return () => { active = false; };
  }, []);

  const saveKey = async (value: string) => {
    setKeyError('');
    try {
      await invoke(value.trim() ? 'provider_api_key_set' : 'provider_api_key_delete',
        value.trim() ? { provider: 'typesafe', apiKey: value.trim() } : { provider: 'typesafe' });
      setKeyExists(Boolean(value.trim()));
      setKeyInput('');
    } catch (error) {
      setKeyError(String(error ?? 'Could not save the key'));
    }
  };

  return (
    <Section title="Jev decisions">
      <p className="shell-hint">Jev can help classify agent status and route work. It is optional; without a key, Spacron uses its existing behavior.</p>
      <SettingRow title="TypeSafe API key" detail={keyExists ? 'Saved in OS keychain' : 'Not saved'}>
        <input type="password" value={keyInput} onChange={(event) => setKeyInput(event.target.value)} placeholder={keyExists ? 'Key saved in OS keychain' : 'Paste key'} />
      </SettingRow>
      <div className="settings-action-row">
        <button className="settings-primary" onClick={() => void saveKey(keyInput)} disabled={!keyInput.trim()}>Save key</button>
        <button className="settings-secondary" onClick={() => void saveKey('')} disabled={!keyExists}>Clear key</button>
        <button className="settings-link-button" onClick={() => openExternalUrl('https://console.typesafe.ai/')}>Get a key</button>
      </div>
      {keyError && <p className="shell-hint">{keyError}</p>}
    </Section>
  );
}

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
    const options = [
      { id: 'auto', label: kind === 'image' ? 'Auto (ChatGPT plan first)' : 'Auto (first with a key)' },
      ...MEDIA_PROVIDERS.filter((p) => (kind === 'video' ? p.video : p.image)).map((p) => ({ id: p.id, label: p.label })),
    ];
    const info = MEDIA_PROVIDERS.find((p) => p.id === chosen);
    const fallback = kind === 'video' ? info?.videoDefault : info?.imageDefault;
    return (
      <>
        <SettingRow title={kind === 'video' ? 'Video provider' : 'Image provider'} detail="Tried first; the others with a key are used if it is out of credit or not set up.">
          <SelectField value={chosen} options={options} onChange={(value) => update({ [field]: value } as Partial<MediaGenerationSettings>)} ariaLabel={`${kind} provider`} />
        </SettingRow>
        {info && info.id !== 'chatgpt' && (
          <SettingRow title={kind === 'video' ? 'Video model' : 'Image model'} detail="Leave blank for the default.">
            <input
              type="text"
              value={settings[modelsField][info.id] ?? ''}
              placeholder={fallback}
              onChange={(event) => update({ [modelsField]: { ...settings[modelsField], [info.id]: event.target.value } } as Partial<MediaGenerationSettings>)}
            />
          </SettingRow>
        )}
      </>
    );
  };

  return (
    <Section title="Image & video generation">
      <p className="shell-hint">
        Images use your ChatGPT plan first. When it is not signed in or its limit is used up, Spacron uses the next
        provider with a key: OpenAI, Google and OpenRouter use the keys above; fal and Replicate use the keys below.
        Files are saved in the project&apos;s <code>generations</code> folder and shown in the chat.
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
 * Everything below them is the user's list, written into each CLI's own config
 * file on the next project open or agent launch. See `services/mcp-servers.ts`
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
          MCP servers give your agents tools beyond the filesystem and the shell. These two come
          with Spacron.
        </p>
        <div className="agent-list">
          <div className="agent-row">
            <div className="agent-meta">
              <div className="agent-name-row"><span className="agent-name">Spacron</span></div>
              <small className="shell-hint">
                Agent-to-agent tools and emulator control. Always on: it is how agents see each
                other and how work gets handed over.
              </small>
            </div>
          </div>
          <div className="agent-row">
            <div className="agent-meta">
              <div className="agent-name-row"><span className="agent-name">Playwright browser</span></div>
              <small className="shell-hint">
                Lets an agent open the page it just built and read it. Managed by Browser tools in
                Agents settings.
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

      <Section title="Your servers">
        <p className="shell-hint" style={{ marginTop: 0, marginBottom: '14px' }}>
          Add a hosted server by URL, or a local one by command. Each is written into every agent
          CLI's own config, so Claude Code, Codex, Gemini, droid, opencode and Cursor all get it.
          Changes apply the next time a project opens or an agent launches.
        </p>
        {servers.length > 0 && (
          <div className="agent-list">
            {servers.map((server) => {
              const problem = validateServer(server, servers);
              return (
                <div className="agent-row" key={server.id}>
                  <div className="agent-meta">
                    <div className="agent-name-row">
                      <span className="agent-name">{server.name || 'Unnamed server'}</span>
                      <span className="shell-hint" style={{ marginLeft: '8px' }}>
                        {server.transport === 'stdio' ? 'local' : server.transport.toUpperCase()}
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
                        Codex has no setting for request headers, so this one reaches Codex without
                        its auth header. Every other agent gets it.
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
          Skills are playbooks the orchestrator follows on every turn, whichever model is its brain.
          Switch off any you do not want.
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
          Teach the orchestrator how you work: your stack, your review checklist, how you like
          commits or replies written. Write it the way you would brief a new teammate. Your skills
          never override the Security skill.
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
          After each conversation the orchestrator notes lasting preferences and project facts, and
          anything you have had to say twice becomes a firm rule. Remove anything that is wrong.
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
  onUpdate: (id: string, keys: string) => void;
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
                <div style={{ display: 'flex', gap: '8px', alignItems: 'center' }}>
                  <input value={shortcut.keys} onChange={(event) => onUpdate(shortcut.id, event.target.value)} />
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

export default function SettingsModal({ onclose }: SettingsModalProps) {
  // Seeded from the store so a caller can deep-link a section — the palette's
  // "Customize Theme…" opens straight onto Appearance instead of General.
  const [activeTab, setActiveTab] = useState<Tab>(
    () => useLayoutStore.getState().settingsInitialTab ?? 'general',
  );
  const [settingsQuery, setSettingsQuery] = useState('');

  const settingsSearchResults = useMemo(() => {
    const query = settingsQuery.trim().toLowerCase();
    if (!query) return [];
    return settingsSearchEntries
      .filter((entry) => {
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

  const [newAgentName, setNewAgentName] = useState('');
  const [newAgentCommand, setNewAgentCommand] = useState('');
  const [newAgentReadsRules, setNewAgentReadsRules] = useState(true);
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
  const [apiKeyInput, setApiKeyInput] = useState('');
  // This selects which connection card is being managed. It deliberately does
  // not change the orchestrator: each Chat conversation owns that choice in
  // its composer.
  const [provider, setProvider] = useState<AiProviderId>(() => get(aiProvider));
  const [keyExists, setKeyExists] = useState(false);
  const [groqKeyExists, setGroqKeyExists] = useState(false);
  const [openaiKeyExists, setOpenaiKeyExists] = useState(false);
  const [xaiKeyExists, setXaiKeyExists] = useState(false);
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
  const panelRef = useRef<HTMLDivElement | null>(null);

  const github = useGithubSignIn();
  const [githubCopied, setGithubCopied] = useState(false);

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

  // Focus trap + Escape + register the modal so app-wide shortcuts stand down.
  useModalFocus(panelRef, onclose);

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
  const currentNotifications = useStore(notificationsEnabled);
  const currentAgentWorktrees = useStore(agentWorktrees);
  const currentAutoStage = useStore(autoStageAgentChanges);
  const currentAgentBrowserTools = useStore(agentBrowserTools);
  const currentAgentFailover = useStore(agentFailover);
  const currentFailoverHeadroom = useStore(agentFailoverHeadroomPercent);
  const currentFailoverCrossProvider = useStore(agentFailoverCrossProvider);
  const currentKeepSystemAwake = useStore(keepSystemAwake);
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
  const conversationEngine = useStore(voiceConversationEngine);
  const realtimeModel = useStore(openaiRealtimeModel);
  const realtimeVoice = useStore(openaiRealtimeVoice);
  const liveModel = useStore(openaiLiveModel);
  const liveVoice = useStore(openaiLiveVoice);
  const grokRealtimeModel = useStore(xaiRealtimeModel);
  const grokRealtimeVoice = useStore(xaiRealtimeVoice);
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

  // Live realtime model lists, falling back to the curated list when the live
  // fetch hasn't landed yet (no key, offline, or request still in flight) —
  // curated descriptions/pricing notes win when a live id matches one we know.
  const openaiRealtimeModelsMerged = useMemo(() => {
    const live = providerRealtimeModels['openai'];
    if (!live || live.length === 0) return openaiRealtimeModelOptions;
    const curated = new Map(openaiRealtimeModelOptions.map((m) => [m.id, m]));
    return live.map((m) => curated.get(m.id) ?? m);
  }, [providerRealtimeModels]);

  const openaiLiveModelsMerged = useMemo(() => {
    const live = providerRealtimeModels['openai'];
    if (!live || live.length === 0) return openaiLiveModelOptions;
    const curated = new Map(openaiLiveModelOptions.map((m) => [m.id, m]));
    const models = live.filter((m) => m.id.toLowerCase().includes('live'));
    return (models.length ? models : openaiLiveModelOptions).map((m) => curated.get(m.id) ?? m);
  }, [providerRealtimeModels]);

  const xaiRealtimeModelsMerged = useMemo(() => {
    const live = providerRealtimeModels['xai'];
    if (!live || live.length === 0) return xaiRealtimeModelOptions;
    const curated = new Map(xaiRealtimeModelOptions.map((m) => [m.id, m]));
    return live.map((m) => curated.get(m.id) ?? m);
  }, [providerRealtimeModels]);

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

  const loadRealtimeModels = useCallback(async (prov: 'openai' | 'xai', force = false) => {
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

  function updateShortcut(id: string, keys: string) {
    userShortcuts.set(shortcuts.map((shortcut) => (shortcut.id === id ? { ...shortcut, keys } : shortcut)));
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
      action: customAction
    };

    userShortcuts.set([...shortcuts, newShortcut]);
    setCustomLabel('');
    setCustomKeys('');
    setCustomAction('');
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
    const created = addCustomAgent({ name, command, readsRulesFile: newAgentReadsRules });
    if (!created) {
      setAgentFormError('An agent with that launch command already exists.');
      return;
    }
    setNewAgentName('');
    setNewAgentCommand('');
    setNewAgentReadsRules(true);
    setRulesDetection(null);
    rulesTouched.current = false;
    setAgentFormError('');
    showToast(`Added "${created.name}". It's now in the spawn picker.`, 'success');
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
    <div className="settings-overlay" onClick={(e) => {
      if (e.target === e.currentTarget) {
        onclose();
      }
    }}>
      <div className="settings-modal" ref={panelRef} role="dialog" aria-modal="true" aria-labelledby="settings-title">
        <header className="settings-header">
          <div>
            <h2 id="settings-title">Settings</h2>
          </div>
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
                if (event.key === 'Escape') setSettingsQuery('');
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
          <button className="settings-close" type="button" onClick={onclose} aria-label="Close settings" title="Close settings">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" aria-hidden="true">
              <path d="M6 6l12 12M18 6 6 18" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
            </svg>
          </button>
        </header>

        <div className="settings-body">
          <nav className="settings-tabs" aria-label="Settings sections">
            {tabs.map((tab) => (
              <button key={tab.id} className={activeTab === tab.id ? 'active' : undefined} onClick={() => setActiveTab(tab.id)}>
                <span>{tab.label}</span>
                <small>{tab.kicker}</small>
              </button>
            ))}
          </nav>

          <main className="settings-panel" ref={panelRef}>
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
                  <div className="option-cards" style={{ padding: '14px', gap: '10px', display: 'grid', gridTemplateColumns: '1fr 1fr' }}>
                    {([
                      { id: 'quit' as const,     label: 'Quit Spacron',    desc: 'Close the app and stop live terminals.' },
                      { id: 'minimize' as const, label: 'Keep running',  desc: 'Minimize and keep terminals and agents alive.' },
                    ]).map((opt) => (
                      <button
                        key={opt.id}
                        type="button"
                        className={`option-card${currentCloseBehavior === opt.id ? ' selected' : ''}`}
                        onClick={() => closeBehavior.set(opt.id)}
                      >
                        <span className="option-title">{opt.label}</span>
                        <span className="option-desc">{opt.desc}</span>
                      </button>
                    ))}
                  </div>
                </Section>

                <Section title="GitHub">
                  <div className="settings-github">
                    {github.identity ? (
                      <>
                        <div className="settings-github-status">
                          <span className="settings-github-login">
                            Signed in as {github.identity.login}
                          </span>
                          <small>
                            {github.identity.source === 'oauth'
                              ? 'via GitHub OAuth'
                              : github.identity.source === 'gh-cli'
                                ? 'via GitHub CLI'
                                : 'with a personal access token'}
                          </small>
                          {github.identity.scopes.length > 0 && (
                            <div className="settings-github-scopes">
                              {github.identity.scopes.map((s) => (
                                <span key={s} className="settings-github-scope">
                                  {s}
                                </span>
                              ))}
                            </div>
                          )}
                        </div>
                        <button
                          type="button"
                          className="settings-danger"
                          onClick={() => void github.signOut()}
                        >
                          Sign out
                        </button>
                      </>
                    ) : github.signingIn ? (
                      github.device ? (
                        <div className="settings-github-signin">
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
                            <span>Waiting for approval in your browser…</span>
                            <button
                              type="button"
                              className="settings-link-button"
                              onClick={() => void github.openInBrowser(github.device!.verification_uri)}
                            >
                              Open github.com/login/device
                            </button>
                          </div>
                          <button type="button" className="settings-secondary" onClick={github.cancel}>
                            Cancel sign-in
                          </button>
                        </div>
                      ) : (
                        <div className="settings-github-signin">
                          <div className="settings-github-device-waiting">
                            <span className="settings-github-spinner" aria-hidden="true" />
                            <span>Signing in with your GitHub CLI…</span>
                          </div>
                          <button type="button" className="settings-secondary" onClick={github.cancel}>
                            Cancel sign-in
                          </button>
                        </div>
                      )
                    ) : (
                      <>
                        <div className="settings-github-status">
                          <span className="settings-github-login">Not signed in</span>
                          <small>Private clones and publishes need a GitHub sign-in.</small>
                        </div>
                        <div className="settings-github-actions">
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
                              Use my GitHub CLI sign-in
                            </button>
                          )}
                          {!github.options?.oauth_available &&
                            !github.options?.gh_cli_available && (
                              <small className="settings-github-note">
                                OAuth sign-in isn't configured for this build, so paste a personal
                                access token in the Clone dialog instead.
                              </small>
                            )}
                        </div>
                      </>
                    )}
                  </div>
                </Section>
              </>
            )}

            {activeTab === 'appearance' && (
              <>
                <Section title="Theme">
                  {/* Appearance mode — visual cards */}
                  <div className="appearance-cards">
                    {([
                      { id: 'system' as const, label: 'System', detail: 'Follow device',
                        icon: <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round"><rect x="2" y="3" width="20" height="14" rx="2"/><line x1="8" y1="21" x2="16" y2="21"/><line x1="12" y1="17" x2="12" y2="21"/></svg> },
                      { id: 'light'  as const, label: 'Light', detail: 'Bright surfaces',
                        icon: <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="4"/><path d="M12 2v2"/><path d="M12 20v2"/><path d="m4.93 4.93 1.41 1.41"/><path d="m17.66 17.66 1.41 1.41"/><path d="M2 12h2"/><path d="M20 12h2"/><path d="m6.34 17.66-1.41 1.41"/><path d="m19.07 4.93-1.41 1.41"/></svg> },
                      { id: 'dark'   as const, label: 'Dark', detail: 'Dimmed surfaces',
                        icon: <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round"><path d="M12 3a6 6 0 0 0 9 9 9 9 0 1 1-9-9Z"/></svg> },
                    ]).map(({ id, label, detail, icon }) => (
                      <button
                        key={id}
                        type="button"
                        className={`appearance-card${currentAppearance === id ? ' selected' : ''}`}
                        onClick={() => appearance.set(id)}
                      >
                        <span className={`appearance-preview appearance-preview-${id}`} aria-hidden="true">
                          <span className="appearance-preview-top" />
                          <span className="appearance-preview-body">
                            <span />
                            <span />
                            <span />
                          </span>
                        </span>
                        <span className="appearance-icon">{icon}</span>
                        <span className="appearance-label">{label}</span>
                        <small className="appearance-detail">{detail}</small>
                      </button>
                    ))}
                  </div>
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

                <Section title="Background">
                  <SettingRow title="Custom background" detail="Show your own image behind the interface. It overrides the solid or theme background while enabled and remains available in Light and Dark mode.">
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
                    <SettingRow title="Show custom background" detail="Turn off to fall back to the theme's wallpaper without losing your image.">
                      <Toggle label="Show custom background" checked={bgEnabled} onChange={backgroundImageEnabled.set} />
                    </SettingRow>
                  )}
                  <SettingRow title="Blur" detail={`${bgBlur}px`}>
                    <input type="range" min="0" max="24" step="1" value={bgBlur} onChange={(event) => backgroundImageBlur.set(Number(event.target.value))} disabled={!bgPresent} />
                  </SettingRow>
                </Section>
              </>
            )}

            {activeTab === 'models' && (
              <>
                <JevConnectionSection />
                <Section title="Provider connections">
                  <SettingRow title="Provider" detail="Choose a connection to configure. Pick the orchestrator provider and model in each Chat composer.">
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
                          Kilo Code&apos;s &quot;Auto (free)&quot; model costs nothing, but it still needs a key to
                          identify your account. Create a free account at app.kilo.ai, copy the API key from your
                          Kilo profile, and paste it above.
                        </p>
                      )}
                      <div className="settings-action-row">
                        <button className="settings-primary" onClick={() => void saveKey()} disabled={!apiKeyInput.trim()}>Save key</button>
                        <button className="settings-secondary" onClick={() => void clearKey()} disabled={!keyExists}>Clear key</button>
                        <button className="settings-link-button" onClick={() => openExternalUrl(providerDef.keyUrl)}>
                          {provider === 'kilocode' ? 'Create a free Kilo account' : 'Open provider'}
                        </button>
                      </div>
                    </>
                  )}

                </Section>

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
                    Download Speech-to-Text models to enable 100% private, offline voice typing in Spacron.
                  </div>
                  <div style={{ fontSize: '12px', background: 'rgba(78, 201, 176, 0.08)', color: 'var(--text-secondary)', padding: '8px 12px', borderRadius: '6px', marginTop: '8px', marginBottom: '12px', lineHeight: '1.5', border: '1px solid rgba(78, 201, 176, 0.15)' }}>
                    ⚡ Parakeet now runs natively in the app process (ONNX Runtime) instead of WASM in the renderer, eliminating the OOM crash on long speech. Memory usage is capped via 30-second windowed inference, and short utterances stay single-pass.
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
                <Section title="Voice input">
                  <SettingRow title="Provider">
                    <SelectField value={voiceInput} options={voiceInputProviders} onChange={voiceInputProvider.set} ariaLabel="Voice input provider" renderIcon={providerIcon} />
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
                    detail="Uses a small Silero model to decide when you start and stop speaking. It is far better at ignoring clicks, fans and chatter than the built-in level gate. Download “Silero VAD” under Settings → Models → Local Speech-to-Text; until then dictation uses the level gate."
                  >
                    <Toggle label="Toggle smart voice detection" checked={smartVad} onChange={smartVadEnabled.set} />
                  </SettingRow>
                </Section>

                <Section title="Terminal transcription">
                  <SettingRow
                    title="Hotkey"
                    detail="Tap the hotkey and speak: pauses do not end it. Tap again or press Esc to send, Ctrl+Esc to discard. The text lands wherever the cursor is, terminal or text field."
                  >
                    <kbd>{formatShortcutLabel(shortcuts.find((s) => s && s.id === 'transcribeToTerminal')?.keys ?? 'F9')}</kbd>
                  </SettingRow>
                  <SettingRow
                    title="Send after transcribing"
                    detail="On presses Enter after typing the transcript; off only types it in."
                  >
                    <Toggle label="Toggle send after transcribing" checked={transcriptionSend} onChange={transcriptionAutoSend.set} />
                  </SettingRow>
                </Section>

                <Section title="Voice refinement">
                  <SettingRow
                    title="Refinement"
                    detail="Cleans prose after dictation. For a fully local option, load S1-mini by Superwhisper in Ollama or LM Studio, then choose it below."
                  >
                    <Toggle label="Toggle voice refinement" checked={voiceRefinement} onChange={voiceRefinementEnabled.set} />
                  </SettingRow>
                  <SettingRow
                    title="Custom vocabulary"
                    detail="Comma-separated terms the polish pass must spell exactly: project names, libraries, APIs, coworkers' names. Uses your refinement provider's key."
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

                <Section title="Conversation engine">
                  <SettingRow
                    title="Engine"
                    detail={conversationEngine === 'xai-realtime'
                      ? 'One live speech-to-speech call to xAI Grok, with sub-second replies and barge-in, billed flat at ~$0.05 per minute.'
                      : conversationEngine === 'openai-live'
                        ? 'OpenAI GPT Live handles the spoken conversation and delegates project work to Spacron’s orchestrator over a full-duplex WebRTC session.'
                      : 'One live speech-to-speech call to OpenAI. Replies start in well under a second and you can interrupt mid-sentence. Billed on audio tokens (mini ≈ $10 in / $20 out per 1M; full ≈ $32 / $64).'}
                  >
                    <SelectField
                      value={conversationEngine}
                      options={[
                        { id: 'openai-realtime', label: 'GPT Realtime (OpenAI)' },
                        { id: 'openai-live', label: 'GPT Live (OpenAI)' },
                        { id: 'xai-realtime', label: 'Grok Realtime (xAI)' },
                      ]}
                      onChange={(value) => voiceConversationEngine.set(value as VoiceConversationEngine)}
                      ariaLabel="Voice conversation engine"
                    />
                  </SettingRow>
                  {conversationEngine === 'openai-realtime' && (
                    <>
                      <SettingRow title="Realtime model">
                        <ModelSelect
                          value={realtimeModel}
                          models={openaiRealtimeModelsMerged}
                          onChange={openaiRealtimeModel.set}
                          label="Realtime model"
                          renderIcon={() => providerIcon('openai')}
                        />
                      </SettingRow>
                      {openaiKeyExists && (
                        <div className="settings-action-row">
                          <button
                            type="button"
                            className="settings-secondary"
                            onClick={() => void loadRealtimeModels('openai', true)}
                            disabled={realtimeModelLoading}
                          >
                            {realtimeModelLoading ? 'Refreshing...' : 'Refresh models'}
                          </button>
                        </div>
                      )}
                      <SettingRow title="Voice">
                        <StyledSelect
                          value={realtimeVoice}
                          options={openaiRealtimeVoiceOptions.map((v) => ({ id: v.id, label: v.label }))}
                          onChange={openaiRealtimeVoice.set}
                          ariaLabel="Realtime voice"
                        />
                      </SettingRow>
                      {!openaiKeyExists && (
                        <SettingRow title="OpenAI API key" detail="GPT Realtime needs an OpenAI API key.">
                          <div style={{ display: 'flex', gap: '8px', flexDirection: 'column', width: '100%' }}>
                            <span style={{ fontSize: '12px', color: 'var(--warning)' }}>No OpenAI API key configured</span>
                            <button type="button" className="settings-primary" onClick={() => { setActiveTab('models'); }}>
                              Add API key
                            </button>
                          </div>
                        </SettingRow>
                      )}
                    </>
                  )}
                  {conversationEngine === 'openai-live' && (
                    <>
                      <SettingRow title="Live model">
                        <ModelSelect
                          value={liveModel}
                          models={openaiLiveModelsMerged}
                          onChange={openaiLiveModel.set}
                          label="GPT Live model"
                          renderIcon={() => providerIcon('openai')}
                        />
                      </SettingRow>
                      {openaiKeyExists && (
                        <div className="settings-action-row">
                          <button type="button" className="settings-secondary" onClick={() => void loadRealtimeModels('openai', true)} disabled={realtimeModelLoading}>
                            {realtimeModelLoading ? 'Refreshing...' : 'Refresh models'}
                          </button>
                        </div>
                      )}
                      <SettingRow title="Voice">
                        <StyledSelect
                          value={liveVoice}
                          options={openaiLiveVoiceOptions.map((v) => ({ id: v.id, label: v.label }))}
                          onChange={openaiLiveVoice.set}
                          ariaLabel="GPT Live voice"
                        />
                      </SettingRow>
                      {!openaiKeyExists && (
                        <SettingRow title="OpenAI API key" detail="GPT Live needs an OpenAI API key.">
                          <div style={{ display: 'flex', gap: '8px', flexDirection: 'column', width: '100%' }}>
                            <span style={{ fontSize: '12px', color: 'var(--warning)' }}>No OpenAI API key configured</span>
                            <button type="button" className="settings-primary" onClick={() => { setActiveTab('models'); }}>
                              Add API key
                            </button>
                          </div>
                        </SettingRow>
                      )}
                    </>
                  )}
                  {conversationEngine === 'xai-realtime' && (
                    <>
                      <SettingRow title="Realtime model">
                        <ModelSelect
                          value={grokRealtimeModel}
                          models={xaiRealtimeModelsMerged}
                          onChange={xaiRealtimeModel.set}
                          label="Realtime model"
                          renderIcon={() => providerIcon('xai')}
                        />
                      </SettingRow>
                      {xaiKeyExists && (
                        <div className="settings-action-row">
                          <button
                            type="button"
                            className="settings-secondary"
                            onClick={() => void loadRealtimeModels('xai', true)}
                            disabled={realtimeModelLoading}
                          >
                            {realtimeModelLoading ? 'Refreshing...' : 'Refresh models'}
                          </button>
                        </div>
                      )}
                      <SettingRow title="Voice">
                        <StyledSelect
                          value={grokRealtimeVoice}
                          options={xaiRealtimeVoiceOptions.map((v) => ({ id: v.id, label: v.label }))}
                          onChange={xaiRealtimeVoice.set}
                          ariaLabel="Realtime voice"
                        />
                      </SettingRow>
                      {!xaiKeyExists && (
                        <SettingRow title="xAI API key" detail="Grok Realtime needs an xAI API key.">
                          <div style={{ display: 'flex', gap: '8px', flexDirection: 'column', width: '100%' }}>
                            <span style={{ fontSize: '12px', color: 'var(--warning)' }}>No xAI API key configured</span>
                            <button type="button" className="settings-primary" onClick={() => { setActiveTab('models'); }}>
                              Add API key
                            </button>
                          </div>
                        </SettingRow>
                      )}
                    </>
                  )}
                </Section>

                <Section title="Notifications">
                  <SettingRow
                    title="Agent result nudge"
                    detail="Play a soft chime when an agent finishes, blocks, or fails, even when voice mode is closed. The recap lands in the chat card."
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
                  <p className="shell-hint">Changes apply to new sessions. Active terminal sessions will automatically restart using the new shell.</p>
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
                  <SettingRow title="Renderer" detail="Canvas is the balanced default. WebGL is fastest, but it makes the terminal solid instead of see-through, because it cannot draw dim or underlined text over a transparent surface, and a window is limited to 16 GPU contexts, so panes beyond that fall back. Use DOM if text renders wrong.">
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
                <Section title="Isolation & changes">
                  <p className="shell-hint" style={{ marginTop: 0, marginBottom: '14px' }}>
                    Each agent works on its own git branch in a private checkout, so several can edit
                    the project at once without colliding. Work stays quarantined there until you review
                    it. The fleet dashboard shows every agent's changes with per-file diffs, and you
                    bring the work in or merge it when it's ready. A branch is only removed once
                    everything in it has been brought across.
                  </p>
                  <SettingRow
                    title="Isolate agents in worktrees"
                    detail="Off runs every agent directly in the project folder instead. The Isolated / Main repo toggle in the spawn picker still overrides this per agent."
                  >
                    <Toggle
                      label="Toggle agent worktree isolation"
                      checked={currentAgentWorktrees}
                      onChange={agentWorktrees.set}
                    />
                  </SettingRow>
                  <SettingRow
                    title="Auto-stage agent changes"
                    detail="Off (the default) keeps each agent's work in its private checkout until you review and bring it in, the Orca-style review wall. On moves changes across on their own as agents finish, so the app can be run and tested against them without pressing anything."
                  >
                    <Toggle
                      label="Toggle automatic staging of agent changes"
                      checked={currentAutoStage}
                      onChange={autoStageAgentChanges.set}
                    />
                  </SettingRow>
                </Section>

                <Section title="Running out of usage">
                  <p className="shell-hint" style={{ marginTop: 0, marginBottom: '14px' }}>
                    An agent that hits its plan's limit halfway through a feature normally just
                    stops, and you find out later. Instead, Spacron watches each signed-in CLI's own
                    meter and moves the unfinished work before the wall: it asks the agent to land
                    what it has and commit, then puts another one in the same checkout, on the same
                    branch, with a brief built from the actual diff. The task, the conversation and
                    the review at the end are all unchanged: only who is typing.
                  </p>
                  <SettingRow
                    title="Hand work over before the limit"
                    detail="Off leaves an agent to stop at its limit mid-feature, which is the behaviour without this."
                  >
                    <Toggle
                      label="Toggle handing agent work over on usage limits"
                      checked={currentAgentFailover}
                      onChange={agentFailover.set}
                    />
                  </SettingRow>
                  <SettingRow
                    title="Move the work at"
                    detail={`${currentFailoverHeadroom}% usage left. Earlier leaves the agent more room to wrap up cleanly; later gets more work out of the plan you are already paying for. Set it high to rehearse a handover without waiting for a real limit.`}
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
                    detail="Another account of the same CLI is always tried first and spends only your own plan. Off stops there rather than moving the work to a different service, which may cost money."
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
                    A long agent run is unattended by design, which is exactly what your machine
                    reads as idle before it suspends, taking every agent down mid-turn. Spacron can
                    hold the system awake for as long as agents are actually working, and let go the
                    moment the last one finishes.
                  </p>
                  <SettingRow
                    title="Stay awake while agents work"
                    detail="Blocks idle sleep only while at least one agent is mid-turn. The display still turns off, and asking your machine to sleep still works. Nothing is held once every agent is idle."
                  >
                    <Toggle
                      label="Toggle keeping the system awake while agents work"
                      checked={currentKeepSystemAwake}
                      onChange={keepSystemAwake.set}
                    />
                  </SettingRow>
                  {currentKeepSystemAwake && (
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
                        ? `Holding the system awake for ${keepAwake.workingAgents} agent${
                            keepAwake.workingAgents === 1 ? '' : 's'
                          } working.`
                        : 'Idle, with nothing held. The hold is taken when an agent starts a turn.'}
                    </p>
                  )}
                </Section>

                <Section title="Browser">
                  <p className="shell-hint" style={{ marginTop: 0, marginBottom: '14px' }}>
                    Give agents a real browser so they can open what they just built, read the page
                    and fix what's wrong, instead of guessing from the dev-server log. Spacron adds
                    Microsoft's Playwright MCP server to each agent's config alongside its own tools.
                    Each agent drives its own Chromium window, separate from the preview panel here,
                    that stays yours.
                  </p>
                  <SettingRow
                    title="Let agents use a browser"
                    detail="Runs `npx @playwright/mcp@latest --isolated` per agent, so it needs Node on your PATH and downloads a browser the first time. Sessions are isolated because agents run concurrently and a shared browser profile can only be held by one of them. Adds a spacron-playwright entry to agent config files, including the global ones for Codex and droid, and removes it again when you turn this off."
                  >
                    <Toggle
                      label="Toggle agent browser tools"
                      checked={currentAgentBrowserTools}
                      onChange={agentBrowserTools.set}
                    />
                  </SettingRow>
                </Section>

                <Section title="Agents">
                  <p className="shell-hint" style={{ marginTop: 0, marginBottom: '14px' }}>
                    Spacron scans each known agent CLI on your PATH and checks whether it has
                    credentials saved, so signed-in agents are ready to spawn without being added
                    by hand. The toggle sets whether every agent launches with its own
                    skip-permissions flag; each row can pin itself to the other mode. Rate limits
                    and reset times live in the usage dock in the corner of the workspace.
                  </p>
                  <AgentsPane />
                </Section>

                <Section title="Coding CLI agents">
                  <p className="shell-hint" style={{ marginTop: 0, marginBottom: '14px' }}>
                    Add your own agent CLI alongside the built-ins (Claude Code, Codex…). It appears in the
                    spawn picker, panes running it show its name, and typing its command in any shell is
                    recognized as that agent. Agents that read a <code>CLAUDE.md</code> / <code>AGENTS.md</code>
                    rules file are briefed automatically. The built-in agents are managed in the list
                    above. Hide one from there and it comes back the same way.
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
              </>
            )}

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
