// M1 acceptance: the real claude binary and agent home on a throwaway repo. It makes real model calls, so run it
// outside any sandbox that blocks the network. With --hold the daemon stays up afterwards, so the UI can be checked.
import { execFile, spawn, type ChildProcess } from 'node:child_process';
import { existsSync, mkdtempSync, openSync, readdirSync, readFileSync, realpathSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig } from '../src/config.ts';
import type { EventRow } from '../src/events.ts';
import type { TaskManifest } from '../src/manifest/build.ts';
import { resolvePaths, transcriptPath } from '../src/paths.ts';
import { isolationViolations, type ClaudeInit } from '../src/setup/isolation.ts';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const TICKETS = join(ROOT, 'test/fixtures/tickets');

const REVIEW_TIMEOUT_MS = 10 * 60_000;
const INIT_TIMEOUT_MS = 2 * 60_000;
const START_TIMEOUT_MS = 30_000;
const WORKER_GONE_TIMEOUT_MS = 30_000;
const POLL_MS = 2000;
const MAX_USD = 3;
const MAX_CONTEXT_TOKENS = 12_000;
const MANIFEST_PARTS = ['charter', 'playbook', 'memory', 'task_inputs', 'output_contract', 'repo_instructions'];
const WORKER_TOOLS = ['Read', 'Glob', 'Grep', 'Edit', 'Write', 'Bash', 'StructuredOutput'];
const ENDED_TASK_STATES = ['escalated', 'cancelled', 'done'];

type Attempt = { id: number; k: number; state: string; pid: number | null; worktree_path: string; base_sha: string | null; failure_kind: string | null };
type Task = { id: number; ticket_id: string; state: string; escalation_reason: string | null; usdEst?: number | null };
type Details = { task: Task; attempts: Attempt[] };
type Json = Record<string, unknown>;

const paths = resolvePaths();
const { port } = loadConfig(paths);
const API = `http://127.0.0.1:${port}`;

const failures: string[] = [];
const scratch = mkdtempSync(join(realpathSync(tmpdir()), 'aiteam-smoke-'));
const repo = join(scratch, 'repo');
let daemon: ChildProcess | undefined;

function check(name: string, ok: boolean, detail = ''): boolean {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `: ${detail}` : ''}`);
  if (!ok) failures.push(name);
  return ok;
}

const note = (text: string) => console.log(`NOTE  ${text}`);
const seconds = (ms: number) => `${(ms / 1000).toFixed(1)}s`;
const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function run(binary: string, args: string[], cwd = ROOT): Promise<{ code: number; output: string }> {
  return new Promise((resolve) => {
    execFile(binary, args, { cwd }, (err, stdout, stderr) => {
      const code = err ? (typeof err.code === 'number' ? err.code : 1) : 0;
      resolve({ code, output: `${stdout}${stderr}`.trim() });
    });
  });
}

// Through node rather than the tsx command: that one is a parent process, and killing it would leave the daemon running.
const CLI = ['--import', 'tsx', 'src/cli.ts'];
const aiteam = (...args: string[]) => run(process.execPath, [...CLI, ...args]);

async function repoRev(ref: string): Promise<string> {
  const { code, output } = await run('git', ['rev-parse', '--verify', ref], repo);
  return code === 0 ? output : `no ${ref}`;
}

async function get<T>(path: string): Promise<T> {
  const res = await fetch(`${API}${path}`);
  if (!res.ok) throw new Error(`${path}: ${res.status} ${await res.text()}`);
  return (await res.json()) as T;
}

async function healthy(): Promise<boolean> {
  try {
    return (await fetch(`${API}/api/health`)).ok;
  } catch {
    return false;
  }
}

async function startDaemonProcess(): Promise<void> {
  const log = openSync(join(scratch, 'daemon.log'), 'a');
  const child = spawn(process.execPath, [...CLI, 'daemon'], { cwd: ROOT, stdio: ['ignore', log, log] });
  daemon = child;
  const deadline = Date.now() + START_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`The daemon exited with ${child.exitCode}. See ${join(scratch, 'daemon.log')}`);
    if (await healthy()) return;
    await pause(100);
  }
  throw new Error(`The daemon wasn't healthy within ${seconds(START_TIMEOUT_MS)}`);
}

function stopDaemonProcess(signal: NodeJS.Signals): Promise<void> {
  const child = daemon;
  if (!child || child.exitCode !== null || child.signalCode !== null) return Promise.resolve();
  return new Promise((resolve) => {
    child.once('exit', () => resolve());
    child.kill(signal);
  });
}

async function freeProjectName(): Promise<string> {
  // M1 has no way to delete a project, so a run after the first can't use the plain name.
  const taken = new Set((await get<{ name: string }[]>('/api/projects')).map((project) => project.name));
  let name = 'smoke';
  for (let n = 2; taken.has(name); n += 1) name = `smoke-${n}`;
  return name;
}

async function addTicket(project: string, file: string, ticketId: string): Promise<number> {
  const added = await aiteam('ticket', 'add', project, join(TICKETS, file));
  if (added.code !== 0) throw new Error(`ticket add ${file}: ${added.output}`);
  const tasks = await get<Task[]>(`/api/tasks?project=${encodeURIComponent(project)}`);
  const task = tasks.find((candidate) => candidate.ticket_id === ticketId);
  if (!task) throw new Error(`${ticketId} is not listed in ${project}`);
  return task.id;
}

async function waitForReview(taskId: number): Promise<Details> {
  const deadline = Date.now() + REVIEW_TIMEOUT_MS;
  for (;;) {
    const details = await get<Details>(`/api/tasks/${taskId}`);
    const { state } = details.task;
    if (state === 'review' || ENDED_TASK_STATES.includes(state) || Date.now() > deadline) return details;
    await pause(POLL_MS);
  }
}

// The stream never ends by itself, so this reads until it has seen what it came for.
async function readEvents(taskId: number, enough: (events: EventRow[]) => boolean, timeoutMs: number): Promise<EventRow[]> {
  const events: EventRow[] = [];
  const res = await fetch(`${API}/api/tasks/${taskId}/events`, { signal: AbortSignal.timeout(timeoutMs) });
  if (!res.body) throw new Error(`The events of task ${taskId} have no body`);
  const reader = res.body.pipeThrough(new TextDecoderStream()).getReader();
  let buffer = '';
  try {
    while (!enough(events)) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += value;
      const frames = buffer.split('\n\n');
      buffer = frames.pop() ?? '';
      for (const frame of frames) {
        const data = frame.split('\n').find((line) => line.startsWith('data: '));
        if (data) events.push(JSON.parse(data.slice('data: '.length)) as EventRow);
      }
    }
  } catch (err) {
    if (!(err instanceof Error && err.name === 'TimeoutError')) throw err;
  } finally {
    await reader.cancel().catch(() => {});
  }
  return events;
}

const reachedReview = (events: EventRow[]) => events.some((event) => event.type === 'task.state' && event.payload.to === 'review');
const workerStarted = (events: EventRow[]) => events.some((event) => event.type === 'worker.init');

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

function userConfigNames(): string[] {
  const names: string[] = [];
  for (const dir of ['skills', 'agents', 'commands']) {
    const full = join(homedir(), '.claude', dir);
    if (existsSync(full)) names.push(...readdirSync(full).map((name) => name.replace(/\.md$/, '')));
  }
  return names;
}

function workerViolations(project: string, attemptId: number): string[] {
  const path = transcriptPath(paths, project, attemptId);
  if (!existsSync(path)) return ['no_transcript'];
  const records = readFileSync(path, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line) as Json);
  const init = records.find((record) => record.type === 'system' && record.subtype === 'init') as ClaudeInit | undefined;
  if (!init) return ['no_init'];
  return isolationViolations(init, {
    agentHome: paths.claudeHome,
    allowedTools: WORKER_TOOLS,
    userSkillNames: userConfigNames(),
    hookEventsSeen: records.some((record) => record.type === 'system' && typeof record.subtype === 'string' && record.subtype.startsWith('hook_')),
  });
}

async function firstTicket(project: string, base: string, baseBefore: string): Promise<boolean> {
  const taskId = await addTicket(project, 'T-SMOKE-1.md', 'T-SMOKE-1');
  note(`T-SMOKE-1 is task ${taskId}: ${API}/tasks/${taskId}`);

  const started = Date.now();
  const { task, attempts } = await waitForReview(taskId);
  if (!check('T-SMOKE-1 reaches review within 10 minutes', task.state === 'review', `${task.state} after ${seconds(Date.now() - started)}, ${task.escalation_reason ?? 'no escalation'}`)) return false;

  const attempt = attempts.at(-1)!;
  note(`T-SMOKE-1 attempts: ${attempts.map((a) => `a${a.k}=id ${a.id} ${a.state}`).join(', ')}`);

  check('The worktree is the attempt\'s own', attempt.worktree_path.endsWith(`/worktrees/${project}/T-SMOKE-1-a${attempt.k}`), attempt.worktree_path);
  const integration = await repoRev('aiteam/m1');
  check('The attempt is based on aiteam/m1', attempt.base_sha === integration, `base_sha ${String(attempt.base_sha)}, aiteam/m1 ${integration}`);

  const manifest = await get<TaskManifest>(`/api/attempts/${attempt.id}/manifest`);
  const names = manifest.parts.map((part) => part.name as string);
  check('The manifest has every part', MANIFEST_PARTS.every((name) => names.includes(name)), names.join(', '));
  check('The manifest is within its context budget', manifest.totalTokens <= MAX_CONTEXT_TOKENS, `${manifest.totalTokens} of ${MAX_CONTEXT_TOKENS}`);
  check('The flags include --strict-mcp-config', manifest.flags?.includes('--strict-mcp-config') === true);

  const violations = workerViolations(project, attempt.id);
  check('isolationViolations is empty', violations.length === 0, violations.join(', '));

  const events = await readEvents(taskId, reachedReview, 10_000);
  const command = 'node --test src/add.test.mjs';
  const finished = events.filter((event) => event.type === 'check.finished' && event.payload.command === command && event.attemptId === attempt.id);
  check(`${command} exits 0`, finished.length === 1 && finished[0]?.payload.exitCode === 0, JSON.stringify(finished.map((event) => event.payload.exitCode)));

  const listed = await get<Task[]>(`/api/tasks?project=${encodeURIComponent(project)}`);
  const usd = listed.find((candidate) => candidate.id === taskId)?.usdEst;
  check(`T-SMOKE-1's estimate is at most $${MAX_USD}`, typeof usd === 'number' && usd <= MAX_USD, `$${String(usd)}`);

  check('The base branch has not moved', (await repoRev(base)) === baseBefore, base);
  const status = await run('git', ['status', '--porcelain'], repo);
  check('The repo\'s checkout is untouched', status.code === 0 && status.output === '', status.output);
  return true;
}

async function crashDrill(project: string): Promise<void> {
  const taskId = await addTicket(project, 'T-SMOKE-2.md', 'T-SMOKE-2');
  note(`T-SMOKE-2 is task ${taskId}: ${API}/tasks/${taskId}`);

  const seen = await readEvents(taskId, workerStarted, INIT_TIMEOUT_MS);
  if (!check('T-SMOKE-2 reaches worker.init', workerStarted(seen))) return;

  const { attempts: before } = await get<Details>(`/api/tasks/${taskId}`);
  const first = before[0];
  if (!check('The first attempt has a live pid', first?.pid !== null && first?.pid !== undefined && pidAlive(first.pid), String(first?.pid))) return;
  const pid = first!.pid!;

  const killedAt = Date.now();
  await stopDaemonProcess('SIGKILL');
  note(`Worker ${pid} ${pidAlive(pid) ? 'outlived' : 'died with'} the killed daemon`);

  await startDaemonProcess();
  note(`Daemon healthy again ${seconds(Date.now() - killedAt)} after SIGKILL`);

  const deadline = Date.now() + WORKER_GONE_TIMEOUT_MS;
  while (pidAlive(pid) && Date.now() < deadline) await pause(100);
  check('The old worker\'s pid is gone', !pidAlive(pid), `${seconds(Date.now() - killedAt)} after SIGKILL`);

  const { task, attempts } = await waitForReview(taskId);
  note(`T-SMOKE-2 attempts: ${attempts.map((a) => `a${a.k}=id ${a.id} ${a.state}`).join(', ')}`);
  note(`T-SMOKE-2 settled ${seconds(Date.now() - killedAt)} after SIGKILL`);
  check('a1 is interrupted', attempts[0]?.state === 'interrupted', attempts[0]?.state);
  check('a2 reaches review', task.state === 'review' && attempts[1]?.state === 'succeeded', `${task.state}, ${task.escalation_reason ?? 'no escalation'}, a2 ${attempts[1]?.state}`);
  check('a2 has a different worktree', attempts[1] !== undefined && attempts[1].worktree_path !== attempts[0]?.worktree_path && attempts[1].worktree_path.endsWith(`/T-SMOKE-2-a${attempts[1].k}`), attempts[1]?.worktree_path);
}

async function main(): Promise<void> {
  // The API would still answer an old daemon's questions, and this run's checks would pass against it.
  if (await healthy()) throw new Error(`Something already answers on ${API}. Stop it first.`);

  const setup = await aiteam('setup');
  if (setup.code !== 0) throw new Error(`setup: ${setup.output}`);
  const doctor = await aiteam('doctor');
  const failing = doctor.output.split('\n').filter((line) => line.startsWith('FAIL'));
  if (!check('doctor has no failing checks', doctor.code === 0, failing.join('; '))) return;

  await startDaemonProcess();
  const project = await freeProjectName();
  const added = await aiteam('project', 'add', project, repo, '--create');
  if (added.code !== 0) throw new Error(`project add: ${added.output}`);
  const { base_branch: base } = (await get<{ name: string; base_branch: string }[]>('/api/projects')).find((candidate) => candidate.name === project)!;
  const baseBefore = await repoRev(base);
  note(`Project ${project} on ${repo}, base branch ${base}`);

  if (await firstTicket(project, base, baseBefore)) await crashDrill(project);

  const listed = await get<Task[]>(`/api/tasks?project=${encodeURIComponent(project)}`);
  const total = listed.reduce((sum, task) => sum + (task.usdEst ?? 0), 0);
  // An interrupted attempt never reports its cost, so this leaves out what a1 of T-SMOKE-2 spent.
  note(`Estimated spend: $${total.toFixed(4)}`);

  if (process.argv.includes('--hold')) {
    console.log(`HOLDING  ${failures.length} failed. The daemon stays up on ${API} until this process is stopped.`);
    await new Promise<void>((resolve) => {
      process.once('SIGINT', resolve);
      process.once('SIGTERM', resolve);
    });
  }
}

main()
  .catch((err: unknown) => {
    check('The run finished', false, err instanceof Error ? err.message : String(err));
  })
  .finally(async () => {
    await stopDaemonProcess('SIGTERM');
    note(`Left for inspection: ${scratch}`);
    console.log(failures.length === 0 ? 'M1 ACCEPTANCE PASS' : `M1 ACCEPTANCE FAIL: ${failures.join('; ')}`);
    process.exitCode = failures.length === 0 ? 0 : 1;
  });
