import { buildClaudeInvocation } from '../../src/adapters/claude-args.ts';
import { workerEnv } from '../../src/adapters/env.ts';
import type { Workspace } from '../../src/adapters/types.ts';
import type { TaskManifest } from '../../src/manifest/build.ts';

const manifest = {
  model: 'claude-sonnet-5-5',
  budgets: { max_turns: 60, max_usd: 3, context_tokens: 12000, playbook_tokens: 2000, memory_tokens: 1000 },
  tools: ['read_repo', 'edit_repo', 'run_commands', { network: 'restricted' }],
  outputSchema: { type: 'object', title: 'Change Report' },
  networkAllow: [],
} as unknown as TaskManifest;

const ws: Workspace = { path: '/w', transcriptPath: '/t/1.jsonl', manifestDir: '/m/T-1-a1' };
const cfg = { agentHome: '/home/agent', mode: 'subscription' as const, denyRead: ['/secret'], parentEnv: { PATH: '/b', ANTHROPIC_API_KEY: 'k' } };

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
      '--allowedTools', 'Read(./**),Glob(./**),Grep(./**),Bash,Edit(./**),Write(./**)',
      '--strict-mcp-config', '--mcp-config', '{"mcpServers":{}}',
      '--setting-sources', 'user',
      '--max-turns', '60', '--max-budget-usd', '3',
      '--settings', '{"sandbox":{"enabled":true,"allowUnsandboxedCommands":false,"network":{"allowedDomains":[]},"filesystem":{"denyRead":["/secret"],"allowRead":["/w"]}}}',
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
    expect(argv[argv.indexOf('--allowedTools') + 1]).toBe('Read(./**),Glob(./**),Grep(./**)');
  });

  // A worktree's settings can hold hooks, and hooks run outside the Bash sandbox.
  it('never loads settings from the worktree, in either mode', () => {
    for (const mode of ['subscription', 'api-key'] as const) {
      const { argv } = buildClaudeInvocation(manifest, ws, { ...cfg, mode });
      expect(argv[argv.indexOf('--setting-sources') + 1]).toBe('user');
    }
  });

  it('keeps every denied path out of the sandbox for any role', () => {
    const { argv } = buildClaudeInvocation({ ...manifest, tools: ['run_commands'] }, ws, { ...cfg, denyRead: ['/a', '/b'] });

    expect(JSON.parse(argv[argv.indexOf('--settings') + 1]!)).toMatchObject({ sandbox: { filesystem: { denyRead: ['/a', '/b'] } } });
  });

  it('gives the attempt back its own worktree and nothing else', () => {
    const { argv } = buildClaudeInvocation(manifest, { ...ws, path: '/worktrees/p/T-1-a2' }, cfg);

    expect(JSON.parse(argv[argv.indexOf('--settings') + 1]!).sandbox.filesystem.allowRead).toEqual(['/worktrees/p/T-1-a2']);
  });

  it('passes the allowed domains to the sandbox settings', () => {
    const { argv } = buildClaudeInvocation({ ...manifest, networkAllow: ['registry.npmjs.org', 'pypi.org'] }, ws, cfg);

    expect(JSON.parse(argv[argv.indexOf('--settings') + 1]!)).toMatchObject({ sandbox: { network: { allowedDomains: ['registry.npmjs.org', 'pypi.org'] } } });
  });

  it('keeps allowedDomains empty by default', () => {
    const { argv } = buildClaudeInvocation(manifest, ws, cfg);

    expect(JSON.parse(argv[argv.indexOf('--settings') + 1]!)).toMatchObject({ sandbox: { network: { allowedDomains: [] } } });
  });

  it('gives a role without the network tool none of the allowed domains', () => {
    const { argv } = buildClaudeInvocation({ ...manifest, tools: ['read_repo', 'run_commands'], networkAllow: ['registry.npmjs.org'] }, ws, cfg);

    expect(JSON.parse(argv[argv.indexOf('--settings') + 1]!)).toMatchObject({ sandbox: { network: { allowedDomains: [] } } });
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
