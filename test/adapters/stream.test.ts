import { readFileSync } from 'node:fs';
import { ClaudeStreamParser } from '../../src/adapters/claude-stream.ts';

const schema = { type: 'object', required: ['ok'], properties: { ok: { type: 'boolean' } } };
const cleanExit = { code: 0, signal: null, stderrTail: '' };

function replayLines(lines: string[]) {
  const parser = new ClaudeStreamParser(schema);
  const events = lines.flatMap((line) => parser.push(line));
  return { events, result: parser.finish(cleanExit) };
}

function replay(fixture: string) {
  const text = readFileSync(new URL(`../fixtures/claude/${fixture}`, import.meta.url), 'utf8');
  return replayLines(text.split('\n').filter(Boolean));
}

const result = (fields: object) => JSON.stringify({ type: 'result', usage: { input_tokens: 1, output_tokens: 2 }, ...fields });
const success = (fields: object = {}) => result({ subtype: 'success', is_error: false, structured_output: { ok: true }, ...fields });
const rejected = (rate_limit_info: object) => JSON.stringify({ type: 'rate_limit_event', rate_limit_info: { status: 'rejected', ...rate_limit_info } });

describe('ClaudeStreamParser on real streams', () => {
  it('normalizes the real success stream', () => {
    const { events, result } = replay('success.jsonl');

    expect(events[0]).toMatchObject({ t: 'init', sessionId: expect.any(String), model: expect.any(String) });
    expect(events.some((e) => e.t === 'message')).toBe(true);
    expect(events.some((e) => e.t === 'tool_call' && e.name === 'Read')).toBe(true);
    expect(events.some((e) => e.t === 'tool_result' && e.name === 'Read' && e.ok)).toBe(true);
    expect(events.at(-1)).toMatchObject({ t: 'usage' });
    expect(result.status).toBe('succeeded');
    expect(result.output).toEqual({ ok: true });
    expect(result.usage.usdEst).toBeGreaterThanOrEqual(0);
    expect(result.usage.inTok).toBeGreaterThan(0);
    expect(result.usage.outTok).toBeGreaterThan(0);
    expect(result.sessionId).toEqual(expect.any(String));
  });

  it('caps tool result summaries at 500 chars', () => {
    const { events } = replay('success.jsonl');
    const summaries = events.flatMap((e) => (e.t === 'tool_result' && e.summary !== undefined ? [e.summary] : []));

    expect(summaries.length).toBeGreaterThan(0);
    expect(Math.max(...summaries.map((s) => s.length))).toBeLessThanOrEqual(500);
  });

  it('treats real auth failure as auth_required', () => {
    expect(replay('auth-failed.jsonl').result).toMatchObject({ status: 'failed', failureKind: 'auth_required' });
  });

  it('maps real max-turns and max-budget', () => {
    expect(replay('max-turns.jsonl').result).toMatchObject({ status: 'failed', failureKind: 'max_turns', message: expect.stringContaining('maximum number of turns') });
    expect(replay('max-budget.jsonl').result).toMatchObject({ status: 'budget_exceeded', message: expect.stringContaining('maximum budget') });
  });

  it('reads a real interrupted stream as a worker error, since only the adapter knows it cancelled', () => {
    expect(replay('sigint.jsonl').result).toMatchObject({ status: 'failed', failureKind: 'worker_error' });
  });
});

describe('ClaudeStreamParser on malformed streams', () => {
  it('survives garbage', () => {
    const { events, result } = replay('garbled.synthetic.jsonl');

    expect(events.filter((e) => e.t === 'error').length).toBe(1);
    expect(events.filter((e) => e.t === 'init').length).toBe(1);
    expect(result.status).toBe('succeeded');
  });

  it('does not count a blank line as garbage', () => {
    expect(replayLines(['', '   ', success()]).events.filter((e) => e.t === 'error')).toEqual([]);
  });

  it('survives a 1 MB line', () => {
    const huge = JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'x'.repeat(1_000_000) }] } });
    const { events, result } = replayLines([huge, success()]);

    expect(events.filter((e) => e.t === 'error')).toEqual([]);
    expect(result.status).toBe('succeeded');
  });

  it.each([
    ['content blocks that are not objects', { type: 'assistant', message: { content: [null, 3, 'x'] } }],
    ['a tool_use with no name', { type: 'assistant', message: { content: [{ type: 'tool_use' }] } }],
    ['a tool_result for an unknown call', { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'nope' }] } }],
  ])('survives %s', (_name, line) => {
    expect(replayLines([JSON.stringify(line), success()]).result.status).toBe('succeeded');
  });

  it('names a tool result whose call it never saw', () => {
    const line = JSON.stringify({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'nope', is_error: true, content: 'boom' }] } });
    expect(replayLines([line]).events).toEqual([{ t: 'tool_result', name: 'unknown', ok: false, summary: 'boom' }]);
  });

  it('reads tool result content given as text blocks', () => {
    const lines = [
      JSON.stringify({ type: 'assistant', message: { content: [{ type: 'tool_use', id: 'a', name: 'Bash', input: { command: 'ls' } }] } }),
      JSON.stringify({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'a', content: [{ type: 'text', text: 'one' }, { type: 'image' }, { type: 'text', text: 'two' }] }] } }),
    ];
    expect(replayLines(lines).events).toEqual([
      { t: 'tool_call', name: 'Bash', input: { command: 'ls' } },
      { t: 'tool_result', name: 'Bash', ok: true, summary: 'one\ntwo' },
    ]);
  });

  it('first result wins', () => {
    const { result } = replayLines([success(), result_('error_max_turns')]);
    expect(result.status).toBe('succeeded');
  });

  it('no result line means failure', () => {
    const p = new ClaudeStreamParser(schema);
    expect(p.finish({ code: 1, signal: null, stderrTail: 'boom' })).toMatchObject({ status: 'failed', failureKind: 'no_result', message: 'boom' });
  });

  it('says how the process ended when there is no result and no stderr', () => {
    const p = new ClaudeStreamParser(schema);
    expect(p.finish({ code: null, signal: 'SIGSEGV', stderrTail: '' }).message).toContain('SIGSEGV');
  });

  it('keeps the session id when no result arrives', () => {
    const p = new ClaudeStreamParser(schema);
    p.push(JSON.stringify({ type: 'system', subtype: 'init', session_id: 's-9', model: 'm' }));
    expect(p.finish(cleanExit).sessionId).toBe('s-9');
  });

  it('reports zero usage rather than bad numbers', () => {
    const { result } = replayLines([success({ usage: { input_tokens: 'many' }, total_cost_usd: 'lots' })]);
    expect(result.usage).toEqual({ inTok: 0, outTok: 0, cachedTok: 0 });
  });
});

const result_ = (subtype: string, fields: object = {}) => result({ subtype, is_error: true, errors: [`${subtype} message`], ...fields });

describe('ClaudeStreamParser result mapping', () => {
  it('rejects schema-invalid output', () => {
    const { result } = replayLines([success({ structured_output: { nope: 1 } })]);
    expect(result).toMatchObject({ status: 'invalid_output', message: expect.stringContaining('ok') });
    expect(result.output).toBeUndefined();
  });

  it('fails a success with no structured output', () => {
    expect(replayLines([result({ subtype: 'success', is_error: false, result: 'done' })]).result).toMatchObject({ status: 'failed', failureKind: 'no_structured_output' });
  });

  it('maps a usage limit with its reset time', () => {
    expect(replay('usage-limit.synthetic.jsonl').result).toMatchObject({ status: 'usage_limited', resetAt: '2026-10-30T15:00:00.000Z' });
  });

  it.each([
    ['a rejected rate limit event', [rejected({}), result_('error_during_execution')]],
    ['a rejected rate limit event with no result', [rejected({})]],
    ['is_error with a usage limit message', [result({ subtype: 'success', is_error: true, result: 'Claude usage limit reached' })]],
    ['is_error with a hit-your-limit message', [result({ subtype: 'success', is_error: true, result: "You've hit your limit" })]],
    ['api_error_status 429', [result_('error_during_execution', { api_error_status: 429 })]],
  ])('maps %s to usage_limited', (_name, lines) => {
    expect(replayLines(lines).result.status).toBe('usage_limited');
  });

  it('ignores overageStatus on a healthy run', () => {
    const line = JSON.stringify({ type: 'rate_limit_event', rate_limit_info: { status: 'allowed', overageStatus: 'rejected' } });
    expect(replayLines([line, success()]).result.status).toBe('succeeded');
  });

  it('lets finished work stand when a limit was hit along the way', () => {
    expect(replayLines([rejected({}), success()]).result.status).toBe('succeeded');
  });

  it.each([['a string', 'soon'], ['a huge number', 1e30]])('leaves resetAt out when resetsAt is %s', (_name, resetsAt) => {
    const { result } = replayLines([rejected({ resetsAt })]);
    expect(result.status).toBe('usage_limited');
    expect(result.resetAt).toBeUndefined();
  });

  it.each([
    ['Not logged in · Please run /login'],
    ['please run /login'],
  ])('maps is_error with %j to auth_required', (message) => {
    expect(replayLines([result({ subtype: 'success', is_error: true, result: message })]).result).toMatchObject({ status: 'failed', failureKind: 'auth_required' });
  });

  it('maps an authentication error on the assistant line to auth_required', () => {
    const line = JSON.stringify({ type: 'assistant', error: 'authentication_failed', message: { content: [] } });
    expect(replayLines([line, result_('error_during_execution')]).result).toMatchObject({ status: 'failed', failureKind: 'auth_required' });
    expect(replayLines([line]).result).toMatchObject({ status: 'failed', failureKind: 'auth_required' });
  });

  it('maps structured output retries to invalid_output', () => {
    expect(replayLines([result_('error_max_structured_output_retries')]).result.status).toBe('invalid_output');
  });

  it('maps any other error to worker_error with its message', () => {
    expect(replayLines([result_('error_something_new')]).result).toMatchObject({ status: 'failed', failureKind: 'worker_error', message: 'error_something_new message' });
    expect(replayLines([result({ subtype: 'success', is_error: true, result: 'odd' })]).result).toMatchObject({ status: 'failed', failureKind: 'worker_error', message: 'odd' });
  });

  it('treats a result with no fields as a worker error', () => {
    expect(replayLines([JSON.stringify({ type: 'result' })]).result).toMatchObject({ status: 'failed', failureKind: 'worker_error', message: expect.any(String) });
  });
});
