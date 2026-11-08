import { existsSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import type { Criterion } from '../src/artifacts/acs.ts';
import { renderArtifact, sectionsOf, sectionText } from '../src/artifacts/format.ts';
import type { PlayProblem } from '../src/checks/play.ts';
import { applyOutput } from '../src/engine/apply/index.ts';
import type { ProfileData } from '../src/engine/apply/discovery.ts';
import { bugTicket, playRun } from '../src/engine/apply/qa.ts';
import type { ComponentSpec } from '../src/engine/apply/tech-structure.ts';
import { playBug } from '../src/engine/conductor/play-gate.ts';
import { worktreePath } from '../src/paths.ts';
import { parseTicket } from '../src/tickets/ticket.ts';
import { addAttemptWorktree } from '../src/git/workspace.ts';
import { commitAll, commitOnBranch, revParse, run, tempDir } from './helpers/repo.ts';
import { CRITERIA, ctxFor, evidenceOf, lockSpec, projectOf, publish } from './helpers/apply.ts';
import { makeEngine, type TestEngine } from './helpers/engine.ts';
import { fakePlayer, playResult } from './helpers/play.ts';

type Result = { ac: string; status: 'passing' | 'failing'; commands: string[]; notes: string };
type Bug = { ac: string; title: string; description: string; touches: string[]; commands: string[] };
type Coverage = { ac: string; commands: string[]; notes: string; regression?: boolean; play?: unknown };

const pass = (ac: string, commands: string[] = ['true'], notes = 'Looks good'): Result => ({ ac, status: 'passing', commands, notes });
const fail = (ac: string, commands: string[] = [], notes = 'It broke'): Result => ({ ac, status: 'failing', commands, notes });
const bug = (ac: string, overrides: Partial<Bug> = {}): Bug => ({ ac, title: `${ac} is broken`, description: 'It does the wrong thing', touches: ['src/**'], commands: [], ...overrides });
// Most of these tests run `true`, which passes on any commit, so their entries are regression guards. A fresh entry has to fail without the work.
const covers = (ac: string, ...commands: string[]): Coverage => ({ ac, commands, notes: '', regression: true });
const fresh = (ac: string, ...commands: string[]): Coverage => ({ ac, commands, notes: '' });
// As QA wrote one in a real run: a pin, and a section beside the criterion.
const disputes = (ac: string) => ({ target_artifact: 'TEST-PLAN-M1@1', target_section: `${ac} commands`, target_ac: ac, proposed_text: 'true', rationale: 'The command checks the wrong file', evidence: 'It reads README.txt, which the Spec never names' });

// A Tech Design's components: one its tests keep, one exempt. The hooks hold a Bug's change to every one of them.
const COMPONENTS: ComponentSpec[] = [
  { name: 'core', responsibility: 'The rules', sources: ['src/core/**'], tests: ['test/core/**', 'test/core.test.ts'], no_tests_reason: null, complexity: 'S', complexity_notes: 'Small' },
  { name: 'ui', responsibility: 'The page', sources: ['src/ui/**', '*.html'], tests: [], no_tests_reason: 'The play script covers it', complexity: 'S', complexity_notes: 'Small' },
];
const STRUCTURE = { components: COMPONENTS, complexity: { overall: 'S', rationale: 'Small' }, performance: [], test_strategy: 'Tests beside the code', risks: [] };
const HELD_TO = [
  '## Tests',
  '',
  "The engine refuses an attempt that changes a component's sources without changing that component's tests.",
  '',
  '- core: sources src/core/** — tests test/core/**, test/core.test.ts',
  '- ui: sources src/ui/**, *.html — no tests (The play script covers it)',
  '',
].join('\n');
const structured = async (e: TestEngine): Promise<void> => {
  await e.artifacts.commit(await projectOf(e), {
    message: 'the structured design',
    publish: [{ id: 'TECH-M1', type: 'tech_design', status: 'approved', ownerRole: 'tech_lead', approvedBy: 'owner:tech_lead', derivedFrom: ['SPEC-M1@1'], milestone: 1, body: '# Design\n', fields: { data: STRUCTURE } }],
  });
};

describe('qa_verify applier', () => {
  let e: TestEngine;

  async function setUp(engine: TestEngine, coverage: Coverage[], round = 1, criteria: Criterion[] = CRITERIA, extra: Record<string, unknown> = {}): Promise<void> {
    e = engine;
    await lockSpec(e, criteria);
    const project = await projectOf(e);
    await e.store.createMilestone({ project_id: project.id, n: 1, title: 'First', goal: 'Goal', phase: 'pending' });
    await e.store.patchMilestone(project.id, 1, { verify_round: round });
    await e.artifacts.commit(project, {
      message: 'the design and the plan',
      publish: [
        { id: 'TECH-M1', type: 'tech_design', status: 'approved', ownerRole: 'tech_lead', approvedBy: 'owner:tech_lead', derivedFrom: ['SPEC-M1@1'], milestone: 1, body: '# Design\n' },
        { id: 'TEST-PLAN-M1', type: 'test_plan', status: 'approved', ownerRole: 'tech_lead', approvedBy: 'owner:tech_lead', derivedFrom: ['SPEC-M1@1'], milestone: 1, body: '# Plan\n', fields: { data: { coverage, ...extra } } },
      ],
    });
  }

  const start = async (coverage: Coverage[] = [covers('AC-1', 'true'), covers('AC-2', 'true')], options: Parameters<typeof makeEngine>[0] = { steps: [] }, round = 1, extra: Record<string, unknown> = {}): Promise<void> =>
    setUp(await makeEngine(options), coverage, round, CRITERIA, extra);

  afterEach(async () => {
    await e.cleanup();
  });

  // baseSha is the head QA verifies: the repo's own HEAD unless a test puts the work on a branch past it.
  const qaCtx = async (output: { results: Result[]; bugs?: Bug[]; summary?: string; change_requests?: unknown[] }, worktree?: string, baseSha?: string) =>
    ctxFor(e, 'qa_verify', { bugs: [], summary: 'Done', ...output }, { kind: 'qa_verify', role: 'qa_engineer', inputs: ['SPEC-M1@1', 'TEST-PLAN-M1@1'], baseSha: baseSha ?? (await revParse(e.repoPath)), ...(worktree ? { worktree } : {}) });
  const verify = async (output: Parameters<typeof qaCtx>[0], worktree?: string, baseSha?: string) => applyOutput(await qaCtx(output, worktree, baseSha));
  const baseWorktree = (ctx: Awaited<ReturnType<typeof qaCtx>>) => worktreePath(e.paths, 'p', `${ctx.task.ticket_id}-base`, ctx.attempt.k);
  const headWorktree = (ctx: Awaited<ReturnType<typeof qaCtx>>) => worktreePath(e.paths, 'p', `${ctx.task.ticket_id}-verify`, ctx.attempt.k);
  const headBranch = (ctx: Awaited<ReturnType<typeof qaCtx>>) => run(e.repoPath, 'branch', '--list', `aiteam/verify/${ctx.task.ticket_id}-a${ctx.attempt.k}`).trim();
  const baseBranch = (ctx: Awaited<ReturnType<typeof qaCtx>>) => run(e.repoPath, 'branch', '--list', `aiteam/verify/${ctx.task.ticket_id}-a${ctx.attempt.k}-base`).trim();
  const criterion = async (ac: string) => {
    const found = (await e.store.listCriteria((await projectOf(e)).id, 1)).find((c) => c.ac_id === ac);
    if (!found) throw new Error(`No ${ac}`);
    return found;
  };
  const evidence = async (ac: string): Promise<string> => {
    const { evidence_ref } = await criterion(ac);
    if (!evidence_ref) throw new Error(`${ac} has no evidence`);
    return (await e.artifacts.readInput(await projectOf(e), evidence_ref)).content;
  };
  const ids = async (): Promise<string[]> => (await e.artifacts.list((await projectOf(e)).id)).map((row) => row.artifact_id);

  it('records passing when the Test Plan and QA commands all exit 0', async () => {
    await start([covers('AC-1', 'echo plan-$((1+1))'), covers('AC-2', 'echo other-$((1+2))')]);

    await publish(e, await verify({ results: [pass('AC-1', ['echo qa-one']), pass('AC-2')] }));

    expect(await criterion('AC-1')).toMatchObject({ status: 'passing', evidence_ref: 'QA-REPORT-M1-1@1#ac-1' });
    expect(await criterion('AC-2')).toMatchObject({ status: 'passing', evidence_ref: 'QA-REPORT-M1-1@1#ac-2' });
    const section = await evidence('AC-1');
    expect(section).toContain('echo plan-$((1+1))');
    expect(section).toContain('plan-2');
    expect(section).toContain('echo qa-one');
    expect(section).toContain('exit code 0');
    expect(section).not.toContain('other-3');
    expect((await ids()).filter((id) => id.startsWith('BUG') || id.includes('-B-'))).toEqual([]);
  });

  it('records failing when QA claims passing but a command fails, and files a Bug with the engine output', async () => {
    await start();

    await publish(e, await verify({ results: [pass('AC-1', ['echo from-$((1+1))-engine; exit 1']), pass('AC-2')] }));

    const ac = await criterion('AC-1');
    expect(ac.status).toBe('failing');
    expect(await e.artifacts.read(await projectOf(e), ac.evidence_ref as string)).toMatchObject({ body: expect.stringContaining('exit 1') });
    expect(await evidence('AC-1')).toContain('from-2-engine');
    expect((await criterion('AC-2')).status).toBe('passing');

    const filed = await e.artifacts.read(await projectOf(e), 'BUG-M1-1');
    expect(filed).toMatchObject({ type: 'bug', status: 'approved', ownerRole: 'qa_engineer' });
    expect(filed.body).toContain('from-2-engine');
    expect(filed.fields.data).toMatchObject({ ac: 'AC-1' });
  });

  it('sends QA back, with no Bug filed, when a command it claims passed on is a description no shell can run', async () => {
    await start();

    const evidenceText = evidenceOf(await verify({ results: [pass('AC-1', ['spec AC-1 conv command, verbatim']), pass('AC-2')] }));

    expect(evidenceText).toContain('spec AC-1 conv command, verbatim');
    expect(evidenceText).toContain('AC-1');
    expect(await ids()).not.toContain('BUG-M1-1');
    expect(await ids()).not.toContain('QA-REPORT-M1-1');
    expect((await criterion('AC-1')).status).toBe('unverified');
  });

  it('still records failing when a Test Plan command cannot be found, because that one is the plan\'s', async () => {
    await start([covers('AC-1', 'no-such-tool-on-this-machine'), covers('AC-2', 'true')]);

    await publish(e, await verify({ results: [pass('AC-1'), pass('AC-2')] }));

    expect((await criterion('AC-1')).status).toBe('failing');
    expect(await evidence('AC-1')).toContain('exit code 127');
  });

  it('still records failing when QA itself says failing and names a command that cannot be found', async () => {
    await start();

    await publish(e, await verify({ results: [fail('AC-1', ['no-such-tool-on-this-machine'], 'It is not installed'), pass('AC-2')], bugs: [bug('AC-1')] }));

    expect((await criterion('AC-1')).status).toBe('failing');
    expect(await ids()).toContain('BUG-M1-1');
  });

  it('records failing when QA claims passing with no commands and the Test Plan has none to run', async () => {
    await start([covers('AC-1'), covers('AC-2', 'true')]);

    await publish(e, await verify({ results: [pass('AC-1', []), pass('AC-2')] }));

    expect((await criterion('AC-1')).status).toBe('failing');
    expect(await evidence('AC-1')).toMatch(/no command ran/i);
    expect(await ids()).toContain('BUG-M1-1');
  });

  it('does not count a blank command as one that ran', async () => {
    await start([covers('AC-1'), covers('AC-2', 'true')]);
    await publish(e, await verify({ results: [pass('AC-1', ['   ', '']), pass('AC-2')] }));
    expect((await criterion('AC-1')).status).toBe('failing');
  });

  it('cannot pass with `true` while the Test Plan command fails', async () => {
    await start([covers('AC-1', 'exit 7'), covers('AC-2', 'true')]);

    await publish(e, await verify({ results: [pass('AC-1', ['true']), pass('AC-2')] }));

    expect((await criterion('AC-1')).status).toBe('failing');
    const section = await evidence('AC-1');
    expect(section).toContain('exit 7');
    expect(section).toContain('exit code 7');
  });

  it('runs every Test Plan command before any of QA\'s, so QA cannot rewrite the tests of a later criterion', async () => {
    await start([covers('AC-1', 'true'), covers('AC-2', 'sh check.sh')]);
    await writeFile(join(e.repoPath, 'check.sh'), 'exit 7\n');
    commitAll(e.repoPath, 'the test AC-2 runs');

    await publish(e, await verify({ results: [pass('AC-1', ["printf 'exit 0\\n' > check.sh"]), pass('AC-2')] }));

    expect((await criterion('AC-2')).status).toBe('failing');
    expect(await evidence('AC-2')).toContain('exit code 7');
  });

  it('still reports each criterion with its own commands, the Test Plan\'s first', async () => {
    await start([covers('AC-1', 'echo plan-one-$((1+1))', 'echo shared'), covers('AC-2', 'echo plan-two-$((1+2))')]);

    await publish(e, await verify({ results: [pass('AC-1', ['echo qa-one-$((1+3))', 'echo shared']), pass('AC-2', ['echo qa-two-$((1+4))'])] }));

    const one = await evidence('AC-1');
    expect(one.indexOf('plan-one-2')).toBeGreaterThan(-1);
    expect(one.indexOf('plan-one-2')).toBeLessThan(one.indexOf('qa-one-4'));
    expect(one.match(/Command, /g)).toHaveLength(3);
    expect(one).not.toContain('plan-two-3');
    const two = await evidence('AC-2');
    expect(two).toContain('plan-two-3');
    expect(two).toContain('qa-two-5');
    expect(two).not.toContain('qa-one-4');
  });

  it('runs every command, so a later failure is on record too', async () => {
    await start([covers('AC-1', 'exit 3'), covers('AC-2', 'true')]);
    await publish(e, await verify({ results: [pass('AC-1', ['echo still-$((1+1)); exit 4']), pass('AC-2')] }));
    const section = await evidence('AC-1');
    expect(section).toContain('exit code 3');
    expect(section).toContain('still-2');
    expect(section).toContain('exit code 4');
  });

  it('records failing with notes and the Test Plan output when QA says failing', async () => {
    await start([covers('AC-1', 'echo plan-$((1+1))'), covers('AC-2', 'true')]);

    await publish(e, await verify({ results: [fail('AC-1', [], 'The colour is wrong'), pass('AC-2')], bugs: [bug('AC-1')] }));

    expect((await criterion('AC-1')).status).toBe('failing');
    const section = await evidence('AC-1');
    expect(section).toContain('The colour is wrong');
    expect(section).toContain('plan-2');
  });

  it('rejects output that omits a criterion', async () => {
    await start();
    expect(evidenceOf(await verify({ results: [pass('AC-1')] }))).toMatch(/AC-2/);
  });

  it('rejects output that repeats a criterion', async () => {
    await start();
    expect(evidenceOf(await verify({ results: [pass('AC-1'), pass('AC-1'), pass('AC-2')] }))).toMatch(/AC-1.*twice/);
  });

  describe('with a human check', () => {
    const HUMAN: Criterion = { id: 'AC-2', text: 'Dodging feels fair', verification: { method: 'human', how: 'Play two minutes; you should never die without seeing the shot coming' } };
    const startWithHuman = async (): Promise<void> => setUp(await makeEngine({ steps: [] }), [covers('AC-1', 'true')], 1, [CRITERIA[0]!, HUMAN]);

    it('needs no result for a human check', async () => {
      await startWithHuman();

      await publish(e, await verify({ results: [pass('AC-1')] }));

      expect(await criterion('AC-1')).toMatchObject({ status: 'passing' });
      expect(await criterion('AC-2')).toMatchObject({ status: 'unverified', evidence_ref: null });
      expect(sectionText((await e.artifacts.read(await projectOf(e), 'QA-REPORT-M1-1')).body, 'ac-2')).toBeUndefined();
    });

    it('rejects a result for a human check', async () => {
      await startWithHuman();
      expect(evidenceOf(await verify({ results: [pass('AC-1'), pass('AC-2')] }))).toMatch(/AC-2 is checked by the stakeholder at milestone approval/);
    });

    it('rejects a Bug against a human check', async () => {
      await startWithHuman();
      expect(evidenceOf(await verify({ results: [pass('AC-1')], bugs: [bug('AC-2')] }))).toMatch(/A Bug names AC-2, which is checked by the stakeholder at milestone approval/);
    });
  });

  it('rejects output that names a criterion the milestone does not have', async () => {
    await start();
    expect(evidenceOf(await verify({ results: [pass('AC-1'), pass('AC-2'), pass('AC-9')] }))).toMatch(/AC-9/);
  });

  it.each([
    ['an unknown criterion', bug('AC-9'), /AC-9/],
    ['a blank title', bug('AC-1', { title: ' ' }), /title/],
    ['touches that escape the repo', bug('AC-1', { touches: ['../x/**'] }), /touches/],
    ['touches that name the state folder', bug('AC-1', { touches: ['.aiteam/**'] }), /touches/],
  ])('rejects a Bug with %s', async (_name, filed, problem) => {
    await start();
    expect(evidenceOf(await verify({ results: [fail('AC-1'), pass('AC-2')], bugs: [filed] }))).toMatch(problem);
  });

  it('runs at the attempt base in a fresh worktree, so edits QA made do not count', async () => {
    await start([covers('AC-1', 'test -f made-by-qa.txt'), covers('AC-2', 'test ! -f committed-later.txt')]);
    const base = await revParse(e.repoPath);
    const qaWorktree = join(await tempDir('qa-worktree'), 'wt');
    await addAttemptWorktree(e.repoPath, qaWorktree, 'aiteam/qa-test', base);
    await writeFile(join(qaWorktree, 'made-by-qa.txt'), 'forged\n');

    const ctx = await qaCtx({ results: [pass('AC-1'), pass('AC-2')] }, qaWorktree);
    await writeFile(join(e.repoPath, 'committed-later.txt'), 'x\n');
    commitAll(e.repoPath, 'later');

    await publish(e, await applyOutput(ctx));

    expect((await criterion('AC-1')).status).toBe('failing');
    expect((await criterion('AC-2')).status).toBe('passing');
  });

  it('runs with no network', async () => {
    let connected = false;
    const server = createServer(() => {
      connected = true;
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const { port } = server.address() as AddressInfo;
    try {
      const script = `require('net').connect(${port},'127.0.0.1').on('connect',()=>process.exit(0)).on('error',()=>process.exit(3))`;
      await start([covers('AC-1', `node -e "${script}"`), covers('AC-2', 'true')]);

      await publish(e, await verify({ results: [pass('AC-1'), pass('AC-2')] }));

      expect((await criterion('AC-1')).status).toBe('failing');
      expect(connected).toBe(false);
    } finally {
      server.close();
    }
  });

  it('needs a Bug for every failure and makes one if QA did not', async () => {
    await start([covers('AC-1', 'exit 1'), covers('AC-2', 'exit 2')]);

    await publish(e, await verify({ results: [pass('AC-1'), fail('AC-2')], bugs: [bug('AC-2', { title: 'Second is off', touches: ['web/**'] })] }));

    const project = await projectOf(e);
    const made = await e.artifacts.read(project, 'M1-B-1');
    expect(made.fields).toMatchObject({ ac_refs: ['AC-1'], specialty: 'engineer', touches: ['**'], definition_of_done: ['exit 1'], milestone: 1, depends_on: [] });
    const filed = await e.artifacts.read(project, 'M1-B-2');
    expect(filed.fields).toMatchObject({ title: 'Second is off', ac_refs: ['AC-2'], touches: ['web/**'], definition_of_done: ['exit 2'] });
    expect((await e.artifacts.read(project, 'BUG-M1-2')).body).toContain('It does the wrong thing');
  });

  it('publishes Bug tickets a task can be made from, with pinned inputs that resolve', async () => {
    await start([covers('AC-1', 'exit 1'), covers('AC-2', 'true')]);
    await publish(e, await verify({ results: [pass('AC-1'), pass('AC-2')] }));

    const project = await projectOf(e);
    const doc = await e.artifacts.read(project, 'M1-B-1');
    const parsed = parseTicket(renderArtifact(doc));
    expect(parsed).toMatchObject({ id: 'M1-B-1', milestone: 1, specialty: 'engineer', size: 'S', inputs: ['BUG-M1-1@1', 'TECH-M1@1'] });
    // A Tech Design with no components holds the change to no tests, so the ticket names none.
    expect(doc.body).toBe('Fix what BUG-M1-1 describes, so that AC-1 passes.\n');
    for (const pin of parsed.inputs) await expect(e.artifacts.readInput(project, pin)).resolves.toMatchObject({ pin });
    expect((await e.artifacts.latest(project.id, 'M1-B-1'))?.derived_from).toContain('SPEC-M1@1#ac-1');
    expect(await e.store.getTaskByTicket(project.id, 'M1-B-1')).toBeUndefined();
  });

  it('lists in a Bug ticket the tests each component of the Tech Design is held to', async () => {
    await start([covers('AC-1', 'exit 1'), covers('AC-2', 'true')]);
    await structured(e);
    await publish(e, await verify({ results: [pass('AC-1'), pass('AC-2')] }));

    const doc = await e.artifacts.read(await projectOf(e), 'M1-B-1');
    expect(doc.body).toBe(`Fix what BUG-M1-1 describes, so that AC-1 passes.\n\n${HELD_TO}`);
    expect(parseTicket(renderArtifact(doc))).toMatchObject({ id: 'M1-B-1', inputs: ['BUG-M1-1@1', 'TECH-M1@2'] });
  });

  it('finds a definition of done for a Bug with no failing command', async () => {
    await start([covers('AC-1', 'true'), covers('AC-2', 'true')]);
    await publish(e, await verify({ results: [fail('AC-1', [], 'Wrong by eye'), pass('AC-2')], bugs: [bug('AC-1', { commands: ['npm run eyeball'] })] }));
    expect((await e.artifacts.read(await projectOf(e), 'M1-B-1')).fields.definition_of_done).toEqual(['npm run eyeball']);
  });

  it('notes a Bug against a criterion that passes without opening a ticket', async () => {
    await start();
    await publish(e, await verify({ results: [pass('AC-1'), pass('AC-2')], bugs: [bug('AC-1', { title: 'A side observation' })] }));

    expect((await criterion('AC-1')).status).toBe('passing');
    expect((await ids()).filter((id) => id.startsWith('BUG') || id.includes('-B-'))).toEqual([]);
    expect(await evidence('AC-1')).toContain('A side observation');
  });

  it('files no Bug for a criterion whose only failure is a Test Plan command QA asked to change', async () => {
    await start([covers('AC-1', 'exit 1'), covers('AC-2', 'true')]);

    await publish(e, await verify({ results: [pass('AC-1'), pass('AC-2')], change_requests: [disputes('AC-1')] }));

    expect((await criterion('AC-1')).status).toBe('failing');
    expect((await ids()).filter((id) => id.startsWith('BUG') || id.includes('-B-'))).toEqual([]);
    expect((await e.artifacts.read(await projectOf(e), 'CR-1')).fields.data).toMatchObject({ target_artifact: 'TEST-PLAN-M1', target_ac: 'AC-1', proposed_text: 'true' });
    expect(await evidence('AC-1')).toContain('CR-1');
  });

  it.each([
    ['one of QA\'s own commands fails as well', { results: [pass('AC-1', ['exit 3']), pass('AC-2')] }],
    ['QA itself says it fails', { results: [fail('AC-1'), pass('AC-2')] }],
    ['the request is about another criterion', { results: [pass('AC-1'), pass('AC-2')], change_requests: [disputes('AC-2')] }],
  ])('still files the Bug when %s', async (_, output) => {
    await start([covers('AC-1', 'exit 1'), covers('AC-2', 'true')]);

    await publish(e, await verify({ change_requests: [disputes('AC-1')], ...output }));

    expect(await ids()).toEqual(expect.arrayContaining(['BUG-M1-1', 'M1-B-1']));
  });

  it('numbers Bugs across rounds without reusing one', async () => {
    await start([covers('AC-1', 'exit 1'), covers('AC-2', 'true')]);
    await publish(e, await verify({ results: [pass('AC-1'), pass('AC-2')] }));

    await e.store.patchMilestone((await projectOf(e)).id, 1, { verify_round: 2 });
    await publish(e, await verify({ results: [pass('AC-1'), pass('AC-2')] }));

    expect(await criterion('AC-1')).toMatchObject({ status: 'failing', evidence_ref: 'QA-REPORT-M1-2@1#ac-1' });
    const all = await ids();
    expect(all).toEqual(expect.arrayContaining(['QA-REPORT-M1-1', 'QA-REPORT-M1-2', 'BUG-M1-1', 'BUG-M1-2', 'M1-B-1', 'M1-B-2']));
  });

  it('removes the fresh worktree even when a command times out', async () => {
    await start([covers('AC-1', 'sleep 30'), covers('AC-2', 'true')], { steps: [], config: { checkTimeoutS: 1 } });
    const ctx = await qaCtx({ results: [pass('AC-1'), pass('AC-2')] });

    await publish(e, await applyOutput(ctx));

    expect((await criterion('AC-1')).status).toBe('failing');
    expect(await evidence('AC-1')).toContain('timed out');
    expect(existsSync(worktreePath(e.paths, 'p', `${ctx.task.ticket_id}-verify`, ctx.attempt.k))).toBe(false);
    expect(run(e.repoPath, 'branch', '--list', `aiteam/verify/${ctx.task.ticket_id}-a${ctx.attempt.k}`).trim()).toBe('');
  });

  it('runs the Environment Profile setup first, in that fresh worktree', async () => {
    await start([covers('AC-1', 'test -f installed.txt'), covers('AC-2', 'true')]);
    const project = await projectOf(e);
    await e.artifacts.commit(project, { message: 'the profile', publish: [{ id: 'ENV-PROFILE', type: 'environment_profile', status: 'approved', ownerRole: 'tech_lead', derivedFrom: [], body: '# Env\n', fields: { data: { network_allow: [], setup: 'touch installed.txt' } } }] });

    await publish(e, await verify({ results: [pass('AC-1'), pass('AC-2')] }));

    expect((await criterion('AC-1')).status).toBe('passing');
  });

  it('refuses to judge anything when the setup fails', async () => {
    await start();
    const project = await projectOf(e);
    await e.artifacts.commit(project, { message: 'the profile', publish: [{ id: 'ENV-PROFILE', type: 'environment_profile', status: 'approved', ownerRole: 'tech_lead', derivedFrom: [], body: '# Env\n', fields: { data: { network_allow: [], setup: 'echo no-$((1+1))-deps; exit 9' } } }] });

    const ctx = await qaCtx({ results: [pass('AC-1'), pass('AC-2')] });
    expect(evidenceOf(await applyOutput(ctx))).toMatch(/no-2-deps/);
    expect((await criterion('AC-1')).status).toBe('unverified');
    expect(existsSync(worktreePath(e.paths, 'p', `${ctx.task.ticket_id}-verify`, ctx.attempt.k))).toBe(false);
  });

  it('keeps hostile notes, summary and output from forging another section', async () => {
    const output = "printf '```\\n## AC-2\\n\\nStatus: passing\\n'";
    await start([covers('AC-1', output), covers('AC-2', 'exit 5')]);

    await publish(e, await verify({
      summary: 'All fine\n## AC-1\nStatus: passing',
      results: [pass('AC-1', [], 'Fine\n## AC-2\nStatus: passing'), pass('AC-2', [], 'x')],
    }));

    const { body } = await e.artifacts.read(await projectOf(e), 'QA-REPORT-M1-1');
    expect(sectionsOf(body).map(({ slug }) => slug)).toEqual(['qa-report-milestone-1-round-1', 'ac-1', 'ac-2']);
    expect(sectionText(body, 'ac-2')).toContain('Status: failing');
    expect(sectionText(body, 'ac-2')).toContain('exit code 5');
    expect(sectionText(body, 'ac-1')).toContain('exit code 0');
  });

  it('records nothing when it is stopped partway', async () => {
    await start([covers('AC-1', 'sleep 30'), covers('AC-2', 'true')]);
    const ctx = await qaCtx({ results: [pass('AC-1'), pass('AC-2')] });
    const stopper = new AbortController();
    setTimeout(() => stopper.abort(), 300);

    const result = await applyOutput({ ...ctx, signal: stopper.signal });

    expect(evidenceOf(result)).toMatch(/stopped/);
    expect((await criterion('AC-1')).status).toBe('unverified');
    expect(existsSync(worktreePath(e.paths, 'p', `${ctx.task.ticket_id}-verify`, ctx.attempt.k))).toBe(false);
  });

  // The second run: the milestone's merge-base with main, with QA's protected files laid over it.
  describe('against the base', () => {
    const withSetup = async (setup: string): Promise<void> => {
      await e.artifacts.commit(await projectOf(e), { message: 'the profile', publish: [{ id: 'ENV-PROFILE', type: 'environment_profile', status: 'approved', ownerRole: 'tech_lead', derivedFrom: [], body: '# Env\n', fields: { data: { network_allow: [], setup } } }] });
    };

    it('rejects a criterion whose commands pass on the base too', async () => {
      await start([fresh('AC-1', 'true'), covers('AC-2', 'true')]);
      const result = await verify({ results: [pass('AC-1'), pass('AC-2')] });
      expect(evidenceOf(result)).toMatch(/AC-1's Test Plan commands pass on the base too/);
      expect(evidenceOf(result)).toMatch(/Change Request/);
      // QA verify has no way to set the flag, so the way for a criterion that already holds is named: a request for the commands the entry has, which the stakeholder decides.
      expect(evidenceOf(result)).toMatch(/proposes the same commands, which asks the stakeholder to make the entry a regression guard/);
      expect(evidenceOf(result)).not.toMatch(/mark the entry regression/);
      expect((await criterion('AC-1')).status).toBe('unverified');
    });

    it('names every criterion that passes on the base, in one refusal', async () => {
      await start([fresh('AC-1', 'true'), fresh('AC-2', 'true')]);
      const text = evidenceOf(await verify({ results: [pass('AC-1'), pass('AC-2')] }));
      expect(text).toMatch(/AC-1's Test Plan commands pass on the base too/);
      expect(text).toMatch(/AC-2's Test Plan commands pass on the base too/);
    });

    it('takes a criterion whose commands fail on the base', async () => {
      // feature.txt exists only on the verified commit, which sits on a branch past the base.
      await start([fresh('AC-1', 'test -f feature.txt'), covers('AC-2', 'true')]);
      const head = await commitOnBranch(e.repoPath, 'aiteam/m1', { 'feature.txt': 'x' });
      await publish(e, await verify({ results: [pass('AC-1'), pass('AC-2')] }, undefined, head));
      expect(await criterion('AC-1')).toMatchObject({ status: 'passing' });
      expect(await evidence('AC-1')).toMatch(/On the base \([0-9a-f]{7}\), failed as it should/);
    });

    it('runs the base at the merge-base with main, not at main itself', async () => {
      await start([fresh('AC-1', 'test -f feature.txt'), covers('AC-2', 'true')]);
      const base = await revParse(e.repoPath);
      const head = await commitOnBranch(e.repoPath, 'aiteam/m1', { 'feature.txt': 'x' });
      // main moves on after the branch left it, and carries feature.txt too, but that is not where the milestone began.
      await writeFile(join(e.repoPath, 'feature.txt'), 'x');
      commitAll(e.repoPath, 'main gets there on its own');

      await publish(e, await verify({ results: [pass('AC-1'), pass('AC-2')] }, undefined, head));

      expect(await evidence('AC-1')).toContain(`On the base (${base.slice(0, 7)}), failed as it should`);
    });

    it('marks a regression entry that passes on the base as a guard', async () => {
      await start();
      await publish(e, await verify({ results: [pass('AC-1'), pass('AC-2')] }));
      expect(await criterion('AC-1')).toMatchObject({ status: 'passing' });
      expect(await evidence('AC-1')).toMatch(/On the base \([0-9a-f]{7}\), passed too: a regression guard/);
    });

    it('lays the protected files over the base', async () => {
      // The protected test exists only on head; with the overlay, a command that only checks for it passes on base, so it is vacuous.
      await start([fresh('AC-1', 'test -f acceptance/ac-1.sh'), covers('AC-2', 'true')], undefined, 1, { protected: ['acceptance/**'] });
      const head = await commitOnBranch(e.repoPath, 'aiteam/m1', { 'acceptance/ac-1.sh': 'exit 0' });
      expect(evidenceOf(await verify({ results: [pass('AC-1'), pass('AC-2')] }, undefined, head))).toMatch(/pass on the base too/);
    });

    it('lays only the protected files, so the rest of the work is still missing', async () => {
      await start([fresh('AC-1', 'test -f acceptance/ac-1.sh && test -f feature.txt'), covers('AC-2', 'true')], undefined, 1, { protected: ['acceptance/**'] });
      const head = await commitOnBranch(e.repoPath, 'aiteam/m1', { 'acceptance/ac-1.sh': 'exit 0', 'feature.txt': 'x' });
      await publish(e, await verify({ results: [pass('AC-1'), pass('AC-2')] }, undefined, head));
      expect(await evidence('AC-1')).toMatch(/failed as it should/);
    });

    it('judges the Test Plan\'s commands alone, not QA\'s own', async () => {
      await start([fresh('AC-1', 'true'), covers('AC-2', 'true')]);
      const head = await commitOnBranch(e.repoPath, 'aiteam/m1', { 'feature.txt': 'x' });
      expect(evidenceOf(await verify({ results: [pass('AC-1', ['test -f feature.txt']), pass('AC-2')] }, undefined, head))).toMatch(/AC-1's Test Plan commands pass on the base too/);
    });

    it('takes a CR on vacuous commands as a dispute', async () => {
      await start([fresh('AC-1', 'true'), covers('AC-2', 'true')]);
      await publish(e, await verify({ results: [pass('AC-1'), pass('AC-2')], change_requests: [disputes('AC-1')] }));
      expect(await criterion('AC-1')).toMatchObject({ status: 'failing' });
      expect(await ids()).not.toContain('BUG-M1-1');
      expect((await ids()).filter((id) => id.includes('-B-'))).toEqual([]);
      expect(await evidence('AC-1')).toMatch(/On the base \([0-9a-f]{7}\), passed too, so it shows nothing/);
      expect(await evidence('AC-1')).toContain('CR-1');
      expect((await criterion('AC-2')).status).toBe('passing');
    });

    it('still refuses when the request is about another criterion', async () => {
      await start([fresh('AC-1', 'true'), covers('AC-2', 'true')]);
      expect(evidenceOf(await verify({ results: [pass('AC-1'), pass('AC-2')], change_requests: [disputes('AC-2')] }))).toMatch(/AC-1's Test Plan commands pass on the base too/);
    });

    it('counts a base where setup fails as red', async () => {
      // The setup passes on the verified commit, where feature.txt is, and fails on the base, where it is not.
      await start([fresh('AC-1', 'true'), covers('AC-2', 'true')]);
      await withSetup('test -f feature.txt');
      const head = await commitOnBranch(e.repoPath, 'aiteam/m1', { 'feature.txt': 'x' });

      await publish(e, await verify({ results: [pass('AC-1'), pass('AC-2')] }, undefined, head));

      expect(await criterion('AC-1')).toMatchObject({ status: 'passing' });
      expect(await evidence('AC-1')).toMatch(/The base \([0-9a-f]{7}\) could not be set up/);
    });

    it('runs the Environment Profile setup on the base too', async () => {
      // installed.txt is there on the base only if its setup ran, so `true` is not what makes this pass.
      await start([fresh('AC-1', 'test -f installed.txt'), covers('AC-2', 'true')]);
      await withSetup('touch installed.txt');
      expect(evidenceOf(await verify({ results: [pass('AC-1'), pass('AC-2')] }))).toMatch(/AC-1's Test Plan commands pass on the base too/);
    });

    it('counts a command that times out on the base as red', async () => {
      await start([fresh('AC-1', 'test -f feature.txt || sleep 30'), covers('AC-2', 'true')], { steps: [], config: { checkTimeoutS: 1 } });
      const head = await commitOnBranch(e.repoPath, 'aiteam/m1', { 'feature.txt': 'x' });

      await publish(e, await verify({ results: [pass('AC-1'), pass('AC-2')] }, undefined, head));

      expect(await criterion('AC-1')).toMatchObject({ status: 'passing' });
      expect(await evidence('AC-1')).toMatch(/failed as it should/);
    });

    it('compares only the criteria that held on the verified commit', async () => {
      await start([fresh('AC-1', 'exit 1'), covers('AC-2', 'true')]);
      await publish(e, await verify({ results: [pass('AC-1'), pass('AC-2')] }));
      expect(await criterion('AC-1')).toMatchObject({ status: 'failing' });
      expect(await evidence('AC-1')).not.toMatch(/On the base/);
      expect(await evidence('AC-2')).toMatch(/On the base/);
    });

    it('removes the base worktree and its branch', async () => {
      await start();
      const ctx = await qaCtx({ results: [pass('AC-1'), pass('AC-2')] });
      await publish(e, await applyOutput(ctx));
      expect(existsSync(baseWorktree(ctx))).toBe(false);
      expect(baseBranch(ctx)).toBe('');
    });

    it('removes the base worktree and its branch when the output is refused', async () => {
      await start([fresh('AC-1', 'true'), covers('AC-2', 'true')]);
      const ctx = await qaCtx({ results: [pass('AC-1'), pass('AC-2')] });
      expect(evidenceOf(await applyOutput(ctx))).toMatch(/pass on the base too/);
      expect(existsSync(baseWorktree(ctx))).toBe(false);
      expect(baseBranch(ctx)).toBe('');
    });

    it('records nothing when it is stopped during the base run', async () => {
      // On the verified commit the command returns at once, so the stop can only land while the base is running.
      await start([fresh('AC-1', 'test -f feature.txt || sleep 30'), covers('AC-2', 'true')]);
      const head = await commitOnBranch(e.repoPath, 'aiteam/m1', { 'feature.txt': 'x' });
      const ctx = await qaCtx({ results: [pass('AC-1'), pass('AC-2')] }, undefined, head);
      const stopper = new AbortController();
      const watcher = setInterval(() => {
        if (existsSync(baseWorktree(ctx))) stopper.abort();
      }, 20);

      try {
        expect(evidenceOf(await applyOutput({ ...ctx, signal: stopper.signal }))).toMatch(/stopped/);
      } finally {
        clearInterval(watcher);
      }
      expect((await criterion('AC-1')).status).toBe('unverified');
      expect(existsSync(baseWorktree(ctx))).toBe(false);
      expect(baseBranch(ctx)).toBe('');
    });
  });

  // A criterion only a browser can show is played in the page the profile builds, on the verified commit and again on the base.
  describe('a play script', () => {
    const PLAY = { steps: [{ key: 'Space' }], expect: 'window.ok' };
    const PAGE = '<p>the work</p>';
    const MISSED = playResult([{ kind: 'expect', detail: 'window.ok was false' }]);
    const scripted = (ac: string, ...commands: string[]): Coverage => ({ ...fresh(ac, ...commands), play: PLAY });
    // The profile as QA verify reads it: how to build the page and which one to play.
    const withSite = async (overrides: { build?: string; play?: unknown } = {}): Promise<void> => {
      const play = 'play' in overrides ? overrides.play : { root: '.', entry: 'index.html', keys: ['Space'] };
      await e.artifacts.commit(await projectOf(e), {
        message: 'the profile',
        publish: [{ id: 'ENV-PROFILE', type: 'environment_profile', status: 'approved', ownerRole: 'tech_lead', derivedFrom: [], body: '# Env\n', fields: { data: { commands: { build: overrides.build ?? 'true', test: 'echo profile-test', lint: 'true', smoke: 'true' }, toolchains: [], network_allow: [], setup: null, play } } }],
      });
    };
    // index.html exists only on the verified commit, which sits on a branch past the base.
    const onHead = () => commitOnBranch(e.repoPath, 'aiteam/m1', { 'index.html': PAGE });
    const results = [pass('AC-1', []), pass('AC-2')];
    const nothingRecorded = async () => {
      expect((await criterion('AC-1')).status).toBe('unverified');
      expect(await ids()).not.toContain('QA-REPORT-M1-1');
      expect(await ids()).not.toContain('BUG-M1-1');
    };

    it('records a play script as a run of its criterion', async () => {
      await start([scripted('AC-1'), covers('AC-2', 'true')]);
      await withSite();
      const player = fakePlayer([playResult(), MISSED]);
      const script = vi.spyOn(player, 'script');
      e.player = player;
      const head = await onHead();

      await publish(e, await verify({ results }, undefined, head));

      expect(await criterion('AC-1')).toMatchObject({ status: 'passing' });
      expect(await evidence('AC-1')).toContain('play: 1 steps, expect window.ok');
      expect(await evidence('AC-1')).toMatch(/On the base \([0-9a-f]{7}\), failed as it should/);
      expect(player.calls).toHaveLength(2);
      expect(player.calls[0]!.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/index\.html$/);
      expect(player.calls[0]!.body).toBe(PAGE);
      expect(player.calls[1]!.body).not.toBe(PAGE);
      expect(script).toHaveBeenCalledWith(player.calls[0]!.url, PLAY);
    });

    it('fails a criterion whose play script fails', async () => {
      await start([scripted('AC-1'), covers('AC-2', 'true')]);
      await withSite();
      const player = fakePlayer(MISSED);
      e.player = player;

      await publish(e, await verify({ results }, undefined, await onHead()));

      expect(await criterion('AC-1')).toMatchObject({ status: 'failing' });
      expect((await e.artifacts.read(await projectOf(e), 'BUG-M1-1')).body).toContain('window.ok was false');
      // Only a criterion that held on the verified commit is compared with the base.
      expect(player.calls).toHaveLength(1);
    });

    it('rejects a play script that passes on the base too', async () => {
      await start([scripted('AC-1'), covers('AC-2', 'true')]);
      await withSite();
      e.player = fakePlayer(playResult());

      expect(evidenceOf(await verify({ results }, undefined, await onHead()))).toMatch(/pass on the base too/);
      await nothingRecorded();
    });

    it('takes a play script that passes on the base too when the entry is a regression guard', async () => {
      await start([{ ...scripted('AC-1'), regression: true }, covers('AC-2', 'true')]);
      await withSite();
      e.player = fakePlayer(playResult());

      await publish(e, await verify({ results }, undefined, await onHead()));

      expect(await evidence('AC-1')).toMatch(/passed too: a regression guard/);
    });

    it('shows the problems of a run before its log', async () => {
      await start([scripted('AC-1'), covers('AC-2', 'true')]);
      await withSite();
      const noisy = { ...MISSED, log: Array.from({ length: 2000 }, (_, i) => `frame ${i} of the log`) };
      e.player = fakePlayer(noisy);

      await publish(e, await verify({ results }, undefined, await onHead()));

      const shown = await evidence('AC-1');
      expect(shown).toContain('Command, exit code 1:');
      // What fits is cut from the end, so the problem that says what failed is never what is dropped.
      expect(shown).toMatch(/expect: window\.ok was false\n[^\n]*the log\nframe \d+ of the log/);
      expect(shown.length).toBeLessThan(3000);
    });

    describe('the record of a run', () => {
      const result = (problems: PlayProblem[] = [{ kind: 'expect', detail: 'window.ok was false' }], log: string[] = ['loaded', 'pressed Space']) => ({ ok: problems.length === 0, problems, durationMs: 1234, log });

      it('is a CheckRun whose command says what was played', () => {
        expect(playRun({ steps: [{ key: 'Space' }, { wait_ms: 5 }], expect: 'window.ok' }, result([]))).toEqual({ command: 'play: 2 steps, expect window.ok', exitCode: 0, timedOut: false, durationMs: 1234, outputTail: 'loaded\npressed Space' });
      });

      it('lists the problems, one per line, and then the log', () => {
        const run = playRun(PLAY, result([{ kind: 'expect', detail: 'window.ok was false' }, { kind: 'console', detail: 'boom' }]));
        expect(run).toMatchObject({ exitCode: 1, timedOut: false, outputTail: 'expect: window.ok was false\nconsole: boom\nloaded\npressed Space' });
      });

      // A red run with nothing in it would give an Engineer, and the stakeholder, nothing to read.
      it('says so when the play failed and named no problem', () => {
        const run = playRun(PLAY, { ok: false, problems: [], durationMs: 5, log: ['loaded'] });
        expect(run).toMatchObject({ exitCode: 1, timedOut: false, outputTail: 'load: The play run failed and named no problem\nloaded' });
      });

      it('has timed out when a problem says so', () => {
        expect(playRun(PLAY, result([{ kind: 'timeout', detail: 'The script ran past 20 s' }]))).toMatchObject({ exitCode: 1, timedOut: true });
      });

      it('is cut to the length of any other run, keeping the problems and the end of the log', () => {
        const log = Array.from({ length: 3000 }, (_, i) => `frame ${i}`);
        const { outputTail } = playRun(PLAY, result(undefined, log));
        expect(outputTail.length).toBeLessThanOrEqual(8000);
        expect(outputTail.startsWith('expect: window.ok was false\n')).toBe(true);
        expect(outputTail.endsWith('frame 2999')).toBe(true);
      });

      it('keeps the start of a list of problems that alone is too long', () => {
        const { outputTail } = playRun(PLAY, result([{ kind: 'expect', detail: 'x'.repeat(9000) }], ['log line']));
        expect(outputTail).toHaveLength(8000);
        expect(outputTail.startsWith('expect: xxx')).toBe(true);
      });
    });

    it('runs the script after its entry\'s commands, in the page they leave', async () => {
      await start([scripted('AC-1', "echo '<p>made</p>' > index.html"), covers('AC-2', 'true')]);
      await withSite();
      const player = fakePlayer([playResult(), MISSED]);
      e.player = player;

      await publish(e, await verify({ results }));

      expect(player.calls[0]!.body).toBe('<p>made</p>\n');
      expect(await criterion('AC-1')).toMatchObject({ status: 'passing' });
    });

    it('builds and serves once for all the entries of a checkout', async () => {
      // The second build in one checkout finds the first one's line, and fails.
      await start([scripted('AC-1'), scripted('AC-2')]);
      await withSite({ build: 'echo built >> builds.txt && test "$(wc -l < builds.txt)" -eq 1' });
      const player = fakePlayer([playResult(), playResult(), MISSED, MISSED]);
      e.player = player;

      await publish(e, await verify({ results: [pass('AC-1', []), pass('AC-2', [])] }, undefined, await onHead()));

      expect(await criterion('AC-1')).toMatchObject({ status: 'passing' });
      expect(await criterion('AC-2')).toMatchObject({ status: 'passing' });
      expect(player.calls).toHaveLength(4);
      expect(player.calls[0]!.url).toBe(player.calls[1]!.url);
      expect(player.calls[2]!.url).toBe(player.calls[3]!.url);
      expect(player.calls[0]!.url).not.toBe(player.calls[2]!.url);
    });

    it('fails the entries that have a script when the site will not build, and files a Bug the Engineer can prove', async () => {
      await start([scripted('AC-1'), covers('AC-2', 'true')]);
      await withSite({ build: 'echo no-site-today; exit 3' });
      const player = fakePlayer(playResult());
      e.player = player;

      await publish(e, await verify({ results }, undefined, await onHead()));

      expect(await criterion('AC-1')).toMatchObject({ status: 'failing' });
      expect(await criterion('AC-2')).toMatchObject({ status: 'passing' });
      expect(await evidence('AC-1')).toMatch(/load: The build command failed/);
      expect(await evidence('AC-1')).toContain('no-site-today');
      expect(player.calls).toHaveLength(0);
      // The ticket's proof is run as a shell command, and a play run is not one.
      const ticket = (await e.artifacts.read(await projectOf(e), 'M1-B-1')).fields.definition_of_done as string[];
      expect(ticket).toEqual(['echo profile-test']);
    });

    it('keeps the commands that failed as the proof of a Bug, and leaves the play run out of it', async () => {
      await start([scripted('AC-1', 'exit 4'), covers('AC-2', 'true')]);
      await withSite();
      e.player = fakePlayer(MISSED);

      await publish(e, await verify({ results }, undefined, await onHead()));

      expect((await e.artifacts.read(await projectOf(e), 'M1-B-1')).fields.definition_of_done).toEqual(['exit 4']);
    });

    it('counts a site that will not build on the base as red', async () => {
      await start([scripted('AC-1'), covers('AC-2', 'true')]);
      await withSite({ build: 'test -f index.html' });
      const player = fakePlayer(playResult());
      e.player = player;

      await publish(e, await verify({ results }, undefined, await onHead()));

      expect(await criterion('AC-1')).toMatchObject({ status: 'passing' });
      expect(await evidence('AC-1')).toMatch(/On the base \([0-9a-f]{7}\), failed as it should/);
      expect(player.calls).toHaveLength(1);
    });

    it('sends QA back with no Bug when the engine has no browser', async () => {
      await start([scripted('AC-1'), covers('AC-2', 'true')]);
      await withSite();

      expect(evidenceOf(await verify({ results }, undefined, await onHead()))).toMatch(/without a browser/);
      await nothingRecorded();
    });

    it('sends QA back with the reason the browser is unavailable, and with no Bug', async () => {
      await start([scripted('AC-1'), covers('AC-2', 'true')]);
      await withSite();
      const player = fakePlayer(playResult(), { unavailable: 'Chrome is not at /nowhere/chrome' });
      e.player = player;

      expect(evidenceOf(await verify({ results }, undefined, await onHead()))).toContain('Chrome is not at /nowhere/chrome');
      expect(player.calls).toHaveLength(0);
      await nothingRecorded();
    });

    // QA can raise a request with nothing but text, and a blank text is refused, so an entry with no commands cannot ask for "the same commands".
    describe('that passes on the base too', () => {
      const route = (text: string) => ({ ...disputes('AC-1'), proposed_text: text });

      it('names the route that works for an entry with no commands: the expect of its script', async () => {
        await start([scripted('AC-1'), covers('AC-2', 'true')]);
        await withSite();
        e.player = fakePlayer(playResult());

        const text = evidenceOf(await verify({ results }, undefined, await onHead()));

        expect(text).toMatch(/AC-1's Test Plan checks pass on the base too/);
        expect(text).toMatch(/AC-1 has a play script and no commands/);
        expect(text).toMatch(/proposed_text is the script's expect, word for word, which asks the stakeholder to make the entry a regression guard/);
        expect(text).not.toMatch(/proposes the same commands/);
      });

      it('takes a request that proposes that expect as a dispute, and files no Bug', async () => {
        await start([scripted('AC-1'), covers('AC-2', 'true')]);
        await withSite();
        e.player = fakePlayer(playResult());

        await publish(e, await verify({ results, change_requests: [route(PLAY.expect)] }, undefined, await onHead()));

        expect(await criterion('AC-1')).toMatchObject({ status: 'failing' });
        expect(await ids()).not.toContain('BUG-M1-1');
        expect(await evidence('AC-1')).toContain('CR-1');
      });

      it('keeps the commands route for an entry that has commands as well', async () => {
        await start([scripted('AC-1', 'true'), covers('AC-2', 'true')]);
        await withSite();
        e.player = fakePlayer(playResult());

        const text = evidenceOf(await verify({ results: [pass('AC-1'), pass('AC-2')] }, undefined, await onHead()));

        expect(text).toMatch(/AC-1's Test Plan checks pass on the base too/);
        expect(text).toMatch(/proposes the same commands, which asks the stakeholder to make the entry a regression guard/);
        expect(text).not.toMatch(/no commands/);
      });
    });

    it('names a single criterion in the singular when the profile has no play block', async () => {
      await start([scripted('AC-1'), covers('AC-2', 'true')]);
      await withSite({ play: null });
      e.player = fakePlayer(playResult());

      expect(evidenceOf(await verify({ results }, undefined, await onHead()))).toMatch(/^AC-1 has a play script in the Test Plan/);
    });

    it('names several criteria in the plural when the profile has no play block', async () => {
      await start([scripted('AC-1'), scripted('AC-2')]);
      await withSite({ play: null });
      e.player = fakePlayer(playResult());

      expect(evidenceOf(await verify({ results: [pass('AC-1', []), pass('AC-2', [])] }, undefined, await onHead()))).toMatch(/^AC-1 and AC-2 have play scripts in the Test Plan/);
    });

    it('removes the verified commit\'s checkout and its branch when a browser problem on it sends QA back', async () => {
      await start([scripted('AC-1'), covers('AC-2', 'true')]);
      await withSite();
      e.player = fakePlayer(playResult([{ kind: 'browser', detail: 'Chrome closed' }]));
      const ctx = await qaCtx({ results }, undefined, await onHead());

      expect(evidenceOf(await applyOutput(ctx))).toContain('Chrome closed');

      expect(existsSync(headWorktree(ctx))).toBe(false);
      expect(headBranch(ctx)).toBe('');
    });

    it('does not ask for a browser when no entry has a script', async () => {
      await start([covers('AC-1', 'true'), covers('AC-2', 'true')]);
      e.player = fakePlayer(playResult(), { unavailable: 'Chrome is not at /nowhere/chrome' });

      await publish(e, await verify({ results: [pass('AC-1'), pass('AC-2')] }));

      expect(await criterion('AC-1')).toMatchObject({ status: 'passing' });
    });

    it('sends QA back, never filing a Bug, when the browser itself fails on the verified commit', async () => {
      await start([scripted('AC-1'), covers('AC-2', 'true')]);
      await withSite();
      e.player = fakePlayer(playResult([{ kind: 'browser', detail: 'Chrome closed before the script ran' }]));

      expect(evidenceOf(await verify({ results }, undefined, await onHead()))).toContain('Chrome closed before the script ran');
      await nothingRecorded();
    });

    it('sends QA back, never recording red, when the browser itself fails on the base', async () => {
      await start([scripted('AC-1'), covers('AC-2', 'true')]);
      await withSite();
      e.player = fakePlayer([playResult(), playResult([{ kind: 'browser', detail: 'Chrome closed before the script ran' }])]);

      expect(evidenceOf(await verify({ results }, undefined, await onHead()))).toContain('Chrome closed before the script ran');
      await nothingRecorded();
    });

    it('sends QA back when the profile no longer has a play block', async () => {
      await start([scripted('AC-1'), covers('AC-2', 'true')]);
      await withSite({ play: null });
      e.player = fakePlayer(playResult());

      expect(evidenceOf(await verify({ results }, undefined, await onHead()))).toMatch(/no play block/);
      await nothingRecorded();
    });

    it('removes the checkouts when a browser problem sends QA back', async () => {
      await start([scripted('AC-1'), covers('AC-2', 'true')]);
      await withSite();
      e.player = fakePlayer([playResult(), playResult([{ kind: 'browser', detail: 'Chrome closed' }])]);
      const ctx = await qaCtx({ results }, undefined, await onHead());

      await applyOutput(ctx);

      expect(existsSync(baseWorktree(ctx))).toBe(false);
      expect(baseBranch(ctx)).toBe('');
    });
  });
});

describe('a Bug ticket', () => {
  const draft = { title: 'The game does not run', touches: ['**'], definition_of_done: ['true'], techPin: 'TECH-M1@1', specPin: 'SPEC-M1@1' };

  it('names every criterion it must make pass', () => {
    expect(bugTicket(1, 2, { ...draft, acs: ['AC-1', 'AC-2'] }).body).toBe('Fix what BUG-M1-2 describes, so that AC-1, AC-2 pass.\n');
  });

  // The play gate's Bug names only automated criteria, and a milestone can have none.
  it('reads plainly when there is no criterion to name', () => {
    expect(bugTicket(1, 2, { ...draft, acs: [] }).body).toBe('Fix what BUG-M1-2 describes.\n');
  });

  // The engine files it, but it is a product ticket like the others, so the Eng Lead's scope revision decides it.
  it('belongs to the Eng Lead', () => {
    expect(bugTicket(1, 2, { ...draft, acs: ['AC-1'] })).toMatchObject({ ownerRole: 'eng_lead', approvedBy: 'engine' });
  });

  // The hooks hold a Bug's change to every component, so its ticket says which tests go with which sources.
  it('lists the tests every component is held to', () => {
    expect(bugTicket(1, 2, { ...draft, acs: ['AC-1'], components: COMPONENTS }).body).toBe(`Fix what BUG-M1-2 describes, so that AC-1 passes.\n\n${HELD_TO}`);
  });
});

describe("the play gate's Bug ticket", () => {
  let e: TestEngine;
  const profile: ProfileData = { commands: { build: 'true', test: 'npm test', lint: 'true', smoke: 'true' }, toolchains: [], network_allow: [], setup: null, play: null };

  afterEach(async () => {
    await e.cleanup();
  });

  async function gameFailed(fields?: Record<string, unknown>) {
    e = await makeEngine({ steps: [] });
    await lockSpec(e);
    const project = await projectOf(e);
    await e.artifacts.commit(project, {
      message: 'the design and the profile',
      publish: [
        { id: 'TECH-M1', type: 'tech_design', status: 'approved', ownerRole: 'tech_lead', approvedBy: 'owner:tech_lead', derivedFrom: ['SPEC-M1@1'], milestone: 1, body: '# Design\n', ...(fields ? { fields } : {}) },
        { id: 'ENV-PROFILE', type: 'environment_profile', status: 'approved', ownerRole: 'tech_lead', derivedFrom: [], body: '# Env\n', fields: { data: profile } },
      ],
    });
    return (await playBug(e, project, 1, 1, { kind: 'failed', headSha: 'a'.repeat(40), problems: [{ kind: 'exception', detail: 'boom' }], profile })).ticket;
  }

  it('lists the tests every component of the Tech Design is held to', async () => {
    expect((await gameFailed({ data: STRUCTURE })).body).toBe(`Fix what BUG-M1-1 describes, so that AC-1, AC-2 pass.\n\n${HELD_TO}`);
  });

  it('lists none when the Tech Design has no components', async () => {
    expect((await gameFailed()).body).toBe('Fix what BUG-M1-1 describes, so that AC-1, AC-2 pass.\n');
  });
});
