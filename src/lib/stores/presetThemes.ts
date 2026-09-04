import { writable } from '$lib/stores/storeCompat';
import type { Theme } from '$lib/types/theme';

export const currentPresetTheme = writable<string | null>(null);

export function createPresetTheme(
  id: string,
  name: string,
  type: 'dark' | 'light',
  colors: Record<string, string>,
  syntax: Record<string, string>,
  backgroundImage?: string,
  backgroundOpacity?: number,
  backgroundBlur?: number
): Theme {
  return { id, name, type, colors, syntax, backgroundImage, backgroundOpacity, backgroundBlur };
}

/* ── The accent ───────────────────────────────────────────────────────
   Two accents, one per appearance mode — every preset below shares them,
   so the accent is a property of light-vs-dark, not of the wallpaper.
   Change these values and the whole app's accent moves with them.

   The accent is graphite, not a hue, and that is the whole point. Every
   hue this app has is already spoken for: red is --error, amber is
   --warning, green is --success, blue is --info, and the --role-* set
   labels terminal panes. A coloured accent would either collide with one
   of those or, as the old indigo did, become a sixth colour that means
   nothing in particular and ends up on everything. Graphite collides with
   nothing, so colour anywhere in the UI now carries information.

   Each mode inverts: the fill is the far end of the page's own value
   range, and the label is the near end.
     light  #1e293b fill on #f8fafc page — 13.98:1, white label 14.63:1
     dark   #f1f5f9 fill on #0b0f17 page — 15.56:1, ink label   14.48:1
   'on-accent' is the label colour for anything painted with the accent.
   Dark mode's fill is near-white, so a hardcoded #fff label disappears on
   it — always reach for 'on-accent' (or --button-text, which tracks it).

   Focus rings, selection and hover tints are deliberately NOT the accent.
   They fire on every input and every tab, and an accent that appears
   dozens of times per screen has stopped pointing at anything.

   The focus-ring alphas are load-bearing, not taste: a focus indicator
   needs 3:1 against the surface behind it. Light 0.55 gives 3.94:1 and
   dark 0.45 gives 4.19:1. Light mode needed the heavier alpha because the
   page is bright — 0.42 measured 2.46:1 and failed. Lower either at your
   peril. */

const LIGHT_ACCENT: Record<string, string> = {
  'accent': '#000000',
  'accent-hover': '#18181b',
  'on-accent': '#ffffff',
  'focus-ring': 'rgba(0, 0, 0, 0.55)',
  'border-focus': 'rgba(0, 0, 0, 0.55)',
  'selection-bg': 'rgba(0, 0, 0, 0.10)',
  'editor-lineHighlight': 'rgba(0, 0, 0, 0.03)',
  'input-focus-border': 'rgba(0, 0, 0, 0.55)',
  'button-bg': '#000000',
  'button-hover-bg': '#18181b',
  'button-text': '#ffffff',
};

const DARK_ACCENT: Record<string, string> = {
  'accent': '#ffffff',
  'accent-hover': '#f4f4f5',
  'on-accent': '#000000',
  'focus-ring': 'rgba(255, 255, 255, 0.45)',
  'border-focus': 'rgba(255, 255, 255, 0.45)',
  'selection-bg': 'rgba(255, 255, 255, 0.18)',
  'editor-lineHighlight': 'rgba(255, 255, 255, 0.04)',
  'input-focus-border': 'rgba(255, 255, 255, 0.45)',
  'button-bg': '#ffffff',
  'button-hover-bg': '#f4f4f5',
  'button-text': '#000000',
};

export const DARK_THEME: Theme = createPresetTheme(
  'forge-dark',
  'Dark',
  'dark',
  {
    'bg-primary': '#000000',
    'bg-secondary': '#08080a',
    'bg-tertiary': '#121215',
    'bg-hover': 'rgba(255, 255, 255, 0.05)',
    'bg-active': 'rgba(255, 255, 255, 0.09)',
    'text-primary': '#ffffff',
    'text-secondary': '#a1a1aa',
    'text-muted': '#71717a',
    ...DARK_ACCENT,
    'error': '#ff6b6b',
    'warning': '#fbbf24',
    'success': '#2ee06d',
    'info': '#58a6ff',
    'border': 'rgba(255, 255, 255, 0.08)',
    'titlebar-bg': '#08080a',
    'titlebar-text': '#ffffff',
    'titlebar-border': 'rgba(255, 255, 255, 0.05)',
    'activitybar-bg': '#08080a',
    'activitybar-border': 'rgba(255, 255, 255, 0.05)',
    'sidebar-bg': '#08080a',
    'sidebar-border': 'rgba(255, 255, 255, 0.06)',
    'editor-bg': '#000000',
    'editor-gutter': '#000000',
    'tab-active-bg': '#000000',
    'tab-inactive-bg': '#08080a',
    'tab-border': 'rgba(255, 255, 255, 0.06)',
    'panel-bg': '#000000',
    'panel-border': 'rgba(255, 255, 255, 0.06)',
    'terminal-bg': '#000000',
    'input-bg': '#0d0d10',
    'input-border': 'rgba(255, 255, 255, 0.12)',
    'statusbar-bg': '#08080a',
    'statusbar-border': 'rgba(255, 255, 255, 0.05)',
    'statusbar-text': '#a1a1aa',
    'scrollbar-thumb': 'rgba(255, 255, 255, 0.10)',
    'scrollbar-track': 'transparent',
  },
  {
    'keyword': '#c792ea',
    'string': '#a5d6ff',
    'comment': '#7a7aa8',
    'function': '#82aaff',
    'number': '#f78c6c',
    'type': '#ffcb6b',
    'variable': '#f07178',
    'operator': '#89ddff',
    'punctuation': '#a0a0c0',
    'constant': '#ff9cac',
    'tag': '#ffcb6b',
    'attribute': '#82aaff',
  }
);

export const LIGHT_THEME: Theme = createPresetTheme(
  'forge-light',
  'Light',
  'light',
  {
    'bg-primary': '#ffffff',
    'bg-secondary': '#f8f9fa',
    'bg-tertiary': '#f1f3f5',
    'bg-hover': 'rgba(0, 0, 0, 0.04)',
    'bg-active': 'rgba(0, 0, 0, 0.08)',
    'text-primary': '#000000',
    'text-secondary': '#4b5563',
    'text-muted': '#6b7280',
    ...LIGHT_ACCENT,
    'error': '#d40c0c',
    'warning': '#a86008',
    'success': '#077f33',
    'info': '#1359f3',
    'border': 'rgba(0, 0, 0, 0.08)',
    'titlebar-bg': '#ffffff',
    'titlebar-text': '#000000',
    'titlebar-border': 'rgba(0, 0, 0, 0.06)',
    'activitybar-bg': '#ffffff',
    'activitybar-border': 'rgba(0, 0, 0, 0.06)',
    'sidebar-bg': '#f8f9fa',
    'sidebar-border': 'rgba(0, 0, 0, 0.08)',
    'editor-bg': '#ffffff',
    'editor-gutter': '#ffffff',
    'tab-active-bg': '#ffffff',
    'tab-inactive-bg': '#f8f9fa',
    'tab-border': 'rgba(0, 0, 0, 0.08)',
    'panel-bg': '#ffffff',
    'panel-border': 'rgba(0, 0, 0, 0.08)',
    'terminal-bg': '#ffffff',
    'input-bg': '#ffffff',
    'input-border': 'rgba(0, 0, 0, 0.12)',
    'statusbar-bg': '#f8f9fa',
    'statusbar-border': 'rgba(0, 0, 0, 0.06)',
    'statusbar-text': '#4b5563',
    'scrollbar-thumb': 'rgba(0, 0, 0, 0.12)',
    'scrollbar-track': 'transparent',
  },
  {
    'keyword': '#d40c0c',
    'string': '#1359f3',
    'comment': '#57606a',
    'function': '#6d28d9',
    'number': '#a86008',
    'type': '#b25708',
    'variable': '#b25708',
    'operator': '#d40c0c',
    'punctuation': '#24292e',
    'constant': '#a86008',
    'tag': '#077f33',
    'attribute': '#0e7490',
  }
);

export const presetThemes: Theme[] = [DARK_THEME, LIGHT_THEME];
