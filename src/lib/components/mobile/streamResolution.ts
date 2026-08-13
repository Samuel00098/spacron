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
 * Measured on the host-side gRPC path (2026-08-13): 720 → 25.7 fps / 36 ms
 * median, 1024 → 15.2 fps / 65 ms, 1200 → 12.7 fps, 1800 → 6.3 fps. 1024 is
 * the last point that still comfortably beats the old scrcpy path (7.1 fps /
 * 125 ms) while being sharp on a HiDPI display; past it the frame rate falls
 * away faster than the sharpness gain is worth. Raise it only with a fresh
 * measurement — see `.spacron/memory/emulator-grpc-stream.md`.
 */
export const MAX_STREAM_SIDE = 1024;

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
