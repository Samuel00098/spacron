import { useEffect } from 'react';
import { useStore } from '$lib/react/useStore';
import { reasoningLevelsFor } from '$lib/services/orchestrator/reasoning-levels';
import { capsFor, forgetModelCaps, loadModelCaps, modelCapabilitiesVersion, type ModelCaps } from '$lib/services/model-capabilities';
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
 * - vision: Rust's `accepts_images` (agent_turn.rs) — the provider's list,
 *   else published catalogues for the same model, else the model's name,
 *   minus models that refused an image earlier this session;
 * - reasoning: the provider's list when it says; else `reasoningLevelsFor`,
 *   which also drives the reasoning picker;
 * - tool calls: the provider's list (`nativeTools`, which the chat itself uses
 *   to decide whether to send native tool calls), else another catalogue's
 *   answer for the same model name; null when nobody says.
 * Both arrive through services/model-capabilities.ts, which Rust keeps fresh in
 * the background (startup, and whenever an API key is saved).
 */
export interface ModelCapabilities {
  text: true;
  vision: boolean | null;
  reasoning: boolean;
  /** Native tool (function) calling; null = no list says. */
  tools: boolean | null;
}

/**
 * Reasoning: what the provider's own list says when it says it; otherwise
 * whether the reasoning menu has levels for the model.
 */
export function modelCapabilities(provider: string, model: string, vision: boolean | null, listedReasoning: boolean | null = null, tools: boolean | null = null): ModelCapabilities {
  return { text: true, vision, reasoning: listedReasoning ?? reasoningLevelsFor(provider, model).length > 0, tools };
}

// --- answers from the shared capability store --------------------------------

/** Same base URL rule as the chat's own requests (orchestrator-brain.ts), so both read the same catalogue entry. */
function baseUrlFor(provider: string): string | null {
  const id = provider as AiProviderId;
  return isLocalProvider(id) ? getProviderBaseUrl(id) || null : null;
}

/** Kept for callers: drop a provider's answers so the picker asks again. */
export function forgetModelVision(provider?: string): void {
  forgetModelCaps(provider);
}

function useCaps(provider: string, model: string, siblings?: string[]): ModelCaps | null {
  // Re-render when answers arrive or Rust's background refresh drops them.
  const version = useStore(modelCapabilitiesVersion);
  const known = capsFor(provider, model);
  useEffect(() => {
    // A row whose model is answered does no work at all: with 400+ rows, each
    // re-checking the whole list on every update was the slow part.
    if (known) return;
    void loadModelCaps(provider, siblings?.length ? siblings : [model], baseUrlFor(provider));
    // `siblings` is a batching hint only; its identity must not refetch.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [provider, model, version, known]);
  return known;
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

function ToolsIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.76 3.76Z" />
    </svg>
  );
}

function badgesFor(caps: ModelCapabilities) {
  return [
    {
      key: 'text',
      on: true,
      known: true,
      icon: <TextIcon />,
      label: 'Text',
      tip: 'Text: reads and writes text. Every model supports this.',
    },
    {
      key: 'vision',
      on: caps.vision === true,
      known: caps.vision !== null,
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
      known: true,
      icon: <ReasoningIcon />,
      label: 'Reasoning',
      tip: caps.reasoning
        ? 'Reasoning: thinks before answering. Pick how much with the reasoning menu.'
        : 'No reasoning control: this model has no reasoning level to choose.',
    },
    {
      key: 'tools',
      on: caps.tools === true,
      known: caps.tools !== null,
      icon: <ToolsIcon />,
      label: 'Tool calls',
      tip:
        caps.tools === true
          ? 'Tool calls: can call tools directly — run commands, edit files, use the browser and MCP servers.'
          : caps.tools === false
            ? 'No tool calls: this model cannot call tools natively, so Spacron drives it with text instructions instead.'
            : 'Tool calls: its provider does not say whether this model can call tools. Spacron tries native tool calls and falls back to text.',
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
  const caps = useCaps(provider, model, siblings);
  const supported = badgesFor(modelCapabilities(provider, model, caps?.vision ?? null, caps?.reasoning ?? null, caps?.tools ?? null)).filter((b) => b.on);
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
 * picker: every icon, the unsupported ones dimmed, so "no vision" is as
 * visible as "vision".
 */
export default function ModelCapabilityBadges({ provider, model }: { provider: string; model: string }) {
  const caps = useCaps(provider, model);
  const badges = badgesFor(modelCapabilities(provider, model, caps?.vision ?? null, caps?.reasoning ?? null, caps?.tools ?? null));
  return (
    <div className="chat-model-caps" role="list" aria-label={`What ${model || 'this model'} supports`}>
      {badges.map((b) => (
        <span
          key={b.key}
          role="listitem"
          className={`chat-model-cap${b.on ? ' is-on' : ''}`}
          title={b.tip}
          aria-label={`${b.label}: ${b.on ? 'supported' : b.known ? 'not supported' : 'unknown'}`}
        >
          {b.icon}
        </span>
      ))}
    </div>
  );
}
