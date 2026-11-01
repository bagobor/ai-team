import { homedir } from 'node:os';
import type { CommandEnv } from '../../checks/run-checks.ts';
import { workerDenyRead } from '../../paths.ts';
import type { ApplyCtx } from './index.ts';

// What an applier's own commands run under: a worker's sandbox, with no network.
export function sandboxEnv(ctx: ApplyCtx, worktree: string = ctx.worktree): CommandEnv & { onEvent: ApplyCtx['report']['onEvent'] } {
  const { paths, config } = ctx.deps;
  return {
    worktree,
    repoPath: ctx.project.repo_path,
    denyRead: workerDenyRead(paths, homedir()),
    timeoutS: config.checkTimeoutS,
    signal: ctx.signal,
    onEvent: ctx.report.onEvent,
    onSpawn: ctx.report.onSpawn,
  };
}
