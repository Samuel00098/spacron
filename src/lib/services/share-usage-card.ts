/**
 * The shareable usage card — Orca's `ShareUsageCard`, drawn rather than
 * screenshotted.
 *
 * Orca renders a React node and rasterises it with `html-to-image`'s `toPng`.
 * That dependency buys one card here, and it is the fragile kind: it inlines
 * computed styles and re-fetches every referenced font and image through the
 * page's CSP, which an Artifact-style locked-down webview does not always
 * allow. This module draws the same card with the canvas 2D API instead — no
 * new dependency, no style cloning, and the output is identical on every
 * platform because nothing about it depends on the DOM.
 *
 * The trade is that layout is manual, so the card is deliberately a fixed
 * composition: a masthead, a 2×2 figure grid, an optional activity strip, and
 * a footer. Anything that needs to reflow does not belong on it.
 */

/** Logical card size. Rendered at `SCALE`× for a crisp result when pasted. */
export const CARD_WIDTH = 480;
export const CARD_HEIGHT = 300;
const SCALE = 2;

export interface ShareCardFigure {
  label: string;
  value: string;
}

export interface ShareCardData {
  /** Masthead line: "Usage · all time", "Claude · last 30 days". */
  subtitle: string;
  /** Exactly four, drawn as a 2×2 grid. Fewer leaves gaps; more is ignored. */
  figures: ShareCardFigure[];
  /** Optional strip under the grid — the activity totals, when recorded. */
  activity?: string | null;
  /** Bottom-left provenance line. */
  footnote: string;
}

/**
 * The card's palette.
 *
 * Fixed rather than read from CSS variables: a shared image outlives the theme
 * it was made in, and a card exported under a light theme onto a dark
 * background (or vice versa) is unreadable. Every theme exports the same card.
 * The greys mirror Nightglass's graphite accent — see accent-and-icon-treatment
 * in `.spacron/memory/` — so it still reads as this app's artefact.
 */
const INK = {
  background: '#0d0f12',
  panel: '#16191e',
  border: '#262b33',
  text: '#f2f4f7',
  muted: '#8b949e',
  accent: '#d7dce4',
};

const FONT_STACK =
  '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif';

function roundedRect(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  r: number
) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

/**
 * Truncate to fit `maxWidth`, measuring as it goes.
 *
 * Canvas has no text overflow, so an over-long project name would otherwise
 * draw straight through the card's edge and out of the image.
 */
function fitText(ctx: CanvasRenderingContext2D, text: string, maxWidth: number): string {
  if (ctx.measureText(text).width <= maxWidth) return text;
  let clipped = text;
  while (clipped.length > 1 && ctx.measureText(`${clipped}…`).width > maxWidth) {
    clipped = clipped.slice(0, -1);
  }
  return `${clipped}…`;
}

/** Draw the card into a canvas at 2× and hand it back. */
export function drawShareCard(data: ShareCardData): HTMLCanvasElement {
  const canvas = document.createElement('canvas');
  canvas.width = CARD_WIDTH * SCALE;
  canvas.height = CARD_HEIGHT * SCALE;
  const ctx = canvas.getContext('2d');
  if (!ctx) return canvas;
  ctx.scale(SCALE, SCALE);

  // Ground.
  ctx.fillStyle = INK.background;
  ctx.fillRect(0, 0, CARD_WIDTH, CARD_HEIGHT);

  // A soft top-left wash, so the card is not a flat rectangle.
  const wash = ctx.createLinearGradient(0, 0, CARD_WIDTH, CARD_HEIGHT);
  wash.addColorStop(0, 'rgba(215, 220, 228, 0.08)');
  wash.addColorStop(0.55, 'rgba(215, 220, 228, 0)');
  ctx.fillStyle = wash;
  ctx.fillRect(0, 0, CARD_WIDTH, CARD_HEIGHT);

  const pad = 26;

  // Masthead.
  ctx.fillStyle = INK.text;
  ctx.font = `600 19px ${FONT_STACK}`;
  ctx.textBaseline = 'alphabetic';
  ctx.fillText('Spacron', pad, pad + 16);

  ctx.fillStyle = INK.muted;
  ctx.font = `500 11px ${FONT_STACK}`;
  ctx.fillText(fitText(ctx, data.subtitle.toUpperCase(), CARD_WIDTH - pad * 2), pad, pad + 33);

  // Hairline under the masthead.
  ctx.fillStyle = INK.border;
  ctx.fillRect(pad, pad + 45, CARD_WIDTH - pad * 2, 1);

  // 2×2 figure grid.
  const gridTop = pad + 60;
  const gap = 10;
  const cellW = (CARD_WIDTH - pad * 2 - gap) / 2;
  const cellH = 62;

  data.figures.slice(0, 4).forEach((figure, i) => {
    const x = pad + (i % 2) * (cellW + gap);
    const y = gridTop + Math.floor(i / 2) * (cellH + gap);

    ctx.fillStyle = INK.panel;
    roundedRect(ctx, x, y, cellW, cellH, 10);
    ctx.fill();
    ctx.strokeStyle = INK.border;
    ctx.lineWidth = 1;
    ctx.stroke();

    ctx.fillStyle = INK.text;
    ctx.font = `650 22px ${FONT_STACK}`;
    ctx.fillText(fitText(ctx, figure.value, cellW - 24), x + 13, y + 32);

    ctx.fillStyle = INK.muted;
    ctx.font = `500 10.5px ${FONT_STACK}`;
    ctx.fillText(
      fitText(ctx, figure.label.toUpperCase(), cellW - 24),
      x + 13,
      y + 48
    );
  });

  // Activity strip.
  if (data.activity) {
    ctx.fillStyle = INK.accent;
    ctx.font = `500 11.5px ${FONT_STACK}`;
    ctx.fillText(fitText(ctx, data.activity, CARD_WIDTH - pad * 2), pad, gridTop + cellH * 2 + gap + 26);
  }

  // Footer.
  ctx.fillStyle = INK.muted;
  ctx.font = `400 10px ${FONT_STACK}`;
  ctx.fillText(fitText(ctx, data.footnote, CARD_WIDTH - pad * 2), pad, CARD_HEIGHT - pad + 4);

  return canvas;
}

/** Encode a drawn card as PNG bytes. */
export async function shareCardPngBytes(data: ShareCardData): Promise<Uint8Array> {
  const canvas = drawShareCard(data);
  const blob = await new Promise<Blob | null>((resolve) =>
    canvas.toBlob((b) => resolve(b), 'image/png')
  );
  if (!blob) throw new Error('The card could not be encoded as a PNG.');
  return new Uint8Array(await blob.arrayBuffer());
}

/** A data URL of the card, for an on-screen preview. */
export function shareCardDataUrl(data: ShareCardData): string {
  return drawShareCard(data).toDataURL('image/png');
}

// ---------------------------------------------------------------------------
// Composition
// ---------------------------------------------------------------------------

export interface ShareCardInput {
  /** Already-resolved picker labels — "Overview", "Last 30 days". */
  providerLabel: string;
  rangeLabel: string;
  /** Set only when the scope filter is narrowing the figures. */
  scopeNote?: string | null;
  figures: ShareCardFigure[];
  /** At least one model had no price, so the cost figure is a floor. */
  hasPartialCost: boolean;
  /** The activity strip's parts, when anything has been recorded. */
  activity?: {
    agentsSpawned: number;
    turns: number;
    workedLabel: string;
  } | null;
}

/**
 * Compose the card's text from an already-loaded pane.
 *
 * The subtitle always names the scope and range the figures cover. A figure
 * without its window is the ambiguity the usage meter hit with a bare
 * percentage: "1.3B tokens" means very different things over a week and over
 * all time, and a shared image carries no filter controls with it.
 */
export function buildShareCard(input: ShareCardInput): ShareCardData {
  const scopeNote = input.scopeNote ? ` · ${input.scopeNote}` : '';
  const activity = input.activity;

  return {
    subtitle: `${input.providerLabel} · ${input.rangeLabel}${scopeNote}`,
    figures: input.figures,
    activity: activity
      ? `${activity.agentsSpawned} agents · ${activity.workedLabel} worked · ${activity.turns} turns`
      : null,
    footnote: input.hasPartialCost
      ? 'Estimated from local CLI logs · some models unpriced'
      : 'Estimated from local CLI logs',
  };
}
