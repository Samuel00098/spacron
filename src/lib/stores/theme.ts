import { writable, get } from '$lib/stores/storeCompat';
import { invoke } from '@tauri-apps/api/core';
import type { Theme, ThemeInfo } from '$lib/types/theme';
import { showToast } from './notification';
import { accentColor, appearance, backgroundImageEnabled, backgroundImageBlur, interfaceTransparency } from './settings';
import { applyInterfaceFrost, applyBackgroundAppearance, applyBackgroundImage, hasBackgroundImage, userBackgroundActive } from './background';
import { presetThemes, currentPresetTheme } from './presetThemes';
import { useThemeStore } from './zustand/theme';
import { analyseImage, deriveForegroundPalette } from '$lib/utils/imageAnalysis';

function syncWritable<T>(key: string, defaultValue: T): import('$lib/stores/storeCompat').Writable<T> {
  const zustandVal = (useThemeStore.getState() as any)[key];
  const initial = zustandVal !== undefined ? zustandVal as T : defaultValue;
  const store = writable<T>(initial);
  void useThemeStore.subscribe((state) => {
    const next = (state as any)[key] as T | undefined;
    if (next !== undefined) store.set(next);
  });
  return {
    subscribe: store.subscribe,
    set(value: T) { (useThemeStore.getState() as any).__set(key, value); },
    update(fn: (val: T) => T) {
      const current = (useThemeStore.getState() as any)[key] as T;
      (useThemeStore.getState() as any).__set(key, fn(current));
    },
  };
}

export const activeTheme = syncWritable<Theme | null>('activeTheme', null);
export const availableThemes = syncWritable<ThemeInfo[]>('availableThemes', []);

/**
 * The two built-in appearance modes are deliberately solid monochrome themes.
 * Older persisted theme data may still carry a wallpaper field, so keep the
 * rule here instead of relying only on the current preset definitions.
 */
export function isMonochromePresetTheme(theme: Pick<Theme, 'id'> | null | undefined): boolean {
  return theme?.id === 'forge-light' || theme?.id === 'forge-dark';
}

/**
 * Monotonically increasing counter that is bumped every time the user
 * explicitly picks a theme (via switchPresetTheme or switchTheme). loadThemes
 * checks this before and after its async Tauri invoke so that a backend
 * response arriving after a user selection doesn't silently overwrite it.
 */
let userThemeVersion = 0;

let mediaQueryList: MediaQueryList | null = null;
const handleSystemThemeChange = (e: MediaQueryListEvent | MediaQueryList) => {
  const desiredTheme = e.matches ? 'forge-dark' : 'forge-light';
  const currentActive = get(activeTheme);
  if (!currentActive || currentActive.id !== desiredTheme) {
    // Appearance modes are the built-in presets. Keeping this path synchronous
    // means the rendered theme and the Appearance picker never drift while the
    // operating system preference changes.
    switchPresetTheme(desiredTheme, false);
  }
};

if (typeof window !== 'undefined') {
  let isAppearanceInitialLoad = true;
  let lastAppearance: string | null = null;

  appearance.subscribe((value) => {
    if (value === lastAppearance && !isAppearanceInitialLoad) {
      return;
    }
    lastAppearance = value;

    if (mediaQueryList) {
      try {
        mediaQueryList.removeEventListener('change', handleSystemThemeChange);
      } catch (err) {
        try {
          mediaQueryList.removeListener(handleSystemThemeChange);
        } catch (_) {}
      }
      mediaQueryList = null;
    }

    if (value === 'system') {
      mediaQueryList = window.matchMedia('(prefers-color-scheme: dark)');
      try {
        mediaQueryList.addEventListener('change', handleSystemThemeChange);
      } catch (err) {
        try {
          mediaQueryList.addListener(handleSystemThemeChange);
        } catch (_) {}
      }
      if (!isAppearanceInitialLoad) {
        handleSystemThemeChange(mediaQueryList);
      }
    } else if (!isAppearanceInitialLoad) {
      if (value === 'light') {
        switchPresetTheme('forge-light', false);
      } else if (value === 'dark') {
        switchPresetTheme('forge-dark', false);
      }
    }

    isAppearanceInitialLoad = false;
  });
}

export async function loadThemes() {
  // Snapshot the version before any async work. If the user picks a theme
  // while we are awaiting Tauri calls, our result is stale and we must not
  // overwrite their explicit choice.
  const versionAtStart = userThemeVersion;

  const isStale = () => userThemeVersion !== versionAtStart;

  try {
    const themes = await invoke<ThemeInfo[]>('theme_list');
    if (isStale()) return;
    availableThemes.set(themes);

    const savedThemeId = typeof window !== 'undefined' ? localStorage.getItem('forge_active_theme') : null;

    if (savedThemeId) {
      const preset = presetThemes.find(t => t.id === savedThemeId);
      if (preset) {
        if (isStale()) return;
        activeTheme.set(preset);
        currentPresetTheme.set(savedThemeId);
        applyThemeToCSS(preset);
        return;
      }

      try {
        const theme = await invoke<Theme>('theme_activate', { themeId: savedThemeId });
        if (isStale()) return;
        activeTheme.set(theme);
        currentPresetTheme.set(null);
        applyThemeToCSS(theme);
        return;
      } catch (e) {
        console.warn(`Failed to activate saved theme ${savedThemeId} on backend, falling back to backend's active theme:`, e);
      }
    }

    const theme = await invoke<Theme>('theme_get_active');
    if (isStale()) return;
    activeTheme.set(theme);
    currentPresetTheme.set(null);
    applyThemeToCSS(theme);
  } catch (err) {
    console.error('Failed to load themes:', err);
  }
}

export async function switchTheme(themeId: string, showNotification = true) {
  userThemeVersion++;
  try {
    const theme = await invoke<Theme>('theme_activate', { themeId });
    activeTheme.set(theme);
    currentPresetTheme.set(null);
    if (typeof window !== 'undefined') {
      localStorage.setItem('forge_active_theme', themeId);
    }
    applyThemeToCSS(theme);
    if (showNotification) {
      showToast(`Switched to theme: ${theme.name}`, 'success');
    }
  } catch (err: any) {
    console.error('Failed to switch theme:', err);
    if (showNotification) {
      showToast(`Failed to switch theme: ${err?.message || err}`, 'error');
    }
  }
}

export function switchPresetTheme(themeId: string, showNotification = true) {
  const theme = presetThemes.find(t => t.id === themeId);
  if (!theme) {
    showToast(`Theme "${themeId}" not found`, 'error');
    return;
  }
  // Bump the version so any in-flight loadThemes() call knows its result is now stale.
  userThemeVersion++;
  activeTheme.set(theme);
  currentPresetTheme.set(themeId);
  if (typeof window !== 'undefined') {
    localStorage.setItem('forge_active_theme', themeId);
  }
  applyThemeToCSS(theme);
  if (showNotification) {
    showToast(`Switched to theme: ${theme.name}`, 'success');
  }
}

export function hexToRgb(hex: string): { r: number; g: number; b: number } | null {
  const clean = hex.trim();
  // Parse rgba(r, g, b, a) string
  const rgbaMatch = clean.match(/^rgba?\s*\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)/);
  if (rgbaMatch) {
    return { r: parseInt(rgbaMatch[1], 10), g: parseInt(rgbaMatch[2], 10), b: parseInt(rgbaMatch[3], 10) };
  }
  const cleanHex = clean.replace(/^#/, '');
  if (cleanHex.length === 3) {
    const r = parseInt(cleanHex[0] + cleanHex[0], 16);
    const g = parseInt(cleanHex[1] + cleanHex[1], 16);
    const b = parseInt(cleanHex[2] + cleanHex[2], 16);
    return { r, g, b };
  } else if (cleanHex.length === 6) {
    const r = parseInt(cleanHex.substring(0, 2), 16);
    const g = parseInt(cleanHex.substring(2, 4), 16);
    const b = parseInt(cleanHex.substring(4, 6), 16);
    return { r, g, b };
  }
  return null;
}

function rgbToHex({ r, g, b }: { r: number; g: number; b: number }): string {
  return `#${[r, g, b].map((channel) => Math.max(0, Math.min(255, Math.round(channel))).toString(16).padStart(2, '0')).join('')}`;
}

function shiftRgb(rgb: { r: number; g: number; b: number }, amount: number) {
  const target = amount >= 0 ? 255 : 0;
  const factor = Math.abs(amount);
  return {
    r: rgb.r + (target - rgb.r) * factor,
    g: rgb.g + (target - rgb.g) * factor,
    b: rgb.b + (target - rgb.b) * factor,
  };
}

function relativeLuminance({ r, g, b }: { r: number; g: number; b: number }): number {
  const linear = (channel: number) => {
    const normalized = channel / 255;
    return normalized <= 0.03928 ? normalized / 12.92 : ((normalized + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * linear(r) + 0.7152 * linear(g) + 0.0722 * linear(b);
}

/** Apply the optional user accent without changing the monochrome surfaces. */
export function applyAccentToCSS(theme: Theme | null): void {
  if (!theme || typeof document === 'undefined') return;
  const root = document.documentElement;
  const configured = get(accentColor).trim();
  const accent = configured && hexToRgb(configured) ? configured : theme.colors['accent'];
  const rgb = hexToRgb(accent);
  if (!rgb) return;

  const isLightTheme = theme.type === 'light';
  const hover = rgbToHex(shiftRgb(rgb, isLightTheme ? -0.14 : 0.14));
  const onAccent = relativeLuminance(rgb) > 0.52 ? '#000000' : '#ffffff';
  const alpha = isLightTheme ? 0.55 : 0.45;

  root.style.setProperty('--accent', accent);
  root.style.setProperty('--accent-rgb', `${rgb.r}, ${rgb.g}, ${rgb.b}`);
  root.style.setProperty('--accent-hover', hover);
  root.style.setProperty('--on-accent', onAccent);
  root.style.setProperty('--button-bg', accent);
  root.style.setProperty('--button-hover-bg', hover);
  root.style.setProperty('--button-text', onAccent);
  root.style.setProperty('--accent-light', `rgba(${rgb.r}, ${rgb.g}, ${rgb.b}, 0.15)`);
  root.style.setProperty('--accent-glow', `rgba(${rgb.r}, ${rgb.g}, ${rgb.b}, 0.08)`);
  // Keep legacy accent tokens in sync so older surfaces do not fall back to
  // a hard-coded hue when a custom accent is selected.
  root.style.setProperty('--accent-color', accent);
  root.style.setProperty('--accent-hover-color', hover);
  root.style.setProperty('--accent-dark', hover);
  root.style.setProperty('--accent-contrast', onAccent);
  root.style.setProperty('--accent-soft', `rgba(${rgb.r}, ${rgb.g}, ${rgb.b}, 0.22)`);
  root.style.setProperty('--selection-bg', `rgba(${rgb.r}, ${rgb.g}, ${rgb.b}, ${isLightTheme ? 0.10 : 0.18})`);
  root.style.setProperty('--editor-lineHighlight', `rgba(${rgb.r}, ${rgb.g}, ${rgb.b}, ${isLightTheme ? 0.03 : 0.04})`);
  root.style.setProperty('--focus-ring', `rgba(${rgb.r}, ${rgb.g}, ${rgb.b}, ${alpha})`);
  root.style.setProperty('--border-focus', `rgba(${rgb.r}, ${rgb.g}, ${rgb.b}, ${alpha})`);
  root.style.setProperty('--input-focus-border', `rgba(${rgb.r}, ${rgb.g}, ${rgb.b}, ${alpha})`);
}

if (typeof window !== 'undefined') {
  accentColor.subscribe(() => {
    applyAccentToCSS(get(activeTheme));
  });
}

/**
 * Apply a foreground text/icon palette to CSS custom properties.
 *
 * Called twice per theme switch:
 *  1. Synchronously with analysis=null so the theme is never unreadable.
 *  2. Asynchronously once the Canvas image sampler has real luminance data.
 *
 * @param analysis - Result from analyseImage(), or null to fall back to type.
 * @param themeType - The theme's declared type ('dark' | 'light').
 */
export function applyForegroundPalette(
  analysis: import('$lib/utils/imageAnalysis').ImageAnalysisResult | null,
  themeType: 'dark' | 'light'
): void {
  if (typeof document === 'undefined') return;
  const root = document.documentElement;

  const palette = deriveForegroundPalette(analysis, themeType);

  root.style.setProperty('--text-primary',       palette.primary);
  root.style.setProperty('--text-secondary',     palette.secondary);
  root.style.setProperty('--text-muted',         palette.muted);
  root.style.setProperty('--text-placeholder',   palette.placeholder);

  // RGB variants so components can do rgba(var(--text-primary-rgb), 0.5)
  for (const [name, hex] of Object.entries(palette)) {
    const rgb = hexToRgb(hex);
    if (rgb) {
      root.style.setProperty(`--text-${name}-rgb`, `${rgb.r}, ${rgb.g}, ${rgb.b}`);
    }
  }

  // Titlebar and statusbar follow the same derived palette
  root.style.setProperty('--titlebar-text', palette.primary);
  const titlebarRgb = hexToRgb(palette.primary);
  if (titlebarRgb) {
    root.style.setProperty('--titlebar-text-rgb', `${titlebarRgb.r}, ${titlebarRgb.g}, ${titlebarRgb.b}`);
  }
  root.style.setProperty('--statusbar-text', palette.secondary);
  const statusbarRgb = hexToRgb(palette.secondary);
  if (statusbarRgb) {
    root.style.setProperty('--statusbar-text-rgb', `${statusbarRgb.r}, ${statusbarRgb.g}, ${statusbarRgb.b}`);
  }

  // Toggle palette class so CSS can target the effective luminance
  const effectivelyDark = analysis !== null ? analysis.isDark : themeType === 'dark';
  root.classList.toggle('bg-palette-dark', effectivelyDark);
  root.classList.toggle('bg-palette-light', !effectivelyDark);
}

let themeTransitionTimeout: any = null;
const THEME_TRANSITION_MS = 420;

// WebKitGTK's tiled compositor sometimes fails to invalidate composited tiles
// when only CSS custom properties change (a theme switch). The stale tiles show
// up as a "square of the previous theme" in the title-bar corners (around the
// app icon and the window-control buttons). Promoting the app subtree to a fresh
// GPU layer and dropping it a frame later forces a full re-rasterization, which
// clears the residue. Targets `.app-shell` (not `:root`) so the fixed wallpaper
// layers — `body::before`/`::after`, which live outside `.app-shell` — are never
// transformed, and modals (portaled to `body`) are unaffected. translateZ(0) is
// visually a no-op.
let repaintRaf: number | null = null;
function forceWebkitRepaint() {
  if (typeof document === 'undefined' || typeof requestAnimationFrame === 'undefined') return;
  const el = document.querySelector<HTMLElement>('.app-shell') ?? document.body;
  if (!el) return;
  if (repaintRaf !== null) cancelAnimationFrame(repaintRaf);
  el.style.transform = 'translateZ(0)';
  repaintRaf = requestAnimationFrame(() => {
    repaintRaf = requestAnimationFrame(() => {
      el.style.transform = '';
      repaintRaf = null;
    });
  });
}

export function applyThemeToCSS(theme: Theme | null) {
  if (!theme || typeof document === 'undefined') return;
  const root = document.documentElement;

  if (theme.type === 'light') {
    root.classList.add('light-theme');
    root.classList.remove('dark-theme');
  } else {
    root.classList.add('dark-theme');
    root.classList.remove('light-theme');
  }

  const isInitialLoad = !root.classList.contains('theme-initialized');
  if (!isInitialLoad) {
    root.classList.add('theme-transitioning');
    void root.offsetHeight;
    if (themeTransitionTimeout) {
      clearTimeout(themeTransitionTimeout);
    }
  } else {
    root.classList.remove('theme-transitioning');
  }

  for (const [key, value] of Object.entries(theme.colors)) {
    root.style.setProperty(`--${key}`, value);
    if (typeof value === 'string') {
      const rgb = hexToRgb(value);
      if (rgb) {
        root.style.setProperty(`--${key}-rgb`, `${rgb.r}, ${rgb.g}, ${rgb.b}`);
      }
    }
  }
  for (const [key, value] of Object.entries(theme.syntax)) {
    root.style.setProperty(`--syntax-${key}`, value);
  }

  applyAccentToCSS(theme);

  // Light and Dark are intentionally image-free. Clear any wallpaper left by
  // an older build before handling other theme/background combinations. A
  // user-selected wallpaper is still allowed in either appearance mode.
  if (isMonochromePresetTheme(theme)) {
    if (userBackgroundActive()) {
      applyBackgroundImage();
    } else {
      root.style.removeProperty('--user-bg-image');
      root.classList.remove('has-bg-image', 'has-bg-media');
      applyBackgroundAppearance(0);
    }
    applyInterfaceFrost(get(interfaceTransparency));
  } else {
    // Apply a custom/theme background for non-monochrome themes, but never over
    // one the user chose.
    //
    // This branch used to run on `theme.backgroundImage` alone, so it overwrote
    // `--user-bg-image` with the preset wallpaper every time a theme was applied:
    // switching theme, or simply reloading (loadThemes runs at boot), silently
    // replaced a background the user had picked. `userBackgroundActive()` is the
    // same question `applyBackgroundImage` asks, so the two agree whichever runs
    // first — the user's wallpaper outranks the theme's, and the `else` below
    // hands painting back to the background store.
    if (theme.backgroundImage && !userBackgroundActive()) {
      root.style.setProperty('--user-bg-image', `url("${theme.backgroundImage}")`);
      root.classList.add('has-bg-image');
      const opacity = theme.backgroundOpacity !== undefined ? theme.backgroundOpacity : 75;
      const blur = theme.backgroundBlur !== undefined ? theme.backgroundBlur : 0;
      root.style.setProperty('--user-bg-opacity', (opacity / 100).toFixed(3));
      root.style.setProperty('--user-bg-blur', `${blur}px`);

      // Force 50% frost transparency when a theme has a built-in background image
      // so the background wallpaper is clearly visible through the glass UI.
      const trans = get(interfaceTransparency);
      if (trans === 0) {
        applyInterfaceFrost(50);
      } else {
        applyInterfaceFrost(trans);
      }
    } else {
      // Revert to global settings-controlled background image if settings active
      const settingsActive = get(backgroundImageEnabled) && hasBackgroundImage();
      if (!settingsActive) {
        root.style.removeProperty('--user-bg-image');
        root.classList.remove('has-bg-image', 'has-bg-media');
        // Restore frost transparency according to global settings
        applyInterfaceFrost(get(interfaceTransparency));
      } else {
        applyBackgroundImage();
        applyBackgroundAppearance(get(backgroundImageBlur));
        applyInterfaceFrost(get(interfaceTransparency));
      }
    }

    // ── Auto-compute foreground text colors for readability ──────
    // Phase 1: Apply an immediate palette based on theme.type so UI is never
    // left in an unreadable state while the async image analysis runs.
    applyForegroundPalette(null, theme.type);

    // Phase 2: If the theme has a background image, sample it with Canvas to
    // get the real luminance and refine the palette asynchronously.  This
    // means dark-on-paper themes that happen to use a very bright wallpaper
    // will still get dark foreground text, and vice-versa.
    if (theme.backgroundImage && !userBackgroundActive()) {
      // Capture the theme id so we don't apply stale results after a switch
      const themeIdAtStart = theme.id;
      analyseImage(theme.backgroundImage).then((analysis) => {
        // Abort if the user has already switched to a different theme
        if (get(activeTheme)?.id !== themeIdAtStart || userBackgroundActive()) return;
        applyForegroundPalette(analysis, theme.type);
      });
    }
  }

  // Plain themes never need image-derived foreground colours.
  if (isMonochromePresetTheme(theme)) applyForegroundPalette(null, theme.type);

  if (isInitialLoad) {
    root.classList.add('theme-initialized');
  } else {
    // Clear the stale composited corner tiles WebKitGTK leaves behind on a
    // theme switch (see forceWebkitRepaint). Only on real switches, not first paint.
    forceWebkitRepaint();
    themeTransitionTimeout = setTimeout(() => {
      root.classList.remove('theme-transitioning');
      themeTransitionTimeout = null;
    }, THEME_TRANSITION_MS);
  }
}
