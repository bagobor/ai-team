import { parse } from 'yaml';
import { ROLE_ID } from '../roles/role.ts';

// Ticket and project ids become paths and branch names.
export const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9_-]*$/;

const FRONT_MATTER = /^---\n(.*?\n)?---[ \t]*(?:\n(.*))?$/s;
const SIZES = ['S', 'M', 'L'] as const;

export type Ticket = {
  id: string;
  title: string;
  milestone: number;
  ac_refs: string[];
  specialty: string;
  touches: string[];
  depends_on: string[];
  definition_of_done: string[];
  inputs: string[];
  size: (typeof SIZES)[number];
  body: string;
};

export class TicketError extends Error {
  override name = 'TicketError';
}

type Fields = Record<string, unknown>;

function parseFields(yaml: string): Fields {
  let parsed: unknown;
  try {
    parsed = parse(yaml);
  } catch (cause) {
    throw new TicketError('The ticket front matter is not valid YAML', { cause });
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new TicketError('The ticket front matter must be a mapping of fields');
  }
  return parsed as Fields;
}

function text(fields: Fields, field: string): string {
  const value = fields[field];
  if (typeof value !== 'string' || value === '') throw new TicketError(`Ticket field ${field} must be a non-empty string`);
  return value;
}

function list(fields: Fields, field: string): string[] {
  const value = fields[field];
  if (!Array.isArray(value) || !value.every((item) => typeof item === 'string' && item !== '')) {
    throw new TicketError(`Ticket field ${field} must be a list of non-empty strings`);
  }
  return value as string[];
}

function nonEmptyList(fields: Fields, field: string): string[] {
  const value = list(fields, field);
  if (value.length === 0) throw new TicketError(`Ticket field ${field} must not be empty`);
  return value;
}

function pattern(fields: Fields, field: string, shape: RegExp): string {
  const value = text(fields, field);
  if (!shape.test(value)) throw new TicketError(`Ticket field ${field} has the unsafe value ${JSON.stringify(value)}`);
  return value;
}

export function parseTicket(markdown: string): Ticket {
  const match = FRONT_MATTER.exec(markdown.replace(/^﻿/, '').replaceAll('\r\n', '\n'));
  if (!match) throw new TicketError('A ticket needs YAML front matter between two --- lines');
  const fields = parseFields(match[1] ?? '');

  const milestone = fields.milestone;
  if (typeof milestone !== 'number' || !Number.isInteger(milestone) || milestone < 1) {
    throw new TicketError('Ticket field milestone must be a positive whole number');
  }

  const size = fields.size;
  if (!SIZES.includes(size as Ticket['size'])) throw new TicketError(`Ticket field size must be one of ${SIZES.join(', ')}`);

  const inputs = list(fields, 'inputs');
  if (inputs.length > 0) throw new TicketError('Ticket field inputs: inputs are not supported until M2');

  return {
    id: pattern(fields, 'id', SAFE_ID),
    title: text(fields, 'title'),
    milestone,
    ac_refs: list(fields, 'ac_refs'),
    specialty: pattern(fields, 'specialty', ROLE_ID),
    touches: nonEmptyList(fields, 'touches'),
    depends_on: list(fields, 'depends_on'),
    definition_of_done: nonEmptyList(fields, 'definition_of_done'),
    inputs,
    size: size as Ticket['size'],
    body: match[2] ?? '',
  };
}
