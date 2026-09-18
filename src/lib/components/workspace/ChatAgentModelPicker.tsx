import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { AgentBrandMark } from '$lib/components/shared/useAgentBrand';
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

  const selectedAgent = agents.find((agent) => agent.command === provider) ?? null;
  const selectedModel = modelsFor(provider).find((entry) => entry.id === model) ?? null;
  const triggerLabel = selectedModel && selectedModel.id !== 'default'
    ? selectedModel.label
    : selectedAgent?.name ?? 'Choose provider';
  const previewAgent = agents.find((agent) => agent.command === previewProvider) ?? selectedAgent;
  const previewModels = useMemo(() => modelsFor(previewProvider), [modelsFor, previewProvider]);
  const filteredModels = useMemo(() => {
    const query = modelQuery.trim().toLocaleLowerCase();
    if (!query) return previewModels;
    return previewModels.filter((entry) => entry.label.toLocaleLowerCase().includes(query));
  }, [modelQuery, previewModels]);
  const unavailableModelCount = filteredModels.filter((entry) => entry.supported === false).length;

  function placeMenu() {
    const anchor = rootRef.current?.getBoundingClientRect();
    if (!anchor) return;
    const boundary = boundarySelector
      ? document.querySelector(boundarySelector)
      : (rootRef.current?.closest('.chat-mode-panel') ?? null);
    const boundRect = boundary ? boundary.getBoundingClientRect() : null;
    const composer = rootRef.current?.closest('.chat-mode-composer');
    const composerRect = composer?.getBoundingClientRect();

    const edge = 16;
    const bottomEdge = 32;
    const boundTop = boundRect ? Math.max(edge, boundRect.top + edge) : edge;
    const boundBottom = boundRect ? Math.min(window.innerHeight - bottomEdge, boundRect.bottom - bottomEdge) : window.innerHeight - bottomEdge;
    const boundLeft = boundRect ? Math.max(edge, boundRect.left + edge) : edge;
    const boundRight = boundRect ? Math.min(window.innerWidth - edge, boundRect.right - edge) : window.innerWidth - edge;

    const topBase = composerRect ? composerRect.bottom + 6 : anchor.bottom + 6;
    const availableBelow = boundBottom - topBase;
    const topAnchor = composerRect ? composerRect.top : anchor.top;
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
            {agents.map((agent) => (
              <button
                key={agent.command}
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
            ))}
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
            ) : filteredModels.map((entry) => (
              <button
                key={entry.id}
                type="button"
                className={`chat-agent-model-model${previewProvider === provider && entry.id === model ? ' active' : ''}${entry.supported === false ? ' unsupported' : ''}`}
                disabled={entry.supported === false}
                onClick={() => {
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
                {previewProvider === provider && entry.id === model && (
                  <svg viewBox="0 0 24 24" aria-hidden="true"><polyline points="20 6 9 17 4 12" /></svg>
                )}
              </button>
            ))}
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
