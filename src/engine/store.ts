import { sql, type Kysely, type Selectable, type Updateable } from 'kysely';
import { AC_ID, type Criterion, type CriterionStatus, type Verification } from '../artifacts/acs.ts';
import type { ArtifactStatus, ArtifactType } from '../artifacts/format.ts';
import type { AcceptanceCriteriaTable, ArtifactDepsTable, ArtifactVersionsTable, AttemptsTable, DB, InboxItemsTable, MilestonesTable, ProjectsTable, TasksTable, VendorPausesTable } from '../db/schema.ts';
import type { EventLog, EventRow, EventType } from '../events.ts';
import {
  assertAttemptTransition,
  assertMilestoneTransition,
  assertProjectTransition,
  assertTaskTransition,
  ATTEMPT_TRANSITIONS,
  type AttemptState,
  type MilestonePhase,
  type ProjectPhase,
  type TaskState,
} from './fsm.ts';
import { AlreadyAnswered, assertValidAnswer, type InboxAnswer, type InboxEvidence, type InboxOption, type InboxRef, type InboxRow, type InboxState, type InboxType, type NewInboxItem } from './inbox.ts';
import type { WorkOrder } from './workorder.ts';

export type ProjectRow = Omit<Selectable<ProjectsTable>, 'phase'> & { phase: ProjectPhase };
export type NewProject = Pick<ProjectRow, 'name' | 'repo_path' | 'base_branch'>;

export type TaskRow = Omit<Selectable<TasksTable>, 'state' | 'touches' | 'depends_on' | 'dod' | 'work_order' | 'ac_refs'> & {
  state: TaskState;
  touches: string[];
  depends_on: string[];
  dod: string[];
  work_order: WorkOrder | null;
  ac_refs: string[];
};
export type NewTask = Pick<
  TaskRow,
  'project_id' | 'ticket_id' | 'title' | 'milestone' | 'role_id' | 'ticket_path' | 'ticket_sha' | 'touches' | 'depends_on' | 'dod'
> &
  Partial<Pick<TaskRow, 'kind' | 'purpose' | 'work_order' | 'parent_task_id' | 'ac_refs'>>;

export type MilestoneRow = Omit<Selectable<MilestonesTable>, 'phase'> & { phase: MilestonePhase };
export type NewMilestone = Pick<MilestoneRow, 'project_id' | 'n' | 'title' | 'goal' | 'phase'>;

export type ArtifactVersionRow = Omit<Selectable<ArtifactVersionsTable>, 'type' | 'status' | 'derived_from' | 'stale_sections'> & {
  type: ArtifactType;
  status: ArtifactStatus;
  derived_from: string[];
  stale_sections: string[];
};
export type NewArtifactVersion = Omit<ArtifactVersionRow, 'stale_sections' | 'created_at'>;
export type ArtifactPatch = { status: ArtifactStatus; rationale?: string } & Partial<Pick<ArtifactVersionRow, 'sha' | 'derived_from' | 'stale_sections' | 'approved_by' | 'approved_at'>>;
export type ArtifactDepRow = Selectable<ArtifactDepsTable>;

export type CriterionRow = Omit<Selectable<AcceptanceCriteriaTable>, 'status' | 'verification'> & {
  status: CriterionStatus;
  verification: Criterion['verification'];
};

export type AttemptRow = Omit<Selectable<AttemptsTable>, 'state' | 'manifest' | 'output' | 'failure_evidence' | 'usage'> & {
  state: AttemptState;
  manifest: unknown;
  output: unknown;
  failure_evidence: unknown;
  usage: unknown;
};
export type NewAttempt = Pick<AttemptRow, 'task_id' | 'adapter' | 'model' | 'worktree_path' | 'branch'> & {
  base_sha?: string | null;
};
export type AttemptPatch = Partial<Omit<AttemptRow, 'id' | 'task_id' | 'k' | 'state'>>;

export type VendorPause = Selectable<VendorPausesTable>;

const LIVE_ATTEMPT_STATES: AttemptState[] = ['starting', 'running'];
// Interrupted and cancelled attempts say nothing about the work, so they don't use up retries.
const FAILED_ATTEMPT_STATES: AttemptState[] = ['failed', 'timeout', 'budget_exceeded', 'invalid_output'];
// Nor do these, each of which escalates at once for a person to fix something other than the work.
const FAILURES_NOT_ABOUT_THE_WORK = ['auth_required', 'context_over_budget', 'engine_error'];
// These attempts succeeded and were sent back afterwards, and they use up a retry all the same.
const REJECTIONS_AFTER_SUCCESS = ['changes_requested', 'merge_conflict'];
const ATTEMPT_JSON_FIELDS = ['manifest', 'output', 'failure_evidence', 'usage'] as const;

function parseJson(value: string | null): unknown {
  return value === null ? null : JSON.parse(value);
}

function toProjectRow(row: Selectable<ProjectsTable>): ProjectRow {
  return { ...row, phase: row.phase as ProjectPhase };
}

function toTaskRow(row: Selectable<TasksTable>): TaskRow {
  return {
    ...row,
    state: row.state as TaskState,
    touches: JSON.parse(row.touches) as string[],
    depends_on: JSON.parse(row.depends_on) as string[],
    dod: JSON.parse(row.dod) as string[],
    work_order: parseJson(row.work_order) as WorkOrder | null,
    ac_refs: JSON.parse(row.ac_refs) as string[],
  };
}

function toMilestoneRow(row: Selectable<MilestonesTable>): MilestoneRow {
  return { ...row, phase: row.phase as MilestonePhase };
}

function toArtifactRow(row: Selectable<ArtifactVersionsTable>): ArtifactVersionRow {
  return {
    ...row,
    type: row.type as ArtifactType,
    status: row.status as ArtifactStatus,
    derived_from: JSON.parse(row.derived_from) as string[],
    stale_sections: JSON.parse(row.stale_sections) as string[],
  };
}

function toCriterionRow(row: Selectable<AcceptanceCriteriaTable>): CriterionRow {
  return { ...row, status: row.status as CriterionStatus, verification: JSON.parse(row.verification) as Criterion['verification'] };
}

function toInboxRow(row: Selectable<InboxItemsTable>): InboxRow {
  return {
    ...row,
    type: row.type as InboxType,
    state: row.state as InboxState,
    ref: JSON.parse(row.ref) as InboxRef,
    blocks: JSON.parse(row.blocks) as string[],
    evidence: JSON.parse(row.evidence) as InboxEvidence[],
    options: JSON.parse(row.options) as InboxOption[],
    answer: row.answer === null ? null : (JSON.parse(row.answer) as InboxAnswer),
  };
}

function toAttemptRow(row: Selectable<AttemptsTable>): AttemptRow {
  return {
    ...row,
    state: row.state as AttemptState,
    manifest: parseJson(row.manifest),
    output: parseJson(row.output),
    failure_evidence: parseJson(row.failure_evidence),
    usage: parseJson(row.usage),
  };
}

function attemptColumns(patch: AttemptPatch): Updateable<AttemptsTable> {
  const { manifest: _m, output: _o, failure_evidence: _f, usage: _u, ...plain } = patch;
  const columns: Updateable<AttemptsTable> = plain;
  for (const field of ATTEMPT_JSON_FIELDS) {
    if (patch[field] !== undefined) columns[field] = JSON.stringify(patch[field]);
  }
  return columns;
}

async function nextK(db: Kysely<DB>, taskId: number): Promise<number> {
  const { last } = await db
    .selectFrom('attempts')
    .select((eb) => eb.fn.max('k').as('last'))
    .where('task_id', '=', taskId)
    .executeTakeFirstOrThrow();
  return (last ?? 0) + 1;
}

// The only writer of engine state: every state change commits together with its event.
export class Store {
  constructor(
    private readonly db: Kysely<DB>,
    private readonly log: EventLog,
    // Set on the Store that atomically hands out: events wait here until the transaction commits.
    private readonly deferred?: EventRow[],
  ) {}

  // Everything fn does through s commits as one, and its events publish only after that.
  // Inside fn use only s: SQLite has one connection, so a call on the root store waits for this
  // transaction to end, and it never does.
  async atomically<T>(fn: (s: Store) => Promise<T>): Promise<T> {
    if (this.deferred) return fn(this);

    const events: EventRow[] = [];
    const result = await this.db.transaction().execute((trx) => fn(new Store(trx, this.log, events)));
    for (const event of events) this.log.publish(event);
    return result;
  }

  // Kysely can't nest transactions, so a Store already inside one reuses it.
  private async inTrx<T>(fn: (db: Kysely<DB>, emit: (event: EventRow) => void) => Promise<T>): Promise<T> {
    if (this.deferred) {
      const events = this.deferred;
      return fn(this.db, (event) => events.push(event));
    }

    const events: EventRow[] = [];
    const result = await this.db.transaction().execute((trx) => fn(trx, (event) => events.push(event)));
    for (const event of events) this.log.publish(event);
    return result;
  }

  async createProject(p: NewProject): Promise<ProjectRow> {
    const row = await this.db
      .insertInto('projects')
      .values({ ...p, created_at: new Date().toISOString() })
      .returningAll()
      .executeTakeFirstOrThrow();
    return toProjectRow(row);
  }

  async getProject(name: string): Promise<ProjectRow | undefined> {
    const row = await this.db.selectFrom('projects').selectAll().where('name', '=', name).executeTakeFirst();
    return row && toProjectRow(row);
  }

  async getProjectById(id: number): Promise<ProjectRow | undefined> {
    const row = await this.db.selectFrom('projects').selectAll().where('id', '=', id).executeTakeFirst();
    return row && toProjectRow(row);
  }

  async listProjects(): Promise<ProjectRow[]> {
    return (await this.db.selectFrom('projects').selectAll().orderBy('id').execute()).map(toProjectRow);
  }

  async setProjectPhase(id: number, to: ProjectPhase): Promise<ProjectRow> {
    return this.inTrx(async (db, emit) => {
      const current = await db.selectFrom('projects').selectAll().where('id', '=', id).executeTakeFirst();
      if (!current) throw new Error(`No project ${id}`);
      assertProjectTransition(current.phase, to);

      const row = await db.updateTable('projects').set({ phase: to }).where('id', '=', id).returningAll().executeTakeFirstOrThrow();
      emit(await this.log.insert(db, { projectId: id, type: 'project.phase', payload: { from: current.phase, to } }));
      return toProjectRow(row);
    });
  }

  async createMilestone(m: NewMilestone): Promise<MilestoneRow> {
    const now = new Date().toISOString();
    const row = await this.db
      .insertInto('milestones')
      .values({ ...m, created_at: now, updated_at: now })
      .returningAll()
      .executeTakeFirstOrThrow();
    return toMilestoneRow(row);
  }

  async getMilestone(projectId: number, n: number): Promise<MilestoneRow | undefined> {
    const row = await this.db.selectFrom('milestones').selectAll().where('project_id', '=', projectId).where('n', '=', n).executeTakeFirst();
    return row && toMilestoneRow(row);
  }

  async latestArtifact(projectId: number, artifactId: string): Promise<ArtifactVersionRow | undefined> {
    const row = await this.db
      .selectFrom('artifact_versions')
      .selectAll()
      .where('project_id', '=', projectId)
      .where('artifact_id', '=', artifactId)
      .orderBy('version', 'desc')
      .limit(1)
      .executeTakeFirst();
    return row && toArtifactRow(row);
  }

  async artifactVersion(projectId: number, artifactId: string, version: number): Promise<ArtifactVersionRow | undefined> {
    const row = await this.db
      .selectFrom('artifact_versions')
      .selectAll()
      .where('project_id', '=', projectId)
      .where('artifact_id', '=', artifactId)
      .where('version', '=', version)
      .executeTakeFirst();
    return row && toArtifactRow(row);
  }

  async listLatestArtifacts(projectId: number): Promise<ArtifactVersionRow[]> {
    const rows = await this.db
      .selectFrom('artifact_versions')
      .selectAll()
      .where('project_id', '=', projectId)
      .where(
        sql<boolean>`version = (SELECT MAX(v.version) FROM artifact_versions v WHERE v.project_id = artifact_versions.project_id AND v.artifact_id = artifact_versions.artifact_id)`,
      )
      .orderBy('artifact_id')
      .execute();
    return rows.map(toArtifactRow);
  }

  async listArtifactDeps(projectId: number): Promise<ArtifactDepRow[]> {
    return this.db.selectFrom('artifact_deps').selectAll().where('project_id', '=', projectId).orderBy(sql`rowid`).execute();
  }

  // The earlier versions stop being current in the same step that makes this one current.
  async insertArtifactVersion(row: NewArtifactVersion): Promise<ArtifactVersionRow> {
    return this.inTrx(async (db, emit) => {
      await db
        .updateTable('artifact_versions')
        .set({ status: 'superseded' })
        .where('project_id', '=', row.project_id)
        .where('artifact_id', '=', row.artifact_id)
        .where('version', '<', row.version)
        .execute();
      const inserted = await db
        .insertInto('artifact_versions')
        .values({ ...row, derived_from: JSON.stringify(row.derived_from), created_at: new Date().toISOString() })
        .returningAll()
        .executeTakeFirstOrThrow();
      emit(await this.log.insert(db, { projectId: row.project_id, type: 'artifact.published', payload: { id: row.artifact_id, version: row.version, status: row.status } }));
      return toArtifactRow(inserted);
    });
  }

  async setArtifactStatus(projectId: number, artifactId: string, version: number, patch: ArtifactPatch): Promise<ArtifactVersionRow> {
    const { derived_from, stale_sections, rationale, ...rest } = patch;
    const why = rationale ? { rationale } : {};
    return this.inTrx(async (db, emit) => {
      const updated = await db
        .updateTable('artifact_versions')
        .set({
          ...rest,
          ...(derived_from ? { derived_from: JSON.stringify(derived_from) } : {}),
          ...(stale_sections ? { stale_sections: JSON.stringify(stale_sections) } : {}),
        })
        .where('project_id', '=', projectId)
        .where('artifact_id', '=', artifactId)
        .where('version', '=', version)
        .returningAll()
        .executeTakeFirst();
      if (!updated) throw new Error(`No version ${version} of artifact ${artifactId} in project ${projectId}`);
      emit(await this.log.insert(db, { projectId, type: 'artifact.status', payload: { id: artifactId, status: patch.status, ...why } }));
      if (derived_from) emit(await this.log.insert(db, { projectId, type: 'lineage.repinned', payload: { id: artifactId, ...why } }));
      return toArtifactRow(updated);
    });
  }

  async insertArtifactDeps(deps: ArtifactDepRow[]): Promise<void> {
    if (deps.length > 0) await this.db.insertInto('artifact_deps').values(deps).execute();
  }

  async deleteArtifactDeps(projectId: number, fromId: string, fromVersion: number): Promise<void> {
    await this.db.deleteFrom('artifact_deps').where('project_id', '=', projectId).where('from_id', '=', fromId).where('from_version', '=', fromVersion).execute();
  }

  async lockCriteria(projectId: number, milestone: number, specVersion: number, criteria: Criterion[]): Promise<void> {
    if (criteria.length === 0) throw new Error(`Milestone ${milestone} has no acceptance criteria to lock`);
    const bad = criteria.find((c, i) => !AC_ID.test(c.id) || c.text.trim() === '' || criteria.findIndex((other) => other.id === c.id) !== i);
    if (bad) throw new Error(`Acceptance criterion ${bad.id} needs a unique AC-n id and some text`);

    return this.inTrx(async (db, emit) => {
      const existing = await db.selectFrom('acceptance_criteria').select('ac_id').where('project_id', '=', projectId).where('milestone', '=', milestone).executeTakeFirst();
      if (existing) throw new Error(`The acceptance criteria of milestone ${milestone} are already locked`);

      const now = new Date().toISOString();
      for (const c of criteria) {
        await db
          .insertInto('acceptance_criteria')
          .values({ project_id: projectId, milestone, ac_id: c.id, text: c.text, verification: JSON.stringify(c.verification), spec_version: specVersion, updated_at: now })
          .execute();
        emit(await this.log.insert(db, { projectId, type: 'ac.status', payload: { acId: c.id, status: 'unverified' } }));
      }
    });
  }

  async listCriteria(projectId: number, milestone?: number): Promise<CriterionRow[]> {
    let query = this.db.selectFrom('acceptance_criteria').selectAll().where('project_id', '=', projectId);
    if (milestone !== undefined) query = query.where('milestone', '=', milestone);
    const rows = await query.orderBy('milestone').orderBy(sql`CAST(SUBSTR(ac_id, 4) AS INTEGER)`).execute();
    return rows.map(toCriterionRow);
  }

  // Only QA moves a criterion, and only by pointing at its evidence (§7.5).
  async recordVerification(projectId: number, milestone: number, acId: string, verification: Verification): Promise<void> {
    if (verification.evidenceRef.trim() === '') throw new Error(`A verification of ${acId} needs an evidence reference`);

    return this.inTrx(async (db, emit) => {
      const task = await db.selectFrom('tasks').select(['kind', 'project_id']).where('id', '=', verification.verifiedBy.taskId).executeTakeFirst();
      if (task?.kind !== 'qa_verify' || task.project_id !== projectId) throw new Error(`Only a QA verification task of this project can verify ${acId}`);

      const updated = await db
        .updateTable('acceptance_criteria')
        .set({ status: verification.status, evidence_ref: verification.evidenceRef, updated_at: new Date().toISOString() })
        .where('project_id', '=', projectId)
        .where('milestone', '=', milestone)
        .where('ac_id', '=', acId)
        .executeTakeFirst();
      if (updated.numUpdatedRows === 0n) throw new Error(`Milestone ${milestone} has no acceptance criterion ${acId}`);
      emit(await this.log.insert(db, { projectId, type: 'ac.status', payload: { acId, status: verification.status } }));
    });
  }

  // New text is a new promise, so what QA proved about the old text no longer counts.
  async reviseCriterion(projectId: number, milestone: number, acId: string, revision: { text: string; crId: string; specVersion: number }): Promise<void> {
    return this.inTrx(async (db, emit) => {
      const updated = await db
        .updateTable('acceptance_criteria')
        .set({ text: revision.text, cr_id: revision.crId, spec_version: revision.specVersion, status: 'unverified', evidence_ref: null, updated_at: new Date().toISOString() })
        .where('project_id', '=', projectId)
        .where('milestone', '=', milestone)
        .where('ac_id', '=', acId)
        .executeTakeFirst();
      if (updated.numUpdatedRows === 0n) throw new Error(`Milestone ${milestone} has no acceptance criterion ${acId}`);
      emit(await this.log.insert(db, { projectId, type: 'ac.status', payload: { acId, status: 'unverified' } }));
    });
  }

  async listMilestones(projectId: number): Promise<MilestoneRow[]> {
    return (await this.db.selectFrom('milestones').selectAll().where('project_id', '=', projectId).orderBy('n').execute()).map(toMilestoneRow);
  }

  async setMilestonePhase(projectId: number, n: number, to: MilestonePhase): Promise<MilestoneRow> {
    return this.inTrx(async (db, emit) => {
      const current = await db.selectFrom('milestones').selectAll().where('project_id', '=', projectId).where('n', '=', n).executeTakeFirst();
      if (!current) throw new Error(`No milestone ${n} in project ${projectId}`);
      assertMilestoneTransition(current.phase, to);

      const row = await db
        .updateTable('milestones')
        .set({ phase: to, updated_at: new Date().toISOString() })
        .where('project_id', '=', projectId)
        .where('n', '=', n)
        .returningAll()
        .executeTakeFirstOrThrow();
      emit(await this.log.insert(db, { projectId, type: 'milestone.phase', payload: { milestone: n, from: current.phase, to } }));
      return toMilestoneRow(row);
    });
  }

  async patchMilestone(projectId: number, n: number, patch: { verify_round?: number; verify_cap?: number }): Promise<MilestoneRow> {
    const row = await this.db
      .updateTable('milestones')
      .set({ ...patch, updated_at: new Date().toISOString() })
      .where('project_id', '=', projectId)
      .where('n', '=', n)
      .returningAll()
      .executeTakeFirst();
    if (!row) throw new Error(`No milestone ${n} in project ${projectId}`);
    return toMilestoneRow(row);
  }

  async createTask(t: NewTask): Promise<TaskRow> {
    const now = new Date().toISOString();
    const row = await this.db
      .insertInto('tasks')
      .values({
        ...t,
        touches: JSON.stringify(t.touches),
        depends_on: JSON.stringify(t.depends_on),
        dod: JSON.stringify(t.dod),
        work_order: t.work_order === undefined || t.work_order === null ? null : JSON.stringify(t.work_order),
        ac_refs: JSON.stringify(t.ac_refs ?? []),
        state: 'queued',
        created_at: now,
        updated_at: now,
      })
      .returningAll()
      .executeTakeFirstOrThrow();
    return toTaskRow(row);
  }

  async setDependencies(id: number, dependsOn: string[]): Promise<void> {
    await this.db.updateTable('tasks').set({ depends_on: JSON.stringify(dependsOn), updated_at: new Date().toISOString() }).where('id', '=', id).execute();
  }

  async getTask(id: number): Promise<TaskRow | undefined> {
    const row = await this.db.selectFrom('tasks').selectAll().where('id', '=', id).executeTakeFirst();
    return row && toTaskRow(row);
  }

  async getTaskByTicket(projectId: number, ticketId: string): Promise<TaskRow | undefined> {
    const row = await this.db
      .selectFrom('tasks')
      .selectAll()
      .where('project_id', '=', projectId)
      .where('ticket_id', '=', ticketId)
      .executeTakeFirst();
    return row && toTaskRow(row);
  }

  async listTasks(projectId?: number): Promise<TaskRow[]> {
    let query = this.db.selectFrom('tasks').selectAll().orderBy('id');
    if (projectId !== undefined) query = query.where('project_id', '=', projectId);
    return (await query.execute()).map(toTaskRow);
  }

  async setTaskState(id: number, to: TaskState, detail: { blockedOn?: string; reason?: string } = {}): Promise<TaskRow> {
    return this.inTrx(async (db, emit) => {
      const current = await db.selectFrom('tasks').selectAll().where('id', '=', id).executeTakeFirst();
      if (!current) throw new Error(`No task ${id}`);
      assertTaskTransition(current.state, to);

      const row = await db
        .updateTable('tasks')
        .set({
          state: to,
          blocked_on: to === 'blocked' ? (detail.blockedOn ?? null) : null,
          escalation_reason: to === 'escalated' ? (detail.reason ?? null) : null,
          updated_at: new Date().toISOString(),
        })
        .where('id', '=', id)
        .returningAll()
        .executeTakeFirstOrThrow();
      emit(
        await this.log.insert(db, {
          projectId: current.project_id,
          taskId: id,
          type: 'task.state',
          payload: { from: current.state, to, ...detail },
        }),
      );
      return toTaskRow(row);
    });
  }

  // The worktree path and branch name k, so the runner needs it before it can create the attempt.
  async nextAttemptK(taskId: number): Promise<number> {
    return nextK(this.db, taskId);
  }

  async createAttempt(a: NewAttempt): Promise<AttemptRow> {
    return this.inTrx(async (db) => {
      const k = await nextK(db, a.task_id);
      const row = await db
        .insertInto('attempts')
        .values({ ...a, k, state: 'starting', started_at: new Date().toISOString() })
        .returningAll()
        .executeTakeFirstOrThrow();
      return toAttemptRow(row);
    });
  }

  async setAttemptState(id: number, to: AttemptState, patch: AttemptPatch = {}): Promise<AttemptRow> {
    return this.inTrx(async (db, emit) => {
      const current = await db
        .selectFrom('attempts')
        .innerJoin('tasks', 'tasks.id', 'attempts.task_id')
        .select(['attempts.state', 'attempts.task_id', 'tasks.project_id'])
        .where('attempts.id', '=', id)
        .executeTakeFirst();
      if (!current) throw new Error(`No attempt ${id}`);
      assertAttemptTransition(current.state, to);

      const ended = ATTEMPT_TRANSITIONS[to].length === 0;
      const row = await db
        .updateTable('attempts')
        .set({ ...attemptColumns(patch), state: to, ...(ended ? { ended_at: new Date().toISOString() } : {}) })
        .where('id', '=', id)
        .returningAll()
        .executeTakeFirstOrThrow();
      emit(
        await this.log.insert(db, {
          projectId: current.project_id,
          taskId: current.task_id,
          attemptId: id,
          type: 'attempt.state',
          payload: { from: current.state, to, ...(patch.failure_kind ? { failureKind: patch.failure_kind } : {}) },
        }),
      );
      return toAttemptRow(row);
    });
  }

  async patchAttempt(id: number, patch: AttemptPatch): Promise<AttemptRow> {
    const row = await this.db
      .updateTable('attempts')
      .set(attemptColumns(patch))
      .where('id', '=', id)
      .returningAll()
      .executeTakeFirst();
    if (!row) throw new Error(`No attempt ${id}`);
    return toAttemptRow(row);
  }

  async getAttempt(id: number): Promise<AttemptRow | undefined> {
    const row = await this.db.selectFrom('attempts').selectAll().where('id', '=', id).executeTakeFirst();
    return row && toAttemptRow(row);
  }

  async attemptTotals(): Promise<Map<number, { attempts: number; usdEst: number | null; seconds: number | null }>> {
    const rows = await this.db
      .selectFrom('attempts')
      .select((eb) => [
        'task_id',
        eb.fn.countAll<number>().as('attempts'),
        sql<number | null>`sum(json_extract(usage, '$.usdEst'))`.as('usdEst'),
        sql<number | null>`sum((julianday(ended_at) - julianday(started_at)) * 86400)`.as('seconds'),
      ])
      .groupBy('task_id')
      .execute();
    return new Map(rows.map(({ task_id, attempts, usdEst, seconds }) => [task_id, { attempts, usdEst, seconds }]));
  }

  // A repeated key returns the row it already raised, even a closed one: a condition raises one item, once.
  raiseInbox(item: NewInboxItem): Promise<InboxRow> {
    return this.inTrx(async (db, emit) => {
      const raised = await db
        .insertInto('inbox_items')
        .values({
          ...item,
          milestone: item.milestone ?? null,
          ref: JSON.stringify(item.ref),
          blocks: JSON.stringify(item.blocks),
          evidence: JSON.stringify(item.evidence),
          options: JSON.stringify(item.options),
          created_at: new Date().toISOString(),
        })
        .onConflict((conflict) => conflict.columns(['project_id', 'dedupe_key']).doNothing())
        .returningAll()
        .executeTakeFirst();
      if (raised) {
        emit(await this.log.insert(db, { projectId: item.project_id, type: 'inbox.raised', payload: { title: item.title } }));
        return toInboxRow(raised);
      }
      const existing = await db.selectFrom('inbox_items').selectAll().where('project_id', '=', item.project_id).where('dedupe_key', '=', item.dedupe_key).executeTakeFirstOrThrow();
      return toInboxRow(existing);
    });
  }

  // Only records: the conductor applies it on its next tick. The state check in the UPDATE is what makes the first answer win.
  answerInbox(id: number, answer: InboxAnswer): Promise<InboxRow> {
    return this.inTrx(async (db, emit) => {
      const current = await db.selectFrom('inbox_items').selectAll().where('id', '=', id).executeTakeFirst();
      if (!current) throw new AlreadyAnswered(id);
      assertValidAnswer(toInboxRow(current), answer);
      const row = await db
        .updateTable('inbox_items')
        .set({ state: 'answered', answer: JSON.stringify(answer), answered_at: new Date().toISOString() })
        .where('id', '=', id)
        .where('state', '=', 'pending')
        .returningAll()
        .executeTakeFirst();
      if (!row) throw new AlreadyAnswered(id);
      emit(await this.log.insert(db, { projectId: row.project_id, type: 'inbox.answered', payload: { title: row.title } }));
      return toInboxRow(row);
    });
  }

  withdrawInbox(id: number, reason: string): Promise<void> {
    return this.inTrx(async (db, emit) => {
      const row = await db.updateTable('inbox_items').set({ state: 'withdrawn' }).where('id', '=', id).where('state', '=', 'pending').returningAll().executeTakeFirst();
      if (row) emit(await this.log.insert(db, { projectId: row.project_id, type: 'inbox.withdrawn', payload: { reason } }));
    });
  }

  markInboxApplied(id: number): Promise<void> {
    return this.inTrx(async (db, emit) => {
      const row = await db.updateTable('inbox_items').set({ applied_at: new Date().toISOString() }).where('id', '=', id).where('state', '=', 'answered').where('applied_at', 'is', null).returningAll().executeTakeFirst();
      if (row) emit(await this.log.insert(db, { projectId: row.project_id, type: 'inbox.applied', payload: { title: row.title } }));
    });
  }

  async getInbox(id: number): Promise<InboxRow | undefined> {
    const row = await this.db.selectFrom('inbox_items').selectAll().where('id', '=', id).executeTakeFirst();
    return row && toInboxRow(row);
  }

  async listInbox({ projectId, state }: { projectId?: number; state?: InboxState }): Promise<InboxRow[]> {
    let query = this.db.selectFrom('inbox_items').selectAll();
    if (projectId !== undefined) query = query.where('project_id', '=', projectId);
    if (state !== undefined) query = query.where('state', '=', state);
    return (await query.orderBy('id').execute()).map(toInboxRow);
  }

  async inboxByPrefix(projectId: number, prefix: string): Promise<InboxRow[]> {
    const rows = await this.db
      .selectFrom('inbox_items')
      .selectAll()
      .where('project_id', '=', projectId)
      .where(sql<string>`substr(dedupe_key, 1, ${prefix.length})`, '=', prefix)
      .orderBy('id')
      .execute();
    return rows.map(toInboxRow);
  }

  async pendingInboxCount(): Promise<number> {
    const { count } = await this.db
      .selectFrom('inbox_items')
      .select((eb) => eb.fn.countAll<number>().as('count'))
      .where('state', '=', 'pending')
      .executeTakeFirstOrThrow();
    return count;
  }

  async listUnappliedAnswers(): Promise<InboxRow[]> {
    const rows = await this.db.selectFrom('inbox_items').selectAll().where('state', '=', 'answered').where('applied_at', 'is', null).orderBy('id').execute();
    return rows.map(toInboxRow);
  }

  // For an event that nothing else in the transaction would log.
  logEvent(projectId: number, type: EventType, payload: Record<string, unknown>): Promise<void> {
    return this.inTrx(async (db, emit) => {
      emit(await this.log.insert(db, { projectId, type, payload }));
    });
  }

  async listAttempts(taskId: number): Promise<AttemptRow[]> {
    const rows = await this.db.selectFrom('attempts').selectAll().where('task_id', '=', taskId).orderBy('k').execute();
    return rows.map(toAttemptRow);
  }

  async listLiveAttempts(): Promise<AttemptRow[]> {
    const rows = await this.db.selectFrom('attempts').selectAll().where('state', 'in', LIVE_ATTEMPT_STATES).orderBy('id').execute();
    return rows.map(toAttemptRow);
  }

  async failedAttemptCount(taskId: number): Promise<number> {
    const { n } = await this.db
      .selectFrom('attempts')
      .select((eb) => eb.fn.countAll<number>().as('n'))
      .where('task_id', '=', taskId)
      .where((eb) =>
        eb.or([
          eb.and([eb('state', 'in', FAILED_ATTEMPT_STATES), eb.or([eb('failure_kind', 'is', null), eb('failure_kind', 'not in', FAILURES_NOT_ABOUT_THE_WORK)])]),
          eb('failure_kind', 'in', REJECTIONS_AFTER_SUCCESS),
        ]),
      )
      .executeTakeFirstOrThrow();
    return n;
  }

  async getVendorPause(vendor: string): Promise<VendorPause | undefined> {
    return this.db.selectFrom('vendor_pauses').selectAll().where('vendor', '=', vendor).executeTakeFirst();
  }

  async setVendorPause(p: VendorPause): Promise<void> {
    await this.db
      .insertInto('vendor_pauses')
      .values(p)
      .onConflict((oc) => oc.column('vendor').doUpdateSet({ until: p.until, backoff_s: p.backoff_s, reason: p.reason }))
      .execute();
  }

  async clearVendorPause(vendor: string): Promise<void> {
    await this.db.deleteFrom('vendor_pauses').where('vendor', '=', vendor).execute();
  }
}
