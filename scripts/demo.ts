// Runs the daemon on a throwaway home and repo with a fake worker, so the UI can be checked without spending anything.
import { existsSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { stringify } from 'yaml';
import { loadConfig } from '../src/config.ts';
import { startDaemon } from '../src/daemon.ts';
import { resolvePaths } from '../src/paths.ts';
import { runSetup } from '../src/setup/setup.ts';
import { M2_BRIEF, m2Script } from '../test/fixtures/m2-script.ts';

const PORT = 4780;
const FAKE_CLAUDE = fileURLToPath(new URL('../test/fixtures/fake-claude.mjs', import.meta.url));
const WEB_INDEX = fileURLToPath(new URL('../web/dist/index.html', import.meta.url));
const SLOW_LINE_MS = 1500;
const SLOW_REVIEW_MS = 120_000;
const INBOX_POLL_MS = 500;

const REPORT = { summary: 'The demo worker finished.', files_changed: [], commands_run: [] };

const json = (value: unknown) => JSON.stringify(value);
const assistant = (...content: unknown[]) => json({ type: 'assistant', message: { content } });
const say = (text: string) => assistant({ type: 'text', text });
const INIT = json({ type: 'system', subtype: 'init', session_id: 'demo', model: 'fake-model' });
const result = (usd: number, output: unknown = REPORT) =>
  json({
    type: 'result',
    subtype: 'success',
    is_error: false,
    session_id: 'demo',
    result: 'done',
    total_cost_usd: usd,
    usage: { input_tokens: 12_400, output_tokens: 1800, cache_read_input_tokens: 6200 },
    structured_output: output,
  });
const review = { lines: [INIT, say('Read the diff.'), result(0.08, { verdict: 'approve', summary: 'Does what the ticket says.', findings: [] })] };

function slowLines(): string[] {
  const lines = [INIT, say('Starting from the ticket and the files it names.')];
  for (let i = 1; i <= 80; i += 1) {
    const id = `tool-${i}`;
    lines.push(
      assistant({ type: 'tool_use', id, name: 'Read', input: { file_path: `src/file-${i}.ts` } }),
      json({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: id, content: `Read ${i * 10} lines` }] } }),
      say(`Step ${i} of 80 looks fine.`),
    );
  }
  return [...lines, result(0.12)];
}

const home = mkdtempSync(join(realpathSync(tmpdir()), 'aiteam-demo-'));
const paths = resolvePaths({ AITEAM_HOME: join(home, 'home') });
await runSetup(paths);

// Each attempt takes its own step. The second review takes a while, so that a ticket can be seen sitting in review.
const script = join(home, 'script.json');
writeFileSync(
  script,
  json({
    byTask: {
      ...m2Script().byTask,
      'T-DEMO-1': { writeFiles: { 'src/slow.txt': 'slow' }, lines: slowLines(), lineDelayMs: SLOW_LINE_MS },
      'T-DEMO-1-R1': review,
      'T-DEMO-2': { writeFiles: { 'src/quick.txt': 'quick' }, lines: [INIT, say('A small change.'), result(0.03)] },
      'T-DEMO-2-R1': { ...review, delayMs: SLOW_REVIEW_MS },
      'T-DEMO-3-a1': { writeFiles: { 'src/wrong.txt': 'first try' }, lines: [INIT, say('First try.'), result(0.04)] },
      'T-DEMO-3-a2': { writeFiles: { 'src/wrong.txt': 'second try' }, lines: [INIT, say('Second try.'), result(0.05)] },
      'T-DEMO-3-a3': { writeFiles: { 'src/fixed.txt': 'fixed' }, lines: [INIT, say('Fixed after a retry.'), result(0.06)] },
      'T-DEMO-3-R3': review,
    },
  }),
);
writeFileSync(
  paths.config,
  stringify({
    port: PORT,
    max_workers: 3,
    max_attempts: 2,
    cancel_grace_s: 2,
    claude: { binary: FAKE_CLAUDE, extra_env: { FAKE_SCRIPT: script, FAKE_SPAWN_LOG: join(home, 'spawns.log') } },
  }),
);

const running = await startDaemon({ paths, config: loadConfig(paths) });

const stopThenExit = () => {
  void running.stop().finally(() => {
    rmSync(home, { recursive: true, force: true });
    process.exit(0);
  });
};
process.once('SIGINT', stopThenExit);
process.once('SIGTERM', stopThenExit);

async function post(path: string, body: unknown): Promise<void> {
  const res = await fetch(`http://127.0.0.1:${PORT}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: json(body),
  });
  if (!res.ok) throw new Error(`${path}: ${await res.text()}`);
}

function ticket(id: string, title: string, definitionOfDone: string, body: string): string {
  const front = {
    id,
    title,
    milestone: 1,
    ac_refs: [],
    specialty: 'engineer',
    touches: ['src/**'],
    depends_on: [],
    definition_of_done: [definitionOfDone],
    inputs: [],
    size: 'S',
  };
  return `---\n${stringify(front)}---\n${body}\n`;
}

await post('/api/projects', { name: 'demo', repoPath: join(home, 'repo'), create: true });
for (const markdown of [
  ticket('T-DEMO-1', 'A slow ticket to watch and cancel', 'true', 'Takes a few minutes, one line at a time.'),
  ticket('T-DEMO-2', 'A quick ticket that reaches review', 'true', 'Passes its check first time.'),
  ticket('T-DEMO-3', 'A ticket that escalates until retried', 'test -f src/fixed.txt', 'Fails its check twice, then passes after Retry.'),
]) {
  await post('/api/projects/demo/tickets', { markdown });
}

// A second project takes the whole road from a brief. It stops at CP4, so every screen has something on it and the last approval is left to try.
await post('/api/projects', { name: 'tempconv', repoPath: join(home, 'tempconv'), create: true });
await post('/api/projects/tempconv/brief', { markdown: M2_BRIEF });

async function approveUpToCp4(): Promise<void> {
  for (;;) {
    const res = await fetch(`http://127.0.0.1:${PORT}/api/inbox?project=tempconv`);
    const { items } = (await res.json()) as { items: { id: number; ref: { kind: string } }[] };
    if (items.some(({ ref }) => ref.kind === 'cp4')) return;
    for (const { id, ref } of items) if (ref.kind === 'cp1' || ref.kind === 'cp2') await post(`/api/inbox/${id}/answer`, { action: 'approve' });
    await new Promise((resolve) => setTimeout(resolve, INBOX_POLL_MS));
  }
}
void approveUpToCp4().catch((err: unknown) => console.error('The demo could not reach CP4:', err));

if (!existsSync(WEB_INDEX)) console.log('There is no web build, so only the API is up. Run: npm run web:build');
console.log(`Demo running on http://127.0.0.1:${running.port}. Ctrl-C stops it and deletes ${home}`);
