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
import './SettingsDetailRows.css';

/**
 * Settings → Agents → Computer use, below the switch: the apps agents may
 * never touch, the permissions currently granted (with Withdraw), and what
 * agents recently did. Rendered only while computer use is on.
 *
 * Each part is a standard settings row (title and explanation on the left,
 * the control on the right), so it lines up with the switch above it.
 *
 * Grants and activity live in Rust memory and change while this is open, so
 * they are polled every few seconds rather than read once.
 */
const REFRESH_MS = 3000;
const SHOWN_ACTIVITY = 20;

const KIND_LABEL: Record<DesktopGrant['kind'], string> = {
  window_list: 'Can see the list of open windows',
  window: 'Can see',
  control: 'Can control',
};

function formatTime(ms: number): string {
  return new Date(ms).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

function Row({ title, detail, children }: { title: string; detail: React.ReactNode; children: React.ReactNode }) {
  return (
    <div className="settings-control-row">
      <div className="settings-control-copy">
        <span>{title}</span>
        <small>{detail}</small>
      </div>
      <div className="settings-control settings-detail-control">{children}</div>
    </div>
  );
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

  // One entry per agent, listing what it holds, so Withdraw is unambiguous.
  const byCaller = new Map<string, DesktopGrant[]>();
  for (const g of grants) byCaller.set(g.caller, [...(byCaller.get(g.caller) ?? []), g]);

  return (
    <>
      <Row
        title="Hidden apps"
        detail="Applications hidden from agents (one per line, e.g. slack.exe)."
      >
        <textarea
          className="agent-input"
          placeholder={'slack.exe\noutlook.exe'}
          value={blockedText}
          onChange={(e) => setBlockedText(e.target.value)}
          onBlur={saveBlocked}
          aria-label="Apps hidden from agents"
          spellCheck={false}
        />
      </Row>

      <Row
        title="Current permissions"
        detail="Active window access permissions granted to agents."
      >
        {byCaller.size === 0 ? (
          <span className="settings-detail-empty">No agent has any permission right now.</span>
        ) : (
          <div className="settings-detail-list">
            {[...byCaller.entries()].map(([caller, list]) => (
              <div className="settings-detail-item" key={caller}>
                <div className="settings-detail-item-text">
                  <span className="settings-detail-item-title">{list[0].agent}</span>
                  <span className="settings-detail-item-sub">
                    {list.map((g) => (g.kind === 'window_list' ? KIND_LABEL[g.kind] : `${KIND_LABEL[g.kind]} ${g.target}`)).join(' · ')}
                  </span>
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
      </Row>

      <Row
        title="Recent actions"
        detail={`Recent desktop interactions (last ${SHOWN_ACTIVITY} actions).`}
      >
        {activity.length === 0 ? (
          <span className="settings-detail-empty">No agent has clicked or typed anything yet.</span>
        ) : (
          <div className="settings-detail-list">
            {activity.map((a, i) => (
              <div className={`settings-detail-item${a.ok ? '' : ' is-refused'}`} key={`${a.atMs}-${i}`}>
                <div className="settings-detail-item-text">
                  <span className="settings-detail-item-title">
                    {a.ok ? '' : 'Refused · '}
                    {a.agent} · {a.window}
                  </span>
                  <span className="settings-detail-item-sub">
                    {formatTime(a.atMs)} · {a.detail}
                  </span>
                </div>
              </div>
            ))}
          </div>
        )}
      </Row>
    </>
  );
}
