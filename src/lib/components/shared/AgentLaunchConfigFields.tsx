import { useEffect, useMemo } from 'react';
import Dropdown from './Dropdown';
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
): LaunchFieldOptions {
  const capabilities = getAgentProviderCapabilities(command);
  const live = liveModels.filter((entry) => entry.id !== DEFAULT_MODEL);
  const defaultModel = live.find((entry) => entry.isDefault) ?? null;

  const selected = selectedModelId === DEFAULT_MODEL
    ? defaultModel
    : live.find((entry) => entry.id === selectedModelId) ?? null;
  // Per-model levels win. With no model info (no live list, or a model the
  // CLI did not describe) fall back to the provider's own list.
  const usable = selected?.reasoningEfforts ?? capabilities.reasoningEfforts;
  const known = new Set<ChatReasoningEffort>(capabilities.reasoningEfforts);
  for (const entry of live) for (const effort of entry.reasoningEfforts ?? []) known.add(effort);
  const reasoning = EFFORT_ORDER
    .filter((effort) => known.has(effort))
    .map((effort) => ({ effort, disabled: !usable.includes(effort) }));

  const orchestratorPick = selectedModelId !== DEFAULT_MODEL && !live.some((entry) => entry.id === selectedModelId)
    ? [{ id: selectedModelId, label: selectedModelId, description: 'Selected by the orchestrator.' }]
    : [];

  return {
    models: [...orchestratorPick, ...live],
    reasoning,
    defaultModel,
    defaultReasoning: selected?.defaultReasoningEffort ?? null,
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
}) {
  const capabilities = useMemo(() => getAgentProviderCapabilities(command), [command]);
  const selectedModel = model?.trim() || DEFAULT_MODEL;
  const options = useMemo(
    () => launchFieldOptions(command, models, selectedModel),
    [command, models, selectedModel],
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

  const defaultModelLabel = options.defaultModel ? `CLI default · ${options.defaultModel.label}` : 'CLI default';
  const defaultReasoningLabel = options.defaultReasoning
    ? `CLI default · ${REASONING_LABELS[options.defaultReasoning] ?? options.defaultReasoning}`
    : 'CLI default';

  return (
    <div className={`agent-launch-config-fields ${className}`.trim()}>
      <label className="agent-launch-config-field">
        <span>Local CLI model</span>
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
          ariaLabel={`${capabilities.label} local model`}
          boundarySelector={boundarySelector}
          menuMaxHeight={220}
          disabled={!hasModelChoice}
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
        <Dropdown
          value={effortUsable ? reasoningEffort : 'default'}
          options={[
            { value: 'default', label: defaultReasoningLabel },
            ...options.reasoning.map(({ effort, disabled }) => ({
              value: effort,
              label: REASONING_LABELS[effort] ?? effort,
              disabled,
              tooltip: disabled ? 'The selected model does not support this level.' : undefined,
            })),
          ]}
          onChange={(value) => onReasoningChange(value as ChatReasoningEffort)}
          ariaLabel={`${capabilities.label} reasoning level`}
          boundarySelector={boundarySelector}
          menuMaxHeight={220}
          disabled={!hasReasoningControl}
        />
        {!hasReasoningControl && (
          <small>
            {options.reasoning.length
              ? 'The selected model has no reasoning control.'
              : `${capabilities.label} has no launch option for reasoning.`}
          </small>
        )}
      </label>
    </div>
  );
}
