import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse as parseYaml } from 'yaml';
import { applyDiscovery } from '../src/engine/apply/discovery.ts';
import type { AttemptRow, NewTask, ProjectRow, TaskRow } from '../src/engine/store.ts';
import type { WorkOrder } from '../src/engine/workorder.ts';
import type { TaskManifest } from '../src/manifest/build.ts';
import { manifestDir, stateRepoDir, transcriptPath, worktreePath } from '../src/paths.ts';
import { eventTypes, makeEngine, okStep, resultLine, runOnce, runToSettled, ticket, until, type TestEngine } from './helpers/engine.ts';
import { commitAll, revParse, run, tempDir } from './helpers/repo.ts';

// One purpose stands in for all of them: what the runner does with an applier's answer doesn't depend on which it was.
vi.mock('../src/engine/apply/discovery.ts', () => ({ applyDiscovery: vi.fn() }));
const applier = vi.mocked(applyDiscovery);

const INIT = JSON.stringify({ type: 'system', subtype: 'init', session_id: 's', model: 'm' });
const SLOW_STEP = { lines: [INIT], delayMs: 120_000 };
const DISCOVERY = { roadmap: { body: '# Roadmap\n', milestones: [] }, team_proposal: { body: 'Team' }, human_requirements: { body: 'Needs' }, stakeholder_note: 'Note' };
const discoveryStep = (files: Record<string, string> = {}) => ({ writeFiles: files, lines: [INIT, resultLine({ structured_output: DISCOVERY })] });
const roadmapChange = (body = '# Roadmap\n') => ({
  message: 'publish the roadmap',
  publish: [{ id: 'ROADMAP', type: 'roadmap' as const, status: 'proposed' as const, ownerRole: 'pm', derivedFrom: [], body }],
});

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
  const projectOf = async (e: TestEngine): Promise<ProjectRow> => (await e.store.getProject('p'))!;
  const taskText = (e: TestEngine, ticketId: string, k: number) => readFileSync(join(manifestDir(e.paths, 'p', ticketId, k), 'task.md'), 'utf8');

  beforeEach(() => {
    applier.mockReset();
  });

  async function orderTask(e: TestEngine, order: Partial<WorkOrder> = {}, fields: Partial<NewTask> = {}): Promise<TaskRow> {
    const project = await projectOf(e);
    return e.store.createTask({
      project_id: project.id,
      ticket_id: 'DISCOVERY',
      title: 'Discovery',
      milestone: 1,
      role_id: 'pm',
      ticket_path: '',
      ticket_sha: '',
      touches: [],
      depends_on: [],
      dod: [],
      kind: 'authoring',
      purpose: 'discovery',
      work_order: { purpose: 'discovery', instructions: 'Write the roadmap: order-instructions-marker', inputs: [], checks: [], base: { kind: 'base' }, ...order },
      ...fields,
    });
  }

  async function publishBrief(e: TestEngine, body = 'brief-content-marker\n'): Promise<void> {
    await e.artifacts.commit(await projectOf(e), {
      message: 'brief',
      publish: [{ id: 'BRIEF', type: 'brief', status: 'approved', ownerRole: 'stakeholder', derivedFrom: [], body, approvedBy: 'stakeholder' }],
    });
  }

  async function publishProfile(e: TestEngine, status: 'proposed' | 'approved', data: { network_allow: string[]; setup: string | null }): Promise<void> {
    await e.artifacts.commit(await projectOf(e), {
      message: 'profile',
      publish: [{ id: 'ENV-PROFILE', type: 'environment_profile', status, ownerRole: 'tech_lead', derivedFrom: [], body: '# Profile\n', fields: { data } }],
    });
  }
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

  it('a login failure leaves all three attempts for after the person has logged in and retried', async () => {
    const e = await engine({ steps: [{ fixture: 'auth-failed.jsonl', exitCode: 1 }, okStep({ 'src/a.mjs': '' })] });
    const t = await e.addTicket(ticket({ definition_of_done: ['false'] }));
    await runToSettled(e, t.id);
    expect(e.spawnCount()).toBe(1);

    await e.runner.retry(t.id);
    await runToSettled(e, t.id);

    expect(await task(e, t.id)).toMatchObject({ state: 'escalated', escalation_reason: 'attempts_exhausted' });
    expect(e.spawnCount()).toBe(4);
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

  describe('tickets', () => {
    it('publishes the Change Report and records head_sha when checks pass', async () => {
      const e = await engine({ steps: [okStep({ 'src/a.mjs': '' }, { summary: 'did-the-work-marker', files_changed: ['src/a.mjs'] })] });
      const t = await e.addTicket(ticket());

      await runOnce(e, t.id);

      const [a] = await e.store.listAttempts(t.id);
      expect(await task(e, t.id)).toMatchObject({ state: 'review' });
      expect(a).toMatchObject({ state: 'succeeded', head_sha: run(a!.worktree_path, 'rev-parse', 'HEAD') });
      expect(a!.head_sha).not.toBe(a!.base_sha);
      expect(existsSync(a!.worktree_path)).toBe(true);

      const project = await projectOf(e);
      expect(await e.artifacts.latest(project.id, 'CHANGE-T-1-a1')).toMatchObject({
        type: 'change_report',
        version: 1,
        status: 'approved',
        approved_by: 'owner:engineer',
        derived_from: [],
      });
      const doc = await e.artifacts.read(project, 'CHANGE-T-1-a1');
      expect(doc.body).toContain('did-the-work-marker');
      expect(doc.body).toContain('src/a.mjs');
    });

    it('derives the Change Report from the ticket when the ticket has a version', async () => {
      const e = await engine({ steps: [okStep({ 'src/a.mjs': '' })] });
      const t = await e.addTicket(ticket());
      const { id: _id, ...fields } = parseYaml(ticket().split('---\n')[1]!) as Record<string, unknown>;
      await e.artifacts.commit(await projectOf(e), {
        message: 'ticket',
        publish: [{ id: 'T-1', type: 'ticket', status: 'approved', ownerRole: 'tech_lead', derivedFrom: [], body: 'Do it.\n', approvedBy: 'owner:tech_lead', fields }],
      });

      await runOnce(e, t.id);

      expect(await e.artifacts.latest((await projectOf(e)).id, 'CHANGE-T-1-a1')).toMatchObject({ derived_from: ['T-1@1'] });
    });

    it('hands a ticket its pinned inputs', async () => {
      const e = await engine({ steps: [okStep({ 'src/a.mjs': '' })] });
      await publishBrief(e);
      const t = await e.addTicket(ticket({ inputs: ['BRIEF@1'] }));

      await runOnce(e, t.id);

      expect(taskText(e, t.ticket_id, 1)).toContain('brief-content-marker');
    });

    it('leaves task and attempt untouched in SQLite when the publish fails', async () => {
      const e = await engine({ steps: [okStep({ 'src/a.mjs': '' })] });
      const t = await e.addTicket(ticket());
      // A file where the report's folder has to go makes the git half of the publish fail.
      const blocked = join(stateRepoDir(e.paths, 'p'), 'artifacts');
      execFileSync('mkdir', ['-p', blocked]);
      writeFileSync(join(blocked, 'change_report'), 'in the way');

      await runOnce(e, t.id);

      const [a] = await e.store.listAttempts(t.id);
      expect(a).toMatchObject({ state: 'failed', failure_kind: 'engine_error', head_sha: null });
      expect(await task(e, t.id)).toMatchObject({ state: 'escalated' });
      expect((await task(e, t.id)).escalation_reason).toMatch(/^engine_error: /);
      expect(await e.artifacts.latest((await projectOf(e)).id, 'CHANGE-T-1-a1')).toBeUndefined();
      expect(await e.store.failedAttemptCount(t.id)).toBe(0);
    });
  });

  describe('tasks with a work order', () => {
    it('finishes an authoring task from checks to done when its output applies', async () => {
      const e = await engine({ steps: [discoveryStep()] });
      const t = await orderTask(e);
      let stateDuringApply: string | undefined;
      applier.mockImplementation(async (ctx) => {
        stateDuringApply = (await ctx.deps.store.getTask(ctx.task.id))?.state;
        expect(ctx.output).toEqual(DISCOVERY);
        return { ok: true, change: roadmapChange(), after: async (s) => void (await s.setProjectPhase(ctx.project.id, 'discovery')) };
      });

      await runOnce(e, t.id);

      expect(stateDuringApply).toBe('checks');
      expect(await task(e, t.id)).toMatchObject({ state: 'done' });
      const [a] = await e.store.listAttempts(t.id);
      expect(a).toMatchObject({ state: 'succeeded', failure_kind: null });
      expect(existsSync(a!.worktree_path)).toBe(false);
      expect(a!.worktree_removed_at).not.toBeNull();

      const project = await projectOf(e);
      expect(project.phase).toBe('discovery');
      expect(await e.artifacts.latest(project.id, 'ROADMAP')).toMatchObject({ status: 'proposed', version: 1 });
    });

    it("gives the worker the order's instructions, inputs and role schema", async () => {
      const e = await engine({ steps: [discoveryStep()] });
      await publishBrief(e);
      const t = await orderTask(e, { inputs: ['BRIEF@1'], comment: 'stakeholder-comment-marker' });
      applier.mockResolvedValue({ ok: true, change: roadmapChange() });

      await runOnce(e, t.id);

      const text = taskText(e, 'DISCOVERY', 1);
      expect(text).toContain('order-instructions-marker');
      expect(text).toContain('brief-content-marker');
      expect(text).toContain('stakeholder-comment-marker');
      const [a] = await e.store.listAttempts(t.id);
      const manifest = a!.manifest as TaskManifest;
      expect(manifest.roleId).toBe('pm');
      expect((manifest.outputSchema as { title: string }).title).toBe('Discovery');
    });

    it('ignores files an authoring worker changed', async () => {
      const e = await engine({ steps: [discoveryStep({ 'src/sneaky.mjs': 'written by a read-only role' })] });
      const t = await orderTask(e);
      applier.mockResolvedValue({ ok: true, change: roadmapChange() });
      const commitsBefore = run(e.repoPath, 'rev-list', '--all', '--count');

      await runOnce(e, t.id);

      expect(await task(e, t.id)).toMatchObject({ state: 'done' });
      expect(run(e.repoPath, 'rev-list', '--all', '--count')).toBe(commitsBefore);
      expect(existsSync(join(e.repoPath, 'src/sneaky.mjs'))).toBe(false);
    });

    it('retries an authoring task with the applier evidence when output does not apply', async () => {
      const e = await engine({ steps: [discoveryStep(), discoveryStep()] });
      const t = await orderTask(e);
      applier.mockResolvedValueOnce({ ok: false, evidence: 'milestones have a gap: applier-evidence-marker' });
      applier.mockResolvedValueOnce({ ok: true, change: roadmapChange() });

      await runToSettled(e, t.id);

      const [a1, a2] = await e.store.listAttempts(t.id);
      expect(a1).toMatchObject({ state: 'invalid_output', failure_kind: 'invalid_output' });
      expect(String(a1!.failure_evidence)).toContain('applier-evidence-marker');
      expect(a2).toMatchObject({ state: 'succeeded', k: 2 });
      expect(a2!.worktree_path).not.toBe(a1!.worktree_path);
      expect(taskText(e, 'DISCOVERY', 2)).toContain('applier-evidence-marker');
      expect(await task(e, t.id)).toMatchObject({ state: 'done' });
    });

    it('escalates an authoring task after three invalid outputs', async () => {
      const e = await engine({ steps: [discoveryStep()] });
      const t = await orderTask(e);
      applier.mockResolvedValue({ ok: false, evidence: 'still wrong' });

      await runToSettled(e, t.id);

      expect(await task(e, t.id)).toMatchObject({ state: 'escalated', escalation_reason: 'attempts_exhausted' });
      expect(e.spawnCount()).toBe(3);
      expect(await e.artifacts.latest((await projectOf(e)).id, 'ROADMAP')).toBeUndefined();
    });

    it('does not count an applier crash as a failed attempt', async () => {
      const e = await engine({ steps: [discoveryStep()] });
      const t = await orderTask(e);
      applier.mockRejectedValue(new Error('applier-crash-marker'));

      await runOnce(e, t.id);

      expect(await task(e, t.id)).toMatchObject({ state: 'escalated' });
      expect((await task(e, t.id)).escalation_reason).toContain('engine_error: applier-crash-marker');
      expect((await e.store.listAttempts(t.id))[0]).toMatchObject({ state: 'failed', failure_kind: 'engine_error' });
      expect(await e.store.failedAttemptCount(t.id)).toBe(0);
    });

    it("rolls the publish back when the applier's after fails", async () => {
      const e = await engine({ steps: [discoveryStep()] });
      const t = await orderTask(e);
      applier.mockResolvedValue({
        ok: true,
        change: roadmapChange(),
        after: async () => {
          throw new Error('then-crash-marker');
        },
      });

      await runOnce(e, t.id);

      expect(await e.artifacts.latest((await projectOf(e)).id, 'ROADMAP')).toBeUndefined();
      expect(await task(e, t.id)).toMatchObject({ state: 'escalated' });
      expect((await task(e, t.id)).escalation_reason).toContain('then-crash-marker');
      expect((await e.store.listAttempts(t.id))[0]).toMatchObject({ state: 'failed', failure_kind: 'engine_error' });
    });

    it('cancel stops an applier that is still running and publishes nothing', async () => {
      const e = await engine({ steps: [discoveryStep()] });
      const t = await orderTask(e);
      applier.mockImplementation(async (ctx) => {
        await new Promise((resolve) => ctx.signal.addEventListener('abort', resolve, { once: true }));
        return { ok: true, change: roadmapChange() };
      });

      await e.store.setTaskState(t.id, 'ready');
      await e.runner.begin(t.id);
      const running = e.runner.execute(t.id);
      await until(async () => (await task(e, t.id)).state === 'checks' && applier.mock.calls.length === 1);

      await e.runner.cancel(t.id);
      await running;

      expect(await task(e, t.id)).toMatchObject({ state: 'cancelled' });
      expect((await e.store.listAttempts(t.id))[0]).toMatchObject({ state: 'cancelled' });
      expect(await e.artifacts.latest((await projectOf(e)).id, 'ROADMAP')).toBeUndefined();
    });

    it.each([
      ['base', 'main head'],
      ['integration', 'milestone branch head'],
    ] as const)('starts a %s order from the %s', async (kind, _from) => {
      const e = await engine({ steps: [discoveryStep()] });
      const main = await revParse(e.repoPath, 'HEAD');
      // The milestone branch moves ahead of main, so the two bases differ.
      run(e.repoPath, 'branch', 'aiteam/m1');
      const scratch = join(tempDir(), 'wt');
      run(e.repoPath, 'worktree', 'add', '--quiet', scratch, 'aiteam/m1');
      writeFileSync(join(scratch, 'ahead.txt'), 'ahead');
      commitAll(scratch, 'ahead of main');
      const integration = await revParse(scratch, 'HEAD');
      const t = await orderTask(e, { base: { kind } });
      applier.mockResolvedValue({ ok: true, change: roadmapChange() });

      await runOnce(e, t.id);

      expect((await e.store.listAttempts(t.id))[0]!.base_sha).toBe(kind === 'base' ? main : integration);
    });

    it('starts a review attempt at the commit it reviews', async () => {
      const e = await engine({
        steps: [okStep({ 'src/a.mjs': 'reviewed-content-marker\n' }), { lines: [INIT, resultLine({ structured_output: { verdict: 'approve', summary: 'Fine', findings: [] } })] }],
      });
      const t = await e.addTicket(ticket());
      await runOnce(e, t.id);
      const [engineered] = await e.store.listAttempts(t.id);
      const sha = engineered!.head_sha!;

      const review = await orderTask(
        e,
        { purpose: 'code_review', instructions: 'Review it.', base: { kind: 'sha', sha }, subject: { ticketTaskId: t.id, attemptId: engineered!.id } },
        { ticket_id: 'REVIEW-T-1', role_id: 'code_reviewer', kind: 'code_review', purpose: 'code_review', milestone: t.milestone },
      );
      await runOnce(e, review.id);

      expect((await e.store.listAttempts(review.id))[0]!.base_sha).toBe(sha);
      expect(taskText(e, 'REVIEW-T-1', 1)).toContain('+reviewed-content-marker');
    });
  });

  describe('rejectFromReview', () => {
    it('rejectFromReview sends a ticket back to ready and hands the evidence to the next attempt', async () => {
      const e = await engine({ steps: [okStep({ 'src/a.mjs': '' }), okStep({ 'src/b.mjs': '' })] });
      const t = await e.addTicket(ticket());
      await runOnce(e, t.id);

      await e.runner.rejectFromReview(t.id, 'changes_requested', 'reviewer-says-marker');

      expect(await task(e, t.id)).toMatchObject({ state: 'ready' });
      const [a1] = await e.store.listAttempts(t.id);
      expect(a1).toMatchObject({ state: 'succeeded', failure_kind: 'changes_requested', failure_evidence: 'reviewer-says-marker' });
      expect(existsSync(a1!.worktree_path)).toBe(false);
      expect(a1!.worktree_removed_at).not.toBeNull();
      expect(await e.store.failedAttemptCount(t.id)).toBe(1);

      await runOnce(e, t.id);

      expect(taskText(e, t.ticket_id, 2)).toContain('reviewer-says-marker');
      expect(await task(e, t.id)).toMatchObject({ state: 'review' });
    });

    it('rejectFromReview escalates at the attempt cap', async () => {
      const e = await engine({ steps: [okStep({ 'src/a.mjs': '' })] });
      const t = await e.addTicket(ticket());

      for (const kind of ['changes_requested', 'merge_conflict'] as const) {
        await runOnce(e, t.id);
        await e.runner.rejectFromReview(t.id, kind, 'not yet');
        expect(await task(e, t.id)).toMatchObject({ state: 'ready' });
      }
      await runOnce(e, t.id);
      await e.runner.rejectFromReview(t.id, 'changes_requested', 'still not');

      expect(await task(e, t.id)).toMatchObject({ state: 'escalated', escalation_reason: 'attempts_exhausted' });
    });

    it('refuses a task with no attempt', async () => {
      const e = await engine({ steps: [] });
      const t = await e.addTicket(ticket());

      await expect(e.runner.rejectFromReview(t.id, 'changes_requested', 'x')).rejects.toThrow(/no attempt/);
    });
  });

  describe('environment profile', () => {
    const domains = (a: AttemptRow) => {
      const flags = (a.manifest as TaskManifest).flags!;
      return (JSON.parse(flags[flags.indexOf('--settings') + 1]!) as { sandbox: { network: { allowedDomains: string[] } } }).sandbox.network.allowedDomains;
    };

    it('runs the approved setup in the fresh worktree and allows its domains', async () => {
      const e = await engine({ steps: [okStep({ 'src/a.mjs': '' })] });
      await publishProfile(e, 'approved', { network_allow: ['registry.npmjs.org'], setup: 'mkdir -p src && echo done > src/from-setup.txt' });
      const t = await e.addTicket(ticket());

      await runOnce(e, t.id);

      const [a] = await e.store.listAttempts(t.id);
      expect(readFileSync(join(a!.worktree_path, 'src/from-setup.txt'), 'utf8')).toBe('done\n');
      expect(domains(a!)).toEqual(['registry.npmjs.org']);
      expect(await eventTypes(e, t.id)).toContain('check.started');
    });

    it('has neither until the profile is approved', async () => {
      const e = await engine({ steps: [okStep({ 'src/a.mjs': '' })] });
      await publishProfile(e, 'proposed', { network_allow: ['registry.npmjs.org'], setup: 'false' });
      const t = await e.addTicket(ticket());

      await runOnce(e, t.id);

      const [a] = await e.store.listAttempts(t.id);
      expect(a).toMatchObject({ state: 'succeeded' });
      expect(domains(a!)).toEqual([]);
    });

    it('fails the attempt without starting a worker when setup fails', async () => {
      const e = await engine({ steps: [okStep({ 'src/a.mjs': '' })] });
      await publishProfile(e, 'approved', { network_allow: [], setup: 'echo setup-output-marker; exit 7' });
      const t = await e.addTicket(ticket());

      await runOnce(e, t.id);

      const [a] = await e.store.listAttempts(t.id);
      expect(a).toMatchObject({ state: 'failed', failure_kind: 'check_failed' });
      expect(String(a!.failure_evidence)).toContain('setup-output-marker');
      expect(e.spawnCount()).toBe(0);
      expect(await task(e, t.id)).toMatchObject({ state: 'ready' });
      expect(await e.store.failedAttemptCount(t.id)).toBe(1);
    });

    it('runs no setup for an authoring task', async () => {
      const e = await engine({ steps: [discoveryStep()] });
      await publishProfile(e, 'approved', { network_allow: ['example.com'], setup: 'false' });
      const t = await orderTask(e);
      applier.mockResolvedValue({ ok: true, change: roadmapChange() });

      await runOnce(e, t.id);

      expect(await task(e, t.id)).toMatchObject({ state: 'done' });
    });
  });

});
