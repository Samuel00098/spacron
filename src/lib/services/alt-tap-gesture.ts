/**
 * "Tap left Alt" gesture — pressed and released with nothing else in between.
 *
 * Extracted from `FloatingPromptBar` so the rule is unit-testable, because
 * getting it wrong is not visible by reading: the bar used to toggle voice mode
 * on the Alt **keydown**, which meant every chord containing Alt opened a voice
 * call the instant Alt went down. `Ctrl+Alt+M` (transcribe at the caret) toggled
 * voice mode before the `M` was ever delivered.
 *
 * Two things this has to get right, and only one of them is obvious:
 *
 * 1. Completion is on keyup, not keydown — at keydown time you cannot yet know
 *    whether more keys are coming.
 * 2. A modifier check at keydown is not sufficient on its own. Holding Alt
 *    *first* and adding Ctrl after produces a bare-Alt keydown too, so the
 *    gesture must also be cancelled by any key that arrives while Alt is held.
 */

/** The subset of `KeyboardEvent` the gesture reads. */
export type AltTapEvent = {
  key: string;
  location?: number;
  repeat?: boolean;
  ctrlKey?: boolean;
  metaKey?: boolean;
  shiftKey?: boolean;
};

/** `KeyboardEvent.DOM_KEY_LOCATION_LEFT`, inlined so this module needs no DOM. */
export const KEY_LOCATION_LEFT = 1;

export type AltTapGesture = {
  /** Feed every keydown. */
  keydown: (event: AltTapEvent) => void;
  /** Feed every keyup. Returns true when it completes a bare left-Alt tap. */
  keyup: (event: AltTapEvent) => boolean;
  /** Forget any in-flight tap (e.g. on blur, when keyup may never arrive). */
  reset: () => void;
};

export function createAltTapGesture(): AltTapGesture {
  // True while the current left-Alt press is still a candidate for a bare tap.
  let candidate = false;

  return {
    keydown(event) {
      // Any key other than a clean left-Alt press disqualifies the tap — both
      // "Alt arrived with a modifier already down" (Ctrl+Alt+M) and "another
      // key arrived while Alt was held" (Alt held first, then Ctrl, then M).
      candidate =
        event.key === 'Alt' &&
        event.location === KEY_LOCATION_LEFT &&
        !event.repeat &&
        !event.ctrlKey &&
        !event.metaKey &&
        !event.shiftKey;
    },

    keyup(event) {
      if (event.key !== 'Alt' || event.location !== KEY_LOCATION_LEFT) return false;
      const wasBareTap = candidate;
      candidate = false;
      return wasBareTap;
    },

    reset() {
      candidate = false;
    },
  };
}
