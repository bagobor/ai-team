import { loadRole } from '../roles/role.ts';
import type { TaskState } from './fsm.ts';
import type { EngineDeps, Runner } from './runner.ts';
import type { TaskRow } from './store.ts';

const DEFAULT_INTERVAL_MS = 1000;
const GLOB_CHARS = /[*?[{!(]/;
const HOLDS_LOCK: TaskState[] = ['running', 'checks'];

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

export class Scheduler {
  private ticking: Promise<void> | undefined;
  private timer: NodeJS.Timeout | undefined;
  // The task testing each vendor after a pause ran out, so that only one finds out at a time.
  private readonly probes = new Map<string, number>();

  constructor(
    private readonly deps: EngineDeps,
    private readonly runner: Runner,
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
    const tasks = await store.listTasks();
    const done = new Set(tasks.filter((t) => t.state === 'done').map((t) => doneKey(t.project_id, t.ticket_id)));
    const holders = tasks.filter((t) => HOLDS_LOCK.includes(t.state));
    const ready: TaskRow[] = [];

    for (const task of tasks) {
      if (task.state === 'ready') {
        ready.push(task);
      } else if (task.state === 'queued' || (task.state === 'blocked' && task.blocked_on !== 'human_request')) {
        const blockedOn = !task.depends_on.every((id) => done.has(doneKey(task.project_id, id)))
          ? 'dependency'
          : holders.some((holder) => overlaps(holder, task))
            ? 'path_lock'
            : undefined;
        if (blockedOn === undefined) ready.push(await store.setTaskState(task.id, 'ready'));
        else if (task.state !== 'blocked' || task.blocked_on !== blockedOn) await this.block(task, blockedOn);
      }
    }

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
      if (state !== undefined && HOLDS_LOCK.includes(state)) return false;
    }
    this.probes.set(vendor, task.id);
    return true;
  }
}
