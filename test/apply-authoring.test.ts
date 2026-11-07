import { Ajv } from 'ajv';
import { readFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { sectionText } from '../src/artifacts/format.ts';
import { applyOutput } from '../src/engine/apply/index.ts';
import { structureProblems, type TechStructure } from '../src/engine/apply/tech-structure.ts';
import { loadRole } from '../src/roles/role.ts';
import { stateRepoDir } from '../src/paths.ts';
import { apply, CRITERIA, ctxFor, evidenceOf, lockSpec, projectOf, publish, specBody, ticketTask } from './helpers/apply.ts';
import { makeEngine, type TestEngine } from './helpers/engine.ts';
import { tempDir } from './helpers/repo.ts';

const DISCOVERY = {
  roadmap: { body: '# Roadmap\n', milestones: [{ n: 1, title: 'First', goal: 'Start' }, { n: 2, title: 'Second', goal: 'Finish' }] },
  team_proposal: { body: '# Team\n' },
  human_requirements: { body: '# Needs\n' },
  stakeholder_note: 'Please look at the roadmap',
};
const PROFILE = {
  body: '# Environment\n',
  commands: { build: 'npm run build', test: 'npm test', lint: 'npm run lint', smoke: 'echo smoke-ok' },
  toolchains: ['node 22'],
  network_allow: ['registry.npmjs.org'],
  setup: 'npm ci',
  play: null,
  stakeholder_note: 'Note',
};
const SPEC = { body: '# Milestone one\n', criteria: CRITERIA, stakeholder_note: 'Note' };
const HUMAN = { id: 'AC-2', text: 'Dodging feels fair', verification: { method: 'human' as const, how: 'Play two minutes; you should never die without seeing the shot coming' } };
const draft = (key: string, ac_refs: string[], overrides: Record<string, unknown> = {}) => ({
  key,
  title: key,
  specialty: 'engineer',
  ac_refs,
  touches: ['src/**'],
  depends_on: [],
  definition_of_done: ['npm test'],
  inputs: [],
  size: 'S',
  body: 'Do it.\n',
  ...overrides,
});
const DESIGN = { body: '# Design\n', tickets: [draft('T-1', ['AC-1']), draft('T-2', ['AC-2'])] };
const coverage = (ac: string, commands = ['npm test']) => ({ ac, commands, notes: '' });
const TEST_PLAN = { body: '# Test plan\n', coverage: [coverage('AC-1'), coverage('AC-2')], harness_tickets: [], protected: [] as string[] };
const REVISE = { unaffected: false, rationale: 'The spec moved', body: '# Design two\n', coverage: null, ticket_decisions: [], tickets: [] };
const component = (name: string, tests: string[], no_tests_reason: string | null = null) => ({ name, responsibility: `Owns ${name}`, sources: [`src/${name}/**`], tests, no_tests_reason, complexity: 'S' as const, complexity_notes: 'Small' });
const STRUCTURE: TechStructure = {
  components: [component('core', ['test/core/**']), component('ui', [], 'The play script covers it')],
  complexity: { overall: 'S', rationale: 'Two small parts' },
  performance: [{ metric: 'Frame time', target: '16 ms', how_measured: 'The play script', component: 'ui' }],
  test_strategy: 'Unit tests for core, a play script for ui.',
  risks: [],
};
const SCOPE = { body: '# Scope\n', tickets: [draft('T-1', ['AC-1'], { components: ['core'] }), draft('T-2', ['AC-2'], { components: ['ui'] })], stakeholder_note: 'Note' };

describe('appliers', () => {
  let e: TestEngine;

  beforeEach(async () => {
    e = await makeEngine({ steps: [] });
  });

  afterEach(() => e.cleanup());

  const latest = async (id: string) => e.artifacts.latest((await projectOf(e)).id, id);
  const read = async (pin: string) => e.artifacts.read(await projectOf(e), pin);
  const brief = async () => e.artifacts.commit(await projectOf(e), { message: 'brief', publish: [{ id: 'BRIEF', type: 'brief', status: 'approved', ownerRole: 'stakeholder', derivedFrom: [], body: '# Brief\n' }] });
  // The structured Tech Design an Eng Lead scopes tickets against.
  const structuredDesign = async (structure: TechStructure | null = STRUCTURE) => {
    if (structure) expect(structureProblems(structure)).toEqual([]);
    return e.artifacts.commit(await projectOf(e), {
      message: 'the tech design',
      publish: [{ id: 'TECH-M1', type: 'tech_design', status: 'approved', ownerRole: 'tech_lead', approvedBy: 'owner:tech_lead', milestone: 1, derivedFrom: ['SPEC-M1@1'], body: '# Design\n', ...(structure ? { fields: { data: structure } } : {}) }],
    });
  };

  describe('discovery', () => {
    it('publishes the three discovery documents as proposed, derived from the brief', async () => {
      await brief();
      const rows = await publish(e, await apply(e, 'discovery', DISCOVERY, { inputs: ['BRIEF@1'] }));

      expect(rows.map((row) => [row.artifact_id, row.status, row.owner_role, row.derived_from])).toEqual([
        ['ROADMAP', 'proposed', 'pm', ['BRIEF@1']],
        ['TEAM-PROPOSAL', 'proposed', 'pm', ['BRIEF@1']],
        ['HUMAN-REQUIREMENTS', 'proposed', 'pm', ['BRIEF@1']],
      ]);
      expect((await read('ROADMAP')).fields.data).toEqual(DISCOVERY.roadmap.milestones);
    });

    it.each([
      ['a gap', [{ n: 1, title: 'A', goal: 'g' }, { n: 3, title: 'B', goal: 'g' }], /milestone/i],
      ['a start past one', [{ n: 2, title: 'A', goal: 'g' }], /milestone/i],
      ['none', [], /milestone/i],
      ['a blank title', [{ n: 1, title: '  ', goal: 'g' }], /title/],
    ])('rejects a roadmap with %s in its milestone numbers', async (_name, milestones, evidence) => {
      const result = await apply(e, 'discovery', { ...DISCOVERY, roadmap: { body: 'r', milestones } });
      expect(evidenceOf(result)).toMatch(evidence);
    });
  });

  describe('environment_profile', () => {
    async function withServer<T>(body: (connect: string, connected: () => boolean) => Promise<T>): Promise<T> {
      let connected = false;
      const server = createServer(() => {
        connected = true;
      });
      await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
      const { port } = server.address() as AddressInfo;
      try {
        const script = `require('net').connect(${port},'127.0.0.1').on('connect',()=>process.exit(0)).on('error',()=>process.exit(3))`;
        return await body(`node -e "${script}"`, () => connected);
      } finally {
        server.close();
      }
    }

    it('publishes a proposed profile with its commands as data, after a passing smoke', async () => {
      await brief();
      await e.artifacts.commit(await projectOf(e), { message: 'roadmap', publish: [{ id: 'ROADMAP', type: 'roadmap', status: 'proposed', ownerRole: 'pm', derivedFrom: [], body: 'r' }] });
      const [row] = await publish(e, await apply(e, 'environment_profile', PROFILE, { inputs: ['ROADMAP@1'], worktree: tempDir() }));

      expect(row).toMatchObject({ artifact_id: 'ENV-PROFILE', status: 'proposed', owner_role: 'tech_lead', derived_from: ['ROADMAP@1'] });
      expect((await read('ENV-PROFILE')).fields.data).toEqual({ commands: PROFILE.commands, toolchains: PROFILE.toolchains, network_allow: PROFILE.network_allow, setup: 'npm ci', play: null });
    });

    it('takes a play block', async () => {
      const play = { root: 'dist', entry: 'index.html', keys: ['ArrowLeft', 'Space', 'KeyZ'] };
      await publish(e, await apply(e, 'environment_profile', { ...PROFILE, play }, { worktree: tempDir() }));

      expect((await read('ENV-PROFILE')).fields.data).toMatchObject({ play });
    });

    it('takes a play block that says its page has no animation loop', async () => {
      const play = { root: '.', entry: 'index.html', keys: ['Enter'], animated: false };
      await publish(e, await apply(e, 'environment_profile', { ...PROFILE, play }, { worktree: tempDir() }));

      expect((await read('ENV-PROFILE')).fields.data).toMatchObject({ play });
    });

    it.each([
      ['animated that is not true or false', { play: { root: '.', entry: 'index.html', keys: ['Space'], animated: 'no' } }, /play.animated/],
      ['a root outside the repo', { play: { root: '../x', entry: 'index.html', keys: ['Space'] } }, /play.root/],
      ['an absolute root', { play: { root: '/tmp', entry: 'index.html', keys: ['Space'] } }, /play.root/],
      ['an entry that is not a page', { play: { root: '.', entry: 'index.txt', keys: ['Space'] } }, /play.entry/],
      ['an entry outside the root', { play: { root: '.', entry: '../index.html', keys: ['Space'] } }, /play.entry/],
      ['a key that is not one', { play: { root: '.', entry: 'index.html', keys: ['Fire'] } }, /Fire is not a key/],
      ['no keys', { play: { root: '.', entry: 'index.html', keys: [] } }, /at least one key/],
      ['no play at all', { play: undefined }, /play/],
    ])('rejects a profile with %s', async (_name, change, evidence) => {
      const result = await apply(e, 'environment_profile', { ...PROFILE, ...change }, { worktree: tempDir() });
      expect(evidenceOf(result)).toMatch(evidence);
    });

    it('rejects an Environment Profile whose smoke command fails, with its output', async () => {
      const result = await apply(e, 'environment_profile', { ...PROFILE, commands: { ...PROFILE.commands, smoke: 'echo smoke-broke; exit 7' } }, { worktree: tempDir() });
      expect(evidenceOf(result)).toMatch(/smoke-broke/);
      expect(evidenceOf(result)).toMatch(/7/);
    });

    it('rejects a blank smoke command', async () => {
      const result = await apply(e, 'environment_profile', { ...PROFILE, commands: { ...PROFILE.commands, smoke: '  ' } }, { worktree: tempDir() });
      expect(evidenceOf(result)).toMatch(/smoke/);
    });

    it('runs the smoke command with no network', async () => {
      await withServer(async (connect, connected) => {
        const result = await apply(e, 'environment_profile', { ...PROFILE, commands: { ...PROFILE.commands, smoke: connect } }, { worktree: tempDir() });
        expect(evidenceOf(result)).toContain('exited with 3');
        expect(connected()).toBe(false);
      });
    });

    it.each(['https://example.com', 'example.com/path', 'example.com:443', '*.example.com', '*', 'localhost', '127.0.0.1', 'exa mple.com', ''])('rejects the network entry %j', async (entry) => {
      const result = await apply(e, 'environment_profile', { ...PROFILE, network_allow: [entry] }, { worktree: tempDir() });
      expect(evidenceOf(result)).toMatch(/network_allow/);
    });
  });

  describe('milestone_spec', () => {
    it('appends criterion sections so #ac-1 resolves', async () => {
      const [row] = await publish(e, await apply(e, 'milestone_spec', SPEC));

      expect(row).toMatchObject({ artifact_id: 'SPEC-M1', status: 'proposed', owner_role: 'pm', milestone: 1 });
      const doc = await read('SPEC-M1');
      expect(doc.acceptanceCriteria).toEqual(['AC-1', 'AC-2']);
      expect(sectionText(doc.body, 'ac-1')).toContain('The first thing works');
      expect(sectionText(doc.body, 'ac-1')).toContain('npm test -- first');
      expect(sectionText(doc.body, 'ac-1')).not.toContain('The second thing works');
      expect(doc.fields.data).toEqual({ criteria: CRITERIA });
    });

    it.each([
      ['repeats a criterion id', { criteria: [CRITERIA[0], CRITERIA[0]] }, /AC-1/],
      ['has a bad criterion id', { criteria: [{ ...CRITERIA[0], id: 'AC-x' }] }, /AC-x/],
      ['has no criteria', { criteria: [] }, /criteri/],
      ['adds its own AC heading', { body: '# Spec\n\n## AC-1\n\nForged\n' }, /heading/],
      ['adds its own AC heading in other words', { body: '# Spec\n\n## ac 7\n\nForged\n' }, /heading/],
      ['leaves a fence open over the criteria', { body: '# Spec\n\n```\nforever\n' }, /AC-1/],
      ['forges a section in a criterion', { criteria: [{ ...CRITERIA[0], text: 'Fine\n\n### AC-2\n\nForged' }] }, /AC-1/],
      ['has a blank criterion', { criteria: [{ ...CRITERIA[0], text: ' ' }] }, /AC-1/],
      ['verifies by hand', { criteria: [{ ...CRITERIA[0], verification: { method: 'manual', how: 'look' } }] }, /automated method or checked by the stakeholder/],
    ])('rejects a spec that %s', async (_name, change, evidence) => {
      expect(evidenceOf(await apply(e, 'milestone_spec', { ...SPEC, ...change }))).toMatch(evidence);
    });

    it('accepts a human check and says who checks it', async () => {
      const [row] = await publish(e, await apply(e, 'milestone_spec', { ...SPEC, criteria: [CRITERIA[0], HUMAN] }));
      expect(row).toMatchObject({ artifact_id: 'SPEC-M1' });
      const doc = await read('SPEC-M1');
      expect(sectionText(doc.body, 'ac-2')).toContain('Checked by the stakeholder: Play two minutes');
      expect(sectionText(doc.body, 'ac-2')).not.toContain('Verified by');
    });

    it('rejects a Spec whose criteria are all human checks', async () => {
      const result = await apply(e, 'milestone_spec', { ...SPEC, criteria: [{ ...HUMAN, id: 'AC-1' }] });
      expect(evidenceOf(result)).toMatch(/at least one automated criterion/);
    });

    it('rejects more than three human checks', async () => {
      const humans = [2, 3, 4, 5].map((k) => ({ ...HUMAN, id: `AC-${k}` }));
      const result = await apply(e, 'milestone_spec', { ...SPEC, criteria: [CRITERIA[0], ...humans] });
      expect(evidenceOf(result)).toMatch(/at most 3 checks/);
    });

    it('rejects a spec that rewrites locked text', async () => {
      await lockSpec(e);
      const rewritten = [{ ...CRITERIA[0]!, text: 'Something easier' }, CRITERIA[1]!];
      expect(evidenceOf(await apply(e, 'milestone_spec', { ...SPEC, criteria: rewritten }))).toMatch(/AC-1.*locked/);
    });

    it('rejects a spec that drops or adds a locked criterion', async () => {
      await lockSpec(e);
      expect(evidenceOf(await apply(e, 'milestone_spec', { ...SPEC, criteria: [CRITERIA[0]] }))).toMatch(/AC-2.*locked/);
      const extra = { id: 'AC-3', text: 'More', verification: { method: 'automated', how: 'x' } };
      expect(evidenceOf(await apply(e, 'milestone_spec', { ...SPEC, criteria: [...CRITERIA, extra] }))).toMatch(/AC-3.*locked/);
    });

    it('rejects a revision that turns a locked automated criterion into a human check', async () => {
      await lockSpec(e);
      const flipped = [{ ...CRITERIA[0]!, verification: { method: 'human', how: CRITERIA[0]!.verification.how } }, CRITERIA[1]!];
      expect(evidenceOf(await apply(e, 'milestone_spec', { ...SPEC, criteria: flipped }))).toMatch(/AC-1 is locked, so its verification method can't change/);
    });

    it('rejects a revision that turns a locked human check into an automated one', async () => {
      await lockSpec(e, [CRITERIA[0]!, HUMAN]);
      const flipped = [CRITERIA[0]!, { ...HUMAN, verification: { method: 'automated', how: HUMAN.verification.how } }];
      expect(evidenceOf(await apply(e, 'milestone_spec', { ...SPEC, criteria: flipped }))).toMatch(/AC-2 is locked, so its verification method can't change/);
    });

    it('takes a new version of the spec that keeps the locked text', async () => {
      await lockSpec(e);
      const [row] = await publish(e, await apply(e, 'milestone_spec', SPEC));
      expect(row).toMatchObject({ artifact_id: 'SPEC-M1', version: 2 });
    });
  });

  describe('tech_design', () => {
    beforeEach(() => lockSpec(e));

    it('publishes the approved design and its tickets', async () => {
      const rows = await publish(e, await apply(e, 'tech_design', DESIGN, { inputs: ['SPEC-M1@1'] }));

      expect(rows.map((row) => [row.artifact_id, row.status, row.approved_by])).toEqual([
        ['TECH-M1', 'approved', 'owner:tech_lead'],
        ['M1-T-1', 'approved', 'owner:tech_lead'],
        ['M1-T-2', 'approved', 'owner:tech_lead'],
      ]);
      expect(rows[0]!.derived_from).toEqual(['SPEC-M1@1']);
      expect(rows[1]!.derived_from).toEqual(['TECH-M1@1', 'SPEC-M1@1#ac-1']);
    });

    it('rejects a Tech Design that leaves a criterion without a ticket', async () => {
      const result = await apply(e, 'tech_design', { ...DESIGN, tickets: [draft('T-1', ['AC-1'])] });
      expect(evidenceOf(result)).toMatch(/AC-2/);
    });

    it('passes on what validateTickets finds', async () => {
      const result = await apply(e, 'tech_design', { ...DESIGN, tickets: [draft('T-1', ['AC-1', 'AC-2'], { touches: ['/etc/**'] })] });
      expect(evidenceOf(result)).toMatch(/T-1.*touches/);
    });

    it('refuses a ticket id that a published ticket already has', async () => {
      await publish(e, await apply(e, 'tech_design', DESIGN));
      expect(evidenceOf(await apply(e, 'tech_design', DESIGN))).toMatch(/already exists/);
    });

    it('treats a milestone with nothing locked as the engine\'s bug', async () => {
      await expect(apply(e, 'tech_design', DESIGN, { milestone: 2 })).rejects.toThrow(/locked/);
    });
  });

  describe('ticket_scope', () => {
    beforeEach(async () => {
      await lockSpec(e);
      await structuredDesign();
    });

    const scope = (output: Record<string, unknown> = {}) => apply(e, 'ticket_scope', { ...SCOPE, ...output }, { inputs: ['SPEC-M1@1', 'TECH-M1@1'], role: 'eng_lead' });

    it('publishes SCOPE-M1 and its tickets owned by eng_lead', async () => {
      const rows = await publish(e, await scope());

      expect(rows.map((row) => [row.artifact_id, row.status, row.approved_by])).toEqual([
        ['SCOPE-M1', 'approved', 'owner:eng_lead'],
        ['M1-T-1', 'approved', 'owner:eng_lead'],
        ['M1-T-2', 'approved', 'owner:eng_lead'],
      ]);
      expect(rows.map((row) => [row.type, row.owner_role])).toEqual([
        ['ticket_scope', 'eng_lead'],
        ['ticket', 'eng_lead'],
        ['ticket', 'eng_lead'],
      ]);
      expect(rows[0]!.derived_from).toEqual(['SPEC-M1@1', 'TECH-M1@1']);
      expect(rows[1]!.derived_from[0]).toBe('SCOPE-M1@1');
      expect(rows[2]!.derived_from[0]).toBe('SCOPE-M1@1');

      const ticket = await read('M1-T-1');
      expect(ticket.fields.components).toEqual(['core']);
      expect(sectionText(ticket.body, 'tests')).toContain('- core: test/core/**');
    });

    it('rejects a scope that leaves a criterion without a ticket', async () => {
      expect(evidenceOf(await scope({ tickets: [draft('T-1', ['AC-1'], { components: ['core'] })] }))).toMatch(/AC-2/);
    });

    it('rejects a ticket without components', async () => {
      const result = await scope({ tickets: [draft('T-1', ['AC-1'], { components: ['core'] }), draft('T-2', ['AC-2'])] });
      expect(evidenceOf(result)).toMatch(/T-2: components is empty/);
    });

    it('rejects a ticket that names a component the design does not have', async () => {
      const result = await scope({ tickets: [draft('T-1', ['AC-1', 'AC-2'], { components: ['core', 'renderer'] })] });
      expect(evidenceOf(result)).toContain('T-1: components names "renderer", which the Tech Design does not have');
    });

    it('passes on what validateTickets finds', async () => {
      const result = await scope({ tickets: [draft('T-1', ['AC-1', 'AC-2'], { components: ['core'], touches: ['/etc/**'] })] });
      expect(evidenceOf(result)).toMatch(/T-1.*touches/);
    });

    it("treats a Tech Design without components as the engine's bug", async () => {
      await structuredDesign(null);
      await expect(scope()).rejects.toThrow(/TECH-M1/);
    });

    // The model answers to these schemas, so a shape the engine takes but a schema forbids could never be written.
    it('is a shape the scope schemas allow', async () => {
      const seed = fileURLToPath(new URL('../seed/knowledge', import.meta.url));
      const ajv = new Ajv({ strict: false });
      const scoped = ajv.compile((await loadRole(seed, 'eng_lead', 'ticket_scope')).schema);
      expect(scoped(SCOPE), JSON.stringify(scoped.errors)).toBe(true);
      expect(scoped({ ...SCOPE, tickets: [draft('T-1', ['AC-1'])] })).toBe(false);

      const revised = ajv.compile((await loadRole(seed, 'eng_lead', 'revise_scope')).schema);
      expect(revised({ ...REVISE, tickets: SCOPE.tickets }), JSON.stringify(revised.errors)).toBe(true);
      expect(revised({ ...REVISE, tickets: [draft('T-1', ['AC-1'])] })).toBe(false);
    });
  });

  describe('test_plan', () => {
    beforeEach(() => lockSpec(e));

    it('publishes the plan with its coverage as data, approved by its owner', async () => {
      const [row, ticket] = await publish(e, await apply(e, 'test_plan', { ...TEST_PLAN, harness_tickets: [draft('Q-1', ['AC-1'])] }, { inputs: ['SPEC-M1@1'] }));

      expect(row).toMatchObject({ artifact_id: 'TEST-PLAN-M1', status: 'approved', owner_role: 'qa_engineer', approved_by: 'owner:qa_engineer' });
      expect((await read('TEST-PLAN-M1')).fields.data).toEqual({ coverage: TEST_PLAN.coverage, protected: [] });
      expect(ticket).toMatchObject({ artifact_id: 'M1-Q-1', owner_role: 'tech_lead' });
    });

    it('stores the protected globs', async () => {
      await publish(e, await apply(e, 'test_plan', { ...TEST_PLAN, protected: ['acceptance/**'] }, { inputs: ['SPEC-M1@1'] }));
      expect((await read('TEST-PLAN-M1')).fields.data).toEqual({ coverage: TEST_PLAN.coverage, protected: ['acceptance/**'] });
    });

    const { protected: _omitted, ...withoutProtected } = TEST_PLAN;
    it.each([
      ['covers the whole repository', { ...TEST_PLAN, protected: ['**'] }],
      ['covers the whole repository, spelled another way', { ...TEST_PLAN, protected: ['**/*'] }],
      ['names the state folder', { ...TEST_PLAN, protected: ['.aiteam/x'] }],
      ['is blank', { ...TEST_PLAN, protected: ['acceptance/**', ' '] }],
      ['is missing', withoutProtected],
      ['is not a list of globs', { ...TEST_PLAN, protected: 'acceptance/**' }],
    ])('rejects a Test Plan whose protected list %s', async (_name, output) => {
      expect(evidenceOf(await apply(e, 'test_plan', output))).toMatch(/protected/);
    });

    it.each([
      ['missing', [coverage('AC-1')], /AC-2/],
      ['repeated', [coverage('AC-1'), coverage('AC-1'), coverage('AC-2')], /AC-1/],
      ['without commands', [coverage('AC-1', []), coverage('AC-2')], /AC-1/],
      ['with a blank command', [coverage('AC-1', [' ']), coverage('AC-2')], /AC-1/],
      ['unknown', [coverage('AC-1'), coverage('AC-2'), coverage('AC-3')], /AC-3/],
    ])('rejects a Test Plan with a criterion %s', async (_name, rows, evidence) => {
      expect(evidenceOf(await apply(e, 'test_plan', { ...TEST_PLAN, coverage: rows }))).toMatch(evidence);
    });

    // What a person sees or does in the browser is shown by playing the page, which needs a page the profile says how to build and serve.
    describe('a play script', () => {
      const script = { steps: [{ key: 'Space' }, { wait_ms: 500 }], expect: 'window.started === true' };
      const playing = (play: unknown = script, commands: string[] = []) => ({ ...TEST_PLAN, coverage: [{ ...coverage('AC-1', commands), play }, coverage('AC-2')] });
      const profile = async (play: unknown) =>
        e.artifacts.commit(await projectOf(e), { message: 'the profile', publish: [{ id: 'ENV-PROFILE', type: 'environment_profile', status: 'approved', ownerRole: 'tech_lead', derivedFrom: [], body: '# Env\n', fields: { data: { ...PROFILE, play } } }] });
      const SITE = { root: 'dist', entry: 'index.html', keys: ['Space'] };

      it('accepts an entry with only a play script', async () => {
        await profile(SITE);
        await publish(e, await apply(e, 'test_plan', playing(), { inputs: ['SPEC-M1@1'] }));

        expect((await read('TEST-PLAN-M1')).fields.data).toEqual({ coverage: playing().coverage, protected: [] });
      });

      // The model answers to this schema, so a shape the engine takes but the schema forbids could never be written.
      it('is a shape the Test Plan schema allows', async () => {
        const { schema } = await loadRole(fileURLToPath(new URL('../seed/knowledge', import.meta.url)), 'qa_engineer', 'test_plan');
        const validate = new Ajv({ strict: false }).compile(schema);
        const full = { steps: [{ key: 'Space', hold_ms: 100 }, { wait_ms: 500 }, { eval: 'window.start()' }], expect: 'window.started === true' };

        expect(validate(playing(full)), JSON.stringify(validate.errors)).toBe(true);
        expect(validate(playing({ steps: [{ press: 'Space' }], expect: 'true' }))).toBe(false);
        expect(validate(playing({ steps: [] }))).toBe(false);
      });

      it('accepts an entry with commands and a play script', async () => {
        await profile(SITE);
        await publish(e, await apply(e, 'test_plan', playing(script, ['npm test']), { inputs: ['SPEC-M1@1'] }));
      });

      it.each([
        ['the profile has no play block', null, playing(), /AC-1.*no play block/],
        ['a key is not one', SITE, playing({ ...script, steps: [{ key: 'Fire' }] }), /Fire is not a key/],
        ['there are 51 steps', SITE, playing({ ...script, steps: Array.from({ length: 51 }, () => ({ eval: '1' })) }), /at most 50 steps/],
        ['it expects nothing', SITE, playing({ ...script, expect: ' ' }), /expect/],
        ['an entry has neither commands nor a play script', SITE, { ...TEST_PLAN, coverage: [coverage('AC-1', []), coverage('AC-2')] }, /AC-1 needs at least one command or a play script/],
      ])('rejects a Test Plan when %s', async (_name, site, output, evidence) => {
        await profile(site);
        expect(evidenceOf(await apply(e, 'test_plan', output))).toMatch(evidence);
      });

      it('rejects a play script when there is no profile at all', async () => {
        expect(evidenceOf(await apply(e, 'test_plan', playing()))).toMatch(/no play block/);
      });

      // The revising model rewrites every entry but is shown the play only in the reference file, so a revision that leaves it out is not asking for it to go.
      describe('and a revision', () => {
        const SECOND = { steps: [{ key: 'ArrowLeft', hold_ms: 100 }], expect: 'window.x < 0' };
        // AC-1 is proved by a play script alone, AC-2 by a command and a play script.
        const base = [{ ...coverage('AC-1', []), play: script }, { ...coverage('AC-2'), play: script }];
        // The profile the plan is first published under is always SITE, and `site` is what it says when the revision is applied.
        const revise = async (rows: unknown[], site: unknown = SITE, plan: unknown[] = base) => {
          await profile(SITE);
          await publish(e, await apply(e, 'test_plan', { ...TEST_PLAN, coverage: plan }, { inputs: ['SPEC-M1@1'] }));
          if (site !== SITE) await profile(site);
          const revision = { unaffected: false, rationale: 'r', body: '# Plan two\n', coverage: rows, ticket_decisions: [], tickets: [] };
          return apply(e, 'revise_test_plan', revision, { inputs: ['SPEC-M1@1', 'TEST-PLAN-M1@1'] });
        };
        const revised = async (rows: unknown[], plan: unknown[] = base) => {
          await publish(e, await revise(rows, SITE, plan));
          expect(await latest('TEST-PLAN-M1')).toMatchObject({ version: 2 });
          return ((await read('TEST-PLAN-M1')).fields.data as { coverage: Record<string, unknown>[] }).coverage;
        };

        it('keeps the play script of an entry that leaves it out, whatever its commands', async () => {
          expect(await revised([coverage('AC-1', []), coverage('AC-2', ['npm run lint'])])).toEqual([{ ...coverage('AC-1', []), play: script }, { ...coverage('AC-2', ['npm run lint']), play: script }]);
        });

        it('replaces the play script of an entry that gives one', async () => {
          expect(await revised([{ ...coverage('AC-1', []), play: SECOND }, coverage('AC-2')])).toEqual([{ ...coverage('AC-1', []), play: SECOND }, { ...coverage('AC-2'), play: script }]);
        });

        it('clears the play script of an entry that says null, and stores no key for it', async () => {
          const rows = await revised([coverage('AC-1', []), { ...coverage('AC-2'), play: null }]);
          expect(rows[1]).toEqual(coverage('AC-2'));
          expect(rows[1]).not.toHaveProperty('play');
          expect(rows[0]).toHaveProperty('play');
        });

        it('still revises an entry that is proved by a play script alone', async () => {
          expect(await revised([{ ...coverage('AC-1', []), notes: 'now with a note' }, coverage('AC-2')])).toEqual([{ ...coverage('AC-1', []), notes: 'now with a note', play: script }, { ...coverage('AC-2'), play: script }]);
        });

        it('refuses an entry with no command once it says null', async () => {
          expect(evidenceOf(await revise([{ ...coverage('AC-1', []), play: null }, coverage('AC-2')]))).toMatch(/AC-1 needs at least one command or a play script/);
          expect(await latest('TEST-PLAN-M1')).toMatchObject({ version: 1 });
        });

        it('holds a play script it replaces to the rules of one at authoring', async () => {
          expect(evidenceOf(await revise([{ ...coverage('AC-1', []), play: { ...script, steps: [{ key: 'Fire' }] } }, coverage('AC-2')]))).toMatch(/AC-1's play script: .*Fire is not a key/);
        });

        it('holds a play script it keeps to the profile as it is now', async () => {
          expect(evidenceOf(await revise([coverage('AC-1', []), coverage('AC-2')], null))).toMatch(/AC-1 has a play script, but the Environment Profile has no play block/);
        });

        // A guard was approved for the play it was asked on, as for the commands, or QA could revise a vacuous script in under it.
        describe('and the regression flag', () => {
          const guarded = [{ ...coverage('AC-1'), play: script, regression: true }, coverage('AC-2')];

          it('keeps the flag of an entry that leaves it out and keeps its play script', async () => {
            expect((await revised([coverage('AC-1'), coverage('AC-2')], guarded))[0]).toEqual({ ...coverage('AC-1'), play: script, regression: true });
          });

          it('drops the flag of an entry that leaves it out and replaces its play script', async () => {
            expect((await revised([{ ...coverage('AC-1'), play: SECOND }, coverage('AC-2')], guarded))[0]).toEqual({ ...coverage('AC-1'), play: SECOND });
          });

          it('drops the flag of an entry that leaves it out and clears its play script', async () => {
            expect((await revised([{ ...coverage('AC-1'), play: null }, coverage('AC-2')], guarded))[0]).toEqual(coverage('AC-1'));
          });

          it('refuses a revision that keeps the flag on an entry whose play script it replaces', async () => {
            expect(evidenceOf(await revise([{ ...coverage('AC-1'), play: SECOND, regression: true }, coverage('AC-2')], SITE, guarded))).toMatch(/AC-1's play script differs from TEST-PLAN-M1@1, so its regression flag can't stay/);
            expect(await latest('TEST-PLAN-M1')).toMatchObject({ version: 1 });
          });

          it('takes the flag again with the same play script, however its keys are ordered', async () => {
            const same = { expect: script.expect, steps: script.steps.map((step) => Object.fromEntries(Object.entries(step).reverse())) };
            expect((await revised([{ ...coverage('AC-1'), play: same, regression: true }, coverage('AC-2')], guarded))[0]).toEqual({ ...coverage('AC-1'), play: script, regression: true });
          });
        });
      });

      // The model answers to the revision's schema, so a play script the engine takes but this schema forbids could never be written.
      it('is a shape the revision schema allows, and null clears', async () => {
        const { schema } = await loadRole(fileURLToPath(new URL('../seed/knowledge', import.meta.url)), 'qa_engineer', 'revise_test_plan');
        const validate = new Ajv({ strict: false }).compile(schema);
        const revision = (play: unknown) => ({ unaffected: false, rationale: 'r', body: '# Plan\n', coverage: [{ ...coverage('AC-1', []), play }], ticket_decisions: [], tickets: [] });
        const full = { steps: [{ key: 'Space', hold_ms: 100 }, { wait_ms: 500 }, { eval: 'window.start()' }], expect: 'window.started === true' };

        expect(validate(revision(full)), JSON.stringify(validate.errors)).toBe(true);
        expect(validate(revision(null)), JSON.stringify(validate.errors)).toBe(true);
        expect(validate({ ...revision(full), coverage: [coverage('AC-1', [])] }), JSON.stringify(validate.errors)).toBe(true);
        expect(validate(revision({ steps: [{ press: 'Space' }], expect: 'true' }))).toBe(false);
        expect(validate(revision({ steps: [] }))).toBe(false);
      });
    });

    it('keeps the protected globs when the plan is revised, which has no way to name new ones', async () => {
      await publish(e, await apply(e, 'test_plan', { ...TEST_PLAN, protected: ['acceptance/**'] }, { inputs: ['SPEC-M1@1'] }));
      const revision = { unaffected: false, rationale: 'r', body: '# Plan two\n', coverage: [coverage('AC-1', ['npm run lint']), coverage('AC-2')], ticket_decisions: [], tickets: [] };

      await publish(e, await apply(e, 'revise_test_plan', revision, { inputs: ['SPEC-M1@1', 'TEST-PLAN-M1@1'] }));

      expect(await latest('TEST-PLAN-M1')).toMatchObject({ version: 2 });
      expect((await read('TEST-PLAN-M1')).fields.data).toEqual({ coverage: revision.coverage, protected: ['acceptance/**'] });
    });

    // The model is shown the Test Plan without its flags, so a revision that leaves regression out is not asking for it to go.
    describe('a revision and the regression flag', () => {
      const flagged = [{ ...coverage('AC-1'), regression: true }, coverage('AC-2')];
      const revise = async (rows: unknown[]) => {
        await publish(e, await apply(e, 'test_plan', { ...TEST_PLAN, coverage: flagged }, { inputs: ['SPEC-M1@1'] }));
        const revision = { unaffected: false, rationale: 'r', body: '# Plan two\n', coverage: rows, ticket_decisions: [], tickets: [] };
        await publish(e, await apply(e, 'revise_test_plan', revision, { inputs: ['SPEC-M1@1', 'TEST-PLAN-M1@1'] }));
        expect(await latest('TEST-PLAN-M1')).toMatchObject({ version: 2 });
        return ((await read('TEST-PLAN-M1')).fields.data as { coverage: unknown[] }).coverage;
      };

      it('keeps the flag of an entry that leaves it out and keeps its commands, whatever their spacing', async () => {
        expect(await revise([coverage('AC-1', ['  npm test ']), coverage('AC-2')])).toEqual([{ ...coverage('AC-1', ['  npm test ']), regression: true }, coverage('AC-2')]);
      });

      // The flag was approved for the commands it was asked on, so carrying it onto new ones would let QA revise vacuous commands in under a guard.
      it('drops the flag of an entry that leaves it out and changes its commands', async () => {
        expect(await revise([coverage('AC-1', ['npm run lint']), coverage('AC-2')])).toEqual([coverage('AC-1', ['npm run lint']), coverage('AC-2')]);
      });

      it('clears the flag of an entry that says false', async () => {
        expect(await revise([{ ...coverage('AC-1'), regression: false }, coverage('AC-2')])).toEqual([{ ...coverage('AC-1'), regression: false }, coverage('AC-2')]);
      });

      it('clears the flag of an entry that says false and changes its commands', async () => {
        expect(await revise([{ ...coverage('AC-1', ['npm run lint']), regression: false }, coverage('AC-2')])).toEqual([{ ...coverage('AC-1', ['npm run lint']), regression: false }, coverage('AC-2')]);
      });

      it('keeps the flag of an entry that says true again', async () => {
        expect(await revise([coverage('AC-1'), coverage('AC-2')].map((row) => (row.ac === 'AC-1' ? { ...row, regression: true } : row)))).toEqual(flagged);
      });

      const refusal = (ac: string, version = 1) => `${ac} has no regression flag in TEST-PLAN-M1@${version}. A revision can keep or clear one, but not add it: raise a Change Request proposing ${ac}'s current commands, which the stakeholder decides.`;

      // QA can stale its own harness tickets with a section request and so trigger its own revision, so a flag added here would be QA waiving its own base check.
      it('refuses a revision that adds the flag to an entry the replaced version covered without it', async () => {
        await publish(e, await apply(e, 'test_plan', { ...TEST_PLAN, coverage: flagged }, { inputs: ['SPEC-M1@1'] }));
        const revision = { unaffected: false, rationale: 'r', body: '# Plan two\n', coverage: [coverage('AC-1'), { ...coverage('AC-2'), regression: true }], ticket_decisions: [], tickets: [] };

        expect(evidenceOf(await apply(e, 'revise_test_plan', revision, { inputs: ['SPEC-M1@1', 'TEST-PLAN-M1@1'] }))).toBe(refusal('AC-2'));
        expect(await latest('TEST-PLAN-M1')).toMatchObject({ version: 1 });
      });

      it('refuses the flag on an entry the replaced version had set false, and names each entry it refuses', async () => {
        await publish(e, await apply(e, 'test_plan', { ...TEST_PLAN, coverage: [{ ...coverage('AC-1'), regression: false }, coverage('AC-2')] }, { inputs: ['SPEC-M1@1'] }));
        const revision = { unaffected: false, rationale: 'r', body: '# Plan two\n', coverage: [{ ...coverage('AC-1'), regression: true }, { ...coverage('AC-2'), regression: true }], ticket_decisions: [], tickets: [] };

        expect(evidenceOf(await apply(e, 'revise_test_plan', revision, { inputs: ['SPEC-M1@1', 'TEST-PLAN-M1@1'] }))).toBe(`${refusal('AC-1')}\n${refusal('AC-2')}`);
      });

      it('refuses a revision that keeps the flag on an entry whose commands it changes', async () => {
        await publish(e, await apply(e, 'test_plan', { ...TEST_PLAN, coverage: flagged }, { inputs: ['SPEC-M1@1'] }));
        const revision = { unaffected: false, rationale: 'r', body: '# Plan two\n', coverage: [{ ...coverage('AC-1', ['npm run lint']), regression: true }, coverage('AC-2')], ticket_decisions: [], tickets: [] };

        expect(evidenceOf(await apply(e, 'revise_test_plan', revision, { inputs: ['SPEC-M1@1', 'TEST-PLAN-M1@1'] }))).toBe(
          "AC-1's commands differ from TEST-PLAN-M1@1, so its regression flag can't stay. A revision that changes a guard's commands drops the flag: raise a Change Request proposing AC-1's new commands once they are in, which the stakeholder decides.",
        );
        expect(await latest('TEST-PLAN-M1')).toMatchObject({ version: 1 });
      });

      it('gives an entry for a criterion the replaced version did not cover the flag it asks for, as at authoring', async () => {
        // Written by hand: the applier would refuse a plan that leaves AC-2 out, but a version from before a criterion moved can.
        await e.artifacts.commit(await projectOf(e), { message: 'an older plan', publish: [{ id: 'TEST-PLAN-M1', type: 'test_plan', status: 'approved', ownerRole: 'qa_engineer', derivedFrom: ['SPEC-M1@1'], milestone: 1, body: '# Plan\n', fields: { data: { coverage: [flagged[0]], protected: [] } } }] });
        const revision = { unaffected: false, rationale: 'r', body: '# Plan two\n', coverage: [coverage('AC-1'), { ...coverage('AC-2'), regression: true }], ticket_decisions: [], tickets: [] };

        await publish(e, await apply(e, 'revise_test_plan', revision, { inputs: ['SPEC-M1@1', 'TEST-PLAN-M1@1'] }));

        expect(((await read('TEST-PLAN-M1')).fields.data as { coverage: unknown[] }).coverage).toEqual([flagged[0], { ...coverage('AC-2'), regression: true }]);
      });

      it('gives an entry for a criterion the replaced version did not cover no flag when it leaves it out', async () => {
        await e.artifacts.commit(await projectOf(e), { message: 'an older plan', publish: [{ id: 'TEST-PLAN-M1', type: 'test_plan', status: 'approved', ownerRole: 'qa_engineer', derivedFrom: ['SPEC-M1@1'], milestone: 1, body: '# Plan\n', fields: { data: { coverage: [flagged[0]], protected: [] } } }] });
        const revision = { unaffected: false, rationale: 'r', body: '# Plan two\n', coverage: [coverage('AC-1'), coverage('AC-2')], ticket_decisions: [], tickets: [] };

        await publish(e, await apply(e, 'revise_test_plan', revision, { inputs: ['SPEC-M1@1', 'TEST-PLAN-M1@1'] }));

        expect(((await read('TEST-PLAN-M1')).fields.data as { coverage: unknown[] }).coverage).toEqual([flagged[0], coverage('AC-2')]);
      });
    });

    it('wants Q keys from a Test Plan', async () => {
      expect(evidenceOf(await apply(e, 'test_plan', { ...TEST_PLAN, harness_tickets: [draft('T-1', ['AC-1'])] }))).toMatch(/key/);
    });
  });

  describe('test_plan with a human check', () => {
    beforeEach(() => lockSpec(e, [CRITERIA[0]!, HUMAN]));

    it('needs no coverage for a human check', async () => {
      const [row] = await publish(e, await apply(e, 'test_plan', { ...TEST_PLAN, coverage: [coverage('AC-1')] }));
      expect(row).toMatchObject({ artifact_id: 'TEST-PLAN-M1', status: 'approved' });
      expect((await read('TEST-PLAN-M1')).fields.data).toEqual({ coverage: [coverage('AC-1')], protected: [] });
    });

    it('rejects coverage for a human check', async () => {
      expect(evidenceOf(await apply(e, 'test_plan', TEST_PLAN))).toMatch(/AC-2 is checked by the stakeholder/);
    });

    it('holds a revised Test Plan to the same rule', async () => {
      await publish(e, await apply(e, 'test_plan', { ...TEST_PLAN, coverage: [coverage('AC-1')] }, { inputs: ['SPEC-M1@1'] }));
      const output = { unaffected: false, rationale: 'r', body: '# Plan two\n', ticket_decisions: [], tickets: [] };

      expect(evidenceOf(await apply(e, 'revise_test_plan', { ...output, coverage: TEST_PLAN.coverage }))).toMatch(/AC-2 is checked by the stakeholder/);

      await publish(e, await apply(e, 'revise_test_plan', { ...output, coverage: [coverage('AC-1', ['npm run lint'])] }, { inputs: ['SPEC-M1@1', 'TEST-PLAN-M1@1'] }));
      expect(await latest('TEST-PLAN-M1')).toMatchObject({ version: 2, status: 'approved' });
    });
  });

  describe('revise', () => {
    const decide = (ticket: string, decision = 'still_valid') => ({ ticket, decision, rationale: `${ticket} ${decision}` });

    // The design and tasks a Conductor would have made, with the spec moved on under them.
    beforeEach(async () => {
      await lockSpec(e);
      await publish(e, await apply(e, 'tech_design', DESIGN, { inputs: ['SPEC-M1@1'] }));
      await ticketTask(e, 'M1-T-1', { ac_refs: ['AC-1'] });
      await ticketTask(e, 'M1-T-2', { ac_refs: ['AC-2'] });
      const moved = [{ ...CRITERIA[0]!, text: 'The first thing works better' }, CRITERIA[1]!];
      await e.artifacts.commit(await projectOf(e), { message: 'the spec moves', publish: [{ id: 'SPEC-M1', type: 'spec', status: 'approved', ownerRole: 'pm', derivedFrom: [], milestone: 1, body: specBody(moved) }] });
    });

    const revise = (output: Record<string, unknown>, inputs = ['SPEC-M1@2', 'TECH-M1@1']) => apply(e, 'revise_design', { ...REVISE, ...output }, { inputs });
    const taskState = async (id: string) => (await e.store.getTaskByTicket((await projectOf(e)).id, id))?.state;
    const setState = async (id: string, ...states: Parameters<TestEngine['store']['setTaskState']>[1][]) => {
      const task = await e.store.getTaskByTicket((await projectOf(e)).id, id);
      for (const state of states) await e.store.setTaskState(task!.id, state);
    };

    it('starts from a design and tickets the moved spec made stale', async () => {
      expect((await latest('TECH-M1'))?.status).toBe('stale');
      expect((await latest('M1-T-1'))?.status).toBe('stale');
      expect((await latest('M1-T-2'))?.status).toBe('approved');
    });

    it('rejects a revise output that leaves an open ticket undecided', async () => {
      expect(evidenceOf(await revise({ ticket_decisions: [decide('M1-T-1')] }))).toMatch(/M1-T-2/);
    });

    it('rejects a decision made twice, or about a ticket that is not open', async () => {
      expect(evidenceOf(await revise({ ticket_decisions: [decide('M1-T-1'), decide('M1-T-1'), decide('M1-T-2')] }))).toMatch(/M1-T-1.*once/);
      expect(evidenceOf(await revise({ ticket_decisions: [decide('M1-T-1'), decide('M1-T-2'), decide('M1-T-8')] }))).toMatch(/M1-T-8/);
    });

    it('rejects an affected design with no body', async () => {
      expect(evidenceOf(await revise({ body: null, ticket_decisions: [decide('M1-T-1'), decide('M1-T-2')] }))).toMatch(/body/);
    });

    it('passes on what validateTickets finds in new tickets', async () => {
      const result = await revise({ ticket_decisions: [decide('M1-T-1'), decide('M1-T-2')], tickets: [draft('T-1', ['AC-1'])] });
      expect(evidenceOf(result)).toMatch(/already exists/);
    });

    it('re-pins on unaffected and logs the rationale', async () => {
      const rows = await publish(e, await revise({ unaffected: true, body: null, rationale: 'Only wording moved', ticket_decisions: [decide('M1-T-1'), decide('M1-T-2')] }));

      const tech = await latest('TECH-M1');
      expect(tech).toMatchObject({ version: 1, status: 'approved', derived_from: ['SPEC-M1@2'], stale_sections: [] });
      expect(rows.find((row) => row.artifact_id === 'M1-T-1')).toMatchObject({ status: 'approved', derived_from: ['TECH-M1@1', 'SPEC-M1@2#ac-1'] });

      const events = await e.log.list({ projectId: (await projectOf(e)).id });
      const repinned = events.filter((event) => event.type === 'lineage.repinned').map((event) => event.payload);
      expect(repinned).toContainEqual({ id: 'TECH-M1', rationale: 'Only wording moved' });
      expect(repinned).toContainEqual({ id: 'M1-T-1', rationale: 'M1-T-1 still_valid' });
    });

    // The work order froze the inputs, so a Spec approved while the worker decided is one it never read.
    it.each([
      ['unaffected', { unaffected: true, body: null }, 1],
      ['revised', {}, 2],
    ])('leaves the design stale when the spec moved again while the worker decided, %s', async (_name, output, version) => {
      const moved = [{ ...CRITERIA[0]!, text: 'The first thing works best' }, CRITERIA[1]!];
      await e.artifacts.commit(await projectOf(e), { message: 'the spec moves again', publish: [{ id: 'SPEC-M1', type: 'spec', status: 'approved', ownerRole: 'pm', derivedFrom: [], milestone: 1, body: specBody(moved) }] });

      await publish(e, await revise({ ...output, ticket_decisions: [decide('M1-T-1'), decide('M1-T-2')] }));

      expect(await latest('TECH-M1')).toMatchObject({ version, status: 'stale', derived_from: ['SPEC-M1@2'] });
    });

    it('publishes a new version and leaves nothing it decided on stale', async () => {
      await publish(e, await revise({ ticket_decisions: [decide('M1-T-1'), decide('M1-T-2')] }));

      expect(await latest('TECH-M1')).toMatchObject({ version: 2, status: 'approved', approved_by: 'owner:tech_lead', derived_from: ['SPEC-M1@2'] });
      expect(await latest('M1-T-1')).toMatchObject({ version: 1, status: 'approved', derived_from: ['TECH-M1@2', 'SPEC-M1@2#ac-1'] });
      expect(await latest('M1-T-2')).toMatchObject({ version: 1, status: 'approved', derived_from: ['TECH-M1@2', 'SPEC-M1@2#ac-2'] });
    });

    it('never edits an existing ticket: new work is a new ticket', async () => {
      const dir = stateRepoDir(e.paths, 'p');
      const before = (await readFile(join(dir, 'artifacts/ticket/M1-T-1.md'), 'utf8')).split('---\n')[2];

      await publish(e, await revise({ ticket_decisions: [decide('M1-T-1', 'superseded'), decide('M1-T-2')], tickets: [draft('T-3', ['AC-1'], { body: 'New work\n' })] }));

      expect((await readFile(join(dir, 'artifacts/ticket/M1-T-1.md'), 'utf8')).split('---\n')[2]).toBe(before);
      expect(await latest('M1-T-1')).toMatchObject({ version: 1, status: 'superseded' });
      expect(await latest('M1-T-3')).toMatchObject({ version: 1, status: 'approved', derived_from: ['TECH-M1@2', 'SPEC-M1@2#ac-1'] });
      expect((await read('M1-T-3')).body).toBe('New work\n');
    });

    it('cancels a superseded task that is not live and leaves a live one to the conductor', async () => {
      await setState('M1-T-2', 'ready', 'running');

      await publish(e, await revise({ ticket_decisions: [decide('M1-T-1', 'superseded'), decide('M1-T-2', 'superseded')], tickets: [draft('T-3', ['AC-1', 'AC-2'])] }));

      expect(await taskState('M1-T-1')).toBe('cancelled');
      expect(await taskState('M1-T-2')).toBe('running');
    });

    it('re-pins a done ticket without reopening it or asking about it', async () => {
      await setState('M1-T-1', 'ready', 'running', 'checks', 'done');

      await publish(e, await revise({ ticket_decisions: [decide('M1-T-2')] }));

      expect(await taskState('M1-T-1')).toBe('done');
      expect(await latest('M1-T-1')).toMatchObject({ status: 'approved', derived_from: ['TECH-M1@2', 'SPEC-M1@2#ac-1'] });
    });

    // The worker is told which tickets are open when its order is written, and a ticket that isn't stale can merge while it decides.
    it('ignores a decision about a ticket that closed while the worker was deciding', async () => {
      await setState('M1-T-1', 'ready', 'running', 'checks', 'done');

      await publish(e, await revise({ ticket_decisions: [decide('M1-T-1'), decide('M1-T-2')] }));

      expect(await taskState('M1-T-1')).toBe('done');
      expect(await latest('M1-T-1')).toMatchObject({ status: 'approved', derived_from: ['TECH-M1@2', 'SPEC-M1@2#ac-1'] });
    });

    it('never lets a late decision supersede a ticket that has merged', async () => {
      await setState('M1-T-1', 'ready', 'running', 'checks', 'done');

      await publish(e, await revise({ ticket_decisions: [decide('M1-T-1', 'superseded'), decide('M1-T-2')] }));

      expect(await taskState('M1-T-1')).toBe('done');
      expect(await latest('M1-T-1')).toMatchObject({ status: 'approved' });
    });

    it('rejects a valid or new ticket that depends on one it supersedes', async () => {
      const project = await projectOf(e);
      await e.store.createTask({ project_id: project.id, ticket_id: 'M1-T-3', title: 'x', milestone: 1, role_id: 'engineer', ticket_path: '', ticket_sha: '', touches: ['src/**'], depends_on: ['M1-T-1'], dod: ['true'], kind: 'ticket', ac_refs: ['AC-1'] });
      const decisions = [decide('M1-T-1', 'superseded'), decide('M1-T-2'), decide('M1-T-3')];
      expect(evidenceOf(await revise({ ticket_decisions: decisions }))).toMatch(/M1-T-3.*M1-T-1/);
      const replaced = [decide('M1-T-1', 'superseded'), decide('M1-T-2'), decide('M1-T-3', 'superseded')];
      const result = await revise({ ticket_decisions: replaced, tickets: [draft('T-4', ['AC-1'], { depends_on: ['T-1'] })] });
      expect(evidenceOf(result)).toMatch(/T-4.*M1-T-1/);
    });

    it('rejects a design revise that leaves a criterion with no ticket', async () => {
      const result = await revise({ ticket_decisions: [decide('M1-T-1', 'superseded'), decide('M1-T-2')] });
      expect(evidenceOf(result)).toMatch(/AC-1/);
    });

    it('decides only its own tickets: Q for the Test Plan, the rest for the design', async () => {
      await publish(e, await apply(e, 'test_plan', { ...TEST_PLAN, harness_tickets: [draft('Q-1', ['AC-1'])] }, { inputs: ['SPEC-M1@2'] }));
      await ticketTask(e, 'M1-Q-1', { ac_refs: ['AC-1'] });

      const forPlan = { unaffected: true, rationale: 'r', body: null, coverage: null, tickets: [] };
      expect(evidenceOf(await apply(e, 'revise_test_plan', { ...forPlan, ticket_decisions: [] }, { inputs: ['SPEC-M1@2'] }))).toMatch(/M1-Q-1/);
      expect(evidenceOf(await apply(e, 'revise_test_plan', { ...forPlan, ticket_decisions: [decide('M1-Q-1'), decide('M1-T-1')] }, { inputs: ['SPEC-M1@2'] }))).toMatch(/M1-T-1/);
      await publish(e, await revise({ ticket_decisions: [decide('M1-T-1'), decide('M1-T-2')] }));
    });

    it('wants full coverage from a Test Plan revise with a body', async () => {
      await publish(e, await apply(e, 'test_plan', TEST_PLAN, { inputs: ['SPEC-M1@1'] }));
      const output = { unaffected: false, rationale: 'r', body: '# Plan two\n', ticket_decisions: [], tickets: [] };

      expect(evidenceOf(await apply(e, 'revise_test_plan', { ...output, coverage: null }))).toMatch(/coverage/);
      expect(evidenceOf(await apply(e, 'revise_test_plan', { ...output, coverage: [coverage('AC-1')] }))).toMatch(/AC-2/);

      await publish(e, await apply(e, 'revise_test_plan', { ...output, coverage: TEST_PLAN.coverage }, { inputs: ['SPEC-M1@2', 'TEST-PLAN-M1@1'] }));
      expect(await latest('TEST-PLAN-M1')).toMatchObject({ version: 2, status: 'approved', derived_from: ['SPEC-M1@2'] });
      expect((await read('TEST-PLAN-M1')).fields.data).toEqual({ coverage: TEST_PLAN.coverage, protected: [] });
    });
  });

  describe('revise_scope', () => {
    const decide = (ticket: string, decision = 'still_valid') => ({ ticket, decision, rationale: `${ticket} ${decision}` });

    // The scope and tasks a Conductor would have made, with the spec moved on under them.
    beforeEach(async () => {
      await lockSpec(e);
      await structuredDesign();
      await publish(e, await apply(e, 'ticket_scope', SCOPE, { inputs: ['SPEC-M1@1', 'TECH-M1@1'], role: 'eng_lead' }));
      await ticketTask(e, 'M1-T-1', { ac_refs: ['AC-1'] });
      await ticketTask(e, 'M1-T-2', { ac_refs: ['AC-2'] });
      const moved = [{ ...CRITERIA[0]!, text: 'The first thing works better' }, CRITERIA[1]!];
      await e.artifacts.commit(await projectOf(e), { message: 'the spec moves', publish: [{ id: 'SPEC-M1', type: 'spec', status: 'approved', ownerRole: 'pm', derivedFrom: [], milestone: 1, body: specBody(moved) }] });
    });

    const revise = (output: Record<string, unknown>, inputs = ['SPEC-M1@2', 'TECH-M1@1', 'SCOPE-M1@1']) => apply(e, 'revise_scope', { ...REVISE, body: '# Scope two\n', ...output }, { inputs, role: 'eng_lead' });

    it('starts from a scope and tickets the moved spec made stale', async () => {
      expect((await latest('SCOPE-M1'))?.status).toBe('stale');
      expect((await latest('M1-T-1'))?.status).toBe('stale');
      expect((await latest('M1-T-2'))?.status).toBe('approved');
    });

    it('rejects a revise output that leaves an open ticket undecided', async () => {
      expect(evidenceOf(await revise({ ticket_decisions: [decide('M1-T-1')] }))).toMatch(/M1-T-2/);
    });

    it('re-pins on unaffected and keeps the tickets the Eng Lead\'s', async () => {
      const rows = await publish(e, await revise({ unaffected: true, body: null, rationale: 'Only wording moved', ticket_decisions: [decide('M1-T-1'), decide('M1-T-2')] }));

      expect(await latest('SCOPE-M1')).toMatchObject({ version: 1, status: 'approved', derived_from: ['SPEC-M1@2', 'TECH-M1@1'], stale_sections: [] });
      expect(rows.find((row) => row.artifact_id === 'M1-T-1')).toMatchObject({ status: 'approved', approved_by: 'owner:eng_lead', derived_from: ['SCOPE-M1@1', 'SPEC-M1@2#ac-1'] });
    });

    it('publishes a new version owned by eng_lead and re-pins its tickets on it', async () => {
      await publish(e, await revise({ ticket_decisions: [decide('M1-T-1'), decide('M1-T-2')] }));

      expect(await latest('SCOPE-M1')).toMatchObject({ version: 2, type: 'ticket_scope', status: 'approved', owner_role: 'eng_lead', approved_by: 'owner:eng_lead', derived_from: ['SPEC-M1@2', 'TECH-M1@1'] });
      expect(await latest('TECH-M1')).toMatchObject({ version: 1, type: 'tech_design' });
      expect(await latest('M1-T-1')).toMatchObject({ version: 1, status: 'approved', approved_by: 'owner:eng_lead', derived_from: ['SCOPE-M1@2', 'SPEC-M1@2#ac-1'] });
      expect(await latest('M1-T-2')).toMatchObject({ version: 1, status: 'approved', derived_from: ['SCOPE-M1@2', 'SPEC-M1@2#ac-2'] });
    });

    it('holds a new ticket to the design\'s components and lists its tests', async () => {
      const decisions = [decide('M1-T-1', 'superseded'), decide('M1-T-2')];
      expect(evidenceOf(await revise({ ticket_decisions: decisions, tickets: [draft('T-3', ['AC-1'])] }))).toMatch(/T-3: components is empty/);
      expect(evidenceOf(await revise({ ticket_decisions: decisions, tickets: [draft('T-3', ['AC-1'], { components: ['renderer'] })] }))).toContain('T-3: components names "renderer", which the Tech Design does not have');

      await publish(e, await revise({ ticket_decisions: decisions, tickets: [draft('T-3', ['AC-1'], { components: ['core'] })] }));

      expect(await latest('M1-T-1')).toMatchObject({ status: 'superseded' });
      expect(await latest('M1-T-3')).toMatchObject({ version: 1, status: 'approved', owner_role: 'eng_lead', approved_by: 'owner:eng_lead', derived_from: ['SCOPE-M1@2', 'SPEC-M1@2#ac-1'] });
      const ticket = await read('M1-T-3');
      expect(ticket.fields.components).toEqual(['core']);
      expect(ticket.body).toBe('Do it.\n\n## Tests\n\n- core: test/core/**\n');
      expect(await e.store.getTaskByTicket((await projectOf(e)).id, 'M1-T-1')).toMatchObject({ state: 'cancelled' });
    });

    it('rejects a scope revise that leaves a criterion with no ticket', async () => {
      const result = await revise({ ticket_decisions: [decide('M1-T-1', 'superseded'), decide('M1-T-2')] });
      expect(evidenceOf(result)).toMatch(/AC-1/);
    });
  });

  describe('milestone_review', () => {
    const REVIEW = { body: '# How it went\n', known_issues: ['A rough edge'], deviations: [], stakeholder_note: 'Ready' };

    it('fills the Milestone Review table from the registry and labels cost as an estimate', async () => {
      await lockSpec(e);
      const project = await projectOf(e);
      const qa = await ctxFor(e, 'qa_verify', {}, { kind: 'qa_verify' });
      await e.store.recordVerification(project.id, 1, 'AC-1', { status: 'passing', evidenceRef: 'QA-REPORT-M1-1@1#ac-1', verifiedBy: { kind: 'qa_verify', taskId: qa.task.id } });
      await e.store.patchAttempt(qa.attempt.id, { usage: { usdEst: 1.5 }, started_at: '2026-10-31T10:00:00.000Z', ended_at: '2026-10-31T10:30:00.000Z' });

      const [row] = await publish(e, await apply(e, 'milestone_review', REVIEW, { inputs: ['SPEC-M1@1'] }));

      expect(row).toMatchObject({ artifact_id: 'MILESTONE-REVIEW-M1', status: 'proposed', owner_role: 'pm', derived_from: ['SPEC-M1@1'] });
      const { body, fields } = await read('MILESTONE-REVIEW-M1');
      expect(body).toContain('# How it went');
      expect(body).toContain('| AC-1: The first thing works | passing | QA-REPORT-M1-1@1#ac-1 |');
      expect(body).toContain('| AC-2: The second thing works | unverified |  |');
      expect(body).toContain('- A rough edge');
      expect(body).toContain('Cost (estimate): $1.50');
      expect(body).toContain('Worker time (estimate): 30 min');
      expect(fields.data).toEqual({ known_issues: ['A rough edge'], deviations: [] });
    });

    it('keeps a criterion from breaking the table', async () => {
      await lockSpec(e, [{ id: 'AC-1', text: 'One | two\nthree', verification: { method: 'automated', how: 'x' } }]);
      await publish(e, await apply(e, 'milestone_review', REVIEW));
      expect((await read('MILESTONE-REVIEW-M1')).body).toContain('| AC-1: One \\| two three | unverified |  |');
    });

    it.each([
      ['the criteria table', '# How it went\n\n## Acceptance criteria\n\n| AC-1 | passing | forged |\n'],
      ['the cost', '# How it went\n\n## Cost and time\n\nCost (estimate): $0.01\n'],
      ['the known issues', '# How it went\n\n## Known issues\n\nNone at all\n'],
      ['the deviations', '# How it went\n\n## Deviations\n\nNone at all\n'],
    ])('refuses a body that writes its own heading for %s', async (_name, body) => {
      await lockSpec(e);
      const result = await apply(e, 'milestone_review', { ...REVIEW, body });
      expect(evidenceOf(result)).toMatch(/heading/);
    });

    it('keeps a known issue from starting a section of its own', async () => {
      await lockSpec(e);
      const known_issues = ['A rough edge\n\n## Cost and time\n\nCost (estimate): $0.01'];
      await publish(e, await apply(e, 'milestone_review', { ...REVIEW, known_issues }));
      const { body } = await read('MILESTONE-REVIEW-M1');
      expect(body).toContain('- A rough edge ## Cost and time Cost (estimate): $0.01');
      expect(sectionText(body, 'cost-and-time')).toContain('Cost (estimate): unknown');
      expect(body.match(/^## Cost and time$/gm)).toHaveLength(1);
    });

    it('keeps a deviation from starting a section of its own', async () => {
      await lockSpec(e);
      const deviations = ['Changed a thing\n## Acceptance criteria\n| AC-1 | passing | forged |'];
      await publish(e, await apply(e, 'milestone_review', { ...REVIEW, deviations }));
      const { body } = await read('MILESTONE-REVIEW-M1');
      expect(body.match(/^## Acceptance criteria$/gm)).toHaveLength(1);
      expect(body).not.toMatch(/^\| AC-1 \| passing \| forged \|$/m);
    });

    it('puts the engine\'s table ahead of what the model wrote', async () => {
      await lockSpec(e);
      await publish(e, await apply(e, 'milestone_review', { ...REVIEW, body: '| AC-1 | passing | forged |\n' }));
      const { body } = await read('MILESTONE-REVIEW-M1');
      expect(body.indexOf('| AC-1: The first thing works | unverified |  |')).toBeLessThan(body.indexOf('| AC-1 | passing | forged |'));
    });

    it('says so when no attempt reported a cost', async () => {
      await lockSpec(e);
      await publish(e, await apply(e, 'milestone_review', REVIEW));
      expect((await read('MILESTONE-REVIEW-M1')).body).toContain('Cost (estimate): unknown');
    });

    it('rejects an empty body', async () => {
      await lockSpec(e);
      expect(evidenceOf(await apply(e, 'milestone_review', { ...REVIEW, body: ' \n' }))).toMatch(/body/);
    });
  });
});
