import { join } from 'node:path';
import type { TaskManifest } from '../manifest/build.ts';
import { workerEnv } from './env.ts';
import type { Workspace } from './types.ts';

export type ClaudeInvocationConfig = {
  agentHome: string;
  mode: 'subscription' | 'api-key';
  denyRead: string[];
  parentEnv?: NodeJS.ProcessEnv;
  extraEnv?: Record<string, string>;
};

export function claudeEnv(cfg: ClaudeInvocationConfig): Record<string, string> {
  return {
    ...workerEnv(cfg.parentEnv ?? process.env, cfg.extraEnv),
    CLAUDE_CONFIG_DIR: cfg.agentHome,
    CLAUDE_CODE_DISABLE_AUTO_MEMORY: '1',
  };
}

export function buildClaudeInvocation(m: TaskManifest, ws: Workspace, cfg: ClaudeInvocationConfig): { argv: string[]; env: Record<string, string> } {
  const read = m.tools.includes('read_repo') ? ['Read', 'Glob', 'Grep'] : [];
  const edit = m.tools.includes('edit_repo') ? ['Edit', 'Write'] : [];
  const bash = m.tools.includes('run_commands') ? ['Bash'] : [];
  const inWorktree = (tool: string) => `${tool}(./**)`;

  // The OS sandbox covers only Bash, so the file tools carry their own path rule.
  const tools = [...read, ...edit, ...bash];
  const allowed = [...read.map(inWorktree), ...bash, ...edit.map(inWorktree)];
  const settings = {
    sandbox: { enabled: true, allowUnsandboxedCommands: false, network: { allowedDomains: [] }, filesystem: { denyRead: cfg.denyRead, allowRead: [ws.path] } },
  };

  const argv = [
    '-p', '--output-format', 'stream-json', '--verbose',
    '--model', m.model,
    '--append-system-prompt-file', join(ws.manifestDir, 'system.md'),
    '--json-schema', JSON.stringify(m.outputSchema),
    '--permission-mode', 'dontAsk',
    '--tools', tools.join(','),
    '--allowedTools', allowed.join(','),
    '--strict-mcp-config', '--mcp-config', '{"mcpServers":{}}',
    // Settings in a worktree can hold hooks, which run outside the sandbox. The manifest carries the repo's instructions instead.
    '--setting-sources', 'user',
    '--max-turns', String(m.budgets.max_turns), '--max-budget-usd', String(m.budgets.max_usd),
    '--settings', JSON.stringify(settings),
    ...(cfg.mode === 'api-key' ? ['--bare'] : []),
  ];

  return { argv, env: claudeEnv(cfg) };
}
