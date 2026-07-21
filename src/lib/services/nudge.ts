// A soft, short audible nudge for background events (agent turns ending) —
// enough to pull the user's attention without a spoken report. Synthesized with
// Web Audio so it needs no sound asset and no TTS provider.

export type NudgeKind = 'done' | 'blocked' | 'failed';

let ctx: AudioContext | null = null;

function getContext(): AudioContext | null {
  if (typeof window === 'undefined') return null;
  const Ctor: (new () => AudioContext) | null =
    (window as any).AudioContext || (window as any).webkitAudioContext || null;
  if (!Ctor) return null;
  if (!ctx || ctx.state === 'closed') ctx = new Ctor();
  return ctx;
}

// Each nudge is two brief sine notes; the contour carries the meaning so the
// user can tell the outcome without looking: rising = done, repeated = needs
// you, falling = failed.
const TONES: Record<NudgeKind, Array<{ freq: number; at: number }>> = {
  done: [{ freq: 660, at: 0 }, { freq: 880, at: 0.12 }],
  blocked: [{ freq: 587, at: 0 }, { freq: 587, at: 0.18 }],
  failed: [{ freq: 494, at: 0 }, { freq: 370, at: 0.12 }],
};

const NOTE_GAIN = 0.08;
const NOTE_SECONDS = 0.3;

export function playNudge(kind: NudgeKind): void {
  const audio = getContext();
  if (!audio) return;
  if (audio.state === 'suspended') void audio.resume().catch(() => {});
  const start = audio.currentTime + 0.02;
  for (const { freq, at } of TONES[kind]) {
    const osc = audio.createOscillator();
    const gain = audio.createGain();
    osc.type = 'sine';
    osc.frequency.value = freq;
    gain.gain.setValueAtTime(0, start + at);
    gain.gain.linearRampToValueAtTime(NOTE_GAIN, start + at + 0.015);
    gain.gain.exponentialRampToValueAtTime(0.0001, start + at + NOTE_SECONDS);
    osc.connect(gain);
    gain.connect(audio.destination);
    osc.start(start + at);
    osc.stop(start + at + NOTE_SECONDS + 0.02);
  }
}
