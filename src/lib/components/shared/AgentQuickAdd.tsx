import { useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { useStore } from '$lib/react/useStore';
import { activeProject } from '$lib/stores/workspace';
import { customAgents, removedPresetAgents } from '$lib/stores/customAgents';
import { getPresetRuns, filterInstalledAgents } from '$lib/stores/runs';
import { usageState, installedAgentCommands, haveAgentDetection } from '$lib/stores/usage';
import { agentUpdates } from '$lib/stores/agentUpdates';
import { openAgentSpawn } from '$lib/stores/layout';
import { quickSpawnAgent, quickStartAgentChat } from '$lib/services/quick-spawn';
import { loadLiveAgentProviderModels, peekLiveAgentProviderModels, prewarmLiveAgentProviderModels } from '$lib/services/live-agent-models';
import { isChatAgentProvider } from '$lib/services/chat-provider-adapters';
import type { AgentProviderModel } from '$lib/services/agent-provider-catalogue';
import type { ChatReasoningEffort } from '$lib/types/chat';
import { REASONING_LABELS } from '$lib/services/orchestrator/reasoning-levels';
import { launchFieldOptions } from './AgentLaunchConfigFields';
import { AgentBrandMark } from './useAgentBrand';
import './Dropdown.css';
import './AgentQuickAdd.css';

// The "+" agent launcher. A list of the installed agents; picking one opens a
// second pane beside it with that CLI's models (searchable), a reasoning
// level, an optional first prompt, and two ways to launch: a terminal agent
// in the main repo, or a Chat-mode thread driven by that agent. "More
// options…" opens the full Spawn Agents picker for counts and worktrees.

const GAP = 6;
const EDGE_MARGIN = 8;
const DEFAULT_MODEL = 'default';

type Preset = { command: string; name: string };

const SHORT_EFFORT: Partial<Record<ChatReasoningEffort, string>> = {
  medium: 'Med',
  xhigh: 'XHigh',
};

export default function AgentQuickAdd({
  className,
  label,
  icon,
  title = 'Add another agent',
}: {
  className?: string;
  /** Visible text beside the "+" (the empty-stage button uses one). */
  label?: string;
  icon?: ReactNode;
  title?: string;
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

  const project = useStore(activeProject);
  const $customAgents = useStore(customAgents);
  const $removedPresetAgents = useStore(removedPresetAgents);
  const $usage = useStore(usageState);
  const $agentUpdates = useStore(agentUpdates);

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
      if (!trigger || !root) return;
      const width = root.offsetWidth;
      const height = root.offsetHeight;
      const left = Math.max(EDGE_MARGIN, Math.min(trigger.left, window.innerWidth - width - EDGE_MARGIN));
      const below = trigger.bottom + GAP;
      const top = below + height > window.innerHeight - EDGE_MARGIN
        ? Math.max(EDGE_MARGIN, trigger.top - GAP - height)
        : below;
      setRootStyle({ position: 'fixed', left: `${left}px`, top: `${top}px` });
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
    const id = requestAnimationFrame(() => rootEl.current?.querySelector<HTMLButtonElement>('.aqa-agent:not(:disabled)')?.focus());
    return () => {
      document.removeEventListener('mousedown', onPointerDown);
      document.removeEventListener('keydown', onKeyDown, true);
      window.removeEventListener('blur', onBlur);
      cancelAnimationFrame(id);
    };
  }, [open, selected]);

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
    };
    close();
    setPrompt('');
    if (kind === 'chat') quickStartAgentChat(selectedPreset, opts);
    else void quickSpawnAgent(selectedPreset.command, opts);
  }

  function moveFocus(event: React.KeyboardEvent) {
    if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return;
    const list = (event.target as HTMLElement).closest('.aqa-list');
    if (!list) return;
    event.preventDefault();
    const items = Array.from(list.querySelectorAll<HTMLButtonElement>('button:not(:disabled)'));
    const index = items.indexOf(document.activeElement as HTMLButtonElement);
    const next = (index + (event.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length;
    items[next]?.focus();
  }

  const chatAvailable = selectedPreset ? isChatAgentProvider(selectedPreset.command) : false;
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
            <div className="aqa-list">
              {presets.length === 0 && (
                <div className="agent-quick-add-empty">
                  {project ? 'No agents found on this computer.' : 'Open a project to add an agent.'}
                </div>
              )}
              {presets.map((preset) => {
                const updating = $agentUpdates.updating.includes(preset.command);
                return (
                  <button
                    key={preset.command}
                    type="button"
                    className={`dd-item aqa-agent${selected === preset.command ? ' active' : ''}`}
                    role="menuitem"
                    aria-haspopup="true"
                    aria-expanded={selected === preset.command}
                    disabled={updating}
                    title={updating ? `${preset.name} is updating` : preset.name}
                    onClick={() => pickAgent(preset.command)}
                    onKeyDown={(event) => {
                      if (event.key === 'ArrowRight') {
                        event.preventDefault();
                        pickAgent(preset.command);
                        requestAnimationFrame(() => rootEl.current?.querySelector<HTMLInputElement>('.aqa-model-search')?.focus());
                      }
                    }}
                  >
                    <AgentBrandMark command={preset.command} name={preset.name} className="agent-quick-add-brand" />
                    <span className="dd-item-label">{preset.name}</span>
                    {updating
                      ? <span className="dd-item-sub">updating</span>
                      : <svg className="aqa-chevron" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="m9 18 6-6-6-6" /></svg>}
                  </button>
                );
              })}
            </div>
            <div className="agent-quick-add-divider" aria-hidden="true" />
            <button
              type="button"
              className="dd-item aqa-more"
              role="menuitem"
              onClick={() => {
                close();
                openAgentSpawn();
              }}
            >
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="3" /><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-2.82 1.17V21a2 2 0 0 1-4 0v-.09a1.65 1.65 0 0 0-2.82-1.17l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 3.17 14H3a2 2 0 0 1 0-4h.09a1.65 1.65 0 0 0 1.17-2.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 10 3.17V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 2.82 1.17l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 20.83 10H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" /></svg>
              <span className="dd-item-label">More options…</span>
            </button>
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
                  if (event.ctrlKey || event.metaKey || !chatAvailable) launch('terminal');
                  else launch('chat');
                }}
              />

              <div className="aqa-actions">
                <button type="button" className="aqa-launch" onClick={() => launch('terminal')} title="Launch in a terminal (Ctrl+Enter)">
                  <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><rect x="3" y="4" width="18" height="16" rx="2" /><path d="m7 9 3 3-3 3M13 15h4" /></svg>
                  <span>Launch terminal</span>
                  <kbd>Ctrl+↵</kbd>
                </button>
                <button
                  type="button"
                  className="aqa-launch primary"
                  onClick={() => launch('chat')}
                  disabled={!chatAvailable}
                  title={chatAvailable ? 'Launch as a chat (Enter)' : `${selectedPreset.name} can't run in Chat mode`}
                >
                  <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" /></svg>
                  <span>Launch chat</span>
                  <kbd>↵</kbd>
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
