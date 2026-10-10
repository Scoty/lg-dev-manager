// Checks a built bridge end to end, as users get it: the packed local page, pairing, and SSH to the mock TVs with a
// password and with an encrypted Dev Mode key. Skipped unless LGDM_APP points at one of:
// - the standalone app (scripts/build-app.mjs): ssh2 runs bundled, without its native add-ons;
// - dist/cli.js of the npm package installed from its tarball (CI's npm-package job) — the npm build as npx runs it.
import { spawn, execFileSync, type ChildProcess } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { createServer, type AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import WebSocket from 'ws';
import { startMockTv, type MockTv } from '@lgdm/mock-tv';
import { PROTOCOL_VERSION } from '@lgdm/protocol';
import { BRIDGE_VERSION } from './version.js';

const APP = process.env.LGDM_APP;
/** The npm package's cli.js runs under this Node.js; the app is its own executable. */
const IS_NPM = !!APP?.endsWith('.js');
const run = (args: string[]): [string, string[]] => (IS_NPM ? [process.execPath, [APP!, ...args]] : [APP!, args]);
const TOKEN = 'app-smoke-token-0123456789';

const freePort = () =>
  new Promise<number>((resolve) => {
    const s = createServer().listen(0, '127.0.0.1', () => {
      const { port } = s.address() as AddressInfo;
      s.close(() => resolve(port));
    });
  });

describe.skipIf(!APP)(IS_NPM ? 'npm package' : 'standalone app', () => {
  let app: ChildProcess;
  let port: number;
  let devTv: MockTv;
  let rootTv: MockTv;
  let ws: WebSocket;
  let nextId = 1;

  const rpc = (method: string, params?: unknown) =>
    new Promise<any>((resolve) => {
      const id = nextId++;
      ws.on('message', function onMsg(raw) {
        const msg = JSON.parse(raw.toString());
        if (msg.id === id) {
          ws.off('message', onMsg);
          resolve(msg);
        }
      });
      ws.send(JSON.stringify({ id, method, params }));
    });

  beforeAll(async () => {
    [devTv, rootTv] = await Promise.all([startMockTv({ passphrase: 'A1B2C3' }), startMockTv({ username: 'root', password: 'alpine' })]);
    port = await freePort();
    app = spawn(...run(['--port', String(port), '--no-open']), {
      env: { ...process.env, LGDM_TOKEN: TOKEN, LGDM_STATE_DIR: mkdtempSync(join(tmpdir(), 'lgdm-app-')) },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let output = '';
    await new Promise<void>((resolve, reject) => {
      const seen = (chunk: Buffer) => {
        output += chunk.toString();
        if (output.includes('Pairing token')) resolve();
      };
      app.stdout!.on('data', seen);
      app.stderr!.on('data', seen);
      app.once('exit', (code) => reject(new Error(`app exited (${code}): ${output}`)));
    });
    ws = new WebSocket(`ws://127.0.0.1:${port}/rpc`, { headers: { Origin: `http://localhost:${port}` } });
    await new Promise((resolve, reject) => {
      ws.once('open', resolve);
      ws.once('error', reject);
    });
  }, 30_000);

  afterAll(async () => {
    ws?.close();
    app?.kill();
    await Promise.all([devTv?.close(), rootTv?.close()]);
  });

  it('prints its version', () => {
    expect(execFileSync(...run(['--version']), { encoding: 'utf8' }).trim()).toBe(BRIDGE_VERSION);
  });

  it.skipIf(IS_NPM)('prints the licenses it carries', () => {
    const licenses = execFileSync(...run(['--license']), { encoding: 'utf8' });
    expect(licenses).toContain('Apache License');
    expect(licenses).toContain('LG Dev Manager contributors'); // NOTICE
    expect(licenses).toMatch(/Node\.js v\d+/);
    expect(licenses).toMatch(/^ssh2 \d/m);
  });

  it('serves the packed local page and its scripts', async () => {
    const page = await fetch(`http://127.0.0.1:${port}/`);
    expect(page.status).toBe(200);
    expect(page.headers.get('x-frame-options')).toBe('DENY');
    const html = await page.text();
    const script = /<script[^>]+src="\.?\/?([^"]+\.js)"/.exec(html)?.[1];
    expect(script).toBeTruthy();
    const js = await fetch(`http://127.0.0.1:${port}/${script}`);
    expect(js.status).toBe(200);
    expect(js.headers.get('content-type')).toContain('javascript');
    expect((await fetch(`http://127.0.0.1:${port}/devices`)).status).toBe(200); // unknown paths: the page
  });

  it('pairs and says how it was installed', async () => {
    const res = await rpc('system.hello', { token: TOKEN, protocolVersion: PROTOCOL_VERSION });
    expect(res.result).toMatchObject({ bridgeVersion: BRIDGE_VERSION, distribution: IS_NPM ? 'npm' : 'app' });
  });

  it('runs commands over SSH with a password and with an encrypted Dev Mode key', async () => {
    const root = await rpc('cmd.exec', {
      device: { host: rootTv.host, port: rootTv.sshPort, username: 'root', auth: { kind: 'password', password: 'alpine' } },
      command: 'echo hello',
    });
    expect(root.result).toMatchObject({ stdout: 'hello\n', exitCode: 0 });
    const apps = await rpc('apps.list', {
      device: {
        host: devTv.host,
        port: devTv.sshPort,
        username: devTv.username,
        auth: { kind: 'key', privateKey: devTv.privateKey, passphrase: 'A1B2C3' },
      },
    });
    expect(apps.error).toBeUndefined();
    expect(apps.result.apps.length).toBeGreaterThan(0);
  });
});
