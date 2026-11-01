import type { ArtifactStatus } from '../../../src/artifacts/format.ts';
import type { LineageGraph as Lineage } from '../../../src/artifacts/lineage.ts';
import { layoutLineage } from '../lib/lineageLayout.ts';

const SIZE = { nodeW: 150, nodeH: 46, gapX: 36, gapY: 12 };

const LAMP: Record<ArtifactStatus, string> = { draft: 'idle', proposed: 'idle', approved: 'pass', superseded: 'idle', stale: 'stale' };

function statusLabel({ status, staleSections }: Lineage['nodes'][number]): string {
  if (status === 'stale' && staleSections.length > 0) return `${staleSections.map((section) => `§${section}`).join(' ')} stale`;
  return status;
}

export function LineageGraph({ graph, selected, onSelect }: { graph: Lineage; selected: string | null; onSelect: (id: string) => void }) {
  const { nodes, edges, width, height } = layoutLineage(graph, SIZE);
  const documents = new Map(graph.nodes.map((node) => [node.id, node]));
  // Drawn last, so that a stale line is never hidden behind a current one.
  const lines = [...edges].sort((a, b) => Number(a.stale) - Number(b.stale));

  return (
    <>
      <div className="lg-wrap">
        <div className="lg" style={{ width, height }}>
          <svg width={width} height={height} aria-hidden="true">
            <defs>
              <marker id="ah-n" viewBox="0 0 8 8" refX="7.2" refY="4" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
                <path d="M0,0.5 L8,4 L0,7.5 z" style={{ fill: 'var(--ink-4)' }} />
              </marker>
              <marker id="ah-s" viewBox="0 0 8 8" refX="7.2" refY="4" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
                <path d="M0,0.5 L8,4 L0,7.5 z" style={{ fill: 'var(--stale)' }} />
              </marker>
            </defs>
            {lines.map(({ from, to, path, stale }) => (
              <path key={`${from} ${to}`} className={`e${stale ? ' stale' : ''}`} d={path} markerEnd={`url(#${stale ? 'ah-s' : 'ah-n'})`} />
            ))}
          </svg>
          {nodes.map(({ id, x, y }) => {
            const node = documents.get(id)!;
            return (
              <button
                key={id}
                type="button"
                className={`gn${node.status === 'stale' ? ' stale' : ''}${id === selected ? ' sel' : ''}`}
                style={{ left: x, top: y, width: SIZE.nodeW, height: SIZE.nodeH }}
                title={id}
                aria-pressed={id === selected}
                onClick={() => onSelect(id)}
              >
                <span className="t">{id}</span>
                <span className="m">
                  <span className="mono">v{node.version}</span>
                  <span className={`lamp ${LAMP[node.status]}`} />
                  {statusLabel(node)}
                </span>
              </button>
            );
          })}
        </div>
      </div>
      <div className="lg-legend">
        <span>
          <i className="sw-n" />
          current
        </span>
        <span>
          <i className="sw-s" />
          stale
        </span>
        <span>
          <i className="ed" />
          stale link
        </span>
      </div>
    </>
  );
}
