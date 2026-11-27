import { useEffect, useMemo, useRef, useState } from 'react';
import { AgentBrandMark } from '$lib/components/shared/useAgentBrand';
import { useStore } from '$lib/react/useStore';
import { favouriteAgentCommands, isFavouriteAgent, toggleFavouriteAgent } from '$lib/stores/agentFavourites';
import { favouriteModels, isFavouriteModel, sortModelsByFavourite, toggleFavouriteModel } from '$lib/stores/modelFavourites';
import { openAgentInstallDocs } from '$lib/services/agent-install';
import type { AgentProviderModel } from '$lib/services/agent-provider-catalogue';
import type { ModelToggleId, ModelToggleSpec } from '$lib/services/model-toggles';
import { REASONING_LABELS } from '$lib/services/orchestrator/reasoning-levels';
import {
  loadStructuredAgentModels,
  resolveStructuredAgentModels,
  useStructuredAgentCatalog,
} from '$lib/services/structured-chat/agent-catalog';
import { modelCatalogNote, modelCatalogStatus, selectedModelIssue } from '$lib/services/structured-chat/model-catalog';
import { commandForStructuredAgent, type StructuredChatAgent } from '$lib/services/structured-chat/panes';
import type { StructuredChatState } from '$lib/services/structured-chat/provider';
import './StructuredAgentModelPicker.css';

const SHORT_EFFORTS: Record<string, string> = {
  minimal: 'Min',
  low: 'Low',
  medium: 'Med',
  high: 'High',
  xhigh: 'XHigh',
  max: 'Max',
  ultra: 'Ultra',
};

function formatShortEffort(value: string): string {
  return SHORT_EFFORTS[value] ?? REASONING_LABELS[value as keyof typeof REASONING_LABELS] ?? (value.charAt(0).toUpperCase() + value.slice(1));
}

export interface StructuredAgentModelPickerProps {
  activeAgent: StructuredChatAgent;
  activeModel: string | null;
  /** Name for `activeModel` when the agent's list spells its id differently. */
  activeLabel?: string | null;
  activeEffort: string | null;
  liveState: StructuredChatState | null;
  toggles?: (ModelToggleSpec & { on: boolean })[];
  disabled?: boolean;
  applying?: boolean;
  error?: string | null;
  onSelect: (agent: StructuredChatAgent, model: string | null, effort: string | null) => void;
  onToggle?: (id: ModelToggleId, on: boolean) => void;
}

export default function StructuredAgentModelPicker({
  activeAgent,
  activeModel,
  activeLabel = null,
  activeEffort,
  liveState,
  toggles = [],
  disabled = false,
  applying = false,
  error = null,
  onSelect,
  onToggle,
}: StructuredAgentModelPickerProps) {
  const [open, setOpen] = useState(false);
  const [previewAgent, setPreviewAgent] = useState<StructuredChatAgent>(activeAgent);
  const [query, setQuery] = useState('');
  const [refreshingAgent, setRefreshingAgent] = useState<StructuredChatAgent | null>(null);
  const [probedModels, setProbedModels] = useState<Partial<Record<StructuredChatAgent, AgentProviderModel[]>>>({});
  const rootRef = useRef<HTMLDivElement | null>(null);
  const searchRef = useRef<HTMLInputElement | null>(null);

  const catalog = useStructuredAgentCatalog();
  useStore(favouriteAgentCommands);
  useStore(favouriteModels);

  useEffect(() => {
    if (!open) return;
    setPreviewAgent(activeAgent);
    setQuery('');
    const onDown = (event: MouseEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false);
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.stopPropagation();
        setOpen(false);
      }
    };
    document.addEventListener('mousedown', onDown, true);
    document.addEventListener('keydown', onKey, true);
    const raf = requestAnimationFrame(() => searchRef.current?.focus());
    return () => {
      cancelAnimationFrame(raf);
      document.removeEventListener('mousedown', onDown, true);
      document.removeEventListener('keydown', onKey, true);
    };
  }, [open, activeAgent]);

  useEffect(() => {
    if (disabled) setOpen(false);
  }, [disabled]);

  // Warm the previewed agent's catalog from disk/CLI when opened.
  const [loadingAgent, setLoadingAgent] = useState<StructuredChatAgent | null>(null);
  useEffect(() => {
    if (!open) return;
    const entry = catalog.find((item) => item.agent === previewAgent);
    if (!entry?.installed) return;
    if (previewAgent === activeAgent && liveState?.models?.length) return;
    let cancelled = false;
    setLoadingAgent(previewAgent);
    void loadStructuredAgentModels(previewAgent).then((list) => {
      if (!cancelled && list.length) {
        setProbedModels((prev) => ({ ...prev, [previewAgent]: list }));
      }
    }).catch(() => {}).finally(() => {
      if (!cancelled) setLoadingAgent(null);
    });
    return () => { cancelled = true; };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, previewAgent, activeAgent, liveState?.models?.length]);

  const activeEntry = catalog.find((item) => item.agent === activeAgent) ?? catalog[0];
  const installedAgents = useMemo(() => catalog.filter((item) => item.installed), [catalog]);
  const uninstalledAgents = useMemo(() => catalog.filter((item) => !item.installed), [catalog]);

  const activeModels = useMemo(() => {
    const resolved = resolveStructuredAgentModels(activeAgent, liveState);
    return resolved.length ? resolved : (probedModels[activeAgent] ?? []);
  }, [activeAgent, liveState, probedModels]);

  const previewEntry = catalog.find((item) => item.agent === previewAgent) ?? activeEntry;
  const previewModels = useMemo(() => {
    const resolved = resolveStructuredAgentModels(previewAgent, previewAgent === activeAgent ? liveState : null);
    const list = resolved.length ? resolved : (probedModels[previewAgent] ?? []);
    return sortModelsByFavourite(list, commandForStructuredAgent(previewAgent));
  }, [previewAgent, activeAgent, liveState, probedModels]);

  const filteredModels = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return previewModels;
    return previewModels.filter((model) =>
      model.label.toLowerCase().includes(q)
      || model.id.toLowerCase().includes(q)
      || (model.description ?? '').toLowerCase().includes(q));
  }, [query, previewModels]);

  // Only an unpicked model reads as the default: a listed default must not
  // stand in for a chosen model the list doesn't contain.
  const activeModelObj = activeModels.find((m) => m.id === activeModel)
    ?? (activeModel ? null : activeModels.find((m) => m.isDefault) ?? null);
  const triggerModelLabel = activeModelObj?.label ?? activeLabel ?? activeModel ?? activeEntry?.name ?? 'Choose agent';

  const footerModel = previewAgent === activeAgent
    ? (activeModelObj ?? previewModels.find((m) => m.isDefault) ?? previewModels[0] ?? null)
    : (previewModels.find((m) => m.isDefault) ?? previewModels[0] ?? null);
  const footerEfforts = (footerModel?.reasoningEfforts ?? []).filter((e) => e !== 'default');
  const currentFooterEffort = previewAgent === activeAgent
    ? (activeEffort && activeEffort !== 'default' ? activeEffort : footerModel?.defaultReasoningEffort ?? null)
    : (footerModel?.defaultReasoningEffort ?? footerEfforts[0] ?? null);

  const catalogStatus = previewAgent === activeAgent && liveState
    ? modelCatalogStatus(activeAgent, liveState)
    : null;
  const catalogNote = catalogStatus
    ? modelCatalogNote(activeEntry?.name ?? activeAgent, catalogStatus, selectedModelIssue(catalogStatus, activeModel, activeEffort))
    : null;

  function pickAgentModel(targetAgent: StructuredChatAgent, model: AgentProviderModel | null) {
    const efforts = (model?.reasoningEfforts ?? []).filter((e) => e !== 'default');
    const nextEffort = targetAgent === activeAgent && activeEffort && efforts.includes(activeEffort as any)
      ? activeEffort
      : (model?.defaultReasoningEffort ?? efforts[0] ?? null);
    setOpen(false);
    onSelect(targetAgent, model?.id ?? null, nextEffort ?? null);
  }

  function pickEffort(effort: string) {
    if (previewAgent === activeAgent) {
      onSelect(activeAgent, activeModelObj?.id ?? activeModel, effort);
      return;
    }
    const targetModel = previewModels.find((m) => m.isDefault) ?? previewModels[0] ?? null;
    setOpen(false);
    onSelect(previewAgent, targetModel?.id ?? null, effort);
  }

  async function refreshModels() {
    if (!previewEntry?.installed || refreshingAgent) return;
    setRefreshingAgent(previewAgent);
    try {
      const fresh = await loadStructuredAgentModels(previewAgent, true);
      if (fresh.length) {
        setProbedModels((prev) => ({ ...prev, [previewAgent]: fresh }));
      }
    } catch {
      // Catalog note shows any cached fallback.
    } finally {
      setRefreshingAgent(null);
    }
  }

  const previewCommand = previewEntry?.command ?? commandForStructuredAgent(previewAgent);

  return (
    <div className="terminal-chat-option structured-agent-picker" ref={rootRef}>
      <button
        type="button"
        className={`terminal-chat-pill model structured-agent-trigger${open ? ' open' : ''}${applying ? ' applying' : ''}`}
        title={catalogNote ?? `${activeEntry?.name ?? activeAgent} · Model & reasoning`}
        disabled={disabled}
        aria-haspopup="dialog"
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
      >
        <AgentBrandMark command={activeEntry?.command ?? activeAgent} name={activeEntry?.name ?? activeAgent} className="structured-agent-trigger-icon" />
        <span className="terminal-chat-pill-label">{triggerModelLabel}</span>
        {activeEffort && activeEffort !== 'default' && (
          <span className="terminal-chat-pill-effort">{formatShortEffort(activeEffort)}</span>
        )}
        {toggles.filter((t) => t.on).map((t) => (
          <span key={t.id} className="terminal-chat-pill-effort">{t.label}</span>
        ))}
        <svg className="terminal-chat-pill-caret" width="9" height="9" viewBox="0 0 10 10" aria-hidden="true">
          <path d="M2.5 3.8 5 6.3l2.5-2.5" stroke="currentColor" strokeWidth="1.5" fill="none" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </button>

      {error && !open && <span className="terminal-chat-pill-error" role="status">{error}</span>}

      {open && (
        <div
          className="terminal-chat-menu right structured-agent-popover"
          role="dialog"
          aria-label="Choose agent, model, and reasoning level"
          onWheel={(event) => event.stopPropagation()}
        >
          <div className="structured-agent-columns">
            <div className="structured-agent-col structured-agent-list" role="listbox" aria-label="Agents">
              {installedAgents.map((entry) => {
                const selected = entry.agent === activeAgent;
                const previewing = entry.agent === previewAgent;
                const fav = isFavouriteAgent(entry.command);
                return (
                  <div
                    key={entry.agent}
                    className={`structured-agent-item${selected ? ' selected' : ''}${previewing ? ' previewing' : ''}`}
                  >
                    <button
                      type="button"
                      role="option"
                      aria-selected={previewing}
                      className="structured-agent-item-btn"
                      onClick={() => {
                        setPreviewAgent(entry.agent);
                        setQuery('');
                      }}
                    >
                      <AgentBrandMark command={entry.command} name={entry.name} className="structured-agent-brand" />
                      <span className="structured-agent-name">{entry.name}</span>
                      {selected && <span className="structured-agent-active-dot" aria-label="Active" />}
                    </button>
                    <button
                      type="button"
                      className={`structured-star-btn${fav ? ' pinned' : ''}`}
                      aria-label={`${fav ? 'Unpin' : 'Pin'} ${entry.name}`}
                      title={fav ? 'Unpin agent' : 'Pin agent'}
                      onClick={(event) => {
                        event.stopPropagation();
                        toggleFavouriteAgent(entry.command);
                      }}
                    >
                      ★
                    </button>
                  </div>
                );
              })}

              {uninstalledAgents.length > 0 && (
                <>
                  <div className="structured-agent-divider">Not installed</div>
                  {uninstalledAgents.map((entry) => (
                    <div
                      key={entry.agent}
                      className="structured-agent-item uninstalled"
                      aria-disabled="true"
                    >
                      <div className="structured-agent-item-btn">
                        <AgentBrandMark command={entry.command} name={entry.name} className="structured-agent-brand" />
                        <span className="structured-agent-name">{entry.name}</span>
                      </div>
                      <button
                        type="button"
                        className="structured-install-btn"
                        title={entry.installDocs.known ? 'Open install guide' : 'Find install steps'}
                        onClick={(event) => {
                          event.stopPropagation();
                          void openAgentInstallDocs(entry.command, entry.name);
                        }}
                      >
                        Install
                      </button>
                    </div>
                  ))}
                </>
              )}
            </div>

            <div className="structured-agent-col structured-model-pane">
              <div className="structured-model-header">
                <input
                  ref={searchRef}
                  type="search"
                  className="structured-model-search"
                  placeholder={`Search ${previewEntry?.name ?? previewAgent} models…`}
                  value={query}
                  onChange={(event) => setQuery(event.target.value)}
                />
                <button
                  type="button"
                  className="structured-refresh-btn"
                  title={`Refresh ${previewEntry?.name ?? previewAgent} models`}
                  aria-label="Refresh models"
                  disabled={refreshingAgent === previewAgent}
                  onClick={() => void refreshModels()}
                >
                  {refreshingAgent === previewAgent ? '…' : '↻'}
                </button>
              </div>

              {catalogNote && <div className="structured-model-note">{catalogNote}</div>}

              <div className="structured-model-list" role="listbox" aria-label="Models">
                {!query.trim() && (
                  <button
                    type="button"
                    className={`structured-model-row${previewAgent === activeAgent && !activeModel ? ' selected' : ''}`}
                    onClick={() => pickAgentModel(previewAgent, null)}
                  >
                    <span className="structured-model-copy">
                      <span className="structured-model-label">
                        {previewAgent === activeAgent ? 'Agent default' : `Use ${previewEntry?.name ?? previewAgent} default`}
                      </span>
                      <span className="structured-model-hint">Let {previewEntry?.name ?? previewAgent} choose its default model</span>
                    </span>
                  </button>
                )}

                {filteredModels.map((model) => {
                  const selected = previewAgent === activeAgent && model.id === activeModel;
                  const fav = isFavouriteModel(previewCommand, model.id);
                  return (
                    <div key={model.id} className={`structured-model-row-wrap${selected ? ' selected' : ''}`}>
                      <button
                        type="button"
                        role="option"
                        aria-selected={selected}
                        className="structured-model-row"
                        onClick={() => pickAgentModel(previewAgent, model)}
                      >
                        <span className="structured-model-copy">
                          <span className="structured-model-label">{model.label}</span>
                          {model.description && <span className="structured-model-hint">{model.description}</span>}
                        </span>
                      </button>
                      <button
                        type="button"
                        className={`structured-star-btn${fav ? ' pinned' : ''}`}
                        aria-label={`${fav ? 'Unpin' : 'Pin'} ${model.label}`}
                        title={fav ? 'Unpin model' : 'Pin model'}
                        onClick={(event) => {
                          event.stopPropagation();
                          toggleFavouriteModel(previewCommand, model.id);
                        }}
                      >
                        ★
                      </button>
                    </div>
                  );
                })}

                {filteredModels.length === 0 && query.trim() && (
                  <div className="terminal-chat-menu-empty">No models match “{query.trim()}”</div>
                )}
                {previewModels.length === 0 && !query.trim() && (
                  <div className="structured-model-status">
                    {previewEntry?.installed === false
                      ? `${previewEntry.name} is not installed.`
                      : loadingAgent === previewAgent
                        ? `Loading ${previewEntry?.name ?? previewAgent}'s models…`
                        : `${previewEntry?.name ?? previewAgent} hasn't reported any models yet. Use refresh, or pick its default.`}
                  </div>
                )}
              </div>
            </div>
          </div>

          {(footerEfforts.length > 0 || (previewAgent === activeAgent && toggles.length > 0)) && (
            <div className="structured-agent-footer">
              {footerEfforts.length > 0 && (
                <div className="structured-effort-strip" role="radiogroup" aria-label="Reasoning level">
                  <span className="structured-effort-title">Reasoning</span>
                  <div className="structured-effort-pills">
                    {footerEfforts.map((effort) => {
                      const active = currentFooterEffort === effort;
                      return (
                        <button
                          key={effort}
                          type="button"
                          role="radio"
                          aria-checked={active}
                          className={`structured-effort-btn${active ? ' selected' : ''}`}
                          onClick={() => pickEffort(effort)}
                        >
                          {formatShortEffort(effort)}
                        </button>
                      );
                    })}
                  </div>
                </div>
              )}

              {previewAgent === activeAgent && toggles.length > 0 && onToggle && (
                <div className="structured-toggle-strip">
                  {toggles.map((toggle) => (
                    <button
                      key={toggle.id}
                      type="button"
                      aria-pressed={toggle.on}
                      className={`structured-toggle-btn${toggle.on ? ' selected' : ''}`}
                      onClick={() => onToggle(toggle.id, !toggle.on)}
                    >
                      {toggle.label}
                    </button>
                  ))}
                </div>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
