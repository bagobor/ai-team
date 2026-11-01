import type { ProjectRow, Store } from '../engine/store.ts';
import { sectionsOf, type ArtifactStatus, type ArtifactType } from './format.ts';
import type { StatusChange } from './store.ts';

// Records say what happened, and a later change to their source doesn't make that any less true.
export const RECORD_TYPES = ['change_report', 'review_report', 'qa_report', 'decision_record', 'change_request', 'milestone_review', 'bug'] as const;

const isRecord = (type: ArtifactType) => (RECORD_TYPES as readonly ArtifactType[]).includes(type);

// Who a new approved version makes stale. Only direct dependents: theirs wait until they get a new approved
// version of their own, so one edit can't stale a whole project in one step.
export async function staleHits(deps: { store: Store }, project: ProjectRow, published: { id: string; version: number; body: string }): Promise<StatusChange[]> {
  const sections = sectionsOf(published.body);
  const staleSections = new Map<string, Set<string>>();

  for (const dep of await deps.store.listArtifactDeps(project.id)) {
    if (dep.to_id !== published.id || dep.to_version >= published.version || dep.from_id === published.id) continue;
    if (dep.to_section !== null && sections.find(({ slug }) => slug === dep.to_section)?.hash === dep.to_section_hash) continue;

    const dependent = await deps.store.latestArtifact(project.id, dep.from_id);
    if (!dependent || dependent.version !== dep.from_version || dependent.status === 'superseded' || isRecord(dependent.type)) continue;

    const hit = staleSections.get(dep.from_id) ?? new Set(dependent.status === 'stale' ? dependent.stale_sections : []);
    if (dep.to_section !== null) hit.add(dep.to_section);
    staleSections.set(dep.from_id, hit);
  }

  const hits: StatusChange[] = [];
  for (const [id, hit] of staleSections) {
    const dependent = await deps.store.latestArtifact(project.id, id);
    // Already stale for exactly these reasons: there is nothing to rewrite.
    if (dependent?.status === 'stale' && dependent.stale_sections.length === hit.size) continue;
    hits.push({ id, status: 'stale', staleSections: [...hit] });
  }
  return hits;
}

export type LineageGraph = {
  nodes: { id: string; type: ArtifactType; version: number; status: ArtifactStatus; staleSections: string[] }[];
  edges: { from: string; to: string; section: string | null; pinnedVersion: number; stale: boolean }[];
};

export async function lineageGraph(store: Store, projectId: number): Promise<LineageGraph> {
  const latest = await store.listLatestArtifacts(projectId);
  const byId = new Map(latest.map((row) => [row.artifact_id, row]));

  const edges: LineageGraph['edges'] = [];
  for (const dep of await store.listArtifactDeps(projectId)) {
    const derived = byId.get(dep.from_id);
    const source = byId.get(dep.to_id);
    if (!derived || !source || derived.version !== dep.from_version) continue;

    const behind = dep.to_section === null ? dep.to_version < source.version : derived.stale_sections.includes(dep.to_section);
    edges.push({ from: dep.to_id, to: dep.from_id, section: dep.to_section, pinnedVersion: dep.to_version, stale: derived.status === 'stale' && behind });
  }

  return {
    nodes: latest.map((row) => ({ id: row.artifact_id, type: row.type, version: row.version, status: row.status, staleSections: row.stale_sections })),
    edges,
  };
}
