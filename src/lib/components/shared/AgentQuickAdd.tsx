import { useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties } from 'react';
import { createPortal } from 'react-dom';
import { useStore } from '$lib/react/useStore';
import { activeProject } from '$lib/stores/workspace';
import { customAgents, removedPresetAgents } from '$lib/stores/customAgents';
import { getPresetRuns, filterInstalledAgents } from '$lib/stores/runs';
import { usageState, installedAgentCommands, haveAgentDetection } from '$lib/stores/usage';
import { agentUpdates } from '$lib/stores/agentUpdates';
import { openAgentSpawn } from '$lib/stores/layout';
import { quickSpawnAgent } from '$lib/services/quick-spawn';
import { AgentBrandMark } from './useAgentBrand';
import './Dropdown.css';
import './AgentQuickAdd.css';

// The "+" on an agent pane's header: a short menu of the installed agents,
// one click to start another in the main repo. "More options…" opens the full Spawn Agents
// picker for counts, models and placement. Uses the shared Dropdown's menu
// styles so it reads as the same kind of menu; it is not a Dropdown itself
// because that is a select with a value.

const GAP = 6;
const EDGE_MARGIN = 8;

export default function AgentQuickAdd({ className }: { className?: string }) {
  const [open, setOpen] = useState(false);
  const [menuStyle, setMenuStyle] = useState<CSSProperties>({ visibility: 'hidden' });
  const triggerEl = useRef<HTMLButtonElement | null>(null);
  const menuEl = useRef<HTMLDivElement | null>(null);

  const project = useStore(activeProject);
  const $customAgents = useStore(customAgents);
  const $removedPresetAgents = useStore(removedPresetAgents);
  const $usage = useStore(usageState);
  const $agentUpdates = useStore(agentUpdates);

  // The same roster the Spawn Agents picker offers.
  const presets = useMemo(() => {
    void $removedPresetAgents;
    if (!project) return [];
    return filterInstalledAgents(getPresetRuns(project.id).filter((r) => r.isAgent), {
      installedCommands: installedAgentCommands($usage),
      customCommands: new Set($customAgents.map((a) => a.command)),
      haveDetection: haveAgentDetection($usage),
    });
  }, [project, $usage.lastFetchedAt, $usage.detected, $customAgents, $removedPresetAgents]);

  // Hang straight down from the trigger, left edges aligned; nudged back
  // inside the window if it would overflow, flipped above when there is no
  // room underneath. Measured after paint so the menu's size is known.
  useLayoutEffect(() => {
    if (!open) return;
    function place() {
      const trigger = triggerEl.current?.getBoundingClientRect();
      const menu = menuEl.current;
      if (!trigger || !menu) return;
      const width = menu.offsetWidth;
      const height = menu.offsetHeight;
      const left = Math.max(EDGE_MARGIN, Math.min(trigger.left, window.innerWidth - width - EDGE_MARGIN));
      const below = trigger.bottom + GAP;
      const top = below + height > window.innerHeight - EDGE_MARGIN
        ? Math.max(EDGE_MARGIN, trigger.top - GAP - height)
        : below;
      setMenuStyle({ position: 'fixed', left: `${left}px`, top: `${top}px` });
    }
    place();
    window.addEventListener('resize', place);
    return () => window.removeEventListener('resize', place);
  }, [open, presets.length]);

  useEffect(() => {
    if (!open) return;
    function onPointerDown(event: MouseEvent) {
      const target = event.target as Node;
      if (triggerEl.current?.contains(target) || menuEl.current?.contains(target)) return;
      setOpen(false);
    }
    function onKeyDown(event: KeyboardEvent) {
      if (event.key !== 'Escape') return;
      event.stopPropagation();
      setOpen(false);
      triggerEl.current?.focus();
    }
    // A click into an iframe (the DeepSeek panel) never reaches `document`;
    // the window losing focus to it is the only sign.
    function onBlur() {
      setOpen(false);
    }
    document.addEventListener('mousedown', onPointerDown);
    document.addEventListener('keydown', onKeyDown, true);
    window.addEventListener('blur', onBlur);
    const id = requestAnimationFrame(() => menuEl.current?.querySelector<HTMLButtonElement>('button:not(:disabled)')?.focus());
    return () => {
      document.removeEventListener('mousedown', onPointerDown);
      document.removeEventListener('keydown', onKeyDown, true);
      window.removeEventListener('blur', onBlur);
      cancelAnimationFrame(id);
    };
  }, [open]);

  function toggle() {
    setMenuStyle({ visibility: 'hidden' });
    setOpen((v) => !v);
  }

  function moveFocus(event: React.KeyboardEvent) {
    if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return;
    event.preventDefault();
    const items = Array.from(menuEl.current?.querySelectorAll<HTMLButtonElement>('button:not(:disabled)') ?? []);
    const index = items.indexOf(document.activeElement as HTMLButtonElement);
    const next = (index + (event.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length;
    items[next]?.focus();
  }

  return (
    <>
      <button
        type="button"
        ref={triggerEl}
        className={className}
        onClick={toggle}
        title="Add another agent"
        aria-label="Add another agent"
        aria-haspopup="menu"
        aria-expanded={open}
      >
        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round">
          <line x1="12" y1="5" x2="12" y2="19" />
          <line x1="5" y1="12" x2="19" y2="12" />
        </svg>
      </button>
      {open && createPortal(
        <div
          ref={menuEl}
          className="dd-menu agent-quick-add-menu"
          style={menuStyle}
          role="menu"
          aria-label="Add an agent"
          onKeyDown={moveFocus}
        >
          {presets.length === 0 && (
            <div className="agent-quick-add-empty">No agents found on this computer.</div>
          )}
          {presets.map((preset) => {
            const updating = $agentUpdates.updating.includes(preset.command);
            return (
              <button
                key={preset.command}
                type="button"
                className="dd-item"
                role="menuitem"
                disabled={updating}
                title={updating ? `${preset.name} is updating` : `Start ${preset.name}`}
                onClick={() => {
                  setOpen(false);
                  void quickSpawnAgent(preset.command);
                }}
              >
                <AgentBrandMark command={preset.command} name={preset.name} className="agent-quick-add-brand" />
                <span className="dd-item-label">{preset.name}</span>
                {updating && <span className="dd-item-sub">updating</span>}
              </button>
            );
          })}
          <div className="agent-quick-add-divider" aria-hidden="true" />
          <button
            type="button"
            className="dd-item"
            role="menuitem"
            onClick={() => {
              setOpen(false);
              openAgentSpawn();
            }}
          >
            <span className="dd-item-label">More options…</span>
          </button>
        </div>,
        document.body,
      )}
    </>
  );
}
