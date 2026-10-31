import { join } from 'node:path';
import type { TaskManifest } from '../manifest/build.ts';
import { workerEnv } from './env.ts';
import type { Workspace } from './types.ts';

export type ClaudeInvocationConfig = {
  agentHome: string;
  mode: 'subscription' | 'api-key';
  parentEnv?: NodeJS.ProcessEnv;
  extraEnv?: Record<string, string>;
};

const SANDBOX = { sandbox: { enabled: true, allowUnsandboxedCommands: false, network: { allowedDomains: [] } } };

export function claudeEnv(cfg: ClaudeInvocationConfig): Record<string, string> {
  return {
    ...workerEnv(cfg.parentEnv ?? process.env, cfg.extraEnv),
    CLAUDE_CONFIG_DIR: cfg.agentHome,
    CLAUDE_CODE_DISABLE_AUTO_MEMORY: '1',
  };
}

export function buildClaudeInvocation(m: TaskManifest, ws: Workspace, cfg: ClaudeInvocationConfig): { argv: string[]; env: Record<string, string> } {
  const read = m.tools.includes('read_repo') ? ['Read', 'Glob', 'Grep'] : [];
  const edit = m.tools.includes('edit_repo');
  const bash = m.tools.includes('run_commands') ? ['Bash'] : [];

  // The OS sandbox covers only Bash, so Edit and Write carry their own path rule.
  const tools = [...read, ...(edit ? ['Edit', 'Write'] : []), ...bash];
  const allowed = [...read, ...bash, ...(edit ? ['Edit(./**)', 'Write(./**)'] : [])];

  const argv = [
    '-p', '--output-format', 'stream-json', '--verbose',
    '--model', m.model,
    '--append-system-prompt-file', join(ws.manifestDir, 'system.md'),
    '--json-schema', JSON.stringify(m.outputSchema),
    '--permission-mode', 'dontAsk',
    '--tools', tools.join(','),
    '--allowedTools', allowed.join(','),
    '--strict-mcp-config', '--mcp-config', '{"mcpServers":{}}',
    '--max-turns', String(m.budgets.max_turns), '--max-budget-usd', String(m.budgets.max_usd),
    '--settings', JSON.stringify(SANDBOX),
    ...(cfg.mode === 'api-key' ? ['--bare'] : []),
  ];

  return { argv, env: claudeEnv(cfg) };
}
