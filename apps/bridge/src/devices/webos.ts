import WebSocket from 'ws';
import { connect } from 'node:net';

/**
 * Is this host a webOS TV? Port 3000/3001 being open isn't proof — other TVs and dev servers use them — so we
 * ask for evidence: the second-screen WebSocket answers in SSAP's JSON shape, or an open SSH port is dropbear
 * (what webOS Dev Mode and Homebrew Channel run).
 */

const PROBE_TIMEOUT_MS = 1500;

/**
 * Ask the second-screen service something harmless. An unpaired client gets an error reply, but the reply has
 * SSAP's shape ({ type, id, … }) — which other servers on these ports don't produce. Never sends `register`, so
 * the TV shows no pairing prompt. 3000 is plain ws://, 3001 is wss:// with the TV's self-signed certificate.
 */
export function probeSsap(host: string, port: number, secure: boolean, timeoutMs = PROBE_TIMEOUT_MS): Promise<boolean> {
  return new Promise((resolve) => {
    let done = false;
    let ws: WebSocket;
    const finish = (ok: boolean) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      try {
        ws.terminate();
      } catch {
        /* not open */
      }
      resolve(ok);
    };
    const timer = setTimeout(() => finish(false), timeoutMs);
    try {
      ws = new WebSocket(`${secure ? 'wss' : 'ws'}://${host}:${port}/`, {
        handshakeTimeout: timeoutMs,
        rejectUnauthorized: false, // fingerprinting only; nothing secret is sent
        maxPayload: 64 * 1024,
      });
    } catch {
      return finish(false);
    }
    ws.on('open', () => ws.send(JSON.stringify({ type: 'request', id: 'lgdm-probe', uri: 'ssap://api/getServiceList' })));
    ws.on('message', (data) => {
      try {
        const msg = JSON.parse(data.toString()) as Record<string, unknown>;
        finish(typeof msg.type === 'string' && (msg.id === 'lgdm-probe' || msg.type === 'error' || msg.type === 'response'));
      } catch {
        finish(false);
      }
    });
    ws.on('error', () => finish(false));
    ws.on('unexpected-response', () => finish(false));
    ws.on('close', () => finish(false));
  });
}

/** Does this sweep hit look like a webOS TV rather than just "something with port 3000 open"? */
export async function looksLikeWebos(
  host: string,
  ports: { ssh22: number; ssh9922: number; webos: readonly number[] },
  sshOpen: { ssh22: boolean; ssh9922: boolean },
): Promise<boolean> {
  const [ws, wss] = ports.webos;
  const checks: Promise<boolean>[] = [];
  if (ws !== undefined) checks.push(probeSsap(host, ws, false));
  if (wss !== undefined) checks.push(probeSsap(host, wss, true));
  for (const [open, port] of [
    [sshOpen.ssh22, ports.ssh22],
    [sshOpen.ssh9922, ports.ssh9922],
  ] as const) {
    if (open) checks.push(sshBanner(host, port, PROBE_TIMEOUT_MS).then((b) => /dropbear/i.test(b ?? '')));
  }
  const results = await Promise.all(checks);
  return results.some(Boolean);
}


/** First line an SSH server sends (e.g. "SSH-2.0-dropbear_2022.83"), or null. */
export function sshBanner(host: string, port: number, timeoutMs = 1500): Promise<string | null> {
  return new Promise((resolve) => {
    const sock = connect({ host: host.replace(/^\[|\]$/g, ''), port });
    let buf = '';
    const done = (v: string | null) => {
      sock.destroy();
      resolve(v);
    };
    sock.setTimeout(timeoutMs, () => done(null));
    sock.on('data', (c: Buffer) => {
      buf += c.toString('latin1');
      const nl = buf.indexOf('\n');
      if (nl >= 0) done(buf.slice(0, nl).trim());
      else if (buf.length > 255) done(null);
    });
    sock.once('error', () => done(null));
    sock.once('end', () => done(buf.trim() || null));
  });
}
