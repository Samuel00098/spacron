import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { get } from './storeCompat';

/**
 * Precedence between the user's own wallpaper and a preset theme's built-in one.
 *
 * The rule these tests pin: **a background the user chose outranks the theme's.**
 * It has to hold whichever side runs first, because `initBackground()` and
 * `loadThemes()` both fire at boot and neither orders the other.
 *
 * vitest runs `environment: 'node'` here (no jsdom, no testing-library — see
 * `.spacron/memory/agent-placement-gate.md`), so the tests install a minimal
 * `document.documentElement` stub. It only needs to record class names and
 * custom properties, which is exactly what the code under test reads back.
 */

const invokeMock = vi.hoisted(() => vi.fn());
const convertFileSrcMock = vi.hoisted(() => vi.fn((p: string) => `asset://${p}`));

vi.mock('@tauri-apps/api/core', () => ({
  invoke: invokeMock,
  convertFileSrc: convertFileSrcMock,
}));
vi.mock('./notification', () => ({ showToast: vi.fn() }));
// Canvas-based; irrelevant to precedence and unavailable in node.
vi.mock('$lib/utils/imageAnalysis', () => ({
  analyseImage: vi.fn(async () => null),
  // Shape matters — applyForegroundPalette reads these straight into CSS vars.
  deriveForegroundPalette: vi.fn(() => ({
    primary: '#fff',
    secondary: '#ddd',
    muted: '#aaa',
    inverse: '#000',
    shadow: 'none',
  })),
}));

function installDomStub() {
  const classes = new Set<string>();
  const props = new Map<string, string>();
  const root = {
    classList: {
      add: (...names: string[]) => names.forEach((n) => classes.add(n)),
      remove: (...names: string[]) => names.forEach((n) => classes.delete(n)),
      toggle: (name: string, force?: boolean) => {
        const on = force ?? !classes.has(name);
        if (on) classes.add(name);
        else classes.delete(name);
        return on;
      },
      contains: (name: string) => classes.has(name),
    },
    style: {
      setProperty: (k: string, v: string) => props.set(k, v),
      removeProperty: (k: string) => props.delete(k),
      getPropertyValue: (k: string) => props.get(k) ?? '',
    },
    offsetHeight: 0,
  };
  (globalThis as unknown as { document: unknown }).document = { documentElement: root };
  return {
    bgImage: () => props.get('--user-bg-image') ?? '',
    hasClass: (n: string) => classes.has(n),
    property: (name: string) => props.get(name),
  };
}

let dom: ReturnType<typeof installDomStub>;

beforeEach(() => {
  vi.useFakeTimers();
  vi.resetModules();
  invokeMock.mockReset();
  dom = installDomStub();
});

/** Load the stores fresh, with a stored user wallpaper or none. */
async function bootWith(storedBackground: string | null) {
  invokeMock.mockImplementation(async (cmd: string) => {
    if (cmd === 'background_image_get') return storedBackground;
    return null;
  });
  const background = await import('./background');
  const settings = await import('./settings');
  const theme = await import('./theme');
  await background.initBackground();
  return { background, settings, theme };
}

const THEMED = {
  id: 'dark-coastline',
  name: 'Coastline',
  type: 'dark' as const,
  colors: { accent: '#3b82f6' },
  syntax: { keyword: '#c678dd' },
  backgroundImage: '/backgrounds/dark-coastline.webp',
};

describe('user background vs theme background', () => {
  it.each(['forge-light', 'forge-dark'])('keeps the user wallpaper available in %s', async (id) => {
    const { background, settings, theme } = await bootWith('/home/me/wallpaper.png');
    settings.backgroundImageEnabled.set(true);
    background.applyBackgroundImage();
    expect(dom.bgImage()).toContain('wallpaper.png');

    theme.applyThemeToCSS({ ...THEMED, id } as never);

    expect(dom.bgImage()).toContain('wallpaper.png');
    expect(dom.hasClass('has-bg-image')).toBe(true);
    expect(dom.hasClass('has-bg-media')).toBe(true);
    expect(get(settings.backgroundImageEnabled)).toBe(true);
  });

  it("keeps the user's wallpaper when a theme with its own is applied", async () => {
    const { background, settings, theme } = await bootWith('/home/me/wallpaper.png');
    settings.backgroundImageEnabled.set(true);
    background.applyBackgroundImage();
    expect(dom.bgImage()).toContain('wallpaper.png');

    // The regression: this used to overwrite --user-bg-image with the preset.
    theme.applyThemeToCSS(THEMED as never);

    expect(dom.bgImage()).toContain('wallpaper.png');
    expect(dom.bgImage()).not.toContain('dark-coastline');
    expect(dom.hasClass('has-bg-image')).toBe(true);
  });

  it("uses the theme's wallpaper when the user has none", async () => {
    const { theme } = await bootWith(null);

    theme.applyThemeToCSS(THEMED as never);

    expect(dom.bgImage()).toContain('dark-coastline.webp');
    expect(dom.hasClass('has-bg-image')).toBe(true);
  });

  it("uses the theme's wallpaper when the user's is toggled off", async () => {
    const { background, settings, theme } = await bootWith('/home/me/wallpaper.png');
    settings.backgroundImageEnabled.set(false);
    background.applyBackgroundImage();

    theme.applyThemeToCSS(THEMED as never);

    expect(dom.bgImage()).toContain('dark-coastline.webp');
  });

  it("restores the theme's wallpaper when the user removes theirs", async () => {
    const { background, settings, theme } = await bootWith('/home/me/wallpaper.png');
    settings.backgroundImageEnabled.set(true);
    background.applyBackgroundImage();
    // The theme is active underneath, just outranked.
    const { useThemeStore } = await import('./zustand/theme');
    useThemeStore.setState({ activeTheme: THEMED } as never);
    expect(dom.bgImage()).toContain('wallpaper.png');

    await background.removeBackgroundImage();

    // Used to leave the cleared user file in place, showing a blank layer.
    expect(dom.bgImage()).toContain('dark-coastline.webp');
    expect(dom.hasClass('has-bg-image')).toBe(true);
    void theme;
  });

  it('clears the layer entirely when neither the user nor the theme has one', async () => {
    const { background, settings } = await bootWith(null);
    settings.backgroundImageEnabled.set(false);

    background.applyBackgroundImage();

    expect(dom.bgImage()).toBe('');
    expect(dom.hasClass('has-bg-image')).toBe(false);
  });
});

describe('custom background toggle', () => {
  it.each(['dark', 'light'] as const)('restores the %s theme and custom image across toggles', async (type) => {
    vi.useFakeTimers();
    const { background, settings, theme } = await bootWith('/home/me/wallpaper.png');
    theme.activeTheme.set({ ...THEMED, type, backgroundBlur: 2 } as never);
    settings.backgroundImageBlur.set(18);
    // Same subscription as App: changing the setting must repaint immediately.
    const unsubscribe = settings.backgroundImageEnabled.subscribe(() => background.applyBackgroundImage());
    try {
      settings.backgroundImageEnabled.set(true);
      await vi.advanceTimersByTimeAsync(50);
      expect(dom.bgImage()).toContain('wallpaper.png');
      expect(dom.property('--user-bg-blur')).toBe('18px');
      expect(dom.hasClass('has-bg-media')).toBe(true);

      settings.backgroundImageEnabled.set(false);
      await vi.advanceTimersByTimeAsync(50);
      expect(dom.bgImage()).toContain('dark-coastline.webp');
      expect(dom.property('--user-bg-blur')).toBe('2px');
      expect(dom.hasClass(`bg-palette-${type}`)).toBe(true);
      expect(dom.hasClass('has-bg-media')).toBe(false);
      expect(background.hasBackgroundImage()).toBe(true);
      expect(invokeMock).not.toHaveBeenCalledWith('background_image_clear');

      settings.backgroundImageEnabled.set(true);
      await vi.advanceTimersByTimeAsync(50);
      expect(dom.bgImage()).toContain('wallpaper.png');
      expect(dom.property('--user-bg-blur')).toBe('18px');
      expect(dom.hasClass('has-bg-media')).toBe(true);
    } finally {
      unsubscribe();
      vi.useRealTimers();
    }
  });

  it('ignores preset analysis that finishes after custom background is enabled', async () => {
    const { background, settings, theme } = await bootWith('/home/me/wallpaper.png');
    const { analyseImage } = await import('$lib/utils/imageAnalysis');
    let resolveAnalysis!: (value: any) => void;
    vi.mocked(analyseImage).mockImplementationOnce(() => new Promise((resolve) => { resolveAnalysis = resolve; }));
    theme.activeTheme.set(THEMED as never);
    background.applyBackgroundImage();
    settings.backgroundImageEnabled.set(true);
    background.applyBackgroundImage();
    resolveAnalysis({ isDark: false });
    await Promise.resolve();
    expect(dom.hasClass('bg-palette-dark')).toBe(true);
    expect(dom.hasClass('bg-palette-light')).toBe(false);
    expect(dom.bgImage()).toContain('wallpaper.png');
  });
});

afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
});

describe('legacy video wallpapers', () => {
  it('recognises the formats a previous version allowed', async () => {
    const { background } = await bootWith(null);
    for (const p of ['/a/clip.mp4', '/a/clip.WEBM', '/a/clip.mov', '/a/clip.m4v', '/a/clip.ogv']) {
      expect(background.isLegacyVideoBackground(p)).toBe(true);
    }
    for (const p of ['/a/shot.png', '/a/shot.webp', '/a/shot.avif', '/a/shot.jpg']) {
      expect(background.isLegacyVideoBackground(p)).toBe(false);
    }
  });

  it('clears a stored video instead of handing it to background-image', async () => {
    // Handing an .mp4 to CSS background-image renders nothing, which reads as
    // "my wallpaper vanished" rather than "video is no longer supported".
    const { background, settings } = await bootWith('/home/me/loop.mp4');

    const { get } = await import('$lib/stores/storeCompat');
    expect(invokeMock).toHaveBeenCalledWith('background_image_clear');
    expect(background.hasBackgroundImage()).toBe(false);
    expect(get(settings.backgroundImageEnabled)).toBe(false);
    expect(dom.bgImage()).not.toContain('loop.mp4');
  });
});
