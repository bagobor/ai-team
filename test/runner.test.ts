import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { AttemptRow } from '../src/engine/store.ts';
import type { TaskManifest } from '../src/manifest/build.ts';
import { manifestDir, transcriptPath, worktreePath } from '../src/paths.ts';
import { eventTypes, makeEngine, okStep, resultLine, runOnce, runToSettled, ticket, until, type TestEngine } from './helpers/engine.ts';
import { commitAll, tempDir } from './helpers/repo.ts';

const INIT = JSON.stringify({ type: 'system', subtype: 'init', session_id: 's', model: 'm' });
const SLOW_STEP = { lines: [INIT], delayMs: 120_000 };

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

describe('Runner', () => {
  const engines: TestEngine[] = [];

  async function engine(opts: Parameters<typeof makeEngine>[0]): Promise<TestEngine> {
    const e = await makeEngine(opts);
    engines.push(e);
    return e;
  }

  const task = async (e: TestEngine, id: number) => (await e.store.getTask(id))!;
  const systemPrompt = (e: TestEngine, ticketId: string) => readFileSync(join(manifestDir(e.paths, 'p', ticketId, 1), 'system.md'), 'utf8');

  // Wrapped because an async function would otherwise wait for the promise it returns, and so for the whole attempt.
  async function startRunning(e: TestEngine, id: number): Promise<{ running: Promise<void>; attempt: AttemptRow }> {
    await e.store.setTaskState(id, 'ready');
    await e.runner.begin(id);
    const running = e.runner.execute(id);
    const attempt = await until(async () => (await e.store.listAttempts(id)).find((a) => a.state === 'running'));
    return { running, attempt };
  }

  it("hands the repo's CLAUDE.md to the worker in its system prompt", async () => {
    const e = await engine({ steps: [okStep({ 'src/a.mjs': '' })] });
    writeFileSync(join(e.repoPath, 'CLAUDE.md'), 'House rule: tabs.');
    commitAll(e.repoPath, 'instructions');
    const t = await e.addTicket(ticket());

    await runOnce(e, t.id);

    expect(systemPrompt(e, t.ticket_id)).toContain('House rule: tabs.');
  });

  it('keeps a file behind a committed link out of the system prompt', async () => {
    const e = await engine({ steps: [okStep({ 'src/a.mjs': '' })] });
    const secret = join(tempDir(), 'secret');
    writeFileSync(secret, 'TOP-SECRET');
    symlinkSync(secret, join(e.repoPath, 'CLAUDE.md'));
    commitAll(e.repoPath, 'a link out of the repo');
    const t = await e.addTicket(ticket());

    await runOnce(e, t.id);

    expect(systemPrompt(e, t.ticket_id)).not.toContain('TOP-SECRET');
    expect((await task(e, t.id)).state).toBe('review');
  });

  afterEach(async () => {
    await Promise.all(engines.splice(0).map((e) => e.cleanup()));
  });

  it('runs a ticket to review with a logged manifest', async () => {
    const e = await engine({ steps: [okStep({ 'src/a.mjs': 'export {}' })] });
    const t = await e.addTicket(ticket({ definition_of_done: ['test -f src/a.mjs'] }));

    await runToSettled(e, t.id);

    expect((await task(e, t.id)).state).toBe('review');
    const [a] = await e.store.listAttempts(t.id);
    expect(a).toMatchObject({ state: 'succeeded', k: 1, branch: 'aiteam/attempt/T-1-a1' });
    expect(a!.worktree_path).toBe(worktreePath(e.paths, 'p', t.ticket_id, 1));
    expect((a!.manifest as TaskManifest).flags).toContain('--json-schema');
    expect(a!.output).toMatchObject({ summary: 'Did the work' });
    expect(a!.usage).toMatchObject({ inTok: 10, outTok: 20 });
    expect(existsSync(transcriptPath(e.paths, 'p', a!.id))).toBe(true);
    expect(await eventTypes(e, t.id)).toEqual(expect.arrayContaining(['manifest.built', 'worker.init', 'check.finished']));
  });

  it('records the full check run on check.finished', async () => {
    const e = await engine({ steps: [okStep({ 'src/a.mjs': 'export {}' })] });
    const t = await e.addTicket(ticket({ definition_of_done: ['echo hello'] }));

    await runToSettled(e, t.id);

    const finished = (await e.log.list({ taskId: t.id })).find((event) => event.type === 'check.finished');
    expect(finished).toMatchObject({ attemptId: expect.any(Number), payload: { command: 'echo hello', exitCode: 0, outputTail: 'hello\n' } });
  });

  it('builds the attempt from the integration branch, not the base branch', async () => {
    const e = await engine({ steps: [okStep({ 'src/a.mjs': 'export {}' })] });
    const t = await e.addTicket(ticket());

    await runToSettled(e, t.id);

    const [a] = await e.store.listAttempts(t.id);
    expect(a!.base_sha).toMatch(/^[0-9a-f]{40}$/);
  });

  it('retries a failed check in a fresh worktree with evidence, never the transcript', async () => {
    const assistantLine = JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'FAKE_TRANSCRIPT_ONLY_MARKER' }] } });
    const first = okStep({ 'src/wrong.mjs': '' }, { summary: 'first-summary-marker' });
    (first.lines as string[]).splice(1, 0, assistantLine);
    const e = await engine({ steps: [first, okStep({ 'src/right.mjs': '' })] });
    const t = await e.addTicket(ticket({ definition_of_done: ['echo check-output-marker; test -f src/right.mjs'] }));

    await runToSettled(e, t.id);

    const [a1, a2] = await e.store.listAttempts(t.id);
    expect(a1).toMatchObject({ state: 'failed', failure_kind: 'check_failed' });
    expect(a2).toMatchObject({ state: 'succeeded', k: 2 });
    expect(a2!.worktree_path).not.toBe(a1!.worktree_path);
    expect(existsSync(a1!.worktree_path)).toBe(true);
    expect(existsSync(join(a2!.worktree_path, 'src/wrong.mjs'))).toBe(false);

    const task2 = readFileSync(join(manifestDir(e.paths, 'p', t.ticket_id, 2), 'task.md'), 'utf8');
    expect(task2).toContain('check-output-marker');
    expect(task2).toContain('first-summary-marker');
    expect(task2).not.toContain('FAKE_TRANSCRIPT_ONLY_MARKER');
  });

  it('skips over an interrupted attempt to find the evidence for a retry', async () => {
    const limited = { fixture: 'usage-limit.synthetic.jsonl', exitCode: 1 };
    const e = await engine({
      steps: [okStep({ 'src/wrong.mjs': '' }), limited, okStep({ 'src/right.mjs': '' })],
      now: () => new Date('2026-10-30T14:00:00.000Z'),
    });
    const t = await e.addTicket(ticket({ definition_of_done: ['echo check-output-marker; test -f src/right.mjs'] }));

    await runToSettled(e, t.id);

    const task3 = readFileSync(join(manifestDir(e.paths, 'p', t.ticket_id, 3), 'task.md'), 'utf8');
    expect(task3).toContain('check-output-marker');
  });

  it('escalates at the attempt cap of 3 and spawns no fourth worker', async () => {
    const e = await engine({ steps: [okStep({ 'src/a.mjs': '' })] });
    const t = await e.addTicket(ticket({ definition_of_done: ['false'] }));

    await runToSettled(e, t.id);

    expect(await task(e, t.id)).toMatchObject({ state: 'escalated', escalation_reason: 'attempts_exhausted' });
    expect(e.spawnCount()).toBe(3);
    expect(await e.store.failedAttemptCount(t.id)).toBe(3);
  });

  it('a human retry grants exactly one more attempt', async () => {
    const e = await engine({ steps: [okStep({ 'src/a.mjs': '' })] });
    const t = await e.addTicket(ticket({ definition_of_done: ['false'] }));
    await runToSettled(e, t.id);

    await e.runner.retry(t.id);
    expect((await task(e, t.id)).state).toBe('ready');
    await runOnce(e, t.id);

    expect(await task(e, t.id)).toMatchObject({ state: 'escalated', escalation_reason: 'attempts_exhausted' });
    expect(e.spawnCount()).toBe(4);
  });

  it('refuses a retry of a task that is not escalated', async () => {
    const e = await engine({ steps: [okStep({ 'src/a.mjs': '' })] });
    const t = await e.addTicket(ticket());
    await runToSettled(e, t.id);

    await expect(e.runner.retry(t.id)).rejects.toThrow(/review → ready/);
  });

  it('counts schema-invalid output as a failed attempt', async () => {
    const bad = { lines: [INIT, resultLine({ structured_output: { nope: true } })] };
    const e = await engine({ steps: [bad, okStep({ 'src/a.mjs': '' })] });
    const t = await e.addTicket(ticket());

    await runToSettled(e, t.id);

    const [a1, a2] = await e.store.listAttempts(t.id);
    expect(a1!.state).toBe('invalid_output');
    expect(a1!.failure_evidence).toEqual(expect.any(String));
    expect(a2!.state).toBe('succeeded');
    expect(await e.store.failedAttemptCount(t.id)).toBe(1);
  });

  it('counts a scope violation as a failed attempt', async () => {
    const e = await engine({ steps: [okStep({ '.aiteam/x.md': 'x' }), okStep({ 'src/a.mjs': '' })] });
    const t = await e.addTicket(ticket());

    await runToSettled(e, t.id);

    const [a1] = await e.store.listAttempts(t.id);
    expect(a1).toMatchObject({ state: 'failed', failure_kind: 'scope_violation' });
    expect(a1!.failure_evidence).toContain('.aiteam/x.md');
  });

  it('counts changing nothing as a failed attempt', async () => {
    const e = await engine({ steps: [okStep({}), okStep({ 'src/a.mjs': '' })] });
    const t = await e.addTicket(ticket());

    await runToSettled(e, t.id);

    const [a1] = await e.store.listAttempts(t.id);
    expect(a1).toMatchObject({ state: 'failed', failure_kind: 'no_changes' });
  });

  it('carries the budget and turn results to the attempt state', async () => {
    const e = await engine({ steps: [{ fixture: 'max-budget.jsonl', exitCode: 1 }, okStep({ 'src/a.mjs': '' })] });
    const t = await e.addTicket(ticket());

    await runToSettled(e, t.id);

    const [a1] = await e.store.listAttempts(t.id);
    expect(a1!.state).toBe('budget_exceeded');
    expect(a1!.failure_evidence).toMatch(/budget/i);
  });

  it('times out a stuck worker and counts the attempt', async () => {
    const e = await engine({ steps: [SLOW_STEP, okStep({ 'src/a.mjs': '' })], config: { attemptTimeoutS: 0.3 } });
    const t = await e.addTicket(ticket());

    await runToSettled(e, t.id);

    const [a1, a2] = await e.store.listAttempts(t.id);
    expect(a1!.state).toBe('timeout');
    expect(a2!.state).toBe('succeeded');
  });

  it('login expiry mid-attempt escalates at once with the login command', async () => {
    const e = await engine({ steps: [{ fixture: 'auth-failed.jsonl', exitCode: 1 }] });
    const t = await e.addTicket(ticket());

    await runToSettled(e, t.id);

    expect(e.spawnCount()).toBe(1);
    const settled = await task(e, t.id);
    expect(settled.state).toBe('escalated');
    expect(settled.escalation_reason).toMatch(/auth login/);
    const [a] = await e.store.listAttempts(t.id);
    expect(a).toMatchObject({ state: 'failed', failure_kind: 'auth_required' });
  });

  it('logged-out preflight creates no attempt', async () => {
    const e = await engine({ steps: [okStep({ 'src/a.mjs': '' })], env: { FAKE_AUTH: '{"loggedIn":false}' } });
    const t = await e.addTicket(ticket());

    await runToSettled(e, t.id);

    expect(await e.store.listAttempts(t.id)).toEqual([]);
    expect(e.spawnCount()).toBe(0);
    const settled = await task(e, t.id);
    expect(settled.state).toBe('escalated');
    expect(settled.escalation_reason).toMatch(/^agent_home_not_logged_in/);
    expect(settled.escalation_reason).toMatch(/auth login/);
  });

  it('a moved repo escalates as a workspace error, with no attempt', async () => {
    const e = await engine({ steps: [okStep({ 'src/a.mjs': '' })] });
    const t = await e.addTicket(ticket());
    rmSync(e.repoPath, { recursive: true, force: true });

    await runToSettled(e, t.id);

    expect((await task(e, t.id)).escalation_reason).toMatch(/^workspace_error/);
    expect(await e.store.listAttempts(t.id)).toEqual([]);
  });

  describe('usage limit', () => {
    const LIMITED = { fixture: 'usage-limit.synthetic.jsonl', exitCode: 1 };
    const NO_RESET = { lines: [INIT, JSON.stringify({ type: 'rate_limit_event', rate_limit_info: { status: 'rejected' } }), resultLine({ is_error: true, result: 'limit' })], exitCode: 1 };
    const NOW = new Date('2026-10-30T14:00:00.000Z');

    it('interrupts without using up an attempt', async () => {
      const e = await engine({ steps: [LIMITED], now: () => NOW });
      const t = await e.addTicket(ticket());

      await runOnce(e, t.id);

      const [a] = await e.store.listAttempts(t.id);
      expect(a!.state).toBe('interrupted');
      expect(a!.failure_evidence).toBeNull();
      expect(await e.store.failedAttemptCount(t.id)).toBe(0);
      expect(await e.store.getVendorPause('anthropic')).toMatchObject({ until: '2026-10-30T15:00:00.000Z' });
      expect((await task(e, t.id)).state).toBe('ready');
      expect(await eventTypes(e, t.id)).toContain('vendor.paused');
    });

    it('backs off from 300 s, doubling, when no reset time is given', async () => {
      const e = await engine({ steps: [NO_RESET], now: () => NOW });
      const t = await e.addTicket(ticket());

      await runOnce(e, t.id);
      expect(await e.store.getVendorPause('anthropic')).toMatchObject({ until: '2026-10-30T14:05:00.000Z', backoff_s: 300 });

      await runOnce(e, t.id);
      expect(await e.store.getVendorPause('anthropic')).toMatchObject({ until: '2026-10-30T14:10:00.000Z', backoff_s: 600 });
    });

    it('stops doubling at 3600 s', async () => {
      const e = await engine({ steps: [NO_RESET], now: () => NOW });
      const t = await e.addTicket(ticket());
      await e.store.setVendorPause({ vendor: 'anthropic', until: NOW.toISOString(), backoff_s: 2400, reason: 'x' });

      await runOnce(e, t.id);

      expect(await e.store.getVendorPause('anthropic')).toMatchObject({ backoff_s: 3600 });
    });

    it('backs off when the reset time has already passed, so it cannot spin', async () => {
      const e = await engine({ steps: [LIMITED], now: () => new Date('2026-10-30T16:00:00.000Z') });
      const t = await e.addTicket(ticket());

      await runOnce(e, t.id);

      expect(await e.store.getVendorPause('anthropic')).toMatchObject({ until: '2026-10-30T16:05:00.000Z' });
    });

    it('a successful worker clears a pause that has run out', async () => {
      const e = await engine({ steps: [okStep({ 'src/a.mjs': '' })], now: () => NOW });
      const t = await e.addTicket(ticket());
      await e.store.setVendorPause({ vendor: 'anthropic', until: '2026-10-30T13:00:00.000Z', backoff_s: 600, reason: 'x' });

      await runToSettled(e, t.id);

      expect(await e.store.getVendorPause('anthropic')).toBeUndefined();
    });

    it('a worker started before a pause began does not lift it', async () => {
      const e = await engine({ steps: [okStep({ 'src/a.mjs': '' })], now: () => NOW });
      const t = await e.addTicket(ticket());
      await e.store.setVendorPause({ vendor: 'anthropic', until: '2026-10-30T15:00:00.000Z', backoff_s: 600, reason: 'x' });

      await runToSettled(e, t.id);

      expect(await e.store.getVendorPause('anthropic')).toMatchObject({ until: '2026-10-30T15:00:00.000Z' });
    });
  });

  it('context over budget spawns nothing', async () => {
    const e = await engine({ steps: [okStep({ 'src/a.mjs': '' })] });
    const t = await e.addTicket(ticket({ body: 'x'.repeat(80_000) }));

    await runToSettled(e, t.id);

    expect(e.spawnCount()).toBe(0);
    const [a] = await e.store.listAttempts(t.id);
    expect(a).toMatchObject({ state: 'failed', failure_kind: 'context_over_budget' });
    expect((await task(e, t.id)).escalation_reason).toMatch(/^context_over_budget/);
  });

  it('cancel stops the worker and abandons the worktree', async () => {
    const e = await engine({ steps: [SLOW_STEP] });
    const t = await e.addTicket(ticket());
    const { running, attempt } = await startRunning(e, t.id);
    const pid = attempt.pid!;
    expect(alive(pid)).toBe(true);

    await e.runner.cancel(t.id);
    await running;

    expect((await task(e, t.id)).state).toBe('cancelled');
    const [a] = await e.store.listAttempts(t.id);
    expect(a!.state).toBe('cancelled');
    expect(a!.worktree_removed_at).not.toBeNull();
    expect(alive(pid)).toBe(false);
    expect(existsSync(attempt.worktree_path)).toBe(false);
    expect(await e.store.failedAttemptCount(t.id)).toBe(0);
    expect(execFileSync('git', ['branch', '--list', attempt.branch], { cwd: e.repoPath, encoding: 'utf8' })).toBe('');
  });

  it('cancel during checks kills the check', async () => {
    const e = await engine({ steps: [okStep({ 'src/a.mjs': '' })], config: { cancelGraceS: 1 } });
    const t = await e.addTicket(ticket({ definition_of_done: ['sleep 100'] }));
    await e.store.setTaskState(t.id, 'ready');
    await e.runner.begin(t.id);
    const running = e.runner.execute(t.id);

    await until(async () => (await eventTypes(e, t.id)).includes('check.started'));
    const checkPid = await until(async () => {
      const [a] = await e.store.listAttempts(t.id);
      const manifestPid = a?.pid;
      return manifestPid && a.pid_started_at && alive(manifestPid) ? manifestPid : undefined;
    });
    const started = Date.now();
    await e.runner.cancel(t.id);
    await running;

    expect(Date.now() - started).toBeLessThan(5000);
    expect(alive(checkPid)).toBe(false);
    expect((await task(e, t.id)).state).toBe('cancelled');
    const [a] = await e.store.listAttempts(t.id);
    expect(a!.state).toBe('cancelled');
    expect(existsSync(a!.worktree_path)).toBe(false);
  });

  it('points the attempt at the running check, so recovery can kill it', async () => {
    const e = await engine({ steps: [okStep({ 'src/a.mjs': '' })] });
    const t = await e.addTicket(ticket({ definition_of_done: ['sleep 100'] }));
    await e.store.setTaskState(t.id, 'ready');
    await e.runner.begin(t.id);
    const running = e.runner.execute(t.id);
    const workerPid = await until(async () => (await e.store.listAttempts(t.id))[0]?.pid);

    await until(async () => (await eventTypes(e, t.id)).includes('check.started'));
    const checkPid = await until(async () => {
      const pid = (await e.store.listAttempts(t.id))[0]?.pid;
      return pid !== workerPid ? pid : undefined;
    });

    expect(alive(checkPid)).toBe(true);
    await e.runner.shutdown();
    await running;
    expect(alive(checkPid)).toBe(false);
  });

  it('cancel with no live attempt goes straight to cancelled', async () => {
    const e = await engine({ steps: [okStep({ 'src/a.mjs': '' })] });
    const t = await e.addTicket(ticket());

    await e.runner.cancel(t.id);

    expect((await task(e, t.id)).state).toBe('cancelled');
    expect(e.spawnCount()).toBe(0);
  });

  it('cancel before the worker started spawns nothing', async () => {
    const e = await engine({ steps: [okStep({ 'src/a.mjs': '' })] });
    const t = await e.addTicket(ticket());
    await e.store.setTaskState(t.id, 'ready');
    await e.runner.begin(t.id);

    const running = e.runner.execute(t.id);
    await e.runner.cancel(t.id);
    await running;

    expect((await task(e, t.id)).state).toBe('cancelled');
    expect(e.spawnCount()).toBe(0);
    for (const a of await e.store.listAttempts(t.id)) expect(a.state).toBe('cancelled');
  });

  it('cancel after the attempt was created still spawns nothing', async () => {
    const e = await engine({ steps: [okStep({ 'src/a.mjs': '' })] });
    const t = await e.addTicket(ticket());
    let cancelling: Promise<void> | undefined;
    const unsubscribe = e.log.subscribe((event) => {
      if (event.type === 'manifest.built') cancelling = e.runner.cancel(t.id);
    });

    await runOnce(e, t.id);
    await cancelling;
    unsubscribe();

    expect(e.spawnCount()).toBe(0);
    expect((await task(e, t.id)).state).toBe('cancelled');
    const [a] = await e.store.listAttempts(t.id);
    expect(a!.state).toBe('cancelled');
    expect(existsSync(a!.worktree_path)).toBe(false);
  });

  it('shutdown interrupts instead of cancelling', async () => {
    const e = await engine({ steps: [SLOW_STEP] });
    const t = await e.addTicket(ticket());
    const { running } = await startRunning(e, t.id);
    expect(e.runner.liveCount()).toBe(1);

    await e.runner.shutdown();
    await running;

    const [a] = await e.store.listAttempts(t.id);
    expect(a!.state).toBe('interrupted');
    expect((await task(e, t.id)).state).toBe('ready');
    expect(await e.store.failedAttemptCount(t.id)).toBe(0);
    expect(existsSync(a!.worktree_path)).toBe(true);
    expect(e.runner.liveCount()).toBe(0);
  });

  it('starts nothing new once it is shutting down', async () => {
    const e = await engine({ steps: [okStep({ 'src/a.mjs': '' })] });
    const t = await e.addTicket(ticket());
    await e.store.setTaskState(t.id, 'ready');

    await e.runner.shutdown();

    await expect(e.runner.begin(t.id)).rejects.toThrow(/shutting down/);
    expect((await task(e, t.id)).state).toBe('ready');
  });

  it('counts a task as live from begin until execute ends', async () => {
    const e = await engine({ steps: [okStep({ 'src/a.mjs': '' })] });
    const t = await e.addTicket(ticket());
    await e.store.setTaskState(t.id, 'ready');

    await e.runner.begin(t.id);
    expect(e.runner.liveCount()).toBe(1);
    expect((await task(e, t.id)).state).toBe('running');

    await e.runner.execute(t.id);
    expect(e.runner.liveCount()).toBe(0);
  });

  it('frees the slot when begin fails', async () => {
    const e = await engine({ steps: [okStep({ 'src/a.mjs': '' })] });
    const t = await e.addTicket(ticket());

    await expect(e.runner.begin(t.id)).rejects.toThrow(/queued → running/);

    expect(e.runner.liveCount()).toBe(0);
  });

  it('an engine exception cannot leave a task running', async () => {
    const e = await engine({ steps: [okStep({ 'src/a.mjs': '' })] });
    const t = await e.addTicket(ticket());
    vi.spyOn(e.adapters['claude-code']!, 'start').mockImplementation(() => {
      throw new Error('adapter blew up');
    });

    await runOnce(e, t.id);

    expect(await task(e, t.id)).toMatchObject({ state: 'escalated', escalation_reason: 'engine_error: adapter blew up' });
    const [a] = await e.store.listAttempts(t.id);
    expect(a).toMatchObject({ state: 'failed', failure_kind: 'engine_error' });
    expect(e.runner.liveCount()).toBe(0);
  });

  it('an exception while a worker runs stops the worker', async () => {
    const e = await engine({ steps: [SLOW_STEP] });
    const t = await e.addTicket(ticket());
    const realAppend = e.log.append.bind(e.log);
    vi.spyOn(e.log, 'append').mockImplementation((event) => (event.type === 'worker.init' ? Promise.reject(new Error('log blew up')) : realAppend(event)));

    await e.store.setTaskState(t.id, 'ready');
    await e.runner.begin(t.id);
    await e.runner.execute(t.id);

    const settled = await task(e, t.id);
    expect(settled.state).toBe('escalated');
    expect(settled.escalation_reason).toMatch(/log blew up/);
    const [a] = await e.store.listAttempts(t.id);
    expect(a).toMatchObject({ state: 'failed', failure_kind: 'engine_error' });
    expect(alive(a!.pid!)).toBe(false);
  });

  it('a worktree deleted before checks fails the attempt instead of hanging', async () => {
    const e = await engine({ steps: [okStep({ 'src/a.mjs': '' }, {}, { exitCode: 0 })] });
    const t = await e.addTicket(ticket());
    const unsubscribe = e.log.subscribe((event) => {
      if (event.type === 'task.state' && event.payload.to === 'checks') {
        const wt = worktreePath(e.paths, 'p', t.ticket_id, 1);
        rmSync(wt, { recursive: true, force: true });
      }
    });

    await runOnce(e, t.id);
    unsubscribe();

    const [a] = await e.store.listAttempts(t.id);
    expect(a).toMatchObject({ state: 'failed', failure_kind: 'engine_error' });
    expect((await task(e, t.id)).state).toBe('escalated');
  });

  it('runs checks under the read limits the worker has', async () => {
    const e = await engine({ steps: [okStep({ 'src/a.mjs': '' })], config: { maxAttempts: 1 } });
    const secret = join(e.paths.claudeHome, 'secret.txt');
    writeFileSync(secret, 'x');
    const t = await e.addTicket(ticket({ definition_of_done: [`cat ${secret}`] }));

    await runToSettled(e, t.id);

    const [a] = await e.store.listAttempts(t.id);
    expect(a).toMatchObject({ state: 'failed', failure_kind: 'check_failed' });
    expect(a!.failure_evidence).toMatch(/not permitted/);
  });

  it('caps large payloads in the event log but not the transcript', async () => {
    const huge = 'y'.repeat(100_000);
    const line = JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: huge }] } });
    const step = okStep({ 'src/a.mjs': '' });
    (step.lines as string[]).splice(1, 0, line);
    const e = await engine({ steps: [step] });
    const t = await e.addTicket(ticket());

    await runToSettled(e, t.id);

    const message = (await e.log.list({ taskId: t.id })).find((event) => event.type === 'worker.message');
    expect((message!.payload.text as string).length).toBe(4000);
    const [a] = await e.store.listAttempts(t.id);
    expect(readFileSync(transcriptPath(e.paths, 'p', a!.id), 'utf8')).toContain(huge);
  });

  it('caps strings nested inside a tool call', async () => {
    const huge = 'z'.repeat(10_000);
    const line = JSON.stringify({ type: 'assistant', message: { content: [{ type: 'tool_use', id: 't1', name: 'Write', input: { content: huge, nested: [{ deep: huge }] } }] } });
    const step = okStep({ 'src/a.mjs': '' });
    (step.lines as string[]).splice(1, 0, line);
    const e = await engine({ steps: [step] });
    const t = await e.addTicket(ticket());

    await runToSettled(e, t.id);

    const call = (await e.log.list({ taskId: t.id })).find((event) => event.type === 'worker.tool_call');
    const input = call!.payload.input as { content: string; nested: { deep: string }[] };
    expect(input.content.length).toBe(4000);
    expect(input.nested[0]!.deep.length).toBe(4000);
  });
});
