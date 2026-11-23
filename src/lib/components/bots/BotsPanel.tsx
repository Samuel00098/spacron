import { useEffect, useState } from 'react';
import { useStore } from '$lib/react/useStore';
import { activeConnection, activeRemoteId, connectRemote, connectionStatus, remoteConnections, remoteTarget } from '$lib/stores/remoteWorkspace';
import { customAgents, removedPresetAgents } from '$lib/stores/customAgents';
import { usageState } from '$lib/stores/usage';
import { mcpServers } from '$lib/stores/settings';
import { showToast } from '$lib/stores/notification';
import { AgentBrandMark } from '$lib/components/shared/useAgentBrand';
import Dropdown from '$lib/components/shared/Dropdown';
import { ACCESS_OPTIONS } from '$lib/components/shared/BotSettingsSection';
import {
  BOT_TEMPLATES, LOCAL_HOST, agentProgram, botAgents, botHostState, botSettings, bots, closeBots, connectorNames, fetchBotLog,
  latestRun, localAvailable, nextBotRun, refreshBotState, removeBot, runBotNow, runsFor, saveBot, selectedBotId, stopBotRun,
  toggleBot, visibleBots, type Bot, type BotAccess, type BotRun, type BotSchedule,
} from '$lib/services/bots/bots';
import './Bots.css';

/** `selectedBotId` value that opens the editor for a new bot. */
export const NEW_BOT = '__new__';

const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const SCHEDULES: { value: BotSchedule; label: string }[] = [
  { value: 'manual', label: 'Only when I run it' },
  { value: 'hourly', label: 'Every hour' },
  { value: 'daily', label: 'Every day' },
  { value: 'weekdays', label: 'Weekdays' },
  { value: 'weekly', label: 'Every week' },
];

export function BotIcon({ size = 18 }: { size?: number }) {
  return <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <rect x="4" y="8" width="16" height="12" rx="3" /><path d="M12 4v4M9 14h.01M15 14h.01M2 13v3M22 13v3" /></svg>;
}

export function botScheduleLabel(b: Pick<Bot, 'schedule' | 'time' | 'day'>): string {
  if (b.schedule === 'manual') return 'Runs when you start it';
  if (b.schedule === 'hourly') return `Every hour at :${b.time.slice(3)}`;
  const when = b.schedule === 'weekly' ? WEEKDAYS[b.day] : b.schedule === 'weekdays' ? 'Mon to Fri' : 'Every day';
  return `${when} at ${b.time}`;
}

function when(ms?: number | null): string {
  return ms ? new Date(ms).toLocaleString(undefined, { weekday: 'short', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }) : '';
}

function duration(run: BotRun): string {
  if (!run.finishedAt) return '';
  const s = Math.max(0, Math.round((run.finishedAt - run.startedAt) / 1000));
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${s % 60}s`;
}

const STATUS_LABEL: Record<BotRun['status'], string> = {
  running: 'Running', completed: 'Done', failed: 'Failed', stopped: 'Stopped', missed: 'Missed', interrupted: 'Interrupted',
};

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
    const timer = window.setInterval(load, anyRunning ? 3_000 : 15_000);
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
  return (
    <section className="bots-panel" aria-label="Bots">
      <header className="bots-header">
        <span className="bots-header-icon"><BotIcon size={22} /></span>
        <div>
          <h2>Bots</h2>
          <p>Agents with a standing job, outside every project. {remote ? 'Bots on your box keep working while this laptop is closed.' : 'They run on this PC while Spacron is open, or on a box once you connect one.'}</p>
        </div>
        {selected !== NEW_BOT && <button type="button" className="bots-primary" onClick={() => selectedBotId.set(NEW_BOT)}>+ New bot</button>}
        <CloseButton />
      </header>
      {stateError && <p role="alert" className="bots-error">Could not load runs: {stateError}</p>}
      <div className="bots-body">
        {selected === NEW_BOT ? <BotEditor onDone={(id) => selectedBotId.set(id)} />
          : bot ? <BotDetail key={bot.id} bot={bot} runs={runsFor(state, bot)} homeRoot={state[bot.boxId]?.homeRoot ?? ''} />
          : <BotList bots={mine} />}
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
        <div className="bots-empty-icon"><BotIcon size={30} /></div>
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
      <div className="bots-empty-icon"><BotIcon size={30} /></div>
      <h3>Put an agent on the night shift</h3>
      <p>Give a bot a job and a schedule. It gets its own folder that it keeps between runs, so it can remember what it did last time. It runs with the agent CLIs you already have installed.</p>
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
                <AgentBrandMark command={b.agent} name={b.agent} className="bots-agent-mark" />
                <strong>{b.name}</strong>
                <StatusChip bot={b} run={run} />
              </div>
              <p>{b.instructions}</p>
              <small>{botScheduleLabel(b)}{next ? ` · next ${when(next)}` : ''}{run ? ` · last ${STATUS_LABEL[run.status].toLowerCase()} ${when(run.startedAt)}` : ''}</small>
            </button>
          );
        })}
      </div>
    </section>
  ))}</>;
}

function StatusChip({ bot, run }: { bot: Bot; run?: BotRun }) {
  const settings = useStore(botSettings);
  if (run?.status === 'running') return <span className="bots-chip running">Running</span>;
  if (bot.schedule === 'manual') return <span className="bots-chip">On demand</span>;
  const on = bot.enabled && settings.enabled;
  return <span className={`bots-chip ${on ? 'scheduled' : ''}`}>{on ? 'Scheduled' : 'Paused'}</span>;
}

/** A template picked from the empty state, applied when the editor opens. */
let pendingTemplate: (typeof BOT_TEMPLATES)[number] | null = null;

function TemplateGrid({ onPick }: { onPick?: (t: (typeof BOT_TEMPLATES)[number]) => void }) {
  return (
    <div className="bots-templates">
      <span>Or start from a template</span>
      <div className="bots-template-grid">
        {BOT_TEMPLATES.map((t) => <button key={t.id} type="button" className="bots-template" onClick={() => {
          if (onPick) onPick(t);
          else { pendingTemplate = t; selectedBotId.set(NEW_BOT); }
        }}><strong>{t.name}</strong><small>{t.blurb}</small></button>)}
      </div>
    </div>
  );
}

function BotEditor({ bot, onDone }: { bot?: Bot; onDone: (id: string | null) => void }) {
  useStore(customAgents);
  useStore(removedPresetAgents);
  useStore(usageState);
  useStore(mcpServers);
  const settings = useStore(botSettings);
  const box = useStore(activeConnection);
  const remote = useStore(remoteTarget);
  const agents = botAgents();
  const start = bot ?? pendingTemplate;
  pendingTemplate = null;
  const hosts = [...(localAvailable() ? [{ value: LOCAL_HOST, label: 'This PC' }] : []), ...(remote && box ? [{ value: box.id, label: box.name }] : [])];
  const [host, setHost] = useState(bot?.boxId ?? (remote && box ? box.id : hosts[0]?.value ?? LOCAL_HOST));
  const [name, setName] = useState(start?.name ?? '');
  const [instructions, setInstructions] = useState(start?.instructions ?? '');
  const [agent, setAgent] = useState(bot?.agent ?? agents[0]?.command ?? '');
  const [model, setModel] = useState(bot?.model ?? '');
  const [schedule, setSchedule] = useState<BotSchedule>(start?.schedule ?? 'manual');
  const [time, setTime] = useState(start?.time ?? '09:00');
  const [day, setDay] = useState(start?.day ?? 1);
  const [access, setAccess] = useState<BotAccess>(start?.access ?? settings.defaultAccess);
  const [connectors, setConnectors] = useState(bot?.connectors ?? true);
  const [error, setError] = useState('');
  const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  const program = agentProgram(agent);
  const tools = connectorNames(host);
  let next = '';
  try { next = when(nextBotRun({ schedule, time, day, enabled: true })); } catch { /* incomplete time input */ }
  function applyTemplate(t: (typeof BOT_TEMPLATES)[number]) { setName(t.name); setInstructions(t.instructions); setSchedule(t.schedule); setTime(t.time); setDay(t.day); setAccess(t.access); }
  function submit() {
    setError('');
    try {
      const saved = saveBot({ id: bot?.id, boxId: host, name, instructions, agent, model: model.trim() || null, schedule, time, day, access, connectors, enabled: bot?.enabled ?? true });
      showToast(bot ? `Saved "${saved.name}".` : `"${saved.name}" is ready to work.`, 'success');
      onDone(saved.id);
    } catch (e) { setError(e instanceof Error ? e.message : String(e)); }
  }
  return (
    <form className="bots-editor" onSubmit={(e) => { e.preventDefault(); submit(); }}>
      <div className="bots-editor-heading"><h3>{bot ? `Edit ${bot.name}` : 'New bot'}</h3></div>
      {!bot && <TemplateGrid onPick={applyTemplate} />}
      {error && <p role="alert" className="bots-error">{error}</p>}
      <div className="bots-editor-grid">
        <div>
          <label htmlFor="bot-name">Name</label>
          <input id="bot-name" required maxLength={80} placeholder="e.g. Morning tech digest" value={name} onChange={(e) => setName(e.target.value)} />
          <label htmlFor="bot-job">Job</label>
          <textarea id="bot-job" required rows={9} maxLength={20_000} placeholder="What should this bot do every time it runs? Say what result you want and where to save it." value={instructions} onChange={(e) => setInstructions(e.target.value)} />
          <p className="bots-helper">Each run starts a fresh agent in the bot's own folder. Files it saves there are still there next run.</p>
        </div>
        <aside className="bots-editor-side">
          <span className="bots-field-label">Runs on</span>
          <Dropdown ariaLabel="Where the bot runs" value={host} onChange={setHost} disabled={Boolean(bot)} options={hosts.length ? hosts : [{ value: host, label: host === LOCAL_HOST ? 'This PC' : 'Box (not connected)' }]} />
          <p className="bots-helper">{host === LOCAL_HOST ? 'Runs while Spacron is open on this PC.' : 'Runs on the box, even while this laptop is closed.'}</p>
          <span className="bots-field-label">Run with</span>
          <Dropdown ariaLabel="Bot agent" value={agent} onChange={setAgent} placeholder="Choose an agent"
            options={[...agents.map((a) => ({ value: a.command, label: a.name, icon: <AgentBrandMark command={a.command} name={a.name} className="bots-agent-mark" /> })),
              ...(agent && !agents.some((a) => a.command === agent) ? [{ value: agent, label: `${agent} (not installed here)`, disabled: true }] : [])]} />
          <p className="bots-helper">{agents.length ? 'Uses the agent CLI installed where the bot runs.' : ''}</p>
          {!agents.length && <p className="bots-error">Install Claude Code, Codex, Gemini CLI or opencode. Bots need an agent that can run unattended.</p>}
          <label htmlFor="bot-model">Model <small>(optional)</small></label>
          <input id="bot-model" placeholder="Agent default" value={model} onChange={(e) => setModel(e.target.value)} />
          <span className="bots-field-label">It may</span>
          <Dropdown ariaLabel="What the bot may do" value={access} onChange={(v) => setAccess(v as BotAccess)} options={ACCESS_OPTIONS.map((o) => ({ value: o.value, label: o.label }))} />
          <p className={`bots-helper${access === 'full' ? ' bots-warn' : ''}`}>{ACCESS_OPTIONS.find((o) => o.value === access)?.detail}{program === 'opencode' ? ' opencode uses the permissions from its own config.' : ''}</p>
          <label className="bots-check">
            <input type="checkbox" checked={connectors} onChange={(e) => setConnectors(e.target.checked)} />
            <span>Use my connectors</span>
          </label>
          <p className="bots-helper">{!connectors ? 'No MCP servers.' : tools.length ? tools.join(', ') : 'No connectors set up yet. Add them in Settings > MCP & plugins.'}
            {connectors && tools.length > 0 && program !== 'claude' ? ' Connectors reach Claude Code bots for now; other agents use their own MCP config.' : ''}</p>
          <span className="bots-field-label">Runs</span>
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
      <p className="bots-note">Bots run unattended and can't stop to ask you anything, so what they may do is decided here. A run stops after {settings.maxRunMinutes >= 60 ? `${settings.maxRunMinutes / 60} hour${settings.maxRunMinutes === 60 ? '' : 's'}` : `${settings.maxRunMinutes} minutes`} (Settings &gt; Bots), and you can stop it any time.</p>
      <footer className="bots-editor-footer">
        <button type="button" onClick={() => onDone(bot?.id ?? null)}>Cancel</button>
        <button type="submit" className="bots-primary" disabled={!agents.some((a) => a.command === agent)}>{bot ? 'Save changes' : 'Create bot'}</button>
      </footer>
    </form>
  );
}

function BotDetail({ bot, runs, homeRoot }: { bot: Bot; runs: BotRun[]; homeRoot: string }) {
  const hostName = useHostName();
  const [editing, setEditing] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [busy, setBusy] = useState<'start' | 'stop' | null>(null);
  const [error, setError] = useState('');
  const [openLog, setOpenLog] = useState<{ id: string; text: string } | null>(null);
  const active = runs.find((r) => r.status === 'running');
  const next = nextBotRun(bot);
  // Keep an open log fresh while that run is still going.
  const openRunning = openLog ? runs.find((r) => r.id === openLog.id)?.status === 'running' : false;
  useEffect(() => {
    if (!openLog || !openRunning) return;
    const timer = window.setInterval(() => { void fetchBotLog(bot, openLog.id).then((log) => setOpenLog({ id: openLog.id, text: format(log) })).catch(() => {}); }, 3_000);
    return () => window.clearInterval(timer);
  }, [openLog?.id, openRunning]);

  if (editing) return <BotEditor bot={bot} onDone={() => setEditing(false)} />;

  async function runNow() {
    setBusy('start'); setError('');
    try {
      const runId = await runBotNow(bot.id);
      await refreshBotState();
      setOpenLog({ id: runId, text: '(Starting…)' });
      // Show the first output as soon as there is some, not on the next poll.
      window.setTimeout(() => { void fetchBotLog(bot, runId).then((log) => setOpenLog((cur) => (cur?.id === runId ? { id: runId, text: format(log) } : cur))).catch(() => {}); }, 800);
    } catch (e) { setError(e instanceof Error ? e.message : String(e)); } finally { setBusy(null); }
  }
  async function stop(run: BotRun) {
    setBusy('stop'); setError('');
    try {
      await stopBotRun(bot, run.id);
      // The runner records the stop as soon as the agent exits.
      for (let i = 0; i < 10; i++) {
        const state = await refreshBotState();
        if (runsFor(state, bot).find((r) => r.id === run.id)?.status !== 'running') break;
        await new Promise((r) => setTimeout(r, 600));
      }
      if (openLog?.id === run.id) setOpenLog({ id: run.id, text: format(await fetchBotLog(bot, run.id)) });
    } catch (e) { setError(e instanceof Error ? e.message : String(e)); } finally { setBusy(null); }
  }
  async function toggleLog(run: BotRun) {
    if (openLog?.id === run.id) { setOpenLog(null); return; }
    try { setOpenLog({ id: run.id, text: format(await fetchBotLog(bot, run.id)) }); } catch (e) { setOpenLog({ id: run.id, text: `Could not read the output: ${String(e)}` }); }
  }
  const access = ACCESS_OPTIONS.find((o) => o.value === bot.access);
  return (
    <div className="bots-detail">
      <button type="button" className="bots-back" onClick={() => selectedBotId.set(null)}>← All bots</button>
      <div className="bots-detail-head">
        <span className="bots-detail-icon"><AgentBrandMark command={bot.agent} name={bot.agent} className="bots-agent-mark large" /></span>
        <div>
          <h3>{bot.name} <StatusChip bot={bot} run={runs[0]} /></h3>
          <p>{hostName(bot.boxId)} · {botScheduleLabel(bot)}{next ? ` · next ${when(next)}` : ''} · {bot.agent}{bot.model ? ` (${bot.model})` : ''}</p>
        </div>
      </div>
      {error && <p role="alert" className="bots-error">{error}</p>}
      <div className="bots-actions">
        {active
          ? <button type="button" className="bots-stop" disabled={busy !== null} onClick={() => void stop(active)}>
              <svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><rect x="5" y="5" width="14" height="14" rx="2" /></svg>
              {busy === 'stop' ? 'Stopping…' : 'Stop'}
            </button>
          : <button type="button" className="bots-primary" disabled={busy !== null} onClick={() => void runNow()}>{busy === 'start' ? 'Starting…' : 'Run now'}</button>}
        {bot.schedule !== 'manual' && <button type="button" onClick={() => toggleBot(bot.id)}>{bot.enabled ? 'Pause schedule' : 'Resume schedule'}</button>}
        <button type="button" onClick={() => setEditing(true)}>Edit</button>
        {confirmDelete ? <>
          <span className="bots-confirm">Delete this bot? Its folder is kept.</span>
          <button type="button" className="bots-danger" disabled={Boolean(active)} onClick={() => removeBot(bot.id)}>Delete</button>
          <button type="button" onClick={() => setConfirmDelete(false)}>Keep</button>
        </> : <button type="button" className="bots-subtle" disabled={Boolean(active)} title={active ? 'Stop the run first' : undefined} onClick={() => setConfirmDelete(true)}>Delete</button>}
      </div>
      <div className="bots-section">
        <h4>Job</h4>
        <p className="bots-job">{bot.instructions}</p>
        <div className="bots-facts">
          <span><strong>May</strong> {access?.label.toLowerCase()}</span>
          <span><strong>Connectors</strong> {bot.connectors ? (connectorNames(bot.boxId).join(', ') || 'none set up') : 'off'}</span>
        </div>
        {homeRoot && <p className="bots-helper">Home folder: <code>{`${homeRoot}/${bot.id}`}</code></p>}
      </div>
      <div className="bots-section">
        <h4>Runs</h4>
        {!runs.length ? <p className="bots-helper">No runs yet. Hit Run now to see it work.</p> : runs.map((run) => (
          <article key={run.id} className="bots-run">
            <span className={`bots-dot ${run.status}`} aria-hidden="true" />
            <div>
              <strong>{STATUS_LABEL[run.status]}</strong>
              <p>{when(run.startedAt)} · {run.trigger === 'schedule' ? 'scheduled' : 'manual'}{duration(run) ? ` · ${duration(run)}` : ''}</p>
              {run.detail && <small>{run.detail}</small>}
              {openLog?.id === run.id && <pre className="bots-log">{openLog.text}</pre>}
            </div>
            <div className="bots-run-actions">
              {run.status === 'running' && <button type="button" className="bots-stop small" disabled={busy !== null} onClick={() => void stop(run)} aria-label="Stop this run">Stop</button>}
              {run.log && <button type="button" onClick={() => void toggleLog(run)}>{openLog?.id === run.id ? 'Hide output' : 'View output'}</button>}
            </div>
          </article>
        ))}
      </div>
    </div>
  );
}

function format(log: { text: string; truncated: boolean }): string {
  if (!log.text) return '(Nothing printed yet.)';
  return log.truncated ? `… earlier output hidden …\n${log.text}` : log.text;
}
