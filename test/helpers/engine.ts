import { once } from 'node:events';
import { chmodSync, existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { stringify } from 'yaml';
import { ClaudeCodeAdapter } from '../../src/adapters/claude-code.ts';
import { ArtifactStore } from '../../src/artifacts/store.ts';
import { DEFAULT_CONFIG, type Config } from '../../src/config.ts';
import { openDb } from '../../src/db/open.ts';
import { Conductor } from '../../src/engine/conductor/index.ts';
import { addProject, addTicket } from '../../src/engine/intake.ts';
import { renderMustSupport, type MsItem } from '../../src/engine/must-support.ts';
import { recover } from '../../src/engine/recovery.ts';
import { Runner, type EngineDeps } from '../../src/engine/runner.ts';
import { Scheduler } from '../../src/engine/scheduler.ts';
import { Store, type ProjectRow, type TaskRow } from '../../src/engine/store.ts';
import { EventLog } from '../../src/events.ts';
import { resolvePaths, workerDenyRead } from '../../src/paths.ts';
import { runSetup } from '../../src/setup/setup.ts';
import { makeRepo, tempDir } from './repo.ts';

const fakeClaude = fileURLToPath(new URL('../fixtures/fake-claude.mjs', import.meta.url));
chmodSync(fakeClaude, 0o755);

export type TestEngine = EngineDeps & {
  runner: Runner;
  repoPath: string;
  spawnCount(): number;
  spawns(): { argv: string[]; cwd: string; pid: number }[];
  addTicket(markdown: string): Promise<TaskRow>;
  cleanup(): Promise<void>;
};

const SETTLED = ['review', 'done', 'escalated', 'cancelled'];

export async function makeEngine(opts: {
  steps: unknown[] | { byTask: Record<string, unknown> };
  config?: Partial<Config>;
  env?: Record<string, string>;
  now?: () => Date;
}): Promise<TestEngine> {
  const root = tempDir('aiteam-home-');
  const paths = resolvePaths({ AITEAM_HOME: join(root, 'home') });
  await runSetup(paths);

  const db = await openDb(paths.db);
  const log = new EventLog(db);
  const store = new Store(db, log);
  const config: Config = { ...DEFAULT_CONFIG, cancelGraceS: 2, ...opts.config };

  const script = join(root, 'script.json');
  const spawnLog = join(root, 'spawns.log');
  writeFileSync(script, JSON.stringify(opts.steps));

  const adapter = new ClaudeCodeAdapter({
    binary: fakeClaude,
    agentHome: paths.claudeHome,
    mode: 'subscription',
    denyRead: workerDenyRead(paths, homedir()),
    graceS: config.cancelGraceS,
    timeoutS: config.attemptTimeoutS,
    extraEnv: { FAKE_SCRIPT: script, FAKE_SPAWN_LOG: spawnLog, ...opts.env },
  });

  const repo = await makeRepo();
  await addProject({ store, paths }, { name: 'p', repoPath: repo.path, create: false });

  const deps: EngineDeps = { db, store, log, paths, config, adapters: { [adapter.id]: adapter }, artifacts: new ArtifactStore(store, paths), ...(opts.now ? { now: opts.now } : {}) };
  const runner = new Runner(deps);
  const spawnLines = () => (existsSync(spawnLog) ? readFileSync(spawnLog, 'utf8').trim().split('\n').filter(Boolean) : []);

  return {
    ...deps,
    runner,
    repoPath: repo.path,
    spawnCount: () => spawnLines().length,
    spawns: () => spawnLines().map((line) => JSON.parse(line) as { argv: string[]; cwd: string; pid: number }),
    addTicket: (markdown) => addTicket({ store, paths }, 'p', markdown),
    cleanup: async () => {
      await runner.shutdown();
      await db.destroy();
      rmSync(root, { recursive: true, force: true });
      rmSync(repo.path, { recursive: true, force: true });
    },
  };
}

export type ProjectEngine = TestEngine & {
  drive(condition: () => Promise<boolean>): Promise<void>;
  // What a daemon does when it stops, then what the next one does when it starts. Use what this returns from then on.
  restart(): Promise<ProjectEngine>;
};

const DRIVE_MS = 30_000;

async function whereThingsAre(e: TestEngine): Promise<string> {
  const tasks = (await e.store.listTasks()).map((task) => `${task.ticket_id}: ${task.state}${task.escalation_reason ? ` (${task.escalation_reason})` : ''}`);
  const asks = (await e.store.listInbox({ state: 'pending' })).map((item) => `${item.title}: ${item.why}`);
  return [...tasks, ...asks].join('\n');
}

function driven(e: TestEngine): ProjectEngine {
  const scheduler = new Scheduler(e, e.runner, new Conductor(e, e.runner));
  return {
    ...e,
    drive: async (condition) => {
      const deadline = Date.now() + DRIVE_MS;
      while (!(await condition())) {
        if (Date.now() > deadline) throw new Error(`The condition was not met in time. Where things are:\n${await whereThingsAre(e)}`);
        await scheduler.tick();
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
    },
    restart: async () => {
      await scheduler.stop();
      await e.runner.shutdown();
      await e.db.destroy();

      const db = await openDb(e.paths.db);
      const log = new EventLog(db);
      const store = new Store(db, log);
      const deps: EngineDeps = { db, store, log, paths: e.paths, config: e.config, adapters: e.adapters, artifacts: new ArtifactStore(store, e.paths) };
      const runner = new Runner(deps);
      await recover(deps);
      return driven({
        ...e,
        ...deps,
        runner,
        addTicket: (markdown) => addTicket({ store, paths: e.paths }, 'p', markdown),
        cleanup: async () => {
          await runner.shutdown();
          await db.destroy();
          await e.cleanup();
        },
      });
    },
    cleanup: async () => {
      await scheduler.stop();
      await e.cleanup();
    },
  };
}

// The whole engine with nothing to answer its Inbox: a test answers it through the API, and only drive moves things along.
export async function makeProjectEngine(opts: { byTask: Record<string, unknown>; config?: Partial<Config> }): Promise<ProjectEngine> {
  return driven(await makeEngine({ steps: { byTask: opts.byTask }, ...(opts.config ? { config: opts.config } : {}) }));
}

// One attempt: the scheduler's job in production. A task comes back ready to go again, or settled.
export async function runOnce(e: TestEngine, taskId: number): Promise<void> {
  const task = await e.store.getTask(taskId);
  if (task?.state === 'queued') await e.store.setTaskState(taskId, 'ready');
  await e.runner.begin(taskId);
  await e.runner.execute(taskId);
}

export async function runToSettled(e: TestEngine, taskId: number): Promise<void> {
  for (let i = 0; i < 20; i += 1) {
    await runOnce(e, taskId);
    const task = await e.store.getTask(taskId);
    if (task && SETTLED.includes(task.state)) return;
  }
  throw new Error(`Task ${taskId} never settled`);
}

export async function until<T>(condition: () => Promise<T | undefined | false | null>, ms = 10_000): Promise<T> {
  const deadline = Date.now() + ms;
  for (;;) {
    const value = await condition();
    if (value) return value;
    if (Date.now() > deadline) throw new Error('condition not met in time');
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

// Listens on the port and lets it go, so it says whether something else holds the port.
async function isFree(port: number): Promise<boolean> {
  const probe = createServer();
  try {
    // once() rejects on the 'error' a port in use emits.
    await once(probe.listen(port, '127.0.0.1'), 'listening');
  } catch {
    return false;
  }
  probe.close();
  await once(probe, 'close');
  return true;
}

// A daemon takes the port after its own for the try server, so a test daemon needs both free. macOS hands out port 0's
// ports in order from 49152, so the port after one taken that way is the next that any server started on port 0 gets.
// These come from far below that range, at random, and nowhere near the 4780 a real daemon uses.
export async function freePort(): Promise<number> {
  for (;;) {
    const port = 20_000 + Math.floor(Math.random() * 20_000);
    if ((await isFree(port)) && (await isFree(port + 1))) return port;
  }
}

const SCHEMA_VALID_REPORT = { summary: 'Did the work', files_changed: [], commands_run: [] };

export function resultLine(fields: Record<string, unknown>): string {
  return JSON.stringify({
    type: 'result',
    subtype: 'success',
    is_error: false,
    session_id: 'session-1',
    result: 'done',
    total_cost_usd: 0.01,
    usage: { input_tokens: 10, output_tokens: 20 },
    ...fields,
  });
}

const INIT_LINE = JSON.stringify({ type: 'system', subtype: 'init', session_id: 'session-1', model: 'm' });

export function okStep(files: Record<string, string>, report: Record<string, unknown> = {}, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    writeFiles: files,
    lines: [INIT_LINE, resultLine({ structured_output: { ...SCHEMA_VALID_REPORT, ...report } })],
    ...extra,
  };
}

export function resultStep(output: unknown): Record<string, unknown> {
  return { lines: [INIT_LINE, resultLine({ structured_output: output })] };
}

export function ticket(overrides: Record<string, unknown> & { body?: string } = {}): string {
  const { body = 'Do the work.\n', ...fields } = overrides;
  const front = {
    id: 'T-1',
    title: 'A ticket',
    milestone: 1,
    ac_refs: [],
    specialty: 'engineer',
    touches: ['src/**'],
    depends_on: [],
    definition_of_done: ['true'],
    inputs: [],
    size: 'S',
    ...fields,
  };
  return `---\n${stringify(front)}---\n${body}`;
}

export async function eventTypes(e: EngineDeps, taskId: number): Promise<string[]> {
  return (await e.log.list({ taskId })).map((event) => event.type);
}

// An approved list, as the stakeholder would leave it. With no items, every later check behaves as it did before the list.
export async function seedMustSupport(e: Pick<EngineDeps, 'artifacts'>, project: ProjectRow, items: MsItem[] = []): Promise<string> {
  const brief = await e.artifacts.latest(project.id, 'BRIEF');
  const [row] = await e.artifacts.commit(project, {
    message: 'must support',
    publish: [{ id: 'MUST-SUPPORT', type: 'must_support', status: 'approved', approvedBy: 'stakeholder', ownerRole: 'pm', derivedFrom: brief ? [`BRIEF@${brief.version}`] : [], body: renderMustSupport(items), fields: { data: { items, used: items.map(({ id }) => id) } } }],
  });
  return `MUST-SUPPORT@${row!.version}`;
}
