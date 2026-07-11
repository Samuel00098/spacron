import { describe, expect, it } from 'vitest';
import { layoutGraph } from './knowledge-layout';
import { buildNoteGraph, type MemoryNote } from './knowledge';

function note(over: Partial<MemoryNote> & { slug: string }): MemoryNote {
  return {
    slug: over.slug,
    title: over.title ?? over.slug,
    body: over.body ?? '',
    links: over.links ?? [],
    updatedAt: over.updatedAt ?? 1,
  };
}

describe('buildNoteGraph', () => {
  it('keeps only edges whose target is a real note and drops self/dangling links', () => {
    const notes = [
      note({ slug: 'a', links: ['b', 'ghost', 'a'] }),
      note({ slug: 'b', links: ['a'] }),
    ];
    const { nodes, edges } = buildNoteGraph(notes);
    expect(nodes).toHaveLength(2);
    expect(edges).toEqual([
      { from: 'a', to: 'b' },
      { from: 'b', to: 'a' },
    ]);
  });

  it('dedupes repeated links between the same pair', () => {
    const notes = [note({ slug: 'a', links: ['b', 'b'] }), note({ slug: 'b' })];
    expect(buildNoteGraph(notes).edges).toEqual([{ from: 'a', to: 'b' }]);
  });
});

describe('layoutGraph', () => {
  const box = { width: 800, height: 600 };

  it('is deterministic — same input yields the same positions', () => {
    const nodes = [{ slug: 'a' }, { slug: 'b' }, { slug: 'c' }];
    const edges = [{ from: 'a', to: 'b' }, { from: 'b', to: 'c' }];
    const one = layoutGraph(nodes, edges, box);
    const two = layoutGraph(nodes, edges, box);
    for (const n of nodes) {
      expect(two.get(n.slug)).toEqual(one.get(n.slug));
    }
  });

  it('keeps every node inside the box', () => {
    const nodes = Array.from({ length: 12 }, (_, i) => ({ slug: `n${i}` }));
    const edges = nodes.slice(1).map((n, i) => ({ from: nodes[i].slug, to: n.slug }));
    const pos = layoutGraph(nodes, edges, box);
    for (const n of nodes) {
      const p = pos.get(n.slug)!;
      expect(p.x).toBeGreaterThanOrEqual(0);
      expect(p.x).toBeLessThanOrEqual(box.width);
      expect(p.y).toBeGreaterThanOrEqual(0);
      expect(p.y).toBeLessThanOrEqual(box.height);
    }
  });

  it('centers a single node and handles the empty graph', () => {
    expect(layoutGraph([], [], box).size).toBe(0);
    const one = layoutGraph([{ slug: 'solo' }], [], box);
    expect(one.get('solo')).toEqual({ slug: 'solo', x: 400, y: 300 });
  });
});
