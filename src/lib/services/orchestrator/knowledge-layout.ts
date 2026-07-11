/**
 * A tiny deterministic force-directed layout (Fruchterman–Reingold) for the
 * knowledge-graph view. Pure and seeded by node order, so the same graph always
 * lays out the same way — stable across re-renders and unit-testable, with no
 * animation loop or external dependency. Coordinates land inside the given box.
 */
import type { NoteEdge } from './knowledge';

export interface LaidOutNode {
  slug: string;
  x: number;
  y: number;
}

export function layoutGraph(
  nodes: Array<{ slug: string }>,
  edges: NoteEdge[],
  opts: { width?: number; height?: number; iterations?: number } = {},
): Map<string, LaidOutNode> {
  const width = opts.width ?? 800;
  const height = opts.height ?? 600;
  const n = nodes.length;
  const out = new Map<string, LaidOutNode>();
  if (n === 0) return out;

  const cx = width / 2;
  const cy = height / 2;

  // Seed positions on a circle (deterministic) so runs are reproducible.
  const pos = new Map<string, { x: number; y: number }>();
  const radius = Math.min(width, height) * 0.35;
  nodes.forEach((node, i) => {
    const angle = (2 * Math.PI * i) / n;
    pos.set(node.slug, { x: cx + radius * Math.cos(angle), y: cy + radius * Math.sin(angle) });
  });
  if (n === 1) {
    out.set(nodes[0].slug, { slug: nodes[0].slug, x: cx, y: cy });
    return out;
  }

  const k = Math.sqrt((width * height) / n); // ideal edge length
  // Scale iteration count down for larger graphs so the O(iters·n²) cost stays bounded.
  const iterations = Math.max(60, Math.min(opts.iterations ?? 300, Math.floor(20000 / n)));
  let temp = Math.min(width, height) * 0.1;
  const cool = temp / (iterations + 1);

  const adj = edges.filter((e) => pos.has(e.from) && pos.has(e.to));
  const pad = 36;

  for (let it = 0; it < iterations; it++) {
    const disp = new Map<string, { x: number; y: number }>();
    for (const node of nodes) disp.set(node.slug, { x: 0, y: 0 });

    // Repulsion between every pair.
    for (let i = 0; i < n; i++) {
      for (let j = i + 1; j < n; j++) {
        const a = pos.get(nodes[i].slug)!;
        const b = pos.get(nodes[j].slug)!;
        const dx = a.x - b.x;
        const dy = a.y - b.y;
        const dist = Math.hypot(dx, dy) || 0.01;
        const force = (k * k) / dist;
        const ux = dx / dist;
        const uy = dy / dist;
        const da = disp.get(nodes[i].slug)!;
        const db = disp.get(nodes[j].slug)!;
        da.x += ux * force;
        da.y += uy * force;
        db.x -= ux * force;
        db.y -= uy * force;
      }
    }

    // Attraction along edges.
    for (const e of adj) {
      const a = pos.get(e.from)!;
      const b = pos.get(e.to)!;
      const dx = a.x - b.x;
      const dy = a.y - b.y;
      const dist = Math.hypot(dx, dy) || 0.01;
      const force = (dist * dist) / k;
      const ux = dx / dist;
      const uy = dy / dist;
      const da = disp.get(e.from)!;
      const db = disp.get(e.to)!;
      da.x -= ux * force;
      da.y -= uy * force;
      db.x += ux * force;
      db.y += uy * force;
    }

    // Apply displacement, capped by the (cooling) temperature; clamp to the box.
    for (const node of nodes) {
      const d = disp.get(node.slug)!;
      const p = pos.get(node.slug)!;
      const len = Math.hypot(d.x, d.y) || 0.01;
      p.x += (d.x / len) * Math.min(len, temp);
      p.y += (d.y / len) * Math.min(len, temp);
      p.x = Math.max(pad, Math.min(width - pad, p.x));
      p.y = Math.max(pad, Math.min(height - pad, p.y));
    }
    temp = Math.max(0, temp - cool);
  }

  for (const node of nodes) {
    const p = pos.get(node.slug)!;
    out.set(node.slug, { slug: node.slug, x: p.x, y: p.y });
  }
  return out;
}
