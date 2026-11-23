import { writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import { claudeJudge, type ClaudeJudgeOptions } from '../src/judge/claude.ts';
import { JudgeStopped, type JudgeRequest } from '../src/judge/judge.ts';
import { localJudge } from '../src/judge/local.ts';
import { makeEngine, resultStep, type TestEngine } from './helpers/engine.ts';
import { tempDir } from './helpers/repo.ts';
import { read } from './helpers/trials.ts';

const REQUEST: JudgeRequest = {
  state: '## The work\n\nRan `node --test`, exit 0.',
  questions: [
    { id: 'A-1', ask: 'Does the report list every command it ran?' },
    { id: 'A-2', ask: 'Does it say what each command returned?' },
  ],
};

const says = (first: boolean, second: boolean, passage = 'Ran `node --test`') =>
  resultStep({
    answers: [
      { question: 'A-1', yes: first, passage },
      { question: 'A-2', yes: second, passage: 'exit 0' },
    ],
  });

describe('the Claude judge', () => {
  let e: TestEngine;
  let dir: string;

  afterEach(() => e.cleanup());

  async function judging(byTask: Record<string, unknown>, env: Record<string, string> = {}): Promise<void> {
    e = await makeEngine({ steps: { byTask }, env });
    dir = join(e.paths.trials, '1');
  }

  const options = (over: Partial<ClaudeJudgeOptions> = {}): ClaudeJudgeOptions => ({ adapter: 'claude-code', model: 'the-judge-model', runs: 3, dir, name: 'model-7', ...over });

  it('asks the questions as many times as it is told, and gives the share of runs that said yes', async () => {
    await judging({ 'model-7-1': says(true, true), 'model-7-2': says(true, false), 'model-7-3': says(false, false, 'No command is named') });

    const judged = await claudeJudge(e, REQUEST, options());

    expect(judged.answers['A-1']!.p).toBeCloseTo(2 / 3);
    expect(judged.answers['A-1']!.passage).toBe('Ran `node --test`');
    expect(judged.answers['A-2']).toEqual({ p: 1 / 3, passage: 'exit 0' });
    expect(judged.usd).toBeCloseTo(0.03);
    expect(e.spawnCount()).toBe(3);
    expect(e.spawns().map(({ argv }) => argv[argv.indexOf('--model') + 1])).toEqual(Array(3).fill('the-judge-model'));
  });

  it('gives the passage of a run that said no when most runs did', async () => {
    await judging({ 'model-7-1': says(false, true, 'No command is named'), 'model-7-2': says(false, true, 'Nothing is listed'), 'model-7-3': says(true, true) });

    expect((await claudeJudge(e, REQUEST, options())).answers['A-1']).toEqual({ p: 1 / 3, passage: 'No command is named' });
  });

  it('gives each run the judge’s instructions, then the work and the questions under their ids', async () => {
    await judging({ 'model-*': says(true, true) });

    await claudeJudge(e, REQUEST, options({ runs: 1 }));

    const system = read(dir, 'model-7-1', 'system.md');
    expect(system).toMatch(/^# Judge\n/);
    expect(system).toContain('Answer every question once, under the id it was given.');
    expect(system).toContain('## Output contract\n\nFinish with a Judgment');
    expect(read(dir, 'model-7-1', 'task.md')).toBe('## The work\n\nRan `node --test`, exit 0.\n\n## Questions\n\n- `A-1`: Does the report list every command it ran?\n- `A-2`: Does it say what each command returned?\n');
    expect(e.spawns()[0]!.cwd).toContain(join('trials', '1', 'judging', 'model-7-1'));
  });

  it('puts a role’s own charter before the instructions when the role judges as itself', async () => {
    await judging({ 'evaluator-*': says(true, true) });

    const judged = await claudeJudge(e, REQUEST, options({ name: 'evaluator-7', runs: 1, preface: '# Code Reviewer\n\nYou review one change.\n' }));

    expect(read(dir, 'evaluator-7-1', 'system.md')).toMatch(/^# Code Reviewer\n\nYou review one change\.\n\n# Judge\n/);
    expect(judged.answers['A-1']).toEqual({ p: 1, passage: 'Ran `node --test`' });
  });

  it('makes a run again once when it leaves a question out, answers one twice, or doesn’t fit the schema', async () => {
    const left = resultStep({ answers: [{ question: 'A-1', yes: true, passage: 'x' }] });
    await judging({ 'model-7-1': left, 'model-7-2': says(true, true), 'model-7-3': says(true, true), 'model-7-4': says(false, true) });

    const judged = await claudeJudge(e, REQUEST, options());

    expect(judged.answers['A-1']!.p).toBeCloseTo(2 / 3);
    expect(e.spawnCount()).toBe(4);
    expect(judged.usd).toBeCloseTo(0.04);
  });

  it('gives up after a second such run, and says what it cost', async () => {
    const twice = resultStep({ answers: [{ question: 'A-1', yes: true, passage: 'x' }, { question: 'A-1', yes: false, passage: 'y' }, { question: 'A-2', yes: true, passage: 'z' }] });
    await judging({ 'model-7-1': says(true, true), 'model-7-2': twice, 'model-7-3': resultStep({ nonsense: true }) });

    const failed = await claudeJudge(e, REQUEST, options()).catch((err: unknown) => err);

    expect(failed).toBeInstanceOf(JudgeStopped);
    expect(failed).toMatchObject({ message: 'the judge twice gave an answer that left a question out or did not fit', usd: expect.closeTo(0.03) });
  });

  it('doesn’t start when the agent home is not logged in', async () => {
    const auth = join(tempDir(), 'auth.json');
    writeFileSync(auth, '{"loggedIn":false}');
    await judging({ 'model-*': says(true, true) }, { FAKE_AUTH_FILE: auth });

    await expect(claudeJudge(e, REQUEST, options())).rejects.toMatchObject({ usd: 0, message: expect.stringContaining('claude auth login') });
    expect(e.spawnCount()).toBe(0);
  });
});

describe('the local judge', () => {
  let server: Server;
  let url: string;
  let asked: { model: string; max_tokens: number; logprobs: boolean; messages: { role: string; content: string }[] }[];
  let reply: (n: number) => { status?: number; body: unknown };

  beforeEach(async () => {
    asked = [];
    server = createServer((req, res) => {
      let text = '';
      req.on('data', (chunk) => (text += chunk));
      req.on('end', () => {
        asked.push(JSON.parse(text));
        const { status = 200, body } = reply(asked.length);
        res.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(body));
      });
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1/`;
  });

  afterEach(() => new Promise((resolve) => server.close(resolve)));

  const weights = (...tokens: [string, number][]) => ({ choices: [{ message: { content: tokens[0]![0] }, logprobs: { content: [{ top_logprobs: tokens.map(([token, p]) => ({ token, logprob: Math.log(p) })) }] } }] });

  it('reads how likely yes is from the weight the model put on the word, asking one question at a time', async () => {
    reply = (n) => ({ body: n === 1 ? weights(['Yes', 0.6], [' yes', 0.2], ['No', 0.15], ['Maybe', 0.05]) : weights(['no', 0.9], ['yes', 0.1]) });

    const judged = await localJudge({ url, model: 'qwen3' }, REQUEST);

    expect(judged.answers['A-1']!.p).toBeCloseTo(0.8 / 0.95);
    expect(judged.answers['A-2']!.p).toBeCloseTo(0.1);
    expect(judged).toMatchObject({ usd: 0, answers: { 'A-1': { passage: null } } });
    expect(asked).toHaveLength(2);
    expect(asked[0]).toMatchObject({ model: 'qwen3', max_tokens: 1, logprobs: true });
    expect(asked[0]!.messages.at(-1)!.content).toBe('## The work\n\nRan `node --test`, exit 0.\n\n## Question\n\nDoes the report list every command it ran?\n\nAnswer yes or no.');
    expect(asked[1]!.messages.at(-1)!.content).toContain('Does it say what each command returned?');
  });

  it('takes the word itself from a model that reports no weights', async () => {
    reply = (n) => ({ body: { choices: [{ message: { content: n === 1 ? ' Yes.' : 'no' } }] } });

    expect((await localJudge({ url, model: 'm' }, REQUEST)).answers).toEqual({ 'A-1': { p: 1, passage: null }, 'A-2': { p: 0, passage: null } });
  });

  it('fails on an answer that is neither, and on a server that refuses', async () => {
    reply = () => ({ body: { choices: [{ message: { content: '<think>' } }] } });
    await expect(localJudge({ url, model: 'm' }, REQUEST)).rejects.toThrow('the local model answered neither yes nor no: "<think>"');

    reply = () => ({ status: 404, body: { error: 'model "m" not found' } });
    await expect(localJudge({ url, model: 'm' }, REQUEST)).rejects.toThrow(/answered 404: .*not found/);
  });
});
