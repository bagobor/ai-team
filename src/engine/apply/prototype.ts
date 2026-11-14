import { renderArtifact, sectionsOf } from '../../artifacts/format.ts';
import type { NewVersion } from '../../artifacts/store.ts';
import { keyProblem } from '../../checks/play.ts';
import { parseTicket } from '../../tickets/ticket.ts';
import { mustSupportItems } from '../conductor/tasks.ts';
import { checkedBy, itemLine, type MsItem } from '../must-support.ts';
import { ownedDoc } from './design.ts';
import type { Gap } from './gaps.ts';
import { PROTO_PLAN_ID, protoPlanId, protoRoot, protoTicketId } from './ids.ts';
import type { Applier, ApplyCtx } from './index.ts';
import { withRaised } from './raised.ts';
import { headed } from './tech-structure.ts';
import { oneLine } from './text.ts';
import { renderTicket } from './tickets.ts';

type Hypothesis = { id: string; element: string; rationale: string; look_for: string };
// `must_support` says how the prototype meets each item on where the game runs. A plan from before the list has none.
type Prototype = { key: string; title: string; hypotheses: string[]; build: string; controls: string[]; must_support?: { item: string; how: string }[] };
type PlanOutput = { hypotheses: Hypothesis[]; prototypes: Prototype[]; stakeholder_note: string; gaps?: Gap[] };

const MAX_PROTOTYPES = 3;
const HYPOTHESIS_ID = /^H-\d+$/;
const blank = (text: string): boolean => text.trim() === '';
const keyOf = (index: number): string => `P-${index + 1}`;
const controlsOf = (controls: string[]): string => (controls.length > 0 ? controls.join(', ') : 'none');

// The round is the task's, not the model's: the conductor makes one PROTO-PLAN-r task for each.
function roundOf(ctx: ApplyCtx): number {
  const match = PROTO_PLAN_ID.exec(ctx.task.ticket_id);
  if (!match) throw new Error(`Task ${ctx.task.ticket_id} is not a prototype round`);
  return Number(match[1]);
}

// A model wrote all of it. The schema keeps the shapes right, so these are the rules a schema cannot say. Each problem is a
// line that names what to fix, and a hypothesis or prototype is named by its place in the list, since its own id may be the problem.
// `ms` is the approved must-support list: every prototype says how it meets each item on where the game runs, unless
// the plan names that item in gaps.
export function planProblems({ hypotheses, prototypes, gaps = [] }: PlanOutput, ms: MsItem[]): string[] {
  const problems: string[] = [];
  if (prototypes.length < 1 || prototypes.length > MAX_PROTOTYPES) problems.push(`A round has 1 to ${MAX_PROTOTYPES} prototypes, not ${prototypes.length}`);
  const runsOn = ms.filter(({ group }) => group === 'runs_on').map(({ id }) => id);

  const defined = new Set<string>();
  hypotheses.forEach((hypothesis, index) => {
    const say = (problem: string) => problems.push(`Hypothesis ${index + 1}: ${problem}`);
    if (!HYPOTHESIS_ID.test(hypothesis.id)) say(`id ${JSON.stringify(hypothesis.id)} must look like H-1`);
    else if (defined.has(hypothesis.id)) say(`id ${hypothesis.id} is already used`);
    defined.add(hypothesis.id);

    for (const field of ['element', 'rationale', 'look_for'] as const) if (blank(hypothesis[field])) say(`${field} is blank`);
    problems.push(...headed('rationale', hypothesis.rationale).map((problem) => `Hypothesis ${index + 1}: ${problem}`));
  });

  prototypes.forEach((prototype, index) => {
    const key = keyOf(index);
    const say = (problem: string) => problems.push(`Prototype ${key}: ${problem}`);
    if (prototype.key !== key) say(`key must be ${key}, not ${JSON.stringify(prototype.key)}`);

    for (const field of ['title', 'build'] as const) if (blank(prototype[field])) say(`${field} is blank`);
    for (const problem of headed('build', prototype.build)) say(problem);

    if (prototype.hypotheses.length === 0) say('names no hypothesis');
    for (const id of prototype.hypotheses) if (!defined.has(id)) say(`tests ${id}, which this plan does not define`);
    for (const control of prototype.controls) {
      const problem = keyProblem(control);
      if (problem) say(`controls: ${problem}`);
    }

    const said = new Set<string>();
    for (const { item, how } of prototype.must_support ?? []) {
      if (!runsOn.includes(item)) problems.push(`${key} names ${item}, which is not a runs_on item on the list`);
      else if (said.has(item)) problems.push(`${key} lists ${item} twice`);
      else if (blank(how)) problems.push(`${key}'s line for ${item} says nothing`);
      said.add(item);
    }
    for (const id of runsOn) {
      if (!said.has(id) && !gaps.some(({ item }) => item === id)) problems.push(`${key} has no must_support line for ${id}: say how it meets it, or name it in gaps`);
    }
  });
  return problems;
}

// The headings are the engine's, so a pin can name a section and the model's text cannot move one: the free-form fields have
// no heading in them (planProblems), and every other field is flattened to a line.
export function renderPlan(round: number, { hypotheses, prototypes }: PlanOutput, ms: MsItem[]): string {
  // planProblems has refused a line for an item the list doesn't have.
  const supported = (lines: NonNullable<Prototype['must_support']>) => {
    const said = lines.flatMap(({ item, how }) => ms.filter(({ id }) => id === item).map((listed) => `  - ${itemLine(listed)}: ${oneLine(how).trim()}`));
    return said.length === 0 ? [] : ['- Must support:', ...said];
  };
  return [
    `# Prototype round ${round}`,
    '',
    '## Hypotheses',
    '',
    ...hypotheses.flatMap(({ id, element, rationale, look_for }) => [`### ${id} — ${oneLine(element).trim()}`, '', rationale.trim(), '', `Look for: ${oneLine(look_for).trim()}`, '']),
    ...prototypes.flatMap(({ title, hypotheses: tested, build, controls, must_support = [] }, index) => [
      `## ${keyOf(index)}`,
      '',
      oneLine(title).trim(),
      '',
      `- Tests: ${tested.join(', ')}`,
      `- Controls: ${controlsOf(controls)}`,
      ...supported(must_support),
      '',
      build.trim(),
      '',
    ]),
  ].join('\n');
}

// A code block that a field leaves open would hide the headings after it, and so the sections the tickets are pinned to.
function movedHeadings(body: string, round: number, { hypotheses, prototypes }: PlanOutput): string[] {
  const expected = [`Prototype round ${round}`, 'Hypotheses', ...hypotheses.map(({ id, element }) => `${id} — ${oneLine(element).trim()}`), ...prototypes.map((_, index) => keyOf(index))];
  const found = sectionsOf(body).map(({ title }) => title);
  return found.length === expected.length && found.every((title, index) => title === expected[index]) ? [] : [`The text changes the headings the engine writes, as a code block left open does by hiding the ones after it: expected ${expected.join(', ')}; found ${found.join(', ') || 'none'}`];
}

// What the list asks of a prototype, for the Engineer who builds it. A play item is the one the engine plays before the
// ticket is done, so the plan's word on how the prototype meets it goes beside it.
function mustSupportSection(prototype: Prototype, items: MsItem[]): string {
  if (items.length === 0) return '';
  const how = (id: string) => {
    const said = prototype.must_support?.find(({ item }) => item === id)?.how;
    return said === undefined ? '' : `: ${oneLine(said).trim()}`;
  };
  const checked = (item: MsItem) => {
    if (item.check === 'command') return 'Not checked on prototypes';
    if (item.check === 'human') return 'The stakeholder checks this when they play it';
    return checkedBy(item).replace(/\.$/, '');
  };
  return [
    '',
    '## Must support',
    '',
    'Every item below holds for this prototype. Before the ticket is done, the engine plays it in each browser the list names.',
    '',
    ...items.map((item) => `- ${itemLine(item)} — ${checked(item)}${how(item.id)}`),
    '',
  ].join('\n');
}

// A prototype is a ticket the PM writes for an Engineer, as short as can be built and played: one page, nothing to install.
// The list is an input the Engineer reads, and not something the ticket derives from: a ticket goes stale when what it
// derives from changes, and nothing revises a prototype's ticket.
export function prototypeTicket(round: number, k: number, prototype: Prototype, pin: string, ms?: { pin: string; items: MsItem[] }): NewVersion {
  const inputs = ms ? [pin, ms.pin] : [pin];
  const root = protoRoot(round, k);
  const id = protoTicketId(round, k);
  const key = `P-${k}`;
  const draft = {
    key,
    title: `Prototype ${key}: ${oneLine(prototype.title).trim()}`,
    ac_refs: [],
    specialty: 'engineer',
    touches: [`${root}/**`],
    depends_on: [],
    definition_of_done: [`test -f ${root}/index.html`],
    inputs,
    size: 'S' as const,
    components: [],
    body: `Build prototype ${key} as a self-contained static page at ${root}/index.html: plain JavaScript, no build step, no dependencies, no network. It must open by loading index.html. Reference every other file by a relative path. Controls: ${controlsOf(prototype.controls)}.\n\n${prototype.build.trim()}\n${mustSupportSection(prototype, ms?.items ?? [])}`,
  };
  const { fields, body } = renderTicket(0, draft, { id, dependsOn: [], inputs });
  // The runner parses it like any other ticket, so one it would refuse is the engine's bug and not the worker's.
  parseTicket(renderArtifact({ id, type: 'ticket', version: 1, status: 'approved', ownerRole: 'pm', derivedFrom: [], acceptanceCriteria: [], approvedBy: null, approvedAt: null, fields, body }));
  return { id, type: 'ticket', status: 'approved', ownerRole: 'pm', approvedBy: 'owner:pm', milestone: 0, derivedFrom: [protoPlanId(round), pin], fields, body };
}

// The PM plans a round of prototypes: what might be fun, as hypotheses from general knowledge, and the smallest playable
// page for each. Only the stakeholder judges whether any of it is fun, so nothing here says it is.
export const applyPrototypePlan: Applier = async (ctx) => {
  const output = ctx.output as PlanOutput;
  const round = roundOf(ctx);
  const id = protoPlanId(round);

  const ms = await mustSupportItems(ctx.deps, ctx.project);
  const items = ms?.items ?? [];
  const problems = planProblems(output, items);
  if (problems.length > 0) return { ok: false, evidence: problems.join('\n') };
  const body = renderPlan(round, output, items);
  const moved = movedHeadings(body, round, output);
  if (moved.length > 0) return { ok: false, evidence: moved.join('\n') };

  // The tickets are pinned to the plan as it is published with them.
  const version = ((await ctx.deps.artifacts.latest(ctx.project.id, id))?.version ?? 0) + 1;
  const { hypotheses, prototypes } = output;
  const plan: NewVersion = { ...ownedDoc(ctx, { id, type: 'prototype_plan', owner: 'pm' }, body), milestone: 0, fields: { data: { hypotheses, prototypes } } };
  const tickets = prototypes.map((prototype, index) => prototypeTicket(round, index + 1, prototype, `${id}@${version}#p-${index + 1}`, ms));

  return withRaised(ctx, { message: `prototype round ${round}: plan and ${tickets.length} prototype${tickets.length === 1 ? '' : 's'}`, publish: [plan, ...tickets] });
};
