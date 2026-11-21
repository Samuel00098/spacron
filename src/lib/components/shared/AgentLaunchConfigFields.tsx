import { useEffect, useMemo } from 'react';
import Dropdown from './Dropdown';
import ReasoningSlider from './ReasoningSlider';
import {
  getAgentProviderCapabilities,
  type AgentProviderModel,
} from '$lib/services/agent-provider-catalogue';
import type { ChatReasoningEffort } from '$lib/types/chat';
import { REASONING_LABELS } from '$lib/services/orchestrator/reasoning-levels';

const DEFAULT_MODEL = 'default';
const EFFORT_ORDER: ChatReasoningEffort[] = ['minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra'];

export interface LaunchFieldOptions {
  models: Array<AgentProviderModel & { disabled?: boolean; disabledReason?: string }>;
  /** Every level the CLI knows of, in canonical order; unusable ones are disabled. */
  reasoning: Array<{ effort: ChatReasoningEffort; disabled: boolean }>;
  /** The model "CLI default" resolves to, when the CLI reports one. */
  defaultModel: AgentProviderModel | null;
  /** The level "CLI default" resolves to for the selected model, when known. */
  defaultReasoning: ChatReasoningEffort | null;
}

/**
 * Work out what the picker offers. The live catalogue from the installed CLI
 * is the only source of models — nothing is pre-listed, so a CLI that reports
 * none leaves just "CLI default" (and the field greys out). Reasoning levels
 * the selected model does not accept are disabled rather than hidden, so the
 * whole scale is always legible.
 */
export function launchFieldOptions(
  command: string,
  liveModels: AgentProviderModel[],
  selectedModelId: string,
  reportedOnly = false,
): LaunchFieldOptions {
  const capabilities = getAgentProviderCapabilities(command);
  const live = liveModels.filter((entry) => entry.id !== DEFAULT_MODEL);
  const defaultModel = live.find((entry) => entry.isDefault) ?? null;

  const selected = selectedModelId === DEFAULT_MODEL
    ? defaultModel
    : live.find((entry) => entry.id === selectedModelId) ?? null;
  // Per-model levels win. With no model info (no live list, or a model the
  // CLI did not describe) fall back to the provider's own list.
  const usable = selected?.reasoningEfforts ?? (reportedOnly ? [] : capabilities.reasoningEfforts);
  const known = new Set<ChatReasoningEffort>(reportedOnly ? usable : capabilities.reasoningEfforts);
  if (!reportedOnly) for (const entry of live) for (const effort of entry.reasoningEfforts ?? []) known.add(effort);
  const reasoning = (reportedOnly ? [...known].filter(effort => effort !== 'default') : EFFORT_ORDER)
    .filter((effort) => known.has(effort))
    .map((effort) => ({ effort, disabled: !usable.includes(effort) }));

  const orchestratorPick = !reportedOnly && selectedModelId !== DEFAULT_MODEL && !live.some((entry) => entry.id === selectedModelId)
    ? [{ id: selectedModelId, label: selectedModelId, description: 'Selected by the orchestrator.' }]
    : [];

  return {
    models: [...orchestratorPick, ...live],
    reasoning,
    defaultModel,
    defaultReasoning: selected?.defaultReasoningEffort && (!reportedOnly || usable.includes(selected.defaultReasoningEffort)) ? selected.defaultReasoningEffort : null,
  };
}

export default function AgentLaunchConfigFields({
  command,
  models,
  loading,
  model,
  reasoningEffort,
  onModelChange,
  onReasoningChange,
  boundarySelector,
  className = '',
  mode = 'cli',
  reportedOnly = false,
  compact = false,
}: {
  command: string;
  models: AgentProviderModel[];
  loading?: boolean;
  model: string | null;
  reasoningEffort: ChatReasoningEffort;
  onModelChange: (model: string | null) => void;
  onReasoningChange: (effort: ChatReasoningEffort) => void;
  boundarySelector?: string;
  className?: string;
  mode?: 'cli' | 'chat';
  /** Use only the selected model's reported metadata, without provider defaults. */
  reportedOnly?: boolean;
  compact?: boolean;
}) {
  const capabilities = useMemo(() => getAgentProviderCapabilities(command), [command]);
  const selectedModel = model?.trim() || DEFAULT_MODEL;
  const options = useMemo(
    () => launchFieldOptions(command, models, selectedModel, reportedOnly),
    [command, models, selectedModel, reportedOnly],
  );
  const hasReasoningControl = options.reasoning.some((entry) => !entry.disabled);
  // Nothing pre-listed: a CLI with no live catalogue offers only its default.
  const hasModelChoice = options.models.length > 0;
  const effortUsable = reasoningEffort === 'default'
    || options.reasoning.some((entry) => entry.effort === reasoningEffort && !entry.disabled);

  // A level chosen for one model can be meaningless for the next (Haiku has no
  // effort; GPT-5.5 has no Ultra). Drop back to the CLI default rather than
  // launch with a flag the model rejects. Runs after the model change has
  // rendered, so it never races the parent's model update.
  useEffect(() => {
    if (!effortUsable) onReasoningChange('default');
  }, [effortUsable]);

  const prefix = mode === 'chat' ? 'Chat default' : 'CLI default';
  const defaultModelLabel = compact ? options.defaultModel?.label ?? 'Agent default' : options.defaultModel ? `${prefix} · ${options.defaultModel.label}` : prefix;
  const defaultReasoningLabel = options.defaultReasoning
    ? `${prefix} · ${REASONING_LABELS[options.defaultReasoning] ?? options.defaultReasoning}`
    : prefix;

  return (
    <div className={`agent-launch-config-fields ${className}`.trim()}>
      <label className="agent-launch-config-field">
        <span>{compact ? 'Model' : mode === 'chat' ? 'Chat model' : 'Local CLI model'}</span>
        <Dropdown
          value={selectedModel}
          options={[
            { value: DEFAULT_MODEL, label: defaultModelLabel, tooltip: `Let ${capabilities.label} use its configured model.` },
            ...options.models.map((entry) => {
              const unavailable = entry.disabled || entry.supported === false;
              return {
                value: entry.id,
                label: entry.label,
                tooltip: unavailable ? entry.disabledReason ?? entry.supportReason : entry.description,
                disabled: unavailable,
              };
            }),
          ]}
          onChange={(value) => onModelChange(value === DEFAULT_MODEL ? null : value)}
          ariaLabel={`${capabilities.label} ${mode === 'chat' ? 'chat' : 'local'} model`}
          boundarySelector={boundarySelector}
          menuMaxHeight={220}
          menuClassName="agent-launch-model-menu"
          disabled={!hasModelChoice && !(reportedOnly && model)}
        />
        {!hasModelChoice && (
          <small>
            {loading
              ? `Loading models from ${capabilities.label}…`
              : `${capabilities.label} does not report its models; it will use its configured model.`}
          </small>
        )}
      </label>

      <label className="agent-launch-config-field">
        <span>Reasoning level</span>
        {compact ? <Dropdown
          value={effortUsable ? reasoningEffort : 'default'}
          options={[
            { value: 'default', label: options.defaultReasoning ? `Default (${REASONING_LABELS[options.defaultReasoning] ?? options.defaultReasoning})` : 'Agent default' },
            ...options.reasoning.filter(entry => !entry.disabled).map(entry => ({ value: entry.effort, label: REASONING_LABELS[entry.effort] ?? entry.effort })),
          ]}
          onChange={value => onReasoningChange(value as ChatReasoningEffort)}
          ariaLabel={`${capabilities.label} reasoning level`}
          disabled={!hasReasoningControl}
          boundarySelector={boundarySelector}
        /> : <ReasoningSlider
          value={effortUsable ? reasoningEffort : 'default'}
          levels={options.reasoning.filter((entry) => !entry.disabled).map((entry) => entry.effort)}
          onChange={onReasoningChange}
          defaultLabel={defaultReasoningLabel}
          disabled={!hasReasoningControl}
        />}
        {!hasReasoningControl && (
          <small>
            {reportedOnly ? 'The agent reports no reasoning levels for this model.' : options.reasoning.length
              ? 'The selected model has no reasoning control.'
              : `${capabilities.label} has no launch option for reasoning.`}
          </small>
        )}
      </label>
    </div>
  );
}
