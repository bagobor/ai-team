// A whole team acted out by the fake worker: it takes a brief for a small Node command line tool through to CP4.
import { okStep, resultStep } from '../helpers/engine.ts';

export const M2_BRIEF = '# Temperatures\n\nA small Node command line tool that converts temperatures, so I stop looking the formula up.\n';

const C2F_COMMAND = 'test "$(node tempconv.mjs c2f 100)" = 212';
const F2C_COMMAND = 'test "$(node tempconv.mjs f2c 212)" = 100';
const HARNESS_COMMAND = 'node --test test/tempconv.test.mjs';

const C2F = 'export const c2f = (c) => (c * 9) / 5 + 32;\n';
const ARGUMENTS = "const [, , direction, value] = process.argv;\nif (direction === 'c2f') console.log(c2f(Number(value)));\n";
const ONE_WAY = `${C2F}\n${ARGUMENTS}`;
const bothWays = (formula: string) => `${C2F}export const f2c = (f) => ${formula};\n\n${ARGUMENTS}if (direction === 'f2c') console.log(f2c(Number(value)));\n`;
const RIGHT = bothWays('((f - 32) * 5) / 9');
const WRONG = bothWays('f - 32');
const HARNESS = "import assert from 'node:assert/strict';\nimport { test } from 'node:test';\nimport { c2f } from '../tempconv.mjs';\n\ntest('water boils', () => assert.equal(c2f(100), 212));\n";

const CRITERIA = [
  { id: 'AC-1', text: 'c2f converts Celsius to Fahrenheit', verification: { method: 'automated', how: C2F_COMMAND } },
  { id: 'AC-2', text: 'f2c converts Fahrenheit to Celsius', verification: { method: 'automated', how: F2C_COMMAND } },
];

const DISCOVERY = {
  roadmap: { body: '# Roadmap\n\nOne milestone is enough.\n', milestones: [{ n: 1, title: 'Convert temperatures', goal: 'A tool that converts both ways' }] },
  team_proposal: { body: '# Team\n\nOne engineer.\n' },
  human_requirements: { body: '# What we need from you\n\nNothing.\n' },
  stakeholder_note: 'One milestone, one engineer, nothing needed from you',
};

const PROFILE = {
  body: '# Environment\n\nNode, with nothing to install.\n',
  commands: { build: 'true', test: HARNESS_COMMAND, lint: 'true', smoke: 'node --version' },
  toolchains: ['node 22'],
  network_allow: [],
  setup: null,
  stakeholder_note: 'Node is all this needs',
};

const SPEC = { body: '# Convert temperatures\n\n## Scope\n\nCelsius and Fahrenheit, one file.\n', criteria: CRITERIA, stakeholder_note: 'A small first milestone' };

const TECH = {
  body: '# Design\n\n## Conversion\n\nFahrenheit is Celsius times nine fifths plus thirty two.\n\n## Arguments\n\nThe first argument names the direction and the second is the value.\n',
  tickets: [
    { key: 'T-1', title: 'Convert Celsius to Fahrenheit', specialty: 'engineer', ac_refs: ['AC-1'], touches: ['tempconv.mjs'], depends_on: [], definition_of_done: [C2F_COMMAND], inputs: ['TECH-M1#conversion'], size: 'S', body: 'Add c2f and its command.\n' },
    { key: 'T-2', title: 'Convert Fahrenheit to Celsius', specialty: 'engineer', ac_refs: ['AC-2'], touches: ['tempconv.mjs'], depends_on: ['T-1'], definition_of_done: ['node tempconv.mjs f2c 212'], inputs: ['TECH-M1#arguments'], size: 'S', body: 'Add f2c and its command.\n' },
  ],
};

const TEST_PLAN = {
  body: '# Test plan\n\nRun the commands, and the harness for the first one.\n',
  coverage: [
    { ac: 'AC-1', commands: [C2F_COMMAND, HARNESS_COMMAND], notes: '' },
    { ac: 'AC-2', commands: [F2C_COMMAND], notes: '' },
  ],
  harness_tickets: [
    { key: 'Q-1', title: 'A test harness', specialty: 'engineer', ac_refs: ['AC-1'], touches: ['test/**'], depends_on: [], definition_of_done: ['test -s test/tempconv.test.mjs'], inputs: [], size: 'S', body: 'Add a test for c2f.\n' },
  ],
};

const APPROVE = { verdict: 'approve', summary: 'Does what the ticket says', findings: [] };
const PASSING = { results: CRITERIA.map(({ id }) => ({ ac: id, status: 'passing', commands: [], notes: '' })), bugs: [], summary: 'Everything passes' };
const FAILING = {
  results: CRITERIA.map(({ id }) => ({ ac: id, status: id === 'AC-2' ? 'failing' : 'passing', commands: [], notes: '' })),
  bugs: [{ ac: 'AC-2', title: 'f2c gives the wrong answer', description: 'f2c 212 prints 180', touches: ['tempconv.mjs'], commands: [] }],
  summary: 'f2c is wrong',
};
const REVIEW = { body: '# How it went\n\nSmall and on plan.\n', known_issues: [], deviations: [], stakeholder_note: 'Ready to merge' };

const stillValid = (ticket: string) => ({ ticket, decision: 'still_valid', rationale: 'The change does not touch this work' });
const unaffected = (tickets: string[]) => ({ unaffected: true, rationale: 'The change does not reach this document', body: null, coverage: null, ticket_decisions: tickets.map(stillValid), tickets: [] });

const ROUNDS = [1, 2, 3];
const TICKETS = ['M1-T-1', 'M1-T-2', 'M1-Q-1', 'M1-B-1'];

export function m2Script(opts: { failFirstQa?: boolean } = {}): { byTask: Record<string, Record<string, unknown>> } {
  const byTask: Record<string, Record<string, unknown>> = {
    'DISCOVERY-PM': resultStep(DISCOVERY),
    'DISCOVERY-TL': resultStep(PROFILE),
    'M1-SPEC': resultStep(SPEC),
    'M1-TECH': resultStep(TECH),
    'M1-TESTPLAN': resultStep(TEST_PLAN),
    'M1-T-1': okStep({ 'tempconv.mjs': ONE_WAY }, { summary: 'Added c2f', files_changed: ['tempconv.mjs'] }),
    'M1-T-2': okStep({ 'tempconv.mjs': opts.failFirstQa ? WRONG : RIGHT }, { summary: 'Added f2c', files_changed: ['tempconv.mjs'] }),
    'M1-Q-1': okStep({ 'test/tempconv.test.mjs': HARNESS }, { summary: 'Added a harness', files_changed: ['test/tempconv.test.mjs'] }),
    'M1-B-1': okStep({ 'tempconv.mjs': RIGHT }, { summary: 'Fixed f2c', files_changed: ['tempconv.mjs'] }),
    'CR-1-REC': resultStep({ decision: 'approve', rationale: 'Scripts do read the output' }),
    'M1-REVISE-TECH-M1-1': resultStep(unaffected(['M1-T-1', 'M1-T-2'])),
    'M1-REVISE-TEST-PLAN-M1-1': resultStep(unaffected(['M1-Q-1'])),
  };
  for (const round of ROUNDS) {
    byTask[`M1-QA-${round}`] = resultStep(opts.failFirstQa && round === 1 ? FAILING : PASSING);
    byTask[`M1-REVIEW-${round}`] = resultStep(REVIEW);
  }
  // A review is named after the attempt it reads, and an attempt can be cut short and go again.
  for (const ticket of TICKETS) for (const k of ROUNDS) byTask[`${ticket}-R${k}`] = resultStep(APPROVE);
  return { byTask };
}
