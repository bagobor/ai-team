// A minimal Chrome DevTools Protocol client over Node's own WebSocket, so driving Chrome needs no dependency.

export type Cdp = {
  send<T>(method: string, params?: object, sessionId?: string): Promise<T>;
  on(event: string, handler: (params: any, sessionId?: string) => void): () => void;
  close(): void;
};

type Pending = { method: string; resolve: (result: any) => void; reject: (err: Error) => void };

export function connectCdp(wsUrl: string): Promise<Cdp> {
  return new Promise((resolve, reject) => {
    let ws: WebSocket;
    try {
      ws = new WebSocket(wsUrl);
    } catch (err) {
      reject(err instanceof Error ? err : new Error(String(err)));
      return;
    }
    const pending = new Map<number, Pending>();
    const handlers = new Map<string, Set<(params: any, sessionId?: string) => void>>();
    let nextId = 0;
    let closed: Error | undefined;

    // Whoever is waiting on Chrome is told at once, so a dead browser can't leave a run hanging.
    const shut = (why: string) => {
      closed ??= new Error(why);
      for (const p of pending.values()) p.reject(new Error(`${p.method}: ${closed.message}`));
      pending.clear();
    };

    const cdp: Cdp = {
      send<T>(method: string, params: object = {}, sessionId?: string): Promise<T> {
        if (closed) return Promise.reject(new Error(`${method}: ${closed.message}`));
        const id = ++nextId;
        return new Promise<T>((res, rej) => {
          pending.set(id, { method, resolve: res, reject: rej });
          ws.send(JSON.stringify(sessionId === undefined ? { id, method, params } : { id, method, params, sessionId }));
        });
      },
      on(event, handler) {
        let set = handlers.get(event);
        if (!set) handlers.set(event, (set = new Set()));
        set.add(handler);
        return () => set.delete(handler);
      },
      close() {
        shut('the CDP connection was closed');
        ws.close();
      },
    };

    ws.addEventListener('open', () => resolve(cdp));
    ws.addEventListener('message', (event) => {
      let message: any;
      try {
        message = JSON.parse(typeof event.data === 'string' ? event.data : '');
      } catch {
        return;
      }
      if (typeof message?.id === 'number') {
        const p = pending.get(message.id);
        if (!p) return;
        pending.delete(message.id);
        if (message.error) p.reject(new Error(`${p.method}: ${message.error.message ?? 'failed'}${message.error.data ? ` (${message.error.data})` : ''}`));
        else p.resolve(message.result);
      } else if (typeof message?.method === 'string') {
        // A copy, so a handler that unsubscribes itself doesn't disturb the rest.
        for (const handler of [...(handlers.get(message.method) ?? [])]) handler(message.params, message.sessionId);
      }
    });
    // An error is always followed by a close, which does the work.
    ws.addEventListener('error', () => {});
    ws.addEventListener('close', () => {
      shut('the CDP connection closed');
      reject(new Error(`Could not connect to ${wsUrl}`));
    });
  });
}
