/**
 * Global UI scaling — make the whole interface grow and shrink with the window.
 *
 * The app is laid out in fixed pixels (see styles/global.css: `body { font-size:
 * 15px }` and px sizing throughout), so without this the UI stays one physical
 * size regardless of the window: cramped when the window is small, sparse and
 * tiny when maximised or on a large display. We can't retrofit every panel to
 * rem overnight, so instead we apply a single clamped `zoom` to the document
 * root, recomputed from the window size. `zoom` (unlike `transform: scale`)
 * reflows layout and scales body-portaled overlays (modals, dropdowns, tooltips)
 * too, since they live under the same root.
 *
 * The scale is the smaller of the width- and height-ratios against a design
 * baseline, so growing never overflows the shorter axis, and it's clamped so the
 * UI is never absurdly big or unreadably small — "arranged in the appropriate
 * sizes" at every window size.
 */

// Window size at which the UI renders at its natural 1.0 scale. Matches the
// default window in tauri.conf.json (1200×800), trimmed slightly on height so a
// standard laptop screen sits right around 1.0 rather than shrunk.
const DESIGN_WIDTH = 1200;
const DESIGN_HEIGHT = 780;

// Keep the interface within a sane band: at the 960×640 minimum window it
// settles near MIN; on large/maximised windows it grows up to MAX.
const MIN_SCALE = 0.82;
const MAX_SCALE = 1.28;

function computeScale(width: number, height: number): number {
  const raw = Math.min(width / DESIGN_WIDTH, height / DESIGN_HEIGHT);
  const clamped = Math.min(MAX_SCALE, Math.max(MIN_SCALE, raw));
  // Round to 3 dp so tiny resize jitters don't thrash layout / terminal refits.
  return Math.round(clamped * 1000) / 1000;
}

let lastApplied = -1;
let rafId = 0;

function applyScale(): void {
  const scale = computeScale(window.innerWidth, window.innerHeight);
  if (scale === lastApplied) return;
  lastApplied = scale;

  // Publish the value as a custom property. The actual `zoom` is applied in CSS
  // to `#app` (see styles/global.css), sized 100%×100%: standardized CSS zoom
  // resolves percentages in the zoomed coordinate space, so the app fills the
  // window exactly at any scale. Raw vw/vh units do NOT self-compensate this
  // way — inside #app use the corrected --app-vw/--app-vh vars instead.
  document.documentElement.style.setProperty('--ui-scale', String(scale));

  // Nudge size-driven layout (xterm FitAddon, overlay-clearance observers) to
  // recompute against the new rendered size. Cheap and idempotent.
  window.dispatchEvent(new Event('resize'));
}

function onResize(): void {
  if (rafId) return;
  rafId = window.requestAnimationFrame(() => {
    rafId = 0;
    applyScale();
  });
}

/**
 * Start scaling the UI to the window and keep it in sync on resize. Safe to call
 * once at startup; a no-op outside the browser.
 */
export function initUiScale(): void {
  if (typeof window === 'undefined' || typeof document === 'undefined') return;
  applyScale();
  window.addEventListener('resize', onResize, { passive: true });
}
