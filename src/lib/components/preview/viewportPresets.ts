// Device presets for the preview's responsive mode.
//
// Deliberately no device *chassis*: like Chrome/Edge device mode, Firefox's
// Responsive Design Mode and Safari's Responsive Design Mode, the preview is a
// plain resizable rectangle. The only thing that changes how a page lays out is
// the CSS-pixel size of the viewport, so a bezel is decoration that eats space
// and makes the frame smaller than the size printed on it.
//
// Sizes are CSS pixels (the logical viewport), matching Chrome DevTools' own
// preset list — not physical device pixels.

export type ViewportCategory = 'phone' | 'tablet' | 'desktop';

export interface ViewportPreset {
  id: string;
  label: string;
  width: number;
  height: number;
  category: ViewportCategory;
}

export const VIEWPORT_PRESETS: ViewportPreset[] = [
  { id: 'iphone-se', label: 'iPhone SE', width: 375, height: 667, category: 'phone' },
  { id: 'iphone-12-pro', label: 'iPhone 12 Pro', width: 390, height: 844, category: 'phone' },
  { id: 'iphone-14-pro-max', label: 'iPhone 14 Pro Max', width: 430, height: 932, category: 'phone' },
  { id: 'pixel-7', label: 'Pixel 7', width: 412, height: 915, category: 'phone' },
  { id: 'galaxy-s8', label: 'Galaxy S8+', width: 360, height: 740, category: 'phone' },
  { id: 'galaxy-fold', label: 'Galaxy Z Fold 5', width: 344, height: 882, category: 'phone' },
  { id: 'ipad-mini', label: 'iPad Mini', width: 768, height: 1024, category: 'tablet' },
  { id: 'ipad-air', label: 'iPad Air', width: 820, height: 1180, category: 'tablet' },
  { id: 'ipad-pro', label: 'iPad Pro 11"', width: 834, height: 1194, category: 'tablet' },
  { id: 'surface-pro', label: 'Surface Pro 7', width: 912, height: 1368, category: 'tablet' },
  { id: 'laptop', label: 'Laptop', width: 1280, height: 800, category: 'desktop' },
  { id: 'laptop-l', label: 'Laptop L', width: 1440, height: 900, category: 'desktop' },
];

/** Marker id used when the size no longer matches any preset (hand-resized). */
export const CUSTOM_PRESET_ID = 'custom';

export const DEFAULT_PHONE_PRESET = 'iphone-12-pro';
export const DEFAULT_TABLET_PRESET = 'ipad-mini';

export const MIN_VIEWPORT = 200;
export const MAX_VIEWPORT = 4000;

export const ZOOM_LEVELS = [0.5, 0.75, 1, 1.25, 1.5] as const;

export function findPreset(id: string): ViewportPreset | undefined {
  return VIEWPORT_PRESETS.find((preset) => preset.id === id);
}

export function clampViewportEdge(value: number): number {
  if (!Number.isFinite(value)) return MIN_VIEWPORT;
  return Math.min(MAX_VIEWPORT, Math.max(MIN_VIEWPORT, Math.round(value)));
}

/** The preset whose dimensions match this size in either orientation, if any. */
export function matchPreset(width: number, height: number): ViewportPreset | undefined {
  return VIEWPORT_PRESETS.find(
    (preset) =>
      (preset.width === width && preset.height === height) ||
      (preset.width === height && preset.height === width),
  );
}
