import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

/**
 * A stand-in for LG's Developer Mode session service (developer.lge.com/secure/…). The real one answers
 * `CheckDevModeSession.dev` with `{ result: "success", errorMsg: "HH:MM:SS" }` (time left) and resets the timer on
 * `ResetDevModeSession.dev`. Sessions last 1000 hours.
 */
export interface MockLge {
  /** Base URL, like https://developer.lge.com/secure */
  url: string;
  /** Session end times (ms) by token. */
  sessions: Map<string, number>;
  requests: string[];
  close(): Promise<void>;
}

const SESSION_MS = 1000 * 3600 * 1000;

const hms = (ms: number) => {
  const s = Math.max(0, Math.floor(ms / 1000));
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${pad(Math.floor(s / 3600))}:${pad(Math.floor((s % 3600) / 60))}:${pad(s % 60)}`;
};

export async function startMockLge(opts: { port?: number; tokens?: Record<string, number> } = {}): Promise<MockLge> {
  const sessions = new Map<string, number>(Object.entries(opts.tokens ?? {}).map(([t, leftMs]) => [t, Date.now() + leftMs]));
  const requests: string[] = [];
  const server: Server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://x');
    requests.push(url.pathname);
    const json = (body: unknown) => res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(body));
    const token = url.searchParams.get('sessionToken') ?? '';
    const end = sessions.get(token);
    if (url.pathname === '/secure/CheckDevModeSession.dev') {
      if (end === undefined) return json({ result: 'fail', errorCode: '405', errorMsg: 'Session token is not valid' });
      return json({ result: 'success', errorCode: '200', errorMsg: hms(end - Date.now()) });
    }
    if (url.pathname === '/secure/ResetDevModeSession.dev') {
      if (end === undefined) return json({ result: 'fail', errorCode: '405', errorMsg: 'Session token is not valid' });
      sessions.set(token, Date.now() + SESSION_MS);
      return json({ result: 'success', errorCode: '200', errorMsg: 'Session is reset' });
    }
    res.writeHead(404).end();
  });
  await new Promise<void>((r) => server.listen(opts.port ?? 0, '127.0.0.1', () => r()));
  const port = (server.address() as AddressInfo).port;
  return {
    url: `http://127.0.0.1:${port}/secure`,
    sessions,
    requests,
    close: () => new Promise<void>((r) => server.close(() => r())),
  };
}
