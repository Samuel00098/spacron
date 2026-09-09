import React, { useEffect, useRef } from 'react';
import './SpectrumVisualizer.css';

export type SpectrumPhase = 'idle' | 'listening' | 'thinking' | 'speaking' | 'sleeping' | 'connecting';

export interface SpectrumVisualizerProps {
  /** Current state: 'idle' | 'listening' | 'thinking' | 'speaking' | 'sleeping' */
  phase?: SpectrumPhase;
  /** Number of spectrum bars (default: 28 for hero, 16 for compact) */
  barCount?: number;
  /** Live audio level (0.0 to 1.0), e.g. from transcriptionLevel */
  audioLevel?: number;
  /** Whether to render dynamic ambient glow behind bars */
  glow?: boolean;
  /** Height of the visualizer in px (default: 32) */
  height?: number;
  /** Extra class name */
  className?: string;
}

// Chromatic spectrum palette from high frequency (cyan/mint) to low frequency (coral/amber)
const SPECTRUM_STOPS: Array<{ pos: number; r: number; g: number; b: number }> = [
  { pos: 0.0, r: 0, g: 245, b: 212 },    // Electric Mint Cyan (#00f5d4)
  { pos: 0.12, r: 0, g: 210, b: 255 },   // Vivid Sky Blue (#00d2ff)
  { pos: 0.25, r: 59, g: 130, b: 246 },  // Cobalt Blue (#3b82f6)
  { pos: 0.4, r: 99, g: 102, b: 241 },   // Electric Indigo (#6366f1)
  { pos: 0.52, r: 139, g: 92, b: 246 },  // Vibrant Violet (#8b5cf6)
  { pos: 0.65, r: 168, g: 85, b: 247 },  // Purple (#a855f7)
  { pos: 0.76, r: 217, g: 70, b: 239 },  // Neon Magenta (#d946ef)
  { pos: 0.86, r: 236, g: 72, b: 153 },  // Hot Pink (#ec4899)
  { pos: 0.94, r: 244, g: 63, b: 94 },   // Rose Coral (#f43f5e)
  { pos: 1.0, r: 251, g: 146, b: 60 },   // Sunset Amber (#fb923c)
];

function sampleSpectrumColor(fraction: number, alpha = 1): string {
  const t = Math.max(0, Math.min(1, fraction));
  for (let i = 0; i < SPECTRUM_STOPS.length - 1; i++) {
    const s0 = SPECTRUM_STOPS[i];
    const s1 = SPECTRUM_STOPS[i + 1];
    if (t >= s0.pos && t <= s1.pos) {
      const segmentT = (t - s0.pos) / (s1.pos - s0.pos);
      const r = Math.round(s0.r + (s1.r - s0.r) * segmentT);
      const g = Math.round(s0.g + (s1.g - s0.g) * segmentT);
      const b = Math.round(s0.b + (s1.b - s0.b) * segmentT);
      return `rgba(${r}, ${g}, ${b}, ${alpha})`;
    }
  }
  const last = SPECTRUM_STOPS[SPECTRUM_STOPS.length - 1];
  return `rgba(${last.r}, ${last.g}, ${last.b}, ${alpha})`;
}

/**
 * High-performance, 60fps moving audio spectrum visualizer.
 * Renders vertical rounded bars expanding symmetrically from center with
 * multi-color chromatic gradient interpolation and dynamic wave physics.
 */
export default function SpectrumVisualizer({
  phase = 'idle',
  barCount = 28,
  audioLevel = 0,
  glow = true,
  height = 32,
  className = '',
}: SpectrumVisualizerProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);

  // Keep latest props in refs to avoid restarting the animation loop
  const phaseRef = useRef(phase);
  phaseRef.current = phase;
  const audioLevelRef = useRef(audioLevel);
  audioLevelRef.current = audioLevel;
  const glowRef = useRef(glow);
  glowRef.current = glow;
  const barCountRef = useRef(barCount);
  barCountRef.current = barCount;

  useEffect(() => {
    const canvas = canvasRef.current;
    const container = containerRef.current;
    if (!canvas || !container) return;

    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    let animId = 0;
    const currentHeights: number[] = [];
    const count = barCountRef.current;
    for (let i = 0; i < count; i++) {
      currentHeights.push(4);
    }

    let width = container.clientWidth || 240;
    let canvasHeight = height;

    const updateSize = () => {
      if (!canvas || !container) return;
      const rect = container.getBoundingClientRect();
      const dpr = window.devicePixelRatio || 1;
      width = Math.max(80, Math.floor(rect.width));
      canvasHeight = height;
      canvas.width = Math.floor(width * dpr);
      canvas.height = Math.floor(canvasHeight * dpr);
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    };

    updateSize();

    let resizeObserver: ResizeObserver | null = null;
    if (typeof ResizeObserver !== 'undefined') {
      resizeObserver = new ResizeObserver(() => {
        updateSize();
      });
      resizeObserver.observe(container);
    }
    window.addEventListener('resize', updateSize);

    const render = (time: number) => {
      animId = requestAnimationFrame(render);

      const currentPhase = phaseRef.current;
      const currentLevel = audioLevelRef.current;
      const currentGlow = glowRef.current;
      const curCount = barCountRef.current;

      // Adjust heights array size if barCount changed
      while (currentHeights.length < curCount) currentHeights.push(4);
      while (currentHeights.length > curCount) currentHeights.pop();

      ctx.clearRect(0, 0, width, canvasHeight);

      const centerY = canvasHeight / 2;
      const availableHeight = canvasHeight - 4;
      const minH = 4;
      const maxH = Math.max(minH, availableHeight);

      // Bar sizing
      const totalBars = curCount;
      const gap = Math.max(2, Math.min(4, Math.floor(width / (totalBars * 3))));
      const totalGaps = (totalBars - 1) * gap;
      const rawBarWidth = (width - totalGaps) / totalBars;
      const barWidth = Math.max(2.5, Math.min(5.5, rawBarWidth));
      const totalSpectrumWidth = totalBars * barWidth + totalGaps;
      const startX = Math.max(0, (width - totalSpectrumWidth) / 2);

      // Optional ambient backdrop glow
      if (currentGlow && currentPhase !== 'idle' && currentPhase !== 'sleeping') {
        const glowGrad = ctx.createLinearGradient(startX, centerY, startX + totalSpectrumWidth, centerY);
        glowGrad.addColorStop(0, 'rgba(0, 245, 212, 0.07)');
        glowGrad.addColorStop(0.35, 'rgba(99, 102, 241, 0.09)');
        glowGrad.addColorStop(0.68, 'rgba(217, 70, 239, 0.09)');
        glowGrad.addColorStop(1, 'rgba(251, 146, 60, 0.07)');
        ctx.fillStyle = glowGrad;
        ctx.beginPath();
        if (typeof ctx.roundRect === 'function') {
          ctx.roundRect(startX - 6, centerY - availableHeight * 0.45, totalSpectrumWidth + 12, availableHeight * 0.9, 12);
        } else {
          ctx.rect(startX - 6, centerY - availableHeight * 0.45, totalSpectrumWidth + 12, availableHeight * 0.9);
        }
        ctx.fill();
      }

      for (let i = 0; i < totalBars; i++) {
        const fraction = totalBars > 1 ? i / (totalBars - 1) : 0.5;
        const normX = (i - (totalBars - 1) / 2) / ((totalBars - 1) / 2 || 1);
        const envelope = Math.max(0.28, 1 - normX * normX * 0.72);

        let targetH = minH;
        let lerpSpeed = 0.2;

        if (currentPhase === 'speaking') {
          // Dynamic organic speech wave harmonics
          const t = time * 0.0034;
          const w1 = Math.sin(t * 3.4 + i * 0.42);
          const w2 = Math.sin(t * 5.1 - i * 0.38 + 1.2);
          const w3 = Math.cos(t * 2.2 + i * 0.62);
          const w4 = Math.sin(t * 7.5 + i * 0.9) * 0.45;
          const raw = (w1 * 0.35 + w2 * 0.3 + w3 * 0.25 + w4 * 0.1 + 1) / 2;
          targetH = minH + (maxH - minH) * (0.16 + raw * 0.84) * envelope;
          lerpSpeed = 0.24;
        } else if (currentPhase === 'listening') {
          const t = time * 0.0026;
          const boost = Math.min(1, Math.max(0, currentLevel / 0.14));
          if (boost > 0.03) {
            // Live reactive speech audio
            const liveWave = Math.sin(t * 4.8 + i * 0.48) * 0.18;
            const activity = Math.min(1, boost * 0.9 + liveWave);
            targetH = minH + (maxH - minH) * Math.max(0.1, activity) * envelope;
            lerpSpeed = 0.35;
          } else {
            // Ambient breathing ripple while waiting for voice
            const ambient = Math.sin(t * 2.2 + i * 0.28) * 0.22 + 0.28;
            targetH = minH + (maxH * 0.42) * ambient * envelope;
            lerpSpeed = 0.14;
          }
        } else if (currentPhase === 'thinking' || currentPhase === 'connecting') {
          // Smooth traveling iridescent pulse
          const t = time * 0.0028;
          const wave = (Math.sin(t * 2.7 - i * 0.32) + 1) / 2;
          targetH = minH + (maxH * 0.52) * (0.15 + wave * 0.65) * envelope;
          lerpSpeed = 0.14;
        } else if (currentPhase === 'sleeping') {
          const t = time * 0.0012;
          const sleepWave = (Math.sin(t * 1.5 + i * 0.2) + 1) / 2;
          targetH = minH + 3 * sleepWave;
          lerpSpeed = 0.08;
        } else {
          // idle
          const t = time * 0.0015;
          const idleWave = (Math.sin(t + i * 0.25) + 1) / 2;
          targetH = minH + 3 * idleWave;
          lerpSpeed = 0.1;
        }

        // Clamp
        targetH = Math.max(minH, Math.min(maxH, targetH));
        currentHeights[i] += (targetH - currentHeights[i]) * lerpSpeed;
        const h = currentHeights[i];

        const barX = startX + i * (barWidth + gap);
        const top = centerY - h / 2;
        const color = sampleSpectrumColor(
          fraction,
          currentPhase === 'sleeping' ? 0.45 : currentPhase === 'idle' ? 0.6 : 0.95
        );

        ctx.save();
        if (currentGlow && currentPhase !== 'idle' && currentPhase !== 'sleeping') {
          ctx.shadowBlur = Math.min(8, Math.max(2, h * 0.28));
          ctx.shadowColor = sampleSpectrumColor(fraction, 0.7);
        }

        ctx.fillStyle = color;
        ctx.beginPath();
        const radius = Math.min(barWidth / 2, h / 2);
        if (typeof ctx.roundRect === 'function') {
          ctx.roundRect(barX, top, barWidth, h, radius);
        } else {
          ctx.rect(barX, top, barWidth, h);
        }
        ctx.fill();
        ctx.restore();
      }
    };

    animId = requestAnimationFrame(render);

    return () => {
      cancelAnimationFrame(animId);
      if (resizeObserver) resizeObserver.disconnect();
      window.removeEventListener('resize', updateSize);
    };
  }, [height]);

  return (
    <div
      ref={containerRef}
      className={`spectrum-visualizer-container ${phase} ${className}`}
      style={{ height: `${height}px` }}
      aria-hidden="true"
    >
      <canvas ref={canvasRef} className="spectrum-canvas" />
    </div>
  );
}
