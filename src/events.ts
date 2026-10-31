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
  | 'recovery.interrupted';

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
    const inserted = await this.db
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

    const row = toEventRow(inserted);
    for (const fn of [...this.subscribers]) {
      try {
        fn(row);
      } catch (err) {
        console.error(`Event subscriber failed on ${row.type}:`, err);
      }
    }
    return row;
  }

  async list(q: { taskId?: number; afterSeq?: number; limit?: number }): Promise<EventRow[]> {
    let query = this.db.selectFrom('events').selectAll().orderBy('seq');
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
