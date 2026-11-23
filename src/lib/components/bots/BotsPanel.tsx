import { useEffect, useMemo, useRef, useState } from 'react';
import { useStore } from '$lib/react/useStore';
import { activeConnection, activeRemoteId, connectRemote, connectionStatus, remoteConnections, remoteTarget } from '$lib/stores/remoteWorkspace';
import { customAgents, removedPresetAgents } from '$lib/stores/customAgents';
import { usageState } from '$lib/stores/usage';
import { getAgentRoster } from '$lib/stores/runs';
import { computerUse as computerUseSetting, mcpServers } from '$lib/stores/settings';
import { computerUseSupported } from '$lib/stores/computerUse';
import { showToast } from '$lib/stores/notification';
import { AgentBrandMark } from '$lib/components/shared/useAgentBrand';
import Dropdown from '$lib/components/shared/Dropdown';
import { ACCESS_OPTIONS } from '$lib/components/shared/BotSettingsSection';
import { catalogIconFor } from '$lib/services/mcp-catalog';
import { boxMcpInfo, sharedSignIns } from '$lib/services/box-signins';
import {
  BOT_TEMPLATES, LOCAL_HOST, agentProgram, botAgents, botConnectorNames, botHostState, botSettings, bots, canRunHeadless, closeBots,
  connectorChoices, fetchBotLog, latestRun, localAvailable, nextBotRun, refreshBotState, removeBot, runBotNow, runsFor,
  attachToBot, attachmentPreview, FILES_ONLY_MESSAGE, MAX_ATTACHMENTS,
  saveBot, selectedBotId, sendBotMessage, stopBotRun, toggleBot, visibleBots,
  type Bot, type BotAccess, type BotRun, type BotSchedule, type BotTemplate,
} from '$lib/services/bots/bots';
import { BOT_AVATARS, DEFAULT_AVATAR, avatarUrl, resizeAvatar } from '$lib/services/bots/avatars';
import { Dots, Markdown, UserTurn, contrastVars } from '$lib/components/terminal/TerminalChatView';
import { CHAT_WIDTH_COLUMN, chatAppearance } from '$lib/stores/chatViewSettings';
import '$lib/components/terminal/TerminalChatRich.css';
import '$lib/components/terminal/TerminalChatView.css';
import './Bots.css';

/** `selectedBotId` value that opens the editor for a new bot. */
export const NEW_BOT = '__new__';

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
  return <img className={`bot-avatar ${className}`} src={avatarUrl(avatar)} alt="" width={size} height={size} draggable={false}
    onError={(e) => { const img = e.currentTarget; if (!img.src.endsWith(`/${DEFAULT_AVATAR}.webp`)) img.src = avatarUrl(DEFAULT_AVATAR); }} />;
}

export function botScheduleLabel(b: Pick<Bot, 'schedule' | 'time' | 'day'>): string {
  if (b.schedule === 'manual') return 'On demand';
  if (b.schedule === 'hourly') return `Every hour at :${b.time.slice(3)}`;
  const when = b.schedule === 'weekly' ? WEEKDAYS[b.day] : b.schedule === 'weekdays' ? 'Mon to Fri' : 'Every day';
  return `${when} at ${b.time}`;
}

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
      if (e.key !== 'Escape' || e.defaultPrevented) return;
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
          <p>Agents with a standing job, outside every project. Chat with them, or let them work on a schedule. {remote ? 'Bots on your box keep working while this laptop is closed.' : 'They run on this PC while Spacron is open, or on a box once you connect one.'}</p>
        </div>
        {selected !== NEW_BOT && <button type="button" className="bots-primary" onClick={() => selectedBotId.set(NEW_BOT)}>+ New bot</button>}
        <CloseButton />
      </header>
      {stateError && <p role="alert" className="bots-error">Could not load runs: {stateError}</p>}
      <div className="bots-body">
        {selected === NEW_BOT ? <BotEditor onDone={(id) => selectedBotId.set(id)} /> : <BotList bots={mine} />}
      </div>
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
  if (!list.length) return (
    <div className="bots-empty">
      <BotAvatar avatar="robot" size={72} className="bots-empty-avatar" />
      <h3>Put an agent on the night shift</h3>
      <p>Give a bot a job, chat with it, or put it on a schedule. It keeps its own folder between runs, so it remembers what it did. It runs with the agent CLIs you already have installed.</p>
      <button type="button" className="bots-primary" onClick={() => selectedBotId.set(NEW_BOT)}>+ Create your first bot</button>
      <TemplateGrid />
    </div>
  );
  const groups = [...new Set(list.map((b) => b.boxId))].sort((a, b) => (a === LOCAL_HOST ? -1 : b === LOCAL_HOST ? 1 : 0));
  return <>{groups.map((host) => (
    <section key={host} className="bots-group">
      <h4>{hostName(host)}</h4>
      <div className="bots-grid">
        {list.filter((b) => b.boxId === host).sort((a, b) => a.name.localeCompare(b.name)).map((b) => {
          const run = latestRun(state, b);
          const next = nextBotRun(b);
          return (
            <button key={b.id} type="button" className="bots-card" onClick={() => selectedBotId.set(b.id)}>
              <div className="bots-card-top">
                <BotAvatar avatar={b.avatar} size={40} />
                <div className="bots-card-title">
                  <strong>{b.name}</strong>
                  <small>{botScheduleLabel(b)}{next ? ` · next ${when(next)}` : ''}</small>
                </div>
                <StatusChip bot={b} run={run} />
              </div>
              <p>{b.instructions}</p>
              <small>{[b.canCreateBots && 'Creates bots', b.computerUse && 'Computer use', b.browser && 'Browser', ...botConnectorNames(b)].filter(Boolean).join(' · ') || ' '}</small>
            </button>
          );
        })}
      </div>
    </section>
  ))}
  <TemplateGrid title="Add another from a template" /></>;
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
      {title && <span>{title}</span>}
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
      {open && <div className="bots-avatar-grid" role="listbox" aria-label="Bot pictures">
        {BOT_AVATARS.map((a) => <button key={a.id} type="button" role="option" aria-selected={value === a.id} title={a.label} onClick={() => { onChange(a.id); setOpen(false); }}>
          <BotAvatar avatar={a.id} size={44} />
        </button>)}
        <button type="button" className="bots-avatar-upload" onClick={() => fileRef.current?.click()} title="Upload your own picture">
          <span>＋</span><small>Upload</small>
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
        const icon = catalogIconFor(c.catalogId ?? c.name);
        return <label key={c.key} className={`bots-connector${on ? ' on' : ''}${c.usable ? '' : ' disabled'}`} title={c.reason}>
          <input type="checkbox" checked={on && c.usable} disabled={!c.usable} onChange={(e) => onChange(e.target.checked ? [...value, c.key] : value.filter((k) => k !== c.key))} />
          {icon ? <img src={icon} alt="" width={16} height={16} /> : <span className="bots-connector-letter">{c.name.slice(0, 1).toUpperCase()}</span>}
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

function BotEditor({ bot, onDone }: { bot?: Bot; onDone: (id: string | null) => void }) {
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
  const [avatar, setAvatar] = useState(start?.avatar ?? DEFAULT_AVATAR);
  const [agent, setAgent] = useState(bot?.agent ?? agents[0]?.command ?? '');
  const [model, setModel] = useState(bot?.model ?? '');
  const [schedule, setSchedule] = useState<BotSchedule>(start?.schedule ?? 'manual');
  const [time, setTime] = useState(start?.time ?? '09:00');
  const [day, setDay] = useState(start?.day ?? 1);
  const [access, setAccess] = useState<BotAccess>(start?.access ?? settings.defaultAccess);
  const [keys, setKeys] = useState<string[]>(() => bot ? (bot.mcpKeys ?? (bot.connectors ? connectorChoices(bot.boxId).filter((c) => c.usable).map((c) => c.key) : [])) : templateKeys(template, host));
  const [browser, setBrowser] = useState(bot?.browser ?? template?.browser ?? false);
  const [builder, setBuilder] = useState(bot?.canCreateBots ?? template?.canCreateBots ?? false);
  const [computer, setComputer] = useState(bot?.computerUse ?? template?.computerUse ?? false);
  const pcComputer = useComputerUseOnThisPc();
  const boxInfo = useStore(boxMcpInfo);
  const boxOs = host === LOCAL_HOST ? null : boxInfo?.os ?? 'linux';
  const [error, setError] = useState('');
  const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  const program = agentProgram(agent);
  const usesAgentPermissions = program && !['claude', 'codex', 'gemini'].includes(program);
  const interactiveAgents = getAgentRoster().filter((entry) => !canRunHeadless(entry.command));
  let next = '';
  try { next = when(nextBotRun({ schedule, time, day, enabled: true })); } catch { /* incomplete time input */ }
  const missing = template?.connectors?.filter((id) => !connectorChoices(host).some((c) => c.usable && c.catalogId === id)) ?? [];
  function applyTemplate(t: BotTemplate) {
    setTemplate(t); setName(t.name); setInstructions(t.instructions); setSchedule(t.schedule); setTime(t.time); setDay(t.day);
    setAccess(t.access); setAvatar(t.avatar); setBrowser(t.browser ?? false); setBuilder(t.canCreateBots ?? false); setComputer(t.computerUse ?? false); setKeys(templateKeys(t, host));
  }
  function submit() {
    setError('');
    try {
      const saved = saveBot({
        id: bot?.id, boxId: host, name, instructions, agent, model: model.trim() || null, schedule, time, day, access,
        connectors: keys.length > 0, mcpKeys: keys, browser, canCreateBots: builder, computerUse: computer, avatar, enabled: bot?.enabled ?? true,
        ...(bot?.createdBy ? { createdBy: bot.createdBy } : {}),
      });
      showToast(bot ? `Saved "${saved.name}".` : `"${saved.name}" is ready. Say hi to it.`, 'success');
      onDone(saved.id);
    } catch (e) { setError(e instanceof Error ? e.message : String(e)); }
  }
  return (
    <form className="bots-editor" onSubmit={(e) => { e.preventDefault(); submit(); }}>
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
          <textarea id="bot-job" required rows={8} maxLength={20_000} placeholder="What is this bot for? Say what result you want, and where to save it." value={instructions} onChange={(e) => setInstructions(e.target.value)} />
          <p className="bots-helper">Each run starts a fresh agent with access to the bot’s saved files and recent chat.</p>
          <h4 className="bots-editor-section">Tools and connectors</h4>
          <span className="bots-field-label">Connectors</span>
          <ConnectorPicker host={host} value={keys} onChange={setKeys} />
          {missing.length > 0 && <p className="bots-helper bots-warn">This template works best with {missing.join(', ')}. Add it in Settings &gt; MCP &amp; plugins{host === LOCAL_HOST ? '' : ', then share the sign-in with this box in Settings > Bots'}.</p>}
          {keys.length > 0 && program !== 'claude' && <p className="bots-helper">Connectors reach Claude Code bots for now; other agents use their own MCP config.</p>}
          <label className="bots-check">
            <input type="checkbox" checked={browser} onChange={(e) => setBrowser(e.target.checked)} />
            <span>Use a web browser</span>
          </label>
          <p className="bots-helper">{host === LOCAL_HOST
            ? 'Opens and uses real pages (sign-ups, forms, sites without an API) in a hidden browser on this PC. Web search works without it.'
            : `Opens and uses real pages in a hidden browser on the box. The box needs Node, and a browser installed once with "${boxOs === 'linux' ? 'npx playwright install --with-deps chromium' : 'npx playwright install chromium'}".`}</p>
          <label className="bots-check">
            <input type="checkbox" checked={computer} onChange={(e) => setComputer(e.target.checked)} />
            <span>Use the computer</span>
          </label>
          <p className={`bots-helper${computer && host === LOCAL_HOST && pcComputer !== 'ready' ? ' bots-warn' : ''}`}>{host === LOCAL_HOST
            ? pcComputer === 'unsupported'
              ? 'Sees and operates apps on this PC\'s screen, but this session does not allow it. On Linux, sign in with an X11 (Xorg) session instead of Wayland.'
              : pcComputer === 'off'
                ? 'Sees and operates apps on this PC\'s screen. Turn on Settings > Computer use first. Spacron asks you to allow each window it may control, so you need to be there.'
                : 'Sees and operates apps on this PC\'s screen. Spacron asks you to allow each window it may control, so you need to be there when it runs.'
            : boxOs === 'macos'
              ? `Operates this Mac box's own screen: screenshots, clicks, typing. ${access === 'full' ? 'It can start programs.' : 'It can start programs only with Full access.'} Allow spacron-server under Screen Recording and Accessibility in System Settings once, and keep a user logged in.`
              : boxOs === 'windows'
                ? `Operates this Windows box's own desktop: screenshots, clicks, typing. ${access === 'full' ? 'It can start programs.' : 'It can start programs only with Full access.'} spacron-server must run in a logged-in desktop session (started at sign-in), not as a service.`
                : `Gets its own virtual desktop on the box to open and operate apps, with no one watching. ${access === 'full' ? 'It can start programs there.' : 'It can start programs there only with Full access.'} The box needs this once: "sudo apt-get install -y xvfb xdotool imagemagick".`}</p>
          <label className="bots-check">
            <input type="checkbox" checked={builder} onChange={(e) => setBuilder(e.target.checked)} />
            <span>Can create other bots</span>
          </label>
          <p className="bots-helper">Bots it creates get no more access than it has, can't create bots themselves, and start with their schedule off until you turn it on.</p>
        </div>
        <aside className="bots-editor-side">
          <h4>Run settings</h4>
          <span className="bots-field-label">Runs on</span>
          <Dropdown ariaLabel="Where the bot runs" value={host} onChange={(v) => { setHost(v); setKeys(templateKeys(template, v)); }} disabled={Boolean(bot)} options={hosts.length ? hosts : [{ value: host, label: host === LOCAL_HOST ? 'This PC' : 'Box (not connected)' }]} />
          <p className="bots-helper">{host === LOCAL_HOST ? 'Runs while Spacron is open on this PC.' : 'Runs on the box, even while this laptop is closed.'}</p>
          <span className="bots-field-label">Run with</span>
          <Dropdown ariaLabel="Bot agent" value={agent} onChange={setAgent} placeholder="Choose an agent"
            options={[...agents.map((a) => ({ value: a.command, label: a.name, icon: <AgentBrandMark command={a.command} name={a.name} className="bots-agent-mark" /> })),
              ...interactiveAgents.map((a) => ({ value: a.command, label: `${a.name} (unavailable for bots)`, disabled: true })),
              ...(agent && !agents.some((a) => a.command === agent) && !interactiveAgents.some((a) => a.command === agent)
                ? [{ value: agent, label: `${agent} (not installed here)`, disabled: true }] : [])]} />
          {agents.length ? <p className="bots-helper">Uses the agent CLI installed where the bot runs.</p>
            : <p className="bots-error">Install an agent that supports unattended bot runs.</p>}
          {program === 'dsh' ? <p className="bots-helper">DeepSeek Harness uses the model configured in its headless profile.</p> : <>
            <label htmlFor="bot-model">Model <small>(optional)</small></label>
            <input id="bot-model" placeholder="Agent default" value={model} onChange={(e) => setModel(e.target.value)} />
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
      <p className="bots-note">Bots work unattended and can't stop to ask permission, so what they may do is decided here. A run stops after {settings.maxRunMinutes >= 60 ? `${settings.maxRunMinutes / 60} hour${settings.maxRunMinutes === 60 ? '' : 's'}` : `${settings.maxRunMinutes} minutes`} (Settings &gt; Bots), and you can stop it any time.</p>
      <footer className="bots-editor-footer">
        <button type="button" onClick={() => onDone(bot?.id ?? null)}>Cancel</button>
        <button type="submit" className="bots-primary" disabled={!agents.some((a) => a.command === agent)}>{bot ? 'Save changes' : 'Create bot'}</button>
      </footer>
    </form>
  );
}

// ── a bot: chat and details ─────────────────────────────────────────────────

function BotView({ bot, runs, homeRoot }: { bot: Bot; runs: BotRun[]; homeRoot: string }) {
  const hostName = useHostName();
  const [tab, setTab] = useState<'chat' | 'about'>('chat');
  const [editing, setEditing] = useState(false);
  const active = runs.find((r) => r.status === 'running');
  const next = nextBotRun(bot);
  if (editing) return <div className="bots-body"><BotEditor bot={bot} onDone={() => setEditing(false)} /></div>;
  return (
    <div className="bots-view">
      <header className="bots-view-header">
        <button type="button" className="bots-back" onClick={() => selectedBotId.set(null)} aria-label="All bots">←</button>
        <BotAvatar avatar={bot.avatar} size={40} />
        <div className="bots-view-title">
          <h3>{bot.name} <StatusChip bot={bot} run={runs[0]} /></h3>
          <p>{hostName(bot.boxId)} · {botScheduleLabel(bot)}{next ? ` · next ${when(next)}` : ''}{bot.createdBy ? ` · made by ${bot.createdBy}` : ''}</p>
        </div>
        <div className="bots-tabs" role="tablist" aria-label="Bot views">
          <button type="button" role="tab" aria-selected={tab === 'chat'} onClick={() => setTab('chat')}>Chat</button>
          <button type="button" role="tab" aria-selected={tab === 'about'} onClick={() => setTab('about')}>About</button>
        </div>
        <CloseButton />
      </header>
      {tab === 'chat'
        ? <BotChat bot={bot} runs={runs} active={active} />
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
function BotChat({ bot, runs, active }: { bot: Bot; runs: BotRun[]; active?: BotRun }) {
  const appearance = useStore(chatAppearance);
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
      void fetchBotLog(bot, run.id).then((log) => setReplies((r) => ({ ...r, [run.id]: log.text })))
        .catch(() => { delete fetchedAt.current[run.id]; });
    }
  }, [finishedKey]);
  useEffect(() => {
    if (!active) return;
    const timer = window.setInterval(() => {
      setNow(Date.now());
      void fetchBotLog(bot, active.id).then((log) => setReplies((r) => ({ ...r, [active.id]: log.text }))).catch(() => {});
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

  async function send() {
    const text = draft.trim();
    if ((!text && !pending.length) || active) return;
    setBusy('send'); setError('');
    try {
      // Upload first: the bot is told where each file landed in its folder.
      const paths: string[] = [];
      for (const p of pending) paths.push(await attachToBot(bot, p.file));
      await sendBotMessage(bot.id, text, paths);
      setDraft('');
      pending.forEach((p) => p.preview && URL.revokeObjectURL(p.preview));
      setPending([]);
      await refreshBotState();
    } catch (e) { setError(e instanceof Error ? e.message : String(e)); } finally { setBusy(null); }
  }
  async function stop() {
    if (!active) return;
    setBusy('stop'); setError('');
    try { await stopBotRun(bot, active.id); await refreshBotState(); } catch (e) { setError(e instanceof Error ? e.message : String(e)); } finally { setBusy(null); }
  }
  const suggestions = bot.canCreateBots
    ? ['Make me a bot that sends me a daily AI news digest', 'I want a bot that checks my inbox every morning', 'Build a bot that finds YouTube video ideas weekly']
    : ['Do your job now', 'What can you do for me?', 'What did you do last time?'];
  return (
    <div
      className={`terminal-chat-view structured-chat-view bots-structured-chat${dragging ? ' bots-dropping' : ''}`}
      onDragOver={(e) => { if (e.dataTransfer.types.includes('Files')) { e.preventDefault(); setDragging(true); } }}
      onDragLeave={(e) => { if (e.currentTarget === e.target) setDragging(false); }}
      onDrop={(e) => { if (!e.dataTransfer.files.length) return; e.preventDefault(); setDragging(false); addFiles(e.dataTransfer.files); }}
      data-chat-font={appearance.font === 'app' ? undefined : appearance.font === 'system' || appearance.font === 'terminal' ? appearance.font : 'custom'}
      data-chat-font-size={appearance.fontSize == null ? undefined : 'set'}
      data-contrast={appearance.contrast !== 100 ? '' : undefined}
      style={{
        '--tc-col': CHAT_WIDTH_COLUMN[appearance.width],
        '--tc-code-size': `${appearance.codeFontSize}px`,
        '--tc-font-family': `"${appearance.font}", system-ui, sans-serif`,
        ...contrastVars(appearance.contrast, false),
        ...(appearance.fontSize == null ? {} : { '--tc-font-size': `${appearance.fontSize}px` }),
      } as React.CSSProperties}
    >
      <div className="terminal-chat-transcript">
        <div className="terminal-chat-scroll" ref={scroller}>
          <div className="terminal-chat-thread">
            {!shown.length && <div className="bots-chat-empty">
              <BotAvatar avatar={bot.avatar} size={64} />
              <h3>{bot.name}</h3>
              <p>{bot.instructions.length > 220 ? `${bot.instructions.slice(0, 220)}…` : bot.instructions}</p>
              <div className="bots-chat-suggestions">
                {suggestions.map((text) => <button key={text} type="button" className="terminal-chat-pill" onClick={() => { setDraft(text); textarea.current?.focus(); }}>{text}</button>)}
              </div>
            </div>}
            {shown.map((run) => {
              const reply = replies[run.id]?.trim();
              return <div key={run.id} className="bots-exchange">
                {run.message
                  ? <SentTurn bot={bot} run={run} />
                  : <div className="terminal-chat-notice">{run.trigger === 'schedule' ? 'Scheduled run' : 'Run started'} · {clock(run.startedAt)}</div>}
                {reply && <div className="tcr-msg"><div className="terminal-chat-agent"><Markdown text={reply} onOpenImage={noImages} /></div></div>}
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
            placeholder={active ? `${bot.name} is working… (Stop to send something new)` : `Message ${bot.name}`}
            disabled={Boolean(active)}
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
            <span className="terminal-chat-pill" title="The agent CLI this bot runs on">
              <span className="terminal-chat-pill-label">{agentProgram(bot.agent)}{bot.model ? ` · ${bot.model}` : ''}</span>
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
              <button type="button" className="terminal-chat-send" title={busy === 'send' && pending.length ? 'Uploading…' : 'Send (Enter)'} aria-label="Send" disabled={busy !== null || (!draft.trim() && !pending.length)} onClick={() => void send()}>
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M12 19V5M5 12l7-7 7 7" /></svg>
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

/** A message you sent, with its attachments: images as thumbnails, other files as chips. */
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
        <div className="bots-section">
          <h4>Job</h4>
          <p className="bots-job">{bot.instructions}</p>
          <div className="bots-facts">
            <span><strong>Agent</strong> {bot.agent}{bot.model ? ` (${bot.model})` : ''}</span>
            <span><strong>May</strong> {access?.label.toLowerCase()}</span>
            <span><strong>Connectors</strong> {connectors.length ? connectors.join(', ') : 'none'}</span>
            <span><strong>Browser</strong> {bot.browser ? 'yes' : 'no'}</span>
            <span><strong>Computer use</strong> {bot.computerUse ? (bot.boxId === LOCAL_HOST ? 'this PC\'s screen' : 'the box\'s desktop') : 'no'}</span>
            {bot.canCreateBots && <span><strong>Creates bots</strong> yes</span>}
          </div>
          {homeRoot && <p className="bots-helper">Home folder: <code>{`${homeRoot}/${bot.id}`}</code></p>}
        </div>
        <div className="bots-section">
          <h4>All runs</h4>
          {!runs.length ? <p className="bots-helper">No runs yet.</p> : runs.map((run) => (
            <article key={run.id} className="bots-run">
              <span className={`bots-dot ${run.status}`} aria-hidden="true" />
              <div>
                <strong>{STATUS_LABEL[run.status]}</strong>
                <p>{when(run.startedAt)} · {run.trigger === 'schedule' ? 'scheduled' : run.trigger === 'chat' ? 'chat' : 'manual'}{duration(run) ? ` · ${duration(run)}` : ''}</p>
                {run.message && <small>“{run.message.length > 120 ? `${run.message.slice(0, 120)}…` : run.message}”</small>}
                {run.detail && <small>{run.detail}</small>}
                {openLog?.id === run.id && <pre className="bots-log">{openLog.text}</pre>}
              </div>
              <div className="bots-run-actions">
                {run.log && <button type="button" onClick={() => void toggleLog(run)}>{openLog?.id === run.id ? 'Hide output' : 'Raw output'}</button>}
              </div>
            </article>
          ))}
        </div>
      </div>
    </div>
  );
}
