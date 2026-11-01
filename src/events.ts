import type { Kysely, Selectable } from 'kysely';
import type { DB, EventsTable } from './db/schema.ts';

export type EventType =
  | 'task.state'
  | 'attempt.state'
  | 'manifest.built'
  | 'worker.init'
  | 'worker.message'
  | 'worker.tool_call'
  | 'worker.tool_result'
  | 'worker.usage'
  | 'worker.error'
  | 'check.started'
  | 'check.finished'
  | 'vendor.paused'
  | 'recovery.interrupted'
  | 'project.phase'
  | 'milestone.phase'
  | 'artifact.published'
  | 'artifact.status'
  | 'lineage.repinned'
  | 'ac.status'
  | 'inbox.raised'
  | 'inbox.answered'
  | 'inbox.applied'
  | 'inbox.withdrawn'
  | 'merge.done'
  | 'merge.conflict'
  | 'change_request.dropped'
  | 'conductor.error';

export type EventRow = {
  seq: number;
  ts: string;
  projectId: number | null;
  taskId: number | null;
  attemptId: number | null;
  type: EventType;
  payload: Record<string, unknown>;
};

export type NewEvent = {
  projectId?: number | null;
  taskId?: number | null;
  attemptId?: number | null;
  type: EventType;
  payload: Record<string, unknown>;
};

function toEventRow(row: Selectable<EventsTable>): EventRow {
  return {
    seq: row.seq,
    ts: row.ts,
    projectId: row.project_id,
    taskId: row.task_id,
    attemptId: row.attempt_id,
    type: row.type as EventType,
    payload: JSON.parse(row.payload) as Record<string, unknown>,
  };
}

export class EventLog {
  private readonly subscribers = new Set<(e: EventRow) => void>();

  constructor(private readonly db: Kysely<DB>) {}

  async append(e: NewEvent): Promise<EventRow> {
    const row = await this.insert(this.db, e);
    this.publish(row);
    return row;
  }

  // For an event that commits with other writes: pass the transaction, then publish after commit.
  async insert(db: Kysely<DB>, e: NewEvent): Promise<EventRow> {
    const inserted = await db
      .insertInto('events')
      .values({
        ts: new Date().toISOString(),
        project_id: e.projectId ?? null,
        task_id: e.taskId ?? null,
        attempt_id: e.attemptId ?? null,
        type: e.type,
        payload: JSON.stringify(e.payload),
      })
      .returningAll()
      .executeTakeFirstOrThrow();
    return toEventRow(inserted);
  }

  publish(row: EventRow): void {
    for (const fn of [...this.subscribers]) {
      try {
        fn(row);
      } catch (err) {
        console.error(`Event subscriber failed on ${row.type}:`, err);
      }
    }
  }

  async list(q: { taskId?: number; projectId?: number; afterSeq?: number; limit?: number; workerLines?: false }): Promise<EventRow[]> {
    let query = this.db.selectFrom('events').selectAll().orderBy('seq');
    if (q.workerLines === false) query = query.where('type', 'not like', 'worker.%');
    if (q.projectId !== undefined) query = query.where('project_id', '=', q.projectId);
    if (q.taskId !== undefined) query = query.where('task_id', '=', q.taskId);
    if (q.afterSeq !== undefined) query = query.where('seq', '>', q.afterSeq);
    if (q.limit !== undefined) query = query.limit(q.limit);
    return (await query.execute()).map(toEventRow);
  }

  subscribe(fn: (e: EventRow) => void): () => void {
    this.subscribers.add(fn);
    return () => this.subscribers.delete(fn);
  }

  subscriberCount(): number {
    return this.subscribers.size;
  }
}
