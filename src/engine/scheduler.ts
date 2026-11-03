import { loadRole } from '../roles/role.ts';
import type { Conductor } from './conductor/index.ts';
import { isClosed, isTerminal } from './conductor/tasks.ts';
import type { TaskState } from './fsm.ts';
import type { EngineDeps, Runner } from './runner.ts';
import type { TaskRow } from './store.ts';

const DEFAULT_INTERVAL_MS = 1000;
const GLOB_CHARS = /[*?[{!(]/;
// A ticket in review still has work on its way to the integration branch, so another ticket on those paths must wait for it.
const HOLDS_LOCK: TaskState[] = ['running', 'checks', 'review'];
// A worker is still on it. A probe past this has already found out what the vendor answers.
const WORKING: TaskState[] = ['running', 'checks'];
const FINISHED: TaskState[] = ['done', 'cancelled'];
// Something other than the scheduler lets these go: a person, or the conductor once a Change Request is decided.
const WAITS_ON_OTHERS = ['human_request', 'change_request'];

// The filesystem here folds case, so the comparison does too: a false positive only serializes two tickets.
function fixedSegments(glob: string): string[] {
  const segments = glob.toLowerCase().split('/').filter((s) => s !== '' && s !== '.');
  const firstGlob = segments.findIndex((s) => GLOB_CHARS.test(s));
  return firstGlob === -1 ? segments : segments.slice(0, firstGlob);
}

export function globsMayOverlap(a: string, b: string): boolean {
  const [shorter, longer] = [fixedSegments(a), fixedSegments(b)].sort((x, y) => x.length - y.length) as [string[], string[]];
  return shorter.every((segment, i) => segment === longer[i]);
}

function overlaps(a: TaskRow, b: TaskRow): boolean {
  return a.project_id === b.project_id && a.touches.some((x) => b.touches.some((y) => globsMayOverlap(x, y)));
}

const doneKey = (projectId: number, ticketId: string) => `${projectId}/${ticketId}`;

// Reviews finish what is already written, and bugs and the planning tasks unblock everything else.
function rankOf(task: TaskRow): number {
  if (task.kind === 'code_review') return 0;
  return task.kind !== 'ticket' || task.ticket_id.includes('-B-') ? 1 : 2;
}

// How many unfinished tasks wait behind each task, along the longest path.
function chainLengths(tasks: TaskRow[]): Map<number, number> {
  const dependents = new Map<string, TaskRow[]>();
  for (const task of tasks) {
    if (FINISHED.includes(task.state)) continue;
    for (const id of task.depends_on) {
      const key = doneKey(task.project_id, id);
      dependents.set(key, [...(dependents.get(key) ?? []), task]);
    }
  }

  const lengths = new Map<number, number>();
  const lengthOf = (task: TaskRow, path: Set<number>): number => {
    const known = lengths.get(task.id);
    if (known !== undefined) return known;
    const next = new Set(path).add(task.id);
    const behind = (dependents.get(doneKey(task.project_id, task.ticket_id)) ?? []).filter(({ id }) => !next.has(id));
    const length = Math.max(0, ...behind.map((dependent) => 1 + lengthOf(dependent, next)));
    lengths.set(task.id, length);
    return length;
  };
  for (const task of tasks) lengthOf(task, new Set());
  return lengths;
}

export function priorityOrder(tasks: TaskRow[]): TaskRow[] {
  const chains = chainLengths(tasks);
  return [...tasks].sort((a, b) => rankOf(a) - rankOf(b) || chains.get(b.id)! - chains.get(a.id)! || a.id - b.id);
}

export class Scheduler {
  private ticking: Promise<void> | undefined;
  private timer: NodeJS.Timeout | undefined;
  // The task testing each vendor after a pause ran out, so that only one finds out at a time.
  private readonly probes = new Map<string, number>();

  constructor(
    private readonly deps: EngineDeps,
    private readonly runner: Runner,
    private readonly conductor?: Pick<Conductor, 'tick'>,
  ) {}

  tick(): Promise<void> {
    this.ticking ??= this.runTick().finally(() => {
      this.ticking = undefined;
    });
    return this.ticking;
  }

  start(intervalMs: number = DEFAULT_INTERVAL_MS): void {
    this.timer ??= setInterval(() => {
      // The next tick reads everything afresh, so a failed one only costs an interval.
      this.tick().catch((err: unknown) => console.error('Scheduler tick failed:', err));
    }, intervalMs);
  }

  async stop(): Promise<void> {
    clearInterval(this.timer);
    this.timer = undefined;
    await this.ticking?.catch(() => {});
  }

  private async runTick(): Promise<void> {
    const { store, config } = this.deps;
    // Before the tasks are read, so that what it queues can start on this tick. Tasks already queued must not wait for it to recover.
    try {
      await this.conductor?.tick();
    } catch (err) {
      console.error('The conductor failed:', err);
    }

    // A conductor tick under way when a project halted can queue a task after the halt swept the project.
    const stopped = new Set((await store.listProjects()).filter(isTerminal).map(({ id }) => id));
    const everyTask = await store.listTasks();
    for (const task of everyTask) if (stopped.has(task.project_id) && !isClosed(task)) await this.runner.cancel(task.id);

    const tasks = everyTask.filter((task) => !stopped.has(task.project_id));
    const keysIn = (state: TaskState) => new Set(tasks.filter((t) => t.state === state).map((t) => doneKey(t.project_id, t.ticket_id)));
    const done = keysIn('done');
    const cancelled = keysIn('cancelled');
    const holders = tasks.filter((t) => HOLDS_LOCK.includes(t.state));
    const ready: TaskRow[] = [];

    for (const task of tasks) {
      if (task.state === 'ready') {
        ready.push(task);
      } else if (task.state === 'queued' || (task.state === 'blocked' && !WAITS_ON_OTHERS.includes(task.blocked_on ?? ''))) {
        // Nothing would ever finish this dependency, so waiting for it would hold up the milestone with nobody told.
        const gone = task.depends_on.filter((id) => cancelled.has(doneKey(task.project_id, id)));
        if (gone.length > 0) {
          await store.setTaskState(task.id, 'escalated', { reason: `dependency_cancelled: ${gone.join(', ')}` });
          continue;
        }
        const blockedOn = !task.depends_on.every((id) => done.has(doneKey(task.project_id, id)))
          ? 'dependency'
          : holders.some((holder) => overlaps(holder, task))
            ? 'path_lock'
            : undefined;
        if (blockedOn === undefined) ready.push(await store.setTaskState(task.id, 'ready'));
        else if (task.state !== 'blocked' || task.blocked_on !== blockedOn) await this.block(task, blockedOn);
      }
    }

    const position = new Map(priorityOrder(tasks).map(({ id }, i) => [id, i]));
    ready.sort((a, b) => position.get(a.id)! - position.get(b.id)!);

    for (const task of ready) {
      if (this.runner.liveCount() >= config.maxWorkers) break;
      if (holders.some((holder) => overlaps(holder, task))) {
        await this.block(task, 'path_lock');
      } else if (await this.startIfAllowed(task)) {
        holders.push(task);
      }
    }
  }

  // The state machine has no blocked → blocked, so a change of reason passes through ready.
  private async block(task: TaskRow, blockedOn: string): Promise<void> {
    if (task.state === 'blocked') await this.deps.store.setTaskState(task.id, 'ready');
    await this.deps.store.setTaskState(task.id, 'blocked', { blockedOn });
  }

  private async startIfAllowed(task: TaskRow): Promise<boolean> {
    const vendor = await this.vendorOf(task);
    if (vendor !== undefined && !(await this.vendorOpen(vendor, task))) return false;
    try {
      await this.runner.begin(task.id);
    } catch (err) {
      // One task that can't start must not hold up the rest. The next tick looks at it again.
      console.error(`Could not start task ${task.id}:`, err);
      return false;
    }
    void this.runner.execute(task.id);
    return true;
  }

  // Undefined when the role can't be read: the runner is what escalates that, so the task goes on to it.
  private async vendorOf(task: TaskRow): Promise<string | undefined> {
    const { paths, adapters } = this.deps;
    try {
      const { role } = await loadRole(paths.knowledge, task.role_id);
      return adapters[role.defaults.adapter]?.vendor;
    } catch {
      return undefined;
    }
  }

  private async vendorOpen(vendor: string, task: TaskRow): Promise<boolean> {
    const { store, now } = this.deps;
    const pause = await store.getVendorPause(vendor);
    if (!pause) return true;
    if (Date.parse(pause.until) > (now?.() ?? new Date()).getTime()) return false;

    const probe = this.probes.get(vendor);
    if (probe !== undefined) {
      const state = (await store.getTask(probe))?.state;
      if (state !== undefined && WORKING.includes(state)) return false;
    }
    this.probes.set(vendor, task.id);
    return true;
  }
}
