import { isolationViolations, type ClaudeInit } from '../src/setup/isolation.ts';

const clean: ClaudeInit = {
  apiKeySource: 'none',
  mcp_servers: [],
  plugins: [],
  skills: ['simplify'],
  agents: ['Explore'],
  slash_commands: [],
  tools: ['Read', 'StructuredOutput'],
  memory_paths: {},
};
const ctx = {
  agentHome: '/h/agent-home/claude',
  allowedTools: ['Read', 'StructuredOutput'],
  userSkillNames: ['mine'],
  hookEventsSeen: false,
};

describe('isolationViolations', () => {
  it('accepts a clean init', () => {
    expect(isolationViolations(clean, ctx)).toEqual([]);
  });

  it('accepts auto-memory inside the agent home', () => {
    const init = { ...clean, memory_paths: { auto: '/h/agent-home/claude/projects/x/memory/' } };
    expect(isolationViolations(init, ctx)).toEqual([]);
  });

  it('names each leak', () => {
    const leaky: ClaudeInit = {
      ...clean,
      plugins: [{ name: 'p' }],
      skills: ['mine', 'plug:x'],
      memory_paths: { auto: '/Users/ps/.claude/projects/x/memory/' },
      tools: ['Read', 'Task'],
      apiKeySource: 'ANTHROPIC_API_KEY',
    };
    expect(isolationViolations(leaky, { ...ctx, hookEventsSeen: true }).sort()).toEqual([
      'apiKeySource',
      'hooks',
      'memory_paths.auto',
      'plugins',
      'skills',
      'tools',
    ]);
  });

  it('flags user agents, slash commands and MCP servers', () => {
    const leaky: ClaudeInit = {
      ...clean,
      agents: ['mine'],
      slash_commands: ['plug:cmd'],
      mcp_servers: [{ name: 'server', status: 'connected' }],
    };
    expect(isolationViolations(leaky, ctx).sort()).toEqual(['agents', 'mcp_servers', 'slash_commands']);
  });
});
