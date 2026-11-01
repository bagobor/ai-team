import type { EngineDeps, Runner } from '../runner.ts';
import type { ProjectRow } from '../store.ts';
import { applyAnswers } from './answers.ts';
import { advanceChangeRequests } from './change-requests.ts';
import { raiseEscalations } from './escalations.ts';
import { advanceMilestone } from './milestone.ts';
import { advanceProject } from './project.ts';
import { advanceReviews } from './reviews.ts';
import { isTerminal, raiseHold, RETRY_OR_HALT } from './tasks.ts';

export { haltProject } from './tasks.ts';

// Code runs the workflow: every tick reads the rows, takes each project one step on, and never asks a model what to do next.
export class Conductor {
  // Only in memory, so a restart logs a stuck error once more. It keeps a stuck project from writing an event every second.
  private readonly lastError = new Map<number, string>();

  constructor(
    private readonly deps: EngineDeps,
    private readonly runner: Runner,
  ) {}

  async tick(): Promise<void> {
    for (const { id, phase } of await this.deps.store.listProjects()) {
      if (isTerminal({ phase })) continue;
      try {
        await this.advance(id);
        this.lastError.delete(id);
      } catch (error) {
        await this.report(id, error);
      }
    }
  }

  private async fresh(id: number): Promise<ProjectRow | undefined> {
    const project = await this.deps.store.getProjectById(id);
    return project && !isTerminal(project) ? project : undefined;
  }

  private async advance(id: number): Promise<void> {
    const { deps, runner } = this;
    const start = await this.fresh(id);
    if (!start) return;
    await applyAnswers(deps, runner, start);

    const answered = await this.fresh(id);
    if (!answered) return;
    const errors = await deps.store.inboxByPrefix(id, 'engine_error:');
    if (errors.some(({ state }) => state === 'pending')) return;

    const steps: ((project: ProjectRow) => Promise<void>)[] = [
      (project) => advanceProject(deps, project),
      (project) => advanceChangeRequests(deps, runner, project),
      (project) => advanceMilestone(deps, runner, project),
      (project) => advanceReviews(deps, runner, project),
      (project) => raiseEscalations(deps, project),
    ];
    for (const step of steps) {
      const project = await this.fresh(id);
      if (!project) return;
      await step(project);
    }
  }

  // One project's failure stays with that project, and a failure in reporting it must not stop the others.
  private async report(id: number, error: unknown): Promise<void> {
    const message = error instanceof Error ? error.message : String(error);
    try {
      const project = await this.fresh(id);
      if (!project) return;
      if (this.lastError.get(id) !== message) {
        this.lastError.set(id, message);
        await this.deps.store.logEvent(id, 'conductor.error', { message });
      }
      await raiseHold(this.deps.store, project, 'engine_error', {
        type: 'question',
        ref: { kind: 'engine_error' },
        title: `The engine hit an error on ${project.name}`,
        asked_by: 'engine',
        why: message,
        blocks: ['This project'],
        evidence: [],
        recommendation: 'Look at the error, then retry once it has been dealt with. Nothing moves on this project until you answer.',
        options: RETRY_OR_HALT,
      });
    } catch {
      // The next tick reports it again.
    }
  }
}
