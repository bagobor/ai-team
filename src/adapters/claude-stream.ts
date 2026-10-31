import { Ajv, type ValidateFunction } from 'ajv';
import type { AttemptResult, Usage, WorkerEvent } from './types.ts';

const SUMMARY_LIMIT = 500;
const BAD_LINE_PREVIEW = 200;
const MAX_DATE_MS = 8.64e15;
const AUTH_MESSAGE = /not logged in|please run \/login/i;
const LIMIT_MESSAGE = /usage limit|hit your limit/i;

type Json = Record<string, unknown>;

function isObject(value: unknown): value is Json {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function tokenCount(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : 0;
}

function asBlocks(message: unknown): Json[] {
  if (!isObject(message) || !Array.isArray(message.content)) return [];
  return message.content.filter(isObject);
}

function toolResultText(content: unknown): string | undefined {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return undefined;
  const texts = content.filter(isObject).flatMap((block) => (typeof block.text === 'string' ? [block.text] : []));
  return texts.length > 0 ? texts.join('\n') : undefined;
}

function resetTime(resetsAt: unknown): string | undefined {
  if (typeof resetsAt !== 'number') return undefined;
  const ms = resetsAt * 1000;
  return Math.abs(ms) <= MAX_DATE_MS ? new Date(ms).toISOString() : undefined;
}

function readUsage(result: Json | undefined): Usage {
  if (!result) return { inTok: 0, outTok: 0 };
  const usage = isObject(result.usage) ? result.usage : {};
  const cost = result.total_cost_usd;
  return {
    inTok: tokenCount(usage.input_tokens),
    outTok: tokenCount(usage.output_tokens),
    cachedTok: tokenCount(usage.cache_read_input_tokens) + tokenCount(usage.cache_creation_input_tokens),
    ...(typeof cost === 'number' && Number.isFinite(cost) && cost >= 0 ? { usdEst: cost } : {}),
  };
}

export class ClaudeStreamParser {
  private readonly validate: ValidateFunction;
  private readonly validator = new Ajv({ strict: false, allErrors: true });
  private readonly toolNames = new Map<string, string>();
  private sessionId: string | undefined;
  private result: Json | undefined;
  private authFailed = false;
  private limited = false;
  private resetAt: string | undefined;

  constructor(schema: object) {
    this.validate = this.validator.compile(schema);
  }

  push(line: string): WorkerEvent[] {
    if (line.trim() === '') return [];

    let record: unknown;
    try {
      record = JSON.parse(line);
    } catch {
      return [{ t: 'error', message: `Unreadable line in the worker's stream: ${line.slice(0, BAD_LINE_PREVIEW)}` }];
    }
    if (!isObject(record)) return [];

    switch (record.type) {
      case 'system':
        return record.subtype === 'init' ? this.onInit(record) : [];
      case 'assistant':
        return this.onAssistant(record);
      case 'user':
        return this.onUser(record);
      case 'rate_limit_event':
        this.onRateLimit(record);
        return [];
      case 'result':
        return this.onResult(record);
      default:
        return [];
    }
  }

  finish(exit: { code: number | null; signal: string | null; stderrTail: string }): AttemptResult {
    const usage = readUsage(this.result);
    const common = { usage, ...(this.sessionId !== undefined ? { sessionId: this.sessionId } : {}) };
    return { ...common, ...(this.result ? this.mapResult(this.result) : this.mapNoResult(exit)) };
  }

  private onInit(record: Json): WorkerEvent[] {
    const sessionId = typeof record.session_id === 'string' ? record.session_id : '';
    if (sessionId) this.sessionId = sessionId;
    return [{ t: 'init', sessionId, model: typeof record.model === 'string' ? record.model : '' }];
  }

  private onAssistant(record: Json): WorkerEvent[] {
    if (record.error === 'authentication_failed') this.authFailed = true;

    const events: WorkerEvent[] = [];
    for (const block of asBlocks(record.message)) {
      if (block.type === 'text' && typeof block.text === 'string') {
        events.push({ t: 'message', text: block.text });
      } else if (block.type === 'tool_use') {
        const name = typeof block.name === 'string' ? block.name : 'unknown';
        if (typeof block.id === 'string') this.toolNames.set(block.id, name);
        events.push({ t: 'tool_call', name, input: block.input });
      }
    }
    return events;
  }

  private onUser(record: Json): WorkerEvent[] {
    const events: WorkerEvent[] = [];
    for (const block of asBlocks(record.message)) {
      if (block.type !== 'tool_result') continue;
      const name = typeof block.tool_use_id === 'string' ? this.toolNames.get(block.tool_use_id) : undefined;
      const summary = toolResultText(block.content)?.slice(0, SUMMARY_LIMIT);
      events.push({ t: 'tool_result', name: name ?? 'unknown', ok: block.is_error !== true, ...(summary !== undefined ? { summary } : {}) });
    }
    return events;
  }

  // Only rate_limit_info.status counts. overageStatus can read "rejected" on a healthy run.
  private onRateLimit(record: Json): void {
    const info = record.rate_limit_info;
    if (!isObject(info) || info.status !== 'rejected') return;
    this.limited = true;
    this.resetAt = resetTime(info.resetsAt) ?? this.resetAt;
  }

  private onResult(record: Json): WorkerEvent[] {
    if (this.result) return [];
    this.result = record;
    if (typeof record.session_id === 'string') this.sessionId = record.session_id;
    return [{ t: 'usage', ...readUsage(record) }];
  }

  private mapNoResult(exit: { code: number | null; signal: string | null; stderrTail: string }): Partial<AttemptResult> & Pick<AttemptResult, 'status'> {
    if (this.authFailed) return { status: 'failed', failureKind: 'auth_required', message: 'The worker is not logged in' };
    if (this.limited) return this.usageLimited('The worker hit a usage limit');
    const ended = exit.signal ? `signal ${exit.signal}` : `exit code ${exit.code}`;
    return { status: 'failed', failureKind: 'no_result', message: exit.stderrTail || `The worker ended with ${ended} and reported no result` };
  }

  private mapResult(result: Json): Partial<AttemptResult> & Pick<AttemptResult, 'status'> {
    const subtype = typeof result.subtype === 'string' ? result.subtype : undefined;
    if (subtype === 'success' && result.is_error !== true) return this.mapSuccess(result);

    const errors = Array.isArray(result.errors) ? result.errors.filter((e): e is string => typeof e === 'string') : [];
    const text = typeof result.result === 'string' ? result.result : undefined;
    const message = errors[0] ?? text ?? `The worker reported ${subtype ?? 'an error'}`;
    const allText = [...errors, text ?? ''].join('\n');

    if (this.authFailed || AUTH_MESSAGE.test(allText)) return { status: 'failed', failureKind: 'auth_required', message };
    // These name what ended the run, so an earlier limit warning does not override them.
    if (subtype === 'error_max_turns') return { status: 'failed', failureKind: 'max_turns', message };
    if (subtype === 'error_max_budget_usd') return { status: 'budget_exceeded', message };
    if (subtype === 'error_max_structured_output_retries') return { status: 'invalid_output', message };
    if (this.limited || LIMIT_MESSAGE.test(allText) || result.api_error_status === 429) return this.usageLimited(message);
    return { status: 'failed', failureKind: 'worker_error', message };
  }

  private mapSuccess(result: Json): Partial<AttemptResult> & Pick<AttemptResult, 'status'> {
    const output = result.structured_output;
    if (output === undefined || output === null) {
      return { status: 'failed', failureKind: 'no_structured_output', message: 'The worker finished without structured output' };
    }
    if (!this.validate(output)) {
      return { status: 'invalid_output', message: this.validator.errorsText(this.validate.errors) };
    }
    return { status: 'succeeded', output };
  }

  private usageLimited(message: string): Partial<AttemptResult> & Pick<AttemptResult, 'status'> {
    return { status: 'usage_limited', message, ...(this.resetAt !== undefined ? { resetAt: this.resetAt } : {}) };
  }
}
