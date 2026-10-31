import { sql, type Kysely, type Selectable, type Updateable } from 'kysely';
import type { AttemptsTable, DB, ProjectsTable, TasksTable, VendorPausesTable } from '../db/schema.ts';
import type { EventLog } from '../events.ts';
import {
  assertAttemptTransition,
  assertTaskTransition,
  ATTEMPT_TRANSITIONS,
  type AttemptState,
  type TaskState,
} from './fsm.ts';

export type ProjectRow = Selectable<ProjectsTable>;
export type NewProject = Pick<ProjectRow, 'name' | 'repo_path' | 'base_branch'>;

export type TaskRow = Omit<Selectable<TasksTable>, 'state' | 'touches' | 'depends_on' | 'dod'> & {
  state: TaskState;
  touches: string[];
  depends_on: string[];
  dod: string[];
};
export type NewTask = Pick<
  TaskRow,
  'project_id' | 'ticket_id' | 'title' | 'milestone' | 'role_id' | 'ticket_path' | 'ticket_sha' | 'touches' | 'depends_on' | 'dod'
>;

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
const ATTEMPT_JSON_FIELDS = ['manifest', 'output', 'failure_evidence', 'usage'] as const;

function parseJson(value: string | null): unknown {
  return value === null ? null : JSON.parse(value);
}

function toTaskRow(row: Selectable<TasksTable>): TaskRow {
  return {
    ...row,
    state: row.state as TaskState,
    touches: JSON.parse(row.touches) as string[],
    depends_on: JSON.parse(row.depends_on) as string[],
    dod: JSON.parse(row.dod) as string[],
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
  ) {}

  async createProject(p: NewProject): Promise<ProjectRow> {
    return this.db
      .insertInto('projects')
      .values({ ...p, created_at: new Date().toISOString() })
      .returningAll()
      .executeTakeFirstOrThrow();
  }

  async getProject(name: string): Promise<ProjectRow | undefined> {
    return this.db.selectFrom('projects').selectAll().where('name', '=', name).executeTakeFirst();
  }

  async getProjectById(id: number): Promise<ProjectRow | undefined> {
    return this.db.selectFrom('projects').selectAll().where('id', '=', id).executeTakeFirst();
  }

  async listProjects(): Promise<ProjectRow[]> {
    return this.db.selectFrom('projects').selectAll().orderBy('id').execute();
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
        state: 'queued',
        created_at: now,
        updated_at: now,
      })
      .returningAll()
      .executeTakeFirstOrThrow();
    return toTaskRow(row);
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
    const { row, event } = await this.db.transaction().execute(async (trx) => {
      const current = await trx.selectFrom('tasks').selectAll().where('id', '=', id).executeTakeFirst();
      if (!current) throw new Error(`No task ${id}`);
      assertTaskTransition(current.state, to);

      const row = await trx
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
      const event = await this.log.insert(trx, {
        projectId: current.project_id,
        taskId: id,
        type: 'task.state',
        payload: { from: current.state, to, ...detail },
      });
      return { row, event };
    });

    this.log.publish(event);
    return toTaskRow(row);
  }

  // The worktree path and branch name k, so the runner needs it before it can create the attempt.
  async nextAttemptK(taskId: number): Promise<number> {
    return nextK(this.db, taskId);
  }

  async createAttempt(a: NewAttempt): Promise<AttemptRow> {
    const row = await this.db.transaction().execute(async (trx) => {
      const k = await nextK(trx, a.task_id);
      return trx
        .insertInto('attempts')
        .values({ ...a, k, state: 'starting', started_at: new Date().toISOString() })
        .returningAll()
        .executeTakeFirstOrThrow();
    });
    return toAttemptRow(row);
  }

  async setAttemptState(id: number, to: AttemptState, patch: AttemptPatch = {}): Promise<AttemptRow> {
    const { row, event } = await this.db.transaction().execute(async (trx) => {
      const current = await trx
        .selectFrom('attempts')
        .innerJoin('tasks', 'tasks.id', 'attempts.task_id')
        .select(['attempts.state', 'attempts.task_id', 'tasks.project_id'])
        .where('attempts.id', '=', id)
        .executeTakeFirst();
      if (!current) throw new Error(`No attempt ${id}`);
      assertAttemptTransition(current.state, to);

      const ended = ATTEMPT_TRANSITIONS[to].length === 0;
      const row = await trx
        .updateTable('attempts')
        .set({ ...attemptColumns(patch), state: to, ...(ended ? { ended_at: new Date().toISOString() } : {}) })
        .where('id', '=', id)
        .returningAll()
        .executeTakeFirstOrThrow();
      const event = await this.log.insert(trx, {
        projectId: current.project_id,
        taskId: current.task_id,
        attemptId: id,
        type: 'attempt.state',
        payload: { from: current.state, to, ...(patch.failure_kind ? { failureKind: patch.failure_kind } : {}) },
      });
      return { row, event };
    });

    this.log.publish(event);
    return toAttemptRow(row);
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

  async attemptTotals(): Promise<Map<number, { attempts: number; usdEst: number | null }>> {
    const rows = await this.db
      .selectFrom('attempts')
      .select((eb) => ['task_id', eb.fn.countAll<number>().as('attempts'), sql<number | null>`sum(json_extract(usage, '$.usdEst'))`.as('usdEst')])
      .groupBy('task_id')
      .execute();
    return new Map(rows.map(({ task_id, attempts, usdEst }) => [task_id, { attempts, usdEst }]));
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
      .where('state', 'in', FAILED_ATTEMPT_STATES)
      .where((eb) => eb.or([eb('failure_kind', 'is', null), eb('failure_kind', 'not in', FAILURES_NOT_ABOUT_THE_WORK)]))
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
