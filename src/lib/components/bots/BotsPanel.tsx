import { useEffect, useState } from 'react';
import { useStore } from '$lib/react/useStore';
import { activeConnection, activeRemoteId, connectRemote, connectionStatus, remoteConnections, remoteTarget } from '$lib/stores/remoteWorkspace';
import { customAgents, removedPresetAgents } from '$lib/stores/customAgents';
import { usageState } from '$lib/stores/usage';
import { showToast } from '$lib/stores/notification';
import { AgentBrandMark } from '$lib/components/shared/useAgentBrand';
import Dropdown from '$lib/components/shared/Dropdown';
import {
  BOT_TEMPLATES, botAgents, botBoxState, bots, botsOnActiveBox, fetchBotLog, latestRun, nextBotRun, refreshBotState,
  closeBots, removeBot, runBotNow, saveBot, selectedBotId, toggleBot, type Bot, type BotRun, type BotSchedule,
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
  running: 'Running', completed: 'Done', failed: 'Failed', missed: 'Missed', interrupted: 'Interrupted',
};

export default function BotsPanel() {
  const list = useStore(bots);
  const selected = useStore(selectedBotId);
  const remote = useStore(remoteTarget);
  const boxId = useStore(activeRemoteId);
  const box = useStore(activeConnection);
  const { runs, homeRoot } = useStore(botBoxState);
  const [stateError, setStateError] = useState('');
  const mine = botsOnActiveBox(list);
  const anyRunning = runs.some((r) => r.status === 'running');

  // Poll the box while the panel is open: quickly while something runs.
  useEffect(() => {
    if (!remote) return;
    let alive = true;
    const load = () => refreshBotState().then(() => { if (alive) setStateError(''); }).catch((e) => { if (alive) setStateError(String(e)); });
    void load();
    const timer = window.setInterval(load, anyRunning ? 4_000 : 15_000);
    return () => { alive = false; window.clearInterval(timer); };
  }, [remote, boxId, anyRunning]);

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

  if (!remote) return <NoBox />;
  const bot = mine.find((b) => b.id === selected) ?? null;
  return (
    <section className="bots-panel" aria-label="Bots">
      <header className="bots-header">
        <span className="bots-header-icon"><BotIcon size={22} /></span>
        <div>
          <h2>Bots</h2>
          <p>Agents that work for you on <strong>{box?.name ?? 'your box'}</strong>, even while this laptop is closed.</p>
        </div>
        {selected !== NEW_BOT && <button type="button" className="bots-primary" onClick={() => selectedBotId.set(NEW_BOT)}>+ New bot</button>}
        <CloseButton />
      </header>
      {stateError && <p role="alert" className="bots-error">Could not reach the box: {stateError}</p>}
      <div className="bots-body">
        {selected === NEW_BOT ? <BotEditor onDone={(id) => selectedBotId.set(id)} />
          : bot ? <BotDetail key={bot.id} bot={bot} runs={runs.filter((r) => r.botId === bot.id)} homeRoot={homeRoot} />
          : <BotList bots={mine} runs={runs} />}
      </div>
    </section>
  );
}

function CloseButton() {
  return <button type="button" className="bots-close" aria-label="Close Bots" title="Back to the workspace (Esc)" onClick={closeBots}>×</button>;
}

function NoBox() {
  const connections = useStore(remoteConnections);
  const status = useStore(connectionStatus);
  return (
    <section className="bots-panel" aria-label="Bots">
      <div className="bots-panel-close"><CloseButton /></div>
      <div className="bots-empty">
        <div className="bots-empty-icon"><BotIcon size={30} /></div>
        <h3>Bots live on your box</h3>
        <p>A bot is an agent with a standing job, like a daily digest or a weekly research report. It runs on your remote box, outside every project, so it keeps working while this laptop is closed.</p>
        {connections.length ? <div className="bots-connect-list">
          {connections.map((c) => <button key={c.id} type="button" disabled={status === 'connecting'} onClick={() => void connectRemote(c.id)}>
            {status === 'connecting' ? 'Connecting…' : `Connect to ${c.name}`}
          </button>)}
        </div> : <p className="bots-helper">Set up a box from the <strong>Remote workspace</strong> menu in the status bar, then come back here.</p>}
      </div>
    </section>
  );
}

function BotList({ bots: list, runs }: { bots: Bot[]; runs: BotRun[] }) {
  if (!list.length) return (
    <div className="bots-empty">
      <div className="bots-empty-icon"><BotIcon size={30} /></div>
      <h3>Put an agent on the night shift</h3>
      <p>Give a bot a job and a schedule. It gets its own folder on the box that it keeps between runs, so it can remember what it did last time.</p>
      <button type="button" className="bots-primary" onClick={() => selectedBotId.set(NEW_BOT)}>+ Create your first bot</button>
      <TemplateGrid />
    </div>
  );
  return (
    <div className="bots-grid">
      {list.slice().sort((a, b) => a.name.localeCompare(b.name)).map((b) => {
        const run = latestRun(runs, b.id);
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
  );
}

function StatusChip({ bot, run }: { bot: Bot; run?: BotRun }) {
  if (run?.status === 'running') return <span className="bots-chip running">Running</span>;
  if (bot.schedule === 'manual') return <span className="bots-chip">On demand</span>;
  return <span className={`bots-chip ${bot.enabled ? 'scheduled' : ''}`}>{bot.enabled ? 'Scheduled' : 'Paused'}</span>;
}

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

/** A template picked from the empty state, applied when the editor opens. */
let pendingTemplate: (typeof BOT_TEMPLATES)[number] | null = null;

function BotEditor({ bot, onDone }: { bot?: Bot; onDone: (id: string | null) => void }) {
  useStore(customAgents);
  useStore(removedPresetAgents);
  useStore(usageState);
  const agents = botAgents();
  const start = bot ?? pendingTemplate;
  pendingTemplate = null;
  const [name, setName] = useState(start?.name ?? '');
  const [instructions, setInstructions] = useState(start?.instructions ?? '');
  const [agent, setAgent] = useState(bot?.agent ?? agents[0]?.command ?? '');
  const [model, setModel] = useState(bot?.model ?? '');
  const [schedule, setSchedule] = useState<BotSchedule>(start?.schedule ?? 'manual');
  const [time, setTime] = useState(start?.time ?? '09:00');
  const [day, setDay] = useState(start?.day ?? 1);
  const [error, setError] = useState('');
  const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  let next = '';
  try { next = when(nextBotRun({ schedule, time, day, enabled: true })); } catch { /* incomplete time input */ }
  function submit() {
    setError('');
    try {
      const saved = saveBot({ id: bot?.id, name, instructions, agent, model: model.trim() || null, schedule, time, day, enabled: bot?.enabled ?? true });
      showToast(bot ? `Saved "${saved.name}".` : `"${saved.name}" is on the box and ready to work.`, 'success');
      onDone(saved.id);
    } catch (e) { setError(e instanceof Error ? e.message : String(e)); }
  }
  return (
    <form className="bots-editor" onSubmit={(e) => { e.preventDefault(); submit(); }}>
      <div className="bots-editor-heading"><h3>{bot ? `Edit ${bot.name}` : 'New bot'}</h3></div>
      {!bot && <TemplateGrid onPick={(t) => { setName(t.name); setInstructions(t.instructions); setSchedule(t.schedule); setTime(t.time); setDay(t.day); }} />}
      {error && <p role="alert" className="bots-error">{error}</p>}
      <div className="bots-editor-grid">
        <div>
          <label htmlFor="bot-name">Name</label>
          <input id="bot-name" required maxLength={80} placeholder="e.g. Morning tech digest" value={name} onChange={(e) => setName(e.target.value)} />
          <label htmlFor="bot-job">Job</label>
          <textarea id="bot-job" required rows={9} maxLength={20_000} placeholder="What should this bot do every time it runs? Say what result you want and where to save it." value={instructions} onChange={(e) => setInstructions(e.target.value)} />
          <p className="bots-helper">Each run starts a fresh agent in the bot's own folder on the box. Files it saves there are still there next run.</p>
        </div>
        <aside className="bots-editor-side">
          <span className="bots-field-label">Run with</span>
          <Dropdown ariaLabel="Bot agent" value={agent} onChange={setAgent} placeholder="Choose an agent"
            options={[...agents.map((a) => ({ value: a.command, label: a.name, icon: <AgentBrandMark command={a.command} name={a.name} className="bots-agent-mark" /> })),
              ...(agent && !agents.some((a) => a.command === agent) ? [{ value: agent, label: `${agent} (not installed here)`, disabled: true }] : [])]} />
          {!agents.length && <p className="bots-error">Install Claude Code, Codex, Gemini CLI or opencode. Bots need an agent that can run unattended.</p>}
          <label htmlFor="bot-model">Model <small>(optional)</small></label>
          <input id="bot-model" placeholder="Agent default" value={model} onChange={(e) => setModel(e.target.value)} />
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
          {schedule !== 'manual' && <p className="bots-helper">Next run <strong>{next || 'choose a time'}</strong> ({timezone})</p>}
        </aside>
      </div>
      <p className="bots-note">Bots run headless and cannot stop to ask you for approval, so give them work they can finish on their own. Runs stop after an hour.</p>
      <footer className="bots-editor-footer">
        <button type="button" onClick={() => onDone(bot?.id ?? null)}>Cancel</button>
        <button type="submit" className="bots-primary" disabled={!agents.some((a) => a.command === agent)}>{bot ? 'Save changes' : 'Create bot'}</button>
      </footer>
    </form>
  );
}

function BotDetail({ bot, runs, homeRoot }: { bot: Bot; runs: BotRun[]; homeRoot: string }) {
  const [editing, setEditing] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [openLog, setOpenLog] = useState<{ id: string; text: string } | null>(null);
  const running = runs.some((r) => r.status === 'running');
  const next = nextBotRun(bot);
  // Keep an open log fresh while that run is still going.
  const openRunning = openLog ? runs.find((r) => r.id === openLog.id)?.status === 'running' : false;
  useEffect(() => {
    if (!openLog || !openRunning) return;
    const timer = window.setInterval(() => { void fetchBotLog(openLog.id).then((log) => setOpenLog({ id: openLog.id, text: format(log) })).catch(() => {}); }, 4_000);
    return () => window.clearInterval(timer);
  }, [openLog?.id, openRunning]);

  if (editing) return <BotEditor bot={bot} onDone={() => setEditing(false)} />;

  async function runNow() {
    setBusy(true); setError('');
    try {
      const runId = await runBotNow(bot.id);
      await refreshBotState();
      setOpenLog({ id: runId, text: '(Starting…)' });
    } catch (e) { setError(e instanceof Error ? e.message : String(e)); } finally { setBusy(false); }
  }
  async function toggleLog(run: BotRun) {
    if (openLog?.id === run.id) { setOpenLog(null); return; }
    try { setOpenLog({ id: run.id, text: format(await fetchBotLog(run.id)) }); } catch (e) { setOpenLog({ id: run.id, text: `Could not read the log: ${String(e)}` }); }
  }
  return (
    <div className="bots-detail">
      <button type="button" className="bots-back" onClick={() => selectedBotId.set(null)}>← All bots</button>
      <div className="bots-detail-head">
        <AgentBrandMark command={bot.agent} name={bot.agent} className="bots-agent-mark large" />
        <div>
          <h3>{bot.name} <StatusChip bot={bot} run={runs[0]} /></h3>
          <p>{botScheduleLabel(bot)}{next ? ` · next ${when(next)}` : ''} · {bot.agent}{bot.model ? ` (${bot.model})` : ''}</p>
        </div>
      </div>
      {error && <p role="alert" className="bots-error">{error}</p>}
      <div className="bots-actions">
        <button type="button" className="bots-primary" disabled={busy || running} onClick={() => void runNow()}>{running ? 'Running…' : busy ? 'Starting…' : 'Run now'}</button>
        {bot.schedule !== 'manual' && <button type="button" onClick={() => toggleBot(bot.id)}>{bot.enabled ? 'Pause schedule' : 'Resume schedule'}</button>}
        <button type="button" onClick={() => setEditing(true)}>Edit</button>
        {confirmDelete ? <>
          <span className="bots-confirm">Delete this bot? Its folder stays on the box.</span>
          <button type="button" className="bots-danger" disabled={running} onClick={() => removeBot(bot.id)}>Delete</button>
          <button type="button" onClick={() => setConfirmDelete(false)}>Keep</button>
        </> : <button type="button" className="bots-subtle" disabled={running} title={running ? 'Wait for the run to finish' : undefined} onClick={() => setConfirmDelete(true)}>Delete</button>}
      </div>
      <div className="bots-section">
        <h4>Job</h4>
        <p className="bots-job">{bot.instructions}</p>
        {homeRoot && <p className="bots-helper">Home folder on the box: <code>{`${homeRoot}/${bot.id}`}</code></p>}
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
            {run.log && <button type="button" onClick={() => void toggleLog(run)}>{openLog?.id === run.id ? 'Hide output' : 'View output'}</button>}
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
