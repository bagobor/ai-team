import { existsSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import { renderArtifact, sectionsOf, sectionText } from '../src/artifacts/format.ts';
import { applyOutput } from '../src/engine/apply/index.ts';
import { worktreePath } from '../src/paths.ts';
import { parseTicket } from '../src/tickets/ticket.ts';
import { addAttemptWorktree } from '../src/git/workspace.ts';
import { commitAll, revParse, run, tempDir } from './helpers/repo.ts';
import { ctxFor, evidenceOf, lockSpec, projectOf, publish } from './helpers/apply.ts';
import { makeEngine, type TestEngine } from './helpers/engine.ts';

type Result = { ac: string; status: 'passing' | 'failing'; commands: string[]; notes: string };
type Bug = { ac: string; title: string; description: string; touches: string[]; commands: string[] };
type Coverage = { ac: string; commands: string[]; notes: string };

const pass = (ac: string, commands: string[] = ['true'], notes = 'Looks good'): Result => ({ ac, status: 'passing', commands, notes });
const fail = (ac: string, commands: string[] = [], notes = 'It broke'): Result => ({ ac, status: 'failing', commands, notes });
const bug = (ac: string, overrides: Partial<Bug> = {}): Bug => ({ ac, title: `${ac} is broken`, description: 'It does the wrong thing', touches: ['src/**'], commands: [], ...overrides });
const covers = (ac: string, ...commands: string[]): Coverage => ({ ac, commands, notes: '' });

describe('qa_verify applier', () => {
  let e: TestEngine;

  async function setUp(engine: TestEngine, coverage: Coverage[], round = 1): Promise<void> {
    e = engine;
    await lockSpec(e);
    const project = await projectOf(e);
    await e.store.createMilestone({ project_id: project.id, n: 1, title: 'First', goal: 'Goal', phase: 'pending' });
    await e.store.patchMilestone(project.id, 1, { verify_round: round });
    await e.artifacts.commit(project, {
      message: 'the design and the plan',
      publish: [
        { id: 'TECH-M1', type: 'tech_design', status: 'approved', ownerRole: 'tech_lead', approvedBy: 'owner:tech_lead', derivedFrom: ['SPEC-M1@1'], milestone: 1, body: '# Design\n' },
        { id: 'TEST-PLAN-M1', type: 'test_plan', status: 'approved', ownerRole: 'tech_lead', approvedBy: 'owner:tech_lead', derivedFrom: ['SPEC-M1@1'], milestone: 1, body: '# Plan\n', fields: { data: { coverage } } },
      ],
    });
  }

  const start = async (coverage: Coverage[] = [covers('AC-1', 'true'), covers('AC-2', 'true')], options: Parameters<typeof makeEngine>[0] = { steps: [] }, round = 1): Promise<void> => setUp(await makeEngine(options), coverage, round);

  afterEach(async () => {
    await e.cleanup();
  });

  const qaCtx = async (output: { results: Result[]; bugs?: Bug[]; summary?: string }, worktree?: string) =>
    ctxFor(e, 'qa_verify', { bugs: [], summary: 'Done', ...output }, { kind: 'qa_verify', role: 'qa_engineer', inputs: ['SPEC-M1@1', 'TEST-PLAN-M1@1'], baseSha: await revParse(e.repoPath), ...(worktree ? { worktree } : {}) });
  const verify = async (output: Parameters<typeof qaCtx>[0], worktree?: string) => applyOutput(await qaCtx(output, worktree));
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
    for (const pin of parsed.inputs) await expect(e.artifacts.readInput(project, pin)).resolves.toMatchObject({ pin });
    expect((await e.artifacts.latest(project.id, 'M1-B-1'))?.derived_from).toContain('SPEC-M1@1#ac-1');
    expect(await e.store.getTaskByTicket(project.id, 'M1-B-1')).toBeUndefined();
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
});
