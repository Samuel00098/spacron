/* Tool cursors for the sketch canvas.
 *
 * The canvas used to hand the viewport the plain CSS keywords — `crosshair`,
 * `cell`, `text`. Those resolve to the platform's own bitmaps, and on every
 * platform they are a thin *unhaloed* dark glyph: a bare cross, a bare I-beam.
 * That is fine on a white page and useless here, because the sketch canvas
 * background is the user's choice — `solid-dark`, `blackboard` and `blueprint`
 * are all dark, and on those the cursor simply disappears at the moment you
 * need it most, while placing a shape or a text box. The pan hand had the same
 * problem mirrored: the platform hand is a pale glyph with a thin dark outline,
 * so it washes out against a white or light canvas instead of a dark one.
 *
 * `select` is the one keyword left alone. Its arrow is the cursor a user reads
 * as "the OS pointer, nothing is happening here", every platform ships it fully
 * outlined already, and a hand-rolled arrow never matches the real one.
 *
 * The replacements below are drawn twice — a wide light pass, then a narrow
 * dark pass over it — so each glyph carries its own contrast. That is
 * deliberately independent of `backgroundStyle`: keying the colour to the
 * background only holds until the pointer crosses artwork drawn in the
 * opposite value, whereas a two-tone glyph reads on white, on black, on the
 * blackboard green and the blueprint blue, and over any stroke on top of them.
 */

const HALO = '#ffffff';
const INK = '#0b0f17';

/** `cursor` needs an escaped URL, and a raw `#` would terminate the data URI. */
function cursorUrl(svg: string, hotX: number, hotY: number, fallback: string) {
  const source = `data:image/svg+xml,${encodeURIComponent(svg.replace(/\s+/g, ' ').trim())}`;
  // The keyword tail is what a renderer falls back to if it cannot decode an
  // SVG cursor, so it stays the closest keyword rather than `auto`.
  return `url("${source}") ${hotX} ${hotY}, ${fallback}`;
}

/* A solid silhouette with its own outline, for glyphs built from several
 * overlapping pieces (the hands). The shapes are painted twice: once filled
 * *and* stroked in the halo colour, which fuses them into one light body a
 * little larger than the glyph, then once filled in ink on top. Painting both
 * passes in a single colour each is what hides the seams where the pieces
 * overlap — stroking them individually would draw every internal edge.
 */
function silhouette(shapes: string, size: number) {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 ${size} ${size}">
    <g fill="${HALO}" stroke="${HALO}" stroke-width="3.2" stroke-linejoin="round">${shapes}</g>
    <g fill="${INK}">${shapes}</g>
  </svg>`;
}

/* Precision cross for pen, line, connector and every shape tool. The arms stop
   short of the middle so the exact anchor point stays uncovered. */
const CROSSHAIR = cursorUrl(
  `<svg xmlns="http://www.w3.org/2000/svg" width="32" height="32" viewBox="0 0 32 32">
     <g fill="none" stroke-linecap="round">
       <path d="M16 2.5v9.5M16 20v9.5M2.5 16h9.5M20 16h9.5" stroke="${HALO}" stroke-width="4.25"/>
       <path d="M16 2.5v9.5M16 20v9.5M2.5 16h9.5M20 16h9.5" stroke="${INK}" stroke-width="1.6"/>
     </g>
     <circle cx="16" cy="16" r="2.6" fill="${HALO}"/>
     <circle cx="16" cy="16" r="1.3" fill="${INK}"/>
   </svg>`,
  16, 16, 'crosshair',
);

/* I-beam for the text tool. */
const TEXT = cursorUrl(
  `<svg xmlns="http://www.w3.org/2000/svg" width="24" height="32" viewBox="0 0 24 32">
     <g fill="none" stroke-linecap="round">
       <path d="M8 4.5h8M8 27.5h8M12 5v22" stroke="${HALO}" stroke-width="4.5"/>
       <path d="M8 4.5h8M8 27.5h8M12 5v22" stroke="${INK}" stroke-width="1.8"/>
     </g>
   </svg>`,
  12, 16, 'text',
);

/* The eraser ring is drawn at the on-screen size of the area it actually
 * clears, so picking a bigger eraser (or zooming in) grows the ring to match.
 * The caller passes that diameter already in screen pixels; this module does
 * not know how a brush width becomes an erased width.
 *
 * Two clamps. Chromium ignores a cursor image over 128px and silently falls
 * back to the keyword, which would leave the biggest eraser with the *smallest*
 * looking cursor — so the ring stops growing below that limit and understates
 * the area only past roughly 1.8x zoom on the widest eraser. At the other end a
 * ring under ~10px stops being a target you can aim, so it stops shrinking and
 * overstates instead. Both clamps trade exactness for a cursor you can see; in
 * between — every eraser size at ordinary zoom — the ring is the erased area.
 */
const ERASER_MIN_PX = 10;
const ERASER_MAX_PX = 112;

const eraserCache = new Map<number, string>();

function eraserCursor(diameterPx: number): string {
  const d = Math.round(Math.min(ERASER_MAX_PX, Math.max(ERASER_MIN_PX, diameterPx)));
  const cached = eraserCache.get(d);
  if (cached) return cached;

  const pad = 4; // room for the halo stroke to sit outside the ring
  const size = d + pad * 2;
  const c = size / 2;
  const r = d / 2;
  // The centre dot marks the exact point; on a small ring it would swallow the
  // hole, so it only appears once there is room for it.
  const dot = d >= 22
    ? `<circle cx="${c}" cy="${c}" r="2.4" fill="${HALO}"/>
       <circle cx="${c}" cy="${c}" r="1.2" fill="${INK}"/>`
    : '';
  const cursor = cursorUrl(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 ${size} ${size}">
       <circle cx="${c}" cy="${c}" r="${r}" fill="none" stroke="${HALO}" stroke-width="4"/>
       <circle cx="${c}" cy="${c}" r="${r}" fill="none" stroke="${INK}" stroke-width="1.6"/>
       ${dot}
     </svg>`,
    c, c, 'cell',
  );
  eraserCache.set(d, cursor);
  return cursor;
}

/* Open hand — the pan tool at rest. Four finger capsules and a thumb over a
   rounded palm; the pieces overlap and `silhouette` fuses them. */
const OPEN_HAND = cursorUrl(
  silhouette(
    `<rect x="10.6" y="8.2"  width="3.1" height="11.4" rx="1.55"/>
     <rect x="14.2" y="6.0"  width="3.1" height="13.6" rx="1.55"/>
     <rect x="17.8" y="6.9"  width="3.1" height="12.7" rx="1.55"/>
     <rect x="21.4" y="9.2"  width="3.1" height="10.4" rx="1.55"/>
     <rect x="6.9"  y="14.6" width="3.1" height="8.6"  rx="1.55"
           transform="rotate(-28 8.45 18.9)"/>
     <rect x="10.2" y="14.0" width="14.6" height="12.6" rx="5.6"/>`,
    32,
  ),
  16, 16, 'grab',
);

/* Closed fist — the pan tool mid-drag. Same body, fingers folded to knuckles
   and the thumb laid across the front, so the two states read as one hand. */
const CLOSED_HAND = cursorUrl(
  silhouette(
    `<rect x="11.0" y="10.4" width="3.1" height="6.0" rx="1.55"/>
     <rect x="14.6" y="9.6"  width="3.1" height="6.8" rx="1.55"/>
     <rect x="18.2" y="10.0" width="3.1" height="6.4" rx="1.55"/>
     <rect x="21.5" y="11.4" width="3.1" height="5.4" rx="1.55"/>
     <rect x="9.6"  y="12.6" width="15.2" height="13.6" rx="6.0"/>
     <rect x="8.4"  y="16.4" width="9.0"  height="3.4"  rx="1.7"/>`,
    32,
  ),
  16, 16, 'grabbing',
);

const POINT_TOOLS = new Set([
  'rectangle', 'circle', 'diamond', 'triangle',
  'hexagon', 'star', 'pentagon', 'octagon',
  'line', 'connector', 'pen',
]);

/**
 * The cursor the canvas viewport should show for the current interaction.
 *
 * `eraserDiameterPx` is the on-screen diameter the eraser clears — brush width
 * through whatever the erase paths scale it by, times the zoom.
 */
export function sketchCursor(
  tool: string,
  opts: { spacePressed: boolean; panning: boolean; eraserDiameterPx?: number },
): string {
  if (opts.spacePressed || tool === 'pan') return opts.panning ? CLOSED_HAND : OPEN_HAND;
  if (tool === 'select') return 'default';
  if (tool === 'eraser') return eraserCursor(opts.eraserDiameterPx ?? 24);
  if (tool === 'text') return TEXT;
  if (POINT_TOOLS.has(tool)) return CROSSHAIR;
  return CROSSHAIR;
}
