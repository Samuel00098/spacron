import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { AgentBrandMark } from '$lib/components/shared/useAgentBrand';
import { get } from '$lib/stores/storeCompat';
import { favouriteAgentCommands, sortAgentsByFavourite, toggleFavouriteAgent } from '$lib/stores/agentFavourites';
import {
  favouriteModels,
  isFavouriteModel,
  sortModelsByFavourite,
  toggleFavouriteModel,
  type FavouriteModelKey,
} from '$lib/stores/modelFavourites';
import { showToast } from '$lib/stores/notification';
import type { AgentProviderModel } from '$lib/services/agent-provider-catalogue';

export type ChatEngineOption = { command: string; name: string };

function DefaultEngineIcon({ command, name }: { command: string; name: string }) {
  return <AgentBrandMark command={command} name={name} />;
}

export default function ChatAgentModelPicker({
  agents,
  provider,
  model,
  disabled = false,
  modelsFor,
  loadingProvider,
  boundarySelector,
  direction = 'auto',
  onPreviewProvider,
  onChange,
  renderEngineIcon,
  onRefresh,
  renderModelBadges,
}: {
  agents: ChatEngineOption[];
  provider: string;
  model: string;
  disabled?: boolean;
  modelsFor: (provider: string) => AgentProviderModel[];
  loadingProvider?: string | null;
  boundarySelector?: string;
  direction?: 'down' | 'up' | 'auto';
  onPreviewProvider: (provider: string) => void;
  onChange: (provider: string, model: string) => void;
  /** Override the provider icon (used for AI provider ids, which get brand marks). */
  renderEngineIcon?: (command: string, name: string) => React.ReactNode;
  /** Explicit refresh affordance shown in the menu footer. */
  onRefresh?: (provider: string) => void;
  /**
   * Extra content at the end of each model row (the chat uses it for the
   * model's capability icons). `modelIds` is the whole list being shown, so a
   * renderer can load answers for all of it at once.
   */
  renderModelBadges?: (provider: string, modelId: string, modelIds: string[]) => React.ReactNode;
}) {
  const EngineIcon = renderEngineIcon
    ? ({ command, name }: { command: string; name: string }) => <>{renderEngineIcon(command, name)}</>
    : DefaultEngineIcon;
  const [open, setOpen] = useState(false);
  const [dropUp, setDropUp] = useState(false);
  const [previewProvider, setPreviewProvider] = useState(provider);
  const [modelQuery, setModelQuery] = useState('');
  const [menuStyle, setMenuStyle] = useState<React.CSSProperties>({});
  const rootRef = useRef<HTMLDivElement | null>(null);
  const menuRef = useRef<HTMLDivElement | null>(null);

  // Pinned agents first: the roster is long once ACP agents are installed, and
  // the one you keep reaching for should never be at the bottom of the list.
  const [favourites, setFavourites] = useState<string[]>(() => get(favouriteAgentCommands));
  const [modelFavourites, setModelFavourites] = useState<FavouriteModelKey[]>(() => get(favouriteModels));
  const orderedAgents = useMemo(() => sortAgentsByFavourite(agents), [agents, favourites]);
  const selectedAgent = agents.find((agent) => agent.command === provider) ?? null;
  const selectedModel = modelsFor(provider).find((entry) => entry.id === model) ?? null;
  const triggerLabel = selectedModel && selectedModel.id !== 'default'
    ? selectedModel.label
    : selectedAgent?.name ?? 'Choose provider';
  const previewAgent = agents.find((agent) => agent.command === previewProvider) ?? selectedAgent;
  const previewModels = useMemo(() => modelsFor(previewProvider), [modelsFor, previewProvider]);
  const orderedModels = useMemo(() => sortModelsByFavourite(previewModels, previewProvider), [previewModels, previewProvider, modelFavourites]);
  const filteredModels = useMemo(() => {
    const query = modelQuery.trim().toLocaleLowerCase();
    if (!query) return orderedModels;
    return orderedModels.filter((entry) => entry.label.toLocaleLowerCase().includes(query));
  }, [modelQuery, orderedModels]);
  const unavailableModelCount = filteredModels.filter((entry) => entry.supported === false).length;
  const previewModelIds = useMemo(() => previewModels.map((entry) => entry.id), [previewModels]);

  function placeMenu() {
    const anchor = rootRef.current?.getBoundingClientRect();
    if (!anchor) return;
    const boundary = boundarySelector
      ? document.querySelector(boundarySelector)
      : (rootRef.current?.closest('.chat-mode-panel') ?? null);
    const boundRect = boundary ? boundary.getBoundingClientRect() : null;

    const edge = 16;
    const bottomEdge = 32;
    const boundTop = boundRect ? Math.max(edge, boundRect.top + edge) : edge;
    const boundBottom = boundRect ? Math.min(window.innerHeight - bottomEdge, boundRect.bottom - bottomEdge) : window.innerHeight - bottomEdge;
    const boundLeft = boundRect ? Math.max(edge, boundRect.left + edge) : edge;
    const boundRight = boundRect ? Math.min(window.innerWidth - edge, boundRect.right - edge) : window.innerWidth - edge;

    // Anchored to the picker itself, above or below it, not to the composer's edges.
    const topBase = anchor.bottom + 6;
    const availableBelow = boundBottom - topBase;
    const topAnchor = anchor.top;
    const availableAbove = topAnchor - boundTop;

    const nextDropUp = direction === 'up'
      ? true
      : direction === 'down'
        ? (availableBelow < 120 && availableAbove > availableBelow)
        : availableBelow < Math.min(300, 200) && availableAbove > availableBelow;
    const available = nextDropUp ? availableAbove : availableBelow;

    const maxW = Math.max(280, boundRight - boundLeft);
    const width = Math.min(480, maxW);
    let left = anchor.left;
    if (left + width > boundRight) {
      left = Math.min(anchor.right - width, boundRight - width);
    }
    left = Math.max(boundLeft, left);

    setDropUp(nextDropUp);
    setMenuStyle({
      position: 'fixed',
      width,
      left,
      maxHeight: Math.max(100, Math.min(280, available - 10)),
      ...(nextDropUp ? { bottom: window.innerHeight - topAnchor + 6 } : { top: topBase }),
    });
  }

  function preview(command: string) {
    setPreviewProvider(command);
    setModelQuery('');
    onPreviewProvider(command);
  }

  function toggle() {
    if (disabled) return;
    if (!open) {
      setPreviewProvider(provider);
      onPreviewProvider(provider);
      placeMenu();
    }
    setOpen((current) => !current);
  }

  useLayoutEffect(() => {
    if (!open || !menuRef.current) return;
    placeMenu();
  }, [open]);

  useEffect(() => {
    const unsub = favouriteModels.subscribe((next) => setModelFavourites(next));
    return () => unsub();
  }, []);

  useEffect(() => {
    if (!open) return;
    const closeOutside = (event: MouseEvent) => {
      const target = event.target as Node;
      if (rootRef.current?.contains(target) || menuRef.current?.contains(target)) return;
      setOpen(false);
    };
    const closeEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setOpen(false);
    };
    const reposition = () => placeMenu();
    window.addEventListener('mousedown', closeOutside);
    window.addEventListener('keydown', closeEscape);
    window.addEventListener('resize', reposition);
    window.addEventListener('scroll', reposition, true);
    return () => {
      window.removeEventListener('mousedown', closeOutside);
      window.removeEventListener('keydown', closeEscape);
      window.removeEventListener('resize', reposition);
      window.removeEventListener('scroll', reposition, true);
    };
  }, [open]);

  return (
    <div className="chat-agent-model-picker" ref={rootRef}>
      <button
        type="button"
        className={`chat-agent-model-trigger${open ? ' open' : ''}`}
        onClick={toggle}
        disabled={disabled}
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-label="Choose provider and model"
        title="Choose provider and model"
      >
        <span className="chat-agent-model-mark">
          <EngineIcon command={provider} name={selectedAgent?.name ?? provider} />
        </span>
        <span>{triggerLabel}</span>
        <svg viewBox="0 0 24 24" aria-hidden="true"><polyline points="6 9 12 15 18 9" /></svg>
      </button>

      {open && createPortal(
        <div ref={menuRef} className={`chat-agent-model-menu${dropUp ? ' drop-up' : ''}`} style={menuStyle} role="dialog" aria-label="Provider and model">
          <div className="chat-agent-model-engines" role="listbox" aria-label="Providers">
            {orderedAgents.map((agent) => {
              const pinned = favourites.includes(agent.command.trim().toLowerCase());
              return (
                <div className="chat-agent-model-engine-row" key={agent.command}>
                  <button
                    type="button"
                    className={agent.command === previewProvider ? 'active' : ''}
                    onClick={() => preview(agent.command)}
                    role="option"
                    aria-selected={agent.command === previewProvider}
                  >
                    <span className="chat-agent-model-mark"><EngineIcon command={agent.command} name={agent.name} /></span>
                    <span>{agent.name}</span>
                    <svg viewBox="0 0 24 24" aria-hidden="true"><polyline points="9 18 15 12 9 6" /></svg>
                  </button>
                  <button
                    type="button"
                    className={`chat-agent-model-fav${pinned ? ' pinned' : ''}`}
                    onClick={(event) => {
                      event.stopPropagation();
                      toggleFavouriteAgent(agent.command);
                      setFavourites(get(favouriteAgentCommands));
                    }}
                    aria-pressed={pinned}
                    aria-label={pinned ? `Unpin ${agent.name}` : `Pin ${agent.name} to the top`}
                    title={pinned ? `Unpin ${agent.name}` : `Pin ${agent.name} to the top`}
                  >
                    <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3.5l2.6 5.3 5.9.9-4.3 4.1 1 5.8-5.2-2.7-5.2 2.7 1-5.8L3.5 9.7l5.9-.9z" /></svg>
                  </button>
                </div>
              );
            })}
          </div>
          <div className="chat-agent-model-models-pane">
            <div className="chat-agent-model-models-heading">
              <span className="chat-agent-model-models-heading-mark">
                <EngineIcon command={previewProvider} name={previewAgent?.name ?? previewProvider} />
              </span>
              <span className="chat-agent-model-models-heading-text">
                <strong>{previewAgent?.name ?? previewProvider}</strong>
              </span>
            </div>
            <input
              className="chat-agent-model-search"
              type="search"
              value={modelQuery}
              onChange={(event) => setModelQuery(event.target.value)}
              placeholder="Search models"
              aria-label="Search models"
            />
            <div className="chat-agent-model-models" role="listbox" aria-label={`${previewAgent?.name ?? 'Provider'} models`}>
            {loadingProvider === previewProvider && previewModels.length <= 1 ? (
              <span className="chat-agent-model-loading">Loading models…</span>
            ) : filteredModels.length === 0 ? (
              <span className="chat-agent-model-loading">No matching models</span>
            ) : filteredModels.map((entry) => {
              const pinned = isFavouriteModel(previewProvider, entry.id);
              return (
                <button
                  key={entry.id}
                  type="button"
                  className={`chat-agent-model-model${previewProvider === provider && entry.id === model ? ' active' : ''}${entry.supported === false ? ' unsupported' : ''}`}
                  disabled={entry.supported === false}
                  onClick={(event) => {
                    if (entry.supported === false) return;
                    onChange(previewProvider, entry.id);
                    setOpen(false);
                  }}
                  role="option"
                  aria-selected={previewProvider === provider && entry.id === model}
                  aria-disabled={entry.supported === false}
                  title={entry.supportReason ?? entry.label}
                >
                  <span className="chat-agent-model-model-text">
                    <span className="chat-agent-model-model-label">{entry.label}</span>
                    {entry.supported === false && <span className="chat-agent-model-model-status">Not supported yet</span>}
                  </span>
                  <button
                    type="button"
                    className={`chat-agent-model-fav${pinned ? ' pinned' : ''}`}
                    onClick={(event) => {
                      event.stopPropagation();
                      const nowPinned = toggleFavouriteModel(previewProvider, entry.id);
                      setModelFavourites(get(favouriteModels));
                      showToast(nowPinned ? `Pinned ${entry.label}` : `Unpinned ${entry.label}`, 'info', 1500);
                    }}
                    aria-pressed={pinned}
                    aria-label={pinned ? `Unpin ${entry.label}` : `Pin ${entry.label} to the top`}
                    title={pinned ? `Unpin ${entry.label}` : `Pin ${entry.label} to the top`}
                  >
                    <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3.5l2.6 5.3 5.9 .9-4.3 4.1 1 5.8-5.2-2.7-5.2 2.7 1-5.8L3.5 9.7l5.9-.9z" /></svg>
                  </button>
                  {renderModelBadges && entry.id !== 'default' ? renderModelBadges(previewProvider, entry.id, previewModelIds) : null}
                  {previewProvider === provider && entry.id === model && (
                    <svg viewBox="0 0 24 24" aria-hidden="true"><polyline points="20 6 9 17 4 12" /></svg>
                  )}
                </button>
              );
            })}
            </div>
            <div className="chat-agent-model-menu-footer">
              <span>
                {loadingProvider === previewProvider
                  ? 'Refreshing…'
                  : `${filteredModels.length} model${filteredModels.length === 1 ? '' : 's'}${unavailableModelCount ? ` · ${unavailableModelCount} unavailable` : ''}`}
              </span>
              {onRefresh && (
                <button
                  type="button"
                  className="chat-agent-model-refresh"
                  onClick={() => onRefresh(previewProvider)}
                  disabled={loadingProvider === previewProvider}
                >
                  Refresh
                </button>
              )}
            </div>
          </div>
        </div>,
        document.body,
      )}
    </div>
  );
}
