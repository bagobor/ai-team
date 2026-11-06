import type { ProjectRow } from '../../src/engine/store.ts';
import { apply, projectOf, publish } from './apply.ts';
import type { TestEngine } from './engine.ts';

const CRITERIA_COUNT = 30;
const TICKET_COUNT = 10;
// A role budget is 12,000, and M4 adds up to 2,000 of playbook and 1,000 of memory to every manifest.
export const ROOM_BEFORE_M4 = 9_000;

export const ids = Array.from({ length: CRITERIA_COUNT }, (_, i) => `AC-${i + 1}`);
export const words = (chars: number) => 'the check reads the file and compares it with what it should hold '.repeat(Math.ceil(chars / 67)).slice(0, chars).trimEnd();
// Sizes from the first real run: its verification commands were shell one-liners of about 700 characters.
export const command = (ac: string) => `true # command-marker ${ac} ${words(700)}`;
export const textOf = (ac: string) => `text-${ac}-marker ${words(250)}`;
export const noteOf = (ac: string) => `note-${ac}-marker ${words(150)}`;
export const planNoteOf = (ac: string) => `plan-note-${ac}-marker ${words(130)}`;
// A row of the table a real PM wrote under its own Acceptance criteria heading, ahead of the engine's.
export const pmRowOf = (ac: string) => `| ${ac} | pm-row-${ac}-marker ${words(80)} |`;

export const largeCoverage = ids.map((ac) => ({ ac, commands: [command(ac)], notes: planNoteOf(ac) }));
export const largeTickets = Array.from({ length: TICKET_COUNT }, (_, t) => ({
  key: `T-${t + 1}`,
  title: `Ticket ${t + 1}`,
  specialty: 'engineer',
  ac_refs: ids.slice(t * 3, t * 3 + 3),
  touches: [`src/part-${t + 1}/**`],
  depends_on: [],
  definition_of_done: ['npm test'],
  inputs: [`SPEC-M1@1#ac-${t * 3 + 1}`],
  size: 'S',
  body: 'Do it.\n',
}));
export const largeDesign = { body: '# Design\n', tickets: largeTickets };
// The first real project's Tech Designs ran from 7,000 to 12,000 characters of prose.
export const proseDesign = { body: `# Design\n\n## Power-ups\n\ndesign-prose-marker ${words(6000)}\n\n## Boss\n\n${words(6000)}\n`, tickets: largeTickets };
export const largeTestPlan = { body: `# Test plan\n\nplan-prose-marker ${words(1500)}\n`, coverage: largeCoverage, harness_tickets: [] };

// Each document comes from its real applier, so these are the sizes and shapes a real milestone leaves behind.
// Run 4's PM wrote its own Acceptance criteria section, so by default this Spec has one too, and the engine's comes second.
export async function publishLargeSpec(e: TestEngine, { ownCriteriaSection = true } = {}): Promise<ProjectRow> {
  const project = await projectOf(e);
  await e.store.createMilestone({ project_id: project.id, n: 1, title: 'First', goal: 'Goal', phase: 'pending' });
  await e.store.patchMilestone(project.id, 1, { verify_round: 1 });

  const criteria = ids.map((id) => ({ id, text: textOf(id), verification: { method: 'automated', how: command(id) } }));
  const own = ownCriteriaSection ? `\n## Acceptance criteria\n\n| ID | Must be true |\n|----|----|\n${ids.map(pmRowOf).join('\n')}\n\n## Assumptions\n\nassumption-marker ${words(300)}\n` : '';
  const [spec] = await publish(e, await apply(e, 'milestone_spec', { body: `# Goal\n\nspec-prose-marker ${words(3000)}\n${own}`, criteria }));
  await e.store.lockCriteria(project.id, 1, spec!.version, criteria as Parameters<typeof e.store.lockCriteria>[3]);
  return project;
}

export async function publishLargeDesign(e: TestEngine, design = largeDesign): Promise<void> {
  await publish(e, await apply(e, 'tech_design', design, { inputs: ['SPEC-M1@1'], role: 'tech_lead' }));
  await publish(e, await apply(e, 'test_plan', largeTestPlan, { inputs: ['SPEC-M1@1'], role: 'qa_engineer' }));
}

// About 660 tokens, as in the first real run.
export async function publishProfile(e: TestEngine): Promise<string> {
  const output = { body: `# Environment\n\nprofile-marker ${words(1700)}\n`, commands: { build: 'npm run build', test: 'npm test', lint: 'npm run lint', smoke: 'true' }, toolchains: ['node 22'], network_allow: [], setup: null, stakeholder_note: 'Ready' };
  const [row] = await publish(e, await apply(e, 'environment_profile', output, { role: 'tech_lead' }));
  return `${row!.artifact_id}@${row!.version}`;
}
