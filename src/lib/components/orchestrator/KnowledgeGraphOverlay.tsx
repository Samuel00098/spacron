import { useEffect, useMemo, useState } from 'react';
import { activeProject } from '$lib/stores/workspace';
import {
  knowledgeGraph,
  knowledgeGraphOpen,
  buildNoteGraph,
  loadKnowledgeGraph,
  type MemoryNote,
} from '$lib/services/orchestrator/knowledge';
import { layoutGraph } from '$lib/services/orchestrator/knowledge-layout';
import { useStore } from '$lib/react/useStore';
import './KnowledgeGraphOverlay.css';

const W = 900;
const H = 620;

function ageLabel(ts: number, now = Date.now()): string {
  const days = Math.floor(Math.max(0, now - ts) / 86_400_000);
  if (days < 1) return 'today';
  if (days === 1) return 'yesterday';
  if (days < 30) return `${days}d ago`;
  const months = Math.floor(days / 30);
  return months < 12 ? `${months}mo ago` : `${Math.floor(months / 12)}y ago`;
}

/**
 * The knowledge-graph view: the authored, wikilinked notes agents leave under
 * `.spacron/memory/` drawn as a force-directed graph — nodes are notes, edges are
 * `[[wikilinks]]`. Click a node to read it; its outgoing links are chips that jump
 * to the linked note. A local, free counterpart to BridgeMemory's graph view.
 *
 * Mounted at the app root and toggled by `knowledgeGraphOpen`, mirroring ProjectHUD.
 */
export default function KnowledgeGraphOverlay() {
  const isOpen = useStore(knowledgeGraphOpen);
  const project = useStore(activeProject);
  const graphs = useStore(knowledgeGraph);
  const projectId = project?.id ?? '';
  const notes = useMemo(() => graphs[projectId] ?? [], [graphs, projectId]);

  const [selected, setSelected] = useState<string | null>(null);

  // Refresh from disk each time the overlay opens so newly-authored notes appear.
  useEffect(() => {
    if (isOpen && project) void loadKnowledgeGraph(project.id, project.root_path);
  }, [isOpen, project]);

  // Close on Escape.
  useEffect(() => {
    if (!isOpen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { e.preventDefault(); knowledgeGraphOpen.set(false); }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [isOpen]);

  const { nodes, edges } = useMemo(() => buildNoteGraph(notes), [notes]);

  const positions = useMemo(
    () => layoutGraph(nodes, edges, { width: W, height: H }),
    [nodes, edges],
  );

  // Node degree drives radius, so hub notes read as more central.
  const degree = useMemo(() => {
    const d = new Map<string, number>();
    for (const e of edges) {
      d.set(e.from, (d.get(e.from) ?? 0) + 1);
      d.set(e.to, (d.get(e.to) ?? 0) + 1);
    }
    return d;
  }, [edges]);

  const bySlug = useMemo(() => new Map(notes.map((n) => [n.slug, n])), [notes]);
  const selectedNote: MemoryNote | null = selected ? bySlug.get(selected) ?? null : null;
  const neighbors = useMemo(() => {
    if (!selected) return new Set<string>();
    const s = new Set<string>();
    for (const e of edges) {
      if (e.from === selected) s.add(e.to);
      if (e.to === selected) s.add(e.from);
    }
    return s;
  }, [selected, edges]);

  if (!isOpen) return null;

  const nodeRadius = (slug: string) => 7 + Math.min(11, (degree.get(slug) ?? 0) * 2);

  return (
    <div className="kg-overlay" onClick={() => knowledgeGraphOpen.set(false)}>
      <div className="kg-panel" onClick={(e) => e.stopPropagation()}>
        <header className="kg-header">
          <div className="kg-title">
            <span className="kg-title-dot" />
            <span>knowledge graph</span>
            <span className="kg-title-sub">
              {notes.length} note{notes.length === 1 ? '' : 's'} · {edges.length} link{edges.length === 1 ? '' : 's'}
            </span>
          </div>
          <button className="kg-close" onClick={() => knowledgeGraphOpen.set(false)} aria-label="Close" title="Close (Esc)">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round">
              <line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" />
            </svg>
          </button>
        </header>

        <div className="kg-body">
          {notes.length === 0 ? (
            <div className="kg-empty">
              <svg width="34" height="34" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                <circle cx="5" cy="6" r="2.5" /><circle cx="19" cy="6" r="2.5" /><circle cx="12" cy="18" r="2.5" />
                <path d="M7.2 7.2 10.5 16M16.8 7.2 13.5 16M7 6h10" />
              </svg>
              <h3>No memory yet</h3>
              <p>
                As agents work, they author wikilinked notes under
                <code> .spacron/memory/</code>. What one agent learns, the next one
                starts with — and it shows up here as a graph.
              </p>
            </div>
          ) : (
            <>
              <div className="kg-canvas-wrap">
                <svg className="kg-canvas" viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="xMidYMid meet" role="img" aria-label="Knowledge graph">
                  {edges.map((e) => {
                    const a = positions.get(e.from);
                    const b = positions.get(e.to);
                    if (!a || !b) return null;
                    const active = selected === e.from || selected === e.to;
                    return (
                      <line
                        key={`${e.from}->${e.to}`}
                        x1={a.x} y1={a.y} x2={b.x} y2={b.y}
                        className={`kg-edge${active ? ' active' : selected ? ' dim' : ''}`}
                      />
                    );
                  })}
                  {nodes.map((node) => {
                    const p = positions.get(node.slug);
                    if (!p) return null;
                    const isSel = selected === node.slug;
                    const isNeighbor = neighbors.has(node.slug);
                    const dim = selected && !isSel && !isNeighbor;
                    const r = nodeRadius(node.slug);
                    return (
                      <g
                        key={node.slug}
                        className={`kg-node${isSel ? ' selected' : ''}${dim ? ' dim' : ''}`}
                        transform={`translate(${p.x} ${p.y})`}
                        onClick={(ev) => { ev.stopPropagation(); setSelected(isSel ? null : node.slug); }}
                      >
                        <circle r={r} className="kg-node-dot" />
                        <text y={r + 13} textAnchor="middle" className="kg-node-label">
                          {node.title.length > 26 ? `${node.title.slice(0, 25)}…` : node.title}
                        </text>
                      </g>
                    );
                  })}
                </svg>
              </div>

              <aside className="kg-detail">
                {selectedNote ? (
                  <>
                    <div className="kg-detail-head">
                      <h3>{selectedNote.title}</h3>
                      <span className="kg-detail-age">updated {ageLabel(selectedNote.updatedAt)}</span>
                    </div>
                    <div className="kg-detail-body">
                      {selectedNote.body ? selectedNote.body : <span className="kg-detail-muted">(no body)</span>}
                    </div>
                    {selectedNote.links.length > 0 && (
                      <div className="kg-detail-links">
                        <span className="kg-detail-links-label">Links to</span>
                        <div className="kg-chip-row">
                          {selectedNote.links.map((slug) => {
                            const exists = bySlug.has(slug);
                            return (
                              <button
                                key={slug}
                                className={`kg-chip${exists ? '' : ' dangling'}`}
                                disabled={!exists}
                                onClick={() => exists && setSelected(slug)}
                                title={exists ? `Go to ${slug}` : 'No note authored yet'}
                              >
                                {bySlug.get(slug)?.title ?? slug}
                              </button>
                            );
                          })}
                        </div>
                      </div>
                    )}
                  </>
                ) : (
                  <div className="kg-detail-hint">
                    <p>Click a note to read it.</p>
                    <p className="kg-detail-muted">Bigger dots are more-linked notes — the hubs of what the team has learned.</p>
                  </div>
                )}
              </aside>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
