import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { fileURLToPath } from 'node:url';
import { serve } from '@hono/node-server';
import { claudeAdapterFor } from './adapters/claude-code.ts';
import { ArtifactStore } from './artifacts/store.ts';
import { chromePlayer } from './checks/play.ts';
import type { Config } from './config.ts';
import { openDb } from './db/open.ts';
import { Conductor } from './engine/conductor/index.ts';
import { recover } from './engine/recovery.ts';
import { pruneWorktrees } from './engine/retention.ts';
import { Runner, type EngineDeps } from './engine/runner.ts';
import { Scheduler } from './engine/scheduler.ts';
import { Store } from './engine/store.ts';
import { TryServer } from './engine/try-server.ts';
import { EventLog } from './events.ts';
import type { Paths } from './paths.ts';
import { createApp, serveWeb } from './server/app.ts';
import { keptWarning, syncSeed } from './setup/setup.ts';

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

function engineDeps(db: EngineDeps['db'], paths: Paths, config: Config, tryServer: TryServer): EngineDeps {
  const log = new EventLog(db);
  const adapter = claudeAdapterFor(paths, config);
  const store = new Store(db, log);
  // A missing Chrome is found when a game needs playing, as a hold, so the daemon starts without one.
  return { db, log, store, paths, config, adapters: { [adapter.id]: adapter }, artifacts: new ArtifactStore(store, paths), player: chromePlayer(config), tryServer };
}

// The stakeholder's link at CP4 has to keep working from one run to the next, so the port is a fixed one, and a daemon
// that can't have it doesn't start rather than serve the build where the link doesn't lead. A daemon given port 0 takes
// whatever port is free for this too.
async function startTryServer(apiPort: number, asked: number): Promise<TryServer> {
  const port = asked === 0 ? 0 : apiPort + 1;
  try {
    return await TryServer.start(port);
  } catch (err) {
    throw new Error(`The try server can't listen on port ${port}, the port after the API's, where CP4 serves a milestone's build: ${(err as Error).message}`, { cause: err });
  }
}

export async function startDaemon(opts: { paths: Paths; config: Config; webDist?: string }): Promise<{ port: number; address: AddressInfo; stop(): Promise<void> }> {
  const { paths, config, webDist = WEB_DIST } = opts;
  let handler: Handler = () => new Response('Starting up', { status: 503 });

  // The port comes first because it is what tells a second daemon to leave: past this point a daemon
  // writes to the database, and marking a live daemon's attempts interrupted can't be undone.
  const { server, port } = await listen((request, env) => handler(request, env), config.port);

  // Before the database too: a daemon that can't serve CP4's builds stops before it has changed anything.
  const tryServer = await startTryServer(port, config.port).catch(async (err: unknown) => {
    await close(server);
    throw err;
  });

  try {
    const db = await openDb(paths.db);
    // The port asked for can be 0, and the API's guard has to know the real one.
    const deps = engineDeps(db, paths, { ...config, port }, tryServer);
    const runner = new Runner(deps);
    const scheduler = new Scheduler(deps, runner, new Conductor(deps, runner));

    const pruneQuietly = () => pruneWorktrees(deps).catch((err: unknown) => console.error('Pruning worktrees failed:', err));
    const { kept } = await syncSeed(paths);
    const stale = keptWarning(paths, kept);
    if (stale) console.warn(stale);
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
        await tryServer.close();
        await close(server);
        await db.destroy();
      },
    };
  } catch (err) {
    await tryServer.close();
    await close(server);
    throw err;
  }
}
