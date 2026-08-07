/**
 * imageAnalysis.ts
 *
 * Smart image-colour sampler that reads the pixel data of a background image
 * and returns perceptual luminance + dominant-hue information.  The result is
 * used by applyThemeToCSS() to derive foreground text / icon colours that are
 * always legible regardless of how bright or dark the wallpaper happens to be.
 *
 * The analysis is intentionally lightweight: we draw a tiny 32×32 thumbnail
 * into an OffscreenCanvas (or a regular <canvas> as fallback) and average the
 * relative luminance of every pixel.  That's fast enough to run on every
 * theme switch without any perceptible lag.
 */

export interface ImageAnalysisResult {
  /** Relative luminance 0–1 (0 = pitch black, 1 = pure white) */
  luminance: number;
  /** true when the image is predominantly dark */
  isDark: boolean;
  /** Dominant hue in degrees 0–360, or -1 if the image is essentially grey */
  dominantHue: number;
  /** Average RGB of the image */
  avgR: number;
  avgG: number;
  avgB: number;
}

/** Size of the thumbnail we analyse.  Larger = more accurate but slower. */
const SAMPLE_SIZE = 32;

/** Gamma-correct sRGB component → linear */
function toLinear(v: number): number {
  const c = v / 255;
  return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
}

/** WCAG relative luminance from linear RGB components */
function relativeLuminance(r: number, g: number, b: number): number {
  return 0.2126 * toLinear(r) + 0.7152 * toLinear(g) + 0.0722 * toLinear(b);
}

/** Convert RGB → Hue (0–360), returns -1 if chroma is too low */
function rgbToHue(r: number, g: number, b: number): number {
  const R = r / 255, G = g / 255, B = b / 255;
  const max = Math.max(R, G, B), min = Math.min(R, G, B);
  const delta = max - min;
  if (delta < 0.05) return -1; // essentially grey
  let h = 0;
  if (max === R) h = ((G - B) / delta + (G < B ? 6 : 0)) / 6;
  else if (max === G) h = ((B - R) / delta + 2) / 6;
  else h = ((R - G) / delta + 4) / 6;
  return Math.round(h * 360);
}

/** Cache so we don't re-analyse the same URL on every re-render */
const cache = new Map<string, ImageAnalysisResult>();
const CACHE_MAX = 20;
function trimCache() {
  if (cache.size <= CACHE_MAX) return;
  const toDelete = [...cache.keys()].slice(0, cache.size - CACHE_MAX);
  for (const k of toDelete) cache.delete(k);
}

/**
 * Analyse an image URL and return colour metrics.
 * Returns null if the image cannot be loaded (CORS, filesystem error, etc.).
 */
export async function analyseImage(url: string): Promise<ImageAnalysisResult | null> {
  if (cache.has(url)) return cache.get(url)!;

  return new Promise((resolve) => {
    const img = new Image();
    img.crossOrigin = 'anonymous';

    img.onload = () => {
      try {
        // Draw a tiny thumbnail so pixel iteration is fast
        let ctx: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D;
        let canvas: HTMLCanvasElement | OffscreenCanvas;

        if (typeof OffscreenCanvas !== 'undefined') {
          canvas = new OffscreenCanvas(SAMPLE_SIZE, SAMPLE_SIZE);
          ctx = (canvas as OffscreenCanvas).getContext('2d') as OffscreenCanvasRenderingContext2D;
        } else {
          canvas = document.createElement('canvas');
          (canvas as HTMLCanvasElement).width = SAMPLE_SIZE;
          (canvas as HTMLCanvasElement).height = SAMPLE_SIZE;
          ctx = (canvas as HTMLCanvasElement).getContext('2d') as CanvasRenderingContext2D;
        }

        ctx.drawImage(img, 0, 0, SAMPLE_SIZE, SAMPLE_SIZE);
        const { data } = ctx.getImageData(0, 0, SAMPLE_SIZE, SAMPLE_SIZE);

        let totalLum = 0, totalR = 0, totalG = 0, totalB = 0;
        const pixels = SAMPLE_SIZE * SAMPLE_SIZE;

        for (let i = 0; i < data.length; i += 4) {
          const r = data[i], g = data[i + 1], b = data[i + 2];
          totalLum += relativeLuminance(r, g, b);
          totalR += r; totalG += g; totalB += b;
        }

        const luminance = totalLum / pixels;
        const avgR = Math.round(totalR / pixels);
        const avgG = Math.round(totalG / pixels);
        const avgB = Math.round(totalB / pixels);
        const dominantHue = rgbToHue(avgR, avgG, avgB);
        const isDark = luminance < 0.35;

        const result: ImageAnalysisResult = { luminance, isDark, dominantHue, avgR, avgG, avgB };
        cache.set(url, result);
        trimCache();
        resolve(result);
      } catch {
        // Canvas taint or other error — fall back gracefully
        resolve(null);
      }
    };

    img.onerror = () => resolve(null);
    img.src = url;
  });
}

/**
 * Given an ImageAnalysisResult (or null if the image couldn't be read) and
 * the theme's declared type, derive the best foreground text / icon palette.
 *
 * The logic:
 *  1. If we have real image data, use the measured luminance to decide.
 *  2. Otherwise fall back to the theme's declared type.
 *
 * We return four levels: primary, secondary, muted, placeholder.
 */
export function deriveForegroundPalette(
  analysis: ImageAnalysisResult | null,
  themeType: 'dark' | 'light'
): { primary: string; secondary: string; muted: string; placeholder: string } {
  // Determine if the *effective* background is dark or light.
  // Prefer real measured luminance; fall back to the theme's type tag.
  const effectivelyDark = analysis !== null ? analysis.isDark : themeType === 'dark';

  // These two ramps are the same ones global.css pins under
  // `html.has-bg-image.bg-palette-*`, and they must stay in step with it.
  //
  // That duplication is not redundant — it is the only path that reaches a
  // *solid* theme. Those CSS rules are gated on a wallpaper class, so with no
  // wallpaper (forge-dark / forge-light, which is what ships) nothing overrides
  // what this function writes inline, and the app ran on the old washed-out
  // values below while every wallpaper preset got the crisp ones. That is why
  // the bundled themes looked flat next to the presets.
  //
  // Both ramps are pinned to a true endpoint rather than the near-white /
  // near-black they used to sit at, and the lower steps come up with them:
  // muted was the worst offender at ~3.2:1 in both modes, which is under the
  // 4.5:1 body text needs and is what read as "greyed out".
  if (effectivelyDark) {
    // Background is dark → foreground must be bright.
    // On #18181e: 17.7:1 / 11.2:1 / 5.6:1.
    return {
      primary:     '#ffffff',
      secondary:   '#cdcdda',
      muted:       '#8f8fa2',
      placeholder: '#5c5c6e',
    };
  } else {
    // Background is light → foreground must be dark.
    // On #fafafa: 20.1:1 / 13.6:1 / 6.3:1.
    return {
      primary:     '#000000',
      secondary:   '#2a2a35',
      muted:       '#5c5c6a',
      placeholder: '#9a9aa8',
    };
  }
}

/**
 * Derive a glass-panel background color for theme cards / overlaid UI
 * that is readable against the given background image analysis.
 *
 * Returns a CSS `rgba(...)` string.
 */
export function deriveGlassBackground(
  bgPrimary: string,
  analysis: ImageAnalysisResult | null,
  themeType: 'dark' | 'light'
): string {
  const effectivelyDark = analysis !== null ? analysis.isDark : themeType === 'dark';

  // Parse the theme's own bg-primary hex to use as the glass tint
  const hexMatch = bgPrimary.replace(/^#/, '');
  let r = 0, g = 0, b = 0;
  if (hexMatch.length === 6) {
    r = parseInt(hexMatch.substring(0, 2), 16);
    g = parseInt(hexMatch.substring(2, 4), 16);
    b = parseInt(hexMatch.substring(4, 6), 16);
  }

  // For dark backgrounds, use a slightly opaque dark glass.
  // For light backgrounds, use a slightly opaque light glass.
  const alpha = effectivelyDark ? 0.72 : 0.76;
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}
