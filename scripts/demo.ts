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

const PORT = 4780;
const FAKE_CLAUDE = fileURLToPath(new URL('../test/fixtures/fake-claude.mjs', import.meta.url));
const WEB_INDEX = fileURLToPath(new URL('../web/dist/index.html', import.meta.url));
const SLOW_LINE_MS = 1500;

const REPORT = { summary: 'The demo worker finished.', files_changed: [], commands_run: [] };

const json = (value: unknown) => JSON.stringify(value);
const assistant = (...content: unknown[]) => json({ type: 'assistant', message: { content } });
const say = (text: string) => assistant({ type: 'text', text });
const INIT = json({ type: 'system', subtype: 'init', session_id: 'demo', model: 'fake-model' });
const result = (usd: number) =>
  json({
    type: 'result',
    subtype: 'success',
    is_error: false,
    session_id: 'demo',
    result: 'done',
    total_cost_usd: usd,
    usage: { input_tokens: 12_400, output_tokens: 1800, cache_read_input_tokens: 6200 },
    structured_output: REPORT,
  });

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

// One worker at a time, so each spawn takes the next step of the script and the tickets run in the order they're added.
const script = join(home, 'script.json');
writeFileSync(
  script,
  json([
    { writeFiles: { 'src/slow.txt': 'slow' }, lines: slowLines(), lineDelayMs: SLOW_LINE_MS },
    { writeFiles: { 'src/quick.txt': 'quick' }, lines: [INIT, say('A small change.'), result(0.03)] },
    { writeFiles: { 'src/wrong.txt': 'first try' }, lines: [INIT, say('First try.'), result(0.04)] },
    { writeFiles: { 'src/wrong.txt': 'second try' }, lines: [INIT, say('Second try.'), result(0.05)] },
    { writeFiles: { 'src/fixed.txt': 'fixed' }, lines: [INIT, say('Fixed after a retry.'), result(0.06)] },
  ]),
);
writeFileSync(
  paths.config,
  stringify({
    port: PORT,
    max_workers: 1,
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

if (!existsSync(WEB_INDEX)) console.log('There is no web build, so only the API is up. Run: npm run web:build');
console.log(`Demo running on http://127.0.0.1:${running.port}. Ctrl-C stops it and deletes ${home}`);
