/**
 * Settings > Chat: everything about the chat view of an agent terminal
 * (`TerminalChatView`), laid out the way Orca lays out its chat settings:
 * opening and per-agent launch mode, appearance, turn activity, behaviour.
 *
 * Every control here is honoured by the view. Orca settings that only make
 * sense for its own app-hosted chat sessions (stop idle agents, resume after
 * restart, shell environment, naming agents) are left out on purpose: a chat
 * here is a view of a live terminal, which already does those things itself.
 */

import { useEffect, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { useStore } from '$lib/react/useStore';
import Dropdown from '$lib/components/shared/Dropdown.tsx';
import { AgentBrandMark } from './useAgentBrand';
import {
  CHAT_CAPABLE_AGENTS,
  agentLaunchView,
  agentLaunchViewByAgent,
  type AgentLaunchView,
} from '$lib/services/terminal-chat';
import {
  CHAT_CODE_FONT_SIZE_RANGE,
  CHAT_CONTRAST_RANGE,
  CHAT_FONT_SIZE_RANGE,
  DEFAULT_CHAT_APPEARANCE,
  chatAppearance,
  chatAutoNames,
  chatModelNames,
  chatCiLines,
  chatComposerSpellcheck,
  chatInlineVisuals,
  chatLinkPreviews,
  chatMarkNewMessages,
  chatPullRequests,
  chatQueueFollowUps,
  chatScrollToLatestOnSend,
  chatShowTimestamps,
  chatSuggestedPrompts,
  chatTurnDiffs,
  chatUsageAutoContinue,
  type ChatAppearance,
  type ChatFontChoice,
  type ChatWidth,
} from '$lib/stores/chatViewSettings';
import {
  agentCmdOverrides,
  agentDefaultArgs,
  agentDefaultEnv,
  agentPermissionMode,
  chatAutoAnswerInline,
  chatDefaultAccessMode,
} from '$lib/stores/settings';
import type { ChatAccessMode } from '$lib/types/chat';
import { effectiveAgentMode } from '$lib/services/agent-permissions';
import { getAgentDisplayName } from '$lib/stores/terminal';
import './ChatSettingsPane.css';

function searchKey(value: string): string {
  return value.trim().toLowerCase().replace(/\s+/g, '-');
}

function Card({ title, subtitle, children }: { title?: string; subtitle?: string; children: React.ReactNode }) {
  return (
    <section className="settings-card chat-settings-card" data-settings-section={title ? searchKey(title) : undefined}>
      {title && <h3>{title}</h3>}
      {subtitle && <p className="chat-settings-subtitle">{subtitle}</p>}
      <div className="settings-card-body">{children}</div>
    </section>
  );
}

function Row({ title, detail, children }: { title: string; detail?: React.ReactNode; children?: React.ReactNode }) {
  return (
    <div className="settings-control-row" data-settings-key={searchKey(title)}>
      <div className="settings-control-copy">
        <span>{title}</span>
        {detail && <small>{detail}</small>}
      </div>
      {children && <div className="settings-control">{children}</div>}
    </div>
  );
}

function Toggle({ checked, onChange, label }: { checked: boolean; onChange: (checked: boolean) => void; label: string }) {
  return (
    <button
      type="button"
      className={`settings-toggle${checked ? ' active' : ''}`}
      onClick={() => onChange(!checked)}
      aria-label={label}
      aria-pressed={checked}
    >
      <span />
    </button>
  );
}

/** A row of choices with one picked, like Orca's Chat | CLI and width switches. */
function Segmented<T extends string>({ value, options, onChange, label, size = 'md' }: {
  value: T;
  options: { value: T; label: string }[];
  onChange: (value: T) => void;
  label: string;
  size?: 'sm' | 'md';
}) {
  return (
    <div className={`chat-settings-seg ${size}`} role="radiogroup" aria-label={label}>
      {options.map((option) => (
        <button
          key={option.value}
          type="button"
          role="radio"
          aria-checked={option.value === value}
          className={option.value === value ? 'active' : undefined}
          onClick={() => onChange(option.value)}
        >
          {option.label}
        </button>
      ))}
    </div>
  );
}

/** A px field that commits on blur or Enter and keeps the value in range. */
function PxInput({ value, min, max, onChange, label }: { value: number; min: number; max: number; onChange: (value: number) => void; label: string }) {
  const [text, setText] = useState<string | null>(null);
  const commit = () => {
    if (text == null) return;
    const n = Math.round(Number(text));
    if (Number.isFinite(n)) onChange(Math.min(max, Math.max(min, n)));
    setText(null);
  };
  return (
    <span className="chat-settings-px">
      <input
        type="number"
        min={min}
        max={max}
        step={1}
        value={text ?? String(value)}
        aria-label={label}
        onChange={(e) => setText(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === 'Enter') commit();
          if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
            e.preventDefault();
            onChange(Math.min(max, Math.max(min, value + (e.key === 'ArrowUp' ? 1 : -1))));
            setText(null);
          }
        }}
      />
      <span>px</span>
    </span>
  );
}

const FONT_STACKS: Record<'app' | 'system' | 'terminal', string> = {
  app: 'var(--font-sans)',
  system: "system-ui, -apple-system, 'Segoe UI', sans-serif",
  terminal: 'var(--terminal-font-family, ui-monospace, monospace)',
};

function fontStack(font: ChatFontChoice): string {
  if (font === 'app' || font === 'system' || font === 'terminal') return FONT_STACKS[font as 'app' | 'system' | 'terminal'];
  return `"${font}", system-ui, sans-serif`;
}

/** Installed font families, read once per app run (`system_font_families`). */
let installedFonts: Promise<string[]> | null = null;

function useInstalledFonts(): string[] | null {
  const [fonts, setFonts] = useState<string[] | null>(null);
  useEffect(() => {
    let cancelled = false;
    installedFonts ??= invoke<string[]>('system_font_families').catch(() => []);
    void installedFonts.then((list) => { if (!cancelled) setFonts(list); });
    return () => { cancelled = true; };
  }, []);
  return fonts;
}

function appFontSize(): number {
  if (typeof document === 'undefined') return 14;
  return Math.round(parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--ui-font-size')) || 14);
}

/** Names as Orca lists them, for presets whose display name is just the command. */
const CHAT_AGENT_NAMES: Record<string, string> = {
  copilot: 'GitHub Copilot',
  omp: 'OMP',
  openclaude: 'OpenClaude',
  'cursor-agent': 'Cursor',
  agy: 'Antigravity',
};

const MODE_LABEL = { yolo: 'Full access', manual: 'Asks for approval', custom: 'Custom' } as const;

/**
 * The appearance controls, shared by Settings > Chat (agent chats) and
 * Settings > Bots (bot chats): each passes its own value and where to save it.
 */
export function ChatAppearanceRows({ appearance, onChange, showMatchTerminal = true }: {
  appearance: ChatAppearance;
  onChange: (next: ChatAppearance) => void;
  /** Bot chats have no terminal to match. */
  showMatchTerminal?: boolean;
}) {
  const patch = (next: Partial<ChatAppearance>) => onChange({ ...appearance, ...next });
  const appSize = appFontSize();
  const fonts = useInstalledFonts();
  const isDefault = JSON.stringify(appearance) === JSON.stringify(DEFAULT_CHAT_APPEARANCE);
  return (
    <>
        {showMatchTerminal && (
          <Row
            title="Match terminal interface"
            detail="Use terminal font and colors across chat."
          >
            <Toggle label="Toggle match terminal interface" checked={appearance.matchTerminal} onChange={(on) => patch({ matchTerminal: on })} />
          </Row>
        )}
        <Row title="Contrast" detail="Adjust text contrast against the background.">
          <div className="chat-settings-contrast">
            <span>Softer</span>
            <input
              type="range"
              min={CHAT_CONTRAST_RANGE.min}
              max={CHAT_CONTRAST_RANGE.max}
              step={1}
              value={appearance.contrast}
              aria-label="Chat contrast"
              onChange={(e) => patch({ contrast: Number(e.target.value) })}
              onDoubleClick={() => patch({ contrast: 100 })}
            />
            <span>Sharper</span>
            <b>{appearance.contrast}</b>
          </div>
        </Row>
        <div className="settings-control-row chat-settings-font" data-settings-key="font-family">
          <div className="settings-control-copy">
            <span>Font family</span>
            <small>Font for messages, activity, and input.</small>
          </div>
          <div className="settings-control">
            <Dropdown
              options={[
                { value: 'system', label: 'System font' },
                { value: 'app', label: 'Same as app' },
                { value: 'terminal', label: 'Same as terminal' },
                // The font picked earlier stays listed even if it was uninstalled since.
                ...(['app', 'system', 'terminal'].includes(appearance.font) || fonts?.includes(appearance.font)
                  ? []
                  : [{ value: appearance.font, label: appearance.font }]),
                ...(fonts ?? []).map((family) => ({ value: family, label: family })),
              ]}
              value={appearance.font}
              onChange={(val) => patch({ font: val as ChatFontChoice })}
              ariaLabel="Chat font family"
              menuMaxHeight={360}
            />
          </div>
          <div
            className="chat-settings-font-preview"
            style={{ '--chat-preview-font': appearance.matchTerminal ? FONT_STACKS.terminal : fontStack(appearance.font) } as React.CSSProperties}
          >
            The quick brown fox jumps over the lazy dog. <code>fontFamily</code>
          </div>
        </div>
        <Row
          title="Text size"
          detail={`Message and input font size (default: ${appSize}px).`}
        >
          <PxInput
            label="Chat text size"
            value={appearance.fontSize ?? appSize}
            min={CHAT_FONT_SIZE_RANGE.min}
            max={CHAT_FONT_SIZE_RANGE.max}
            onChange={(n) => patch({ fontSize: n === appSize ? null : n })}
          />
        </Row>
        <Row title="Code text size" detail={`Code block and output font size (default: ${DEFAULT_CHAT_APPEARANCE.codeFontSize}px).`}>
          <PxInput
            label="Chat code text size"
            value={appearance.codeFontSize}
            min={CHAT_CODE_FONT_SIZE_RANGE.min}
            max={CHAT_CODE_FONT_SIZE_RANGE.max}
            onChange={(n) => patch({ codeFontSize: n })}
          />
        </Row>
        <Row title="Width" detail="Maximum message width in wide panes.">
          <Segmented<ChatWidth>
            label="Chat width"
            value={appearance.width}
            options={[
              { value: 'comfortable', label: 'Comfortable' },
              { value: 'wide', label: 'Wide' },
              { value: 'full', label: 'Full' },
            ]}
            onChange={(width) => patch({ width })}
          />
        </Row>
        <Row title="Reset chat appearance" detail="Restore default appearance settings.">
          <button type="button" className="settings-secondary" disabled={isDefault} onClick={() => onChange({ ...DEFAULT_CHAT_APPEARANCE })}>
            Reset
          </button>
        </Row>
    </>
  );
}

export default function ChatSettingsPane({ onOpenAgents }: { onOpenAgents: () => void }) {
  const launchView = useStore(agentLaunchView);
  const launchByAgent = useStore(agentLaunchViewByAgent);
  const appearance = useStore(chatAppearance);
  const scrollOnSend = useStore(chatScrollToLatestOnSend);
  const spellcheck = useStore(chatComposerSpellcheck);
  const inlineVisuals = useStore(chatInlineVisuals);
  const queueFollowUps = useStore(chatQueueFollowUps);
  const markNew = useStore(chatMarkNewMessages);
  const autoNames = useStore(chatAutoNames);
  const modelNames = useStore(chatModelNames);
  const timestamps = useStore(chatShowTimestamps);
  const suggested = useStore(chatSuggestedPrompts);
  const turnDiffs = useStore(chatTurnDiffs);
  const pullRequests = useStore(chatPullRequests);
  const ciLines = useStore(chatCiLines);
  const linkPreviews = useStore(chatLinkPreviews);
  const usageContinue = useStore(chatUsageAutoContinue);
  const permissionMode = useStore(agentPermissionMode);
  const defaultAccess = useStore(chatDefaultAccessMode);
  const autoAnswerInline = useStore(chatAutoAnswerInline);
  const cmdOverrides = useStore(agentCmdOverrides);
  const defaultArgs = useStore(agentDefaultArgs);
  const defaultEnv = useStore(agentDefaultEnv);

  const agentName = (preset: string) => CHAT_AGENT_NAMES[preset] ?? getAgentDisplayName(preset) ?? preset;
  const setAgentView = (preset: string, view: AgentLaunchView) => agentLaunchViewByAgent.set({ ...launchByAgent, [preset]: view });

  return (
    <>
      <Card title="Opening">
        <Row
          title="Open new agents in"
          detail="Choose default view for new agent sessions (Ctrl+Shift+J to toggle)."
        >
          <Segmented<AgentLaunchView>
            label="Open new agents in"
            value={launchView}
            options={[{ value: 'chat', label: 'Chat' }, { value: 'terminal', label: 'CLI' }]}
            onChange={(view) => agentLaunchView.set(view)}
          />
        </Row>
      </Card>

      <Card title="Default launch mode per agent" subtitle="Default view for supported agents.">
        {CHAT_CAPABLE_AGENTS.map((preset) => (
          <div key={preset} className="settings-control-row chat-settings-agent" data-settings-key={searchKey(agentName(preset))}>
            <div className="settings-control-copy chat-settings-agent-name">
              <span className="chat-settings-agent-mark"><AgentBrandMark command={preset} name={agentName(preset)} /></span>
              <span>{agentName(preset)}</span>
            </div>
            <div className="settings-control">
              <Segmented<AgentLaunchView>
                size="sm"
                label={`${agentName(preset)} opens in`}
                value={launchByAgent[preset] ?? launchView}
                options={[{ value: 'chat', label: 'Chat' }, { value: 'terminal', label: 'CLI' }]}
                onChange={(view) => setAgentView(preset, view)}
              />
            </div>
          </div>
        ))}
      </Card>

      <Card title="Appearance">
        <ChatAppearanceRows appearance={appearance} onChange={(next) => chatAppearance.set(next)} />
      </Card>

      <Card title="Turn activity">
        <Row title="Turn diffs" detail="Show file edits and line counts after each turn.">
          <Toggle label="Toggle turn diffs" checked={turnDiffs} onChange={chatTurnDiffs.set} />
        </Row>
        <Row title="Opened pull requests" detail="Show pull requests opened by agents.">
          <Toggle label="Toggle opened pull requests" checked={pullRequests} onChange={chatPullRequests.set} />
        </Row>
        <Row title="CI result lines" detail="Show CI check results on opened pull requests.">
          <Toggle label="Toggle CI result lines" checked={ciLines} onChange={chatCiLines.set} />
        </Row>
      </Card>

      <Card>
        <Row title="Inline visuals" detail="Allow agents to render inline charts and interactive mockups.">
          <Toggle label="Toggle inline visuals" checked={inlineVisuals} onChange={chatInlineVisuals.set} />
        </Row>
      </Card>

      <Card title="Behavior">
        <Row
          title="Default access for new chats"
          detail="Applied when a chat starts. Inherit uses the per-agent permissions below."
        >
          <Dropdown
            options={[
              { value: 'inherit', label: 'Inherit from Agents' },
              { value: 'supervised', label: 'Asks for approval' },
              { value: 'auto-edits', label: 'Auto-edit files' },
              { value: 'auto', label: 'Auto' },
              { value: 'full-access', label: 'Full access' },
            ]}
            value={defaultAccess}
            onChange={(value) => chatDefaultAccessMode.set(value as ChatAccessMode)}
            ariaLabel="Default access for new chats"
          />
        </Row>
        <Row
          title="Answer safe read-only requests automatically"
          detail="Auto-approves reads and searches in ACP, Claude and Pi chats; commands and edits still ask."
        >
          <Toggle
            label="Toggle automatic read-only answers"
            checked={autoAnswerInline}
            onChange={chatAutoAnswerInline.set}
          />
        </Row>
        <Row title="Permissions for new chats" detail="Inherits permissions configured under Settings → Agents.">
          <button type="button" className="chat-settings-link" onClick={onOpenAgents}>Settings → Agents</button>
        </Row>
        {CHAT_CAPABLE_AGENTS.map((preset) => (
          <div key={`perm-${preset}`} className="settings-control-row chat-settings-perm">
            <div className="settings-control-copy"><span>{agentName(preset)}</span></div>
            <div className="settings-control">
              <span className="chat-settings-muted">
                {MODE_LABEL[effectiveAgentMode(preset, permissionMode, { agentCmdOverrides: cmdOverrides, agentDefaultArgs: defaultArgs, agentDefaultEnv: defaultEnv })]}
              </span>
            </div>
          </div>
        ))}
        <Row
          title="Continue chats automatically when a usage limit resets"
          detail="Automatically continue chats when quota limits reset."
        >
          <Toggle label="Toggle continue after usage limits" checked={usageContinue} onChange={chatUsageAutoContinue.set} />
        </Row>
        <Row
          title="Queue follow-ups"
          detail="Queue follow-up messages while an agent is actively working."
        >
          <Toggle label="Toggle queue follow-ups" checked={queueFollowUps} onChange={chatQueueFollowUps.set} />
        </Row>
        <Row title="Scroll to latest when sending" detail="Jump to latest message when sending.">
          <Toggle label="Toggle scroll to latest when sending" checked={scrollOnSend} onChange={chatScrollToLatestOnSend.set} />
        </Row>
        <Row title="Mark new messages when returning to a chat" detail="Mark unread messages received while away.">
          <Toggle label="Toggle mark new messages" checked={markNew} onChange={chatMarkNewMessages.set} />
        </Row>
        <Row title="Chat names" detail="Name each new chat from its first message. Renaming always wins.">
          <Toggle label="Toggle automatic chat names" checked={autoNames} onChange={chatAutoNames.set} />
        </Row>
        <Row title="Model-written chat names" detail="Ask your AI provider for a short title after the first message. Sends that message to the provider and uses a few credits per chat. Needs Chat names on.">
          <Toggle label="Toggle model-written chat names" checked={modelNames} onChange={chatModelNames.set} />
        </Row>
        <Row title="Link previews" detail="Show preview cards when hovering web links.">
          <Toggle label="Toggle link previews" checked={linkPreviews} onChange={chatLinkPreviews.set} />
        </Row>
        <Row title="Spellcheck and autocorrect" detail="Check spelling in the chat input.">
          <Toggle label="Toggle spellcheck and autocorrect" checked={spellcheck} onChange={chatComposerSpellcheck.set} />
        </Row>
        <Row title="Show timestamps" detail="Show timestamps next to messages.">
          <Toggle label="Toggle timestamps" checked={timestamps} onChange={chatShowTimestamps.set} />
        </Row>
        <Row title="Suggested prompts" detail="Show starter suggestions in empty chats.">
          <Toggle label="Toggle suggested prompts" checked={suggested} onChange={chatSuggestedPrompts.set} />
        </Row>
      </Card>
    </>
  );
}
