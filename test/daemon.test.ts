import { spawn, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { rmSync, writeFileSync } from 'node:fs';
import { connect, createServer } from 'node:net';
import { networkInterfaces } from 'node:os';
import { join } from 'node:path';
import { setTimeout } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import type { Kysely } from 'kysely';
import { stringify } from 'yaml';
import { DEFAULT_CONFIG, type Config } from '../src/config.ts';
import { DaemonAlreadyRunning, startDaemon } from '../src/daemon.ts';
import type { DB } from '../src/db/schema.ts';
import { openDb } from '../src/db/open.ts';
import { addProject, addTicket } from '../src/engine/intake.ts';
import { Store, type TaskRow } from '../src/engine/store.ts';
import { EventLog } from '../src/events.ts';
import { resolvePaths, type Paths } from '../src/paths.ts';
import { runSetup } from '../src/setup/setup.ts';
import { okStep, ticket, until } from './helpers/engine.ts';
import { makeRepo, tempDir } from './helpers/repo.ts';

const CLI = fileURLToPath(new URL('../src/cli.ts', import.meta.url));
const FAKE_CLAUDE = fileURLToPath(new URL('./fixtures/fake-claude.mjs', import.meta.url));
const INIT = JSON.stringify({ type: 'system', subtype: 'init', session_id: 's', model: 'm' });
const SLOW = { lines: [INIT], delayMs: 120_000 };
const STUBBORN = { ...SLOW, ignoreSigint: true };
const TIMEOUT = 45_000;

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function freePort(): Promise<number> {
  const probe = createServer();
  probe.listen(0, '127.0.0.1');
  await once(probe, 'listening');
  const { port } = probe.address() as { port: number };
  probe.close();
  await once(probe, 'close');
  return port;
}

async function statusOf(port: number): Promise<number | null> {
  return fetch(`http://127.0.0.1:${port}/api/health`).then(
    (response) => response.status,
    () => null,
  );
}

describe('the daemon', () => {
  let root: string;
  let paths: Paths;
  let port: number;
  let db: Kysely<DB>;
  let store: Store;
  let repoPath: string;
  const processes: ChildProcess[] = [];
  const pids: number[] = [];

  beforeEach(async () => {
    root = tempDir('aiteam-daemon-');
    paths = resolvePaths({ AITEAM_HOME: join(root, 'home') });
    await runSetup(paths);
    port = await freePort();
    db = await openDb(paths.db);
    store = new Store(db, new EventLog(db));
    repoPath = (await makeRepo()).path;
    await addProject({ store, paths }, { name: 'p', repoPath, create: false });
  });

  afterEach(async () => {
    for (const child of processes.splice(0)) {
      if (child.exitCode === null && child.signalCode === null) {
        child.kill('SIGKILL');
        await once(child, 'exit');
      }
    }
    for (const pid of pids.splice(0)) {
      try {
        process.kill(-pid, 'SIGKILL');
      } catch {
        // Already gone.
      }
    }
    await db.destroy();
    rmSync(root, { recursive: true, force: true });
    rmSync(repoPath, { recursive: true, force: true });
  });

  function configure(steps: unknown[]): void {
    const script = join(root, 'script.json');
    writeFileSync(script, JSON.stringify(steps));
    writeFileSync(
      paths.config,
      stringify({
        port,
        cancel_grace_s: 2,
        claude: { binary: FAKE_CLAUDE, extra_env: { FAKE_SCRIPT: script, FAKE_SPAWN_LOG: join(root, 'spawns.log') } },
      }),
    );
  }

  // Not through the tsx launcher: a signal has to reach the daemon itself, with nothing in between.
  function spawnDaemon(): ChildProcess {
    const child = spawn(process.execPath, ['--import', 'tsx', CLI, 'daemon'], {
      env: { ...process.env, AITEAM_HOME: paths.root },
      stdio: ['ignore', 'ignore', 'pipe'],
    });
    processes.push(child);
    return child;
  }

  const addTask = (): Promise<TaskRow> => addTicket({ store, paths }, 'p', ticket());
  const stateOf = async (t: TaskRow) => (await store.getTask(t.id))!.state;

  async function runningWorker(t: TaskRow): Promise<number> {
    const attempt = await until(async () => (await store.listAttempts(t.id)).find((a) => a.state === 'running' && a.pid !== null), 20_000);
    pids.push(attempt.pid!);
    return attempt.pid!;
  }

  async function crash(child: ChildProcess): Promise<void> {
    child.kill('SIGKILL');
    await once(child, 'exit');
  }

  it(
    'recovers from SIGKILL mid-attempt in a new worktree',
    async () => {
      configure([SLOW, okStep({ 'src/a.mjs': '' })]);
      const t = await addTask();
      const first = spawnDaemon();
      const workerPid = await runningWorker(t);

      await crash(first);
      expect(isAlive(workerPid)).toBe(true);

      spawnDaemon();
      await until(async () => !isAlive(workerPid), 20_000);
      await until(async () => (await stateOf(t)) === 'review', 20_000);

      const [a1, a2] = await store.listAttempts(t.id);
      expect(a1!.state).toBe('interrupted');
      expect(a2!.state).toBe('succeeded');
      expect(a2!.worktree_path).not.toBe(a1!.worktree_path);
      expect(await store.failedAttemptCount(t.id)).toBe(0);
    },
    TIMEOUT,
  );

  it(
    'a second daemon exits non-zero and leaves the first alone',
    async () => {
      configure([SLOW]);
      const t = await addTask();
      spawnDaemon();
      const workerPid = await runningWorker(t);

      const second = spawnDaemon();
      const [code] = (await once(second, 'exit')) as [number | null];

      expect(code).not.toBe(0);
      expect(isAlive(workerPid)).toBe(true);
      expect((await store.listAttempts(t.id))[0]!.state).toBe('running');
      expect(await stateOf(t)).toBe('running');
    },
    TIMEOUT,
  );

  it.each(['SIGTERM', 'SIGINT'] as const)(
    '%s interrupts cleanly',
    async (signal) => {
      configure([SLOW]);
      const t = await addTask();
      const daemon = spawnDaemon();
      const workerPid = await runningWorker(t);

      daemon.kill(signal);
      const [code] = (await once(daemon, 'exit')) as [number | null];

      expect(code).toBe(0);
      expect(isAlive(workerPid)).toBe(false);
      expect((await store.listAttempts(t.id))[0]!.state).toBe('interrupted');
      expect(await stateOf(t)).toBe('ready');
    },
    TIMEOUT,
  );

  it(
    'answers 503 until recovery has finished',
    async () => {
      configure([STUBBORN]);
      const t = await addTask();
      const first = spawnDaemon();
      await runningWorker(t);
      await crash(first);

      spawnDaemon();
      const seen = new Set<number | null>();
      await until(async () => {
        const status = await statusOf(port);
        seen.add(status);
        return status === 200;
      }, 20_000);

      expect(seen.has(503)).toBe(true);
      expect((await store.listAttempts(t.id))[0]!.state).toBe('interrupted');
    },
    TIMEOUT,
  );

  describe('startDaemon', () => {
    const config = (): Config => ({ ...DEFAULT_CONFIG, port, cancelGraceS: 2, claude: { ...DEFAULT_CONFIG.claude, binary: FAKE_CLAUDE } });

    it('serves health on the port it reports, and stops twice without harm', async () => {
      const daemon = await startDaemon({ paths, config: { ...config(), port: 0 } });

      expect(daemon.port).toBeGreaterThan(0);
      expect(await statusOf(daemon.port)).toBe(200);

      await Promise.all([daemon.stop(), daemon.stop()]);
      await daemon.stop();
      expect(await statusOf(daemon.port)).toBeNull();
    });

    it('stops while a client is partway through a request', async () => {
      const daemon = await startDaemon({ paths, config: config() });
      const client = connect(daemon.port, '127.0.0.1');
      client.on('error', () => {});
      await once(client, 'connect');
      client.write('GET /api/health HTTP/1.1\r\n');
      // Nothing reports that the server has read this. Too short a wait can only let the test pass, never fail it.
      await setTimeout(200);

      await daemon.stop();

      expect(await statusOf(daemon.port)).toBeNull();
      client.destroy();
    });

    const external = Object.values(networkInterfaces())
      .flat()
      .find((address) => address && address.family === 'IPv4' && !address.internal);

    it.skipIf(external === undefined)('cannot be reached from another machine', async () => {
      const daemon = await startDaemon({ paths, config: config() });
      const client = connect(daemon.port, external!.address);

      const outcome = await new Promise((resolve) => {
        client.once('connect', () => resolve('connected'));
        client.once('error', () => resolve('refused'));
      });

      client.destroy();
      await daemon.stop();
      expect(outcome).toBe('refused');
    });

    it('refuses a port in use before touching the database', async () => {
      const holder = createServer();
      holder.listen(port, '127.0.0.1');
      await once(holder, 'listening');
      const t = await addTask();
      await store.setTaskState(t.id, 'ready');
      await store.setTaskState(t.id, 'running');
      const before = (await db.selectFrom('events').selectAll().execute()).length;

      await expect(startDaemon({ paths, config: config() })).rejects.toBeInstanceOf(DaemonAlreadyRunning);

      expect(await stateOf(t)).toBe('running');
      expect((await db.selectFrom('events').selectAll().execute()).length).toBe(before);
      holder.close();
      await once(holder, 'close');
    });

    it('lets go of the port when startup fails', async () => {
      writeFileSync(join(root, 'not-a-database'), 'garbage, and more than a header of it'.repeat(100));
      const broken: Paths = { ...paths, db: join(root, 'not-a-database') };

      await expect(startDaemon({ paths: broken, config: config() })).rejects.toThrow();

      const again = createServer();
      again.listen(port, '127.0.0.1');
      await once(again, 'listening');
      again.close();
      await once(again, 'close');
    });
  });
});
