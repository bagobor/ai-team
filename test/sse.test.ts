import { once } from 'node:events';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createServer } from 'node:net';
import { setTimeout } from 'node:timers/promises';
import { serve } from '@hono/node-server';
import type { Hono } from 'hono';
import type { EventRow, EventType } from '../src/events.ts';
import type { TaskRow } from '../src/engine/store.ts';
import { createApp } from '../src/server/app.ts';
import { makeEngine, ticket, until, type TestEngine } from './helpers/engine.ts';

type Frame = { id: string; event: string; row: EventRow };

// Reads an event stream a frame at a time, keeping whatever arrives past the frames asked for.
class StreamReader {
  private readonly reader: ReadableStreamDefaultReader<Uint8Array>;
  private readonly decoder = new TextDecoder();
  private buffer = '';

  constructor(body: ReadableStream<Uint8Array>) {
    this.reader = body.getReader();
  }

  async rawFrame(): Promise<string> {
    for (;;) {
      const end = this.buffer.indexOf('\n\n');
      if (end !== -1) {
        const frame = this.buffer.slice(0, end);
        this.buffer = this.buffer.slice(end + 2);
        return frame;
      }
      const { value, done } = await this.reader.read();
      if (done) throw new Error('The stream ended');
      this.buffer += this.decoder.decode(value, { stream: true });
    }
  }

  // Skips comments.
  async frame(): Promise<Frame> {
    let raw = await this.rawFrame();
    while (raw.startsWith(':')) raw = await this.rawFrame();
    const fields = new Map(raw.split('\n').map((line) => [line.slice(0, line.indexOf(':')), line.slice(line.indexOf(':') + 2)]));
    return { id: fields.get('id')!, event: fields.get('event')!, row: JSON.parse(fields.get('data')!) as EventRow };
  }

  async frames(n: number): Promise<Frame[]> {
    const frames: Frame[] = [];
    for (let i = 0; i < n; i += 1) frames.push(await this.frame());
    return frames;
  }

  cancel(): Promise<void> {
    return this.reader.cancel();
  }
}

const PORT = 4780;

describe('the event stream', () => {
  let e: TestEngine;
  let app: Hono;
  let t: TaskRow;
  let opened: StreamReader[];

  beforeEach(async () => {
    e = await makeEngine({ steps: [], config: { port: PORT } });
    app = createApp(e);
    t = await e.addTicket(ticket());
    opened = [];
  });

  afterEach(async () => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    await Promise.all(opened.map((reader) => reader.cancel()));
    await e.cleanup();
  });

  const say = (n: number, taskId = t.id, type: EventType = 'worker.message') => e.log.append({ projectId: t.project_id, taskId, type, payload: { n } });

  async function open(query = '', headers: Record<string, string> = {}): Promise<StreamReader> {
    const res = await app.request(`/api/tasks/${t.id}/events${query}`, { headers: { host: `127.0.0.1:${PORT}`, ...headers } });
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/event-stream');
    const reader = new StreamReader(res.body!);
    opened.push(reader);
    return reader;
  }

  const messages = (frames: Frame[]) => frames.filter((f) => f.event === 'worker.message').map((f) => f.row.payload.n);

  it('sends the seq as the id, the type as the event and the whole row as the data', async () => {
    const said = await say(1);

    const frame = await (await open(`?after=${said.seq - 1}`)).frame();

    expect(frame.id).toBe(String(said.seq));
    expect(frame.event).toBe('worker.message');
    expect(frame.row).toEqual(said);
  });

  it('replays then streams', async () => {
    await say(1);
    const stream = await open();
    expect(messages([await stream.frame()])).toEqual([1]);

    await say(2);

    expect(messages([await stream.frame()])).toEqual([2]);
  });

  it('loses nothing appended while the replay is being read', async () => {
    const list = e.log.list.bind(e.log);
    vi.spyOn(e.log, 'list').mockImplementationOnce(async (q) => {
      const rows = await list(q);
      await say(1);
      return rows;
    });

    const stream = await open();

    expect(messages([await stream.frame()])).toEqual([1]);
  });

  it('repeats nothing that reached both the replay and the subscription', async () => {
    const list = e.log.list.bind(e.log);
    vi.spyOn(e.log, 'list').mockImplementationOnce(async (q) => {
      await say(1);
      return list(q);
    });

    const stream = await open();
    const first = await stream.frame();
    await say(2);
    const next = await stream.frame();

    expect(messages([first, next])).toEqual([1, 2]);
  });

  it('keeps seqs strictly increasing and complete under concurrent appends', async () => {
    const appending = Promise.all(Array.from({ length: 20 }, (_, n) => say(n)));
    const stream = await open();
    await appending;

    const frames = await stream.frames(20);

    const seqs = frames.map((f) => f.row.seq);
    expect(seqs).toEqual([...seqs].sort((a, b) => a - b));
    expect(new Set(seqs).size).toBe(20);
  });

  it('resumes from Last-Event-ID without duplicates', async () => {
    const first = await say(1);
    await say(2);

    const frame = await (await open('', { 'last-event-id': String(first.seq) })).frame();

    expect(frame.row.payload.n).toBe(2);
  });

  it('resumes from ?after=', async () => {
    const first = await say(1);
    await say(2);

    const frame = await (await open(`?after=${first.seq}`)).frame();

    expect(frame.row.payload.n).toBe(2);
  });

  it('prefers Last-Event-ID, which is what a reconnect sends', async () => {
    const first = await say(1);
    const second = await say(2);
    await say(3);

    const frame = await (await open(`?after=${first.seq}`, { 'last-event-id': String(second.seq) })).frame();

    expect(frame.row.payload.n).toBe(3);
  });

  it('replays everything when the id is not a number', async () => {
    await say(1);

    const frame = await (await open('', { 'last-event-id': 'nonsense' })).frame();

    expect(frame.row.payload.n).toBe(1);
  });

  it("shows only this task's events", async () => {
    const other = await e.addTicket(ticket({ id: 'T-2' }));
    const stream = await open();

    await say(1, other.id);
    await say(2);

    expect(messages([await stream.frame()])).toEqual([2]);
  });

  it('pings every 15 s', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    const stream = await open();
    await stream.rawFrame();

    vi.advanceTimersByTime(14_999);
    await say(1);
    await stream.frame();
    vi.advanceTimersByTime(1);

    expect(await stream.rawFrame()).toBe(': ping');
  });

  it('stops pinging when the client disconnects', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    const stream = await open();
    expect(vi.getTimerCount()).toBe(1);

    await stream.cancel();

    await until(async () => vi.getTimerCount() === 0);
  });

  it('unsubscribes when the client disconnects from an idle stream', async () => {
    await say(1);
    const stream = await open();
    await stream.frame();
    // Time for the stream to run out of events and sit waiting. Too short can only let this pass, never fail.
    await setTimeout(50);

    await stream.cancel();

    await until(async () => e.log.subscriberCount() === 0);
  });

  it('opens with a comment, so a client knows it is connected before the first event', async () => {
    expect(await (await open()).rawFrame()).toBe(': connected');
  });

  it('unsubscribes when the client disconnects', async () => {
    const stream = await open();
    expect(e.log.subscriberCount()).toBe(1);

    await stream.cancel();

    await until(async () => e.log.subscriberCount() === 0);
  });

  it('is 404 for an unknown task, without a stream', async () => {
    const res = await app.request('/api/tasks/999/events', { headers: { host: `127.0.0.1:${PORT}` } });

    expect(res.status).toBe(404);
    expect(e.log.subscriberCount()).toBe(0);
  });

  describe('over a real connection', () => {
    async function freePort(): Promise<number> {
      const probe = createServer();
      probe.listen(0, '127.0.0.1');
      await once(probe, 'listening');
      const { port } = probe.address() as AddressInfo;
      probe.close();
      await once(probe, 'close');
      return port;
    }

    it('unsubscribes when the client goes away', async () => {
      const port = await freePort();
      e.config.port = port;
      const served = createApp(e);
      const server = serve({ fetch: served.fetch, port, hostname: '127.0.0.1' }) as Server;
      await once(server, 'listening');
      const client = new AbortController();

      const res = await fetch(`http://127.0.0.1:${port}/api/tasks/${t.id}/events`, { signal: client.signal });
      await new StreamReader(res.body!).rawFrame();
      expect(e.log.subscriberCount()).toBe(1);

      client.abort();

      await until(async () => e.log.subscriberCount() === 0);
      server.closeAllConnections();
      server.close();
      await once(server, 'close');
    });
  });
});
