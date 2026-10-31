import { readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { Ajv } from 'ajv';
import { parse } from 'yaml';
import { estimateTokens } from '../manifest/tokens.ts';
import { isWithin } from '../paths.ts';

export const CHARTER_TOKEN_LIMIT = 600;

// Looser than a ticket id: a specialty such as engineer.watchos names a role too.
export const ROLE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

export type Budgets = {
  max_turns: number;
  max_usd: number;
  context_tokens: number;
  playbook_tokens: number;
  memory_tokens: number;
};

export type RoleTool = 'read_repo' | 'edit_repo' | 'run_commands' | { network: 'restricted' };

export type Role = {
  id: string;
  specialty_of: string | null;
  department: string;
  mission: string;
  consumes: string[];
  produces: string[];
  write_scope: { allow: string[]; deny: string[] };
  tools: RoleTool[];
  defaults: { adapter: string; model: string; budgets: Budgets };
  output_schema: string;
};

const stringList = { type: 'array', items: { type: 'string' } };

const ROLE_SCHEMA = {
  type: 'object',
  required: ['id', 'specialty_of', 'department', 'mission', 'consumes', 'produces', 'write_scope', 'tools', 'defaults', 'output_schema'],
  properties: {
    id: { type: 'string' },
    specialty_of: { type: ['string', 'null'] },
    department: { type: 'string' },
    mission: { type: 'string' },
    consumes: stringList,
    produces: stringList,
    write_scope: {
      type: 'object',
      required: ['allow', 'deny'],
      additionalProperties: false,
      properties: { allow: stringList, deny: stringList },
    },
    tools: {
      type: 'array',
      items: {
        oneOf: [
          { enum: ['read_repo', 'edit_repo', 'run_commands'] },
          { type: 'object', required: ['network'], additionalProperties: false, properties: { network: { const: 'restricted' } } },
        ],
      },
    },
    defaults: {
      type: 'object',
      required: ['adapter', 'model', 'budgets'],
      properties: {
        adapter: { type: 'string' },
        model: { type: 'string' },
        budgets: {
          type: 'object',
          required: ['max_turns', 'max_usd', 'context_tokens', 'playbook_tokens', 'memory_tokens'],
          additionalProperties: false,
          properties: {
            max_turns: { type: 'integer', minimum: 1 },
            max_usd: { type: 'number', exclusiveMinimum: 0 },
            context_tokens: { type: 'integer', minimum: 1 },
            playbook_tokens: { type: 'integer', minimum: 0 },
            memory_tokens: { type: 'integer', minimum: 0 },
          },
        },
      },
    },
    output_schema: { type: 'string' },
  },
};

const ajv = new Ajv({ strict: false });
const isRole = ajv.compile<Role>(ROLE_SCHEMA);

function readOrFail(path: string, roleId: string, what: string): Promise<string> {
  return readFile(path, 'utf8').catch((cause: unknown) => {
    throw new Error(`Role ${roleId}: cannot read ${what} at ${path}`, { cause });
  });
}

function parseRole(text: string, roleId: string): Role {
  let parsed: unknown;
  try {
    parsed = parse(text);
  } catch (cause) {
    throw new Error(`Role ${roleId}: role.yaml is not valid YAML`, { cause });
  }
  if (!isRole(parsed)) throw new Error(`Role ${roleId}: role.yaml is invalid: ${ajv.errorsText(isRole.errors)}`);
  if (parsed.id !== roleId) throw new Error(`Role ${roleId}: role.yaml has the id ${parsed.id}`);
  return parsed;
}

async function loadOutputSchema(knowledgeDir: string, role: Role): Promise<object> {
  const path = resolve(knowledgeDir, role.output_schema);
  if (!isWithin(resolve(knowledgeDir), path)) {
    throw new Error(`Role ${role.id}: output schema ${role.output_schema} is outside the knowledge repo`);
  }
  const text = await readOrFail(path, role.id, 'its output schema');
  try {
    const schema: unknown = JSON.parse(text);
    // A fresh instance each time: one Ajv refuses a second schema with the same $id.
    new Ajv({ strict: false }).compile(schema as object);
    return schema as object;
  } catch (cause) {
    throw new Error(`Role ${role.id}: output schema ${role.output_schema} does not compile`, { cause });
  }
}

export async function loadRole(knowledgeDir: string, roleId: string): Promise<{ role: Role; charter: string; schema: object }> {
  if (!ROLE_ID.test(roleId)) throw new Error(`"${roleId}" is not a valid role id`);

  const dir = join(knowledgeDir, 'roles', roleId);
  const role = parseRole(await readOrFail(join(dir, 'role.yaml'), roleId, 'role.yaml'), roleId);

  const charter = await readOrFail(join(dir, 'charter.md'), roleId, 'its charter');
  const tokens = estimateTokens(charter);
  if (tokens > CHARTER_TOKEN_LIMIT) {
    throw new Error(`Role ${roleId}: charter is ${tokens} tokens, over the limit of ${CHARTER_TOKEN_LIMIT}`);
  }

  return { role, charter, schema: await loadOutputSchema(knowledgeDir, role) };
}
