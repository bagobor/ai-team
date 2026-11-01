import { resolve } from 'node:path';
import { ArtifactStore } from '../artifacts/store.ts';
import { commitArtifact, initStateRepo } from '../git/state-repo.ts';
import { prepareRepo } from '../git/workspace.ts';
import { stateRepoDir, type Paths } from '../paths.ts';
import { loadRole } from '../roles/role.ts';
import { parseTicket, SAFE_ID, TicketError } from '../tickets/ticket.ts';
import type { ProjectRow, Store, TaskRow } from './store.ts';

export type IntakeDeps = { store: Store; paths: Paths };

const sameId = (a: string, b: string) => a.toLowerCase() === b.toLowerCase(); // These ids name files, and macOS ignores case.

// The caller's input can't make a project: a bad name, or a path that can't be a repo.
export class ProjectError extends Error {}

// A name that is already taken, for a project or a ticket.
export class DuplicateError extends TicketError {}

export async function addProject(deps: IntakeDeps, input: { name: string; repoPath: string; create: boolean }): Promise<ProjectRow> {
  const { name, repoPath, create } = input;
  if (!SAFE_ID.test(name)) throw new ProjectError(`"${name}" is not a valid project name`);

  const existing = (await deps.store.listProjects()).find((project) => sameId(project.name, name));
  if (existing) throw new DuplicateError(`A project named ${existing.name} already exists`);

  const { baseBranch } = await prepareRepo(repoPath, { create }).catch((cause: unknown) => {
    throw new ProjectError(cause instanceof Error ? cause.message : String(cause), { cause });
  });
  await initStateRepo(stateRepoDir(deps.paths, name));
  return deps.store.createProject({ name, repo_path: resolve(repoPath), base_branch: baseBranch });
}

export async function addTicket(deps: IntakeDeps, projectName: string, markdown: string): Promise<TaskRow> {
  const project = await deps.store.getProject(projectName);
  if (!project) throw new Error(`Unknown project ${projectName}`);

  const ticket = parseTicket(markdown);
  const tasks = await deps.store.listTasks(project.id);

  const duplicate = tasks.find((task) => sameId(task.ticket_id, ticket.id));
  if (duplicate) throw new DuplicateError(`Ticket ${duplicate.ticket_id} already exists in ${project.name}`);

  // Requiring tickets that are already imported rules out cycles.
  for (const dependency of ticket.depends_on) {
    if (!tasks.some((task) => task.ticket_id === dependency)) {
      throw new TicketError(`Ticket ${ticket.id} depends on ${dependency}, which has not been imported`);
    }
  }

  const { role } = await loadRole(deps.paths.knowledge, ticket.specialty).catch((cause: unknown) => {
    throw new TicketError(`Ticket ${ticket.id} has the specialty ${ticket.specialty}, which no usable role provides`, { cause });
  });
  if (!role.tools.includes('edit_repo')) throw new TicketError(`Ticket ${ticket.id} has the specialty ${ticket.specialty}, which cannot edit the repo`);

  const artifacts = new ArtifactStore(deps.store, deps.paths);
  for (const pin of ticket.inputs) {
    await artifacts.readInput(project, pin).catch((cause: unknown) => {
      throw new TicketError(`Ticket ${ticket.id} has the input ${pin}, which does not resolve`, { cause });
    });
  }

  const ticketPath = `artifacts/ticket/${ticket.id}.md`;
  const { sha } = await commitArtifact(stateRepoDir(deps.paths, project.name), ticketPath, markdown, `ticket: ${ticket.id}`);

  return deps.store.createTask({
    project_id: project.id,
    ticket_id: ticket.id,
    title: ticket.title,
    milestone: ticket.milestone,
    role_id: ticket.specialty,
    ticket_path: ticketPath,
    ticket_sha: sha,
    touches: ticket.touches,
    depends_on: ticket.depends_on,
    dod: ticket.definition_of_done,
  });
}
