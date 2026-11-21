import { get, writable } from '$lib/stores/storeCompat';
import { convertFileSrc, invoke } from '@tauri-apps/api/core';
import { backgroundImageEnabled, interfaceTransparency, backgroundImageBlur, backgroundGlassOpacity } from './settings';
import { showToast } from './notification';
import { useBackgroundStore } from './zustand/background';
import { useThemeStore } from './zustand/theme';
import { analyseImage } from '$lib/utils/imageAnalysis';
import { applyForegroundPalette } from './theme';

function syncWritable<T>(key: string, defaultValue: T): import('$lib/stores/storeCompat').Writable<T> {
  const zustandVal = (useBackgroundStore.getState() as any)[key];
  const initial = zustandVal !== undefined ? zustandVal as T : defaultValue;
  const store = writable<T>(initial);
  void useBackgroundStore.subscribe((state) => {
    const next = (state as any)[key] as T | undefined;
    if (next !== undefined) store.set(next);
  });
  return {
    subscribe: store.subscribe,
    set(value: T) { (useBackgroundStore.getState() as any).__set(key, value); },
    update(fn: (val: T) => T) {
      const current = (useBackgroundStore.getState() as any)[key] as T;
      (useBackgroundStore.getState() as any).__set(key, fn(current));
    },
  };
}

export const backgroundImagePresent = syncWritable<boolean>('backgroundImagePresent', false);

let currentAssetUrl: string | null = null;
let backgroundAppearanceVersion = 0;

/**
 * Formats the picker accepts. Deliberately short: these four cover every real
 * wallpaper and all decode reliably in the webview.
 *
 * Dropped on purpose — `svg` is an active document format aimed at the app's own
 * chrome, and `heic`/`heif`/`tiff`/`tif`/`ico`/`bmp` decode inconsistently
 * across platforms, so they failed in ways users reported as bugs.
 */
const IMAGE_EXTENSIONS = ['png', 'jpg', 'jpeg', 'webp', 'avif'];

/**
 * Video wallpapers were removed (see [[background-wallpapers]]): a looping
 * 2560×1440 video behind a terminal holds the GPU awake for the whole session,
 * stacked on top of the panels' own backdrop blur. Kept only to recognise a
 * background a previous version stored, so it can be cleared instead of being
 * handed to `background-image` — which renders nothing and reads as "my
 * wallpaper vanished".
 */
const LEGACY_VIDEO_EXTENSIONS = new Set(['mp4', 'webm', 'm4v', 'mov', 'ogv']);

function withCacheToken(assetUrl: string, token: string): string {
  return `${assetUrl}${assetUrl.includes('?') ? '&' : '?'}v=${encodeURIComponent(token)}`;
}

export function isLegacyVideoBackground(filePath: string): boolean {
  const cleanPath = filePath.split(/[?#]/, 1)[0] ?? filePath;
  const ext = cleanPath.split('.').pop()?.toLowerCase() ?? '';
  return LEGACY_VIDEO_EXTENSIONS.has(ext);
}

function setCurrent(filePath: string | null, cacheToken = `${Date.now()}`) {
  currentAssetUrl = filePath ? withCacheToken(convertFileSrc(filePath), cacheToken) : null;
  backgroundImagePresent.set(filePath !== null);
}

export async function initBackground(): Promise<void> {
  applyInterfaceFrost(get(interfaceTransparency));
  applyBackgroundAppearance(get(backgroundImageBlur));
  try {
    const storedBackground = await invoke<string | null>('background_image_get');
    // A wallpaper stored by a version that still supported video would now be
    // handed to `background-image`, which silently renders nothing. Clear it
    // once so the user gets their theme back rather than a blank pane.
    if (storedBackground !== null && isLegacyVideoBackground(storedBackground)) {
      await removeBackgroundImage();
      showToast('Video wallpapers are no longer supported. Pick an image instead.', 'info', 8000);
      return;
    }
    setCurrent(storedBackground);
    // Load the stored media but DON'T force the enabled toggle on. Whether the
    // background shows is the user's persisted choice (set true by
    // chooseBackgroundImage, false by the Settings toggle / removeBackgroundImage)
    // — overriding it here from "a file exists on disk" is what made a toggled-off
    // background reappear on every restart. If the file went missing, fall the
    // toggle off so a stale "on" doesn't leave the app trying to show nothing.
    if (storedBackground === null) {
      backgroundImageEnabled.set(false);
    }
  } catch (e) {
    console.error('Failed to load background image:', e);
    setCurrent(null);
  }
  applyBackgroundImage();
}

export async function chooseBackgroundImage(): Promise<void> {
  const { open } = await import('@tauri-apps/plugin-dialog');
  const selected = await open({
    multiple: false,
    directory: false,
    filters: [{ name: 'Background image', extensions: IMAGE_EXTENSIONS }],
  });
  if (!selected || typeof selected !== 'string') return;

  try {
    setCurrent(await invoke<string>('background_image_set', { srcPath: selected }));
    backgroundImageEnabled.set(true);
    applyBackgroundImage();
    showToast('Background image applied', 'success');
  } catch (e: any) {
    showToast(`Failed to set background: ${e?.message || e}`, 'error');
  }
}

export async function removeBackgroundImage(): Promise<void> {
  try {
    await invoke('background_image_clear');
  } catch (e) {
    console.error('Failed to clear background image:', e);
  }
  setCurrent(null);
  backgroundImageEnabled.set(false);
  applyBackgroundImage();
}

export function hasBackgroundImage(): boolean {
  return currentAssetUrl !== null;
}

/** The active theme's own wallpaper, when it declares one. */
function activeThemeBackground(): string | null {
  const theme = (useThemeStore.getState() as { activeTheme?: { id?: string; backgroundImage?: string } })
    .activeTheme;
  // Forge Light/Dark are solid monochrome modes. Ignore wallpaper fields that
  // may have been persisted by an older build.
  if (theme?.id === 'forge-light' || theme?.id === 'forge-dark') return null;
  return theme?.backgroundImage || null;
}

/**
 * Whether the user's own wallpaper should be showing. This is the precedence
 * rule, and `applyThemeToCSS` asks the same question before painting a theme's
 * built-in background — so whichever of the two runs first, the answer is the
 * same: **a background the user chose outranks the theme's.**
 */
export function userBackgroundActive(): boolean {
  return get(backgroundImageEnabled) && currentAssetUrl !== null;
}

export function applyBackgroundImage(): void {
  if (typeof document === 'undefined') return;
  const root = document.documentElement;
  const theme = useThemeStore.getState().activeTheme;
  // A custom wallpaper belongs to the user, not to a preset theme. It remains
  // available when switching between the solid Light and Dark appearances.
  const active = userBackgroundActive();
  const version = ++backgroundAppearanceVersion;
  const themeType = theme?.type ?? 'dark';

  if (active) {
    root.style.setProperty('--user-bg-image', `url("${currentAssetUrl}")`);
    root.classList.add('has-bg-image');
  } else {
    // No custom wallpaper. A preset theme can own the background via
    // theme.backgroundImage, so fall back to it rather than clearing outright —
    // initBackground() runs alongside loadThemes() at boot, and this used to
    // unconditionally strip has-bg-image, wiping the preset background
    // loadThemes() had just set.
    //
    // Re-asserting the theme's URL (rather than only leaving the property alone)
    // is what makes REMOVAL work: on remove, `--user-bg-image` still pointed at
    // the user's now-cleared file, so the theme's wallpaper never came back and
    // the app showed a blank layer.
    const themeBg = activeThemeBackground();
    if (themeBg) {
      root.style.setProperty('--user-bg-image', `url("${themeBg}")`);
      root.classList.add('has-bg-image');
    } else {
      root.style.removeProperty('--user-bg-image');
      root.classList.remove('has-bg-image');
    }
  }

  root.classList.toggle('has-bg-media', active);
  applyWallpaperGlass(get(backgroundGlassOpacity));
  // The glass look needs the frosted pipeline (live backdrop blur, translucent
  // surface tokens), which a transparency of 0 switches off. Re-run the frost
  // so turning the image on or off flips between glass and solid at once.
  applyInterfaceFrost(get(interfaceTransparency));
  // Restore the entire visible background, not just its URL. The custom blur
  // remains saved so enabling the image again restores the user's choice.
  applyBackgroundAppearance(active ? get(backgroundImageBlur) : (theme?.backgroundBlur ?? 0));
  applyForegroundPalette(null, themeType);

  // Custom-image panels keep their theme palette. Only the preset wallpaper
  // uses sampled colours, and a later toggle/theme change invalidates the work.
  if (!active && theme?.backgroundImage) {
    analyseImage(theme.backgroundImage).then((analysis) => {
      if (version !== backgroundAppearanceVersion || userBackgroundActive()) return;
      if (useThemeStore.getState().activeTheme !== theme) return;
      applyForegroundPalette(analysis, themeType);
    });
  }
}

let frostTimeout: any = null;
let lastFrostRun = 0;

export function applyInterfaceFrost(transparency: number): void {
  if (typeof document === 'undefined') return;

  const now = Date.now();
  const throttleMs = 40;

  const run = () => {
    const root = document.documentElement;
    // A custom image always gets glass panels — that is the point of setting
    // one. The slider's 0 ("solid") would otherwise kill every backdrop blur
    // and leave see-through panels with nothing frosting the image behind the
    // text. Same fallback the preset wallpapers use in `theme.ts`.
    if (transparency === 0 && userBackgroundActive()) transparency = 50;
    if (transparency === 0) {
      root.classList.add('solid-theme');
      root.style.setProperty('--frost-base', '1.000');
      root.style.setProperty('--frost-chrome', '1.000');
      root.style.setProperty('--frost-surface', '1.000');
      root.style.setProperty('--glass-blur', '0px');
      root.style.setProperty('--glass-saturate', '100%');
    } else {
      root.classList.remove('solid-theme');
      const t = Math.min(100, Math.max(0, transparency)) / 100;

      // Make the glass layers translucent (guarantees readability even at 100% transparency)
      const base = 0.84 - t * 0.28; // At t=1, base is 0.56
      const chrome = Math.min(0.92, base + 0.08); // At t=1, chrome is 0.64
      const surface = Math.min(0.95, base + 0.16); // At t=1, surface is 0.72

      // Apple's liquid glass relies on deep blur to maintain text readability.
      // We scale the blur *upwards* as transparency increases, from 30px to 50px.
      const blur = 30 + t * 20;
      
      // We also boost saturation (from 170% up to 250%) to make backgrounds pop.
      const saturate = 170 + t * 70;

      root.style.setProperty('--frost-base', base.toFixed(3));
      root.style.setProperty('--frost-chrome', chrome.toFixed(3));
      root.style.setProperty('--frost-surface', surface.toFixed(3));
      root.style.setProperty('--glass-blur', `${blur.toFixed(1)}px`);
      root.style.setProperty('--glass-saturate', `${saturate.toFixed(0)}%`);
    }
    lastFrostRun = Date.now();
    frostTimeout = null;
  };

  if (frostTimeout) {
    clearTimeout(frostTimeout);
    frostTimeout = null;
  }

  const timeSinceLastRun = now - lastFrostRun;
  if (timeSinceLastRun >= throttleMs) {
    run();
  } else {
    frostTimeout = setTimeout(run, throttleMs - timeSinceLastRun);
  }
}

/**
 * How solid the glass panels are over a custom image (30–100%; 100 is a fully
 * solid panel, the image only showing between them). Light mode sits 10 points
 * more solid than dark, up to solid: dark ink needs a brighter field under it than
 * light ink needs a dark one, because a dark wallpaper pocket costs dark text
 * more contrast than a bright pocket costs light text.
 */
export function applyWallpaperGlass(percent: number): void {
  if (typeof document === 'undefined') return;
  const p = Math.min(100, Math.max(30, Number.isFinite(percent) ? percent : 60)) / 100;
  const root = document.documentElement;
  root.style.setProperty('--wallpaper-glass-dark', p.toFixed(2));
  root.style.setProperty('--wallpaper-glass-light', Math.min(1, p + 0.1).toFixed(2));
}

// Keep the live glass surfaces in sync as the Settings slider changes. The
// persisted value alone does not repaint CSS custom properties.
backgroundGlassOpacity.subscribe(applyWallpaperGlass);

let appearanceTimeout: any = null;
let lastAppearanceRun = 0;

export function applyBackgroundAppearance(blurPx: number): void {
  if (typeof document === 'undefined') return;

  const now = Date.now();
  const throttleMs = 40;

  const run = () => {
    const root = document.documentElement;
    const b = Math.min(60, Math.max(0, blurPx));
    // Background image is always fully solid — opacity is fixed at 1 in CSS.
    // Only the blur is controllable.
    root.style.setProperty('--user-bg-blur', `${b}px`);
    lastAppearanceRun = Date.now();
    appearanceTimeout = null;
  };

  if (appearanceTimeout) {
    clearTimeout(appearanceTimeout);
    appearanceTimeout = null;
  }

  const timeSinceLastRun = now - lastAppearanceRun;
  if (timeSinceLastRun >= throttleMs) {
    run();
  } else {
    appearanceTimeout = setTimeout(run, throttleMs - timeSinceLastRun);
  }
}
