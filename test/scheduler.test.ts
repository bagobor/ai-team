import { Conductor } from '../src/engine/conductor/index.ts';
import { addProject, addTicket } from '../src/engine/intake.ts';
import { globsMayOverlap, priorityOrder, Scheduler } from '../src/engine/scheduler.ts';
import type { TaskRow } from '../src/engine/store.ts';
import { eventTypes, makeEngine, okStep, resultLine, ticket, until, type TestEngine } from './helpers/engine.ts';
import { makeRepo } from './helpers/repo.ts';

const INIT = JSON.stringify({ type: 'system', subtype: 'init', session_id: 's', model: 'm' });
const SLOW = { lines: [INIT], delayMs: 120_000 };
const NO_RESET_LIMIT = {
  lines: [INIT, JSON.stringify({ type: 'rate_limit_event', rate_limit_info: { status: 'rejected' } }), resultLine({ is_error: true, result: 'limit' })],
  exitCode: 1,
};

describe('globsMayOverlap', () => {
  it.each([
    ['src/a/**', 'src/b/**', false],
    ['src/**', 'src/a/x.ts', true],
    ['**', 'anything', true],
    ['src/a.ts', 'src/a.ts', true],
    ['src/a.ts', 'src/b.ts', false],
    ['src/*.ts', 'src/a/x.ts', true],
    ['src/ab*', 'src/ac/x', true],
    ['docs/x.md', 'src/x.md', false],
    ['src/', 'src/a.ts', true],
    ['./src/a.ts', 'src/a.ts', true],
    ['SRC/a.ts', 'src/a.ts', true],
    ['{src,lib}/**', 'docs/x.md', true],
    ['src/a?.ts', 'src/ab.ts', true],
  ])('globsMayOverlap(%s, %s) = %s', (a, b, want) => {
    expect(globsMayOverlap(a, b)).toBe(want);
    expect(globsMayOverlap(b, a)).toBe(want);
  });
});

describe('priorityOrder', () => {
  const row = (id: number, ticket_id: string, overrides: Partial<TaskRow> = {}) => ({ id, project_id: 1, ticket_id, kind: 'ticket', state: 'ready', depends_on: [], ...overrides }) as TaskRow;

  it('orders reviews, then bugs, then the longest chain', () => {
    const order = priorityOrder([
      row(1, 'M1-T-1'),
      row(2, 'M1-T-2'),
      row(3, 'M1-T-3', { depends_on: ['M1-T-2'], state: 'blocked' }),
      row(4, 'M1-T-4', { depends_on: ['M1-T-3'], state: 'blocked' }),
      row(5, 'M1-T-5'),
      row(6, 'M1-T-6', { depends_on: ['M1-T-5'], state: 'blocked' }),
      row(7, 'M1-B-1'),
      row(8, 'M1-QA-1', { kind: 'qa_verify' }),
      row(9, 'M1-T-1-R1', { kind: 'code_review' }),
      row(10, 'M1-T-10'),
      row(11, 'M1-T-11', { depends_on: ['M1-T-10'], state: 'done' }),
    ]);

    expect(order.map(({ id }) => id)).toEqual([9, 7, 8, 2, 3, 5, 1, 4, 6, 10, 11]);
  });

  it('keeps chains within a project', () => {
    const order = priorityOrder([row(1, 'A'), row(2, 'A', { project_id: 2 }), row(3, 'B', { project_id: 2, depends_on: ['A'] })]);

    expect(order.map(({ id }) => id)).toEqual([2, 1, 3]);
  });

  it('finishes on a dependency cycle', () => {
    const order = priorityOrder([row(1, 'A', { depends_on: ['B'] }), row(2, 'B', { depends_on: ['A'] })]);

    expect(order.map(({ id }) => id).sort()).toEqual([1, 2]);
  });
});

describe('Scheduler', () => {
  const started: { e: TestEngine; sched: Scheduler }[] = [];

  async function engine(opts: Parameters<typeof makeEngine>[0], conductor?: (e: TestEngine) => Pick<Conductor, 'tick'>): Promise<{ e: TestEngine; sched: Scheduler }> {
    const e = await makeEngine(opts);
    const made = { e, sched: new Scheduler(e, e.runner, conductor?.(e)) };
    started.push(made);
    return made;
  }

  const stateOf = async (e: TestEngine, id: number) => (await e.store.getTask(id))!.state;

  const settled = (e: TestEngine, id: number, state: string) => until(async () => (await stateOf(e, id)) === state, 15_000);

  afterEach(async () => {
    for (const { e, sched } of started.splice(0)) {
      await sched.stop();
      await e.cleanup();
    }
  });

  it('cancels what a conductor tick left behind in a halted project instead of starting it', async () => {
    const { e, sched } = await engine({ steps: [] });
    const stray = await e.addTicket(ticket());
    await e.store.setProjectPhase((await e.store.getProject('p'))!.id, 'halted');

    await sched.tick();

    expect(await stateOf(e, stray.id)).toBe('cancelled');
    expect(e.spawnCount()).toBe(0);
  });

  it('never exceeds 3 live workers across 5 tickets', async () => {
    const { e, sched } = await engine({ steps: [okStep({ 'src/a.mjs': '' }, {}, { delayMs: 200 })] });
    for (let i = 0; i < 5; i += 1) await e.addTicket(ticket({ id: `T-${i}`, touches: [`dir${i}/**`] }));

    let most = 0;
    const sampler = setInterval(() => {
      most = Math.max(most, e.runner.liveCount());
    }, 5);
    sched.start(10);
    await until(async () => (await e.store.listTasks()).every((t) => t.state === 'review'), 15_000);
    clearInterval(sampler);

    expect(most).toBe(3);
    expect(e.spawnCount()).toBe(5);
  });

  it('starts the oldest ready task first', async () => {
    const { e, sched } = await engine({ steps: [SLOW], config: { maxWorkers: 1 } });
    const a = await e.addTicket(ticket({ id: 'A', touches: ['a/**'] }));
    const b = await e.addTicket(ticket({ id: 'B', touches: ['b/**'] }));

    await sched.tick();

    expect(await stateOf(e, a.id)).toBe('running');
    expect(await stateOf(e, b.id)).toBe('ready');
  });

  it('serializes overlapping touches', async () => {
    const { e, sched } = await engine({ steps: [okStep({ 'src/a.mjs': '' }, {}, { delayMs: 200 })] });
    const a = await e.addTicket(ticket({ id: 'A', touches: ['src/**'] }));
    const b = await e.addTicket(ticket({ id: 'B', touches: ['src/a.ts'] }));

    await sched.tick();

    expect(await stateOf(e, a.id)).toBe('running');
    expect(await e.store.getTask(b.id)).toMatchObject({ state: 'blocked', blocked_on: 'path_lock' });

    await settled(e, a.id, 'review');
    await e.store.setTaskState(a.id, 'done');
    sched.start(10);
    await settled(e, b.id, 'review');
  });

  it('keeps an overlapping ticket blocked while the first is in review', async () => {
    const { e, sched } = await engine({ steps: [okStep({ 'src/a.mjs': '' })] });
    const a = await e.addTicket(ticket({ id: 'A', touches: ['src/**'] }));
    const b = await e.addTicket(ticket({ id: 'B', touches: ['src/a.ts'] }));

    await sched.tick();
    await settled(e, a.id, 'review');
    await sched.tick();

    expect(await e.store.getTask(b.id)).toMatchObject({ state: 'blocked', blocked_on: 'path_lock' });
    expect(e.spawnCount()).toBe(1);
  });

  it('runs the conductor before starting tasks', async () => {
    let added: TaskRow | undefined;
    const { e, sched } = await engine({ steps: [SLOW] }, (engine) => ({
      tick: async () => {
        added ??= await engine.addTicket(ticket());
      },
    }));

    await sched.tick();

    expect(await stateOf(e, added!.id)).toBe('running');
  });

  it('keeps scheduling when the conductor throws', async () => {
    const { e, sched } = await engine({ steps: [SLOW] }, () => ({ tick: () => Promise.reject(new Error('The conductor fell over')) }));
    const t = await e.addTicket(ticket());
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});

    await sched.tick();

    expect(await stateOf(e, t.id)).toBe('running');
    expect(error).toHaveBeenCalledOnce();
    error.mockRestore();
  });

  it('starts a bug ticket ahead of an older ticket', async () => {
    const { e, sched } = await engine({ steps: [SLOW], config: { maxWorkers: 1 } });
    const older = await e.addTicket(ticket({ id: 'M1-T-1', touches: ['a/**'] }));
    const bug = await e.addTicket(ticket({ id: 'M1-B-1', touches: ['b/**'] }));

    await sched.tick();

    expect(await stateOf(e, bug.id)).toBe('running');
    expect(await stateOf(e, older.id)).toBe('ready');
  });

  it('asks about a ticket whose dependency was cancelled, rather than waiting on it forever', async () => {
    const { e, sched } = await engine({ steps: [SLOW] });
    const a = await e.addTicket(ticket({ id: 'A', touches: ['a/**'] }));
    await e.store.setTaskState(a.id, 'cancelled');
    const b = await e.addTicket(ticket({ id: 'B', touches: ['b/**'], depends_on: ['A'] }));

    await sched.tick();

    expect(await e.store.getTask(b.id)).toMatchObject({ state: 'escalated', escalation_reason: 'dependency_cancelled: A' });
    expect(e.spawnCount()).toBe(0);
  });

  it('runs that ticket without its dependency once the stakeholder says retry, and does not ask again', async () => {
    const { e, sched } = await engine({ steps: [SLOW] }, (engine) => new Conductor(engine, engine.runner));
    const holder = await e.addTicket(ticket({ id: 'H', touches: ['b/**'] }));
    const a = await e.addTicket(ticket({ id: 'A', touches: ['a/**'] }));
    await e.store.setTaskState(a.id, 'cancelled');
    const b = await e.addTicket(ticket({ id: 'B', touches: ['b/**'], depends_on: ['A'] }));

    await sched.tick();
    expect(await stateOf(e, holder.id)).toBe('running');
    await sched.tick();
    const [item] = await e.store.listInbox({ state: 'pending' });
    expect(item).toMatchObject({ ref: { kind: 'escalation', taskId: b.id } });
    expect(item!.recommendation).toContain('without');
    await e.store.answerInbox(item!.id, { option: 'retry' });

    await sched.tick();
    expect(await e.store.getTask(b.id)).toMatchObject({ state: 'blocked', blocked_on: 'path_lock', depends_on: [] });
    await e.runner.cancel(holder.id);
    await sched.tick();

    expect(await stateOf(e, b.id)).toBe('running');
    expect(await e.store.listInbox({ state: 'pending' })).toEqual([]);
  });

  it('does not let a retry start over a task that now holds the lock', async () => {
    const { e, sched } = await engine({ steps: [SLOW] });
    const a = await e.addTicket(ticket({ id: 'A', touches: ['src/**'] }));
    const b = await e.addTicket(ticket({ id: 'B', touches: ['src/**'] }));
    await sched.tick();
    await e.store.setTaskState(b.id, 'ready');

    await sched.tick();

    expect(await stateOf(e, a.id)).toBe('running');
    expect(await e.store.getTask(b.id)).toMatchObject({ state: 'blocked', blocked_on: 'path_lock' });
  });

  it('keeps locks within a project', async () => {
    const { e, sched } = await engine({ steps: [SLOW] });
    const other = await makeRepo();
    await addProject({ store: e.store, paths: e.paths }, { name: 'q', repoPath: other.path, create: false });
    const a = await e.addTicket(ticket({ id: 'A', touches: ['src/**'] }));
    const b = await addTicket({ store: e.store, paths: e.paths }, 'q', ticket({ id: 'B', touches: ['src/**'] }));

    await sched.tick();

    expect(await stateOf(e, a.id)).toBe('running');
    expect(await stateOf(e, b.id)).toBe('running');
  });

  it('keeps dependencies within a project', async () => {
    const { e, sched } = await engine({ steps: [SLOW] });
    const other = await makeRepo();
    const deps = { store: e.store, paths: e.paths };
    await addProject(deps, { name: 'q', repoPath: other.path, create: false });
    const doneHere = await e.addTicket(ticket({ id: 'A', touches: ['a/**'] }));
    await e.db.updateTable('tasks').set({ state: 'done' }).where('id', '=', doneHere.id).execute();
    const notDoneThere = await addTicket(deps, 'q', ticket({ id: 'A', touches: ['a/**'] }));
    await e.store.setTaskState(notDoneThere.id, 'blocked', { blockedOn: 'human_request' });
    const b = await addTicket(deps, 'q', ticket({ id: 'B', touches: ['b/**'], depends_on: ['A'] }));

    await sched.tick();

    expect(await e.store.getTask(b.id)).toMatchObject({ state: 'blocked', blocked_on: 'dependency' });
  });

  it('waits for dependencies to be done, not just in review', async () => {
    const { e, sched } = await engine({ steps: [okStep({ 'src/a.mjs': '' })] });
    const a = await e.addTicket(ticket({ id: 'A', touches: ['a/**'] }));
    const b = await e.addTicket(ticket({ id: 'B', touches: ['b/**'], depends_on: ['A'] }));

    await sched.tick();
    await settled(e, a.id, 'review');
    await sched.tick();
    expect(await e.store.getTask(b.id)).toMatchObject({ state: 'blocked', blocked_on: 'dependency' });

    await e.store.setTaskState(a.id, 'done');
    await sched.tick();

    expect(await stateOf(e, b.id)).toBe('running');
  });

  it('moves a task to the new reason when its dependency clears but a lock holds it', async () => {
    const { e, sched } = await engine({ steps: [SLOW] });
    const a = await e.addTicket(ticket({ id: 'A', touches: ['a/**'] }));
    const c = await e.addTicket(ticket({ id: 'C', touches: ['shared/**'], depends_on: ['A'] }));
    const b = await e.addTicket(ticket({ id: 'B', touches: ['shared/**'] }));

    await sched.tick();
    expect(await e.store.getTask(c.id)).toMatchObject({ state: 'blocked', blocked_on: 'dependency' });
    expect(await stateOf(e, b.id)).toBe('running');

    await e.runner.cancel(a.id);
    await e.db.updateTable('tasks').set({ state: 'done' }).where('id', '=', a.id).execute();
    await sched.tick();

    expect(await e.store.getTask(c.id)).toMatchObject({ state: 'blocked', blocked_on: 'path_lock' });
  });

  it('holds a paused vendor until its reset, then probes', async () => {
    let now = new Date('2026-10-30T14:00:00.000Z');
    const { e, sched } = await engine({ steps: [okStep({ 'src/a.mjs': '' })], now: () => now });
    await e.store.setVendorPause({ vendor: 'anthropic', until: '2026-10-30T15:00:00.000Z', backoff_s: 300, reason: 'usage' });
    const t = await e.addTicket(ticket());

    await sched.tick();
    expect(e.runner.liveCount()).toBe(0);
    expect(await stateOf(e, t.id)).toBe('ready');

    now = new Date('2026-10-30T15:00:01.000Z');
    await sched.tick();
    await settled(e, t.id, 'review');

    expect(e.spawnCount()).toBe(1);
    expect(await e.store.getVendorPause('anthropic')).toBeUndefined();
  });

  it('lets one probe through at a time after a pause runs out', async () => {
    let now = new Date('2026-10-30T14:00:00.000Z');
    const { e, sched } = await engine({ steps: [okStep({ 'src/a.mjs': '' }, {}, { delayMs: 300 })], now: () => now });
    await e.store.setVendorPause({ vendor: 'anthropic', until: '2026-10-30T13:00:00.000Z', backoff_s: 300, reason: 'usage' });
    const a = await e.addTicket(ticket({ id: 'A', touches: ['a/**'] }));
    const b = await e.addTicket(ticket({ id: 'B', touches: ['b/**'] }));

    await sched.tick();
    await sched.tick();

    expect(await stateOf(e, a.id)).toBe('running');
    expect(await stateOf(e, b.id)).toBe('ready');

    await settled(e, a.id, 'review');
    await sched.tick();
    expect(await stateOf(e, b.id)).toBe('running');
  });

  it('lets another probe through when the last one failed for its own reasons', async () => {
    const bad = { lines: [INIT, resultLine({ structured_output: { nope: true } })] };
    const { e, sched } = await engine({
      steps: [bad, SLOW],
      config: { maxAttempts: 1 },
      now: () => new Date('2026-10-30T14:00:00.000Z'),
    });
    await e.store.setVendorPause({ vendor: 'anthropic', until: '2026-10-30T13:00:00.000Z', backoff_s: 300, reason: 'usage' });
    const a = await e.addTicket(ticket({ id: 'A', touches: ['a/**'] }));
    const b = await e.addTicket(ticket({ id: 'B', touches: ['b/**'] }));

    await sched.tick();
    await settled(e, a.id, 'escalated');
    await sched.tick();

    expect(await stateOf(e, b.id)).toBe('running');
  });

  it('doubles backoff to 3600 when no reset time is given', async () => {
    let now = new Date('2026-10-30T14:00:00.000Z');
    const { e, sched } = await engine({ steps: [NO_RESET_LIMIT], now: () => now });
    const t = await e.addTicket(ticket());

    const seen: number[] = [];
    for (let i = 0; i < 6; i += 1) {
      await sched.tick();
      await until(async () => (await stateOf(e, t.id)) === 'ready' && e.runner.liveCount() === 0);
      const pause = await e.store.getVendorPause('anthropic');
      seen.push(pause!.backoff_s);
      now = new Date(Date.parse(pause!.until) + 1000);
    }

    expect(seen).toEqual([300, 600, 1200, 2400, 3600, 3600]);
    expect(await e.store.failedAttemptCount(t.id)).toBe(0);
  });

  it('writes one event per real state change', async () => {
    const { e, sched } = await engine({ steps: [okStep({ 'src/a.mjs': '' })] });
    const a = await e.addTicket(ticket({ id: 'A', touches: ['a/**'] }));
    await e.store.setTaskState(a.id, 'blocked', { blockedOn: 'human_request' });
    const b = await e.addTicket(ticket({ id: 'B', touches: ['b/**'], depends_on: ['A'] }));

    for (let i = 0; i < 10; i += 1) await sched.tick();

    expect((await eventTypes(e, b.id)).filter((type) => type === 'task.state')).toHaveLength(1);
  });

  it('keeps a task blocked on a lock without flapping through ready', async () => {
    const { e, sched } = await engine({ steps: [SLOW] });
    await e.addTicket(ticket({ id: 'A', touches: ['src/**'] }));
    const b = await e.addTicket(ticket({ id: 'B', touches: ['src/**'] }));

    const stateEvents = async () => (await eventTypes(e, b.id)).filter((type) => type === 'task.state').length;

    await sched.tick();
    const afterFirstTick = await stateEvents();
    for (let i = 0; i < 5; i += 1) await sched.tick();

    expect(await e.store.getTask(b.id)).toMatchObject({ state: 'blocked', blocked_on: 'path_lock' });
    expect(await stateEvents()).toBe(afterFirstTick);
  });

  it('leaves a task that waits on a person alone', async () => {
    const { e, sched } = await engine({ steps: [okStep({ 'src/a.mjs': '' })] });
    const t = await e.addTicket(ticket());
    await e.store.setTaskState(t.id, 'blocked', { blockedOn: 'human_request' });

    await sched.tick();

    expect(await e.store.getTask(t.id)).toMatchObject({ state: 'blocked', blocked_on: 'human_request' });
    expect(e.spawnCount()).toBe(0);
  });

  it('does not run a tick on top of itself', async () => {
    const { e, sched } = await engine({ steps: [okStep({ 'src/a.mjs': '' })] });
    const list = vi.spyOn(e.store, 'listTasks');

    await Promise.all([sched.tick(), sched.tick(), sched.tick()]);

    expect(list).toHaveBeenCalledTimes(1);
  });

  it('starts nothing after stop', async () => {
    const { e, sched } = await engine({ steps: [okStep({ 'src/a.mjs': '' })] });
    sched.start(5);
    await sched.stop();

    const t = await e.addTicket(ticket());
    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(await stateOf(e, t.id)).toBe('queued');
  });

  it('stop waits for the current tick', async () => {
    const { e, sched } = await engine({ steps: [SLOW] });
    const t = await e.addTicket(ticket());

    const ticking = sched.tick();
    await sched.stop();

    expect(await stateOf(e, t.id)).toBe('running');
    await ticking;
  });

  it('survives a task that cannot start and still starts the next', async () => {
    const { e, sched } = await engine({ steps: [SLOW] });
    const a = await e.addTicket(ticket({ id: 'A', touches: ['a/**'] }));
    const b = await e.addTicket(ticket({ id: 'B', touches: ['b/**'] }));
    const begin = e.runner.begin.bind(e.runner);
    vi.spyOn(e.runner, 'begin').mockImplementation((id) => (id === a.id ? Promise.reject(new Error('no')) : begin(id)));
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});

    await sched.tick();

    expect(await stateOf(e, a.id)).toBe('ready');
    expect(await stateOf(e, b.id)).toBe('running');
    expect(error).toHaveBeenCalledOnce();
    error.mockRestore();
  });

  it('lets a broken role reach the runner, which escalates it', async () => {
    const { e, sched } = await engine({ steps: [okStep({ 'src/a.mjs': '' })] });
    const t = await e.addTicket(ticket());
    await e.db.updateTable('tasks').set({ role_id: 'ghost' }).where('id', '=', t.id).execute();

    await sched.tick();
    await settled(e, t.id, 'escalated');

    expect((await e.store.getTask(t.id))!.escalation_reason).toMatch(/^workspace_error/);
  });

  it('survives a tick that fails', async () => {
    const { e, sched } = await engine({ steps: [okStep({ 'src/a.mjs': '' })] });
    const t = await e.addTicket(ticket());
    const list = vi.spyOn(e.store, 'listTasks').mockRejectedValueOnce(new Error('db hiccup'));
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});

    sched.start(5);
    await settled(e, t.id, 'review');

    expect(list.mock.calls.length).toBeGreaterThan(1);
    expect(error).toHaveBeenCalled();
    error.mockRestore();
  });
});
