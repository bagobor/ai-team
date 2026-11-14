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

const MUST_SUPPORT = {
  items: [{ id: 'MS-1', group: 'built_with', text: 'Runs as a Node command line tool', brief_quote: 'A small Node command line tool', check: 'command' }],
  stakeholder_note: 'One thing to confirm: it runs as a Node command line tool',
};

const DISCOVERY = {
  roadmap: { body: '# Roadmap\n\nOne milestone is enough.\n', milestones: [{ n: 1, title: 'Convert temperatures', goal: 'A tool that converts both ways' }] },
  team_proposal: { body: '# Team\n\nOne engineer.\n' },
  human_requirements: { body: '# What we need from you\n\nNothing.\n' },
  fun_definition: null,
  stakeholder_note: 'One milestone, one engineer, nothing needed from you',
};

const PROFILE = {
  body: '# Environment\n\nNode, with nothing to install.\n',
  commands: { build: 'true', test: HARNESS_COMMAND, lint: 'true', smoke: 'node --version' },
  toolchains: ['node 22'],
  network_allow: [],
  setup: null,
  play: null,
  // The list's one item is checked by command, so the profile says which.
  must_support_checks: [{ item: 'MS-1', command: 'node --version', protected: [] }],
  stakeholder_note: 'Node is all this needs',
};

// The Spec and the ticket scope carry this one. The Test Plan and QA cover the automated criteria only, because nothing but the stakeholder can judge it.
const HUMAN_CHECK = {
  id: 'AC-3',
  text: 'The output reads naturally',
  verification: { method: 'human', how: 'Run node tempconv.mjs c2f 100 and read the line it prints; it should say 212 with a unit, in plain words' },
};

const spec = (humanCheck: boolean) => ({ body: '# Convert temperatures\n\n## Scope\n\nCelsius and Fahrenheit, one file.\n', criteria: humanCheck ? [...CRITERIA, HUMAN_CHECK] : CRITERIA, stakeholder_note: 'A small first milestone' });

// Both parts live in the one file the tickets write. Neither ticket adds a test: the Test Plan's harness and commands check them.
const NO_TESTS = 'The tickets add no tests; the Test Plan checks each direction by running the command.';
const TECH = {
  body: 'One file: the formulas, then the arguments that pick one.\n',
  components: [
    { name: 'conversion', responsibility: 'Fahrenheit is Celsius times nine fifths plus thirty two, and back.', sources: ['tempconv.mjs'], tests: [], no_tests_reason: NO_TESTS, complexity: 'S', complexity_notes: 'Two one-line formulas' },
    { name: 'arguments', responsibility: 'The first argument names the direction and the second is the value.', sources: ['tempconv.mjs'], tests: [], no_tests_reason: NO_TESTS, complexity: 'S', complexity_notes: 'Reads two arguments' },
  ],
  complexity: { overall: 'S', rationale: 'One small file' },
  performance: [{ metric: 'Run time', target: 'Under a second', how_measured: 'The Test Plan commands', component: null }],
  test_strategy: 'The Test Plan runs each direction, and its harness checks c2f.',
  risks: [],
  stakeholder_note: 'One small file',
};

// A scope has to give every criterion a ticket, the stakeholder's included, so the first ticket takes the human check when the Spec has one.
const scope = (humanCheck: boolean) => ({
  body: 'Formulas first, then the second direction.\n',
  tickets: [
    { key: 'T-1', title: 'Convert Celsius to Fahrenheit', specialty: 'engineer', ac_refs: humanCheck ? ['AC-1', 'AC-3'] : ['AC-1'], touches: ['tempconv.mjs'], depends_on: [], definition_of_done: [C2F_COMMAND], inputs: ['TECH-M1#conversion'], size: 'S', body: 'Add c2f and its command.\n', components: ['conversion'] },
    { key: 'T-2', title: 'Convert Fahrenheit to Celsius', specialty: 'engineer', ac_refs: ['AC-2'], touches: ['tempconv.mjs'], depends_on: ['T-1'], definition_of_done: ['node tempconv.mjs f2c 212'], inputs: ['TECH-M1#arguments'], size: 'S', body: 'Add f2c and its command.\n', components: ['arguments'] },
  ],
  stakeholder_note: 'Two tickets, one after the other',
});

const TEST_PLAN = {
  body: '# Test plan\n\nRun the commands, and the harness for the first one.\n',
  coverage: [
    { ac: 'AC-1', commands: [C2F_COMMAND, HARNESS_COMMAND], notes: '' },
    { ac: 'AC-2', commands: [F2C_COMMAND], notes: '' },
  ],
  protected: [],
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
// Both components are exempt from tests, so the Eng Lead can approve with no test changed.
const ENG_REVIEW = { verdict: 'approve', summary: 'Two formulas and their arguments, as designed', performance: [{ metric: 'Run time', target: 'Under a second', measured: 'Well under a second', status: 'met', evidence: 'The Test Plan commands returned at once' }], findings: [], polish_tickets: [], stakeholder_note: 'Nothing to polish' };

const stillValid = (ticket: string) => ({ ticket, decision: 'still_valid', rationale: 'The change does not touch this work' });
const unaffected = (tickets: string[]) => ({ unaffected: true, rationale: 'The change does not reach this document', body: null, coverage: null, ticket_decisions: tickets.map(stillValid), tickets: [] });

const ROUNDS = [1, 2, 3];
const TICKETS = ['M1-T-1', 'M1-T-2', 'M1-Q-1', 'M1-B-1'];

export function m2Script(opts: { failFirstQa?: boolean; humanCheck?: boolean } = {}): { byTask: Record<string, Record<string, unknown>> } {
  const byTask: Record<string, Record<string, unknown>> = {
    'MUST-SUPPORT-PM': resultStep(MUST_SUPPORT),
    'DISCOVERY-PM': resultStep(DISCOVERY),
    'DISCOVERY-TL': resultStep(PROFILE),
    'M1-SPEC': resultStep(spec(opts.humanCheck === true)),
    'M1-TECH': resultStep(TECH),
    'M1-TESTPLAN': resultStep(TEST_PLAN),
    'M1-SCOPE': resultStep(scope(opts.humanCheck === true)),
    'M1-T-1': okStep({ 'tempconv.mjs': ONE_WAY }, { summary: 'Added c2f', files_changed: ['tempconv.mjs'] }),
    'M1-T-2': okStep({ 'tempconv.mjs': opts.failFirstQa ? WRONG : RIGHT }, { summary: 'Added f2c', files_changed: ['tempconv.mjs'] }),
    'M1-Q-1': okStep({ 'test/tempconv.test.mjs': HARNESS }, { summary: 'Added a harness', files_changed: ['test/tempconv.test.mjs'] }),
    'M1-B-1': okStep({ 'tempconv.mjs': RIGHT }, { summary: 'Fixed f2c', files_changed: ['tempconv.mjs'] }),
    'CR-1-REC': resultStep({ decision: 'approve', rationale: 'Scripts do read the output' }),
    'M1-REVISE-TECH-M1-1': resultStep({ unaffected: true, rationale: 'The change does not reach the design', design: null }),
    'M1-REVISE-SCOPE-M1-1': resultStep(unaffected(['M1-T-1', 'M1-T-2'])),
    'M1-REVISE-TEST-PLAN-M1-1': resultStep(unaffected(['M1-Q-1'])),
  };
  for (const round of ROUNDS) {
    byTask[`M1-QA-${round}`] = resultStep(opts.failFirstQa && round === 1 ? FAILING : PASSING);
    byTask[`M1-ENGREV-${round}`] = resultStep(ENG_REVIEW);
    byTask[`M1-REVIEW-${round}`] = resultStep(REVIEW);
  }
  // A review is named after the attempt it reads, and an attempt can be cut short and go again.
  for (const ticket of TICKETS) for (const k of ROUNDS) byTask[`${ticket}-R${k}`] = resultStep(APPROVE);
  return { byTask };
}
