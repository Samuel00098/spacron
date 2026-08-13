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
import { loadJson } from '$lib/utils/storage';

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

// Persisted key so fetched logos survive app restarts.
const FETCHED_LOGOS_KEY = 'spacron_fetched_agent_logos';

// Shared across every component that renders the same agent, so the header mark
// and its minimized chip resolve together and a slug is fetched only once.
//
// Only SUCCESSES are worth carrying across restarts. Two states are dropped on
// load and both for the same reason — keeping them would make a temporary
// condition permanent:
//   * 'pending' left behind by a crashed session would never resolve, and would
//     block a fresh fetch forever;
//   * 'failed' is very often not about the agent at all — the app started
//     offline, the icon CDN was down, the backend hadn't grown its later
//     fallback tiers yet. Persisting it froze a letter glyph in place for good,
//     and no amount of improving the lookup would ever be seen. Retrying once
//     per launch costs one request for an agent that genuinely has no logo, and
//     is what makes the favicon fallback actually reach the screen.
function cleanPersisted(raw: Record<string, FetchState>): Record<string, FetchState> {
  const cleaned: Record<string, FetchState> = {};
  for (const [key, state] of Object.entries(raw)) {
    if (state.status !== 'ok') continue; // stale or retryable — fetch again
    cleaned[key] = state;
  }
  return cleaned;
}
const fetchedLogos = writable<Record<string, FetchState>>(
  cleanPersisted(loadJson<Record<string, FetchState>>(FETCHED_LOGOS_KEY, {})),
);

// Persist on every update so a cached logo survives restart.
fetchedLogos.subscribe((val) => {
  try {
    localStorage.setItem(FETCHED_LOGOS_KEY, JSON.stringify(val));
  } catch { /* quota exceeded or unavailable — safe to ignore */ }
});

const inFlight = new Set<string>();

function slugFor(command: string, name: string): string {
  const cmd = command.trim().toLowerCase().replace(/[^a-z0-9]/g, '');
  const nm = name.trim().toLowerCase().replace(/[^a-z0-9]/g, '');
  // Both command and name contribute to the key so a rename or a different
  // name that triggers a different NAME_HINTS / backend match won't
  // cross-contaminate the cache. When the command alone is sufficient,
  // the name part provides the same identity (the command token is already
  // in the name or vice versa), so extra precision is harmless.
  const cmdPart = cmd || '_';
  const nmPart = nm ? `:${nm}` : '';
  return `${cmdPart}${nmPart}`;
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
