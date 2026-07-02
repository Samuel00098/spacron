'use client';

import { useEffect } from 'react';

export function SiteEffects() {
  useEffect(() => {
    const cleanups: Array<() => void> = [];

    // ── Reveal-on-scroll ────────────────────────────────────────────────────
    const io = new IntersectionObserver(
      (entries) => {
        for (const e of entries) {
          if (e.isIntersecting) {
            e.target.classList.add('in');
            io.unobserve(e.target);
          }
        }
      },
      { threshold: 0.12 },
    );
    document.querySelectorAll('.reveal, .reveal-lift').forEach((el) => io.observe(el));
    cleanups.push(() => io.disconnect());

    // ── Top scroll-progress rail ────────────────────────────────────────────
    const progress = document.querySelector<HTMLElement>('.fx-progress > span');
    if (progress) {
      let ticking = false;
      const update = () => {
        ticking = false;
        const doc = document.documentElement;
        const max = doc.scrollHeight - doc.clientHeight;
        progress.style.width = `${max > 0 ? Math.min(100, (doc.scrollTop / max) * 100) : 0}%`;
      };
      const onScroll = () => {
        if (ticking) return;
        ticking = true;
        requestAnimationFrame(update);
      };
      window.addEventListener('scroll', onScroll, { passive: true });
      window.addEventListener('resize', onScroll);
      update();
      cleanups.push(() => {
        window.removeEventListener('scroll', onScroll);
        window.removeEventListener('resize', onScroll);
      });
    }

    // ── Orb scroll parallax ──────────────────────────────────────────────────
    const orbs = document.querySelectorAll<HTMLElement>('.orb');
    if (orbs.length > 0 && !window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
      let ticking = false;
      const onScroll = () => {
        if (ticking) return;
        ticking = true;
        requestAnimationFrame(() => {
          ticking = false;
          const sy = window.scrollY;
          const speeds = [0.03, -0.04, 0.025, -0.035];
          orbs.forEach((orb, i) => {
            const speed = speeds[i % speeds.length];
            orb.style.transform = `translate3d(0, ${sy * speed}px, 0)`;
          });
        });
      };
      window.addEventListener('scroll', onScroll, { passive: true });
      onScroll();
      cleanups.push(() => window.removeEventListener('scroll', onScroll));
    }

    // ── Constellation network ───────────────────────────────────────────────
    const canvas = document.querySelector<HTMLCanvasElement>('.fx-net');
    const ctx = canvas?.getContext('2d');
    const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    const lowPower =
      window.matchMedia('(pointer: coarse)').matches || window.innerWidth < 760;

    if (canvas && ctx) {
      const LINK = 132;
      const CURSOR = 168;
      let w = 0;
      let h = 0;
      let dpr = 1;
      let pts: { x: number; y: number; vx: number; vy: number }[] = [];
      const mouse = { x: -9999, y: -9999 };
      let ox = 0;
      let oy = 0;
      let raf = 0;

      const resize = () => {
        w = window.innerWidth;
        h = window.innerHeight;
        dpr = Math.min(window.devicePixelRatio || 1, 2);
        canvas.width = Math.round(w * dpr);
        canvas.height = Math.round(h * dpr);
        ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
        const count = Math.max(28, Math.min(92, Math.round((w * h) / 19000)));
        pts = Array.from({ length: count }, () => ({
          x: Math.random() * w,
          y: Math.random() * h,
          vx: (Math.random() - 0.5) * 0.24,
          vy: (Math.random() - 0.5) * 0.24,
        }));
      };

      const draw = (animate: boolean) => {
        if (animate) {
          const tx = mouse.x < 0 ? 0 : (mouse.x - w / 2) * 0.018;
          const ty = mouse.y < 0 ? 0 : (mouse.y - h / 2) * 0.018;
          ox += (tx - ox) * 0.05;
          oy += (ty - oy) * 0.05;
        }
        ctx.clearRect(0, 0, w, h);
        ctx.save();
        ctx.translate(ox, oy);

        for (const p of pts) {
          if (animate) {
            p.x += p.vx;
            p.y += p.vy;
            if (p.x < -20) p.x = w + 20;
            else if (p.x > w + 20) p.x = -20;
            if (p.y < -20) p.y = h + 20;
            else if (p.y > h + 20) p.y = -20;
          }
        }

        for (let i = 0; i < pts.length; i++) {
          for (let j = i + 1; j < pts.length; j++) {
            const dx = pts[i].x - pts[j].x;
            const dy = pts[i].y - pts[j].y;
            const d2 = dx * dx + dy * dy;
            if (d2 < LINK * LINK) {
              const a = (1 - Math.sqrt(d2) / LINK) * 0.55;
              // Use light cyan/teal for the constellation connection lines
              ctx.strokeStyle = `rgba(34, 211, 199, ${a * 0.35})`;
              ctx.lineWidth = 1;
              ctx.beginPath();
              ctx.moveTo(pts[i].x, pts[i].y);
              ctx.lineTo(pts[j].x, pts[j].y);
              ctx.stroke();
            }
          }
        }

        if (mouse.x >= 0) {
          const mx = mouse.x - ox;
          const my = mouse.y - oy;
          for (const p of pts) {
            const dx = p.x - mx;
            const dy = p.y - my;
            const d2 = dx * dx + dy * dy;
            if (d2 < CURSOR * CURSOR) {
              const a = (1 - Math.sqrt(d2) / CURSOR) * 0.6;
              // Mouse cursor pulls connection lines in sky blue
              ctx.strokeStyle = `rgba(96, 165, 250, ${a * 0.45})`;
              ctx.lineWidth = 1;
              ctx.beginPath();
              ctx.moveTo(mx, my);
              ctx.lineTo(p.x, p.y);
              ctx.stroke();
            }
          }
        }

        // Draw points
        ctx.fillStyle = 'rgba(34, 211, 199, 0.6)';
        for (const p of pts) {
          ctx.beginPath();
          ctx.arc(p.x, p.y, 1.3, 0, Math.PI * 2);
          ctx.fill();
        }
        ctx.restore();
      };

      const loop = () => {
        draw(true);
        raf = requestAnimationFrame(loop);
      };
      const start = () => {
        if (!raf) loop();
      };
      const stop = () => {
        if (raf) cancelAnimationFrame(raf);
        raf = 0;
      };

      resize();
      const onResize = () => {
        resize();
        if (reduceMotion || lowPower) draw(false);
      };
      const onMove = (e: PointerEvent) => {
        mouse.x = e.clientX;
        mouse.y = e.clientY;
      };
      const onLeave = () => {
        mouse.x = -9999;
        mouse.y = -9999;
      };
      const onVisibility = () => {
        if (document.hidden) stop();
        else if (!reduceMotion && !lowPower) start();
      };

      window.addEventListener('resize', onResize);
      window.addEventListener('pointermove', onMove, { passive: true });
      window.addEventListener('pointerleave', onLeave);
      document.addEventListener('visibilitychange', onVisibility);

      if (reduceMotion || lowPower) {
        draw(false);
      } else if ('requestIdleCallback' in window) {
        (window as any).requestIdleCallback(start, { timeout: 1200 });
      } else {
        start();
      }

      cleanups.push(() => {
        stop();
        window.removeEventListener('resize', onResize);
        window.removeEventListener('pointermove', onMove);
        window.removeEventListener('pointerleave', onLeave);
        document.removeEventListener('visibilitychange', onVisibility);
      });
    }

    return () => cleanups.forEach((fn) => fn());
  }, []);

  return null;
}

