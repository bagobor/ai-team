import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { fileURLToPath } from 'node:url';
import { serve } from '@hono/node-server';
import { claudeAdapterFor } from './adapters/claude-code.ts';
import type { Config } from './config.ts';
import { openDb } from './db/open.ts';
import { recover } from './engine/recovery.ts';
import { pruneWorktrees } from './engine/retention.ts';
import { Runner, type EngineDeps } from './engine/runner.ts';
import { Scheduler } from './engine/scheduler.ts';
import { Store } from './engine/store.ts';
import { EventLog } from './events.ts';
import type { Paths } from './paths.ts';
import { createApp, serveWeb } from './server/app.ts';

const PRUNE_INTERVAL_MS = 3_600_000;
const HOST = '127.0.0.1';
const WEB_DIST = fileURLToPath(new URL('../web/dist', import.meta.url));

type Handler = (request: Request, env: object) => Response | Promise<Response>;

export class DaemonAlreadyRunning extends Error {
  constructor(port: number) {
    super(`Port ${port} is in use: a daemon is already running, or something else holds it. The port is set in config.yaml.`);
    this.name = 'DaemonAlreadyRunning';
  }
}

function listen(handler: Handler, port: number): Promise<{ server: Server; port: number }> {
  return new Promise((resolve, reject) => {
    const server = serve({ fetch: handler, port, hostname: HOST }, (info) => resolve({ server: server as Server, port: info.port }));
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
  const adapter = claudeAdapterFor(paths, config);
  return { db, log, store: new Store(db, log), paths, config, adapters: { [adapter.id]: adapter } };
}

export async function startDaemon(opts: { paths: Paths; config: Config; webDist?: string }): Promise<{ port: number; address: AddressInfo; stop(): Promise<void> }> {
  const { paths, config, webDist = WEB_DIST } = opts;
  let handler: Handler = () => new Response('Starting up', { status: 503 });

  // The port comes first because it is what tells a second daemon to leave: past this point a daemon
  // writes to the database, and marking a live daemon's attempts interrupted can't be undone.
  const { server, port } = await listen((request, env) => handler(request, env), config.port);

  try {
    const db = await openDb(paths.db);
    // The port asked for can be 0, and the API's guard has to know the real one.
    const deps = engineDeps(db, paths, { ...config, port });
    const runner = new Runner(deps);
    const scheduler = new Scheduler(deps, runner);

    const pruneQuietly = () => pruneWorktrees(deps).catch((err: unknown) => console.error('Pruning worktrees failed:', err));
    await recover(deps);
    await pruneQuietly();
    scheduler.start();
    const pruning = setInterval(() => void pruneQuietly(), PRUNE_INTERVAL_MS);

    const app = createApp({ ...deps, runner });
    serveWeb(app, webDist);
    handler = app.fetch;

    return {
      port,
      address: server.address() as AddressInfo,
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
