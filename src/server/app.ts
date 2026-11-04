import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';
import { serveStatic } from '@hono/node-server/serve-static';
import { Hono, type Context, type MiddlewareHandler } from 'hono';
import type { ContentfulStatusCode } from 'hono/utils/http-status';
import { ArtifactError } from '../artifacts/format.ts';
import { lineageGraph } from '../artifacts/lineage.ts';
import { testPlanId } from '../engine/apply/ids.ts';
import { ChangeRequestError, fileChangeRequest } from '../engine/change-requests.ts';
import { haltProject } from '../engine/conductor/index.ts';
import { isTerminal } from '../engine/conductor/tasks.ts';
import { IllegalTransition } from '../engine/fsm.ts';
import { AlreadyAnswered, InvalidAnswer, type InboxAnswer } from '../engine/inbox.ts';
import { addBrief, addProject, addTicket, DuplicateError, ProjectError } from '../engine/intake.ts';
import type { EngineDeps, Runner } from '../engine/runner.ts';
import type { MilestoneRow, ProjectRow, TaskRow } from '../engine/store.ts';
import { git } from '../git/git.ts';
import { SAFE_ID, TicketError } from '../tickets/ticket.ts';
import { streamEvents } from './events-stream.ts';

class BadRequest extends Error {}
class NotFound extends Error {}
class Conflict extends Error {}

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

function numberParam(c: Context, name: string): number | undefined {
  const raw = c.req.query(name);
  if (raw === undefined) return undefined;
  const value = parseId(raw);
  if (value === undefined) throw new BadRequest(`${name} must be a number`);
  return value;
}

function requireNumber(c: Context, name: string): number {
  const value = numberParam(c, name);
  if (value === undefined) throw new BadRequest(`${name} must be a number`);
  return value;
}

function artifactIdOf(c: Context): string {
  const id = c.req.param('id') ?? '';
  if (!SAFE_ID.test(id)) throw new BadRequest('That is not a valid artifact id');
  return id;
}

// A reconnecting browser sends Last-Event-ID along with the URL it first opened, whose ?after= is older.
const resumeFrom = (c: Context) => parseId(c.req.header('last-event-id')) ?? parseId(c.req.query('after')) ?? 0;

const currentMilestone = (milestones: MilestoneRow[]) => milestones.find(({ phase }) => phase !== 'merged' && phase !== 'halted') ?? milestones.at(-1);

// Only the fields of an answer reach the durable record, whatever else the request carried.
function answerFrom(body: Record<string, unknown>): InboxAnswer {
  const { action, comment, option, text } = body;
  if (action === 'approve' || action === 'reject') return { action };
  if (action === 'request_changes') return { action, comment: typeof comment === 'string' ? comment : '' };
  if (typeof option === 'string') return { option };
  if (typeof text === 'string') return { text };
  throw new BadRequest('An answer is an action, an option or written words');
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
    if (err instanceof NotFound) return fail(c, 404, err.message);
    if (err instanceof Conflict) return fail(c, 409, err.message);
    console.error(err);
    return fail(c, 500, 'Something went wrong in the daemon. Its log has the details.');
  });
  app.notFound((c) => fail(c, 404, 'Not found'));

  app.use('*', guard(deps.config.port));

  app.get('/api/health', (c) => c.json({ ok: true }));

  async function projectOf(c: Context): Promise<ProjectRow> {
    const name = c.req.param('name') ?? '';
    const project = await store.getProject(name);
    if (!project) throw new NotFound(`Unknown project ${name}`);
    return project;
  }

  // Nothing would ever pick up what is added to a project that has stopped.
  function assertRunning(project: ProjectRow): void {
    if (isTerminal(project)) throw new Conflict(`${project.name} has stopped`);
  }

  app.get('/api/projects', async (c) => {
    const projects = await store.listProjects();
    const rows = projects.map(async (project) => ({
      ...project,
      milestone: currentMilestone(await store.listMilestones(project.id)) ?? null,
      pending: (await store.listInbox({ projectId: project.id, state: 'pending' })).length,
    }));
    return c.json(await Promise.all(rows));
  });

  app.get('/api/projects/:name', async (c) => {
    const project = await projectOf(c);
    const [milestones, tasks, attemptTotals] = await Promise.all([store.listMilestones(project.id), store.listTasks(project.id), store.attemptTotals()]);

    const totals = { attempts: 0, usdEst: null as number | null, seconds: 0 };
    for (const task of tasks) {
      const total = attemptTotals.get(task.id);
      totals.attempts += total?.attempts ?? 0;
      totals.seconds += total?.seconds ?? 0;
      if (total?.usdEst != null) totals.usdEst = (totals.usdEst ?? 0) + total.usdEst;
    }
    return c.json({ ...project, milestones, totals });
  });

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

  app.post('/api/projects/:name/brief', async (c) => {
    const project = await projectOf(c);
    const markdown = requireString(await jsonBody(c), 'markdown');
    if (markdown.trim() === '') throw new BadRequest('markdown must not be blank');
    assertRunning(project);

    try {
      return c.json(await addBrief(deps, project.name, markdown), 201);
    } catch (err) {
      if (err instanceof DuplicateError) return fail(c, 409, err.message);
      throw err;
    }
  });

  app.post('/api/projects/:name/halt', async (c) => {
    const project = await projectOf(c);
    const reason = requireString(await jsonBody(c), 'reason');
    assertRunning(project);

    await haltProject(deps, runner, project, reason);
    return c.json(await store.getProjectById(project.id));
  });

  app.post('/api/projects/:name/change-requests', async (c) => {
    const project = await projectOf(c);
    const body = await jsonBody(c);
    const optional = (field: 'target_section' | 'target_ac' | 'proposed_verification') => (typeof body[field] === 'string' ? { [field]: body[field] } : {});
    const input = {
      target_artifact: requireString(body, 'target_artifact'),
      ...optional('target_section'),
      ...optional('target_ac'),
      proposed_text: requireString(body, 'proposed_text'),
      ...optional('proposed_verification'),
      rationale: requireString(body, 'rationale'),
      evidence: requireString(body, 'evidence'),
      raised_by: 'stakeholder',
    };
    assertRunning(project);

    try {
      return c.json(await fileChangeRequest(deps, project, input), 201);
    } catch (err) {
      if (err instanceof ChangeRequestError) return fail(c, 409, err.message);
      throw err;
    }
  });

  app.get('/api/projects/:name/artifacts', async (c) => c.json(await store.listLatestArtifacts((await projectOf(c)).id)));

  app.get('/api/projects/:name/artifacts/:id', async (c) => {
    const project = await projectOf(c);
    const id = artifactIdOf(c);
    const version = numberParam(c, 'version');
    const row = version === undefined ? await store.latestArtifact(project.id, id) : await store.artifactVersion(project.id, id, version);
    if (!row) return fail(c, 404, `${id} has no such version`);

    const [doc, versions] = await Promise.all([deps.artifacts.read(project, `${id}@${row.version}`), store.listArtifactVersions(project.id, id)]);
    return c.json({ ...doc, versions });
  });

  app.get('/api/projects/:name/artifacts/:id/diff', async (c) => {
    const project = await projectOf(c);
    const id = artifactIdOf(c);
    const [from, to] = [requireNumber(c, 'from'), requireNumber(c, 'to')];

    try {
      return c.json({ diff: await deps.artifacts.diff(project, id, from, to) });
    } catch (err) {
      if (err instanceof ArtifactError) return fail(c, 404, err.message);
      throw err;
    }
  });

  app.get('/api/projects/:name/lineage', async (c) => c.json(await lineageGraph(store, (await projectOf(c)).id)));

  // The status comes from the registry and nowhere else: only a QA verification task can change it there.
  app.get('/api/projects/:name/acs', async (c) => {
    const project = await projectOf(c);
    const milestone = numberParam(c, 'milestone') ?? currentMilestone(await store.listMilestones(project.id))?.n;
    if (milestone === undefined) return c.json([]);

    const [criteria, tasks, plan] = await Promise.all([store.listCriteria(project.id, milestone), store.listTasks(project.id), deps.artifacts.latest(project.id, testPlanId(milestone))]);
    const coverage = plan ? ((await deps.artifacts.read(project, testPlanId(milestone))).fields.data as { coverage: { ac: string; commands: string[] }[] }).coverage : [];
    const coversIt = (task: TaskRow, ac: string) => task.kind === 'ticket' && task.milestone === milestone && task.state !== 'cancelled' && task.ac_refs.includes(ac);

    return c.json(
      criteria.map((criterion) => ({
        ...criterion,
        tickets: tasks.filter((task) => coversIt(task, criterion.ac_id)).map(({ ticket_id }) => ticket_id),
        commands: [...new Set(coverage.filter(({ ac }) => ac === criterion.ac_id).flatMap(({ commands }) => commands))],
      })),
    );
  });

  app.get('/api/projects/:name/events', async (c) => {
    const project = await projectOf(c);
    const after = resumeFrom(c);
    return streamEvents(c, log, {
      after,
      replay: () => log.list({ projectId: project.id, afterSeq: after, workerLines: false }),
      filter: (event) => event.projectId === project.id && !event.type.startsWith('worker.'),
    });
  });

  app.get('/api/inbox', async (c) => {
    const projectName = c.req.query('project');
    const project = projectName === undefined ? undefined : await store.getProject(projectName);
    if (projectName !== undefined && !project) return fail(c, 404, `Unknown project ${projectName}`);

    const [items, projects, count] = await Promise.all([store.listInbox({ ...(project ? { projectId: project.id } : {}), state: 'pending' }), store.listProjects(), store.pendingInboxCount()]);
    const names = new Map(projects.map(({ id, name }) => [id, name]));
    const now = (deps.now?.() ?? new Date()).getTime();
    return c.json({
      items: items.map((item) => ({ ...item, project: names.get(item.project_id), ageS: Math.max(0, Math.round((now - Date.parse(item.created_at)) / 1000)) })),
      count,
    });
  });

  app.post('/api/inbox/:id/answer', async (c) => {
    const id = parseId(c.req.param('id'));
    const item = id === undefined ? undefined : await store.getInbox(id);
    if (!item) return fail(c, 404, 'No such Inbox item');
    const answer = answerFrom(await jsonBody(c));

    try {
      return c.json(await store.answerInbox(item.id, answer));
    } catch (err) {
      if (err instanceof AlreadyAnswered) return fail(c, 409, err.message);
      if (err instanceof InvalidAnswer) return fail(c, 400, err.message);
      throw err;
    }
  });

  app.get('/api/tasks', async (c) => {
    const projectName = c.req.query('project');
    const project = projectName === undefined ? undefined : await store.getProject(projectName);
    if (projectName !== undefined && !project) return fail(c, 404, `Unknown project ${projectName}`);
    const milestone = numberParam(c, 'milestone');

    const [tasks, totals] = await Promise.all([store.listTasks(project?.id), store.attemptTotals()]);
    const rows = milestone === undefined ? tasks : tasks.filter((task) => task.milestone === milestone);
    return c.json(rows.map((task) => ({ ...task, specialty: task.role_id, ...(totals.get(task.id) ?? { attempts: 0, usdEst: null }) })));
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

    const after = resumeFrom(c);
    return streamEvents(c, log, {
      after,
      replay: () => log.list({ taskId: task.id, afterSeq: after }),
      filter: (event) => event.taskId === task.id,
    });
  });

  app.get('/api/attempts/:id/diff', async (c) => {
    const id = parseId(c.req.param('id'));
    const attempt = id === undefined ? undefined : await store.getAttempt(id);
    if (!attempt) return fail(c, 404, 'No such attempt');
    const { base_sha: base, head_sha: head } = attempt;
    if (!base || !head) return c.json({ diff: null });

    const task = await store.getTask(attempt.task_id);
    const project = task && (await store.getProjectById(task.project_id));
    // The commit goes when its branch does, and a diff too big for the buffer rejects: neither is a failure of this request.
    const result = project && (await git(project.repo_path, ['diff', '--no-ext-diff', '--no-textconv', '--no-color', base, head]).catch(() => undefined));
    return c.json({ diff: result?.code === 0 ? result.stdout : null, base, head });
  });

  // The conductor would only queue its own tasks again, and cancelling one would leave a phase stuck.
  app.post('/api/tasks/:id/cancel', async (c) =>
    act(c, async (task) => {
      if (task.kind !== 'ticket') throw new Conflict(`${task.ticket_id} belongs to the conductor. Halt the project to stop it.`);
      await runner.cancel(task.id);
    }),
  );
  app.post('/api/tasks/:id/retry', async (c) => act(c, (task) => runner.retry(task.id)));

  async function act(c: Context, action: (task: TaskRow) => Promise<unknown>): Promise<Response> {
    const id = parseId(c.req.param('id'));
    const task = id === undefined ? undefined : await store.getTask(id);
    if (!task) return fail(c, 404, 'No such task');

    try {
      await action(task);
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
