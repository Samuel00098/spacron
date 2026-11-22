import { useState, useSyncExternalStore } from 'react';
import { createPortal } from 'react-dom';
import {
  automationSnapshot, subscribeAutomations, updateAutomationSettings, setAllAutomationsEnabled,
  clearAutomationHistory, toggleAutomation, removeAutomation, loadAutomations,
} from '$lib/services/automations/automations';
import { AutomationDialog, scheduleLabel } from '$lib/components/automations/Automations';
import { getAgentRoster } from '$lib/stores/runs';
import { showToast } from '$lib/stores/notification';
import Dropdown from './Dropdown';
import './AutomationSettingsSection.css';

function key(value: string) { return value.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, ''); }

function Row({ title, detail, children }: { title: string; detail?: string; children: React.ReactNode }) {
  return <div className="settings-control-row" data-settings-key={key(title)}>
    <div className="settings-control-copy"><span>{title}</span>{detail && <small>{detail}</small>}</div>
    <div className="settings-control">{children}</div>
  </div>;
}
function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return <section className="settings-card" data-settings-section={key(title)}><h3>{title}</h3><div className="settings-card-body">{children}</div></section>;
}
function Toggle({ checked, onChange, label }: { checked: boolean; onChange: (v: boolean) => void; label: string }) {
  return <button type="button" className={`settings-toggle${checked ? ' active' : ''}`} onClick={() => onChange(!checked)} aria-label={label} aria-pressed={checked}><span /></button>;
}
function attempt(fn: () => void) { try { fn(); } catch (error) { showToast(String(error), 'error'); } }

const statusLabel: Record<string, string> = {
  starting: 'Starting', running: 'Running', needs_input: 'Needs approval', completed: 'Completed',
  failed: 'Failed', missed: 'Missed', interrupted: 'Interrupted', quiet: 'Went quiet',
};

/** Settings > Automations: global scheduling controls plus every saved automation. */
export default function AutomationSettingsSection() {
  try { loadAutomations(); } catch { /* the Automations dialog reports storage errors */ }
  const { automations, runs, settings } = useSyncExternalStore(subscribeAutomations, automationSnapshot);
  const [dialog, setDialog] = useState(false);
  const [pendingDelete, setPendingDelete] = useState<string | null>(null);
  const agents = getAgentRoster();
  const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  const activeCount = automations.filter(a => a.enabled).length;
  const finishedRuns = runs.filter(r => !['starting', 'running', 'needs_input'].includes(r.status)).length;

  return <div className="automation-settings">
    <Section title="Scheduling">
      <Row title="Run automations on schedule" detail="When off, nothing starts on its own. Run now still works on any automation.">
        <Toggle label="Run automations on schedule" checked={settings.enabled} onChange={enabled => updateAutomationSettings({ enabled })} />
      </Row>
      <Row title="Catch up missed runs" detail="If Spacron was closed or the project wasn't open at the scheduled time, a run can still start this long afterwards.">
        <Dropdown ariaLabel="Catch up missed runs" value={String(settings.catchUpMinutes)} onChange={v => updateAutomationSettings({ catchUpMinutes: Number(v) })}
          options={[{ value: '0', label: 'Never' }, { value: '15', label: 'Within 15 minutes' }, { value: '60', label: 'Within 1 hour' }, { value: '240', label: 'Within 4 hours' }]} />
      </Row>
      <Row title="Time zone" detail="Schedules follow this computer's time zone setting.">
        <span className="automation-settings-value">{timezone}</span>
      </Row>
    </Section>

    <Section title="Results">
      <Row title="Notify when a run finishes" detail="Shows a notice when a run completes, fails or is waiting for your approval.">
        <Toggle label="Notify when a run finishes" checked={settings.notify} onChange={notify => updateAutomationSettings({ notify })} />
      </Row>
      <Row title="Where results go" detail="Each run opens its own agent session named “Automation: …” with the full output. Run history lists every run with its status and an Open session link.">
        <button type="button" className="settings-secondary" onClick={() => setDialog(true)}>Open automations</button>
      </Row>
      <Row title="Keep run history" detail="Older runs are removed once the list is longer than this.">
        <Dropdown ariaLabel="Keep run history" value={String(settings.historyLimit)} onChange={v => updateAutomationSettings({ historyLimit: Number(v) })}
          options={['25', '50', '100', '250'].map(v => ({ value: v, label: `Last ${v} runs` }))} />
      </Row>
      <Row title="Clear run history" detail={`${finishedRuns} finished run${finishedRuns === 1 ? '' : 's'} saved. Runs still in progress are kept.`}>
        <button type="button" className="settings-secondary" disabled={!finishedRuns} onClick={() => attempt(clearAutomationHistory)}>Clear history</button>
      </Row>
    </Section>

    <Section title="All automations">
      <div className="automation-settings-toolbar">
        <span>{automations.length ? `${automations.length} automation${automations.length === 1 ? '' : 's'} · ${activeCount} active` : 'No automations yet'}</span>
        {automations.length > 0 && <button type="button" className="settings-secondary" onClick={() => attempt(() => setAllAutomationsEnabled(activeCount === 0))}>{activeCount === 0 ? 'Resume all' : 'Pause all'}</button>}
        <button type="button" className="settings-secondary" onClick={() => setDialog(true)}>{automations.length ? 'Create or edit' : 'Create automation'}</button>
      </div>
      {automations.map(a => {
        const last = runs.find(r => r.automationId === a.id);
        const agent = agents.find(p => p.command === a.agent)?.name ?? a.agent;
        return <div className="automation-settings-item" key={a.id}>
          <div className="automation-settings-item-copy">
            <strong>{a.name}</strong>
            <small>{scheduleLabel(a)} · {agent} · {a.root.split(/[\\/]/).pop()}</small>
            <small>{!settings.enabled ? 'Scheduling paused' : a.enabled ? `Next ${new Date(a.nextRunAt).toLocaleString()}` : 'Paused'}{last ? ` · Last run: ${statusLabel[last.status] ?? last.status}` : ''}</small>
          </div>
          <div className="automation-settings-item-actions">
            {pendingDelete === a.id ? <>
              <button type="button" className="settings-secondary danger" onClick={() => attempt(() => { removeAutomation(a.id); setPendingDelete(null); })}>Delete</button>
              <button type="button" className="settings-secondary" onClick={() => setPendingDelete(null)}>Keep</button>
            </> : <>
              <Toggle label={`${a.enabled ? 'Pause' : 'Resume'} ${a.name}`} checked={a.enabled} onChange={() => attempt(() => toggleAutomation(a.id))} />
              <button type="button" className="settings-secondary" onClick={() => setPendingDelete(a.id)}>Delete</button>
            </>}
          </div>
        </div>;
      })}
    </Section>
    {dialog && createPortal(<AutomationDialog close={() => setDialog(false)} />, document.body)}
  </div>;
}
