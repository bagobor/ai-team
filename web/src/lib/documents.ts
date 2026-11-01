import type { ArtifactType } from '../../../src/artifacts/format.ts';
import { naturalOrder } from './lineageLayout.ts';

export type DocumentGroup<T> = { label: string; documents: T[] };

// In reading order. Keyed by every type, so that a new one can't drop off the list without the compiler saying so.
const GROUP_OF: Record<ArtifactType, string> = {
  brief: 'Brief',
  roadmap: 'Discovery',
  team_proposal: 'Discovery',
  human_requirements: 'Discovery',
  environment_profile: 'Discovery',
  spec: 'Milestone specs',
  tech_design: 'Design',
  test_plan: 'Test',
  ticket: 'Tickets',
  bug: 'Tickets',
  change_report: 'Reports',
  review_report: 'Reports',
  qa_report: 'Reports',
  milestone_review: 'Reports',
  change_request: 'Decisions',
  decision_record: 'Decisions',
};

const LABELS = [...new Set(Object.values(GROUP_OF))];

export function groupDocuments<T extends { artifact_id: string; type: ArtifactType }>(rows: T[]): DocumentGroup<T>[] {
  return LABELS.map((label) => ({
    label,
    documents: rows.filter(({ type }) => GROUP_OF[type] === label).sort((a, b) => naturalOrder(a.artifact_id, b.artifact_id)),
  })).filter(({ documents }) => documents.length > 0);
}
