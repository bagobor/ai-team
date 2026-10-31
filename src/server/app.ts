import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';
import { serveStatic } from '@hono/node-server/serve-static';
import { Hono, type Context, type MiddlewareHandler } from 'hono';
import { streamSSE } from 'hono/streaming';
import type { ContentfulStatusCode } from 'hono/utils/http-status';
import { IllegalTransition } from '../engine/fsm.ts';
import { addProject, addTicket, DuplicateError, ProjectError } from '../engine/intake.ts';
import type { EngineDeps, Runner } from '../engine/runner.ts';
import type { EventRow } from '../events.ts';
import { TicketError } from '../tickets/ticket.ts';

const PING_MS = 15_000;

class BadRequest extends Error {}

const fail = (c: Context, status: ContentfulStatusCode, error: string) => c.json({ error }, status);

function parseId(raw: string | undefined): number | undefined {
  if (raw === undefined || !/^\d+$/.test(raw)) return undefined;
  const id = Number(raw);
  return Number.isSafeInteger(id) ? id : undefined;
}

async function jsonBody(c: Context): Promise<Record<string, unknown>> {
  const body: unknown = await c.req.json().catch(() => {
    throw new BadRequest('The request body is not valid JSON');
  });
  if (typeof body !== 'object' || body === null || Array.isArray(body)) throw new BadRequest('The request body must be a JSON object');
  return body as Record<string, unknown>;
}

function requireString(body: Record<string, unknown>, field: string): string {
  const value = body[field];
  if (typeof value !== 'string' || value === '') throw new BadRequest(`${field} must be a non-empty string`);
  return value;
}

// A browser page on any other site can still send requests here, so the daemon has to refuse them itself:
// Host stops DNS rebinding, Origin stops cross-site reads and writes, and requiring JSON stops the
// form-style POST that a browser sends without asking first.
function guard(port: number): MiddlewareHandler {
  const hosts = [`127.0.0.1:${port}`, `localhost:${port}`];
  const origins = hosts.map((host) => `http://${host}`);

  return async (c, next) => {
    const host = c.req.header('host');
    if (host === undefined || !hosts.includes(host)) return fail(c, 403, 'This Host is not allowed');

    const origin = c.req.header('origin');
    if (origin !== undefined && !origins.includes(origin)) return fail(c, 403, 'This Origin is not allowed');

    if (c.req.method !== 'GET') {
      const mediaType = c.req.header('content-type')?.split(';', 1)[0]?.trim().toLowerCase();
      if (mediaType !== 'application/json') return fail(c, 415, 'Content-Type must be application/json');
    }
    return next();
  };
}

export function createApp(deps: EngineDeps & { runner: Runner }): Hono {
  const { store, log, runner } = deps;
  const app = new Hono();

  app.onError((err, c) => {
    if (err instanceof BadRequest) return fail(c, 400, err.message);
    console.error(err);
    return fail(c, 500, 'Something went wrong in the daemon. Its log has the details.');
  });
  app.notFound((c) => fail(c, 404, 'Not found'));

  app.use('*', guard(deps.config.port));

  app.get('/api/health', (c) => c.json({ ok: true }));

  app.get('/api/projects', async (c) => c.json(await store.listProjects()));

  app.post('/api/projects', async (c) => {
    const body = await jsonBody(c);
    const name = requireString(body, 'name');
    const repoPath = requireString(body, 'repoPath');
    if (!isAbsolute(repoPath)) throw new BadRequest('repoPath must be an absolute path');
    const create = body.create ?? false;
    if (typeof create !== 'boolean') throw new BadRequest('create must be true or false');

    try {
      return c.json(await addProject(deps, { name, repoPath, create }), 201);
    } catch (err) {
      if (err instanceof DuplicateError) return fail(c, 409, err.message);
      if (err instanceof ProjectError) return fail(c, 400, err.message);
      throw err;
    }
  });

  app.post('/api/projects/:name/tickets', async (c) => {
    const name = c.req.param('name');
    if (!(await store.getProject(name))) return fail(c, 404, `Unknown project ${name}`);
    const markdown = requireString(await jsonBody(c), 'markdown');

    try {
      return c.json(await addTicket(deps, name, markdown), 201);
    } catch (err) {
      if (err instanceof DuplicateError) return fail(c, 409, err.message);
      if (err instanceof TicketError) return fail(c, 400, err.message);
      throw err;
    }
  });

  app.get('/api/tasks', async (c) => {
    const projectName = c.req.query('project');
    const project = projectName === undefined ? undefined : await store.getProject(projectName);
    if (projectName !== undefined && !project) return fail(c, 404, `Unknown project ${projectName}`);

    const [tasks, totals] = await Promise.all([store.listTasks(project?.id), store.attemptTotals()]);
    return c.json(tasks.map((task) => ({ ...task, ...(totals.get(task.id) ?? { attempts: 0, usdEst: null }) })));
  });

  app.get('/api/tasks/:id', async (c) => {
    const id = parseId(c.req.param('id'));
    const task = id === undefined ? undefined : await store.getTask(id);
    if (!task) return fail(c, 404, 'No such task');

    const attempts = (await store.listAttempts(task.id)).map(({ manifest, ...attempt }) => attempt);
    return c.json({ task, attempts });
  });

  app.get('/api/attempts/:id/manifest', async (c) => {
    const id = parseId(c.req.param('id'));
    const attempt = id === undefined ? undefined : await store.getAttempt(id);
    if (attempt?.manifest === undefined || attempt.manifest === null) return fail(c, 404, 'No manifest for this attempt');
    return c.json(attempt.manifest as object);
  });

  app.get('/api/tasks/:id/events', async (c) => {
    const id = parseId(c.req.param('id'));
    const task = id === undefined ? undefined : await store.getTask(id);
    if (!task) return fail(c, 404, 'No such task');

    // A reconnecting browser sends Last-Event-ID along with the URL it first opened, whose ?after= is older.
    const after = parseId(c.req.header('last-event-id')) ?? parseId(c.req.query('after')) ?? 0;

    return streamSSE(c, async (stream) => {
      const queue: EventRow[] = [];
      let wake = () => {};
      let closed = false;

      // Subscribing comes before the replay: an event appended between the two would otherwise be lost.
      const unsubscribe = log.subscribe((event) => {
        if (event.taskId !== task.id) return;
        queue.push(event);
        wake();
      });
      stream.onAbort(() => {
        closed = true;
        wake();
      });
      const ping = setInterval(() => void stream.write(': ping\n\n'), PING_MS);

      try {
        let last = after;
        const send = async (event: EventRow) => {
          if (event.seq <= last) return; // In the replay as well as the subscription.
          last = event.seq;
          await stream.writeSSE({ id: String(event.seq), event: event.type, data: JSON.stringify(event) });
        };

        // Response headers go out with the first write, and a task can be quiet for a long time.
        await stream.write(': connected\n\n');
        for (const event of await log.list({ taskId: task.id, afterSeq: after })) await send(event);

        while (!closed) {
          const event = queue.shift();
          if (event) await send(event);
          else {
            await new Promise<void>((resolve) => {
              wake = resolve;
            });
          }
        }
      } finally {
        clearInterval(ping);
        unsubscribe();
      }
    });
  });

  app.post('/api/tasks/:id/cancel', async (c) => act(c, (id) => runner.cancel(id)));
  app.post('/api/tasks/:id/retry', async (c) => act(c, (id) => runner.retry(id)));

  async function act(c: Context, action: (id: number) => Promise<unknown>): Promise<Response> {
    const id = parseId(c.req.param('id'));
    const task = id === undefined ? undefined : await store.getTask(id);
    if (!task) return fail(c, 404, 'No such task');

    try {
      await action(task.id);
    } catch (err) {
      if (err instanceof IllegalTransition) return fail(c, 409, err.message);
      throw err;
    }
    return c.json({ ok: true }, 202);
  }

  return app;
}

// Goes on after the API's routes, so they win and the guard covers these too.
export function serveWeb(app: Hono, webDist: string): void {
  if (!existsSync(join(webDist, 'index.html'))) return;

  app.use('*', serveStatic({ root: webDist }));
  // The app has its own paths, such as /tasks/3, and has to be the answer to a reload on one of them.
  app.get('*', async (c, next) => {
    if (c.req.path === '/api' || c.req.path.startsWith('/api/')) return next();
    return c.html(await readFile(join(webDist, 'index.html'), 'utf8'));
  });
}
