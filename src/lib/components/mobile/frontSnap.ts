/** Snap to the nearest front-facing revolution without spinning a full turn. */
export function frontSnap(x: number, y: number, threshold = 18): { x: number; y: number } | null {
  if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
  const front = Math.round(y / 360) * 360;
  return Math.abs(x) <= threshold && Math.abs(y - front) <= threshold ? { x: 0, y: front } : null;
}
