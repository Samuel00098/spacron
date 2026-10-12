import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { get } from '$lib/stores/storeCompat';
import { appearance } from '$lib/stores/settings';
import './LaunchSplash.css';

/** The mark is the "S"; the splash types out the rest of the name beside it. */
const WORD = 'pacron';

/** Per-letter delays (ms). Uneven on purpose, so it reads as typed, not ticked. */
const LETTER_DELAYS = [260, 200, 300, 180, 250, 220];

// Keep these in step with the matching durations in LaunchSplash.css.
const ENTER_MS = 800;
const SLIDE_MS = 750;
const HOLD_MS = 900;
const EXIT_MS = 600;

type Phase = 'enter' | 'slide' | 'type' | 'hold' | 'exit';

/**
 * Resolved once from the saved appearance. The theme classes on <html> are only
 * applied after `loadThemes` round-trips to the backend, which is after this
 * first paints, so they can't be read here.
 */
function resolveScheme(): 'dark' | 'light' {
  const mode = get(appearance);
  if (mode === 'light' || mode === 'dark') return mode;
  return window.matchMedia?.('(prefers-color-scheme: dark)').matches === false ? 'light' : 'dark';
}

/**
 * Full-window cover shown on a cold launch (see `isColdLaunch`): the mark fades
 * in centred, slides left, the rest of the name types out, then the cover fades
 * away to reveal the app.
 */
export default function LaunchSplash() {
  const [scheme] = useState(resolveScheme);
  const [phase, setPhase] = useState<Phase>('enter');
  const [shown, setShown] = useState(0);
  const [done, setDone] = useState(false);
  const wordRef = useRef<HTMLSpanElement>(null);
  const lockupRef = useRef<HTMLDivElement>(null);

  // Start with the mark dead centre: shift the lockup by half the word's width
  // so the reserved (still invisible) word doesn't pull the mark off-centre.
  useLayoutEffect(() => {
    const word = wordRef.current;
    const lockup = lockupRef.current;
    if (!word || !lockup) return;
    const gap = parseFloat(getComputedStyle(lockup).columnGap) || 0;
    lockup.style.setProperty('--splash-shift', `${(word.offsetWidth + gap) / 2}px`);
  }, []);

  useEffect(() => {
    const reduced = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false;
    // The app boots behind the splash and can block the main thread for a
    // while. Timers scheduled up front would then fire in a burst and skip
    // whole phases (the slide never animates without a painted frame to start
    // from), so each step is chained: wait, apply, let it paint, then wait again.
    const steps: [number, () => void][] = reduced
      ? [
          [0, () => { setPhase('hold'); setShown(WORD.length); }],
          [700, () => setPhase('exit')],
          [EXIT_MS, () => setDone(true)],
        ]
      : [
          [ENTER_MS, () => setPhase('slide')],
          [SLIDE_MS, () => setPhase('type')],
          ...LETTER_DELAYS.slice(0, WORD.length).map(
            (delay, i): [number, () => void] => [delay, () => setShown(i + 1)],
          ),
          [HOLD_MS, () => setPhase('exit')],
          [EXIT_MS, () => setDone(true)],
        ];

    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let frame: number | undefined;
    // Frames stop entirely while the window is hidden or minimised, so a
    // timeout backs them up; the splash must never wait on a frame forever.
    const afterPaint = (fn: () => void) => {
      let fired = false;
      const once = () => {
        if (fired) return;
        fired = true;
        if (frame !== undefined) cancelAnimationFrame(frame);
        fn();
      };
      frame = requestAnimationFrame(() => {
        frame = requestAnimationFrame(once);
      });
      timer = setTimeout(once, 120);
    };
    const run = (index: number) => {
      const step = steps[index];
      if (!step || cancelled) return;
      timer = setTimeout(() => {
        if (cancelled) return;
        step[1]();
        afterPaint(() => run(index + 1));
      }, step[0]);
    };
    // Start counting only once the centred mark has actually been painted.
    afterPaint(() => run(0));
    return () => {
      cancelled = true;
      if (timer !== undefined) clearTimeout(timer);
      if (frame !== undefined) cancelAnimationFrame(frame);
    };
  }, []);

  // index.html painted <html> in the splash colour before any script ran; the
  // app's translucent surfaces would show it through, so drop it once covered.
  useEffect(() => {
    document.documentElement.style.removeProperty('background');
  }, []);

  if (done) return null;

  return (
    <div
      className={`launch-splash launch-splash--${scheme} is-${phase}`}
      data-tauri-drag-region
      role="presentation"
      aria-hidden="true"
    >
      <div className="launch-splash-lockup" ref={lockupRef} data-tauri-drag-region>
        <span className="launch-splash-mark" />
        <span className="launch-splash-word" ref={wordRef}>
          {WORD.split('').map((letter, i) => (
            <span key={i} className={i < shown ? 'is-shown' : undefined}>
              {letter}
            </span>
          ))}
        </span>
      </div>
    </div>
  );
}
