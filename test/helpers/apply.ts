import type { Criterion } from '../../src/artifacts/acs.ts';
import { applyOutput, type ApplyCtx, type ApplyResult } from '../../src/engine/apply/index.ts';
import type { ArtifactVersionRow, NewTask, ProjectRow, TaskRow } from '../../src/engine/store.ts';
import type { Purpose, WorkOrder } from '../../src/engine/workorder.ts';
import type { TestEngine } from './engine.ts';

export const CRITERIA: Criterion[] = [
  { id: 'AC-1', text: 'The first thing works', verification: { method: 'automated', how: 'npm test -- first' } },
  { id: 'AC-2', text: 'The second thing works', verification: { method: 'automated', how: 'npm test -- second' } },
];

export async function projectOf(e: TestEngine): Promise<ProjectRow> {
  const project = await e.store.getProject('p');
  if (!project) throw new Error('makeEngine should have created project p');
  return project;
}

export const specBody = (criteria: Criterion[]): string => `# Spec\n\n## Acceptance criteria\n\n${criteria.map((c) => `### ${c.id}\n\n${c.text}\n`).join('\n')}`;

// An approved spec and its locked criteria: what CP2 leaves behind.
export async function lockSpec(e: TestEngine, criteria: Criterion[] = CRITERIA, milestone = 1): Promise<ArtifactVersionRow> {
  const project = await projectOf(e);
  const [row] = await e.artifacts.commit(project, {
    message: 'the approved spec',
    publish: [{ id: `SPEC-M${milestone}`, type: 'spec', status: 'approved', ownerRole: 'pm', derivedFrom: [], milestone, body: specBody(criteria), acceptanceCriteria: criteria.map((c) => c.id) }],
  });
  await e.store.lockCriteria(project.id, milestone, row!.version, criteria);
  return row!;
}

export async function ticketTask(e: TestEngine, id: string, fields: Partial<NewTask> = {}): Promise<TaskRow> {
  const project = await projectOf(e);
  return e.store.createTask({
    project_id: project.id,
    ticket_id: id,
    title: id,
    milestone: 1,
    role_id: 'engineer',
    ticket_path: `artifacts/ticket/${id}.md`,
    ticket_sha: '',
    touches: ['src/**'],
    depends_on: [],
    dod: ['true'],
    kind: 'ticket',
    ...fields,
  });
}

let tasks = 0;

// The context an applier gets, for a task that really is in the store.
export async function ctxFor(e: TestEngine, purpose: Purpose, output: unknown, opts: { inputs?: string[]; milestone?: number; worktree?: string; kind?: NewTask['kind']; role?: string; baseSha?: string; subject?: WorkOrder['subject'] } = {}): Promise<ApplyCtx> {
  const project = await projectOf(e);
  const order: WorkOrder = { purpose, instructions: 'Do it', inputs: opts.inputs ?? [], checks: [], base: { kind: 'base' }, ...(opts.subject ? { subject: opts.subject } : {}) };
  tasks += 1;
  const task = await e.store.createTask({
    project_id: project.id,
    ticket_id: `TASK-${tasks}`,
    title: purpose,
    milestone: opts.milestone ?? 1,
    role_id: opts.role ?? 'pm',
    ticket_path: '',
    ticket_sha: '',
    touches: [],
    depends_on: [],
    dod: [],
    kind: opts.kind ?? 'authoring',
    purpose,
    work_order: order,
  });
  const worktree = opts.worktree ?? e.repoPath;
  const attempt = await e.store.createAttempt({ task_id: task.id, adapter: 'claude', model: 'm', worktree_path: worktree, branch: 'b', ...(opts.baseSha ? { base_sha: opts.baseSha } : {}) });
  return { deps: e, project, task, attempt, order, output, worktree, signal: new AbortController().signal, report: { onEvent: () => {}, onSpawn: () => {} } };
}

export const apply = async (e: TestEngine, purpose: Purpose, output: unknown, opts: Parameters<typeof ctxFor>[3] = {}): Promise<ApplyResult> => applyOutput(await ctxFor(e, purpose, output, opts));

export function evidenceOf(result: ApplyResult): string {
  if (result.ok) throw new Error(`Expected a refusal, got ${JSON.stringify(result.change)}`);
  return result.evidence;
}

// What the runner does with an accepted result.
export async function publish(e: TestEngine, result: ApplyResult): Promise<ArtifactVersionRow[]> {
  if (!result.ok) throw new Error(`Expected the output to be accepted: ${result.evidence}`);
  return e.artifacts.commit(await projectOf(e), result.change, async (s, rows) => result.after?.(s, rows));
}
