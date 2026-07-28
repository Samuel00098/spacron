/**
 * Short status chimes for agent turn ends.
 *
 * This is a *nudge*, not a report: enough to pull your attention back to the
 * app when an agent finishes while you're elsewhere. The recap lives in the
 * chat completion card and the toast; the audio only carries the outcome, via
 * melodic contour so the three cases are distinguishable without looking:
 *
 *   done    — two rising notes
 *   blocked — the same note twice (an unresolved "knock")
 *   failed  — two falling notes
 *
 * Synthesized with Web Audio rather than shipped as audio files: no asset
 * loading, no decode latency, and no TTS provider needed, so the cue works
 * offline and on every completion path.
 */

export type NudgeKind = 'done' | 'blocked' | 'failed';

/** Note pairs (Hz) per outcome — see the contour note above. */
const TONES: Record<NudgeKind, [number, number]> = {
  done: [659.25, 987.77], // E5 → B5
  blocked: [739.99, 739.99], // F#5 ×2
  failed: [587.33, 415.3], // D5 → G#4
};

const NOTE_MS = 130;
const GAP_MS = 70;
const PEAK_GAIN = 0.14;

// One shared context — browsers cap how many can exist, and completions can
// land back-to-back when several agents finish together.
let ctx: AudioContext | null = null;

function getContext(): AudioContext | null {
  if (typeof window === 'undefined') return null;
  const Ctor: (new () => AudioContext) | undefined =
    (window as any).AudioContext || (window as any).webkitAudioContext;
  if (!Ctor) return null;
  if (!ctx || ctx.state === 'closed') {
    try {
      ctx = new Ctor();
    } catch {
      return null;
    }
  }
  return ctx;
}

/**
 * Schedule one note with a short attack and exponential decay. A raw
 * gain-on/gain-off would click audibly at these durations.
 */
function scheduleNote(context: AudioContext, freq: number, startAt: number): void {
  const osc = context.createOscillator();
  const gain = context.createGain();
  // Triangle reads as a soft chime; sine is too flutey to cut through, square
  // too harsh for something that fires many times an hour.
  osc.type = 'triangle';
  osc.frequency.setValueAtTime(freq, startAt);

  const end = startAt + NOTE_MS / 1000;
  gain.gain.setValueAtTime(0.0001, startAt);
  gain.gain.exponentialRampToValueAtTime(PEAK_GAIN, startAt + 0.012);
  gain.gain.exponentialRampToValueAtTime(0.0001, end);

  osc.connect(gain);
  gain.connect(context.destination);
  osc.start(startAt);
  osc.stop(end + 0.02);
  osc.onended = () => {
    osc.disconnect();
    gain.disconnect();
  };
}

/**
 * Two cues this close together are one event heard twice, not two events.
 *
 * A single completion can reach here from more than one path: the turn watcher
 * resolves `finished`, and a beat later the CLI process exits and `handlePtyExit`
 * cues the same ending again. The toast layer drops the duplicate (it suppresses
 * an identical message already on screen), so the chime was the only part of the
 * cue that doubled — which is exactly what makes the notification feel unreliable
 * rather than merely chatty.
 */
const REPEAT_WINDOW_MS = 1200;
let lastKind: NudgeKind | null = null;
let lastPlayedAt = 0;

/**
 * Play the chime for `kind`. Never throws and never rejects — an audio failure
 * must not take down the completion pipeline that calls it.
 */
export function playNudge(kind: NudgeKind): void {
  const now = Date.now();
  if (kind === lastKind && now - lastPlayedAt < REPEAT_WINDOW_MS) return;
  lastKind = kind;
  lastPlayedAt = now;

  const context = getContext();
  if (!context) return;
  // Autoplay policy can leave the context suspended until the first gesture.
  // The app has had plenty by the time an agent finishes, but a fresh reload
  // with a still-running agent can land here suspended.
  if (context.state === 'suspended') void context.resume().catch(() => undefined);

  const [first, second] = TONES[kind];
  const start = context.currentTime + 0.02;
  try {
    scheduleNote(context, first, start);
    scheduleNote(context, second, start + (NOTE_MS + GAP_MS) / 1000);
  } catch {
    /* audio graph unavailable — the toast still fires */
  }
}
