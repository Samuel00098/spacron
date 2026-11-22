import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { createPortal } from 'react-dom';
import { useStore } from '$lib/react/useStore';
import { useModalFocus } from '$lib/react/useModalFocus';
import { activeProject } from '$lib/stores/workspace';
import { remoteTarget } from '$lib/stores/remoteWorkspace';
import { setActiveSession } from '$lib/stores/terminal';
import { requestRoomControl } from '$lib/stores/layoutControl';
import { showToast } from '$lib/stores/notification';
import { usageState, haveAgentDetection } from '$lib/stores/usage';
import { customAgents, removedPresetAgents } from '$lib/stores/customAgents';
import { getAgentRoster } from '$lib/stores/runs';
import { AgentBrandMark } from '$lib/components/shared/useAgentBrand';
import Dropdown from '$lib/components/shared/Dropdown';
import AgentLaunchConfigFields from '$lib/components/shared/AgentLaunchConfigFields';
import { freshLiveAgentProviderModels } from '$lib/services/live-agent-models';
import type { AgentProviderModel } from '$lib/services/agent-provider-catalogue';
import type { ChatReasoningEffort } from '$lib/types/chat';
import { automationSnapshot, subscribeAutomations, startAutomationScheduler, saveAutomation, toggleAutomation, removeAutomation, runAutomation, type Automation } from '$lib/services/automations/automations';
import { nextOccurrence, type Schedule } from '$lib/services/automations/schedule';
import './Automations.css';

function Clock({ size = 18 }: { size?: number }) {
  return <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" aria-hidden="true"><circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/></svg>;
}
const weekdays = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const schedules = [{ value: 'hourly', label: 'Every hour' }, { value: 'daily', label: 'Every day' }, { value: 'weekdays', label: 'Weekdays' }, { value: 'weekly', label: 'Every week' }];
type Template = { id: string; name: string; blurb: string; prompt: string; schedule: Schedule; time: string; day: number };
const templates: Template[] = [
  { id: 'review', name: 'Morning code review', blurb: 'Every day at 09:00', schedule: 'daily', time: '09:00', day: 1,
    prompt: 'Review the commits made in this repository over the last 24 hours. For each one, flag likely bugs, missing tests and risky changes, with file and line references. Do not edit any files. End with a short prioritised list of what to look at first.' },
  { id: 'standup', name: 'Daily standup summary', blurb: 'Weekdays at 08:30', schedule: 'weekdays', time: '08:30', day: 1,
    prompt: 'Summarise what changed in this project since the previous working day: commits, branches touched and any uncommitted work. Write it as a short standup update with three headings: Done, In progress, and Blocked or risky. Do not edit any files.' },
  { id: 'tests', name: 'Test health check', blurb: 'Every day at 18:00', schedule: 'daily', time: '18:00', day: 1,
    prompt: 'Run the project’s test suite and type checks. Report how many passed and failed, and for each failure give the likely cause and the file involved. Do not change any code; only report.' },
  { id: 'deps', name: 'Dependency and security check', blurb: 'Mondays at 10:00', schedule: 'weekly', time: '10:00', day: 1,
    prompt: 'Check this project’s dependencies for known security advisories and outdated packages using the project’s own package manager (for example npm audit or cargo audit). List each issue with its severity and the safest upgrade. Do not install or upgrade anything.' },
  { id: 'debt', name: 'Weekly TODO sweep', blurb: 'Fridays at 16:00', schedule: 'weekly', time: '16:00', day: 5,
    prompt: 'Search the codebase for TODO, FIXME and HACK comments and for obviously dead code. Group what you find by area, note which items look stale or risky, and suggest the three most worthwhile to tackle next week. Do not edit any files.' },
];

function scheduleLabel(a: Pick<Automation, 'schedule' | 'time' | 'day'>) {
  return a.schedule === 'hourly' ? `Every hour at :${a.time.slice(3)}` : `${a.schedule === 'weekly' ? weekdays[a.day] : a.schedule === 'weekdays' ? 'Mon–Fri' : 'Every day'} at ${a.time}`;
}

export default function Automations() {
  const [open, setOpen] = useState(false);
  useEffect(() => startAutomationScheduler(message => showToast(message, 'error')), []);
  return <><button className="icon-btn" aria-label="Automations" title="Automations" onClick={() => setOpen(true)}><Clock size={16}/></button>
    {open && createPortal(<AutomationDialog close={() => setOpen(false)} />, document.body)}</>;
}

export function AutomationDialog({ close }: { close: () => void }) {
  const ref = useRef<HTMLDivElement>(null);
  useModalFocus(ref, close);
  const { automations, runs } = useSyncExternalStore(subscribeAutomations, automationSnapshot);
  const project = useStore(activeProject);
  const remote = useStore(remoteTarget);
  const usage = useStore(usageState);
  useStore(customAgents);
  useStore(removedPresetAgents);
  const agents = getAgentRoster();
  const [tab, setTab] = useState<'saved' | 'history'>('saved');
  const [creating, setCreating] = useState(false);
  const [editing, setEditing] = useState<Automation | null>(null);
  const [name, setName] = useState('');
  const [prompt, setPrompt] = useState('');
  const [agent, setAgent] = useState(() => agents[0]?.command ?? '');
  const [model, setModel] = useState<string | null>(null);
  const [effort, setEffort] = useState<ChatReasoningEffort>('default');
  const [modelCatalog, setModelCatalog] = useState<{ agent: string; models: AgentProviderModel[] }>({ agent: '', models: [] });
  const [modelsLoading, setModelsLoading] = useState(false);
  const [modelRefresh, setModelRefresh] = useState(0);
  const [schedule, setSchedule] = useState<Schedule>('daily');
  const [time, setTime] = useState('09:00');
  const [day, setDay] = useState(1);
  const [error, setError] = useState('');
  const [pendingDelete, setPendingDelete] = useState<string | null>(null);
  const local = Boolean(project && !remote);
  const agentAvailable = agents.some(a => a.command === agent);
  const modelAvailable = !model || (modelCatalog.agent === agent && modelCatalog.models.some(entry => entry.id === model && entry.supported !== false));
  useEffect(() => { if (!agent && agents.length) setAgent(agents[0].command); }, [agent, usage.lastFetchedAt, agents.length]);
  const editor = creating || editing !== null;
  useEffect(() => {
    if (!editor || !agent) return;
    let alive = true;
    setModelsLoading(true);
    const fetchModels = (command: string) => freshLiveAgentProviderModels(command, true);
    fetchModels(agent).then(models => {
      if (alive) setModelCatalog({ agent, models });
    }).catch(() => {
      if (alive) setModelCatalog({ agent, models: [] });
    }).finally(() => { if (alive) setModelsLoading(false); });
    return () => { alive = false; };
  }, [editor, agent, modelRefresh]);
  function action(fn: () => void | Promise<void>) {
    setError('');
    try { Promise.resolve(fn()).catch(e => setError(String(e))); } catch (e) { setError(String(e)); }
  }
  function reset() { setEditing(null); setCreating(false); setName(''); setPrompt(''); setModel(null); setEffort('default'); setError(''); }
  function edit(a: Automation) {
    setEditing(a); setCreating(false); setName(a.name); setPrompt(a.prompt); setAgent(a.agent); setModel(a.model ?? null); setEffort(a.reasoningEffort ?? 'default'); setSchedule(a.schedule); setTime(a.time); setDay(a.day); setError('');
  }
  function newAutomation() { reset(); setAgent(agents[0]?.command ?? ''); setCreating(true); }
  function applyTemplate(t: Template) { setName(t.name); setPrompt(t.prompt); setSchedule(t.schedule); setTime(t.time); setDay(t.day); }
  function startFromTemplate(t: Template) { newAutomation(); applyTemplate(t); }
  const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  let next = '';
  try { next = new Date(nextOccurrence(schedule, time, day, Date.now())).toLocaleString(undefined, { weekday: 'short', hour: '2-digit', minute: '2-digit' }); } catch { /* incomplete time input */ }
  return <div className="automation-overlay" onMouseDown={e => { if (e.target === e.currentTarget) close(); }}>
    <div className="automation-dialog" ref={ref} role="dialog" aria-modal="true" aria-labelledby="automation-title">
      <header className="automation-header"><span className="automation-header-icon"><Clock size={22}/></span><div><h2 id="automation-title">Automations</h2><p>Put repeatable work on a schedule.</p></div><button className="automation-close" onClick={close} aria-label="Close automations">×</button></header>
      <div className="automation-nav"><div role="tablist" aria-label="Automation views"><button role="tab" aria-selected={tab === 'saved'} onClick={() => { reset(); setTab('saved'); }}>Automations <span>{automations.length}</span></button><button role="tab" aria-selected={tab === 'history'} onClick={() => { reset(); setTab('history'); }}>Run history <span>{runs.length}</span></button></div>{!editor && tab === 'saved' && <button className="automation-primary" onClick={newAutomation}>+ New automation</button>}</div>
      <div className="automation-body">
      {error && <p role="alert" className="automation-error">{error}</p>}
      {editor ? <form onSubmit={e => { e.preventDefault(); action(() => {
        if (!project || remote) throw new Error('Open a local project first');
        if (model && (modelsLoading || !modelAvailable)) throw new Error('Choose a model from this agent’s current model list');
        if (editing && (editing.projectId !== project.id || editing.root !== project.root_path)) throw new Error('Open the saved project to edit this automation');
        saveAutomation({ id: editing?.id, name, prompt, agent, model, reasoningEffort: effort, schedule, time, day, projectId: project.id, root: project.root_path, enabled: editing?.enabled ?? true }); reset();
      }); }}>
        <div className="automation-editor-heading"><h3>{editing ? 'Edit automation' : 'New automation'}</h3><span className="automation-project" title={project?.root_path}>{project?.name ?? 'No project open'}</span></div>
        <div className="automation-editor-grid"><div className="automation-instructions">
          {!editing && <div className="automation-template-chips" role="group" aria-label="Start from a template"><span>Start from a template</span>{templates.map(t => <button key={t.id} type="button" aria-pressed={name === t.name && prompt === t.prompt} onClick={() => applyTemplate(t)}>{t.name}</button>)}</div>}
          <label htmlFor="automation-name">Name</label><input id="automation-name" required maxLength={120} placeholder="e.g. Morning code review" value={name} onChange={e => setName(e.target.value)} />
          <label htmlFor="automation-prompt">Instructions</label><textarea id="automation-prompt" required rows={7} placeholder="What should the agent do each time? Be specific about the result you want." value={prompt} onChange={e => setPrompt(e.target.value)} />
          <p className="automation-helper">Each run starts a fresh agent session in this project.</p>
        </div><aside className="automation-configuration">
          <span className="automation-field-label">Run with</span><Dropdown ariaLabel="Automation agent" value={agent} onChange={value => { setAgent(value); setModel(null); setEffort('default'); }} placeholder="Choose an agent" options={[...agents.map(a => ({ value: a.command, label: a.name, icon: <AgentBrandMark command={a.command} name={a.name} className="automation-agent-mark"/> })), ...(!agentAvailable && agent ? [{ value: agent, label: `${agent} (unavailable)`, disabled: true }] : [])]} />
          <p className="automation-helper">{haveAgentDetection(usage) ? `${agents.length} installed agents available` : 'Uses the same agent list as your launcher'}</p>
          {agent && <>{modelsLoading || modelCatalog.agent !== agent ? <p className="automation-helper" role="status">Loading agent models…</p> : <AgentLaunchConfigFields command={agent} models={modelCatalog.agent === agent ? modelCatalog.models : []} loading={modelsLoading} model={model} reasoningEffort={effort} onModelChange={setModel} onReasoningChange={setEffort} className="automation-model-fields" reportedOnly compact/>}<button className="automation-refresh-models" type="button" disabled={modelsLoading} onClick={() => setModelRefresh(value => value + 1)}>{modelsLoading ? 'Loading models…' : 'Refresh models'}</button></>}
          {model && !modelsLoading && !modelAvailable && <p className="automation-error">The saved model is unavailable. Choose a reported model or CLI default.</p>}<span className="automation-field-label">Repeat</span><Dropdown ariaLabel="Automation schedule" value={schedule} onChange={value => setSchedule(value as Schedule)} options={schedules}/>
          <div className="automation-time-row"><div><label htmlFor="automation-time">{schedule === 'hourly' ? 'Minute past the hour' : 'Time'}</label>{schedule === 'hourly' ? <input id="automation-time" required type="number" min={0} max={59} value={Number(time.slice(3))} onChange={e => setTime(`09:${e.target.value.padStart(2, '0')}`)}/> : <input id="automation-time" required type="time" value={time} onChange={e => setTime(e.target.value)}/>}</div>{schedule === 'weekly' && <div><span className="automation-field-label">Day</span><Dropdown ariaLabel="Automation weekday" value={String(day)} onChange={value => setDay(Number(value))} options={weekdays.map((label, i) => ({ value: String(i), label }))}/></div>}</div>
          <div className="automation-next"><Clock size={15}/><div><span>Next run</span><strong>{next || 'Choose a time'}</strong><small>{timezone}</small></div></div>
        </aside></div>
        {!local && <p className="automation-error">Open a local project to create an automation.</p>}
        <footer className="automation-editor-footer"><span>Runs while this project is active.</span><button type="button" onClick={reset}>Cancel</button><button className="automation-primary" type="submit" disabled={!local || !agentAvailable || (Boolean(model) && (modelsLoading || !modelAvailable))}>{editing ? 'Save changes' : 'Create automation'}</button></footer>
      </form> : tab === 'saved' ? <>
        {!automations.length ? <div className="automation-empty"><div className="automation-empty-icon"><Clock size={30}/></div><h3>A little less on your to-do list</h3><p>Schedule reviews, daily summaries, or routine checks.<br/>Pick an agent, give it instructions, and choose when.</p><button className="automation-primary" onClick={newAutomation}>+ Create your first automation</button><div className="automation-templates"><span>Or start from a template</span><div className="automation-template-grid">{templates.map(t => <button key={t.id} type="button" className="automation-template" onClick={() => startFromTemplate(t)}><strong>{t.name}</strong><small>{t.blurb}</small></button>)}</div></div></div> : <div className="automation-list">{automations.map(a => <article className="automation-item" key={a.id}><div className="automation-item-icon"><AgentBrandMark command={a.agent} name={agents.find(p => p.command === a.agent)?.name ?? a.agent}/></div><div className="automation-item-content"><div className="automation-item-title"><strong>{a.name}</strong><span className={`automation-status ${a.enabled ? 'enabled' : ''}`}>{a.enabled ? 'Active' : 'Paused'}</span></div><p>{scheduleLabel(a)} <span>· {agents.find(p => p.command === a.agent)?.name ?? a.agent}</span></p><small title={a.root}>{a.enabled ? `Next ${new Date(a.nextRunAt).toLocaleString()}` : 'Schedule paused'} · {a.root.split(/[\\/]/).pop()}</small><div className="automation-item-actions"><button onClick={() => edit(a)}>Edit</button><button onClick={() => action(() => toggleAutomation(a.id))}>{a.enabled ? 'Pause' : 'Resume'}</button><button disabled={!local || a.projectId !== project?.id || a.root !== project?.root_path} onClick={() => action(() => runAutomation(a.id))}>Run now</button>{pendingDelete === a.id ? <><span>Delete this automation?</span><button className="automation-danger" onClick={() => action(() => { removeAutomation(a.id); setPendingDelete(null); })}>Delete</button><button onClick={() => setPendingDelete(null)}>Keep</button></> : <button className="automation-delete" onClick={() => setPendingDelete(a.id)}>Delete</button>}</div></div></article>)}</div>}
      </> : <section className="automation-history">
        {!runs.length ? <div className="automation-empty"><div className="automation-empty-icon"><Clock size={30}/></div><h3>Every run, in one place</h3><p>Results, approval requests, and run details<br/>will appear here once an automation starts.</p></div> : runs.map(run => <article key={run.id} className="automation-run"><span className={`automation-run-dot ${run.status}`}/><div><strong>{run.name}</strong><p>{new Date(run.startedAt).toLocaleString()} · {run.status === 'quiet' ? 'Went quiet' : run.status.replace(/_/g, ' ')}</p>{run.detail && <small>{run.detail}</small>}</div>{run.sessionId !== undefined && <button onClick={() => { setActiveSession(run.sessionId!); requestRoomControl('focus', `agent:${run.sessionId}`); close(); }}>Open session ↗</button>}</article>)}
      </section>}
      </div>
      <div className="automation-bottom"><span className="automation-local-dot"/> Local schedules <details><summary>How scheduling works</summary><p>Spacron must stay open with the saved local project active. Times follow this computer's time zone ({timezone}). Missed runs catch up once within 15 minutes. Agents retain their approval prompts.</p></details></div>
    </div>
  </div>;
}





