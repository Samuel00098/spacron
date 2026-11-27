import { useEffect, useRef, useState } from 'react';
import { useStore } from '$lib/react/useStore';
import { useUpdaterStore } from '$lib/stores/zustand/updater';
import { agentUpdates, checkAgentUpdates, installAgentUpdate } from '$lib/stores/agentUpdates';
import { usageState } from '$lib/stores/usage';
import { openChangelogPage } from '$lib/services/changelog';
import { releaseHighlights } from '$lib/services/release-notes';
import { showToast } from '$lib/stores/notification';
import './UpdateCenter.css';

const HOVER_OPEN_MS = 150;
/** Long enough to cross the gap between the icon and the card. */
const HOVER_CLOSE_MS = 250;

/**
 * The title bar's update icon. With nothing newer it is a wheel that checks
 * again on click. With an update it is a download arrow with a dot: a click
 * installs the agent updates. Spacron itself restarts to update, so that one
 * waits for the card's Install button.
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
  const [version, setVersion] = useState<string | null>(null);
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

  useEffect(() => {
    if (!open || version) return;
    let cancelled = false;
    void import('@tauri-apps/api/app')
      .then(({ getVersion }) => getVersion())
      .then((current) => { if (!cancelled) setVersion(current); })
      .catch((error) => console.warn('[updates] could not read the installed version', error));
    return () => { cancelled = true; };
  }, [open, version]);

  async function checkNow() {
    setCheckFailed(false);
    await Promise.all([
      useUpdaterStore.getState().checkForUpdate().catch(() => setCheckFailed(true)),
      checkAgentUpdates(true),
    ]);
  }

  async function updateAll() {
    if (agents.updating.length > 0) return;
    // One at a time: they install into the same npm prefix.
    for (const agent of outdated) await installAgentUpdate(agent.command);
  }

  async function viewChangelog() {
    try {
      await openChangelogPage(update?.version);
      close();
    } catch (error) {
      console.error('Failed to open changelog:', error);
      showToast('Could not open the changelog', 'error');
    }
  }

  const updatingAgents = agents.updating.length > 0;
  const busy = checking || downloading || updatingAgents;
  // Only an update that is still to come has notes worth reading.
  const highlights = releaseHighlights(update?.body);
  const title = downloading
    ? 'Downloading update…'
    : updatingAgents
      ? 'Updating agents…'
      : checking
        ? 'Checking for updates…'
        : update
          ? 'Update ready to download'
          : outdated.length
            ? outdated.length === 1 ? '1 agent update' : `${outdated.length} agent updates`
            : checkFailed ? "Couldn't check for updates" : "You're up to date";
  const subtitle = update
    ? `Spacron ${update.version}`
    : version ? `Spacron ${version}` : 'Spacron';
  const label = busy
    ? title
    : outdated.length
      ? 'Update agents'
      : update ? 'Spacron update ready' : 'Check for updates';
  const hint = outdated.length
    ? 'Click the icon to update agents'
    : update ? '' : 'Click the icon to check again';

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
          if (busy) return;
          if (outdated.length) void updateAll();
          else if (!update) void checkNow();
        }}
        aria-label={label}
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-busy={busy}
      >
        {busy ? (
          <svg className="update-center-spin" width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" aria-hidden="true">
            <path d="M21 12a9 9 0 1 1-6.2-8.56" />
          </svg>
        ) : available ? (
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <path d="M12 4v10" />
            <polyline points="7.5 10 12 14.5 16.5 10" />
            <path d="M4 16v2a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-2" />
          </svg>
        ) : (
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <path d="M20 11a8 8 0 0 0-14.3-4L4 9" />
            <path d="M4 4v5h5" />
            <path d="M4 13a8 8 0 0 0 14.3 4L20 15" />
            <path d="M20 20v-5h-5" />
          </svg>
        )}
        {available && !busy && <span className="update-center-dot" aria-hidden="true" />}
      </button>

      {open && (
        <div className="update-center-popover" role="dialog" aria-label="Updates">
          <div className="update-center-head">
            <div className="update-center-title" role="status">{title}</div>
            <div className="update-center-sub">{subtitle}</div>
          </div>

          {update && (
            <div className="update-center-scroll">
              {highlights.items.length > 0 ? (
                <>
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
              ) : (
                <div className="update-center-more">No notes came with this release.</div>
              )}
            </div>
          )}

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
            {update && (
              <button type="button" className="update-center-link" onClick={() => void viewChangelog()}>
                Full changelog
              </button>
            )}
            <span>{checkFailed && available ? "Couldn't check Spacron just now" : hint}</span>
          </div>
        </div>
      )}
    </div>
  );
}
