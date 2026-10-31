import { execFileSync, type ChildProcess } from 'node:child_process';
import { existsSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { ensureIntegrationBranch, addAttemptWorktree } from '../src/git/workspace.ts';
import { recover } from '../src/engine/recovery.ts';
import type { AttemptRow, TaskRow } from '../src/engine/store.ts';
import type { TaskState } from '../src/engine/fsm.ts';
import { worktreePath } from '../src/paths.ts';
import { processStartTime, spawnGroup } from '../src/proc.ts';
import { makeEngine, ticket, until, type TestEngine } from './helpers/engine.ts';

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

const ROUTE: Partial<Record<TaskState, TaskState[]>> = {
  running: ['ready', 'running'],
  checks: ['ready', 'running', 'checks'],
  review: ['ready', 'running', 'checks', 'review'],
};

describe('recover', () => {
  let e: TestEngine;
  const children: ChildProcess[] = [];

  beforeEach(async () => {
    e = await makeEngine({ steps: [] });
  });

  afterEach(async () => {
    for (const child of children.splice(0)) {
      if (child.pid !== undefined) {
        try {
          process.kill(-child.pid, 'SIGKILL');
        } catch {
          // Already gone.
        }
      }
    }
    await e.cleanup();
  });

  async function crashedTask(state: TaskState): Promise<TaskRow> {
    const t = await e.addTicket(ticket());
    for (const step of ROUTE[state] ?? []) await e.store.setTaskState(t.id, step);
    return t;
  }

  async function crashedAttempt(t: TaskRow, state: 'starting' | 'running' = 'running'): Promise<AttemptRow> {
    const attempt = await e.store.createAttempt({
      task_id: t.id,
      adapter: 'claude-code',
      model: 'm',
      worktree_path: join(e.paths.root, 'never-created'),
      branch: 'aiteam/attempt/none',
    });
    return state === 'running' ? e.store.setAttemptState(attempt.id, 'running') : attempt;
  }

  function group(command: string, args: string[]): ChildProcess {
    const child = spawnGroup(command, args, { stdio: 'ignore' });
    children.push(child);
    return child;
  }

  async function runningAs(attempt: AttemptRow, child: ChildProcess): Promise<void> {
    await e.store.patchAttempt(attempt.id, { pid: child.pid!, pid_started_at: await processStartTime(child.pid!) });
  }

  const taskOf = async (t: TaskRow) => (await e.store.getTask(t.id))!;
  const attemptOf = async (t: TaskRow) => (await e.store.listAttempts(t.id))[0]!;

  it('kills a live worker and returns its task to ready', async () => {
    const t = await crashedTask('running');
    const attempt = await crashedAttempt(t);
    const worker = group('sleep', ['60']);
    await runningAs(attempt, worker);

    expect(await recover(e)).toEqual({ interrupted: 1, killed: 1 });

    await until(async () => !isAlive(worker.pid!));
    expect((await attemptOf(t)).state).toBe('interrupted');
    expect((await taskOf(t)).state).toBe('ready');
  });

  it('records what it interrupted', async () => {
    const t = await crashedTask('running');
    const attempt = await crashedAttempt(t);
    await runningAs(attempt, group('sleep', ['60']));

    await recover(e);

    const events = await e.log.list({ taskId: t.id });
    expect(events.find((event) => event.type === 'recovery.interrupted')).toMatchObject({
      attemptId: attempt.id,
      payload: { attemptId: attempt.id, killed: true },
    });
  });

  it('leaves an unrelated process holding a reused pid alone', async () => {
    const t = await crashedTask('running');
    const attempt = await crashedAttempt(t);
    const other = group('sleep', ['60']);
    await e.store.patchAttempt(attempt.id, { pid: other.pid!, pid_started_at: 'Mon Jan  1 00:00:00 2024' });

    expect(await recover(e)).toEqual({ interrupted: 1, killed: 0 });

    expect(isAlive(other.pid!)).toBe(true);
    expect((await attemptOf(t)).state).toBe('interrupted');
  });

  it('a dead pid is interrupted without a kill', async () => {
    const t = await crashedTask('running');
    const attempt = await crashedAttempt(t);
    const gone = group('true', []);
    const pid = gone.pid!;
    await until(async () => (await processStartTime(pid)) === null);
    await e.store.patchAttempt(attempt.id, { pid, pid_started_at: 'Mon Jan  1 00:00:00 2024' });

    expect(await recover(e)).toEqual({ interrupted: 1, killed: 0 });
  });

  it('kills what a dead worker left behind in its group', async () => {
    const t = await crashedTask('running');
    const attempt = await crashedAttempt(t);
    const out = spawnGroup('sh', ['-c', 'sleep 60 >/dev/null 2>&1 & echo $!'], { stdio: ['ignore', 'pipe', 'ignore'] });
    children.push(out);
    const descendant = await new Promise<number>((resolve) => out.stdout!.once('data', (chunk: Buffer) => resolve(Number(chunk.toString()))));
    await until(async () => (await processStartTime(out.pid!)) === null);
    expect(isAlive(descendant)).toBe(true);
    await e.store.patchAttempt(attempt.id, { pid: out.pid!, pid_started_at: 'Mon Jan  1 00:00:00 2024' });

    expect(await recover(e)).toEqual({ interrupted: 1, killed: 1 });

    await until(async () => !isAlive(descendant));
  });

  it('a crash during checks kills the check and returns the task to ready', async () => {
    const t = await crashedTask('checks');
    const attempt = await crashedAttempt(t);
    const check = group('sleep', ['60']);
    await runningAs(attempt, check);

    expect(await recover(e)).toEqual({ interrupted: 1, killed: 1 });

    await until(async () => !isAlive(check.pid!));
    expect((await taskOf(t)).state).toBe('ready');
  });

  it('a crash before the worktree existed still recovers', async () => {
    const t = await crashedTask('running');
    await crashedAttempt(t, 'starting');

    expect(await recover(e)).toEqual({ interrupted: 1, killed: 0 });

    expect((await attemptOf(t)).state).toBe('interrupted');
    expect((await taskOf(t)).state).toBe('ready');
  });

  it('a crash before the attempt existed still recovers', async () => {
    const t = await crashedTask('running');

    expect(await recover(e)).toEqual({ interrupted: 0, killed: 0 });

    expect((await taskOf(t)).state).toBe('ready');
  });

  it('a crash after the attempt ended still returns the task to ready', async () => {
    const t = await crashedTask('checks');
    const attempt = await crashedAttempt(t);
    await e.store.setAttemptState(attempt.id, 'failed', { failure_kind: 'check_failed' });

    expect(await recover(e)).toEqual({ interrupted: 0, killed: 0 });

    expect((await taskOf(t)).state).toBe('ready');
  });

  it('a crash just after the task reached review leaves it there', async () => {
    const t = await crashedTask('review');
    await crashedAttempt(t);

    expect(await recover(e)).toEqual({ interrupted: 1, killed: 0 });

    expect((await attemptOf(t)).state).toBe('interrupted');
    expect((await taskOf(t)).state).toBe('review');
  });

  it('forgets worktrees whose folders have gone', async () => {
    const { headSha } = await ensureIntegrationBranch(e.repoPath, 1, 'main');
    const wt = worktreePath(e.paths, 'p', 'T-1', 1);
    await addAttemptWorktree(e.repoPath, wt, 'aiteam/attempt/T-1-a1', headSha);
    rmSync(wt, { recursive: true });

    await recover(e);

    expect(execFileSync('git', ['-C', e.repoPath, 'worktree', 'list', '--porcelain'], { encoding: 'utf8' })).not.toContain('T-1-a1');
  });

  it('finishes when a project repo has gone', async () => {
    const t = await crashedTask('running');
    await crashedAttempt(t);
    rmSync(e.repoPath, { recursive: true });
    mkdirSync(e.repoPath);
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});

    expect(await recover(e)).toEqual({ interrupted: 1, killed: 0 });

    expect((await taskOf(t)).state).toBe('ready');
    expect(error).toHaveBeenCalledOnce();
    error.mockRestore();
    expect(existsSync(e.repoPath)).toBe(true);
  });

  it('recognises a worker whose daemon ran in another time zone', async () => {
    const worker = group('sleep', ['60']);
    const zone = process.env.TZ;
    try {
      process.env.TZ = 'Asia/Tokyo';
      const there = await processStartTime(worker.pid!);
      process.env.TZ = 'America/New_York';
      expect(await processStartTime(worker.pid!)).toBe(there);
    } finally {
      if (zone === undefined) delete process.env.TZ;
      else process.env.TZ = zone;
    }
  });
});
