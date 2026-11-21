import { useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { useStore } from '$lib/react/useStore';
import { activeProject } from '$lib/stores/workspace';
import { customAgents, removedPresetAgents } from '$lib/stores/customAgents';
import { getPresetRuns, filterInstalledAgents } from '$lib/stores/runs';
import { usageState, installedAgentCommands, haveAgentDetection } from '$lib/stores/usage';
import { agentUpdates } from '$lib/stores/agentUpdates';
import { quickSpawnAgent } from '$lib/services/quick-spawn';
import { agentLaunchView, agentLaunchViewByAgent, canShowTerminalChat } from '$lib/services/terminal-chat';
import { loadLiveAgentProviderModels, peekLiveAgentProviderModels, prewarmLiveAgentProviderModels } from '$lib/services/live-agent-models';
import type { AgentProviderModel } from '$lib/services/agent-provider-catalogue';
import type { ChatReasoningEffort } from '$lib/types/chat';
import { REASONING_LABELS } from '$lib/services/orchestrator/reasoning-levels';
import { launchFieldOptions } from './AgentLaunchConfigFields';
import { AgentBrandMark } from './useAgentBrand';
import './Dropdown.css';
import './AgentQuickAdd.css';
import { agentSpawnOpen, closeAgentSpawn } from '$lib/stores/layout';
import { launchWorktreeFor, worktreesByProject } from '$lib/stores/projectWorktrees';

// The "+" launcher: optional quick items (Editor, Terminal) on top, then every
// installed agent. Clicking an agent's name starts it straight away; its arrow
// opens a second pane with that CLI's models (searchable), a reasoning level,
// an optional first prompt, and two ways to launch: a terminal agent or a
// Chat-mode thread driven by that agent.
//
// Where it starts: on an agent's room, `launchFrom` is that agent's folder, so
// the new agent joins the same project worktree (master or another). Without
// it, the sidebar's selected worktree. This replaced the old Spawn Agents
// dialog; its keyboard shortcut now opens the first visible launcher.

/** Mounted launchers, in mount order, for the "spawn agent" shortcut. */
const launchers = new Set<{ trigger: () => HTMLButtonElement | null; open: () => void }>();

/** Open the launcher the shortcut should reach: the first one on screen in the
 *  stage (sidebar rows are skipped — they are per-worktree, not general). */
function openPrimaryLauncher(): boolean {
  for (const entry of launchers) {
    const el = entry.trigger();
    if (!el || el.offsetParent === null || el.closest('.projects-sidebar-panel')) continue;
    entry.open();
    return true;
  }
  for (const entry of launchers) {
    const el = entry.trigger();
    if (el && el.offsetParent !== null) {
      entry.open();
      return true;
    }
  }
  return false;
}

const GAP = 6;
const EDGE_MARGIN = 8;
const DEFAULT_MODEL = 'default';

type Preset = { command: string; name: string };

export type LauncherItem = { id: string; label: string; icon: ReactNode; onSelect: () => void };

const SHORT_EFFORT: Partial<Record<ChatReasoningEffort, string>> = {
  medium: 'Med',
  xhigh: 'XHigh',
};

export default function AgentQuickAdd({
  className,
  label,
  icon,
  title = 'Add another agent',
  items = [],
  launchFrom,
}: {
  className?: string;
  /** Visible text beside the "+" (the empty-stage button uses one). */
  label?: string;
  icon?: ReactNode;
  title?: string;
  /** Shown above the agents, e.g. "Editor" and "Terminal". */
  items?: LauncherItem[];
  /**
   * The folder of the agent this "+" belongs to. New agents join the project
   * worktree that contains it. Omit for the sidebar's selected worktree.
   */
  launchFrom?: string | null;
}) {
  const [open, setOpen] = useState(false);
  const [rootStyle, setRootStyle] = useState<CSSProperties>({ visibility: 'hidden' });
  const triggerEl = useRef<HTMLButtonElement | null>(null);
  const rootEl = useRef<HTMLDivElement | null>(null);
  const promptEl = useRef<HTMLTextAreaElement | null>(null);

  const [selected, setSelected] = useState<string | null>(null);
  const [modelQuery, setModelQuery] = useState('');
  const [model, setModel] = useState<string>(DEFAULT_MODEL);
  const [effort, setEffort] = useState<ChatReasoningEffort>('default');
  const [prompt, setPrompt] = useState('');
  const [models, setModels] = useState<Record<string, AgentProviderModel[]>>({});
  const [loading, setLoading] = useState<Record<string, boolean>>({});

  const defaultLaunchView = useStore(agentLaunchView);
  const launchViewByAgent = useStore(agentLaunchViewByAgent);
  const project = useStore(activeProject);
  const $customAgents = useStore(customAgents);
  const $removedPresetAgents = useStore(removedPresetAgents);
  const $usage = useStore(usageState);
  const $agentUpdates = useStore(agentUpdates);
  const $worktrees = useStore(worktreesByProject);
  const spawnShortcut = useStore(agentSpawnOpen);

  // Where a launch from here lands: resolved at launch time, so a worktree
  // created after this rendered is still found.
  const targetWorktree = (): string | null | undefined =>
    launchFrom === undefined || !project ? undefined : launchWorktreeFor(project.id, launchFrom);
  const targetLabel = useMemo(() => {
    if (launchFrom === undefined || !project) return null;
    const list = $worktrees[project.id];
    if (!list || list.length === 0) return null;
    const path = launchWorktreeFor(project.id, launchFrom);
    const row = path ? list.find((w) => w.path === path) : list.find((w) => w.is_main);
    return row ? (row.is_main ? row.branch ?? row.name : row.name) : null;
  }, [launchFrom, project, $worktrees]);

  // Register for the "spawn agent" shortcut, which used to open the old dialog.
  useEffect(() => {
    const entry = {
      trigger: () => triggerEl.current,
      open: () => {
        setRootStyle({ visibility: 'hidden' });
        setOpen(true);
      },
    };
    launchers.add(entry);
    return () => {
      launchers.delete(entry);
    };
  }, []);
  useEffect(() => {
    if (!spawnShortcut) return;
    // Every mounted launcher sees the flag; the first to run handles it and
    // clears it, so exactly one opens.
    closeAgentSpawn();
    openPrimaryLauncher();
  }, [spawnShortcut]);

  // The same roster the Spawn Agents picker offers.
  const presets: Preset[] = useMemo(() => {
    void $removedPresetAgents;
    if (!project) return [];
    return filterInstalledAgents(getPresetRuns(project.id).filter((r) => r.isAgent), {
      installedCommands: installedAgentCommands($usage),
      customCommands: new Set($customAgents.map((a) => a.command)),
      haveDetection: haveAgentDetection($usage),
    });
  }, [project, $usage.lastFetchedAt, $usage.detected, $customAgents, $removedPresetAgents]);

  const selectedPreset = presets.find((p) => p.command === selected) ?? null;

  // Probe every agent's models as soon as the menu opens, so the model list is
  // usually filled by the time one is picked.
  useEffect(() => {
    if (open) prewarmLiveAgentProviderModels(presets.map((p) => p.command));
  }, [open, presets]);

  useEffect(() => {
    if (!selected || models[selected]) return;
    const cached = peekLiveAgentProviderModels(selected);
    if (cached?.length) {
      setModels((current) => ({ ...current, [selected]: cached }));
      return;
    }
    let alive = true;
    setLoading((current) => ({ ...current, [selected]: true }));
    loadLiveAgentProviderModels(selected)
      .then((list) => {
        if (alive && list.length) setModels((current) => ({ ...current, [selected]: list }));
      })
      .catch(() => { /* "CLI default" stays available. */ })
      .finally(() => {
        if (alive) setLoading((current) => ({ ...current, [selected]: false }));
      });
    return () => { alive = false; };
  }, [selected]);

  const options = useMemo(
    () => (selected ? launchFieldOptions(selected, models[selected] ?? [], model) : null),
    [selected, models, model],
  );
  const usableEfforts = options?.reasoning.filter((entry) => !entry.disabled).map((entry) => entry.effort) ?? [];

  // A level chosen for one model can be meaningless for the next.
  useEffect(() => {
    if (effort !== 'default' && options && !usableEfforts.includes(effort)) setEffort('default');
  }, [options]);

  const filteredModels = useMemo(() => {
    const q = modelQuery.trim().toLowerCase();
    const list = options?.models ?? [];
    return q ? list.filter((m) => `${m.label} ${m.id}`.toLowerCase().includes(q)) : list;
  }, [options, modelQuery]);

  // Hang down from the trigger (flipped above when there is no room), nudged
  // back inside the window. Measured after paint so the size is known; the
  // second pane changes the width, so it re-places when one is picked.
  useLayoutEffect(() => {
    if (!open) return;
    function place() {
      const trigger = triggerEl.current?.getBoundingClientRect();
      const root = rootEl.current;
      const agents = root?.querySelector<HTMLElement>('.aqa-agents');
      if (!trigger || !root || !agents) return;
      // The agents pane always hangs under the "+" (nudged inside the window).
      // The launch pane goes to its right, or to its left when the right has
      // no room.
      const agentsWidth = agents.offsetWidth;
      const total = root.offsetWidth;
      const height = root.offsetHeight;
      const agentsLeft = Math.max(EDGE_MARGIN, Math.min(trigger.left, window.innerWidth - agentsWidth - EDGE_MARGIN));
      const flip = total > agentsWidth && agentsLeft + total > window.innerWidth - EDGE_MARGIN;
      const left = flip ? Math.max(EDGE_MARGIN, agentsLeft + agentsWidth - total) : agentsLeft;
      const below = trigger.bottom + GAP;
      const top = below + height > window.innerHeight - EDGE_MARGIN
        ? Math.max(EDGE_MARGIN, trigger.top - GAP - height)
        : below;
      setRootStyle({ left: `${left}px`, top: `${top}px`, flexDirection: flip ? 'row-reverse' : 'row' });
    }
    place();
    window.addEventListener('resize', place);
    return () => window.removeEventListener('resize', place);
  }, [open, presets.length, selected !== null]);

  useEffect(() => {
    if (!open) return;
    function onPointerDown(event: MouseEvent) {
      const target = event.target as Node;
      if (triggerEl.current?.contains(target) || rootEl.current?.contains(target)) return;
      // The model list's own portalled pieces never exist here, but Dropdown
      // menus elsewhere might: only clicks truly outside close the launcher.
      close();
    }
    function onKeyDown(event: KeyboardEvent) {
      if (event.key !== 'Escape') return;
      event.stopPropagation();
      if (selected) setSelected(null);
      else {
        close();
        triggerEl.current?.focus();
      }
    }
    // A click into an iframe never reaches `document`; the window losing
    // focus to it is the only sign.
    function onBlur() {
      close();
    }
    document.addEventListener('mousedown', onPointerDown);
    document.addEventListener('keydown', onKeyDown, true);
    window.addEventListener('blur', onBlur);
    return () => {
      document.removeEventListener('mousedown', onPointerDown);
      document.removeEventListener('keydown', onKeyDown, true);
      window.removeEventListener('blur', onBlur);
    };
  }, [open, selected]);

  // Focus the first agent when the launcher opens (only then: re-running on
  // every pick would pull focus out of the model search).
  useEffect(() => {
    if (!open) return;
    const id = requestAnimationFrame(() => rootEl.current?.querySelector<HTMLButtonElement>('.aqa-agent:not(:disabled)')?.focus({ preventScroll: true }));
    return () => cancelAnimationFrame(id);
  }, [open]);

  function close() {
    setOpen(false);
    setSelected(null);
  }

  function toggle() {
    setRootStyle({ visibility: 'hidden' });
    if (open) close();
    else setOpen(true);
  }

  function pickAgent(command: string) {
    if (command !== selected) {
      setSelected(command);
      setModel(DEFAULT_MODEL);
      setEffort('default');
      setModelQuery('');
    }
  }

  function launch(kind: 'terminal' | 'chat') {
    if (!selectedPreset) return;
    const opts = {
      model: model === DEFAULT_MODEL ? null : model,
      reasoningEffort: effort,
      prompt,
      worktreePath: targetWorktree(),
    };
    close();
    setPrompt('');
    // Both open the agent's real CLI in a terminal; "chat" just shows that
    // terminal's chat view (services/terminal-chat.ts).
    void quickSpawnAgent(selectedPreset.command, { ...opts, view: kind });
  }

  function moveFocus(event: React.KeyboardEvent) {
    if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return;
    const list = (event.target as HTMLElement).closest('.aqa-list');
    if (!list) return;
    event.preventDefault();
    const items = Array.from(list.querySelectorAll<HTMLButtonElement>('button.aqa-nav:not(:disabled), .aqa-models button:not(:disabled)'));
    const index = items.indexOf(document.activeElement as HTMLButtonElement);
    const next = (index + (event.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length;
    items[next]?.focus();
  }

  const chatAvailable = selectedPreset ? canShowTerminalChat(selectedPreset.command) : false;
  // Enter launches the agent's default view from Settings → Chat; Ctrl+Enter the other.
  const agentView = (selectedPreset && launchViewByAgent[selectedPreset.command]) ?? defaultLaunchView;
  const enterView: 'terminal' | 'chat' = agentView === 'chat' && chatAvailable ? 'chat' : 'terminal';
  const defaultModelLabel = options?.defaultModel ? `Default · ${options.defaultModel.label}` : 'CLI default';

  return (
    <>
      <button
        type="button"
        ref={triggerEl}
        className={className}
        onClick={toggle}
        title={title}
        aria-label={label ?? title}
        aria-haspopup="menu"
        aria-expanded={open}
      >
        {icon ?? (
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round">
            <line x1="12" y1="5" x2="12" y2="19" />
            <line x1="5" y1="12" x2="19" y2="12" />
          </svg>
        )}
        {label && <span>{label}</span>}
      </button>
      {open && createPortal(
        <div ref={rootEl} className="aqa-root" style={rootStyle} onKeyDown={moveFocus}>
          <div className="dd-menu aqa-pane aqa-agents" role="menu" aria-label="Add an agent">
            {targetLabel && (
              <div className="aqa-target" title="New agents join this worktree">
                <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                  <circle cx="6" cy="6" r="2.5" /><circle cx="6" cy="18" r="2.5" /><circle cx="18" cy="8" r="2.5" />
                  <path d="M6 8.5v7M18 10.5c0 4-6 3-11 5.5" />
                </svg>
                <span>Starts in <strong>{targetLabel}</strong></span>
              </div>
            )}
            {items.length > 0 && (
              <div className="aqa-quick-row" role="group" aria-label="Open">
                {items.map((item) => (
                  <button
                    key={item.id}
                    type="button"
                    className="aqa-quick-item"
                    role="menuitem"
                    title={item.label}
                    aria-label={item.label}
                    onClick={() => {
                      close();
                      item.onSelect();
                    }}
                  >
                    {item.icon}
                  </button>
                ))}
              </div>
            )}
            <div className="aqa-list">
              {presets.length === 0 && (
                <div className="agent-quick-add-empty">
                  {project ? 'No agents found on this computer.' : 'Open a project to add an agent.'}
                </div>
              )}
              {presets.map((preset) => {
                const updating = $agentUpdates.updating.includes(preset.command);
                const openConfig = () => {
                  pickAgent(preset.command);
                  requestAnimationFrame(() => rootEl.current?.querySelector<HTMLInputElement>('.aqa-model-search')?.focus());
                };
                return (
                  <div key={preset.command} className={`aqa-agent-row${selected === preset.command ? ' active' : ''}`}>
                    {/* The name launches straight away with the CLI's defaults. */}
                    <button
                      type="button"
                      className="dd-item aqa-agent aqa-nav"
                      role="menuitem"
                      disabled={updating}
                      title={updating ? `${preset.name} is updating` : `Launch ${preset.name}`}
                      onClick={() => {
                        close();
                        void quickSpawnAgent(preset.command, { worktreePath: targetWorktree() });
                      }}
                      onKeyDown={(event) => {
                        if (event.key === 'ArrowRight') {
                          event.preventDefault();
                          openConfig();
                        }
                      }}
                    >
                      <AgentBrandMark command={preset.command} name={preset.name} className="agent-quick-add-brand" />
                      <span className="dd-item-label">{preset.name}</span>
                      {updating && <span className="dd-item-sub">updating</span>}
                    </button>
                    {/* The arrow opens the model / level / prompt pane. */}
                    <button
                      type="button"
                      className="aqa-config-btn"
                      disabled={updating}
                      tabIndex={-1}
                      title={`Choose ${preset.name} model and level`}
                      aria-label={`Choose ${preset.name} model and level`}
                      aria-haspopup="true"
                      aria-expanded={selected === preset.command}
                      onClick={openConfig}
                    >
                      <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="m9 18 6-6-6-6" /></svg>
                    </button>
                  </div>
                );
              })}
            </div>
          </div>

          {selectedPreset && options && (
            <div className="dd-menu aqa-pane aqa-config" role="group" aria-label={`Launch ${selectedPreset.name}`}>
              <div className="aqa-model-search-wrap">
                <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" aria-hidden="true"><circle cx="11" cy="11" r="7" /><path d="M21 21l-4.3-4.3" /></svg>
                <input
                  className="aqa-model-search"
                  type="text"
                  placeholder={`Search ${selectedPreset.name} models…`}
                  value={modelQuery}
                  onChange={(event) => setModelQuery(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === 'ArrowDown') {
                      event.preventDefault();
                      rootEl.current?.querySelector<HTMLButtonElement>('.aqa-models button:not(:disabled)')?.focus();
                    }
                  }}
                  spellCheck={false}
                  autoComplete="off"
                />
              </div>
              <div className="aqa-list aqa-models" role="listbox" aria-label="Model">
                {!modelQuery.trim() && (
                  <button
                    type="button"
                    role="option"
                    aria-selected={model === DEFAULT_MODEL}
                    className={`dd-item aqa-model${model === DEFAULT_MODEL ? ' active' : ''}`}
                    onClick={() => setModel(DEFAULT_MODEL)}
                  >
                    <span className="dd-item-label">{defaultModelLabel}</span>
                    {model === DEFAULT_MODEL && <CheckIcon />}
                  </button>
                )}
                {filteredModels.map((entry) => {
                  const unavailable = Boolean((entry as { disabled?: boolean }).disabled) || entry.supported === false;
                  return (
                    <button
                      key={entry.id}
                      type="button"
                      role="option"
                      aria-selected={model === entry.id}
                      className={`dd-item aqa-model${model === entry.id ? ' active' : ''}`}
                      disabled={unavailable}
                      title={entry.description}
                      onClick={() => setModel(entry.id)}
                    >
                      <span className="dd-item-label">{entry.label}</span>
                      {model === entry.id && <CheckIcon />}
                    </button>
                  );
                })}
                {loading[selectedPreset.command] && !(models[selectedPreset.command]?.length) && (
                  <div className="agent-quick-add-empty">Loading models…</div>
                )}
                {modelQuery.trim() && filteredModels.length === 0 && (
                  <div className="agent-quick-add-empty">No matching models.</div>
                )}
              </div>

              {usableEfforts.length > 0 && (
                <div className="aqa-efforts" role="radiogroup" aria-label="Reasoning effort">
                  {(['default', ...usableEfforts] as ChatReasoningEffort[]).map((level) => (
                    <button
                      key={level}
                      type="button"
                      role="radio"
                      aria-checked={effort === level}
                      className={`aqa-effort${effort === level ? ' active' : ''}`}
                      onClick={() => setEffort(level)}
                      title={REASONING_LABELS[level]}
                    >
                      {level === 'default' ? 'Auto' : SHORT_EFFORT[level] ?? REASONING_LABELS[level]}
                    </button>
                  ))}
                </div>
              )}

              <textarea
                ref={promptEl}
                className="aqa-prompt"
                rows={2}
                placeholder="Add a prompt (optional)"
                value={prompt}
                onChange={(event) => setPrompt(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key !== 'Enter' || event.shiftKey) return;
                  event.preventDefault();
                  const alternate = enterView === 'chat' ? 'terminal' : chatAvailable ? 'chat' : 'terminal';
                  launch(event.ctrlKey || event.metaKey ? alternate : enterView);
                }}
              />

              <div className="aqa-actions">
                <button
                  type="button"
                  className={`aqa-launch${enterView === 'terminal' ? ' primary' : ''}`}
                  onClick={() => launch('terminal')}
                  title={`Launch in a terminal (${enterView === 'terminal' ? 'Enter' : 'Ctrl+Enter'})`}
                >
                  <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><rect x="3" y="4" width="18" height="16" rx="2" /><path d="m7 9 3 3-3 3M13 15h4" /></svg>
                  <span>Launch terminal</span>
                  <kbd>{enterView === 'terminal' ? '↵' : 'Ctrl+↵'}</kbd>
                </button>
                <button
                  type="button"
                  className={`aqa-launch${enterView === 'chat' ? ' primary' : ''}`}
                  onClick={() => launch('chat')}
                  disabled={!chatAvailable}
                  title={chatAvailable
                    ? `Launch in its terminal, shown as chat (${enterView === 'chat' ? 'Enter' : 'Ctrl+Enter'})`
                    : `${selectedPreset.name} has no chat view yet: Spacron can't read its conversation`}
                >
                  <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" /></svg>
                  <span>Launch chat</span>
                  {chatAvailable && <kbd>{enterView === 'chat' ? '↵' : 'Ctrl+↵'}</kbd>}
                </button>
              </div>
            </div>
          )}
        </div>,
        document.body,
      )}
    </>
  );
}

function CheckIcon() {
  return (
    <svg className="aqa-check" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M20 6 9 17l-5-5" />
    </svg>
  );
}
