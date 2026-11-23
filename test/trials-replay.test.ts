import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { AttemptRow, TaskRow } from '../src/engine/store.ts';
import type { TaskManifest } from '../src/manifest/build.ts';
import { replay, type ReplayOutcome, type ReplayPlace } from '../src/trials/replay.ts';
import { replaySource, type ReplaySource } from '../src/trials/source.ts';
import type { Knowledge } from '../src/trials/types.ts';
import { apply, CRITERIA, projectOf, publish } from './helpers/apply.ts';
import { makeEngine, okStep, resultStep, runOnce, ticket, type TestEngine } from './helpers/engine.ts';
import { run, tempDir } from './helpers/repo.ts';
import { entryText, knowledgeWith, projectState, read } from './helpers/trials.ts';

const DISCOVERY = { roadmap: { body: '# Roadmap\n', milestones: [] }, team_proposal: { body: 'Team' }, human_requirements: { body: 'Needs' }, fun_definition: null, stakeholder_note: 'Note' };

describe('one past task, run again with other knowledge', () => {
  let e: TestEngine;
  let dir: string;

  afterEach(() => e.cleanup());

  // The original run is T-1's or the order's; each run of a trial has a folder named for it, which the script names.
  async function engineWith(byTask: Record<string, unknown>, env: Record<string, string> = {}): Promise<void> {
    e = await makeEngine({ steps: { byTask: { 'T-1': okStep({ 'src/a.mjs': 'export {}' }), ...byTask } }, env });
    dir = join(e.paths.trials, '1');
  }

  async function ranTicket(overrides: Record<string, unknown> = {}): Promise<ReplaySource> {
    const task = await e.addTicket(ticket(overrides));
    await runOnce(e, task.id);
    return sourceOf((await e.store.listAttempts(task.id))[0]!);
  }

  async function sourceOf(attempt: AttemptRow): Promise<ReplaySource> {
    const found = await replaySource(e, attempt.id);
    if (!found.ok) throw new Error(found.why);
    return found.source;
  }

  const place = (name: string): ReplayPlace => ({ dir, name, branch: `aiteam/trial/1/${name}` });
  const again = async (source: ReplaySource, name: string, over: Partial<Knowledge> = {}): Promise<ReplayOutcome> => replay(e, source, await knowledgeWith(e, over, source.task.role_id), place(name));
  const done = (outcome: ReplayOutcome) => {
    if (outcome.kind !== 'done') throw new Error(`The run stopped: ${outcome.why}`);
    return outcome;
  };

  it('gives the worker the knowledge to try, then the attempt’s own contract and task', async () => {
    await engineWith({ 'draft-1': okStep({ 'src/a.mjs': 'export const better = true;' }) });
    const source = await ranTicket();

    const outcome = done(await again(source, 'draft-1', { playbook: entryText('PB-1', 'Run every check before you report.'), memory_role: entryText('MEM-1', 'Tests live in test/.', 'structure') }));

    const system = read(dir, 'draft-1', 'system.md');
    expect(system).toBe(`${source.sections.charter}\n\n## Playbook\n\nHow to do this role’s work well, from earlier work. Follow it unless the task says otherwise.\n\n### PB-1\n\nRun every check before you report.\n\n${system.slice(system.indexOf('## Project memory'), system.indexOf('## Output contract'))}${source.sections.contract}\n`);
    expect(system).toContain('### MEM-1 (structure, your own note)\n\nTests live in test/.');
    expect(read(dir, 'draft-1', 'task.md')).toBe(source.manifest.task);
    expect(outcome.fingerprint).toMatch(/^[0-9a-f]{64}$/);
    expect(outcome.fingerprint).not.toBe(source.fingerprint);
    expect(outcome).toMatchObject({ output: { summary: 'Did the work' }, usd: 0.01, measured: { parses: true, changed: true, tests: true, checks: true, usd: 0.01, note: null } });
  });

  it('gives the same fingerprint as the attempt when the knowledge is what the attempt had', async () => {
    await engineWith({ 'current-1': okStep({ 'src/a.mjs': 'export {}' }) });
    const source = await ranTicket();

    expect(done(await again(source, 'current-1')).fingerprint).toBe(source.fingerprint);
  });

  it('runs in a worktree of its own at the commit the attempt started from, and leaves neither it nor its branch', async () => {
    await engineWith({ 'draft-1': okStep({ 'src/b.mjs': 'export {}' }) });
    const source = await ranTicket();
    writeFileSync(join(e.repoPath, 'later.txt'), 'committed after the attempt began\n');
    run(e.repoPath, 'add', '-A');
    run(e.repoPath, 'commit', '-q', '-m', 'later');

    done(await again(source, 'draft-1'));

    const spawn = e.spawns().at(-1)!;
    expect(spawn.cwd).toContain(join('trials', '1', 'worktrees', 'draft-1'));
    expect(existsSync(spawn.cwd)).toBe(false);
    expect(run(e.repoPath, 'branch', '--list', 'aiteam/trial/*')).toBe('');
    const diff = read(dir, 'draft-1.diff');
    expect(diff).toContain('+++ b/src/b.mjs');
    expect(diff).not.toContain('later.txt');
    expect(existsSync(join(dir, 'draft-1.jsonl'))).toBe(true);
  });

  it('changes nothing a project’s own flow reads', async () => {
    await engineWith({ 'draft-1': okStep({ 'src/a.mjs': 'export const better = true;' }), 'draft-2': okStep({}) });
    const source = await ranTicket();
    const before = await projectState(e);

    done(await again(source, 'draft-1', { playbook: entryText('PB-1', 'A rule.') }));
    done(await again(source, 'draft-2'));

    expect(await projectState(e)).toEqual(before);
  });

  it('counts a run that changed nothing, and one whose commands fail', async () => {
    await engineWith({ 'draft-1': okStep({}), 'draft-2': okStep({ 'src/other.mjs': '' }) });
    const source = await ranTicket({ definition_of_done: ['test -f src/a.mjs'] });

    expect(done(await again(source, 'draft-1')).measured).toMatchObject({ parses: true, changed: false, checks: null, tests: null });
    expect(done(await again(source, 'draft-2')).measured).toMatchObject({ parses: true, changed: true, checks: false, note: expect.stringContaining('test -f src/a.mjs') });
  });

  it('puts the attempt’s reference files where its task says they are', async () => {
    // The worker here finishes only once the file is in its folder.
    await engineWith({ 'draft-1': okStep({ 'src/a.mjs': '' }, {}, { waitForFile: '.aiteam-reference/verification.md' }) });
    const project = await projectOf(e);
    await e.store.createMilestone({ project_id: project.id, n: 1, title: 'First', goal: 'Goal', phase: 'pending' });
    const [spec] = await publish(e, await apply(e, 'milestone_spec', { body: '# Goal\n\nBoth things work.\n', criteria: CRITERIA }));
    await e.store.lockCriteria(project.id, 1, spec!.version, CRITERIA);
    const source = await ranTicket({ inputs: ['SPEC-M1@1'] });

    expect(done(await again(source, 'draft-1')).measured).toMatchObject({ parses: true, checks: true });
  });

  it('runs on the model and the budgets the role has today', async () => {
    await engineWith({ 'draft-1': okStep({ 'src/a.mjs': '' }) });
    const source = await ranTicket();
    const yaml = join(e.paths.knowledge, 'roles', 'engineer', 'role.yaml');
    writeFileSync(yaml, readFileSync(yaml, 'utf8').replace('model: claude-sonnet-5-5', 'model: a-newer-model').replace('max_turns: 60', 'max_turns: 7'));

    done(await again(source, 'draft-1'));

    const { argv } = e.spawns().at(-1)!;
    expect(argv[argv.indexOf('--model') + 1]).toBe('a-newer-model');
    expect(argv[argv.indexOf('--max-turns') + 1]).toBe('7');
    expect(argv[argv.indexOf('--json-schema') + 1]).toBe(JSON.stringify(source.manifest.outputSchema));
  });

  it('counts an answer that doesn’t fit the schema, and a prompt over the role’s budget, without stopping', async () => {
    await engineWith({ 'draft-1': resultStep({ nonsense: true }) });
    const source = await ranTicket();

    expect(done(await again(source, 'draft-1')).measured).toMatchObject({ parses: false, checks: null, changed: null, tests: null, usd: 0.01 });

    const spawned = e.spawnCount();
    const over = done(await again(source, 'draft-2', { playbook: entryText('PB-1', 'x'.repeat(60_000)) }));
    expect(over.measured).toMatchObject({ parses: false, note: expect.stringMatching(/^context_over_budget: \d+ tokens against a budget of 12000$/) });
    expect(e.spawnCount()).toBe(spawned);
  });

  it('stops, to be made again, when the agent home is not logged in', async () => {
    const auth = join(tempDir(), 'auth.json');
    writeFileSync(auth, '{"loggedIn":true}');
    await engineWith({}, { FAKE_AUTH_FILE: auth });
    const source = await ranTicket();
    writeFileSync(auth, '{"loggedIn":false}');
    const spawned = e.spawnCount();

    expect(await again(source, 'draft-1')).toMatchObject({ kind: 'stopped', usd: 0, why: expect.stringContaining('claude auth login') });
    expect(e.spawnCount()).toBe(spawned);
    expect(run(e.repoPath, 'branch', '--list', 'aiteam/trial/*')).toBe('');
  });

  it('refuses knowledge with a file that has a problem', async () => {
    await engineWith({});
    const source = await ranTicket();

    await expect(again(source, 'draft-1', { playbook: '## PB-1\nAdded by: someone\n\nNo date.\n' })).rejects.toThrow('The knowledge to try has a file with a problem: PB-1 has no "Added" line');
  });

  it('runs a task that writes a document, which has nothing to count but whether its answer fits', async () => {
    await engineWith({ DISCOVERY: resultStep({ nonsense: true }), 'draft-1': resultStep(DISCOVERY) });
    const project = await projectOf(e);
    const task: TaskRow = await e.store.createTask({
      project_id: project.id,
      ticket_id: 'DISCOVERY',
      title: 'Discovery',
      milestone: 1,
      role_id: 'pm',
      ticket_path: '',
      ticket_sha: '',
      touches: [],
      depends_on: [],
      dod: [],
      kind: 'authoring',
      purpose: 'discovery',
      work_order: { purpose: 'discovery', instructions: 'Write the roadmap.', inputs: [], checks: [], base: { kind: 'base' } },
    });
    await runOnce(e, task.id);
    const [attempt] = await e.store.listAttempts(task.id);
    expect(attempt).toMatchObject({ state: 'invalid_output' });
    const before = await projectState(e);

    const outcome = done(await again(await sourceOf(attempt!), 'draft-1'));

    expect(outcome).toMatchObject({ output: DISCOVERY, measured: { parses: true, checks: null, changed: null, tests: null } });
    expect(read(dir, 'draft-1', 'task.md')).toBe((attempt!.manifest as TaskManifest).task);
    expect(existsSync(join(dir, 'draft-1.diff'))).toBe(false);
    expect(await projectState(e)).toEqual(before);
  });
});
