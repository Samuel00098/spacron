import { useEffect, useState } from 'react';
import { useStore } from '$lib/react/useStore';
import { loadBoolean } from '$lib/utils/storage';
import { activeRemoteId, remoteTarget } from '$lib/stores/remoteWorkspace';
import { showToast } from '$lib/stores/notification';
import { botHostState, bots, botsOpen, latestRun, openBots, selectedBotId, startBotWatcher, visibleBots } from '$lib/services/bots/bots';
import { BotIcon, NEW_BOT } from './BotsPanel';
import './Bots.css';

/** The Bots list in the sidebar, under Projects: outside every project. */
export default function BotsSidebar() {
  const list = useStore(bots);
  useStore(activeRemoteId);
  useStore(remoteTarget);
  const open = useStore(botsOpen);
  const selected = useStore(selectedBotId);
  const state = useStore(botHostState);
  // The sidebar is always mounted, so it owns the background watcher: run
  // state stays fresh and finished scheduled runs are announced.
  useEffect(() => startBotWatcher((message, tone) => showToast(message, tone, 8000)), []);
  const [collapsed, setCollapsed] = useState(() => loadBoolean('spacron_bots_collapsed'));
  const mine = visibleBots(list).sort((a, b) => a.name.localeCompare(b.name));
  function toggle() {
    setCollapsed((current) => {
      try { localStorage.setItem('spacron_bots_collapsed', String(!current)); } catch { /* Live toggle still works. */ }
      return !current;
    });
  }
  return (
    <section className="bots-sidebar" aria-label="Bots">
      <div className="bots-sidebar-heading">
        <button type="button" className="bots-sidebar-toggle" aria-expanded={!collapsed} aria-controls="bots-sidebar-list" onClick={toggle} title={collapsed ? 'Expand Bots' : 'Collapse Bots'}>
          <svg className={collapsed ? '' : 'expanded'} width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true"><path d="m9 5 7 7-7 7" /></svg><span>Bots</span>
        </button>
        <button type="button" aria-label="New bot" title="New bot" onClick={() => openBots(NEW_BOT)}>
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true"><path d="M12 5v14M5 12h14" /></svg>
        </button>
      </div>
      <div id="bots-sidebar-list" hidden={collapsed}>
        <button type="button" className={`bots-sidebar-row${open && !selected ? ' active' : ''}`} onClick={() => openBots(null)}>
          <BotIcon size={13} /><span>All bots</span>
        </button>
        {mine.map((bot) => {
          const run = latestRun(state, bot);
          const active = open && selected === bot.id;
          return (
            <button key={bot.id} type="button" className={`bots-sidebar-row${active ? ' active' : ''}`} aria-current={active ? 'true' : undefined} onClick={() => openBots(bot.id)} title={bot.name}>
              <span className={`bots-dot ${run?.status === 'running' ? 'running' : bot.enabled && bot.schedule !== 'manual' ? 'scheduled' : 'idle'}`} aria-hidden="true" />
              <span>{bot.name}</span>
            </button>
          );
        })}
      </div>
    </section>
  );
}
