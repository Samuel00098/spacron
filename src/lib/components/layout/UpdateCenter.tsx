import { useEffect, useRef, useState } from 'react';
import { useStore } from '$lib/react/useStore';
import { useUpdaterStore } from '$lib/stores/zustand/updater';
import { agentUpdates, checkAgentUpdates, installAgentUpdate } from '$lib/stores/agentUpdates';
import { usageState } from '$lib/stores/usage';
import { openChangelogPage } from '$lib/services/changelog';
import { changelogSection, releaseHighlights } from '$lib/services/release-notes';
import { showToast } from '$lib/stores/notification';
import './UpdateCenter.css';

const HOVER_OPEN_MS = 150;
/** Long enough to cross the gap between the icon and the card. */
const HOVER_CLOSE_MS = 250;

/**
 * The title bar's update icon: a dot when Spacron or an agent CLI has a newer
 * version, a card on hover with what changed and one-click updates, and a
 * click that checks again.
 */
export default function UpdateCenter() {
  const update = useUpdaterStore((s) => s.pendingUpdate);
  const appChecking = useUpdaterStore((s) => s.updateChecking);
  const downloading = useUpdaterStore((s) => s.updateDownloading);
  const progress = useUpdaterStore((s) => s.updateProgress);
  const agents = useStore(agentUpdates);
  const usage = useStore(usageState);

  const [open, setOpen] = useState(false);
  // A click keeps the card up; hovering alone lets it close on leave.
  const [pinned, setPinned] = useState(false);
  const [checkFailed, setCheckFailed] = useState(false);
  const [installed, setInstalled] = useState<{ version: string; notes: string | null } | null>(null);
  const rootRef = useRef<HTMLDivElement | null>(null);
  const hoverTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const outdated = Object.values(agents.byCommand).filter((a) => a.updateAvailable);
  const checking = appChecking || agents.checking;
  const available = Boolean(update) || outdated.length > 0;
  const nameOf = (command: string) => usage.detected.find((d) => d.command === command)?.name || command;

  function clearHoverTimer() {
    if (hoverTimer.current) clearTimeout(hoverTimer.current);
    hoverTimer.current = null;
  }

  function close() {
    clearHoverTimer();
    setOpen(false);
    setPinned(false);
  }

  useEffect(() => clearHoverTimer, []);

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: PointerEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) close();
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') close();
    };
    window.addEventListener('pointerdown', onPointerDown, true);
    window.addEventListener('keydown', onKeyDown);
    return () => {
      window.removeEventListener('pointerdown', onPointerDown, true);
      window.removeEventListener('keydown', onKeyDown);
    };
  }, [open]);

  // What the installed version brought, for when there is nothing newer.
  useEffect(() => {
    if (!open || installed) return;
    let cancelled = false;
    void (async () => {
      try {
        const { getVersion } = await import('@tauri-apps/api/app');
        const version = await getVersion();
        const changelog = (await import('../../../../CHANGELOG.md?raw')).default;
        if (!cancelled) setInstalled({ version, notes: changelogSection(changelog, version) });
      } catch (error) {
        console.warn('[updates] could not read the installed version', error);
      }
    })();
    return () => { cancelled = true; };
  }, [open, installed]);

  async function checkNow() {
    setCheckFailed(false);
    await Promise.all([
      useUpdaterStore.getState().checkForUpdate().catch(() => setCheckFailed(true)),
      checkAgentUpdates(true),
    ]);
  }

  async function updateAll() {
    // One at a time: they install into the same npm prefix.
    for (const agent of outdated) await installAgentUpdate(agent.command);
  }

  async function viewChangelog() {
    try {
      await openChangelogPage(update?.version ?? installed?.version);
      close();
    } catch (error) {
      console.error('Failed to open changelog:', error);
      showToast('Could not open the changelog', 'error');
    }
  }

  const highlights = releaseHighlights(update ? update.body : installed?.notes);
  const title = downloading
    ? 'Downloading update…'
    : checking
      ? 'Checking for updates…'
      : update
        ? 'Update ready to download'
        : outdated.length
          ? outdated.length === 1 ? '1 agent update' : `${outdated.length} agent updates`
          : checkFailed ? "Couldn't check for updates" : "You're up to date";
  const subtitle = update
    ? `Spacron ${update.version}`
    : installed ? `Spacron ${installed.version}` : 'Spacron';
  const label = checking
    ? 'Checking for updates'
    : available ? 'Updates available. Click to check again' : 'Check for updates';

  return (
    <div
      className="update-center"
      ref={rootRef}
      onPointerEnter={() => {
        clearHoverTimer();
        hoverTimer.current = setTimeout(() => setOpen(true), HOVER_OPEN_MS);
      }}
      onPointerLeave={() => {
        clearHoverTimer();
        if (!pinned) hoverTimer.current = setTimeout(() => setOpen(false), HOVER_CLOSE_MS);
      }}
    >
      <button
        type="button"
        className={`icon-btn update-center-btn${open ? ' active' : ''}`}
        onClick={() => {
          clearHoverTimer();
          setOpen(true);
          setPinned(true);
          if (!checking && !downloading) void checkNow();
        }}
        aria-label={label}
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-busy={checking}
      >
        {checking || downloading ? (
          <svg className="update-center-spin" width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" aria-hidden="true">
            <path d="M21 12a9 9 0 1 1-6.2-8.56" />
          </svg>
        ) : (
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <path d="M12 4v10" />
            <polyline points="7.5 10 12 14.5 16.5 10" />
            <path d="M4 16v2a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-2" />
          </svg>
        )}
        {available && !checking && <span className="update-center-dot" aria-hidden="true" />}
      </button>

      {open && (
        <div className="update-center-popover" role="dialog" aria-label="Updates">
          <div className="update-center-head">
            <div className="update-center-title" role="status">{title}</div>
            <div className="update-center-sub">{subtitle}</div>
          </div>

          <div className="update-center-scroll">
            {highlights.items.length > 0 && (
              <>
                {!update && <div className="update-center-section">In this version</div>}
                <ul className="update-center-notes">
                  {highlights.items.map((item, i) => (
                    <li key={i}>
                      {item.title && <span className="update-center-lead">{item.title}. </span>}
                      <span className="update-center-text">{item.text}</span>
                    </li>
                  ))}
                </ul>
                {highlights.more > 0 && <div className="update-center-more">Plus {highlights.more} more {highlights.more === 1 ? 'change' : 'changes'}.</div>}
              </>
            )}
            {update && highlights.items.length === 0 && (
              <div className="update-center-more">No notes came with this release.</div>
            )}
          </div>

          {update && (
            downloading ? (
              <div className="update-center-progress">
                <div className="update-center-track"><div style={{ width: `${progress}%` }} /></div>
                <span>{progress}%</span>
              </div>
            ) : (
              <button
                type="button"
                className="update-center-primary"
                onClick={() => void useUpdaterStore.getState().installUpdate()}
              >
                Install &amp; Restart
              </button>
            )
          )}

          {outdated.length > 0 && (
            <div className="update-center-agents">
              <div className="update-center-agents-head">
                <span className="update-center-section">Agents</span>
                {outdated.length > 1 && (
                  <button type="button" className="update-center-action" disabled={agents.updating.length > 0} onClick={() => void updateAll()}>
                    Update all
                  </button>
                )}
              </div>
              {outdated.map((agent) => {
                const busy = agents.updating.includes(agent.command);
                return (
                  <div className="update-center-agent" key={agent.command}>
                    <span className="update-center-agent-name">{nameOf(agent.command)}</span>
                    <span className="update-center-agent-version">{agent.installed} → {agent.latest}</span>
                    <button
                      type="button"
                      className="update-center-action"
                      disabled={busy}
                      aria-label={`Update ${nameOf(agent.command)}`}
                      onClick={() => void installAgentUpdate(agent.command)}
                    >
                      {busy ? 'Updating…' : 'Update'}
                    </button>
                  </div>
                );
              })}
            </div>
          )}

          <div className="update-center-foot">
            <button type="button" className="update-center-link" onClick={() => void viewChangelog()}>
              Full changelog
            </button>
            <span>{checkFailed && available ? "Couldn't check Spacron just now" : 'Click the icon to check again'}</span>
          </div>
        </div>
      )}
    </div>
  );
}
