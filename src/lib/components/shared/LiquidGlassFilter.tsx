import { useEffect, useState } from 'react';

/**
 * Generates an SDF-based displacement map encoding rounded rectangle bevel normals.
 * Red channel -> X displacement
 * Green channel -> Y displacement
 * 128 is neutral (0 displacement).
 */
function generateSdfDisplacementMap(size = 200, cornerRadiusRatio = 0.16, bevelRatio = 0.10): string {
  if (typeof document === 'undefined') return '';
  
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d');
  if (!ctx) return '';

  const imgData = ctx.createImageData(size, size);
  const data = imgData.data;

  const r = cornerRadiusRatio;
  const w = bevelRatio;

  for (let y = 0; y < size; y++) {
    const ny = y / (size - 1);
    const dy = Math.abs(ny - 0.5) - (0.5 - r);

    for (let x = 0; x < size; x++) {
      const nx = x / (size - 1);
      const dx = Math.abs(nx - 0.5) - (0.5 - r);

      const dOut = Math.hypot(Math.max(dx, 0), Math.max(dy, 0));
      const dIn = Math.min(Math.max(dx, dy), 0);
      const d = dOut + dIn - r;

      let dispX = 0;
      let dispY = 0;

      if (d <= 0 && d >= -w) {
        const t = -d / w;
        const magnitude = Math.sin(Math.PI * t) * 0.95;

        let nxDir = 0;
        let nyDir = 0;

        if (dx > 0 && dy > 0) {
          const len = Math.hypot(dx, dy) || 1;
          nxDir = (dx / len) * Math.sign(nx - 0.5);
          nyDir = (dy / len) * Math.sign(ny - 0.5);
        } else if (dx > dy) {
          nxDir = Math.sign(nx - 0.5);
          nyDir = 0;
        } else {
          nxDir = 0;
          nyDir = Math.sign(ny - 0.5);
        }

        dispX = -nxDir * magnitude;
        dispY = -nyDir * magnitude;
      }

      const idx = (y * size + x) * 4;
      data[idx] = Math.min(255, Math.max(0, Math.round(128 + dispX * 127)));
      data[idx + 1] = Math.min(255, Math.max(0, Math.round(128 + dispY * 127)));
      data[idx + 2] = 128;
      data[idx + 3] = 255;
    }
  }

  ctx.putImageData(imgData, 0, 0);
  return canvas.toDataURL('image/png');
}

export default function LiquidGlassFilter() {
  const [dispMapUrl, setDispMapUrl] = useState<string>('');

  useEffect(() => {
    const url = generateSdfDisplacementMap(200, 0.16, 0.10);
    setDispMapUrl(url);

    // Pointer listener for dynamic Fresnel specular shine spot
    const GLASS_SELECTOR =
      '.lg-surface, .lg-interactive, .bento-card, .room-panel, .titlebar, .activity-bar, .sidebar-panel, .terminal-panel, .command-palette, .floating-search-bar, .project-hud, .settings-modal, .welcome-card, .glass-panel, .floating-pod, .modal-content, [class*="card"], [class*="panel"], [class*="modal"]';

    const handlePointerMove = (e: PointerEvent) => {
      const target = (e.target as HTMLElement)?.closest?.(GLASS_SELECTOR) as HTMLElement | null;
      if (target) {
        const rect = target.getBoundingClientRect();
        if (rect.width > 0 && rect.height > 0) {
          const x = ((e.clientX - rect.left) / rect.width) * 100;
          const y = ((e.clientY - rect.top) / rect.height) * 100;
          target.style.setProperty('--shine-x', `${x.toFixed(1)}%`);
          target.style.setProperty('--shine-y', `${y.toFixed(1)}%`);
        }
      }
    };

    window.addEventListener('pointermove', handlePointerMove, { passive: true });
    return () => window.removeEventListener('pointermove', handlePointerMove);
  }, []);

  if (!dispMapUrl) return null;

  return (
    <svg
      style={{ position: 'absolute', width: 0, height: 0, overflow: 'hidden', pointerEvents: 'none' }}
      aria-hidden="true"
    >
      <filter id="liquid-lens" colorInterpolationFilters="sRGB" x="-10%" y="-10%" width="120%" height="120%">
        <feImage href={dispMapUrl} result="dispMap" width="100%" height="100%" preserveAspectRatio="none" />
        
        {/* Chromatic Aberration: Red channel (IOR 1.51) */}
        <feDisplacementMap in="SourceGraphic" in2="dispMap" scale="26" xChannelSelector="R" yChannelSelector="G" result="dispR" />
        <feColorMatrix in="dispR" type="matrix" values="1 0 0 0 0  0 0 0 0 0  0 0 0 0 0  0 0 0 1 0" result="redOnly" />
        
        {/* Chromatic Aberration: Green channel (IOR 1.50) */}
        <feDisplacementMap in="SourceGraphic" in2="dispMap" scale="22" xChannelSelector="R" yChannelSelector="G" result="dispG" />
        <feColorMatrix in="dispG" type="matrix" values="0 0 0 0 0  0 1 0 0 0  0 0 0 0 0  0 0 0 1 0" result="greenOnly" />
        
        {/* Chromatic Aberration: Blue channel (IOR 1.49) */}
        <feDisplacementMap in="SourceGraphic" in2="dispMap" scale="18" xChannelSelector="R" yChannelSelector="G" result="dispB" />
        <feColorMatrix in="dispB" type="matrix" values="0 0 0 0 0  0 0 0 0 0  0 0 1 0 0  0 0 0 1 0" result="blueOnly" />

        {/* Recombine channels */}
        <feComposite in="redOnly" in2="greenOnly" operator="arithmetic" k2="1" k3="1" result="rgBlend" />
        <feComposite in="rgBlend" in2="blueOnly" operator="arithmetic" k2="1" k3="1" result="lensedGraphic" />
      </filter>
    </svg>
  );
}
