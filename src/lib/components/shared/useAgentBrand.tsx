import { useEffect } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { writable, get } from '$lib/stores/storeCompat';
import { useStore } from '$lib/react/useStore';
import { useThemeStore } from '$lib/stores/zustand/theme';
import {
  lookupAgentBrand,
  fallbackAgentBrand,
  type AgentBrand,
} from './agentBrands';

/**
 * Agent logo resolution, one level up from `agentBrands`.
 *
 * `getAgentBrand` (in agentBrands) resolves a BUNDLED mark for a known coding
 * CLI, falling straight to a letter glyph otherwise. This hook adds the third
 * tier the spawn UI can't do synchronously: for an agent whose command isn't a
 * known CLI, it asks the backend (`fetch_agent_logo`) to discover a real logo
 * off the web, caches it, and swaps the glyph for the fetched mark once it
 * arrives. Bundled brands never trigger a fetch.
 */

// A fetched logo carries a version for each UI theme; the backend returns both
// (they're identical when the source only ships one asset, e.g. a favicon).
type AgentLogo = { light: string; dark: string };

type FetchState =
  | { status: 'pending' }
  | { status: 'failed' }
  | { status: 'ok'; logo: AgentLogo };

// Shared across every component that renders the same agent, so the header mark
// and its minimized chip resolve together and a slug is fetched only once.
const fetchedLogos = writable<Record<string, FetchState>>({});
const inFlight = new Set<string>();

function slugFor(command: string, name: string): string {
  const base = (command.trim() || name.trim()).toLowerCase();
  return base.replace(/[^a-z0-9]/g, '');
}

function webBrand(dataUri: string): AgentBrand {
  // Fetched favicons carry their own colors, so the tile color is irrelevant —
  // 'mono' just keeps the container from tinting anything.
  return {
    color: 'mono',
    mark: <img src={dataUri} alt="" draggable={false} />,
  };
}

/**
 * Resolve the best available brand for an agent: a bundled CLI mark if known,
 * else a web-fetched logo once it lands, else a letter glyph in the meantime.
 * Pass the agent's launch command and display name.
 */
export function useAgentBrand(
  command: string | null | undefined,
  name: string | null | undefined,
): AgentBrand {
  const cmd = command ?? '';
  const nm = name ?? '';
  const bundled = lookupAgentBrand(cmd, nm);
  const slug = slugFor(cmd, nm);
  const map = useStore(fetchedLogos);
  // Pick the logo variant that suits the active theme's background.
  const themeType = useThemeStore(
    (s) => ((s.activeTheme as { type?: 'dark' | 'light' } | null)?.type ?? 'dark'),
  );

  useEffect(() => {
    if (bundled) return; // known CLI — never hit the network
    if (slug.length < 2) return;
    if (get(fetchedLogos)[slug] !== undefined || inFlight.has(slug)) return;

    inFlight.add(slug);
    fetchedLogos.update((prev) => ({ ...prev, [slug]: { status: 'pending' } }));
    invoke<AgentLogo>('fetch_agent_logo', { command: cmd.trim(), name: nm.trim() })
      .then((logo) => {
        fetchedLogos.update((prev) => ({ ...prev, [slug]: { status: 'ok', logo } }));
      })
      .catch(() => {
        fetchedLogos.update((prev) => ({ ...prev, [slug]: { status: 'failed' } }));
      })
      .finally(() => inFlight.delete(slug));
  }, [bundled, slug, cmd, nm]);

  if (bundled) return bundled;
  const fetched = map[slug];
  if (fetched?.status === 'ok') {
    const { logo } = fetched;
    return webBrand(themeType === 'light' ? logo.light : logo.dark);
  }
  return fallbackAgentBrand(cmd, nm);
}

/**
 * Renders an agent's brand mark, sized by its container. Brand color is applied
 * inline so a `currentColor` mark paints in the brand's own color (or the theme
 * foreground for monochrome brands), overriding any tint the container sets.
 */
export function AgentBrandMark({
  command,
  name,
  className,
}: {
  command: string | null | undefined;
  name: string | null | undefined;
  className?: string;
}) {
  const brand = useAgentBrand(command, name);
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
