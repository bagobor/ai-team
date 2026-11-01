import type { LineageGraph } from '../../../src/artifacts/lineage.ts';

export type LineageSize = { nodeW: number; nodeH: number; gapX: number; gapY: number };
export type LineageLayout = {
  nodes: { id: string; x: number; y: number }[];
  edges: { from: string; to: string; path: string; stale: boolean }[];
  width: number;
  height: number;
};
export type StaleNote = { source: string; version: number; citing: string[] };

// So that T-2 comes before T-10.
export const naturalOrder = (a: string, b: string) => a.localeCompare(b, 'en', { numeric: true });

// A document's layer is the longest path to it from a document with no sources. The engine refuses
// cycles, but this draws whatever it's given: inside a cycle, a document already being visited counts as a source.
function layers(ids: string[], sourcesOf: Map<string, string[]>): Map<string, number> {
  const found = new Map<string, number>();
  const visiting = new Set<string>();

  const depth = (id: string): number => {
    const known = found.get(id);
    if (known !== undefined) return known;
    if (visiting.has(id)) return -1;
    visiting.add(id);
    const layer = Math.max(-1, ...(sourcesOf.get(id) ?? []).map(depth)) + 1;
    visiting.delete(id);
    found.set(id, layer);
    return layer;
  };

  for (const id of ids) depth(id);
  return found;
}

export function layoutLineage(graph: LineageGraph, { nodeW, nodeH, gapX, gapY }: LineageSize): LineageLayout {
  const ids = graph.nodes.map(({ id }) => id).sort(naturalOrder);
  const known = new Set(ids);

  // One line between two documents, however many of the source's sections the derived one cites.
  const links = new Map<string, { from: string; to: string; stale: boolean }>();
  for (const { from, to, stale } of graph.edges) {
    if (!known.has(from) || !known.has(to)) continue;
    const key = JSON.stringify([from, to]);
    const link = links.get(key);
    if (link) link.stale ||= stale;
    else links.set(key, { from, to, stale });
  }

  const sourcesOf = new Map<string, string[]>();
  for (const { from, to } of links.values()) sourcesOf.set(to, [...(sourcesOf.get(to) ?? []), from]);
  const layerOf = layers(ids, sourcesOf);

  const rows: number[] = [];
  const places = new Map<string, { x: number; y: number }>();
  for (const id of ids) {
    const layer = layerOf.get(id) ?? 0;
    const row = rows[layer] ?? 0;
    rows[layer] = row + 1;
    places.set(id, { x: layer * (nodeW + gapX), y: row * (nodeH + gapY) });
  }

  const nodes = ids.map((id) => {
    const { x, y } = places.get(id)!;
    return { id, x, y };
  });

  const edges = [...links.values()].map(({ from, to, stale }) => {
    const source = places.get(from)!;
    const target = places.get(to)!;
    const [x1, y1, x2, y2] = [source.x + nodeW, source.y + nodeH / 2, target.x, target.y + nodeH / 2];
    const middle = (x1 + x2) / 2;
    return { from, to, stale, path: `M${x1} ${y1} C${middle} ${y1} ${middle} ${y2} ${x2} ${y2}` };
  });

  const tallest = Math.max(0, ...rows.map((row) => row ?? 0));
  return {
    nodes,
    edges,
    width: rows.length === 0 ? 0 : rows.length * nodeW + (rows.length - 1) * gapX,
    height: tallest === 0 ? 0 : tallest * nodeH + (tallest - 1) * gapY,
  };
}

export function staleNotes(graph: LineageGraph): StaleNote[] {
  const citing = new Map<string, Set<string>>();
  for (const { from, to, section, stale } of graph.edges) {
    if (!stale) continue;
    const documents = citing.get(from) ?? new Set<string>();
    documents.add(section === null ? to : `${to} §${section}`);
    citing.set(from, documents);
  }

  return graph.nodes
    .filter(({ id }) => citing.has(id))
    .map(({ id, version }) => ({ source: id, version, citing: [...citing.get(id)!].sort(naturalOrder) }))
    .sort((a, b) => naturalOrder(a.source, b.source));
}
