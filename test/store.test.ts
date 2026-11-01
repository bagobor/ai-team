import { sql, type Kysely } from 'kysely';
import { openDb } from '../src/db/open.ts';
import type { DB } from '../src/db/schema.ts';
import { IllegalTransition } from '../src/engine/fsm.ts';
import { Store, type NewTask, type ProjectRow, type TaskRow } from '../src/engine/store.ts';
import { EventLog } from '../src/events.ts';
import type { WorkOrder } from '../src/engine/workorder.ts';

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

describe('Store for M2', () => {
  let db: Kysely<DB>;
  let log: EventLog;
  let store: Store;
  let project: ProjectRow;
  let task: TaskRow;
  let seen: string[];

  beforeEach(async () => {
    db = await openDb(':memory:');
    log = new EventLog(db);
    store = new Store(db, log);
    project = await store.createProject({ name: 'p', repo_path: '/r', base_branch: 'main' });
    task = await store.createTask({
      project_id: project.id,
      ticket_id: 'T-1',
      title: 'Ticket',
      milestone: 1,
      role_id: 'engineer',
      ticket_path: 'tickets/T-1.md',
      ticket_sha: 'abc',
      touches: [],
      depends_on: [],
      dod: [],
    });
    seen = [];
    log.subscribe((row) => seen.push(row.type));
  });

  afterEach(async () => {
    await db.destroy();
  });

  const insertCriterion = (status: string, evidence: string | null) =>
    db
      .insertInto('acceptance_criteria')
      .values({ project_id: project.id, milestone: 1, ac_id: 'AC-1', text: 'Text', verification: '{}', spec_version: 1, status, evidence_ref: evidence, updated_at: 'now' })
      .execute();

  describe('atomically', () => {
    it('commits every change together and publishes events only after commit', async () => {
      await store.atomically(async (s) => {
        await s.setTaskState(task.id, 'ready');
        expect(seen).toEqual([]);
      });

      expect(seen).toEqual(['task.state']);
      expect((await store.getTask(task.id))?.state).toBe('ready');
    });

    it('rolls back every change and publishes nothing when it throws', async () => {
      await expect(
        store.atomically(async (s) => {
          await s.setTaskState(task.id, 'ready');
          throw new Error('boom');
        }),
      ).rejects.toThrow('boom');

      expect((await store.getTask(task.id))?.state).toBe('queued');
      expect(seen).toEqual([]);
    });

    it('reuses its transaction for a state change and an attempt in one unit', async () => {
      await store.atomically(async (s) => {
        await s.setTaskState(task.id, 'ready');
        await s.setTaskState(task.id, 'running');
        const a = await s.createAttempt({ task_id: task.id, adapter: 'x', model: 'm', worktree_path: '/w', branch: 'b' });
        await s.setAttemptState(a.id, 'running');
        await s.setAttemptState(a.id, 'succeeded', { head_sha: 'deadbeef' });
      });

      expect(seen).toEqual(['task.state', 'task.state', 'attempt.state', 'attempt.state']);
      expect((await store.listAttempts(task.id))[0]).toMatchObject({ state: 'succeeded', head_sha: 'deadbeef' });
    });

    it('joins the outer transaction when nested', async () => {
      await expect(
        store.atomically(async (s) => {
          await s.atomically(async (inner) => inner.setTaskState(task.id, 'ready'));
          throw new Error('outer');
        }),
      ).rejects.toThrow('outer');

      expect((await store.getTask(task.id))?.state).toBe('queued');
    });
  });

  describe('attempt cap', () => {
    it.each(['changes_requested', 'merge_conflict'])('counts a succeeded attempt rejected for %s', async (kind) => {
      const a = await store.createAttempt({ task_id: task.id, adapter: 'x', model: 'm', worktree_path: '/w', branch: 'b' });
      await store.setAttemptState(a.id, 'running');
      await store.setAttemptState(a.id, 'succeeded');
      expect(await store.failedAttemptCount(task.id)).toBe(0);

      await store.patchAttempt(a.id, { failure_kind: kind, failure_evidence: 'why' });

      expect(await store.failedAttemptCount(task.id)).toBe(1);
    });
  });

  describe('tasks', () => {
    it('defaults to a ticket with no work order', () => {
      expect(task).toMatchObject({ kind: 'ticket', purpose: null, work_order: null, parent_task_id: null, ac_refs: [] });
    });

    it('stores kind, purpose, work order, parent and criterion refs as values', async () => {
      const order: WorkOrder = { purpose: 'tech_design', instructions: 'Do it', inputs: [], checks: [], base: { kind: 'base' } };
      const made = await store.createTask({
        project_id: project.id,
        ticket_id: 'M1-TECH',
        title: 'Design',
        milestone: 1,
        role_id: 'tech_lead',
        ticket_path: '',
        ticket_sha: '',
        touches: [],
        depends_on: [],
        dod: [],
        kind: 'authoring',
        purpose: 'tech_design',
        work_order: order,
        parent_task_id: task.id,
        ac_refs: ['AC-1'],
      });

      expect(await store.getTask(made.id)).toMatchObject({ kind: 'authoring', purpose: 'tech_design', work_order: order, parent_task_id: task.id, ac_refs: ['AC-1'] });
    });
  });

  describe('logEvent', () => {
    it('logs an event against the project', async () => {
      await store.logEvent(project.id, 'change_request.dropped', { reason: 'Too many' });

      expect(seen).toEqual(['change_request.dropped']);
      const [row] = await log.list({ projectId: project.id });
      expect(row!.payload).toEqual({ reason: 'Too many' });
    });

    it('goes with the transaction it is part of', async () => {
      const failed = store.atomically(async (s) => {
        await s.logEvent(project.id, 'change_request.dropped', { reason: 'Too many' });
        throw new Error('crash-marker');
      });

      await expect(failed).rejects.toThrow('crash-marker');
      expect(seen).toEqual([]);
      expect(await log.list({ projectId: project.id })).toEqual([]);
    });
  });

  describe('project and milestone phases', () => {
    it('starts a project in intake and moves it with an event', async () => {
      expect(project.phase).toBe('intake');

      const moved = await store.setProjectPhase(project.id, 'discovery');

      expect(moved.phase).toBe('discovery');
      expect(seen).toEqual(['project.phase']);
    });

    it('refuses an illegal project move and leaves it where it was', async () => {
      await expect(store.setProjectPhase(project.id, 'active')).rejects.toThrow(IllegalTransition);
      expect((await store.getProject('p'))?.phase).toBe('intake');
    });

    it('creates, lists and moves milestones', async () => {
      const m = await store.createMilestone({ project_id: project.id, n: 1, title: 'First', goal: 'Goal', phase: 'pending' });
      expect(m).toMatchObject({ n: 1, phase: 'pending', verify_round: 0, verify_cap: 3 });

      await store.setMilestonePhase(project.id, 1, 'spec');

      expect(seen).toEqual(['milestone.phase']);
      expect((await store.getMilestone(project.id, 1))?.phase).toBe('spec');
      expect((await store.listMilestones(project.id)).map((x) => x.n)).toEqual([1]);
    });

    it('refuses an illegal milestone move', async () => {
      await store.createMilestone({ project_id: project.id, n: 1, title: 'First', goal: 'Goal', phase: 'pending' });
      await expect(store.setMilestonePhase(project.id, 1, 'merged')).rejects.toThrow(IllegalTransition);
    });

    it('patches the verify round and cap', async () => {
      await store.createMilestone({ project_id: project.id, n: 1, title: 'First', goal: 'Goal', phase: 'pending' });
      await store.patchMilestone(project.id, 1, { verify_round: 2 });
      await store.patchMilestone(project.id, 1, { verify_cap: 5 });
      expect(await store.getMilestone(project.id, 1)).toMatchObject({ verify_round: 2, verify_cap: 5 });
    });
  });

  describe('criteria constraints', () => {
    it.each(['passing', 'failing'])('refuses a %s criterion with no evidence', async (status) => {
      await expect(insertCriterion(status, null)).rejects.toThrow(/CHECK/i);
    });

    it('takes a passing criterion with evidence', async () => {
      await expect(insertCriterion('passing', 'QA-REPORT-M1-1@1#ac-1')).resolves.toBeDefined();
    });

    it('refuses a criterion text change without a new cr_id', async () => {
      await insertCriterion('unverified', null);

      await expect(db.updateTable('acceptance_criteria').set({ text: 'Changed' }).execute()).rejects.toThrow(/only through a Change Request/);
      await db.updateTable('acceptance_criteria').set({ text: 'Changed', cr_id: 'CR-1' }).execute();
      await expect(db.updateTable('acceptance_criteria').set({ text: 'Again', cr_id: 'CR-1' }).execute()).rejects.toThrow(/only through a Change Request/);
    });
  });
});
