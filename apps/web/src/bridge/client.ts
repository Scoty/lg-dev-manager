import {
  PROTOCOL_VERSION,
  type MethodName,
  type ParamsOf,
  type ResultOf,
  type RpcErrorBody,
} from '@lgdm/protocol';

export class BridgeError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly detail?: string,
  ) {
    super(message);
  }
  static from(body: RpcErrorBody) {
    return new BridgeError(body.code, body.message, body.detail);
  }
}

type Pending = { resolve: (v: unknown) => void; reject: (e: Error) => void; timer: ReturnType<typeof setTimeout> };
type EventListener = (data: unknown) => void;

/**
 * Thin typed JSON-RPC client over one WebSocket. Knows nothing about React.
 * `connect()` opens the socket and performs the `system.hello` pairing handshake.
 */
export class BridgeClient {
  private ws?: WebSocket;
  private nextId = 1;
  private pending = new Map<number, Pending>();
  private listeners = new Map<string, Set<EventListener>>();
  onClose?: (reason: string) => void;

  constructor(
    readonly url: string,
    private readonly token: string,
  ) {}

  async connect(timeoutMs = 8000): Promise<ResultOf<'system.hello'>> {
    await new Promise<void>((resolve, reject) => {
      let ws: WebSocket;
      try {
        ws = new WebSocket(this.url);
      } catch (e) {
        reject(new BridgeError('bad_url', `Invalid bridge address: ${this.url}`, String(e)));
        return;
      }
      this.ws = ws;
      const timer = setTimeout(() => {
        ws.close();
        reject(new BridgeError('timeout', 'The bridge did not answer in time.'));
      }, timeoutMs);
      ws.onopen = () => {
        clearTimeout(timer);
        resolve();
      };
      ws.onerror = () => {
        clearTimeout(timer);
        reject(new BridgeError('unreachable', 'Could not reach the bridge. Is it running, and is this site allowed?'));
      };
      ws.onmessage = (e) => this.handle(String(e.data));
      ws.onclose = (e) => {
        const reason = e.reason || (e.code === 4401 ? 'unauthorized' : 'closed');
        for (const p of this.pending.values()) {
          clearTimeout(p.timer);
          p.reject(new BridgeError('disconnected', 'Connection to the bridge was lost.'));
        }
        this.pending.clear();
        this.onClose?.(reason);
      };
    });
    return this.call('system.hello', { token: this.token, protocolVersion: PROTOCOL_VERSION, client: 'web' });
  }

  call<M extends MethodName>(method: M, params?: ParamsOf<M>, timeoutMs = 30_000): Promise<ResultOf<M>> {
    const ws = this.ws;
    if (!ws || ws.readyState !== WebSocket.OPEN) {
      return Promise.reject(new BridgeError('disconnected', 'Not connected to the bridge.'));
    }
    const id = this.nextId++;
    return new Promise<ResultOf<M>>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new BridgeError('timeout', `${method} timed out.`));
      }, timeoutMs);
      this.pending.set(id, { resolve: resolve as (v: unknown) => void, reject, timer });
      ws.send(JSON.stringify({ id, method, params }));
    });
  }

  on(event: string, fn: EventListener): () => void {
    let set = this.listeners.get(event);
    if (!set) this.listeners.set(event, (set = new Set()));
    set.add(fn);
    return () => set!.delete(fn);
  }

  close() {
    this.onClose = undefined;
    this.ws?.close();
  }

  private handle(raw: string) {
    let msg: { id?: number; result?: unknown; error?: RpcErrorBody; event?: string; data?: unknown };
    try {
      msg = JSON.parse(raw);
    } catch {
      return;
    }
    if (typeof msg.id === 'number') {
      const p = this.pending.get(msg.id);
      if (!p) return;
      this.pending.delete(msg.id);
      clearTimeout(p.timer);
      if (msg.error) p.reject(BridgeError.from(msg.error));
      else p.resolve(msg.result);
    } else if (msg.event) {
      this.listeners.get(msg.event)?.forEach((fn) => fn(msg.data));
    }
  }
}
