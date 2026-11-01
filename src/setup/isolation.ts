// The fields of Claude's `system:init` event that reveal what a worker can see.
export type ClaudeInit = {
  apiKeySource: string;
  mcp_servers: unknown[];
  plugins: { name?: string; path?: string }[];
  skills: string[];
  agents: string[];
  slash_commands: string[];
  tools: string[];
  memory_paths?: { auto?: string };
};

export type IsolationContext = {
  agentHome: string;
  allowedTools: string[];
  userSkillNames: string[];
  hookEventsSeen: boolean;
};

// Returns the name of each way the user's own configuration reached the worker.
export function isolationViolations(init: ClaudeInit, ctx: IsolationContext): string[] {
  const violations: string[] = [];
  const leaked = (names: string[]) => names.some((n) => n.includes(':') || ctx.userSkillNames.includes(n));

  if (init.apiKeySource !== 'none') violations.push('apiKeySource');
  if (init.mcp_servers.length > 0) violations.push('mcp_servers');
  if (init.plugins.some(({ path }) => path !== 'builtin')) violations.push('plugins');
  if (leaked(init.skills)) violations.push('skills');
  if (leaked(init.agents)) violations.push('agents');
  if (leaked(init.slash_commands)) violations.push('slash_commands');
  if (init.tools.some((t) => !ctx.allowedTools.includes(t))) violations.push('tools');
  if (ctx.hookEventsSeen) violations.push('hooks');

  const auto = init.memory_paths?.auto;
  if (auto !== undefined && !auto.startsWith(`${ctx.agentHome}/`)) violations.push('memory_paths.auto');

  return violations;
}
