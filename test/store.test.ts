import { sql, type Kysely } from 'kysely';
import { openDb } from '../src/db/open.ts';
import type { DB } from '../src/db/schema.ts';
import { IllegalTransition } from '../src/engine/fsm.ts';
import { Store, type NewTask, type ProjectRow, type TaskRow } from '../src/engine/store.ts';
import { EventLog } from '../src/events.ts';

describe('Store', () => {
  let db: Kysely<DB>;
  let log: EventLog;
  let store: Store;
  let project: ProjectRow;
  let task: TaskRow;

  const ticket = (ticket_id: string): NewTask => ({
    project_id: project.id,
    ticket_id,
    title: `Ticket ${ticket_id}`,
    milestone: 1,
    role_id: 'engineer',
    ticket_path: `tickets/${ticket_id}.md`,
    ticket_sha: 'abc123',
    touches: ['src/**'],
    depends_on: [],
    dod: ['tests pass'],
  });
  const attempt = (task_id: number) => ({
    task_id,
    adapter: 'claude-code',
    model: 'claude-sonnet-5-5',
    worktree_path: '/w',
    branch: 'aiteam/T-1',
  });

  beforeEach(async () => {
    db = await openDb(':memory:');
    log = new EventLog(db);
    store = new Store(db, log);
    project = await store.createProject({ name: 'p', repo_path: '/r', base_branch: 'main' });
    task = await store.createTask(ticket('T-1'));
  });

  afterEach(async () => {
    await db.destroy();
  });

  describe('projects and tasks', () => {
    it('finds a project by name and lists them', async () => {
      expect(await store.getProject('p')).toEqual(project);
      expect(await store.getProject('other')).toBeUndefined();
      expect(await store.listProjects()).toEqual([project]);
    });

    it('starts a task queued, with its JSON fields as values', async () => {
      expect(task).toMatchObject({ state: 'queued', touches: ['src/**'], depends_on: [], dod: ['tests pass'], blocked_on: null });
      expect(await store.getTask(task.id)).toEqual(task);
      expect(await store.getTaskByTicket(project.id, 'T-1')).toEqual(task);
      expect(await store.getTask(999)).toBeUndefined();
    });

    it('refuses a second task with the same ticket id in a project', async () => {
      await expect(store.createTask(ticket('T-1'))).rejects.toThrow(/UNIQUE/);
    });

    it('lists tasks across projects or for one', async () => {
      const other = await store.createProject({ name: 'q', repo_path: '/q', base_branch: 'main' });
      const t2 = await store.createTask({ ...ticket('T-2'), project_id: other.id });

      expect((await store.listTasks()).map((t) => t.id)).toEqual([task.id, t2.id]);
      expect((await store.listTasks(other.id)).map((t) => t.id)).toEqual([t2.id]);
    });
  });

  describe('task state', () => {
    it('writes state and event atomically', async () => {
      const updated = await store.setTaskState(task.id, 'ready');

      expect(updated.state).toBe('ready');
      expect((await store.getTask(task.id))?.state).toBe('ready');
      const events = await log.list({ taskId: task.id });
      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({ type: 'task.state', projectId: project.id, payload: { from: 'queued', to: 'ready' } });
    });

    it('rolls the state back when the event cannot be written', async () => {
      await sql`CREATE TRIGGER no_events BEFORE INSERT ON events BEGIN SELECT RAISE(ABORT, 'event write failed'); END`.execute(db);

      await expect(store.setTaskState(task.id, 'ready')).rejects.toThrow(/event write failed/);

      expect((await store.getTask(task.id))?.state).toBe('queued');
    });

    it('illegal transition changes nothing', async () => {
      await expect(store.setTaskState(task.id, 'done')).rejects.toThrow(IllegalTransition);

      expect((await store.getTask(task.id))?.state).toBe('queued');
      expect(await log.list({ taskId: task.id })).toEqual([]);
    });

    it('lets only one of two racing transitions through', async () => {
      await store.setTaskState(task.id, 'ready');

      const results = await Promise.allSettled([store.setTaskState(task.id, 'running'), store.setTaskState(task.id, 'running')]);

      expect(results.map((r) => r.status).sort()).toEqual(['fulfilled', 'rejected']);
      expect((await log.list({ taskId: task.id })).filter((e) => e.payload.to === 'running')).toHaveLength(1);
    });

    it('tells subscribers only after the change is committed', async () => {
      const seen: Array<Promise<string | undefined>> = [];
      log.subscribe(() => seen.push(store.getTask(task.id).then((t) => t?.state)));

      await store.setTaskState(task.id, 'ready');

      expect(seen).toHaveLength(1);
      expect(await seen[0]).toBe('ready');
    });

    it('records why a task is blocked and clears it on the way out', async () => {
      const blocked = await store.setTaskState(task.id, 'blocked', { blockedOn: 'path_lock' });
      expect(blocked.blocked_on).toBe('path_lock');

      expect((await store.setTaskState(task.id, 'ready')).blocked_on).toBeNull();
    });

    it('records why a task escalated and clears it on the way out', async () => {
      const escalated = await store.setTaskState(task.id, 'escalated', { reason: 'attempts_exhausted' });
      expect(escalated.escalation_reason).toBe('attempts_exhausted');
      expect((await log.list({ taskId: task.id }))[0]?.payload).toMatchObject({ reason: 'attempts_exhausted' });

      expect((await store.setTaskState(task.id, 'ready')).escalation_reason).toBeNull();
    });

    it('fails clearly for an unknown task', async () => {
      await expect(store.setTaskState(999, 'ready')).rejects.toThrow(/No task 999/);
    });
  });

  describe('attempts', () => {
    it('numbers attempts per task from 1', async () => {
      const other = await store.createTask(ticket('T-2'));

      const a1 = await store.createAttempt(attempt(task.id));
      const a2 = await store.createAttempt(attempt(task.id));
      const b1 = await store.createAttempt(attempt(other.id));

      expect([a1.k, a2.k, b1.k]).toEqual([1, 2, 1]);
      expect(a1.state).toBe('starting');
      expect((await store.listAttempts(task.id)).map((a) => a.k)).toEqual([1, 2]);
    });

    it('tells the next attempt number before the attempt exists', async () => {
      expect(await store.nextAttemptK(task.id)).toBe(1);
      await store.createAttempt(attempt(task.id));
      expect(await store.nextAttemptK(task.id)).toBe(2);
      const second = await store.createAttempt(attempt(task.id));
      expect(second.k).toBe(2);
    });

    it('moves state with an event and stores the patch', async () => {
      const a = await store.createAttempt(attempt(task.id));

      const running = await store.setAttemptState(a.id, 'running', { pid: 42, usage: { usdEst: 0.5 } });

      expect(running).toMatchObject({ state: 'running', pid: 42, usage: { usdEst: 0.5 }, ended_at: null });
      expect(await log.list({ taskId: task.id })).toMatchObject([
        { type: 'attempt.state', projectId: project.id, attemptId: a.id, payload: { from: 'starting', to: 'running' } },
      ]);
    });

    it('stamps ended_at when an attempt ends', async () => {
      const a = await store.createAttempt(attempt(task.id));

      const failed = await store.setAttemptState(a.id, 'failed', { failure_kind: 'spawn_error', failure_evidence: { why: 'ENOENT' } });

      expect(failed.ended_at).not.toBeNull();
      expect(failed).toMatchObject({ failure_kind: 'spawn_error', failure_evidence: { why: 'ENOENT' } });
    });

    it('illegal transition leaves the attempt and the patch alone', async () => {
      const a = await store.createAttempt(attempt(task.id));

      await expect(store.setAttemptState(a.id, 'succeeded', { pid: 42 })).rejects.toThrow(IllegalTransition);

      expect((await store.listAttempts(task.id))[0]).toMatchObject({ state: 'starting', pid: null });
    });

    it('patches fields without a state change or an event', async () => {
      const a = await store.createAttempt(attempt(task.id));

      const patched = await store.patchAttempt(a.id, { pid: 7, pid_started_at: 'Mon Jan  1 00:00:00 2024', manifest: { flags: ['-p'] } });

      expect(patched).toMatchObject({ state: 'starting', pid: 7, pid_started_at: 'Mon Jan  1 00:00:00 2024', manifest: { flags: ['-p'] } });
      expect(await log.list({ taskId: task.id })).toEqual([]);
    });

    it('lists only live attempts', async () => {
      const starting = await store.createAttempt(attempt(task.id));
      const running = await store.createAttempt(attempt(task.id));
      const ended = await store.createAttempt(attempt(task.id));
      await store.setAttemptState(running.id, 'running');
      await store.setAttemptState(ended.id, 'cancelled');

      expect((await store.listLiveAttempts()).map((a) => a.id)).toEqual([starting.id, running.id]);
    });

    it('counts only real failures', async () => {
      for (const to of ['failed', 'timeout', 'budget_exceeded', 'invalid_output', 'interrupted', 'cancelled', 'succeeded'] as const) {
        const a = await store.createAttempt(attempt(task.id));
        await store.setAttemptState(a.id, 'running');
        await store.setAttemptState(a.id, to);
      }

      expect(await store.failedAttemptCount(task.id)).toBe(4);
    });

    const failWith = async (kinds: string[]) => {
      for (const failure_kind of kinds) {
        const a = await store.createAttempt(attempt(task.id));
        await store.setAttemptState(a.id, 'running');
        await store.setAttemptState(a.id, 'failed', { failure_kind });
      }
    };

    it('does not count a failure that escalates at once for a person to fix', async () => {
      await failWith(['auth_required', 'context_over_budget', 'engine_error']);

      expect(await store.failedAttemptCount(task.id)).toBe(0);
    });

    it('counts a failure that goes round to another attempt, or the runner would never stop', async () => {
      const kinds = ['check_failed', 'scope_violation', 'no_changes', 'spawn_error', 'max_turns', 'no_result', 'no_structured_output', 'worker_error'];
      await failWith(kinds);

      expect(await store.failedAttemptCount(task.id)).toBe(kinds.length);
    });
  });

  describe('vendor pauses', () => {
    it('sets, replaces and clears a pause', async () => {
      expect(await store.getVendorPause('anthropic')).toBeUndefined();

      await store.setVendorPause({ vendor: 'anthropic', until: '2026-10-31T15:00:00.000Z', backoff_s: 300, reason: 'usage' });
      await store.setVendorPause({ vendor: 'anthropic', until: '2026-10-31T16:00:00.000Z', backoff_s: 600, reason: 'usage' });
      expect(await store.getVendorPause('anthropic')).toEqual({ vendor: 'anthropic', until: '2026-10-31T16:00:00.000Z', backoff_s: 600, reason: 'usage' });

      await store.clearVendorPause('anthropic');
      expect(await store.getVendorPause('anthropic')).toBeUndefined();
    });
  });
});
