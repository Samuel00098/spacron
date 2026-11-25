import { useEffect, useMemo, useRef, useState } from 'react';
import { useStore } from '$lib/react/useStore';
import { projects } from '$lib/stores/workspace';
import { get } from '$lib/stores/storeCompat';
import { isModalOpen } from '$lib/react/useModalFocus';
import { activeConnection, activeRemoteId, connectRemote, connectionStatus, remoteConnections, remoteTarget } from '$lib/stores/remoteWorkspace';
import { customAgents, removedPresetAgents } from '$lib/stores/customAgents';
import { usageState } from '$lib/stores/usage';
import { getAgentRoster } from '$lib/stores/runs';
import { freshLiveAgentProviderModels } from '$lib/services/live-agent-models';
import { stripTerminalOutput } from '$lib/services/orchestrator/activity-log';
import type { AgentProviderModel } from '$lib/services/agent-provider-catalogue';
import { computerUse as computerUseSetting, mcpServers } from '$lib/stores/settings';
import { computerUseSupported } from '$lib/stores/computerUse';
import { showToast } from '$lib/stores/notification';
import { AgentBrandMark } from '$lib/components/shared/useAgentBrand';
import Dropdown from '$lib/components/shared/Dropdown';
import { ACCESS_OPTIONS } from '$lib/components/shared/BotSettingsSection';
import { boxMcpInfo, sharedSignIns } from '$lib/services/box-signins';
import {
  BOT_TEMPLATES, LOCAL_HOST, MAX_BOT_STARTER_LENGTH, MAX_BOT_STARTER_PROMPTS, agentProgram, botAgents, botConnectorNames, botHostState, botSettings, botStarterPrompts, bots, canRunHeadless, closeBots,
  connectorChoices, deleteBotChat, fetchBotLog, latestRun, localAvailable, nextBotRun, refreshBotState, removeBot, runBotNow, runsFor,
  attachToBot, attachmentPreview, botVisualSpot, FILES_ONLY_MESSAGE, MAX_ATTACHMENTS,
  botDraftQueue, saveBot, selectedBotId, sendBotMessage, stopBotRun, suggestBotAvatar, toggleBot, visibleBots,
  type Bot, type BotAccess, type BotRun, type BotSchedule, type BotTemplate,
} from '$lib/services/bots/bots';
import { BOT_NOTIFY_MODES, botNotifyModes, setBotNotifyMode, type BotNotifyMode } from '$lib/services/bots/botNotify';
import { botAutoArchive, botChats, newBotChat, setBotAutoArchive, setBotChatArchived, splitChats, type BotChat as ChatThread } from '$lib/services/bots/botChats';
import { BOT_AVATARS, DEFAULT_AVATAR, avatarUrl, resizeAvatar } from '$lib/services/bots/avatars';
import { Dots, Markdown, UserTurn, contrastVars } from '$lib/components/terminal/TerminalChatView';
import { MessageActions, markPointerMessage, clearPointerMessage } from '$lib/components/terminal/TerminalChatRich';
import { CHAT_WIDTH_COLUMN } from '$lib/stores/chatViewSettings';
import {
  botChatAppearance,
  botChatSuggestedPrompts,
  botChatTimestamps,
  botChatVisuals,
} from '$lib/stores/botChatSettings';
import { ChatVisual, ChatVisualStatus, splitReply, visualReplyText } from '$lib/components/terminal/ChatVisual';
import type { ChatVisualsSpot } from '$lib/stores/terminal';
import '$lib/components/terminal/TerminalChatRich.css';
import '$lib/components/terminal/TerminalChatView.css';
import './Bots.css';

/** `selectedBotId` value that opens the editor for a new bot. */
export const NEW_BOT = '__new__';

/** Agents with no per-project MCP file: kept in step with `GLOBAL_ONLY` in `remote/bot_mcp.rs`. */
const GLOBAL_MCP_ONLY = new Set(['agy', 'droid']);

const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const SCHEDULES: { value: BotSchedule; label: string }[] = [
  { value: 'manual', label: 'Only when I run it or chat' },
  { value: 'hourly', label: 'Every hour' },
  { value: 'daily', label: 'Every day' },
  { value: 'weekdays', label: 'Weekdays' },
  { value: 'weekly', label: 'Every week' },
];

export function BotIcon({ size = 18 }: { size?: number }) {
  return <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <rect x="4" y="8" width="16" height="12" rx="3" /><path d="M12 4v4M9 14h.01M15 14h.01M2 13v3M22 13v3" /></svg>;
}

/** A bot's picture: a built-in avatar or the one the user uploaded. */
export function BotAvatar({ avatar, size = 32, className = '' }: { avatar?: string | null; size?: number; className?: string }) {
  return <img className={`bot-avatar${avatar?.startsWith('data:image/') ? ' bot-avatar-uploaded' : ''} ${className}`} src={avatarUrl(avatar)} alt="" width={size} height={size} draggable={false}
    onError={(e) => { const img = e.currentTarget; if (!img.src.endsWith(`/${DEFAULT_AVATAR}.webp`)) img.src = avatarUrl(DEFAULT_AVATAR); }} />;
}

export function botScheduleLabel(b: Pick<Bot, 'schedule' | 'time' | 'day'>): string {
  if (b.schedule === 'manual') return 'On demand';
  if (b.schedule === 'hourly') return `Every hour at :${b.time.slice(3)}`;
  const when = b.schedule === 'weekly' ? WEEKDAYS[b.day] : b.schedule === 'weekdays' ? 'Mon to Fri' : 'Every day';
  return `${when} at ${b.time}`;
}

/** The project-folder dropdown's "Choose a folder…" entry. */
const CHOOSE_FOLDER = '__choose__';

function when(ms?: number | null): string {
  return ms ? new Date(ms).toLocaleString(undefined, { weekday: 'short', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }) : '';
}

function clock(ms: number): string {
  const d = new Date(ms);
  const today = new Date().toDateString() === d.toDateString();
  return today ? d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' }) : when(ms);
}

function duration(run: BotRun): string {
  if (!run.finishedAt) return '';
  const s = Math.max(0, Math.round((run.finishedAt - run.startedAt) / 1000));
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${s % 60}s`;
}

const STATUS_LABEL: Record<BotRun['status'], string> = {
  running: 'Running', completed: 'Done', failed: 'Failed', stopped: 'Stopped', missed: 'Missed', interrupted: 'Interrupted',
};

/** Whether computer use works on this PC (Windows, macOS, Linux on X11), behind its Settings switch. */
function useComputerUseOnThisPc(): 'ready' | 'off' | 'unsupported' | 'unknown' {
  const enabled = useStore(computerUseSetting);
  const [supported, setSupported] = useState<boolean | null>(null);
  useEffect(() => { void computerUseSupported().then(setSupported).catch(() => setSupported(false)); }, []);
  if (supported === null) return 'unknown';
  if (!supported) return 'unsupported';
  return enabled ? 'ready' : 'off';
}

/** "This PC" or the box's name. */
function useHostName() {
  const box = useStore(activeConnection);
  return (host: string) => (host === LOCAL_HOST ? 'This PC' : box && box.id === host ? box.name : 'a box');
}

export default function BotsPanel() {
  const list = useStore(bots);
  const selected = useStore(selectedBotId);
  const remote = useStore(remoteTarget);
  const boxId = useStore(activeRemoteId);
  const state = useStore(botHostState);
  useStore(botSettings);
  const [stateError, setStateError] = useState('');
  const mine = visibleBots(list);
  const anyRunning = Object.values(state).some((h) => h.runs.some((r) => r.status === 'running'));
  const canHost = localAvailable() || Boolean(remote);

  // Poll while the panel is open: quickly while something runs.
  useEffect(() => {
    if (!canHost) return;
    let alive = true;
    const load = () => refreshBotState().then(() => { if (alive) setStateError(''); }).catch((e) => { if (alive) setStateError(String(e)); });
    void load();
    const timer = window.setInterval(load, anyRunning ? 2_000 : 15_000);
    return () => { alive = false; window.clearInterval(timer); };
  }, [canHost, boxId, anyRunning]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' || e.defaultPrevented || isModalOpen()) return;
      const t = e.target as HTMLElement | null;
      if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return;
      closeBots();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  if (!canHost) return <NoHost />;
  const bot = mine.find((b) => b.id === selected) ?? null;
  if (bot) return <section className="bots-panel" aria-label={`Bot ${bot.name}`}><BotView key={bot.id} bot={bot} runs={runsFor(state, bot)} homeRoot={state[bot.boxId]?.homeRoot ?? ''} /></section>;
  return (
    <section className="bots-panel" aria-label="Bots">
      <header className="bots-header">
        <span className="bots-header-icon"><BotIcon size={22} /></span>
        <div>
          <h2>Bots</h2>
          <p>Chat with your bots or give them a job to run on a schedule.</p>
        </div>
        {selected !== NEW_BOT && <button type="button" className="bots-primary" onClick={() => selectedBotId.set(NEW_BOT)}>+ New bot</button>}
        <CloseButton />
      </header>
      {stateError && <p role="alert" className="bots-error">Could not load runs: {stateError}</p>}
      {selected === NEW_BOT
        ? <BotEditor onDone={(id) => selectedBotId.set(id)} />
        : <div className="bots-body"><BotList bots={mine} /></div>}
    </section>
  );
}

function CloseButton() {
  return <button type="button" className="bots-close" aria-label="Close Bots" title="Back to the workspace (Esc)" onClick={closeBots}>×</button>;
}

/** Only in a plain browser with no box: there is nowhere to run a bot. */
function NoHost() {
  const connections = useStore(remoteConnections);
  const status = useStore(connectionStatus);
  return (
    <section className="bots-panel" aria-label="Bots">
      <div className="bots-panel-close"><CloseButton /></div>
      <div className="bots-empty">
        <BotAvatar avatar="robot" size={72} className="bots-empty-avatar" />
        <h3>Bots need somewhere to run</h3>
        <p>A bot is an agent with a standing job, like a daily digest or a weekly research report. It runs on this PC in the Spacron desktop app, or on your remote box so it keeps working while the laptop is closed.</p>
        {connections.length > 0 && <div className="bots-connect-list">
          {connections.map((c) => <button key={c.id} type="button" disabled={status === 'connecting'} onClick={() => void connectRemote(c.id)}>
            {status === 'connecting' ? 'Connecting…' : `Connect to ${c.name}`}
          </button>)}
        </div>}
      </div>
    </section>
  );
}

function BotList({ bots: list }: { bots: Bot[] }) {
  const state = useStore(botHostState);
  const hostName = useHostName();
  const groups = [...new Set(list.map((b) => b.boxId))].sort((a, b) => (a === LOCAL_HOST ? -1 : b === LOCAL_HOST ? 1 : 0));
  return <div className="bots-library">
    {!list.length && <div className="bots-empty bots-list-empty">
      <BotAvatar avatar="robot" size={64} />
      <h3>Create your first bot</h3>
      <p>Start with a template below or create a bot with your own instructions.</p>
    </div>}
    {groups.map((host) => (
      <section key={host} className="bots-group">
        <h4>{hostName(host)}</h4>
        <div className="bots-grid">
          {list.filter((b) => b.boxId === host).sort((a, b) => a.name.localeCompare(b.name)).map((b) => {
            const run = latestRun(state, b);
            const next = nextBotRun(b);
            const tools = [b.canCreateBots && 'Creates bots', b.computerUse && 'Computer use', b.browser && 'Browser', ...botConnectorNames(b)].filter(Boolean);
            return (
              <button key={b.id} type="button" className="bots-card" onClick={() => selectedBotId.set(b.id)}>
                <div className="bots-card-top">
                  <BotAvatar avatar={b.avatar} size={40} />
                  <div className="bots-card-title">
                    <strong>{b.name}</strong>
                    {b.schedule !== 'manual' && <small>{botScheduleLabel(b)}{next ? ` · next ${when(next)}` : ''}</small>}
                  </div>
                  <StatusChip bot={b} run={run} />
                </div>
                <p>{b.instructions}</p>
                {tools.length > 0 && <small className="bots-card-tools">{tools.join(' · ')}</small>}
              </button>
            );
          })}
        </div>
      </section>
    ))}
    <TemplateGrid title="Start from a template" />
  </div>;
}

function StatusChip({ bot, run }: { bot: Bot; run?: BotRun }) {
  const settings = useStore(botSettings);
  if (run?.status === 'running') return <span className="bots-chip running">Working</span>;
  if (bot.schedule === 'manual') return <span className="bots-chip">On demand</span>;
  const on = bot.enabled && settings.enabled;
  return <span className={`bots-chip ${on ? 'scheduled' : ''}`}>{on ? 'Scheduled' : 'Paused'}</span>;
}

/** A template picked from the list, applied when the editor opens. */
let pendingTemplate: BotTemplate | null = null;

function TemplateGrid({ onPick, title = 'Or start from a template', selectedId }: { onPick?: (t: BotTemplate) => void; title?: string; selectedId?: string }) {
  return (
    <div className="bots-templates">
      {title && <h4>{title}</h4>}
      <div className="bots-template-grid">
        {BOT_TEMPLATES.map((t) => <button key={t.id} type="button" className="bots-template" aria-pressed={onPick ? t.id === selectedId : undefined} onClick={() => {
          if (onPick) onPick(t);
          else { pendingTemplate = t; selectedBotId.set(NEW_BOT); }
        }}>
          <BotAvatar avatar={t.avatar} size={36} />
          <span><strong>{t.name}</strong><small>{t.blurb}</small></span>
        </button>)}
      </div>
    </div>
  );
}

// ── editor ──────────────────────────────────────────────────────────────────

function AvatarPicker({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  const [open, setOpen] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);
  async function upload(file: File | undefined) {
    if (!file) return;
    try { onChange(await resizeAvatar(file)); setOpen(false); } catch (e) { showToast(e instanceof Error ? e.message : String(e), 'error'); }
  }
  return (
    <div className="bots-avatar-picker">
      <button type="button" className="bots-avatar-current" onClick={() => setOpen((o) => !o)} aria-expanded={open} aria-label="Change the bot's picture" title="Change picture">
        <BotAvatar avatar={value} size={64} />
        <span>Change</span>
      </button>
      {open && <div className="bots-avatar-popover">
        <div className="bots-avatar-grid" role="listbox" aria-label="Bot pictures">
          {BOT_AVATARS.map((a) => <button key={a.id} type="button" role="option" aria-selected={value === a.id} title={a.label} onClick={() => { onChange(a.id); setOpen(false); }}>
            <BotAvatar avatar={a.id} size={44} />
          </button>)}
        </div>
        <button type="button" className="bots-avatar-upload" onClick={() => fileRef.current?.click()}>
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M12 16V4m-5 5 5-5 5 5M4 16v3a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1v-3" /></svg>
          <span>Upload an image</span>
        </button>
        <input ref={fileRef} type="file" accept="image/png,image/jpeg,image/webp,image/gif" hidden onChange={(e) => { void upload(e.target.files?.[0]); e.target.value = ''; }} />
      </div>}
    </div>
  );
}

function ConnectorPicker({ host, value, onChange }: { host: string; value: string[]; onChange: (v: string[]) => void }) {
  useStore(mcpServers);
  useStore(sharedSignIns);
  useStore(botSettings);
  const choices = connectorChoices(host);
  if (!choices.length) return <p className="bots-helper">No connectors yet. Add Gmail, Google Drive, Notion and more in Settings &gt; MCP &amp; plugins.</p>;
  return (
    <div className="bots-connectors">
      {choices.map((c) => {
        const on = value.includes(c.key);
        return <label key={c.key} className={`bots-connector${on ? ' on' : ''}${c.usable ? '' : ' disabled'}`} title={c.reason}>
          <input type="checkbox" checked={on && c.usable} disabled={!c.usable} onChange={(e) => onChange(e.target.checked ? [...value, c.key] : value.filter((k) => k !== c.key))} />
          {c.icon ? <img src={c.icon} alt="" width={16} height={16} /> : <span className="bots-connector-letter" aria-hidden="true">{c.name.slice(0, 1).toUpperCase()}</span>}
          <span>{c.name}</span>
        </label>;
      })}
    </div>
  );
}

/** Connector keys a template wants that are set up on `host`. */
function templateKeys(t: BotTemplate | null, host: string): string[] {
  if (!t?.connectors?.length) return [];
  return connectorChoices(host).filter((c) => c.usable && c.catalogId && t.connectors!.includes(c.catalogId)).map((c) => c.key);
}

/** Saved at once (not with "Save changes"): when this bot may notify you, how its chats are kept, and the ones put away. */
function ChatHistorySettings({ bot, runs }: { bot: Bot; runs: BotRun[] }) {
  const auto = Boolean(useStore(botAutoArchive)[bot.id]);
  const notifyMode: BotNotifyMode = useStore(botNotifyModes)[bot.id] ?? 'all';
  const chatState = useStore(botChats)[bot.id];
  const archived = useMemo(() => splitChats(chatState, runs).filter((c) => c.archived), [chatState, runs]);
  // Delete arms on the first click and deletes on a second within 3 seconds.
  const [armed, setArmed] = useState<number | null>(null);
  const [problem, setProblem] = useState('');
  useEffect(() => {
    if (armed === null) return undefined;
    const timer = setTimeout(() => setArmed(null), 3000);
    return () => clearTimeout(timer);
  }, [armed]);
  async function remove(chat: ChatThread) {
    if (armed !== chat.id) { setArmed(chat.id); return; }
    setArmed(null); setProblem('');
    try { await deleteBotChat(bot, chat); } catch (e) { setProblem(e instanceof Error ? e.message : String(e)); }
  }
  return (
    <>
      <h4 className="bots-editor-section">Notifications</h4>
      <span className="bots-field-label">When a run ends</span>
      <Dropdown ariaLabel="When to notify about this bot" value={notifyMode} onChange={(v) => setBotNotifyMode(bot.id, v as BotNotifyMode)}
        options={BOT_NOTIFY_MODES.map((m) => ({ value: m.value, label: m.label }))} />
      <p className="bots-helper">{BOT_NOTIFY_MODES.find((m) => m.value === notifyMode)?.detail} Notices show what the bot said and take you to its chat. You won't get one for a reply you are already reading.</p>
      <h4 className="bots-editor-section">Chat history</h4>
      <div className="bots-options">
        <label className="bots-option">
          <input type="checkbox" checked={auto} onChange={(e) => setBotAutoArchive(bot.id, e.target.checked)} />
          <span className="bots-option-text">
            <span className="bots-option-title">Archive the old chat when I start a new one</span>
            <span className="bots-option-desc">Keeps the chat list short. Archived chats are only hidden, never deleted, and you can bring them back here or from the chat picker.</span>
          </span>
        </label>
      </div>
      <span className="bots-field-label bots-archived-label">Archived chats{archived.length > 0 ? ` (${archived.length})` : ''}</span>
      {archived.length === 0
        ? <p className="bots-helper bots-archived-empty">Nothing archived yet. Use Archive above a chat to put it away, or Delete to remove it for good.</p>
        : <ul className="bots-archived-list">
          {archived.map((c) => (
            <li key={c.id}>
              <span className="bots-archived-title" title={c.title}>{c.title}</span>
              <span className="bots-archived-when">{c.runs[0] ? when(c.runs[0].startedAt) : ''}</span>
              <button type="button" className="bots-chat-bar-btn" onClick={() => setBotChatArchived(bot.id, c.id, false)}>Unarchive</button>
              <button type="button" className={`bots-chat-bar-btn danger${armed === c.id ? ' armed' : ''}`}
                disabled={c.runs.some((r) => r.status === 'running')}
                title={armed === c.id ? 'Click again to delete this chat for good' : 'Delete this chat and everything in it'}
                onClick={() => void remove(c)}>{armed === c.id ? 'Delete chat?' : 'Delete'}</button>
            </li>
          ))}
        </ul>}
      {problem && <p role="alert" className="bots-error">{problem}</p>}
    </>
  );
}

function BotEditor({ bot, runs = [], onDone }: { bot?: Bot; runs?: BotRun[]; onDone: (id: string | null) => void }) {
  useStore(customAgents);
  useStore(removedPresetAgents);
  useStore(usageState);
  const settings = useStore(botSettings);
  const box = useStore(activeConnection);
  const remote = useStore(remoteTarget);
  const agents = botAgents();
  const [template, setTemplate] = useState<BotTemplate | null>(() => { const t = pendingTemplate; pendingTemplate = null; return t; });
  const start = bot ?? template;
  const hosts = [...(localAvailable() ? [{ value: LOCAL_HOST, label: 'This PC' }] : []), ...(remote && box ? [{ value: box.id, label: box.name }] : [])];
  const [host, setHost] = useState(bot?.boxId ?? hosts[0]?.value ?? LOCAL_HOST);
  const [name, setName] = useState(start?.name ?? '');
  const [instructions, setInstructions] = useState(start?.instructions ?? '');
  const [starterPrompts, setStarterPrompts] = useState(start?.starterPrompts ?? []);
  const [avatar, setAvatar] = useState(() => bot?.avatar ?? suggestBotAvatar(template?.avatar));
  const [agent, setAgent] = useState(bot?.agent ?? agents[0]?.command ?? '');
  const [model, setModel] = useState(bot?.model ?? '');
  const [schedule, setSchedule] = useState<BotSchedule>(start?.schedule ?? 'manual');
  const [time, setTime] = useState(start?.time ?? '09:00');
  const [day, setDay] = useState(start?.day ?? 1);
  const [access, setAccess] = useState<BotAccess>(start?.access ?? settings.defaultAccess);
  const [keys, setKeys] = useState<string[]>(() => bot ? (bot.mcpKeys ?? (bot.connectors ? connectorChoices(bot.boxId).filter((c) => c.usable).map((c) => c.key) : [])) : templateKeys(template, host));
  const [browser, setBrowser] = useState(bot?.browser ?? template?.browser ?? false);
  const [browserVisible, setBrowserVisible] = useState(bot?.browserVisible ?? false);
  const [builder, setBuilder] = useState(bot?.canCreateBots ?? template?.canCreateBots ?? false);
  const [computer, setComputer] = useState(bot?.computerUse ?? template?.computerUse ?? false);
  const [projectDir, setProjectDir] = useState(bot?.projectDir ?? '');
  const openProjects = useStore(projects);
  const pcComputer = useComputerUseOnThisPc();
  const boxInfo = useStore(boxMcpInfo);
  const boxOs = host === LOCAL_HOST ? null : boxInfo?.os ?? 'linux';
  const [error, setError] = useState('');
  const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  const program = agentProgram(agent);
  const modelHost = host === LOCAL_HOST ? 'local' : box?.id === host && remote ? `box:${host}` as const : null;
  const [modelCatalogue, setModelCatalogue] = useState<{ host: string; program: string; models: AgentProviderModel[] }>();
  const currentCatalogue = modelCatalogue?.host === modelHost && modelCatalogue.program === program ? modelCatalogue : undefined;
  const reportedModels = currentCatalogue?.models.filter((entry) => entry.id !== 'default' && entry.supported !== false) ?? [];
  const savedModelMissing = Boolean(model && !reportedModels.some((entry) => entry.id === model));
  useEffect(() => {
    if (!modelHost || !program || program === 'dsh') return;
    let current = true;
    const update = (models: AgentProviderModel[]) => {
      if (current) setModelCatalogue({ host: modelHost, program, models });
    };
    void freshLiveAgentProviderModels(program, false, modelHost).then(update, () => update([]));
    return () => { current = false; };
  }, [modelHost, program]);
  const usesAgentPermissions = program && !['claude', 'codex', 'gemini'].includes(program);
  const interactiveAgents = getAgentRoster().filter((entry) => !canRunHeadless(entry.command));
  let next = '';
  try { next = when(nextBotRun({ schedule, time, day, enabled: true })); } catch { /* incomplete time input */ }
  const missing = template?.connectors?.filter((id) => !connectorChoices(host).some((c) => c.usable && c.catalogId === id)) ?? [];
  async function chooseProjectDir() {
    try {
      const { open } = await import('@tauri-apps/plugin-dialog');
      const picked = await open({ directory: true, multiple: false, title: 'Choose a folder the bot may work in' });
      if (typeof picked === 'string') setProjectDir(picked);
    } catch (e) { setError(e instanceof Error ? e.message : String(e)); }
  }
  function applyTemplate(t: BotTemplate) {
    setTemplate(t); setName(t.name); setInstructions(t.instructions); setSchedule(t.schedule); setTime(t.time); setDay(t.day);
    setStarterPrompts(t.starterPrompts);
    setAccess(t.access); setAvatar(suggestBotAvatar(t.avatar)); setBrowser(t.browser ?? false); setBuilder(t.canCreateBots ?? false); setComputer(t.computerUse ?? false); setKeys(templateKeys(t, host));
  }
  function submit() {
    setError('');
    try {
      const saved = saveBot({
        id: bot?.id, boxId: host, name, instructions, starterPrompts, agent, model: model.trim() || null, schedule, time, day, access,
        connectors: keys.length > 0, mcpKeys: keys, browser, browserVisible: browser && host === LOCAL_HOST && browserVisible, canCreateBots: builder, computerUse: computer, projectDir: projectDir.trim() || null, avatar, enabled: bot?.enabled ?? true,
        ...(bot?.createdBy ? { createdBy: bot.createdBy } : {}),
      });
      showToast(bot ? `Saved "${saved.name}".` : `"${saved.name}" is ready. Say hi to it.`, 'success');
      onDone(saved.id);
    } catch (e) { setError(e instanceof Error ? e.message : String(e)); }
  }
  return (
    <form className="bots-editor" onSubmit={(e) => { e.preventDefault(); submit(); }}>
      <div className="bots-body bots-editor-scroll">
        <div className="bots-editor-content">
          <div className="bots-editor-heading"><h3>{bot ? `Edit ${bot.name}` : 'New bot'}</h3></div>
          {!bot && <details className="bots-template-picker">
            <summary>{template ? `Template: ${template.name}` : 'Browse templates'}</summary>
            <TemplateGrid onPick={applyTemplate} title="" selectedId={template?.id} />
          </details>}
          {error && <p role="alert" className="bots-error">{error}</p>}
          <div className="bots-editor-grid">
            <div className="bots-editor-main">
              <h4>Bot details</h4>
              <div className="bots-identity">
                <AvatarPicker value={avatar} onChange={setAvatar} />
                <div>
                  <label htmlFor="bot-name">Name</label>
                  <input id="bot-name" required maxLength={80} placeholder="e.g. Morning tech digest" value={name} onChange={(e) => setName(e.target.value)} />
                </div>
              </div>
              <label htmlFor="bot-job">Job</label>
              <textarea id="bot-job" aria-describedby="bot-job-help" required rows={8} maxLength={20_000} placeholder="What is this bot for? Say what result you want, and where to save it." value={instructions} onChange={(e) => setInstructions(e.target.value)} />
              <p id="bot-job-help" className="bots-helper">Each run starts a fresh agent with access to the bot’s saved files and recent chat.</p>
              <details className="bots-starter-settings">
                <summary>Suggested prompts</summary>
                <p className="bots-helper">Add up to three messages people can pick in an empty chat. Leave all fields blank to use suggestions based on the bot’s job.</p>
                {botStarterPrompts({ name, instructions }).slice(0, MAX_BOT_STARTER_PROMPTS).map((prompt, index) => (
                  <input key={index} type="text" aria-label={`Suggested prompt ${index + 1}`} maxLength={MAX_BOT_STARTER_LENGTH}
                    placeholder={prompt} value={starterPrompts[index] ?? ''}
                    onChange={(event) => {
                      const value = event.currentTarget.value;
                      setStarterPrompts((previous) => {
                        const next = [...previous];
                        next[index] = value;
                        return next;
                      });
                    }} />
                ))}
              </details>
              <h4 className="bots-editor-section">Tools and connectors</h4>
              <span className="bots-field-label">Connectors</span>
              <ConnectorPicker host={host} value={keys} onChange={setKeys} />
              {missing.length > 0 && <p className="bots-helper bots-warn">This template works best with {missing.join(', ')}. Add it in Settings &gt; MCP &amp; plugins{host === LOCAL_HOST ? '' : ', then share the sign-in with this box in Settings > Bots'}.</p>}
              {keys.length > 0 && GLOBAL_MCP_ONLY.has(program) && <p className="bots-helper">This agent only reads its own global MCP config, so it gets every connector from Settings &gt; MCP &amp; plugins, not just these.</p>}
              <span className="bots-field-label">Abilities</span>
              <div className="bots-options">
                <label className="bots-option">
                  <input type="checkbox" checked={browser} onChange={(e) => setBrowser(e.target.checked)} />
                  <span className="bots-option-text">
                    <span className="bots-option-title">Use a web browser</span>
                    <span className="bots-option-desc">{host === LOCAL_HOST
                      ? 'Opens and uses real pages (sign-ups, forms, sites without an API) in a hidden browser on this PC. Web search works without it.'
                      : `Opens and uses real pages in a hidden browser on the box. The box needs Node, and a browser installed once with "${boxOs === 'linux' ? 'npx playwright install --with-deps chromium' : 'npx playwright install chromium'}".`}</span>
                  </span>
                </label>
                {browser && host === LOCAL_HOST && <label className="bots-option nested">
                  <input type="checkbox" checked={browserVisible} onChange={(e) => setBrowserVisible(e.target.checked)} />
                  <span className="bots-option-text">
                    <span className="bots-option-title">Show the browser while it works</span>
                    <span className="bots-option-desc">Opens a real browser window on this PC so you can watch the bot click and type. Leave it off to run hidden in the background.</span>
                  </span>
                </label>}
                <label className="bots-option">
                  <input type="checkbox" checked={computer} onChange={(e) => setComputer(e.target.checked)} />
                  <span className="bots-option-text">
                    <span className="bots-option-title">Use the computer</span>
                    <span className={`bots-option-desc${computer && host === LOCAL_HOST && pcComputer !== 'ready' ? ' bots-warn' : ''}`}>{host === LOCAL_HOST
                ? pcComputer === 'unsupported'
                  ? 'Sees and operates apps on this PC\'s screen, but this session does not allow it. On Linux, sign in with an X11 (Xorg) session instead of Wayland.'
                  : pcComputer === 'off'
                    ? 'Sees and operates apps on this PC\'s screen. Turn on Settings > Computer use first. Spacron asks you to allow each window it may control, so you need to be there.'
                    : 'Sees and operates apps on this PC\'s screen. Spacron asks you to allow each window it may control, so you need to be there when it runs.'
                : boxOs === 'macos'
                  ? `Operates this Mac box's own screen: screenshots, clicks, typing. ${access === 'full' ? 'It can start programs.' : 'It can start programs only with Full access.'} Allow spacron-server under Screen Recording and Accessibility in System Settings once, and keep a user logged in.`
                  : boxOs === 'windows'
                    ? `Operates this Windows box's own desktop: screenshots, clicks, typing. ${access === 'full' ? 'It can start programs.' : 'It can start programs only with Full access.'} spacron-server must run in a logged-in desktop session (started at sign-in), not as a service.`
                    : `Gets its own virtual desktop on the box to open and operate apps, with no one watching. ${access === 'full' ? 'It can start programs there.' : 'It can start programs there only with Full access.'} The box needs this once: "sudo apt-get install -y xvfb xdotool imagemagick".`}</span>
                  </span>
                </label>
                <label className="bots-option">
                  <input type="checkbox" checked={builder} onChange={(e) => setBuilder(e.target.checked)} />
                  <span className="bots-option-text">
                    <span className="bots-option-title">Can create other bots</span>
                    <span className="bots-option-desc">Bots it creates get no more access than it has, can't create bots themselves, and start with their schedule off until you turn it on.</span>
                  </span>
                </label>
              </div>
              {bot && <ChatHistorySettings bot={bot} runs={runs} />}
            </div>
            <aside className="bots-editor-side">
              <h4>Run settings</h4>
              <span className="bots-field-label">Runs on</span>
              <Dropdown ariaLabel="Where the bot runs" value={host} onChange={(v) => { setHost(v); setModel(''); setKeys(templateKeys(template, v)); }} disabled={Boolean(bot)} options={hosts.length ? hosts : [{ value: host, label: host === LOCAL_HOST ? 'This PC' : 'Box (not connected)' }]} />
              <p className="bots-helper">{host === LOCAL_HOST ? 'Runs while Spacron is open on this PC.' : 'Runs on the box, even while this laptop is closed.'}</p>
              <span className="bots-field-label">Project folder</span>
              {host === LOCAL_HOST
                ? <Dropdown ariaLabel="Project folder the bot may work in" value={projectDir}
                  onChange={(v) => { if (v === CHOOSE_FOLDER) void chooseProjectDir(); else setProjectDir(v); }}
                  options={[
                    { value: '', label: 'None' },
                    ...[...openProjects.values()].map((p) => ({ value: p.root_path, label: p.name, tooltip: p.root_path })),
                    ...(projectDir && ![...openProjects.values()].some((p) => p.root_path === projectDir) ? [{ value: projectDir, label: projectDir, tooltip: projectDir }] : []),
                    { value: CHOOSE_FOLDER, label: 'Choose a folder…' },
                  ]} />
                : <input aria-label="Project folder on the box" placeholder="Full path on the box, or leave empty" value={projectDir} onChange={(e) => setProjectDir(e.target.value)} />}
              <p className="bots-helper">{projectDir.trim()
                ? access === 'research'
                  ? 'The bot can read this folder. Choose "Work in its folder" under Permissions to let it save results there too.'
                  : access === 'folder'
                    ? 'The bot can also save files here, besides its own folder, without full access. It is told to change only what you ask for.'
                    : 'With full access the bot can already write anywhere; this tells it where your project is.'
                : 'Optional. A project the bot may also work in, so it can save results straight into it.'}</p>
              <span className="bots-field-label">Run with</span>
              <Dropdown ariaLabel="Bot agent" value={agent} onChange={(value) => { setAgent(value); setModel(''); }} placeholder="Choose an agent"
                options={[...agents.map((a) => ({ value: a.command, label: a.name, icon: <AgentBrandMark command={a.command} name={a.name} className="bots-agent-mark" /> })),
                  ...interactiveAgents.map((a) => ({ value: a.command, label: `${a.name} (unavailable for bots)`, disabled: true })),
                  ...(agent && !agents.some((a) => a.command === agent) && !interactiveAgents.some((a) => a.command === agent)
                    ? [{ value: agent, label: `${agent} (not installed here)`, disabled: true }] : [])]} />
              {agents.length ? <p className="bots-helper">Uses the agent CLI installed where the bot runs.</p>
                : <p className="bots-error">Install an agent that supports unattended bot runs.</p>}
              {program === 'dsh' ? <p className="bots-helper">DeepSeek Harness uses the model configured in its headless profile.</p> : <>
                <span className="bots-field-label">Model</span>
                <Dropdown ariaLabel="Bot model" value={model} onChange={setModel} disabled={!reportedModels.length && !model}
                  options={[
                    { value: '', label: 'Agent default' },
                    ...reportedModels.map((entry) => ({ value: entry.id, label: entry.label, tooltip: entry.id })),
                    ...(savedModelMissing ? [{ value: model, label: `${model} (saved model)`, disabled: true }] : []),
                  ]} />
                {modelHost && program && !currentCatalogue
                  ? <p className="bots-helper" role="status">Loading models from the agent…</p>
                  : !reportedModels.length && <p className="bots-helper">No model list reported. The agent can use its configured default.</p>}
              </>}
              <span className="bots-field-label">Permissions</span>
              <Dropdown ariaLabel="What the bot may do" value={access} onChange={(v) => setAccess(v as BotAccess)} options={ACCESS_OPTIONS.map((o) => ({ value: o.value, label: o.label }))} />
              <p className={`bots-helper${access === 'full' ? ' bots-warn' : ''}`}>{usesAgentPermissions
                ? 'This guides the bot’s instructions. The agent CLI enforces its own permissions.'
                : ACCESS_OPTIONS.find((o) => o.value === access)?.detail}</p>
              <span className="bots-field-label">Schedule</span>
              <Dropdown ariaLabel="Bot schedule" value={schedule} onChange={(v) => setSchedule(v as BotSchedule)} options={SCHEDULES} />
              {schedule !== 'manual' && <div className="bots-time-row">
                <div>
                  <label htmlFor="bot-time">{schedule === 'hourly' ? 'Minute past the hour' : 'Time'}</label>
                  {schedule === 'hourly'
                    ? <input id="bot-time" type="number" min={0} max={59} value={Number(time.slice(3))} onChange={(e) => setTime(`09:${String(Math.min(59, Math.max(0, Number(e.target.value) || 0))).padStart(2, '0')}`)} />
                    : <input id="bot-time" type="time" required value={time} onChange={(e) => setTime(e.target.value)} />}
                </div>
                {schedule === 'weekly' && <div><span className="bots-field-label">Day</span>
                  <Dropdown ariaLabel="Bot weekday" value={String(day)} onChange={(v) => setDay(Number(v))} options={WEEKDAYS.map((label, i) => ({ value: String(i), label }))} /></div>}
              </div>}
              {schedule !== 'manual' && <p className="bots-helper">Next run <strong>{next || 'choose a time'}</strong> ({timezone}){settings.enabled ? '' : '. Schedules are paused in Settings > Bots.'}</p>}
            </aside>
          </div>
        </div>
      </div>
      <footer className="bots-editor-footer">
        <div className="bots-editor-content">
          <p className="bots-note">Bots run unattended. Each run stops after {settings.maxRunMinutes >= 60 ? `${settings.maxRunMinutes / 60} hour${settings.maxRunMinutes === 60 ? '' : 's'}` : `${settings.maxRunMinutes} minutes`} (Settings &gt; Bots), and you can stop it any time.</p>
          <div className="bots-editor-actions">
            <button type="button" onClick={() => onDone(bot?.id ?? null)}>Cancel</button>
            <button type="submit" className="bots-primary" disabled={!agents.some((a) => a.command === agent)}>{bot ? 'Save changes' : 'Create bot'}</button>
          </div>
        </div>
      </footer>
    </form>
  );
}

// ── a bot: chat and details ─────────────────────────────────────────────────

/** The chat each bot was last showing, kept while the app runs so a visit to another page does not reset it. */
const pickedChats = new Map<string, number>();

function BotView({ bot, runs, homeRoot }: { bot: Bot; runs: BotRun[]; homeRoot: string }) {
  const hostName = useHostName();
  const [tab, setTab] = useState<'chat' | 'about'>('chat');
  const [editing, setEditing] = useState(false);
  const active = runs.find((r) => r.status === 'running');
  const next = nextBotRun(bot);
  const chatState = useStore(botChats)[bot.id];
  const chats = useMemo(() => splitChats(chatState, runs), [chatState, runs]);
  // Which chat is open is remembered per bot, so leaving the Bots page and coming back
  // shows the chat you were reading, not the newest one.
  const [picked, setPickedState] = useState<number | null>(() => pickedChats.get(bot.id) ?? null);
  const setPicked = (id: number | null) => {
    if (id === null) pickedChats.delete(bot.id); else pickedChats.set(bot.id, id);
    setPickedState(id);
  };
  const chat = chats.find((c) => c.id === picked) ?? chats.find((c) => c.current)!;
  function startChat() {
    // With "Archive the old chat" on in the bot's settings, the chat being left goes to the archive.
    const leaving = chats.find((c) => c.current);
    if (get(botAutoArchive)[bot.id] && leaving?.runs.length) setBotChatArchived(bot.id, leaving.id, true);
    setPicked(newBotChat(bot.id, runs));
    setTab('chat');
  }
  function archive(target: ChatThread, archived: boolean) {
    setBotChatArchived(bot.id, target.id, archived);
    if (archived && target.current) setPicked(newBotChat(bot.id, runs));
    else if (archived) setPicked(null);
  }
  /** Delete a whole chat thread; the open chat moves to the newest one. Throws with a message for the bar to show. */
  async function removeChat(target: ChatThread) {
    await deleteBotChat(bot, target);
    if (!target.current) setPicked(null);
  }
  if (editing) return <BotEditor bot={bot} runs={runs} onDone={() => setEditing(false)} />;
  return (
    <div className="bots-view">
      <header className="bots-view-header">
        <button type="button" className="bots-back" onClick={() => selectedBotId.set(null)} aria-label="All bots">←</button>
        <BotAvatar avatar={bot.avatar} size={40} />
        <div className="bots-view-title">
          <h3><span title={bot.name}>{bot.name}</span> <StatusChip bot={bot} run={runs[0]} /></h3>
          <p>{hostName(bot.boxId)}{bot.schedule !== 'manual' ? ` · ${botScheduleLabel(bot)}` : ''}{next ? ` · next ${when(next)}` : ''}{bot.createdBy ? ` · made by ${bot.createdBy}` : ''}</p>
        </div>
        <div className="bots-tabs" role="tablist" aria-label="Bot views">
          <button type="button" role="tab" aria-selected={tab === 'chat'} onClick={() => setTab('chat')}>Chat</button>
          <button type="button" role="tab" aria-selected={tab === 'about'} onClick={() => setTab('about')}>About</button>
        </div>
        <CloseButton />
      </header>
      {tab === 'chat'
        ? <BotChat key={chat.id} bot={bot} runs={chat.runs} active={active} chat={chat} chats={chats} onPick={setPicked} onNewChat={startChat} onArchive={archive} onDelete={removeChat} />
        : <BotAbout bot={bot} runs={runs} homeRoot={homeRoot} active={active} onEdit={() => setEditing(true)} />}
    </div>
  );
}

/**
 * A bot's chat, drawn with the structured chat's own pieces (UserTurn,
 * Markdown, Dots, the composer markup and TerminalChatView.css) so it looks
 * and reads exactly like a chat with an agent, and follows the same chat
 * appearance settings. No avatars beside the messages.
 */
function botChatReply(log: Awaited<ReturnType<typeof fetchBotLog>>): string {
  if (log.reply !== undefined) return log.reply;
  return log.text.includes('\x1b')
    ? stripTerminalOutput(log.text.replace(/\r\n/g, '\n'))
    : log.text;
}

function BotChat({ bot, runs, active, chat, chats, onPick, onNewChat, onArchive, onDelete }: {
  bot: Bot; runs: BotRun[]; active?: BotRun;
  chat: ChatThread; chats: ChatThread[];
  onPick: (id: number) => void; onNewChat: () => void; onArchive: (chat: ChatThread, archived: boolean) => void;
  onDelete: (chat: ChatThread) => Promise<void>;
}) {
  const [showArchived, setShowArchived] = useState(false);
  // Delete arms on the first click and deletes on a second within 3 seconds.
  const [deleteArmed, setDeleteArmed] = useState(false);
  const [deleting, setDeleting] = useState(false);
  useEffect(() => {
    if (!deleteArmed) return undefined;
    const timer = setTimeout(() => setDeleteArmed(false), 3000);
    return () => clearTimeout(timer);
  }, [deleteArmed]);
  const chatWorking = chat.runs.some((r) => r.status === 'running');
  // Only the newest chat takes messages; an older or archived one is for reading.
  const readOnly = !chat.current || chat.archived;
  const listed = chats.filter((c) => c.id === chat.id || showArchived === c.archived);
  const archivedCount = chats.filter((c) => c.archived).length;
  const appearance = useStore(botChatAppearance);
  const visualsOn = useStore(botChatVisuals);
  const showTimes = useStore(botChatTimestamps);
  const showStarters = useStore(botChatSuggestedPrompts);
  const [draft, setDraft] = useState('');
  const [busy, setBusy] = useState<'send' | 'stop' | null>(null);
  const [error, setError] = useState('');
  const [replies, setReplies] = useState<Record<string, string>>({});
  const [now, setNow] = useState(Date.now());
  const [pending, setPending] = useState<{ id: string; file: File; preview: string | null }[]>([]);
  const [dragging, setDragging] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);
  function addFiles(files: Iterable<File>) {
    const list = [...files].filter((f) => f.size > 0 || f.type);
    if (!list.length) return;
    setPending((cur) => {
      const room = Math.max(0, MAX_ATTACHMENTS - cur.length);
      if (list.length > room) setError(`Attach at most ${MAX_ATTACHMENTS} files to one message.`);
      return [...cur, ...list.slice(0, room).map((file) => ({ id: crypto.randomUUID(), file, preview: file.type.startsWith('image/') ? URL.createObjectURL(file) : null }))];
    });
  }
  function removePending(id: string) {
    setPending((cur) => { const gone = cur.find((p) => p.id === id); if (gone?.preview) URL.revokeObjectURL(gone.preview); return cur.filter((p) => p.id !== id); });
  }
  const scroller = useRef<HTMLDivElement>(null);
  const textarea = useRef<HTMLTextAreaElement>(null);
  const shown = useMemo(() => runs.slice(0, 30).reverse(), [runs]);
  const finishedKey = shown.map((r) => `${r.id}:${r.status}`).join('|');
  const noImages = () => {};

  // Fetch each run's reply, and again whenever its status changes: a reply
  // read while the run was still going may be empty or partial.
  // No "alive" guard: the list changing (a new message sent) must not throw
  // away a reply already on its way, which is then marked as fetched. This
  // chat is keyed per bot, so a late reply always belongs here.
  const fetchedAt = useRef<Record<string, BotRun['status']>>({});
  useEffect(() => {
    for (const run of shown) {
      if (!run.log || fetchedAt.current[run.id] === run.status) continue;
      fetchedAt.current[run.id] = run.status;
      void fetchBotLog(bot, run.id).then((log) => setReplies((r) => ({ ...r, [run.id]: botChatReply(log) })))
        .catch(() => { delete fetchedAt.current[run.id]; });
    }
  }, [finishedKey]);
  useEffect(() => {
    if (!active) return;
    const timer = window.setInterval(() => {
      setNow(Date.now());
      void fetchBotLog(bot, active.id).then((log) => setReplies((r) => ({ ...r, [active.id]: botChatReply(log) }))).catch(() => {});
    }, 1_000);
    return () => window.clearInterval(timer);
  }, [active?.id]);
  useEffect(() => { scroller.current?.scrollTo({ top: scroller.current.scrollHeight }); }, [shown.length, active ? replies[active.id]?.length : 0]);
  // Grow the composer with its text, like the structured chat.
  useEffect(() => {
    const el = textarea.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight, 220)}px`;
  }, [draft]);

  async function send(revision?: { text: string; paths: string[] }) {
    const text = revision?.text ?? draft.trim();
    if ((!text && !pending.length) || active || busy !== null || readOnly) return false;
    setBusy('send'); setError('');
    try {
      // Upload first: the bot is told where each file landed in its folder.
      const paths = revision?.paths ?? [];
      if (!revision) for (const p of pending) paths.push(await attachToBot(bot, p.file));
      await sendBotMessage(bot.id, text, paths, chat.id);
      if (!revision) {
        setDraft('');
        pending.forEach((p) => p.preview && URL.revokeObjectURL(p.preview));
        setPending([]);
      }
      await refreshBotState().catch((error) => setError(`Message sent. Could not refresh runs: ${String(error)}`));
    } catch (e) {
      if (revision) throw e;
      setError(e instanceof Error ? e.message : String(e));
    } finally { setBusy(null); }
  }
  // A visual's "send to this bot" button queues text for this bot (by id or name).
  const queued = useStore(botDraftQueue);
  useEffect(() => {
    const keys = [bot.id.toLowerCase(), bot.name.trim().toLowerCase()].filter((k) => queued[k]);
    if (!keys.length) return;
    const text = keys.map((k) => queued[k]).join('\n');
    botDraftQueue.update((q) => { const next = { ...q }; keys.forEach((k) => delete next[k]); return next; });
    setDraft((cur) => (cur.trim() ? `${cur.trim()}\n${text}` : text));
    requestAnimationFrame(() => textarea.current?.focus());
  }, [queued, bot.id, bot.name]);
  // A visual's "send to the bot" button fills the message box for review.
  function composeFromVisual(text: string) {
    setDraft((cur) => (cur.trim() ? `${cur.trim()}\n${text}` : text));
    requestAnimationFrame(() => textarea.current?.focus());
  }
  async function stop() {
    if (!active) return;
    setBusy('stop'); setError('');
    try { await stopBotRun(bot, active.id); await refreshBotState(); } catch (e) { setError(e instanceof Error ? e.message : String(e)); } finally { setBusy(null); }
  }
  const suggestions = botStarterPrompts(bot);
  const agentName = getAgentRoster().find((agent) => agent.command === bot.agent)?.name ?? agentProgram(bot.agent);
  return (
    <div
      className={`terminal-chat-view structured-chat-view bots-structured-chat${dragging ? ' bots-dropping' : ''}`}
      onDragOver={(e) => { if (e.dataTransfer.types.includes('Files')) { e.preventDefault(); setDragging(true); } }}
      onDragLeave={(e) => { if (e.currentTarget === e.target) setDragging(false); }}
      onDrop={(e) => { if (!e.dataTransfer.files.length) return; e.preventDefault(); setDragging(false); addFiles(e.dataTransfer.files); }}
      data-chat-font={appearance.font === 'app' ? undefined : appearance.font === 'system' || appearance.font === 'terminal' ? appearance.font : 'custom'}
      data-chat-font-size={appearance.fontSize == null ? undefined : 'set'}
      onPointerMove={markPointerMessage}
      onPointerLeave={clearPointerMessage}
      data-timestamps={showTimes ? '' : undefined}
      data-contrast={appearance.contrast !== 100 ? '' : undefined}
      style={{
        '--tc-col': CHAT_WIDTH_COLUMN[appearance.width],
        '--tc-code-size': `${appearance.codeFontSize}px`,
        '--tc-font-family': `"${appearance.font}", system-ui, sans-serif`,
        ...contrastVars(appearance.contrast, false),
        ...(appearance.fontSize == null ? {} : { '--tc-font-size': `${appearance.fontSize}px` }),
      } as React.CSSProperties}
    >
      <div className="bots-chat-bar">
        <Dropdown
          ariaLabel="Chats with this bot"
          value={String(chat.id)}
          onChange={(v) => onPick(Number(v))}
          options={listed.map((c) => ({ value: String(c.id), label: c.title, sublabel: c.runs[0] ? `${c.archived ? 'Archived · ' : ''}${when(c.runs[0].startedAt)}` : undefined }))}
        />
        {archivedCount > 0 && <button type="button" className="bots-chat-bar-btn" aria-pressed={showArchived} onClick={() => setShowArchived((v) => !v)}>
          {showArchived ? 'Hide archived' : `Archived (${archivedCount})`}
        </button>}
        <span className="bots-chat-bar-spacer" />
        <button type="button" className="bots-chat-bar-btn" disabled={chat.archived ? false : !chat.runs.length && chat.current} onClick={() => onArchive(chat, !chat.archived)}>
          {chat.archived ? 'Unarchive' : 'Archive'}
        </button>
        <button
          type="button"
          className={`bots-chat-bar-btn danger${deleteArmed ? ' armed' : ''}`}
          disabled={deleting || chatWorking || (!chat.runs.length && chat.current)}
          title={chatWorking ? 'Stop the run first' : deleteArmed ? 'Click again to delete this chat for good' : 'Delete this chat and everything in it'}
          onClick={async () => {
            if (!deleteArmed) { setDeleteArmed(true); return; }
            setDeleteArmed(false); setDeleting(true); setError('');
            try { await onDelete(chat); } catch (e) { setError(e instanceof Error ? e.message : String(e)); } finally { setDeleting(false); }
          }}
        >
          {deleting ? 'Deleting…' : deleteArmed ? 'Delete chat?' : 'Delete'}
        </button>
        <button type="button" className="bots-chat-bar-btn primary" disabled={Boolean(active)} title="Start a new conversation with this bot" onClick={onNewChat}>New chat</button>
      </div>
      <div className="terminal-chat-transcript">
        <div className="terminal-chat-scroll" ref={scroller}>
          <div className="terminal-chat-thread">
            {!shown.length && <div className="bots-chat-empty">
              <BotAvatar avatar={bot.avatar} size={64} />
              <h3>{bot.name}</h3>
              <p>{bot.canCreateBots
                ? 'Describe a recurring task, a schedule, or a workflow you want a bot to handle.'
                : 'Ask this bot what it can do, or give it a task to start.'}</p>
              {showStarters && <div className="bots-chat-suggestions" role="group" aria-label="Starter prompts">
                {suggestions.map((prompt) => (
                  <button key={prompt} type="button" disabled={Boolean(active) || busy !== null} onClick={() => { setDraft(prompt); textarea.current?.focus(); }}>
                    <span>{prompt}</span>
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M5 12h14m-6-6 6 6-6 6" /></svg>
                  </button>
                ))}
              </div>}
            </div>}
            {shown.map((run) => {
              const reply = replies[run.id]?.trim();
              const segments = reply ? splitReply(reply) : [];
              const replyText = visualReplyText(segments);
              const replyTime = showTimes ? run.finishedAt ?? run.startedAt : null;
              return <div key={run.id} className="bots-exchange">
                {run.message
                  ? <div className="tcr-msg user">
                    <SentTurn bot={bot} run={run} />
                    {run.message !== FILES_ONLY_MESSAGE && <MessageActions
                      align="end"
                      text={run.message}
                      time={showTimes ? run.startedAt : null}
                      canResend={!active && busy === null}
                      onResend={(text) => send({ text, paths: run.attachments ?? [] })}
                    />}
                  </div>
                  : <div className="terminal-chat-notice">{run.trigger === 'schedule' ? 'Scheduled run' : 'Run started'} · {clock(run.startedAt)}</div>}
                {reply && <div className="tcr-msg">
                  <div className="terminal-chat-agent">
                    {segments.map((segment, i) => segment.type === 'text'
                      ? <Markdown key={`t${i}`} text={segment.text} onOpenImage={noImages} />
                      : visualsOn && <BotVisual key={`v${i}-${segment.visual.file}`} bot={bot} visual={segment.visual} status={run.status} onCompose={composeFromVisual} />)}
                  </div>
                  {replyText
                    ? <MessageActions text={replyText} time={replyTime} replyId={`bot:${bot.id}:${run.id}`} />
                    : replyTime !== null && <div className="bots-reply-time">{clock(replyTime)}</div>}
                </div>}
                {run.status === 'running' && <div className="terminal-chat-working"><Dots /><span>{bot.name} is working · {Math.max(0, Math.round((now - run.startedAt) / 1000))}s</span></div>}
                {run.status === 'missed' && <div className="terminal-chat-notice">Missed its scheduled time.</div>}
                {run.status === 'completed' && !reply && replies[run.id] !== undefined && <div className="terminal-chat-notice">No reply.</div>}
                {(run.status === 'failed' || run.status === 'stopped' || run.status === 'interrupted') && (
                  <div className={run.status === 'failed' ? 'terminal-chat-error' : 'terminal-chat-notice'} role={run.status === 'failed' ? 'alert' : undefined}>
                    <span>{STATUS_LABEL[run.status]}{run.detail ? `: ${run.detail}` : ''}</span>
                  </div>
                )}
              </div>;
            })}
          </div>
        </div>
      </div>
      <div className="terminal-chat-dock">
        {error && <div className="terminal-chat-error" role="alert"><span>{error}</span></div>}
        <div className="terminal-chat-composer">
          {pending.length > 0 && (
            <div className="terminal-chat-attachments">
              {pending.map((p, index) => (
                <div key={p.id} className="terminal-chat-attachment" title={p.file.name}>
                  <span className="terminal-chat-attachment-thumb">
                    {p.preview ? <img src={p.preview} alt="" /> : <span className="terminal-chat-attachment-icon">{(p.file.name.split('.').pop() || 'FILE').slice(0, 4).toUpperCase()}</span>}
                  </span>
                  <button type="button" className="terminal-chat-attachment-remove" aria-label={`Remove ${p.file.name}`} disabled={busy === 'send'} onClick={() => removePending(p.id)}>
                    <svg width="8" height="8" viewBox="0 0 8 8" aria-hidden="true"><path d="M1 1l6 6M7 1 1 7" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" /></svg>
                  </button>
                  {index === 0 && pending.length > 1 && <span className="terminal-chat-attachment-count">{pending.length}</span>}
                </div>
              ))}
            </div>
          )}
          <textarea
            ref={textarea}
            onPaste={(e) => { const files = [...e.clipboardData.files]; if (files.length) { e.preventDefault(); addFiles(files); } }}
            rows={1}
            value={draft}
            placeholder={readOnly ? (chat.archived ? 'This chat is archived. Unarchive it to read along, or start a new chat.' : 'This chat has ended. Start a new chat to message this bot.') : active ? `${bot.name} is working… (Stop to send something new)` : `Message ${bot.name}`}
            disabled={Boolean(active) || readOnly}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) { e.preventDefault(); void send(); }
              if (e.key === 'Escape' && active) { e.preventDefault(); void stop(); }
            }}
          />
          <div className="terminal-chat-composer-bar">
            <button type="button" className="terminal-chat-icon-btn" title="Attach files (or paste or drop them here)" aria-label="Attach files" disabled={Boolean(active) || busy !== null} onClick={() => fileInput.current?.click()}>
              <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="m21.4 11.1-9.2 9.2a6 6 0 0 1-8.5-8.5l9.2-9.2a4 4 0 0 1 5.7 5.7l-9.2 9.2a2 2 0 0 1-2.8-2.8l8.5-8.5" /></svg>
            </button>
            <input ref={fileInput} type="file" multiple hidden onChange={(e) => { if (e.target.files) addFiles(e.target.files); e.target.value = ''; }} />
            <span className="terminal-chat-pill bots-chat-agent" title={bot.model ? `${agentName} · ${bot.model}` : agentName}>
              <AgentBrandMark command={bot.agent} name={agentName} className="bots-agent-mark" />
              <span className="terminal-chat-pill-label">{agentName}{bot.model ? ` · ${bot.model}` : ''}</span>
            </span>
            {(() => {
              const tools = [bot.computerUse && 'Computer use', bot.browser && 'Browser', ...botConnectorNames(bot)].filter(Boolean) as string[];
              return tools.length > 0 && <span className="terminal-chat-pill" title={tools.join(', ')}><span className="terminal-chat-pill-label">{tools.length} tool{tools.length === 1 ? '' : 's'}</span></span>;
            })()}
            <span className="terminal-chat-bar-spacer" />
            {active ? (
              <button type="button" className="terminal-chat-send stop" title="Stop (Esc)" aria-label="Stop" disabled={busy !== null} onClick={() => void stop()}>
                <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true"><rect width="10" height="10" rx="2.2" fill="currentColor" /></svg>
              </button>
            ) : (
              <button type="button" className="terminal-chat-send bots-composer-send" title="Send (Enter)" disabled={readOnly || busy !== null || (!draft.trim() && !pending.length)} onClick={() => void send()}>
                <span>{busy === 'send' && pending.length ? 'Uploading…' : busy === 'send' ? 'Sending…' : 'Send'}</span>
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M12 19V5M5 12l7-7 7 7" /></svg>
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

/** A message you sent, with its attachments: images as thumbnails, other files as chips. */
/**
 * One interactive visual from a bot's reply. The page lives in the bot's home
 * (here or on a box), so it is fetched first; until then, or if it never
 * arrives, the card says so rather than showing a broken frame. A page that was
 * not there yet is tried again when the run's status changes.
 */
function BotVisual({ bot, visual, status, onCompose }: {
  bot: Bot;
  visual: { file: string; title: string | null };
  status: BotRun['status'];
  onCompose: (text: string) => void;
}) {
  const [state, setState] = useState<{ spot: ChatVisualsSpot } | { error: string } | null>(null);
  useEffect(() => {
    let alive = true;
    void botVisualSpot(bot, visual.file)
      .then((spot) => { if (alive) setState({ spot }); })
      .catch((e) => { if (alive) setState({ error: e instanceof Error ? e.message : String(e) }); });
    return () => { alive = false; };
  }, [bot.id, bot.boxId, visual.file, status]);
  if (state && 'spot' in state) return <ChatVisual visual={visual} spot={state.spot} onCompose={onCompose} botMode />;
  return <ChatVisualStatus title={visual.title ?? visual.file}
    text={state ? (status === 'running' ? 'Waiting for the bot to finish this visual…' : `Could not load this visual. ${state.error}`) : 'Loading visual…'} />;
}

function SentTurn({ bot, run }: { bot: Bot; run: BotRun }) {
  const files = run.attachments ?? [];
  const [images, setImages] = useState<string[]>([]);
  const key = files.join('|');
  useEffect(() => {
    let alive = true;
    void Promise.all(files.map((f) => attachmentPreview(bot, f))).then((urls) => { if (alive) setImages(urls.filter((u): u is string => Boolean(u))); });
    return () => { alive = false; };
  }, [key]);
  const others = files.filter((f) => !/\.(png|jpe?g|gif|webp)$/i.test(f));
  const text = run.message === FILES_ONLY_MESSAGE ? '' : run.message ?? '';
  return <>
    <UserTurn text={text} images={images} onOpenImage={() => {}} />
    {others.length > 0 && <div className="bots-sent-files">{others.map((f) => <span key={f} className="terminal-chat-pill" title={f}><span className="terminal-chat-pill-label">{f.replace(/^attachments\/[0-9a-f]{8}-/, '')}</span></span>)}</div>}
  </>;
}

function BotAbout({ bot, runs, homeRoot, active, onEdit }: { bot: Bot; runs: BotRun[]; homeRoot: string; active?: BotRun; onEdit: () => void }) {
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [openLog, setOpenLog] = useState<{ id: string; text: string } | null>(null);
  const access = ACCESS_OPTIONS.find((o) => o.value === bot.access);
  const connectors = botConnectorNames(bot);
  const agentName = getAgentRoster().find((agent) => agent.command === bot.agent)?.name ?? agentProgram(bot.agent);
  async function runNow() {
    setBusy(true); setError('');
    try { await runBotNow(bot.id); await refreshBotState(); } catch (e) { setError(e instanceof Error ? e.message : String(e)); } finally { setBusy(false); }
  }
  async function toggleLog(run: BotRun) {
    if (openLog?.id === run.id) { setOpenLog(null); return; }
    try { const log = await fetchBotLog(bot, run.id); setOpenLog({ id: run.id, text: log.text || '(Nothing printed.)' }); } catch (e) { setOpenLog({ id: run.id, text: `Could not read the output: ${String(e)}` }); }
  }
  return (
    <div className="bots-body">
      <div className="bots-detail">
        {error && <p role="alert" className="bots-error">{error}</p>}
        <div className="bots-actions">
          {active
            ? <button type="button" className="bots-stop" onClick={() => void stopBotRun(bot, active.id).then(() => refreshBotState())}>Stop</button>
            : <button type="button" className="bots-primary" disabled={busy} onClick={() => void runNow()}>{busy ? 'Starting…' : 'Run now'}</button>}
          {bot.schedule !== 'manual' && <button type="button" onClick={() => toggleBot(bot.id)}>{bot.enabled ? 'Pause schedule' : 'Turn on schedule'}</button>}
          <button type="button" onClick={onEdit}>Edit</button>
          {confirmDelete ? <>
            <span className="bots-confirm">Delete this bot? Its folder is kept.</span>
            <button type="button" className="bots-danger" disabled={Boolean(active)} onClick={() => removeBot(bot.id)}>Delete</button>
            <button type="button" onClick={() => setConfirmDelete(false)}>Keep</button>
          </> : <button type="button" className="bots-subtle" disabled={Boolean(active)} title={active ? 'Stop the run first' : undefined} onClick={() => setConfirmDelete(true)}>Delete</button>}
        </div>
        {bot.createdBy && bot.schedule !== 'manual' && !bot.enabled && <p className="bots-note">{bot.createdBy} created this bot. Its schedule is off until you turn it on.</p>}
        <div className="bots-about-grid">
          <section className="bots-section">
            <h4>Job</h4>
            <p className="bots-job">{bot.instructions}</p>
            {homeRoot && <dl className="bots-home-folder">
              <dt>Home folder</dt>
              <dd><code>{`${homeRoot}/${bot.id}`}</code></dd>
            </dl>}
          </section>
          <section className="bots-section">
            <h4>Agent and tools</h4>
            <dl className="bots-facts">
              <div><dt>Agent</dt><dd className="bots-about-agent"><AgentBrandMark command={bot.agent} name={agentName} className="bots-agent-mark" /><span>{agentName}{bot.model ? ` · ${bot.model}` : ''}</span></dd></div>
              <div><dt>Permissions</dt><dd>{access?.label}</dd></div>
              <div><dt>Connectors</dt><dd>{connectors.length ? connectors.join(', ') : 'None'}</dd></div>
              <div><dt>Browser</dt><dd>{bot.browser ? 'Enabled' : 'Off'}</dd></div>
              <div><dt>Computer use</dt><dd>{bot.computerUse ? (bot.boxId === LOCAL_HOST ? 'This PC’s screen' : 'Box desktop') : 'Off'}</dd></div>
              {bot.canCreateBots && <div><dt>Can create bots</dt><dd>Enabled</dd></div>}
            </dl>
          </section>
        </div>
        <section className="bots-section bots-run-history">
          <h4>Run history</h4>
          {!runs.length ? <p className="bots-no-runs">No runs yet. Runs will appear here once the bot starts.</p> : runs.map((run) => (
            <article key={run.id} className="bots-run">
              <span className={`bots-dot ${run.status}`} aria-hidden="true" />
              <div className="bots-run-info">
                <strong>{STATUS_LABEL[run.status]}</strong>
                <p>{when(run.startedAt)} · {run.trigger === 'schedule' ? 'scheduled' : run.trigger === 'chat' ? 'chat' : 'manual'}{duration(run) ? ` · ${duration(run)}` : ''}</p>
                {run.message && <small>“{run.message.length > 120 ? `${run.message.slice(0, 120)}…` : run.message}”</small>}
                {run.detail && <small>{run.detail}</small>}
                {openLog?.id === run.id && <pre className="bots-log">{openLog.text}</pre>}
              </div>
              {run.log && <div className="bots-run-actions"><button type="button" aria-expanded={openLog?.id === run.id} onClick={() => void toggleLog(run)}>{openLog?.id === run.id ? 'Hide output' : 'View output'}</button></div>}
            </article>
          ))}
        </section>
      </div>
    </div>
  );
}
