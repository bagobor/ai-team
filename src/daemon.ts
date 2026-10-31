import type { Server } from 'node:http';
import { homedir } from 'node:os';
import { serve } from '@hono/node-server';
import { Hono } from 'hono';
import { ClaudeCodeAdapter } from './adapters/claude-code.ts';
import type { Config } from './config.ts';
import { openDb } from './db/open.ts';
import { recover } from './engine/recovery.ts';
import { pruneWorktrees } from './engine/retention.ts';
import { Runner, type EngineDeps } from './engine/runner.ts';
import { Scheduler } from './engine/scheduler.ts';
import { Store } from './engine/store.ts';
import { EventLog } from './events.ts';
import { workerDenyRead, type Paths } from './paths.ts';

const PRUNE_INTERVAL_MS = 3_600_000;
const HOST = '127.0.0.1';

export class DaemonAlreadyRunning extends Error {
  constructor(port: number) {
    super(`Port ${port} is in use: a daemon is already running, or something else holds it. The port is set in config.yaml.`);
    this.name = 'DaemonAlreadyRunning';
  }
}

function listen(app: Hono, port: number): Promise<{ server: Server; port: number }> {
  return new Promise((resolve, reject) => {
    const server = serve({ fetch: app.fetch, port, hostname: HOST }, (info) => resolve({ server: server as Server, port: info.port }));
    server.once('error', (err: NodeJS.ErrnoException) => reject(err.code === 'EADDRINUSE' ? new DaemonAlreadyRunning(port) : err));
  });
}

function close(server: Server): Promise<void> {
  return new Promise((resolve) => {
    server.close(() => resolve());
    // A request still open, such as an event stream, would otherwise hold the close up indefinitely.
    server.closeAllConnections();
  });
}

function engineDeps(db: EngineDeps['db'], paths: Paths, config: Config): EngineDeps {
  const log = new EventLog(db);
  const adapter = new ClaudeCodeAdapter({
    binary: config.claude.binary,
    agentHome: paths.claudeHome,
    mode: config.claude.mode,
    denyRead: workerDenyRead(paths, homedir()),
    graceS: config.cancelGraceS,
    timeoutS: config.attemptTimeoutS,
    ...(config.claude.extraEnv ? { extraEnv: config.claude.extraEnv } : {}),
  });
  return { db, log, store: new Store(db, log), paths, config, adapters: { [adapter.id]: adapter } };
}

export async function startDaemon(opts: { paths: Paths; config: Config }): Promise<{ port: number; stop(): Promise<void> }> {
  const { paths, config } = opts;
  let started = false;

  const app = new Hono();
  app.use('*', async (c, next) => (started ? next() : c.text('Starting up', 503)));
  app.get('/api/health', (c) => c.json({ ok: true }));

  // The port comes first because it is what tells a second daemon to leave: past this point a daemon
  // writes to the database, and marking a live daemon's attempts interrupted can't be undone.
  const { server, port } = await listen(app, config.port);

  try {
    const db = await openDb(paths.db);
    const deps = engineDeps(db, paths, config);
    const runner = new Runner(deps);
    const scheduler = new Scheduler(deps, runner);

    const pruneQuietly = () => pruneWorktrees(deps).catch((err: unknown) => console.error('Pruning worktrees failed:', err));
    await recover(deps);
    await pruneQuietly();
    scheduler.start();
    const pruning = setInterval(() => void pruneQuietly(), PRUNE_INTERVAL_MS);
    started = true;

    return {
      port,
      stop: async () => {
        clearInterval(pruning);
        await scheduler.stop();
        await runner.shutdown();
        await close(server);
        await db.destroy();
      },
    };
  } catch (err) {
    await close(server);
    throw err;
  }
}
