import { readFile, realpath, stat } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { isWithin } from '../paths.ts';
import { CHARTER_TOKEN_LIMIT, type Budgets, type Role, type RoleTool } from '../roles/role.ts';
import type { Ticket } from '../tickets/ticket.ts';
import { charsForTokens, estimateTokens } from './tokens.ts';

export type ManifestPart = {
  name: 'charter' | 'playbook' | 'memory' | 'task_inputs' | 'output_contract' | 'repo_instructions';
  tokens: number;
  budget: number | null;
  sources: string[];
};

export type TaskManifest = {
  project: string;
  ticketId: string;
  attemptK: number;
  roleId: string;
  adapter: string;
  model: string;
  budgets: Budgets;
  tools: RoleTool[];
  system: string;
  task: string;
  outputSchema: object;
  writeScope: Role['write_scope'];
  parts: ManifestPart[];
  totalTokens: number;
  contextBudget: number;
  flags?: readonly string[];
};

export type RepoInstruction = { path: string; content: string; inRepo: boolean };

export type BuildInput = {
  project: string;
  attemptK: number;
  role: Role;
  charter: string;
  schema: object;
  ticket: Ticket;
  ticketMarkdown: string;
  repoInstructions: RepoInstruction[];
  retry?: { evidence: string; changeReport: unknown };
};

export type BuildResult =
  | { ok: true; manifest: TaskManifest }
  | { ok: false; reason: 'context_over_budget'; parts: ManifestPart[]; totalTokens: number };

const REPORT_HEADING = '\n\n## Previous attempt\n\n### Change Report\n';
const EVIDENCE_HEADING = '\n\n### Evidence\n';
const PREVIOUS_ATTEMPT_SOURCE = 'previous attempt';

// A worker doesn't load these by itself, since its settings sources exclude the project's, so the ones in the repo
// are copied into its prompt. The ones above the repo are the stakeholder's own and are only counted, in case they load.
const INSTRUCTION_FILES = ['CLAUDE.md', join('.claude', 'CLAUDE.md'), 'AGENTS.md'];

function outputContract(i: BuildInput): string {
  const { role, ticket, schema } = i;
  const title = (schema as { title?: unknown }).title;
  const lines = [
    '## Output contract',
    '',
    `Finish with a ${typeof title === 'string' ? title : role.output_schema} matching the output schema you were given.`,
    '',
    `You may change: ${role.write_scope.allow.map((p) => `\`${p}\``).join(', ')}.`,
    `You must not change: ${role.write_scope.deny.map((p) => `\`${p}\``).join(', ')}.`,
    '',
    'Definition of done, each of which must exit 0:',
    ...ticket.definition_of_done.map((command) => `- \`${command}\``),
  ];
  return lines.join('\n');
}

function instructionsSection(files: RepoInstruction[]): string {
  const inRepo = files.filter((file) => file.inRepo);
  if (inRepo.length === 0) return '';
  return [
    '## Repository instructions',
    '',
    "The repository's notes on how to work in it. The output contract above comes first where they disagree.",
    ...inRepo.flatMap((file) => ['', `### ${file.path}`, '', file.content.trimEnd()]),
  ].join('\n');
}

const trimMarker = (chars: number) => `[… ${chars} chars trimmed]\n`;

function keepTail(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  // The marker reserved here is the longest it can be, as it reports fewer characters than the whole text.
  const room = maxChars - trimMarker(text.length).length;
  if (room <= 0) return '';
  let start = text.length - room;
  const first = text.charCodeAt(start);
  if (first >= 0xdc00 && first <= 0xdfff) start += 1; // Never begin on the second half of a surrogate pair.
  return trimMarker(start) + text.slice(start);
}

// The worker wrote the Change Report and much of the evidence, so neither may grow the prompt past its budget.
// The report gets at most half of what is left, and the evidence goes last so that its tail, where failures show, survives.
function taskWithPreviousAttempt(ticketMarkdown: string, retry: NonNullable<BuildInput['retry']>, maxChars: number): string {
  const room = maxChars - ticketMarkdown.length - REPORT_HEADING.length - EVIDENCE_HEADING.length;
  if (room <= 0) return ticketMarkdown;
  const report = keepTail(JSON.stringify(retry.changeReport ?? 'None', null, 2), Math.floor(room / 2));
  const evidence = keepTail(retry.evidence, room - report.length);
  return `${ticketMarkdown}${REPORT_HEADING}${report}${EVIDENCE_HEADING}${evidence}`;
}

export function buildManifest(i: BuildInput): BuildResult {
  const { role, ticket, retry } = i;
  const budgets = role.defaults.budgets;
  const contextBudget = budgets.context_tokens;

  const contract = outputContract(i);
  const charterTokens = estimateTokens(i.charter);
  // The schema reaches the model too, through the adapter, so it counts even though it isn't in the system prompt.
  const contractTokens = estimateTokens(`${contract}\n\n${JSON.stringify(i.schema)}`);
  const instructions = instructionsSection(i.repoInstructions);
  const instructionTokens = i.repoInstructions
    .filter((file) => !file.inRepo)
    .reduce((sum, file) => sum + estimateTokens(file.content), estimateTokens(instructions));
  const taskBudget = contextBudget - charterTokens - contractTokens - instructionTokens;

  const task = retry ? taskWithPreviousAttempt(i.ticketMarkdown, retry, charsForTokens(taskBudget)) : i.ticketMarkdown;
  const ticketSource = `artifacts/ticket/${ticket.id}.md`;

  const parts: ManifestPart[] = [
    { name: 'charter', tokens: charterTokens, budget: CHARTER_TOKEN_LIMIT, sources: [`roles/${role.id}/charter.md`] },
    { name: 'playbook', tokens: 0, budget: budgets.playbook_tokens, sources: [] },
    { name: 'memory', tokens: 0, budget: budgets.memory_tokens, sources: [] },
    {
      name: 'task_inputs',
      tokens: estimateTokens(task),
      budget: Math.max(0, taskBudget),
      sources: task === i.ticketMarkdown ? [ticketSource] : [ticketSource, PREVIOUS_ATTEMPT_SOURCE],
    },
    { name: 'output_contract', tokens: contractTokens, budget: null, sources: [role.output_schema] },
    { name: 'repo_instructions', tokens: instructionTokens, budget: null, sources: i.repoInstructions.map((file) => file.path) },
  ];
  const totalTokens = parts.reduce((sum, part) => sum + part.tokens, 0);

  if (totalTokens > contextBudget) return { ok: false, reason: 'context_over_budget', parts, totalTokens };

  return {
    ok: true,
    manifest: {
      project: i.project,
      ticketId: ticket.id,
      attemptK: i.attemptK,
      roleId: role.id,
      adapter: role.defaults.adapter,
      model: role.defaults.model,
      budgets,
      tools: role.tools,
      system: `${i.charter.trimEnd()}\n\n${contract}\n${instructions && `\n${instructions}\n`}`,
      task,
      outputSchema: i.schema,
      writeScope: role.write_scope,
      parts,
      totalTokens,
      contextBudget,
    },
  };
}

// Only a regular file is read: a link to /dev/zero would never end.
async function readIfFile(path: string): Promise<string | undefined> {
  const found = await stat(path).catch(() => undefined);
  return found?.isFile() ? readFile(path, 'utf8') : undefined;
}

// This text goes into a prompt and a worktree holds anything the integration branch does, so a link may name a secret
// elsewhere on the machine. One that stays inside is fine, and common: CLAUDE.md -> AGENTS.md.
async function readInside(root: string, path: string): Promise<string | undefined> {
  const real = await realpath(path).catch(() => undefined);
  return real !== undefined && isWithin(root, real) ? readIfFile(real) : undefined;
}

async function isFile(path: string): Promise<boolean> {
  return (await stat(path).catch(() => undefined))?.isFile() ?? false;
}

export async function findAncestorInstructions(dir: string): Promise<string[]> {
  const found: string[] = [];
  let current = resolve(dir);
  for (let parent = dirname(current); parent !== current; current = parent, parent = dirname(current)) {
    for (const name of INSTRUCTION_FILES) {
      const path = join(parent, name);
      if (await isFile(path)) found.push(path);
    }
  }
  return found;
}

export async function readRepoInstructions(worktree: string): Promise<RepoInstruction[]> {
  const root = await realpath(worktree);
  const files: RepoInstruction[] = [];
  for (const name of INSTRUCTION_FILES) {
    const content = await readInside(root, join(worktree, name));
    if (content !== undefined) files.push({ path: name, content, inRepo: true });
  }
  for (const path of await findAncestorInstructions(worktree)) {
    const content = await readIfFile(path);
    if (content !== undefined) files.push({ path, content, inRepo: false });
  }
  return files;
}
