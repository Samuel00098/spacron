/**
 * Picks the stream resolution to ask a device for, from the size the panel can
 * actually display.
 *
 * A fixed constant cannot be right for everyone. 720 is pixel-perfect in a
 * default-width drawer on a standard display, but on a HiDPI screen the same
 * CSS box is twice as many real pixels, so the frame is stretched ~2x and looks
 * soft — which is exactly the machine (a Retina Mac) where the pane is supposed
 * to look its best.
 *
 * So the rule is: ask for the pixels the panel will really paint, and no more.
 * Under-asking is visible as softness; over-asking is invisible and costs frame
 * rate, because the emulator scales host-side before encoding either way.
 */

/**
 * Never ask for less than this. Below ~480 the image is soft even in a narrow
 * drawer, and the frame rate gained is negligible — measured 27.6 fps at 480
 * against 25.7 at 720, i.e. the whole range under 720 buys almost nothing.
 */
export const MIN_STREAM_SIDE = 480;

/**
 * Never ask for more than this, however large the panel or the DPR.
 *
 * This ceiling is load-bearing for how the mirror *feels*, because a stage
 * taller than ~650 CSS px pins the request to it — which is every
 * non-collapsed panel on a normal display. Whatever this number is, it is the
 * resolution most sessions actually run at.
 *
 * 1024 was the original value, chosen as "the last point that still
 * comfortably beats the old scrcpy path (7.1 fps / 125 ms)". That baseline is
 * the wrong one now: scrcpy is the *fallback* for physical devices, and an
 * emulator takes the host-side gRPC path, so the bar is the knee of the gRPC
 * curve rather than anything scrcpy does.
 *
 * Re-measured against that curve (2026-08-15, Medium_Phone AVD, continuous
 * drag driven over gRPC sendTouch, three interleaved reps to cancel host
 * drift):
 *
 * | long side | fps  | median gap |
 * |-----------|------|-----------|
 * | 720       | 16.1 |    39 ms  |
 * | **864**   | 15.7 |    43 ms  |
 * | 1024      | 12.7 |    54 ms  |
 *
 * 720 and 864 are within run-to-run noise of each other; 1024 was slower in
 * every rep. So the cliff is between 864 and 1024, and 864 is the pick — it
 * keeps 20% more linear resolution than 720 (the sharpness this whole module
 * exists to buy) at no measurable frame-rate cost, while staying on the fast
 * side of the cliff.
 *
 * Absolute fps here is lower than the 2026-08-13 figures above because that
 * run had a quieter machine; the *shape* (flat to ~864, then a cliff) held in
 * both. Raise this only with a fresh interleaved measurement.
 */
export const MAX_STREAM_SIDE = 864;

/**
 * Device-pixel-ratio is capped at 2. Beyond 2x the extra pixels are past what
 * the eye resolves at this size, but the encoder cost is real and quadratic.
 */
const MAX_DPR = 2;

/**
 * Tallest phone aspect worth planning for (~19.5:9 plus headroom). Used to
 * bound the long side by the panel's *width* as well as its height: in a narrow
 * drawer a portrait device is width-limited, so its rendered height never
 * reaches the stage's full height and asking for it would over-shoot.
 */
const TALLEST_PHONE_ASPECT = 2.2;

/**
 * The longest edge worth requesting for a portrait device rendered into a stage
 * of `stageWidth` x `stageHeight` CSS pixels at `dpr`.
 *
 * Returns a value in `[MIN_STREAM_SIDE, MAX_STREAM_SIDE]`, or
 * `MIN_STREAM_SIDE` when the stage has not been laid out yet (zero-sized) —
 * a stream started before layout settles gets the floor rather than a garbage
 * number, and the next start corrects it.
 */
export function desiredStreamLongSide(
  stageWidth: number,
  stageHeight: number,
  dpr: number,
): number {
  if (!Number.isFinite(stageWidth) || !Number.isFinite(stageHeight)) return MIN_STREAM_SIDE;
  if (stageWidth <= 0 || stageHeight <= 0) return MIN_STREAM_SIDE;

  const scale = Math.min(Number.isFinite(dpr) && dpr > 0 ? dpr : 1, MAX_DPR);
  // A portrait device fits the stage by whichever bound binds first: the
  // stage's height, or its width times the tallest aspect we plan for.
  const cssLongSide = Math.min(stageHeight, stageWidth * TALLEST_PHONE_ASPECT);
  // `round`, not `ceil`: TALLEST_PHONE_ASPECT is not exactly representable, so
  // 350 * 2.2 is 770.0000000000001 and `ceil` would turn a clean 770 into 771.
  // A pixel either way is irrelevant here; a number that looks wrong is not.
  const devicePixels = Math.round(cssLongSide * scale);
  return Math.max(MIN_STREAM_SIDE, Math.min(MAX_STREAM_SIDE, devicePixels));
}

// ---------------------------------------------------------------------------
// The panel's resolution switcher
// ---------------------------------------------------------------------------

/**
 * What the resolution picker is set to: a long side in device pixels, or
 * `'auto'` to keep following the panel size via [`desiredStreamLongSide`].
 */
export type StreamSideChoice = 'auto' | number;

/**
 * Bounds an explicit pick is held to. These mirror the clamps both backend
 * transports already apply (`MIN_MAX_SIDE`/`MAX_MAX_SIDE` in `emulator_grpc.rs`
 * and `SCRCPY_MIN_SIDE`/`SCRCPY_MAX_SIDE_CAP` in `mobile_stream.rs`), so what
 * the switcher shows is what the device is actually asked for.
 */
export const MIN_REQUESTABLE_SIDE = 240;
export const MAX_REQUESTABLE_SIDE = 4096;

/**
 * The fixed rungs offered in the panel's switcher, with the measured trade-off
 * as the sublabel — see the table on [`MAX_STREAM_SIDE`].
 *
 * These deliberately run past `MAX_STREAM_SIDE`. That ceiling exists to stop
 * the *automatic* pick from wandering onto the slow side of the frame-rate
 * cliff; someone who selects 1440 has chosen the trade knowingly and gets what
 * they asked for.
 */
export const STREAM_SIDE_CHOICES: ReadonlyArray<{ side: number; sublabel: string }> = [
  { side: 480, sublabel: 'Smoothest' },
  { side: 720, sublabel: 'Smooth' },
  { side: 864, sublabel: 'Balanced' },
  { side: 1080, sublabel: 'Sharp · fewer frames' },
  { side: 1440, sublabel: 'Sharpest · slowest' },
];

/** The long side to request for `choice`, given the stage it will be shown in. */
export function resolveStreamSide(
  choice: StreamSideChoice,
  stageWidth: number,
  stageHeight: number,
  dpr: number,
): number {
  if (choice === 'auto') return desiredStreamLongSide(stageWidth, stageHeight, dpr);
  if (!Number.isFinite(choice)) return desiredStreamLongSide(stageWidth, stageHeight, dpr);
  return Math.max(MIN_REQUESTABLE_SIDE, Math.min(MAX_REQUESTABLE_SIDE, Math.round(choice)));
}

/**
 * Read a persisted choice back. Anything unrecognised — a hand-edited value, a
 * rung removed from a later build — falls back to `'auto'` rather than
 * pinning the stream to a number nothing offers any more.
 */
export function parseStreamSideChoice(raw: string | null | undefined): StreamSideChoice {
  if (!raw || raw === 'auto') return 'auto';
  const side = Number(raw);
  if (!Number.isFinite(side) || side <= 0) return 'auto';
  return Math.max(MIN_REQUESTABLE_SIDE, Math.min(MAX_REQUESTABLE_SIDE, Math.round(side)));
}

/** Serialize a choice for storage / the `<select>` value. */
export function formatStreamSideChoice(choice: StreamSideChoice): string {
  return choice === 'auto' ? 'auto' : String(choice);
}
