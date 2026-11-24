import { useEffect, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { useStore } from '$lib/react/useStore';
import { activeConnection, activeRemoteId } from '$lib/stores/remoteWorkspace';
import { mcpServers } from '$lib/stores/settings';
import { showToast } from '$lib/stores/notification';
import { enabledServers, type McpServer } from '$lib/services/mcp-servers';
import { boxMcpInfo, refreshBoxMcpInfo, setSharedSignIns, sharedSignIns } from '$lib/services/box-signins';
import { botSettings, bots, closeBots, openBots, syncBots, updateBotSettings, LOCAL_HOST, type BotAccess } from '$lib/services/bots/bots';
import {
  botChatAppearance,
  botChatSuggestedPrompts,
  botChatTimestamps,
  botChatVisuals,
} from '$lib/stores/botChatSettings';
import { ChatAppearanceRows } from './ChatSettingsPane';
import Dropdown from './Dropdown';
import { ABOUT_YOU_MAX, aboutYou } from '$lib/stores/aboutYou';
import './ChatSettingsPane.css';
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
  const appearance = useStore(botChatAppearance);
  const visuals = useStore(botChatVisuals);
  const timestamps = useStore(botChatTimestamps);
  const starters = useStore(botChatSuggestedPrompts);
  return <div className="automation-settings">
    <AboutYouSection />

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

    <Section title="Chat">
      <ChatAppearanceRows appearance={appearance} onChange={botChatAppearance.set} showMatchTerminal={false} />
      <Row title="Interactive visuals" detail="Let bots answer with charts, tables and small tools shown inline, which you can use and send back to the bot. Only bots that can work in their folder (or have full access) can make them.">
        <Toggle label="Interactive visuals in bot chats" checked={visuals} onChange={(on) => { botChatVisuals.set(on); void syncBots().catch(() => {}); }} />
      </Row>
      <Row title="Message times" detail="Show when each reply was sent.">
        <Toggle label="Show times in bot chats" checked={timestamps} onChange={botChatTimestamps.set} />
      </Row>
      <Row title="Starter prompts" detail="Suggest things to ask in an empty bot chat.">
        <Toggle label="Starter prompts in bot chats" checked={starters} onChange={botChatSuggestedPrompts.set} />
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
 * Settings > Bots > About you: a few lines the user writes about themselves, read
 * by every bot run, the agents Spacron starts and the in-app assistant (see stores/aboutYou.ts).
 */
function AboutYouSection() {
  const saved = useStore(aboutYou);
  const [draft, setDraft] = useState(saved);
  useEffect(() => setDraft(saved), [saved]);
  const changed = draft !== saved;
  function save() {
    const next = draft.slice(0, ABOUT_YOU_MAX);
    aboutYou.set(next);
    // Scheduled runs read it from the runner, so it has to reach every host now.
    void syncBots().catch(() => {});
    showToast(next.trim()
      ? 'About you saved. Your bots, the agents Spacron starts and its assistant will use it. Agents already running get it next time they start.'
      : 'About you cleared. Bots, agents and the assistant no longer get it.', 'success', 6000);
  }
  return <Section title="About you">
    <p className="shell-hint" style={{ marginTop: 0, marginBottom: '10px' }}>
      Tell Spacron who you are, so it can work well with you: your name, what you do, what you are building and how you like answers.
    </p>
    <div className="about-you-shared" role="note">
      <strong>Not only for bots.</strong> Whatever you write here is read by:
      <ul>
        <li><b>Your bots</b>, with every run (bots on your box too)</li>
        <li><b>The agents Spacron starts</b>, terminal and chat, from a private file on this computer. Agents already running get it the next time they start.</li>
        <li><b>Spacron's assistant</b>, on every message</li>
      </ul>
      It stays on this computer and is never written into your projects.
    </div>
    <textarea
      className="agent-input"
      aria-label="About you"
      placeholder={'For example:\nI am Alex, I run a small online shop and I am learning to code.\nKeep answers short and practical, and explain jargon.\nI work in Central European Time.'}
      value={draft}
      maxLength={ABOUT_YOU_MAX}
      rows={6}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={() => { if (changed) save(); }}
      style={{ width: '100%', minHeight: '120px', resize: 'vertical', fontFamily: 'inherit', lineHeight: 1.5, boxSizing: 'border-box' }}
    />
    <div className="settings-action-row">
      <button type="button" className="settings-primary" disabled={!changed} onClick={save}>Save</button>
      <small className="shell-hint">{draft.length} / {ABOUT_YOU_MAX}</small>
    </div>
  </Section>;
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
