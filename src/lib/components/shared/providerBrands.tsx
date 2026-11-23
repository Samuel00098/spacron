import type { ReactNode } from 'react';
import { get } from '$lib/stores/storeCompat';
import { useStore } from '$lib/react/useStore';
import { customProviders, customProviderIcons, knownProviderForUrl } from '$lib/stores/customProviders';
import {
  fallbackAgentBrand,
  lookupAgentBrand,
  type AgentBrand,
} from './agentBrands';

/**
 * Brand marks for API providers in Settings and the Chat provider/model
 * picker. Provider connections are not coding agents: a provider must not
 * silently borrow a similarly named agent mark (Groq is not Grok, and
 * Mistral is not Mistral Vibe). The local SVGs come from the provider icon
 * set already used by the project, so the desktop app does not depend on a
 * network request just to paint a picker.
 */

const PROVIDER_ASSETS: Record<string, { file: string; color: string }> = {
  openrouter: { file: 'openrouter', color: '#94A3B8' },
  deepseek: { file: 'deepseek', color: '#5786FE' },
  groq: { file: 'groq', color: '#F43E01' },
  mistral: { file: 'mistral', color: '#FF7000' },
  together: { file: 'together', color: '#F97316' },
  fireworks: { file: 'fireworks', color: '#FF6B35' },
  cerebras: { file: 'cerebras', color: '#F43F5E' },
  nvidia: { file: 'nvidia', color: '#76B900' },
  sambanova: { file: 'sambanova', color: '#F97316' },
  perplexity: { file: 'perplexity', color: '#20B8CD' },
  cohere: { file: 'cohere', color: '#FF7759' },
  ollama: { file: 'ollama', color: '#F5A524' },
  lmstudio: { file: 'lmstudio', color: '#60A5FA' },
  vercel: { file: 'vercel', color: '#94A3B8' },
};

// These providers genuinely share their public brand with a bundled mark.
// Keep this list explicit so a new provider cannot accidentally match an
// unrelated coding-agent name through the generic name-hint resolver.
const SHARED_BRANDS: Record<string, { command: string; name: string }> = {
  openai: { command: 'codex', name: 'Codex' },
  // The ChatGPT-subscription provider is served by the Codex CLI, so it wears
  // the same OpenAI mark as the `openai` connection.
  chatgpt: { command: 'codex', name: 'Codex' },
  anthropic: { command: 'claude', name: 'Claude' },
  google: { command: 'gemini', name: 'Gemini' },
  xai: { command: 'grok', name: 'Grok' },
  opencode: { command: 'opencode', name: 'OpenCode' },
  'opencode-go': { command: 'opencode', name: 'OpenCode' },
  kilocode: { command: 'kilo', name: 'Kilo' },
  moonshot: { command: 'kimi', name: 'Kimi' },
};

function assetMark(file: string, color: string): ReactNode {
  const source = `url("/provider-icons/${file}.svg")`;
  return (
    <span
      className="provider-brand-asset"
      style={{
        display: 'block',
        width: '100%',
        height: '100%',
        backgroundColor: color,
        WebkitMaskImage: source,
        maskImage: source,
        WebkitMaskPosition: 'center',
        maskPosition: 'center',
        WebkitMaskRepeat: 'no-repeat',
        maskRepeat: 'no-repeat',
        WebkitMaskSize: 'contain',
        maskSize: 'contain',
      }}
    />
  );
}

function localMark(): AgentBrand {
  return {
    color: '#9CA3AF',
    mark: (
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7">
        <rect x="4" y="5" width="16" height="14" rx="2.5" />
        <path d="M8 9h8M8 12h5M8 15h8" />
      </svg>
    ),
  };
}

function imageMark(src: string): ReactNode {
  return (
    <img
      className="provider-brand-image"
      src={src}
      alt=""
      draggable={false}
      style={{ display: 'block', width: '100%', height: '100%', objectFit: 'contain', borderRadius: '3px' }}
    />
  );
}

/**
 * A custom provider's mark: the bundled logo of the service its address
 * points at, else the site's own icon (fetched by the backend), else a letter.
 */
function customBrand(id: string, label: string): AgentBrand {
  const provider = get(customProviders).find((p) => p.id === id);
  const known = provider ? knownProviderForUrl(provider.baseUrl) : null;
  if (known) return getProviderBrand(known, label);
  const icon = get(customProviderIcons)[id];
  if (icon) return { color: 'mono', mark: imageMark(icon) };
  return fallbackAgentBrand(id, provider?.name ?? label);
}

/** Resolve a provider-specific mark without falling back to a lookalike. */
export function getProviderBrand(id: string, label: string): AgentBrand {
  const key = id.trim().toLowerCase();
  if (key.startsWith('custom-')) return customBrand(key, label);
  const asset = PROVIDER_ASSETS[key];
  if (asset) return { color: asset.color, mark: assetMark(asset.file, asset.color) };
  if (key === 'fish') return { color: 'mono', mark: imageMark('/provider-icons/fish.png') };
  if (key === 'local') return localMark();

  const shared = SHARED_BRANDS[key];
  if (shared) {
    const bundled = lookupAgentBrand(shared.command, shared.name);
    if (bundled) return bundled;
  }

  // Unknown/custom ids still get the established fallback treatment, but do
  // not borrow a provider logo based on a fuzzy label match.
  return fallbackAgentBrand(id, label);
}

/** Renders an AI provider mark at the size chosen by its parent container. */
export function ProviderBrandMark({
  id,
  label,
  className,
}: {
  id: string | null | undefined;
  label: string | null | undefined;
  className?: string;
}) {
  // Subscribed so a custom provider's icon appears as soon as it arrives.
  useStore(customProviders);
  useStore(customProviderIcons);
  const brand = getProviderBrand(id ?? '', label ?? '');
  const color = brand.color === 'mono' ? 'var(--text-primary, #e8e8e8)' : brand.color;
  return (
    <span
      className={`agent-brand-mark${className ? ` ${className}` : ''}`}
      style={{ color }}
      aria-hidden="true"
    >
      {brand.mark}
    </span>
  );
}
