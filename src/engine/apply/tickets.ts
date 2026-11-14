import picomatch from 'picomatch';
import { ArtifactError, formatPin, parsePin, renderArtifact, sectionText } from '../../artifacts/format.ts';
import type { NewVersion } from '../../artifacts/store.ts';
import { loadRole } from '../../roles/role.ts';
import { parseTicket, TicketError, type Ticket } from '../../tickets/ticket.ts';
import { mustSupportPins } from '../conductor/tasks.ts';
import { specId } from './ids.ts';
import type { ApplyCtx } from './index.ts';
import type { ComponentSpec } from './tech-structure.ts';
import { oneLine } from './text.ts';

// Only the Eng Lead's schemas ask for components, so a harness ticket from a Test Plan, or a Bug's ticket, has none.
export type TicketDraft = Omit<Ticket, 'id' | 'milestone' | 'components'> & { key: string; components?: string[] };

// The document a batch of tickets comes with and the role that owns them. A batch with components holds each ticket to
// the Tech Design's. E is an eng review's polish, which can be about the code alone and so may name no criterion.
export type TicketBatch = { prefix: 'T' | 'Q' | 'E'; docId: string; owner: string; components?: ComponentSpec[] };

export const ticketIdFor = (milestone: number, key: string): string => `M${milestone}-${key}`;

export function renderTicket(milestone: number, draft: TicketDraft, ids: { id: string; dependsOn: string[]; inputs: string[] }): { fields: Record<string, unknown>; body: string } {
  const { title, ac_refs, specialty, touches, definition_of_done, size, components, body } = draft;
  // The hooks hold a ticket to its components by name, so each is stored once, trimmed, as validation matched it.
  const names = components === undefined ? {} : { components: [...new Set(components.map((name) => name.trim()))] };
  return { fields: { title, milestone, ac_refs, specialty, touches, depends_on: ids.dependsOn, definition_of_done, inputs: ids.inputs, size, ...names }, body };
}

// The tests a ticket's components keep, which the engine's hooks hold its change to.
function withTests(body: string, named: ComponentSpec[]): string {
  const lines = named.map(({ name, tests, no_tests_reason }) => `- ${oneLine(name.trim())}: ${tests.length > 0 ? tests.map(oneLine).join(', ') : `no tests (${oneLine(no_tests_reason ?? '')})`}`);
  const head = body.trimEnd();
  return `${head === '' ? '' : `${head}\n\n`}## Tests\n\n${lines.join('\n')}\n`;
}

export const HELD_TO_TESTS = "The engine refuses an attempt that changes a component's sources without changing that component's tests.";

// A Bug's ticket names no components, yet the hooks hold its change to every one, so it lists each one's sources beside its tests.
export function withComponentTests(body: string, components: ComponentSpec[]): string {
  const globs = (list: string[]) => list.map(oneLine).join(', ');
  const lines = components.map(({ name, sources, tests, no_tests_reason }) => `- ${oneLine(name.trim())}: sources ${globs(sources)} — ${tests.length > 0 ? `tests ${globs(tests)}` : `no tests (${oneLine(no_tests_reason ?? '')})`}`);
  const head = body.trimEnd();
  return `${head === '' ? '' : `${head}\n\n`}## Tests\n\n${HELD_TO_TESTS}\n\n${lines.join('\n')}\n`;
}

const isAimedAtStateFolder = (glob: string): boolean => {
  const matches = picomatch(glob, { dot: true, nocase: true });
  // ** matches the state folder too, and is fine: only a glob that singles it out says the ticket means to work there.
  return (matches('.aiteam/x') || matches('.aiteam')) && !matches('zz-other/x');
};

export function touchesProblem(glob: string): string | undefined {
  const path = glob.replaceAll('\\', '/').replace(/^(?:\.\/)+/, '');
  if (path.trim() === '') return 'is blank';
  if (/^(?:\/|~|[A-Za-z]:)/.test(path)) return 'is absolute';
  if (path.split('/').includes('..')) return 'contains ..';
  if (isAimedAtStateFolder(path)) return 'names the state folder';
  return undefined;
}

// The ids in a cycle: what is left once everything that can be finished in order has been taken away.
function cycleAmong(graph: Map<string, string[]>): string[] {
  const left = new Map(graph);
  for (;;) {
    const free = [...left.keys()].filter((id) => !left.get(id)!.some((dep) => left.has(dep)));
    if (free.length === 0) return [...left.keys()];
    for (const id of free) left.delete(id);
  }
}

type Batch = { id: string; version: number; body: string };

async function pinnedInput(ctx: ApplyCtx, input: string, batch: Batch | undefined): Promise<string> {
  const pin = parsePin(input);
  if (batch && pin.id === batch.id && (pin.version === undefined || pin.version === batch.version)) {
    if (pin.section !== undefined && sectionText(batch.body, pin.section) === undefined) throw new ArtifactError(`${formatPin(pin)} names a section that the document it comes with does not have`);
    return formatPin({ ...pin, version: batch.version });
  }
  return (await ctx.deps.artifacts.readInput(ctx.project, input)).pin;
}

// Models wrote every field here, and each one becomes a task the engine runs. batchBody is the body of the document the
// tickets come with, which a ticket may name as an input before it exists.
export async function validateTickets(
  ctx: ApplyCtx,
  milestone: number,
  drafts: TicketDraft[],
  acIds: string[],
  existing: string[],
  { prefix, docId, owner, components }: TicketBatch,
  batchBody?: string,
): Promise<{ ok: true; docs: NewVersion[] } | { ok: false; evidence: string }> {
  const { artifacts, paths } = ctx.deps;
  const problems: string[] = [];
  const keyPattern = new RegExp(`^${prefix}-\\d+$`);
  const known = new Map(existing.map((id) => [id.toLowerCase(), id]));

  const spec = await artifacts.latest(ctx.project.id, specId(milestone));
  if (!spec) throw new Error(`Milestone ${milestone} has tickets but no ${specId(milestone)}`);
  const latest = await artifacts.latest(ctx.project.id, docId);
  // Every ticket is built against the must-support list in force, whatever else it names.
  const [listPin] = await mustSupportPins(ctx.deps, ctx.project);
  const batch = batchBody === undefined ? undefined : { id: docId, version: (latest?.version ?? 0) + 1, body: batchBody };

  const batchIds = new Map<string, string>();
  for (const { key } of drafts) if (keyPattern.test(key)) batchIds.set(key, ticketIdFor(milestone, key));
  const inBatch = new Set(batchIds.values());

  const resolveDependency = (dep: string): string | undefined => batchIds.get(dep) ?? (inBatch.has(dep) ? dep : (known.get(dep.toLowerCase()) ?? known.get(ticketIdFor(milestone, dep).toLowerCase())));

  const specialties = new Map<string, boolean>();
  const canEdit = async (specialty: string): Promise<boolean> => {
    let result = specialties.get(specialty);
    if (result === undefined) {
      result = await loadRole(paths.knowledge, specialty).then(
        ({ role }) => role.tools.includes('edit_repo'),
        () => false,
      );
      specialties.set(specialty, result);
    }
    return result;
  };

  const seen = new Set<string>();
  const docs: NewVersion[] = [];
  const graph = new Map<string, string[]>();

  for (const draft of drafts) {
    const say = (problem: string) => problems.push(`Ticket ${draft.key}: ${problem}`);

    if (!keyPattern.test(draft.key)) {
      say(`key must look like ${prefix}-1`);
      continue;
    }
    if (seen.has(draft.key)) {
      say('duplicate key');
      continue;
    }
    seen.add(draft.key);

    const id = ticketIdFor(milestone, draft.key);
    if (known.has(id.toLowerCase())) say(`${id} already exists`);
    if (draft.title.trim() === '') say('the title is blank');

    const dependsOn: string[] = [];
    for (const dep of draft.depends_on) {
      const resolved = resolveDependency(dep);
      if (resolved === undefined) say(`depends on ${dep}, which does not exist`);
      else dependsOn.push(resolved);
    }
    graph.set(id, dependsOn);

    if (!(await canEdit(draft.specialty))) say(`specialty ${draft.specialty} can't edit the repository`);

    if (draft.touches.length === 0) say('touches is empty');
    for (const glob of draft.touches) {
      const problem = touchesProblem(glob);
      if (problem) say(`touches ${JSON.stringify(glob)} ${problem}`);
    }

    if (draft.ac_refs.length === 0 && prefix !== 'E') say('ac_refs is empty');
    for (const ac of draft.ac_refs) if (!acIds.includes(ac)) say(`ac_refs names ${ac}, which this milestone does not have`);

    const named: ComponentSpec[] = [];
    if (components) {
      if ((draft.components ?? []).length === 0) say('components is empty');
      // Names are matched trimmed, so one spelt twice with different spacing is one component.
      for (const name of new Set((draft.components ?? []).map((name) => name.trim()))) {
        const component = components.find((candidate) => candidate.name.trim() === name);
        if (component) named.push(component);
        else say(`components names ${JSON.stringify(name)}, which the Tech Design does not have`);
      }
    }

    if (draft.definition_of_done.length === 0 || draft.definition_of_done.some((command) => command.trim() === '')) say('definition_of_done needs at least one command, and no blank ones');

    const inputs: string[] = [];
    for (const input of draft.inputs) {
      try {
        inputs.push(await pinnedInput(ctx, input, batch));
      } catch (err) {
        if (!(err instanceof ArtifactError)) throw err;
        say(`input ${input} does not resolve: ${err.message}`);
      }
    }
    if (listPin !== undefined && !inputs.includes(listPin)) inputs.push(listPin);

    const { fields, body: text } = renderTicket(milestone, draft, { id, dependsOn, inputs });
    const body = components ? withTests(text, named) : text;
    try {
      parseTicket(renderArtifact({ id, type: 'ticket', version: 1, status: 'approved', ownerRole: owner, derivedFrom: [], acceptanceCriteria: [], approvedBy: null, approvedAt: null, fields, body }));
    } catch (err) {
      if (!(err instanceof TicketError)) throw err;
      say(err.message);
    }

    const criteria = draft.ac_refs.map((ac) => `${specId(milestone)}@${spec.version}#${ac.toLowerCase()}`);
    docs.push({ id, type: 'ticket', status: 'approved', ownerRole: owner, approvedBy: `owner:${owner}`, milestone, derivedFrom: [...new Set([docId, ...criteria, ...inputs])], fields, body });
  }

  const cycle = cycleAmong(new Map([...graph].map(([id, deps]) => [id, deps.filter((dep) => graph.has(dep))])));
  if (cycle.length > 0) problems.push(`Ticket ${cycle.join(', ')}: dependency cycle`);

  return problems.length > 0 ? { ok: false, evidence: problems.join('\n') } : { ok: true, docs };
}
