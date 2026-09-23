'use client';

import { useEffect } from 'react';

/**
 * Scroll-triggered reveal engine for the marketing site.
 *
 * Any element carrying `data-reveal` starts hidden (CSS) and animates in when
 * it enters the viewport. `data-reveal="left" | "right" | "up" | "scale"` picks
 * the direction; `--reveal-delay` staggers it. One shared observer drives
 * everything, so it costs nothing per element.
 */



export default function ScrollFX() {
  useEffect(() => {
    // 1. Scroll reveals — one observer for every [data-reveal] on the page.
    const revealed = new Set<Element>();
    const io = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (!entry.isIntersecting) continue;
          const el = entry.target;
          revealed.add(el);
          el.classList.add('is-in');
          // Group siblings that enter in the same frame (e.g. card grids):
          // assign staggered delays once, at reveal time.
          const parent = el.parentElement;
          if (parent && !parent.dataset.staggered) {
            parent.dataset.staggered = '1';
            Array.from(parent.children).forEach((child, i) => {
              // Leave hand-tuned inline delays (e.g. the hero sequence) alone.
              if (child instanceof HTMLElement && child.hasAttribute('data-reveal') && !child.style.getPropertyValue('--reveal-delay')) {
                (child as HTMLElement).style.setProperty('--reveal-delay', `${Math.min(i * 70, 500)}ms`);
              }
            });
          }
          io.unobserve(el);
        }
      },
      { threshold: 0.15, rootMargin: '0px 0px -8% 0px' },
    );

    const observeAll = () => {
      document.querySelectorAll('[data-reveal]').forEach((el) => {
        if (!revealed.has(el)) io.observe(el);
      });
    };
    observeAll();

    // 2. Button / card spotlight — a highlight follows the pointer on the
    // primary CTAs and agent cards.
    const onMove = (e: PointerEvent) => {
      const target = (e.target as HTMLElement | null)?.closest<HTMLElement>('.btn, .agents-card');
      if (!target) return;
      const rect = target.getBoundingClientRect();
      target.style.setProperty('--mx', `${e.clientX - rect.left}px`);
      target.style.setProperty('--my', `${e.clientY - rect.top}px`);
    };
    window.addEventListener('pointermove', onMove, { passive: true });

    // 3. Tilt on the terminal mock — pointer position drives a subtle 3D lean.
    const terminal = document.querySelector<HTMLElement>('.terminal');
    let raf = 0;
    const onTilt = (e: PointerEvent) => {
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(() => {
        if (!terminal) return;
        const rect = terminal.getBoundingClientRect();
        const x = (e.clientX - rect.left) / rect.width - 0.5;
        const y = (e.clientY - rect.top) / rect.height - 0.5;
        // Full strength only when the cursor is near the terminal.
        const dist = Math.hypot(x, y);
        const strength = Math.max(0, 1 - dist * 1.4);
        terminal.style.setProperty('--tx', `${(x * 6 * strength).toFixed(2)}deg`);
        terminal.style.setProperty('--ty', `${(y * 6 * strength).toFixed(2)}deg`);
      });
    };
    window.addEventListener('pointermove', onTilt, { passive: true });

    return () => {
      io.disconnect();
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointermove', onTilt);
      cancelAnimationFrame(raf);
    };
  }, []);

  return null;
}
