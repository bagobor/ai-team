import type { ProjectRow } from '../../src/engine/store.ts';
import { apply, projectOf, publish } from './apply.ts';
import type { TestEngine } from './engine.ts';

const CRITERIA_COUNT = 30;
const TICKET_COUNT = 10;
// A role budget is 12,000, and M3 adds up to 2,000 of playbook and 1,000 of memory to every manifest.
export const ROOM_BEFORE_M3 = 9_000;

export const ids = Array.from({ length: CRITERIA_COUNT }, (_, i) => `AC-${i + 1}`);
export const words = (chars: number) => 'the check reads the file and compares it with what it should hold '.repeat(Math.ceil(chars / 67)).slice(0, chars).trimEnd();
// Sizes from the first real run: its verification commands were shell one-liners of about 700 characters.
export const command = (ac: string) => `true # command-marker ${ac} ${words(700)}`;
export const textOf = (ac: string) => `text-${ac}-marker ${words(250)}`;
export const noteOf = (ac: string) => `note-${ac}-marker ${words(150)}`;
export const planNoteOf = (ac: string) => `plan-note-${ac}-marker ${words(130)}`;

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
export const largeTestPlan = { body: `# Test plan\n\nplan-prose-marker ${words(1500)}\n`, coverage: largeCoverage, harness_tickets: [] };

// Each document comes from its real applier, so these are the sizes and shapes a real milestone leaves behind.
export async function publishLargeSpec(e: TestEngine): Promise<ProjectRow> {
  const project = await projectOf(e);
  await e.store.createMilestone({ project_id: project.id, n: 1, title: 'First', goal: 'Goal', phase: 'pending' });
  await e.store.patchMilestone(project.id, 1, { verify_round: 1 });

  const criteria = ids.map((id) => ({ id, text: textOf(id), verification: { method: 'automated', how: command(id) } }));
  const [spec] = await publish(e, await apply(e, 'milestone_spec', { body: `# Goal\n\nspec-prose-marker ${words(3000)}\n`, criteria }));
  await e.store.lockCriteria(project.id, 1, spec!.version, criteria as Parameters<typeof e.store.lockCriteria>[3]);
  return project;
}

export async function publishLargeDesign(e: TestEngine): Promise<void> {
  await publish(e, await apply(e, 'tech_design', largeDesign, { inputs: ['SPEC-M1@1'], role: 'tech_lead' }));
  await publish(e, await apply(e, 'test_plan', largeTestPlan, { inputs: ['SPEC-M1@1'], role: 'qa_engineer' }));
}

// About 660 tokens, as in the first real run.
export async function publishProfile(e: TestEngine): Promise<string> {
  const output = { body: `# Environment\n\nprofile-marker ${words(1700)}\n`, commands: { build: 'npm run build', test: 'npm test', lint: 'npm run lint', smoke: 'true' }, toolchains: ['node 22'], network_allow: [], setup: null, stakeholder_note: 'Ready' };
  const [row] = await publish(e, await apply(e, 'environment_profile', output, { role: 'tech_lead' }));
  return `${row!.artifact_id}@${row!.version}`;
}
