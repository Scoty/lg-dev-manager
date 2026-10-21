// Tests only: a WebSocket client for a bridge started with startServer(), as the web app talks to it.
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import WebSocket from 'ws';
import { PROTOCOL_VERSION } from '@lgdm/protocol';

export interface TestClient {
  ws: WebSocket;
  /** Sends a call and resolves with its response frame ({ id, result } or { id, error }). */
  call(method: string, params?: unknown): Promise<any>;
  /** Every frame received, as text (to check nothing secret was ever sent) … */
  frames: string[];
  /** … and parsed. */
  messages: any[];
  /** The response to system.hello, when a token was given. */
  hello?: any;
  close(): void;
}

export async function connect(server: Server, opts: { origin: string; token?: string; headers?: Record<string, string> }): Promise<TestClient> {
  const ws = new WebSocket(`ws://127.0.0.1:${(server.address() as AddressInfo).port}/rpc`, { headers: { Origin: opts.origin, ...opts.headers } });
  const frames: string[] = [];
  const messages: any[] = [];
  const pending = new Map<number, (msg: any) => void>();
  ws.on('message', (raw) => {
    const text = raw.toString();
    const msg = JSON.parse(text);
    frames.push(text);
    messages.push(msg);
    if (typeof msg.id === 'number') {
      pending.get(msg.id)?.(msg);
      pending.delete(msg.id);
    }
  });
  await new Promise((resolve, reject) => {
    ws.once('open', resolve);
    ws.once('error', reject);
  });
  let nextId = 1;
  const call = (method: string, params?: unknown) =>
    new Promise<any>((resolve) => {
      const id = nextId++;
      pending.set(id, resolve);
      ws.send(JSON.stringify({ id, method, params }));
    });
  const client: TestClient = { ws, call, frames, messages, close: () => ws.close() };
  if (opts.token) client.hello = await call('system.hello', { token: opts.token, protocolVersion: PROTOCOL_VERSION });
  return client;
}
