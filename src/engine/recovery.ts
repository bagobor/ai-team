import { pruneGitWorktrees } from '../git/workspace.ts';
import { groupAlive, killGroup, processStartTime } from '../proc.ts';
import type { TaskState } from './fsm.ts';
import type { EngineDeps } from './runner.ts';
import type { AttemptRow } from './store.ts';

// A task here has nothing working on it once the daemon has died.
const NEEDS_A_WORKER: TaskState[] = ['running', 'checks'];

// A pid can come back as someone else's process, so its start time must match. With no process at that pid,
// a group still alive is what the worker left behind: the system won't reuse a pid while its group exists.
async function stillOurs(attempt: AttemptRow): Promise<boolean> {
  if (attempt.pid === null) return false;
  const started = await processStartTime(attempt.pid);
  return started === null ? groupAlive(attempt.pid) : started === attempt.pid_started_at;
}

export async function recover(deps: EngineDeps): Promise<{ interrupted: number; killed: number }> {
  const { store, log, config } = deps;
  let killed = 0;
  const attempts = await store.listLiveAttempts();

  for (const attempt of attempts) {
    const ours = await stillOurs(attempt);
    if (ours) {
      await killGroup(attempt.pid!, config.cancelGraceS);
      killed += 1;
    }
    await store.setAttemptState(attempt.id, 'interrupted');
    const task = await store.getTask(attempt.task_id);
    await log.append({
      projectId: task?.project_id ?? null,
      taskId: attempt.task_id,
      attemptId: attempt.id,
      type: 'recovery.interrupted',
      payload: { attemptId: attempt.id, killed: ours },
    });
  }

  // Not only the tasks of the attempts above: a crash can fall before an attempt exists or after it ended.
  for (const task of await store.listTasks()) {
    if (NEEDS_A_WORKER.includes(task.state)) await store.setTaskState(task.id, 'ready');
  }

  for (const project of await store.listProjects()) {
    await pruneGitWorktrees(project.repo_path).catch((err: unknown) => {
      console.error(`Could not prune the worktrees of ${project.name}:`, err);
    });
  }

  return { interrupted: attempts.length, killed };
}
