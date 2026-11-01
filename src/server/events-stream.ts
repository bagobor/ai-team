import type { Context } from 'hono';
import { streamSSE } from 'hono/streaming';
import type { EventLog, EventRow } from '../events.ts';

const PING_MS = 15_000;

export type EventSource = {
  after: number;
  replay: () => Promise<EventRow[]>;
  filter: (event: EventRow) => boolean;
};

export function streamEvents(c: Context, log: EventLog, { after, replay, filter }: EventSource): Response {
  return streamSSE(c, async (stream) => {
    const queue: EventRow[] = [];
    let wake = () => {};
    let closed = false;

    // Subscribing comes before the replay: an event appended between the two would otherwise be lost.
    const unsubscribe = log.subscribe((event) => {
      if (!filter(event)) return;
      queue.push(event);
      wake();
    });
    stream.onAbort(() => {
      closed = true;
      wake();
    });
    const ping = setInterval(() => void stream.write(': ping\n\n'), PING_MS);

    try {
      let last = after;
      const send = async (event: EventRow) => {
        if (event.seq <= last) return; // In the replay as well as the subscription.
        last = event.seq;
        await stream.writeSSE({ id: String(event.seq), event: event.type, data: JSON.stringify(event) });
      };

      // Response headers go out with the first write, and a task can be quiet for a long time.
      await stream.write(': connected\n\n');
      for (const event of await replay()) await send(event);

      while (!closed) {
        const event = queue.shift();
        if (event) await send(event);
        else {
          await new Promise<void>((resolve) => {
            wake = resolve;
          });
        }
      }
    } finally {
      clearInterval(ping);
      unsubscribe();
    }
  });
}
