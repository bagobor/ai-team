import { buildClaudeInvocation } from '../../src/adapters/claude-args.ts';
import { workerEnv } from '../../src/adapters/env.ts';
import type { Workspace } from '../../src/adapters/types.ts';
import type { TaskManifest } from '../../src/manifest/build.ts';

const manifest = {
  model: 'claude-sonnet-5-5',
  budgets: { max_turns: 60, max_usd: 3, context_tokens: 12000, playbook_tokens: 2000, memory_tokens: 1000 },
  tools: ['read_repo', 'edit_repo', 'run_commands', { network: 'restricted' }],
  outputSchema: { type: 'object', title: 'Change Report' },
} as TaskManifest;

const ws: Workspace = { path: '/w', transcriptPath: '/t/1.jsonl', manifestDir: '/m/T-1-a1' };
const cfg = { agentHome: '/home/agent', mode: 'subscription' as const, parentEnv: { PATH: '/b', ANTHROPIC_API_KEY: 'k' } };

describe('buildClaudeInvocation', () => {
  it('builds the §6.2 subscription invocation', () => {
    const { argv, env } = buildClaudeInvocation(manifest, ws, cfg);

    expect(argv).toEqual([
      '-p', '--output-format', 'stream-json', '--verbose',
      '--model', 'claude-sonnet-5-5',
      '--append-system-prompt-file', '/m/T-1-a1/system.md',
      '--json-schema', JSON.stringify(manifest.outputSchema),
      '--permission-mode', 'dontAsk',
      '--tools', 'Read,Glob,Grep,Edit,Write,Bash',
      '--allowedTools', 'Read,Glob,Grep,Bash,Edit(./**),Write(./**)',
      '--strict-mcp-config', '--mcp-config', '{"mcpServers":{}}',
      '--max-turns', '60', '--max-budget-usd', '3',
      '--settings', '{"sandbox":{"enabled":true,"allowUnsandboxedCommands":false,"network":{"allowedDomains":[]}}}',
    ]);
    expect(env.CLAUDE_CONFIG_DIR).toBe('/home/agent');
    expect(env.CLAUDE_CODE_DISABLE_AUTO_MEMORY).toBe('1');
    expect(env.ANTHROPIC_API_KEY).toBeUndefined();
  });

  it('adds --bare only in api-key mode', () => {
    expect(buildClaudeInvocation(manifest, ws, cfg).argv).not.toContain('--bare');
    expect(buildClaudeInvocation(manifest, ws, { ...cfg, mode: 'api-key' }).argv).toContain('--bare');
  });

  it('offers only the tools the role has', () => {
    const { argv } = buildClaudeInvocation({ ...manifest, tools: ['read_repo'] }, ws, cfg);

    expect(argv[argv.indexOf('--tools') + 1]).toBe('Read,Glob,Grep');
    expect(argv[argv.indexOf('--allowedTools') + 1]).toBe('Read,Glob,Grep');
  });

  it('keeps the sandbox on for a role without the network tool', () => {
    const { argv } = buildClaudeInvocation({ ...manifest, tools: ['run_commands'] }, ws, cfg);

    expect(JSON.parse(argv[argv.indexOf('--settings') + 1]!)).toMatchObject({ sandbox: { enabled: true, network: { allowedDomains: [] } } });
  });

  it('never lets extra env change where the worker logs in', () => {
    const { env } = buildClaudeInvocation(manifest, ws, { ...cfg, extraEnv: { FAKE: '1', CLAUDE_CONFIG_DIR: '/elsewhere' } });

    expect(env.FAKE).toBe('1');
    expect(env.CLAUDE_CONFIG_DIR).toBe('/home/agent');
  });
});

describe('workerEnv', () => {
  it('strips secrets and nesting vars', () => {
    const e = workerEnv({ PATH: '/b', ANTHROPIC_API_KEY: 'k', CLAUDECODE: '1', CLAUDE_CODE_ENTRYPOINT: 'x', AWS_SECRET_ACCESS_KEY: 's' });
    expect(e).toEqual({ PATH: '/b' });
  });

  it('passes the whole allow-list and any extras', () => {
    const allowed = { PATH: '1', HOME: '2', USER: '3', LOGNAME: '4', SHELL: '5', TMPDIR: '6', LANG: '7', LC_ALL: '8', LC_CTYPE: '9', TERM: '10' };
    expect(workerEnv({ ...allowed, OTHER: 'x' }, { EXTRA: 'y' })).toEqual({ ...allowed, EXTRA: 'y' });
  });
});
