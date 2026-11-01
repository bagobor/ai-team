import { readFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import { sectionText } from '../src/artifacts/format.ts';
import { applyOutput } from '../src/engine/apply/index.ts';
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
  stakeholder_note: 'Note',
};
const SPEC = { body: '# Milestone one\n', criteria: CRITERIA, stakeholder_note: 'Note' };
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
const TEST_PLAN = { body: '# Test plan\n', coverage: [coverage('AC-1'), coverage('AC-2')], harness_tickets: [] };
const REVISE = { unaffected: false, rationale: 'The spec moved', body: '# Design two\n', coverage: null, ticket_decisions: [], tickets: [] };

describe('appliers', () => {
  let e: TestEngine;

  beforeEach(async () => {
    e = await makeEngine({ steps: [] });
  });

  afterEach(() => e.cleanup());

  const latest = async (id: string) => e.artifacts.latest((await projectOf(e)).id, id);
  const read = async (pin: string) => e.artifacts.read(await projectOf(e), pin);
  const brief = async () => e.artifacts.commit(await projectOf(e), { message: 'brief', publish: [{ id: 'BRIEF', type: 'brief', status: 'approved', ownerRole: 'stakeholder', derivedFrom: [], body: '# Brief\n' }] });

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
      expect((await read('ENV-PROFILE')).fields.data).toEqual({ commands: PROFILE.commands, toolchains: PROFILE.toolchains, network_allow: PROFILE.network_allow, setup: 'npm ci' });
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
      ['verifies by hand', { criteria: [{ ...CRITERIA[0], verification: { method: 'manual', how: 'look' } }] }, /automated/],
    ])('rejects a spec that %s', async (_name, change, evidence) => {
      expect(evidenceOf(await apply(e, 'milestone_spec', { ...SPEC, ...change }))).toMatch(evidence);
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

  describe('test_plan', () => {
    beforeEach(() => lockSpec(e));

    it('publishes the plan with its coverage as data, approved by its owner', async () => {
      const [row, ticket] = await publish(e, await apply(e, 'test_plan', { ...TEST_PLAN, harness_tickets: [draft('Q-1', ['AC-1'])] }, { inputs: ['SPEC-M1@1'] }));

      expect(row).toMatchObject({ artifact_id: 'TEST-PLAN-M1', status: 'approved', owner_role: 'qa_engineer', approved_by: 'owner:qa_engineer' });
      expect((await read('TEST-PLAN-M1')).fields.data).toEqual({ coverage: TEST_PLAN.coverage });
      expect(ticket).toMatchObject({ artifact_id: 'M1-Q-1', owner_role: 'tech_lead' });
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

    it('wants Q keys from a Test Plan', async () => {
      expect(evidenceOf(await apply(e, 'test_plan', { ...TEST_PLAN, harness_tickets: [draft('T-1', ['AC-1'])] }))).toMatch(/key/);
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
      expect((await read('TEST-PLAN-M1')).fields.data).toEqual({ coverage: TEST_PLAN.coverage });
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
