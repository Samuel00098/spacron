import { useEffect, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { reasoningLevelsFor } from '$lib/services/orchestrator/reasoning-levels';
import { getProviderBaseUrl, isLocalProvider, type AiProviderId } from '$lib/stores/settings';
import './ModelCapabilityBadges.css';

/**
 * What a chat model can take in: text (always), vision (images and
 * screenshots) and reasoning (an effort level to pick). Shown on every model
 * in the picker, and for the selected model next to the composer's reasoning
 * picker.
 *
 * Both answers come from the same place the chat itself uses, so an icon
 * cannot promise something a turn would not do:
 * - vision: Rust's `accepts_images` (agent_turn.rs), through
 *   `ai_models_accept_images` — the catalogue's modalities where a provider
 *   publishes them, else the model's name, minus models that refused an image
 *   earlier this session;
 * - reasoning: `reasoningLevelsFor`, which also drives the reasoning picker.
 */
export interface ModelCapabilities {
  text: true;
  vision: boolean | null;
  reasoning: boolean;
}

export function modelCapabilities(provider: string, model: string, vision: boolean | null): ModelCapabilities {
  return { text: true, vision, reasoning: reasoningLevelsFor(provider, model).length > 0 };
}

// --- vision answers, fetched a provider's list at a time -----------------------

/** provider → model → accepts images. Filled per provider, reused across renders. */
const visionCache = new Map<string, Map<string, boolean>>();
const pending = new Map<string, Promise<void>>();
const listeners = new Set<() => void>();

/** Same base URL rule as the chat's own requests (orchestrator-brain.ts), so both read the same catalogue entry. */
function baseUrlFor(provider: string): string | null {
  const id = provider as AiProviderId;
  return isLocalProvider(id) ? getProviderBaseUrl(id) || null : null;
}

/** Ask Rust about every model in `models` that has no answer yet, in one call. */
export function loadModelVision(provider: string, models: string[]): Promise<void> {
  const known = visionCache.get(provider);
  const missing = [...new Set(models)].filter((m) => m && !known?.has(m));
  if (!missing.length) return Promise.resolve();
  const key = `${provider}\u0000${missing.join('\u0000')}`;
  const running = pending.get(key);
  if (running) return running;
  const job = invoke<Record<string, boolean>>('ai_models_accept_images', { provider, models: missing, baseUrl: baseUrlFor(provider) })
    .then((answers) => {
      const map = visionCache.get(provider) ?? new Map<string, boolean>();
      for (const [model, accepts] of Object.entries(answers ?? {})) map.set(model, accepts === true);
      visionCache.set(provider, map);
      listeners.forEach((notify) => notify());
    })
    .catch(() => undefined)
    .finally(() => pending.delete(key));
  pending.set(key, job);
  return job;
}

/**
 * Forget a provider's answers: a model that refused an image mid-session is
 * text-only from then on, and the next look should say so.
 */
export function forgetModelVision(provider?: string): void {
  if (provider) visionCache.delete(provider);
  else visionCache.clear();
  listeners.forEach((notify) => notify());
}

function useVision(provider: string, model: string, siblings?: string[]): boolean | null {
  const read = () => visionCache.get(provider)?.get(model) ?? null;
  const [vision, setVision] = useState<boolean | null>(read);
  useEffect(() => {
    const update = () => setVision(read());
    listeners.add(update);
    update();
    void loadModelVision(provider, siblings?.length ? siblings : [model]);
    return () => {
      listeners.delete(update);
    };
    // `siblings` is a batching hint only; its identity must not refetch.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [provider, model]);
  return vision;
}

// --- icons ---------------------------------------------------------------------

function TextIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path d="M4 7V5h16v2M9 19h6M12 5v14" />
    </svg>
  );
}

function VisionIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path d="M2 12s3.6-7 10-7 10 7 10 7-3.6 7-10 7S2 12 2 12Z" />
      <circle cx="12" cy="12" r="3" />
    </svg>
  );
}

function ReasoningIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path d="M9 3a3 3 0 0 0-3 3v.2A3 3 0 0 0 4 9a3 3 0 0 0 1 2.2A3 3 0 0 0 4 14a3 3 0 0 0 2 2.8V17a3 3 0 0 0 3 3 3 3 0 0 0 3-3V6a3 3 0 0 0-3-3Z" />
      <path d="M15 3a3 3 0 0 1 3 3v.2A3 3 0 0 1 20 9a3 3 0 0 1-1 2.2 3 3 0 0 1 1 2.8 3 3 0 0 1-2 2.8V17a3 3 0 0 1-3 3 3 3 0 0 1-3-3" />
    </svg>
  );
}

function badgesFor(caps: ModelCapabilities) {
  return [
    {
      key: 'text',
      on: true,
      icon: <TextIcon />,
      label: 'Text',
      tip: 'Text: reads and writes text. Every model supports this.',
    },
    {
      key: 'vision',
      on: caps.vision === true,
      icon: <VisionIcon />,
      label: 'Vision',
      tip:
        caps.vision === true
          ? 'Vision: sees images you attach and screenshots from the browser, desktop and emulator tools.'
          : caps.vision === false
            ? 'No vision: this model gets text only. Screenshots are saved for you, and it reads pages and windows as text.'
            : 'Vision: checking this model…',
    },
    {
      key: 'reasoning',
      on: caps.reasoning,
      icon: <ReasoningIcon />,
      label: 'Reasoning',
      tip: caps.reasoning
        ? 'Reasoning: thinks before answering. Pick how much with the reasoning menu.'
        : 'No reasoning control: this model has no reasoning level to choose.',
    },
  ];
}

/**
 * The icons for one model row in the picker: only what the model supports, so
 * a long list stays readable and models can be compared at a glance.
 * `siblings` (the other models in the list) lets the first row fetch the whole
 * list's answers in one call.
 */
export function ModelCapabilityIcons({ provider, model, siblings }: { provider: string; model: string; siblings?: string[] }) {
  const vision = useVision(provider, model, siblings);
  const supported = badgesFor(modelCapabilities(provider, model, vision)).filter((b) => b.on);
  return (
    <span className="chat-model-caps-inline" aria-label={`Supports ${supported.map((b) => b.label.toLowerCase()).join(', ')}`}>
      {supported.map((b) => (
        <span key={b.key} className="chat-model-cap is-on" title={b.tip}>
          {b.icon}
        </span>
      ))}
    </span>
  );
}

/**
 * The selected model's capabilities, in the composer beside the reasoning
 * picker: all three icons, the unsupported ones dimmed, so "no vision" is as
 * visible as "vision".
 */
export default function ModelCapabilityBadges({ provider, model }: { provider: string; model: string }) {
  const vision = useVision(provider, model);
  const badges = badgesFor(modelCapabilities(provider, model, vision));
  return (
    <div className="chat-model-caps" role="list" aria-label={`What ${model || 'this model'} supports`}>
      {badges.map((b) => (
        <span
          key={b.key}
          role="listitem"
          className={`chat-model-cap${b.on ? ' is-on' : ''}`}
          title={b.tip}
          aria-label={`${b.label}: ${b.on ? 'supported' : 'not supported'}`}
        >
          {b.icon}
        </span>
      ))}
    </div>
  );
}
