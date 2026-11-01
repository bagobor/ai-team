// M2 acceptance: a real team on the stakeholder's login takes a small brief to a merged milestone, answered through the
// API like the stakeholder would. It spends real money up to MAX_TOTAL_USD, so run it outside any sandbox that blocks the
// network. With --hold the daemon stays up afterwards, so the UI can be checked.
import { execFile, spawn, type ChildProcess } from 'node:child_process';
import { mkdtempSync, openSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { ArtifactDoc } from '../src/artifacts/format.ts';
import type { LineageGraph } from '../src/artifacts/lineage.ts';
import { loadConfig } from '../src/config.ts';
import { openDb } from '../src/db/open.ts';
import type { InboxAnswer, InboxRef, InboxRow } from '../src/engine/inbox.ts';
import type { AttemptRow, CriterionRow, MilestoneRow, ProjectRow, TaskRow } from '../src/engine/store.ts';
import type { EventRow } from '../src/events.ts';
import type { TaskManifest } from '../src/manifest/build.ts';
import { resolvePaths } from '../src/paths.ts';
import { loadRole } from '../src/roles/role.ts';

const ROOT = fileURLToPath(new URL('..', import.meta.url));

const MAX_TOTAL_USD = 25;
const POLL_MS = 2000;
const PHASE_TIMEOUT_MS = 60 * 60_000;
const INIT_TIMEOUT_MS = 2 * 60_000;
const START_TIMEOUT_MS = 30_000;
const WORKER_GONE_TIMEOUT_MS = 30_000;
const EVENTS_TIMEOUT_MS = 10_000;
const MAX_CONTEXT_TOKENS = 12_000;
const MILESTONE = 1;
const NOTES = 'NOTES.md';
const NOTES_COMMITTED = '# My notes\n\nWhat I want from this tool.\n';
const NOTES_EDITED = `${NOTES_COMMITTED}\nAn unfinished thought about Kelvin.\n`;
const UNTRACKED = 'scratch-notes.txt';
const UNTRACKED_TEXT = 'Nothing to do with this work.\n';
const DESIGN_TASKS = ['M1-TECH', 'M1-TESTPLAN'];
const ROLES: Record<string, string> = { pm: 'claude-opus-5-5', tech_lead: 'claude-opus-5-5', engineer: 'claude-sonnet-5-5', code_reviewer: 'claude-opus-5-5', qa_engineer: 'claude-sonnet-5-5' };
// Each of these needs a person to think. This run can't, so it stops and says what it found.
const STOPS: InboxRef['kind'][] = ['escalation', 'smoke', 'base_conflict', 'base_refused', 'qa_cap', 'engine_error'];
const ENDED_PROJECT_PHASES = ['closed', 'halted'];
const ENDED_TASK_STATES = ['done', 'cancelled'];

const BRIEF = `# Temperatures

A small Node command line tool that converts temperatures between Celsius and Fahrenheit, so I stop looking the formula up.

It uses only Node's built-in modules, with nothing to install. Its tests run with \`node --test\`. One milestone is enough for this.
`;

type Task = TaskRow & { attempts: number; usdEst: number | null; seconds: number | null };
type Details = { task: TaskRow; attempts: AttemptRow[] };
type InboxItem = InboxRow & { project: string; ageS: number };
type ProjectView = ProjectRow & { milestones: MilestoneRow[]; totals: { attempts: number; usdEst: number | null; seconds: number | null } };
type Criterion = CriterionRow & { tickets: string[]; commands: string[] };
type ArtifactDetails = ArtifactDoc & { versions: { version: number }[] };
type Snapshot = { view: ProjectView; tasks: Task[]; inbox: InboxItem[] };

const paths = resolvePaths();
const { port } = loadConfig(paths);
const API = `http://127.0.0.1:${port}`;

const failures: string[] = [];
const scratch = mkdtempSync(join(realpathSync(tmpdir()), 'aiteam-smoke-m2-'));
const repo = join(scratch, 'repo');
const startedAt = Date.now();
let daemon: ChildProcess | undefined;
let name = '';
let base = '';
let baseBefore = '';
let checkoutBefore = '';
let headBefore = '';
let lastEstimate = -1;
let cp4Answered = false;
let designDone = false;
let earlyTicket = '';
let mainMovedEarly = '';
let checkoutChangedEarly = '';
const answeredRequests = new Set<number>();

function check(what: string, ok: boolean, detail = ''): boolean {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${what}${detail ? `: ${detail}` : ''}`);
  if (!ok) failures.push(what);
  return ok;
}

const note = (text: string) => console.log(`NOTE  ${text}`);
const seconds = (ms: number) => `${(ms / 1000).toFixed(1)}s`;
const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const cut = (text: string | null | undefined, length = 400) => (text ?? '').replace(/\s+/g, ' ').slice(0, length);
const blank = (text: string | null | undefined) => (text ?? '').trim() === '';

// A check that throws has failed, but the checks after it still have something to say.
async function guarded(what: string, body: () => Promise<void>): Promise<void> {
  try {
    await body();
  } catch (err) {
    check(what, false, err instanceof Error ? err.message : String(err));
  }
}

function run(binary: string, args: string[], cwd = ROOT): Promise<{ code: number; output: string }> {
  return new Promise((resolve) => {
    execFile(binary, args, { cwd, maxBuffer: 16 * 1024 * 1024 }, (err, stdout, stderr) => {
      const code = err ? (typeof err.code === 'number' ? err.code : 1) : 0;
      resolve({ code, output: `${stdout}${stderr}`.trim() });
    });
  });
}

// Through node rather than the tsx command: that one is a parent process, and killing it would leave the daemon running.
const CLI = ['--import', 'tsx', 'src/cli.ts'];
const aiteam = (...args: string[]) => run(process.execPath, [...CLI, ...args]);
const git = (...args: string[]) => run('git', args, repo);

async function repoRev(ref: string): Promise<string> {
  const { code, output } = await git('rev-parse', '--verify', ref);
  return code === 0 ? output : `no ${ref}`;
}

const porcelain = async () => (await git('status', '--porcelain')).output;

async function get<T>(path: string): Promise<T> {
  const res = await fetch(`${API}${path}`);
  if (!res.ok) throw new Error(`${path}: ${res.status} ${await res.text()}`);
  return (await res.json()) as T;
}

async function post<T>(path: string, body: unknown): Promise<T> {
  const res = await fetch(`${API}${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  if (!res.ok) throw new Error(`${path}: ${res.status} ${await res.text()}`);
  return (await res.json()) as T;
}

const projectApi = () => `/api/projects/${encodeURIComponent(name)}`;
const artifact = (id: string, version?: number) => get<ArtifactDetails>(`${projectApi()}/artifacts/${encodeURIComponent(id)}${version === undefined ? '' : `?version=${version}`}`);
const criteria = () => get<Criterion[]>(`${projectApi()}/acs?milestone=${MILESTONE}`);
const details = (taskId: number) => get<Details>(`/api/tasks/${taskId}`);
const answer = (item: InboxItem, body: InboxAnswer) => post(`/api/inbox/${item.id}/answer`, body);

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

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM';
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

const workerStarted = (events: EventRow[]) => events.some((event) => event.type === 'worker.init');

// A leftover project would carry on as soon as the daemon starts, and its spend would count against nothing.
async function refuseUnfinishedProjects(): Promise<void> {
  const db = await openDb(paths.db);
  try {
    const projects = await db.selectFrom('projects').select(['id', 'name', 'phase']).execute();
    const tasks = await db.selectFrom('tasks').select(['project_id', 'state']).execute();
    const live = projects.filter(({ id, phase }) => !ENDED_PROJECT_PHASES.includes(phase) && (phase !== 'intake' || tasks.some((task) => task.project_id === id && !ENDED_TASK_STATES.includes(task.state))));
    if (live.length > 0) throw new Error(`These projects would carry on and spend when the daemon starts, so halt them first: ${live.map((project) => project.name).join(', ')}`);
  } finally {
    await db.destroy();
  }
}

async function freeProjectName(): Promise<string> {
  const taken = new Set((await get<{ name: string }[]>('/api/projects')).map((project) => project.name));
  let free = 'smoke-m2';
  for (let n = 2; taken.has(free); n += 1) free = `smoke-m2-${n}`;
  return free;
}

// What holds for the whole run is read on every poll, so a breach between two checks still gets seen.
async function watch({ view, tasks, inbox }: Snapshot): Promise<void> {
  const usd = view.totals.usdEst ?? 0;
  if (usd !== lastEstimate) {
    lastEstimate = usd;
    note(`Running estimate $${usd.toFixed(2)} of the $${MAX_TOTAL_USD} cap, ${seconds(Date.now() - startedAt)} in`);
  }
  if (usd > MAX_TOTAL_USD) throw new Error(`The estimate of $${usd.toFixed(2)} is over the $${MAX_TOTAL_USD} cap`);

  designDone ||= DESIGN_TASKS.every((id) => tasks.find((task) => task.ticket_id === id)?.state === 'done');
  const early = designDone ? undefined : tasks.find((task) => task.kind === 'ticket');
  if (early) earlyTicket ||= early.ticket_id;

  if (!cp4Answered && baseBefore !== '') {
    const rev = await repoRev(base);
    if (rev !== baseBefore) mainMovedEarly ||= rev;
    const status = await porcelain();
    if (status !== checkoutBefore) checkoutChangedEarly ||= status;
  }

  const stop = inbox.find(({ ref }) => STOPS.includes(ref.kind));
  if (stop) throw new Error(`The Inbox asks for a person (${stop.ref.kind}): ${stop.title}. ${cut(stop.why)}. ${cut(stop.evidence.map(({ label, value }) => `${label}: ${value}`).join('; '))}`);
  if (view.phase === 'halted') throw new Error(`${name} halted`);
}

async function snapshot(): Promise<Snapshot> {
  const query = encodeURIComponent(name);
  const [view, tasks, { items }] = await Promise.all([get<ProjectView>(projectApi()), get<Task[]>(`/api/tasks?project=${query}`), get<{ items: InboxItem[] }>(`/api/inbox?project=${query}`)]);
  const taken = { view, tasks, inbox: items };
  await watch(taken);
  return taken;
}

async function waitFor<T>(what: string, found: (taken: Snapshot) => T | false | undefined | Promise<T | false | undefined>): Promise<T> {
  const from = Date.now();
  note(`Waiting for ${what}`);
  for (;;) {
    const result = await found(await snapshot());
    if (result) {
      note(`Reached ${what} after ${seconds(Date.now() - from)}`);
      return result;
    }
    if (Date.now() - from > PHASE_TIMEOUT_MS) throw new Error(`Timed out waiting for ${what}`);
    await pause(POLL_MS);
  }
}

const pending = (kind: InboxRef['kind']) => ({ inbox }: Snapshot) => inbox.find(({ ref }) => ref.kind === kind);
const taskOf = (tasks: Task[], ticketId: string) => tasks.find((task) => task.ticket_id === ticketId);
const phaseOf = ({ view }: Snapshot) => view.milestones.find(({ n }) => n === MILESTONE)?.phase;

async function preflight(): Promise<boolean> {
  const setup = await aiteam('setup');
  if (setup.code !== 0) throw new Error(`setup: ${setup.output}`);

  const doctor = await aiteam('doctor');
  const failing = doctor.output.split('\n').filter((line) => line.startsWith('FAIL'));
  if (!check('1. doctor has no failing checks', doctor.code === 0, failing.join('; '))) return false;

  for (const [id, model] of Object.entries(ROLES)) {
    const { role } = await loadRole(paths.knowledge, id);
    check(`1. The ${id} role loads on ${model}`, role.defaults.model === model, role.defaults.model);
  }
  const { schema } = await loadRole(paths.knowledge, 'engineer');
  return check('1. The Engineer can raise a Change Request', JSON.stringify(schema).includes('change_requests'), 'knowledge/schemas/change_report.json');
}

async function makeProject(): Promise<void> {
  name = await freeProjectName();
  const added = await aiteam('project', 'add', name, repo, '--create');
  if (added.code !== 0) throw new Error(`project add: ${added.output}`);
  base = (await get<ProjectRow[]>('/api/projects')).find((project) => project.name === name)!.base_branch;

  // What the stakeholder's own work looks like: one committed file with an edit they haven't finished, and one git doesn't know.
  writeFileSync(join(repo, NOTES), NOTES_COMMITTED);
  await git('add', NOTES);
  const committed = await git('-c', 'user.name=Stakeholder', '-c', 'user.email=stakeholder@example.invalid', 'commit', '-m', 'Add my notes');
  if (committed.code !== 0) throw new Error(`commit: ${committed.output}`);
  writeFileSync(join(repo, NOTES), NOTES_EDITED);
  writeFileSync(join(repo, UNTRACKED), UNTRACKED_TEXT);

  baseBefore = await repoRev(base);
  headBefore = (await git('symbolic-ref', 'HEAD')).output;
  checkoutBefore = await porcelain();
  note(`Project ${name} on ${repo}, base branch ${base} at ${baseBefore}`);
}

async function checkpointOne(): Promise<void> {
  await post(`${projectApi()}/brief`, { markdown: BRIEF });
  const item = await waitFor('CP1', pending('cp1'));

  check('2. CP1 says who asks', !blank(item.asked_by), item.asked_by);
  check('2. CP1 says why', !blank(item.why), cut(item.why, 120));
  check('2. CP1 says what it blocks', item.blocks.length > 0, item.blocks.join(', '));
  check('2. CP1 gives a recommendation', !blank(item.recommendation), cut(item.recommendation, 200));
  const labels = item.evidence.map(({ label }) => label);
  check('2. CP1 has evidence of all four documents', ['ROADMAP', 'TEAM-PROPOSAL', 'HUMAN-REQUIREMENTS', 'ENV-PROFILE'].every((label) => labels.includes(label)), labels.join(', '));

  await guarded('3. The profile\'s smoke command passed in the sandbox', async () => {
    const smoke = ((await artifact('ENV-PROFILE')).fields.data as { commands: { smoke: string } }).commands.smoke;
    const { tasks } = await snapshot();
    const finished = (events: EventRow[]) => events.filter((event) => event.type === 'check.finished' && event.payload.command === smoke);
    const events = await readEvents(taskOf(tasks, 'DISCOVERY-TL')!.id, (seen) => finished(seen).length > 0, EVENTS_TIMEOUT_MS);
    check('3. The profile\'s smoke command passed in the sandbox', finished(events).at(-1)?.payload.exitCode === 0, smoke);
  });

  await answer(item, { action: 'approve' });
  const { view } = await waitFor('Milestone 1 to start', (taken) => phaseOf(taken) !== undefined && phaseOf(taken) !== 'pending' && taken);
  // The brief asks for one. A second milestone would spend on work nobody wants checked.
  if (!check('2. The Roadmap has the single milestone the brief asked for', view.milestones.length === 1, view.milestones.map(({ title }) => title).join(', '))) throw new Error('The Roadmap has more than one milestone');
}

// With no worker running this one costs nothing. The drill during build is about workers, so a pending item is checked here.
async function checkpointTwo(): Promise<void> {
  const item = await waitFor('CP2', pending('cp2'));
  const { ageS: _ageBefore, ...before } = item;

  await stopDaemonProcess('SIGKILL');
  await startDaemonProcess();
  const after = (await snapshot()).inbox.find(({ id }) => id === item.id);
  const { ageS: _ageAfter, ...still } = after ?? ({} as InboxItem);
  check('6. A pending Inbox item comes through SIGKILL unchanged', JSON.stringify(still) === JSON.stringify(before), after ? `item ${after.id}, ${after.state}` : `item ${item.id} is gone`);

  await answer(item, { action: 'approve' });
  await waitFor('design to start', (taken) => phaseOf(taken) !== 'spec' && phaseOf(taken) !== 'cp2');

  await guarded('4. CP2 locks the criteria', async () => {
    const locked = await criteria();
    check('4. CP2 locks the criteria', locked.length > 0 && locked.every(({ status, spec_version }) => status === 'unverified' && spec_version === 1), locked.map(({ ac_id, status, spec_version }) => `${ac_id} ${status} v${spec_version}`).join(', '));
    check('4. Each criterion says how it is verified', locked.every(({ verification }) => !blank(verification.method) && !blank(verification.how)), locked.map(({ ac_id, verification }) => `${ac_id} ${verification.method}`).join(', '));
    const spec = await artifact('SPEC-M1');
    check('4. The Spec is approved', spec.status === 'approved', `${spec.id}@${spec.version} ${spec.status}`);
  });
}

async function killWhileATicketRuns(): Promise<number | undefined> {
  const ticket = await waitFor('a ticket to run', ({ tasks }) => tasks.find((task) => task.kind === 'ticket' && task.state === 'running'));
  note(`Crash drill on ${ticket.ticket_id}: ${API}/tasks/${ticket.id}`);

  const seen = await readEvents(ticket.id, workerStarted, INIT_TIMEOUT_MS);
  if (!check(`6. ${ticket.ticket_id} reaches worker.init`, workerStarted(seen))) return undefined;
  const pid = (await details(ticket.id)).attempts.at(-1)?.pid;
  if (!check('6. The running attempt has a live pid', typeof pid === 'number' && pidAlive(pid), String(pid))) return undefined;

  const killedAt = Date.now();
  await stopDaemonProcess('SIGKILL');
  note(`Worker ${pid} ${pidAlive(pid!) ? 'outlived' : 'died with'} the killed daemon`);
  await startDaemonProcess();
  note(`Daemon healthy again ${seconds(Date.now() - killedAt)} after SIGKILL`);

  const deadline = Date.now() + WORKER_GONE_TIMEOUT_MS;
  while (pidAlive(pid!) && Date.now() < deadline) await pause(100);
  check('6. The old worker\'s pid is gone', !pidAlive(pid!), `${seconds(Date.now() - killedAt)} after SIGKILL`);

  const interrupted = (await details(ticket.id)).attempts.find((attempt) => attempt.pid === pid);
  check('6. The attempt it interrupted is marked', interrupted?.state === 'interrupted', `a${interrupted?.k} ${interrupted?.state}`);

  // A revision may supersede any ticket still open, so the Change Request waits until this one has proved it can finish.
  await waitFor(`${ticket.ticket_id} to finish after the crash`, async (taken) => {
    await settleTeamRequests(taken);
    return taken.tasks.some(({ id, state }) => id === ticket.id && state === 'done');
  });
  return ticket.id;
}

async function changeRequest(): Promise<void> {
  const current = await criteria();
  const target = current.find(({ text }) => /convert|fahrenheit|celsius/i.test(text)) ?? current[0];
  if (!target) throw new Error('There is no criterion to change');
  const proposed = `${target.text.replace(/[.\s]+$/, '')}. Results are printed with at most two decimal places.`;
  note(`Change Request against ${target.ac_id}, with the milestone in ${phaseOf(await snapshot())}: ${proposed}`);

  await post(`${projectApi()}/change-requests`, {
    target_artifact: 'SPEC-M1',
    target_ac: target.ac_id,
    proposed_text: proposed,
    rationale: 'Plain floating point arithmetic prints noise that nobody wants to read.',
    evidence: '36.6 Celsius is 97.88 Fahrenheit, and plain arithmetic prints 97.88000000000001.',
  });
  const item = await waitFor('the Change Request in the Inbox', pending('cr'));
  answeredRequests.add(item.id);
  check('8. The Change Request reaches the Inbox with a PM recommendation', !blank(item.recommendation), cut(item.recommendation, 240));

  // The stakeholder filed it, so the stakeholder decides, whichever way the PM leans.
  await answer(item, { action: 'approve' });
  const spec = await waitFor('SPEC-M1@2', async () => {
    const latest = await artifact('SPEC-M1');
    return latest.version >= 2 && latest;
  });
  check('8. Approving it publishes SPEC-M1@2', spec.version === 2 && spec.versions.length === 2, `${spec.id}@${spec.version}`);

  const changed = (await criteria()).find(({ ac_id }) => ac_id === target.ac_id);
  check('8. The criterion has the new text', changed?.text === proposed, cut(changed?.text, 160));
  check('8. The criterion is reset', changed?.status === 'unverified' && changed?.spec_version === 2, `${changed?.status}, spec v${changed?.spec_version}`);

  const { nodes } = await get<LineageGraph>(`${projectApi()}/lineage`);
  const stale = nodes.filter(({ status, staleSections }) => status === 'stale' || staleSections.length > 0).map(({ id }) => id);
  check('8. What depends on it is marked stale', stale.length > 0, stale.join(', '));
}

// A worker can raise one of its own while this waits. Nobody is there to read it, so the PM's recommendation stands.
async function settleTeamRequests({ inbox }: Snapshot): Promise<void> {
  for (const item of inbox) {
    if (item.ref.kind !== 'cr' || answeredRequests.has(item.id)) continue;
    answeredRequests.add(item.id);
    const approve = (item.recommendation ?? '').toLowerCase().startsWith('approve');
    note(`The team raised ${item.title}. Following the PM: ${approve ? 'approve' : 'reject'}. ${cut(item.recommendation, 240)}`);
    await answer(item, { action: approve ? 'approve' : 'reject' });
  }
}

function sectionOf(body: string, acId: string): string {
  return body.split(/\n(?=## )/).find((section) => section.startsWith(`## ${acId}\n`)) ?? '';
}

async function checkQaEvidence(): Promise<void> {
  const finished = await criteria();
  check('9. Every criterion ends passing', finished.length > 0 && finished.every(({ status }) => status === 'passing'), finished.map(({ ac_id, status }) => `${ac_id} ${status}`).join(', '));
  for (const { ac_id, evidence_ref, commands } of finished) {
    const ref = /^(QA-REPORT-M1-\d+)@(\d+)#ac-\d+$/.exec(evidence_ref ?? '');
    if (!check(`9. ${ac_id} cites a QA report`, ref !== null, String(evidence_ref))) continue;
    const { body } = await artifact(ref![1]!, Number(ref![2]));
    const section = sectionOf(body, ac_id);
    check(`9. The report says ${ac_id} passes, from the engine's run`, section.includes('Status: passing') && section.includes('Command, exit code 0:'), evidence_ref!);
    check(`9. The engine ran the Test Plan's commands for ${ac_id}`, commands.length > 0 && commands.every((command) => section.includes(command)), commands.join(' ; '));
  }
}

async function checkMainHeldUntilCp4(): Promise<void> {
  check('10. main has not moved before CP4', mainMovedEarly === '' && (await repoRev(base)) === baseBefore, mainMovedEarly || baseBefore);
  check('10. The checkout has not changed before CP4', checkoutChangedEarly === '' && (await porcelain()) === checkoutBefore, checkoutChangedEarly);
}

async function checkAfterMerge(killedTask: number | undefined): Promise<void> {
  const { tasks, inbox, view } = await snapshot();
  check('The Inbox has nothing pending', inbox.length === 0, inbox.map(({ title }) => title).join('; '));

  const tickets = tasks.filter(({ kind }) => kind === 'ticket');
  await guarded('5. Tickets and manifests', async () => {
    check('5. No ticket existed before design finished', earlyTicket === '', earlyTicket);
    check('5. Every ticket has acceptance criteria', tickets.length > 0 && tickets.every(({ ac_refs }) => ac_refs.length > 0), tickets.map(({ ticket_id, ac_refs }) => `${ticket_id}: ${ac_refs.join('+')}`).join(', '));

    const sizes = await Promise.all(tasks.flatMap((task) => [details(task.id).then(({ attempts }) => Promise.all(attempts.map(async ({ id, k }) => ({ at: `${task.ticket_id}-a${k}`, tokens: (await get<TaskManifest>(`/api/attempts/${id}/manifest`)).totalTokens }))))]));
    const all = sizes.flat();
    const largest = all.reduce((most, size) => (size.tokens > most.tokens ? size : most), { at: 'none', tokens: 0 });
    check('5. Every manifest is within 12,000 tokens', all.length > 0 && all.every(({ tokens }) => tokens <= MAX_CONTEXT_TOKENS), `${all.length} manifests, the largest is ${largest.at} at ${largest.tokens}`);
  });

  await guarded('6. The interrupted ticket finishes', async () => {
    if (killedTask === undefined) throw new Error('The drill did not run');
    const { task, attempts } = await details(killedTask);
    const first = attempts.find(({ state }) => state === 'interrupted');
    const last = attempts.at(-1);
    note(`${task.ticket_id} attempts: ${attempts.map(({ k, state }) => `a${k} ${state}`).join(', ')}`);
    check('6. The interrupted ticket finishes', task.state === 'done' && last?.state === 'succeeded', `${task.ticket_id} ${task.state}`);
    check('6. It finished in a different worktree', first !== undefined && last !== undefined && last.worktree_path !== first.worktree_path && last.worktree_path.endsWith(`/${task.ticket_id}-a${last.k}`), last?.worktree_path);
  });

  await guarded('7. Reviews', async () => {
    const merged = tickets.filter(({ state }) => state === 'done');
    check('7. Tickets were merged', merged.length > 0, merged.map(({ ticket_id }) => ticket_id).join(', '));
    for (const ticket of merged) {
      const attempt = (await details(ticket.id)).attempts.at(-1)!;
      const review = taskOf(tasks, `${ticket.ticket_id}-R${attempt.k}`);
      const reviewAttempt = review && (await details(review.id)).attempts.find(({ state }) => state === 'succeeded');
      const report = await artifact(`REVIEW-${ticket.ticket_id}-a${attempt.k}`);
      check(`7. ${ticket.ticket_id} has a Review Report from a separate attempt`, review?.state === 'done' && reviewAttempt !== undefined && reviewAttempt.id !== attempt.id && reviewAttempt.worktree_path !== attempt.worktree_path, `${report.id}@${report.version}`);
    }
  });

  check('8. The revisions ran', ['M1-REVISE-TECH-M1-1', 'M1-REVISE-TEST-PLAN-M1-1'].every((id) => taskOf(tasks, id)?.state === 'done'), tasks.filter(({ ticket_id }) => ticket_id.includes('REVISE')).map(({ ticket_id, state }) => `${ticket_id} ${state}`).join(', '));

  await guarded('10. main after CP4', async () => {
    const files = (await git('ls-tree', '-r', '--name-only', base)).output.split('\n');
    const code = files.filter((file) => file !== NOTES && !file.startsWith('.aiteam/') && file !== '');
    check('10. main holds the code', code.length > 0, code.join(', '));
    check('10. main holds .aiteam/', files.includes('.aiteam/artifacts/spec/SPEC-M1.md'), `${files.filter((file) => file.startsWith('.aiteam/')).length} files`);
    check('10. main moved forward from where it was', (await git('merge-base', baseBefore, base)).output === baseBefore && (await repoRev(base)) !== baseBefore);
    check('10. HEAD is where the stakeholder left it', (await git('symbolic-ref', 'HEAD')).output === headBefore, headBefore);
    check('10. The dirty file survives', readFileSync(join(repo, NOTES), 'utf8') === NOTES_EDITED, NOTES);
    check('10. The untracked file survives', readFileSync(join(repo, UNTRACKED), 'utf8') === UNTRACKED_TEXT, UNTRACKED);
    check('10. git still reports only the stakeholder\'s own changes', (await porcelain()) === checkoutBefore, await porcelain());
  });

  await guarded('11. node --test passes on the merged main', async () => {
    const tests = await run(process.execPath, ['--test'], repo);
    const passed = Number(/(?:#|ℹ)\s*pass\s+(\d+)/.exec(tests.output)?.[1] ?? 0);
    check('11. node --test passes on the merged main', tests.code === 0 && passed > 0, `exit ${tests.code}, ${passed} passed`);
    if (tests.code !== 0) note(tests.output);
  });

  check(`12. The estimate stayed under the $${MAX_TOTAL_USD} cap`, (view.totals.usdEst ?? 0) < MAX_TOTAL_USD, `estimate $${(view.totals.usdEst ?? 0).toFixed(2)}`);
}

// Printed whichever way the run ended, since this is what the acceptance note is written from.
async function report(): Promise<void> {
  const tasks = await get<Task[]>(`/api/tasks?project=${encodeURIComponent(name)}`);
  console.log('TASK  ticket | kind | role | state | attempts | estimate | seconds');
  for (const { ticket_id, kind, role_id, state, attempts, usdEst, seconds: taken } of tasks) console.log(`TASK  ${ticket_id} | ${kind} | ${role_id} | ${state} | ${attempts} | $${(usdEst ?? 0).toFixed(2)} | ${Math.round(taken ?? 0)}`);
  for (const task of tasks) {
    for (const { k, state, failure_kind, failure_evidence } of (await details(task.id)).attempts) {
      if (state !== 'succeeded') console.log(`ATTEMPT  ${task.ticket_id}-a${k} ${state} ${failure_kind ?? ''} ${cut(JSON.stringify(failure_evidence), 600)}`);
    }
  }
  const { totals } = await get<ProjectView>(projectApi());
  // An interrupted attempt never reports its cost, so this leaves out what the killed attempts spent.
  note(`Estimated spend $${(totals.usdEst ?? 0).toFixed(2)} over ${totals.attempts} attempts and ${Math.round(totals.seconds ?? 0)} worker seconds, leaving out interrupted attempts`);
}

async function main(): Promise<void> {
  // The API would still answer an old daemon's questions, and this run's checks would pass against it.
  if (await healthy()) throw new Error(`Something already answers on ${API}. Stop it first.`);
  await refuseUnfinishedProjects();
  if (!(await preflight())) return;

  await startDaemonProcess();
  await makeProject();
  await checkpointOne();
  await checkpointTwo();
  const killedTask = await killWhileATicketRuns();
  await changeRequest();

  const cp4 = await waitFor('CP4', async (taken) => {
    await settleTeamRequests(taken);
    return pending('cp4')(taken);
  });
  await guarded('9. QA evidence', checkQaEvidence);
  await checkMainHeldUntilCp4();

  cp4Answered = true;
  await answer(cp4, { action: 'approve' });
  await waitFor('the merge', (taken) => phaseOf(taken) === 'merged' && taken.view.phase === 'closed');

  await checkAfterMerge(killedTask);
  await report();

  if (process.argv.includes('--hold')) {
    console.log(`HOLDING  ${failures.length} failed. The daemon stays up on ${API} until this process is stopped. Project ${name}.`);
    await new Promise<void>((resolve) => {
      process.once('SIGINT', resolve);
      process.once('SIGTERM', resolve);
    });
  }
}

main()
  .catch(async (err: unknown) => {
    const reason = err instanceof Error ? err.message : String(err);
    check('The run finished', false, reason);
    if (name === '' || !(await healthy())) return;
    // A project left open would carry on spending the next time a daemon starts.
    await post(`${projectApi()}/halt`, { reason: `The acceptance run stopped: ${reason}` }).catch((error: unknown) => note(`Halting failed: ${String(error)}`));
    await report().catch((error: unknown) => note(`The report failed: ${String(error)}`));
  })
  .finally(async () => {
    await stopDaemonProcess('SIGTERM');
    note(`Left for inspection: ${scratch}`);
    console.log(failures.length === 0 ? 'M2 ACCEPTANCE PASS' : `M2 ACCEPTANCE FAIL: ${failures.join('; ')}`);
    process.exitCode = failures.length === 0 ? 0 : 1;
  });
