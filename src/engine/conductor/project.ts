import { ENV_PROFILE } from '../apply/ids.ts';
import type { EngineDeps } from '../runner.ts';
import type { ProjectRow } from '../store.ts';
import { advanceMustSupport, type MsState } from './must-support.ts';
import { advancePrototype } from './prototype.ts';
import { discoveryDocs, discoveryInputs, discoveryTask, ensureTask, noteOf, pinOf, profileTask, protoPlanInputs, protoPlanTask, roundId, roundOf } from './tasks.ts';

// Nothing starts until the stakeholder has approved what the game must run on.
async function intake(deps: EngineDeps, project: ProjectRow, { approved, pending }: MsState): Promise<void> {
  if (!approved || pending) return;
  // A prototyping project finds its fun before discovery, so discovery can write it down.
  if (project.prototyping === 1) {
    const inputs = await protoPlanInputs(deps, project);
    await deps.store.atomically(async (s) => {
      await ensureTask(s, protoPlanTask(project, 1, inputs));
      await s.setProjectPhase(project.id, 'prototype');
    });
    return;
  }
  const inputs = await discoveryInputs(deps, project);
  await deps.store.atomically(async (s) => {
    await ensureTask(s, discoveryTask(project, 1, inputs.pm));
    await ensureTask(s, profileTask(project, 1, inputs.profile));
    await s.setProjectPhase(project.id, 'discovery');
  });
}

async function discovery(deps: EngineDeps, project: ProjectRow): Promise<void> {
  const { store, artifacts } = deps;
  const tasks = await store.listTasks(project.id);
  const round = roundOf(tasks, 'DISCOVERY-PM');
  const pm = tasks.find(({ ticket_id }) => ticket_id === roundId('DISCOVERY-PM', round));
  const profile = tasks.find(({ ticket_id }) => ticket_id === roundId('DISCOVERY-TL', round));
  if (pm?.state !== 'done' || profile?.state !== 'done') return;

  const rows = await Promise.all([...(await discoveryDocs(deps, project)), ENV_PROFILE].map(async (id) => {
    const row = await artifacts.latest(project.id, id);
    if (!row) throw new Error(`Discovery finished without ${id}`);
    return row;
  }));
  const notes = [await noteOf(store, pm.id), await noteOf(store, profile.id)].filter((note) => note !== '');
  const roadmap = rows[0]!;

  await store.atomically(async (s) => {
    await s.raiseInbox({
      project_id: project.id,
      type: 'approval',
      dedupe_key: `cp1:${roadmap.version}`,
      ref: { kind: 'cp1' },
      title: 'Approve the Roadmap and the team for this project',
      asked_by: 'pm',
      why: 'Discovery is finished. No milestone starts until you approve what it produced.',
      blocks: ['Milestone 1'],
      evidence: rows.map((row) => ({ label: row.artifact_id, value: pinOf(row), pin: pinOf(row) })),
      recommendation: notes.join('\n\n'),
      options: [],
    });
    await s.setProjectPhase(project.id, 'cp1');
  });
}

export async function advanceProject(deps: EngineDeps, project: ProjectRow): Promise<void> {
  const ms = await advanceMustSupport(deps, project);
  if (project.phase === 'intake') await intake(deps, project, ms);
  else if (project.phase === 'prototype') await advancePrototype(deps, project, ms);
  else if (project.phase === 'discovery') await discovery(deps, project);
}
