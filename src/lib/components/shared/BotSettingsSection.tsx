import { useEffect, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { useStore } from '$lib/react/useStore';
import { activeConnection, activeRemoteId } from '$lib/stores/remoteWorkspace';
import { mcpServers } from '$lib/stores/settings';
import { showToast } from '$lib/stores/notification';
import { enabledServers, type McpServer } from '$lib/services/mcp-servers';
import { boxMcpInfo, refreshBoxMcpInfo, setSharedSignIns, sharedSignIns } from '$lib/services/box-signins';
import { botSettings, bots, closeBots, openBots, syncBots, updateBotSettings, LOCAL_HOST, type BotAccess } from '$lib/services/bots/bots';
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

export const ACCESS_OPTIONS: { value: BotAccess; label: string; detail: string }[] = [
  { value: 'research', label: 'Read and research', detail: 'Reads, searches the web and uses connectors. Never writes files; the result is in the run output.' },
  { value: 'folder', label: 'Work in its folder', detail: 'Also creates and edits files, inside its own home folder only.' },
  { value: 'full', label: 'Full access', detail: 'Everything, including running commands, with no approvals. Only for jobs you trust.' },
];

/** Settings > Bots: how bots run, wherever they live. */
export default function BotSettingsSection({ onOpenBots }: { onOpenBots?: () => void }) {
  const settings = useStore(botSettings);
  const list = useStore(bots);
  const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  const local = list.filter((b) => b.boxId === LOCAL_HOST).length;
  return <div className="automation-settings">
    <Section title="Scheduling">
      <Row title="Run bots on schedule" detail="When off, no bot starts on its own, on this PC or on a box. Run now still works.">
        <Toggle label="Run bots on schedule" checked={settings.enabled} onChange={(enabled) => updateBotSettings({ enabled })} />
      </Row>
      <Row title="Catch up missed runs" detail="If a scheduled time passed while the computer couldn't run it, the run can still start this long afterwards.">
        <Dropdown ariaLabel="Catch up missed bot runs" value={String(settings.catchUpMinutes)} onChange={(v) => updateBotSettings({ catchUpMinutes: Number(v) })}
          options={[{ value: '0', label: 'Never' }, { value: '15', label: 'Within 15 minutes' }, { value: '60', label: 'Within 1 hour' }, { value: '240', label: 'Within 4 hours' }]} />
      </Row>
      <Row title="Stop a run after" detail="A run still going after this long is stopped, so a stuck bot can't burn through your usage.">
        <Dropdown ariaLabel="Stop a bot run after" value={String(settings.maxRunMinutes)} onChange={(v) => updateBotSettings({ maxRunMinutes: Number(v) })}
          options={[{ value: '10', label: '10 minutes' }, { value: '30', label: '30 minutes' }, { value: '60', label: '1 hour' }, { value: '120', label: '2 hours' }, { value: '240', label: '4 hours' }]} />
      </Row>
      <Row title="Time zone" detail="Schedules follow this computer's time zone, also for bots on a box.">
        <span className="automation-settings-value">{timezone}</span>
      </Row>
    </Section>

    <Section title="Permissions and tools">
      <Row title="New bots start with" detail={ACCESS_OPTIONS.find((o) => o.value === settings.defaultAccess)?.detail}>
        <Dropdown ariaLabel="Default bot access" value={settings.defaultAccess} onChange={(v) => updateBotSettings({ defaultAccess: v as BotAccess })}
          options={ACCESS_OPTIONS.map((o) => ({ value: o.value, label: o.label }))} />
      </Row>
      <Row title="Spacron tools for bots on this PC" detail="Gives bots on this PC Spacron's own MCP server (spacron-mcp) next to your connectors. Bots on a box don't get it: it's served by this app, which isn't there while the laptop is closed.">
        <Toggle label="Spacron tools for bots on this PC" checked={settings.spacronTools} onChange={(spacronTools) => updateBotSettings({ spacronTools })} />
      </Row>
      <Row title="Connectors" detail="Bots use the MCP servers from Settings > MCP & plugins. On a box, connectors you signed in to through Spacron are left out, because their sign-in lives in this app.">
        <span className="automation-settings-value">Per bot</span>
      </Row>
    </Section>

    <BoxSignInsSection />

    <Section title="Results">
      <Row title="Notify when a run finishes" detail="Shows a notice while Spacron is open. Desktop and spoken alerts follow your notification and Read aloud settings.">
        <Toggle label="Notify when a bot run finishes" checked={settings.notify} onChange={(notify) => updateBotSettings({ notify })} />
      </Row>
      <Row title="Your bots" detail={`${list.length} bot${list.length === 1 ? '' : 's'} · ${local} on this PC · ${list.length - local} on boxes`}>
        <button type="button" className="settings-secondary" onClick={() => { closeBots(); openBots(null); onOpenBots?.(); }}>Open Bots</button>
      </Row>
    </Section>
  </div>;
}

/**
 * Settings > Bots > Sign-ins on your box: share a connector's sign-in with the
 * connected box, so bots and agents there can use it with the laptop closed.
 */
function BoxSignInsSection() {
  const box = useStore(activeConnection);
  const boxId = useStore(activeRemoteId);
  const servers = useStore(mcpServers) as McpServer[];
  const shared = useStore(sharedSignIns);
  const info = useStore(boxMcpInfo);
  const [signedIn, setSignedIn] = useState<Record<string, boolean>>({});
  const [busy, setBusy] = useState(false);
  const signIns = enabledServers(servers ?? []).filter(({ server }) => server.oauth);
  const keysKey = signIns.map((s) => s.key).join(',');
  useEffect(() => {
    if (!signIns.length) return;
    void invoke<Record<string, boolean>>('mcp_oauth_status', { keys: signIns.map((s) => s.key) }).then(setSignedIn).catch(() => setSignedIn({}));
  }, [keysKey]);
  useEffect(() => { if (boxId) void refreshBoxMcpInfo(); }, [boxId]);
  const mine = boxId ? shared[boxId] ?? [] : [];
  async function toggle(key: string, on: boolean) {
    setBusy(true);
    try {
      await setSharedSignIns(on ? [...mine, key] : mine.filter((k) => k !== key));
      await syncBots();
      showToast(on ? `Shared with ${box?.name}. Bots and agents there can use it with the laptop closed.` : `Removed from ${box?.name}.`, 'success');
    } catch (e) { showToast(e instanceof Error ? e.message : String(e), 'error'); } finally { setBusy(false); }
  }
  return <Section title="Sign-ins on your box">
    <Row title="How it works" detail="Connectors you signed in to through Spacron (Gmail, Google Drive, Notion and more) live on this computer. While you're connected, agents on your box borrow them. Share one with the box to keep it working there with the laptop closed. This copies that account's sign-in to your box; remove it here at any time.">
      <span className="automation-settings-value">{box ? box.name : 'No box connected'}</span>
    </Row>
    {!box ? <Row title="Connect a box" detail="Connect to your box from the Remote workspace menu to choose what to share."><span /></Row>
      : info === null ? <Row title="Update the box server" detail="This box's server is too old to keep sign-ins. Redeploy it from the remote setup wizard."><span /></Row>
      : !signIns.length ? <Row title="No signed-in connectors" detail="Add one from Settings > MCP & plugins and sign in first."><span /></Row>
      : signIns.map(({ key, server }) => {
        const ready = signedIn[key] === true;
        const on = mine.includes(key) && (info?.shared ?? []).includes(key);
        return <Row key={key} title={server.name} detail={!ready ? 'Sign in on this computer first (Settings > MCP & plugins).' : on ? `Works on ${box.name} with the laptop closed.` : 'Only while this laptop is connected.'}>
          <Toggle label={`Share ${server.name} with ${box.name}`} checked={on} onChange={(v) => { if (!busy && (ready || !v)) void toggle(key, v); }} />
        </Row>;
      })}
  </Section>;
}
