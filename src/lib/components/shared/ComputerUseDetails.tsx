import { useCallback, useEffect, useState } from 'react';
import { useStore } from '$lib/react/useStore';
import { computerUseBlockedApps } from '$lib/stores/settings';
import {
  fetchDesktopActivity,
  fetchDesktopGrants,
  revokeDesktopGrant,
  type DesktopActivityEntry,
  type DesktopGrant,
} from '$lib/stores/computerUse';

/**
 * Settings → Agents → Computer use, below the switch: the apps agents may
 * never touch, the permissions currently granted (with Revoke), and what
 * agents recently did. Rendered only while computer use is on.
 *
 * Grants and activity live in Rust memory and change while this is open, so
 * they are polled every few seconds rather than read once.
 */
const REFRESH_MS = 3000;
const SHOWN_ACTIVITY = 20;

const KIND_LABEL: Record<DesktopGrant['kind'], string> = {
  window_list: 'can see the window list',
  window: 'can see',
  control: 'can control',
};

function formatTime(ms: number): string {
  return new Date(ms).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

export default function ComputerUseDetails() {
  const blocked = useStore(computerUseBlockedApps);
  const [blockedText, setBlockedText] = useState(() => (Array.isArray(blocked) ? blocked.join('\n') : ''));
  const [grants, setGrants] = useState<DesktopGrant[]>([]);
  const [activity, setActivity] = useState<DesktopActivityEntry[]>([]);
  const [logPath, setLogPath] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    const [g, a] = await Promise.all([fetchDesktopGrants(), fetchDesktopActivity()]);
    setGrants(g);
    setActivity(a.entries.slice(0, SHOWN_ACTIVITY));
    setLogPath(a.logPath);
  }, []);

  useEffect(() => {
    void refresh();
    const timer = window.setInterval(() => void refresh(), REFRESH_MS);
    return () => window.clearInterval(timer);
  }, [refresh]);

  const saveBlocked = () => {
    const apps = blockedText
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean);
    computerUseBlockedApps.set(apps);
  };

  // One row per caller, listing what it holds, so Revoke is unambiguous.
  const byCaller = new Map<string, DesktopGrant[]>();
  for (const g of grants) byCaller.set(g.caller, [...(byCaller.get(g.caller) ?? []), g]);

  return (
    <>
      <div style={{ marginTop: '14px' }}>
        <div className="agent-add-title">Never show these apps to agents</div>
        <small className="shell-hint">
          One program per line, e.g. <code>slack.exe</code>. Password managers, Windows security
          prompts and Spacron itself are always hidden.
        </small>
        <textarea
          className="agent-input mcp-textarea"
          placeholder={'slack.exe\noutlook.exe'}
          value={blockedText}
          onChange={(e) => setBlockedText(e.target.value)}
          onBlur={saveBlocked}
          aria-label="Apps hidden from agents"
          style={{ marginTop: '8px' }}
        />
      </div>

      <div style={{ marginTop: '14px' }}>
        <div className="agent-add-title">Current permissions</div>
        {byCaller.size === 0 ? (
          <small className="shell-hint">No agent has any permission right now.</small>
        ) : (
          <div className="agent-list">
            {[...byCaller.entries()].map(([caller, list]) => (
              <div className="agent-row" key={caller}>
                <div className="agent-meta">
                  <div className="agent-name-row">
                    <span className="agent-name">{list[0].agent}</span>
                  </div>
                  <small className="shell-hint">
                    {list.map((g) => `${KIND_LABEL[g.kind]} ${g.kind === 'window_list' ? '' : g.target}`.trim()).join(' · ')}
                  </small>
                </div>
                <button
                  type="button"
                  className="agent-remove"
                  onClick={() => void revokeDesktopGrant(caller).then(refresh)}
                  aria-label={`Withdraw every permission ${list[0].agent} holds`}
                  title="Withdraw"
                >
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><path d="M18 6 6 18M6 6l12 12" /></svg>
                </button>
              </div>
            ))}
          </div>
        )}
      </div>

      <div style={{ marginTop: '14px' }}>
        <div className="agent-add-title">Recent actions</div>
        {activity.length === 0 ? (
          <small className="shell-hint">No agent has clicked or typed anything yet.</small>
        ) : (
          <div className="agent-list">
            {activity.map((a, i) => (
              <div className="agent-row" key={`${a.atMs}-${i}`}>
                <div className="agent-meta">
                  <div className="agent-name-row">
                    <span className="agent-name">
                      {a.ok ? '' : '✕ '}
                      {a.agent} · {a.window}
                    </span>
                  </div>
                  <small className="shell-hint">
                    {formatTime(a.atMs)} · {a.detail}
                  </small>
                </div>
              </div>
            ))}
          </div>
        )}
        {logPath ? (
          <small className="shell-hint" style={{ display: 'block', marginTop: '8px' }}>
            Full log: <code>{logPath}</code>
          </small>
        ) : null}
      </div>
    </>
  );
}
