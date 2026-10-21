// Smoke test of the Docker image as compose runs it (CI: the "docker" job in ci.yml; release-docker.yml before pushing).
//   node apps/bridge/scripts/docker-smoke.mjs <image> <public url, e.g. http://10.1.0.4:5199> [allowed networks]
// (allowed networks: LGDM_ALLOWED_NETWORKS, when this machine's address isn't in a private range)
// Starts the container (host networking, read-only, no capabilities, a volume for /data), then checks: it runs as a
// non-root user and turns healthy, prints a pairing link, answers only at its public address and refuses requests
// forwarded from the internet, pairs and reports LAN mode / docker, reaches the mock TV on 127.0.0.1:9922 (start it
// first: pnpm --filter @lgdm/mock-tv start), serves the web app, stops at once and keeps its token across restarts.
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { request } from 'node:http';
import WebSocket from 'ws';

// The protocol version this checkout speaks (packages/protocol needn't be built for this script).
const PROTOCOL_VERSION = Number(
  /export const PROTOCOL_VERSION = (\d+)/.exec(readFileSync(new URL('../../../packages/protocol/src/methods.ts', import.meta.url), 'utf8'))?.[1],
);

const [image, publicUrl, allowedNetworks] = process.argv.slice(2);
if (!image || !publicUrl) throw new Error('usage: docker-smoke.mjs <image> <public url>');
const pub = new URL(publicUrl);
const name = `lgdm-smoke-${process.pid}`;
const volume = `${name}-data`;
const docker = (...args) => execFileSync('docker', args, { encoding: 'utf8' }).trim();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let failures = 0;
const check = (ok, what) => {
  console.log(`${ok ? '✓' : '✗'} ${what}`);
  if (!ok) failures++;
};

const run = () =>
  docker(
    'run', '-d', '--name', name, '--network', 'host', '--read-only', '--cap-drop', 'ALL',
    '--security-opt', 'no-new-privileges:true', '-v', `${volume}:/data`, '-e', `LGDM_PUBLIC_URL=${pub.origin}`,
    ...(allowedNetworks ? ['-e', `LGDM_ALLOWED_NETWORKS=${allowedNetworks}`] : []), image,
  );

/** GET with a chosen Host header (and others), straight to the server's address. */
const get = (path, headers = {}) =>
  new Promise((resolve, reject) => {
    const req = request({ host: pub.hostname, port: pub.port || 80, path, headers: { host: pub.host, ...headers } }, (res) => {
      let body = '';
      res.on('data', (c) => (body += c));
      res.on('end', () => resolve({ status: res.statusCode, body }));
    });
    req.on('error', reject);
    req.end();
  });

async function untilHealthy() {
  for (let i = 0; i < 60; i++) {
    const s = docker('inspect', '-f', '{{if .State.Health}}{{.State.Health.Status}}{{end}}', name);
    if (s === 'healthy') return true;
    await sleep(1000);
  }
  return false;
}

async function rpc(token) {
  const ws = new WebSocket(`ws://${pub.host}/rpc`, { headers: { origin: pub.origin } });
  await new Promise((resolve, reject) => {
    ws.once('open', resolve);
    ws.once('error', reject);
  });
  let id = 0;
  const call = (method, params) =>
    new Promise((resolve) => {
      const my = ++id;
      ws.on('message', function on(raw) {
        const msg = JSON.parse(raw.toString());
        if (msg.id !== my) return;
        ws.off('message', on);
        resolve(msg);
      });
      ws.send(JSON.stringify({ id: my, method, params }));
    });
  const hello = await call('system.hello', { token, protocolVersion: PROTOCOL_VERSION, client: 'docker-smoke' });
  return { hello, call, close: () => ws.close() };
}

try {
  run();
  check(await untilHealthy(), 'the container turns healthy');
  const logs = docker('logs', name);
  const token = /Pairing token\s+(\S+)/.exec(logs)?.[1];
  check(!!token, 'it prints a pairing token');
  check(logs.includes(`${pub.origin}/#/pair?token=${token}`), 'and a pairing link for the public address');
  check(docker('exec', name, 'node', '-e', 'process.stdout.write(String(process.getuid()))') !== '0', 'it doesn’t run as root');

  check((await get('/')).status === 200, 'it answers at the public address');
  const page = await get('/');
  check(page.status === 200 && page.body.includes('<div id="root">'), 'it serves the web app');
  check((await get('/', { host: 'evil.example' })).status === 421, 'it refuses other host names (DNS rebinding)');
  check((await get('/healthz', { 'cf-connecting-ip': '192.168.1.5' })).status === 403, 'it refuses a Cloudflare tunnel');
  check((await get('/healthz', { 'x-forwarded-for': '8.8.8.8' })).status === 403, 'it refuses requests forwarded from the internet');

  const session = await rpc(token);
  const hello = session.hello.result;
  check(hello?.lan === true && hello?.distribution === 'docker', `it pairs and says it is the Docker bridge in LAN mode (${JSON.stringify(hello)})`);
  check(hello?.features?.includes('serverStore'), 'it stores the TVs');
  const saved = await session.call('store.devices.save', {
    device: { id: 'smoke-tv', name: 'Smoke TV', mode: 'devmode', host: '127.0.0.1', port: 9922, username: 'prisoner', auth: { kind: 'password', password: 'smoke-secret' } },
  });
  check(saved.result?.device?.login?.kind === 'password' && !JSON.stringify(saved).includes('smoke-secret'), 'it keeps a TV and doesn’t send its login back');
  const tv = (await session.call('device.checkConnection', { host: '127.0.0.1' })).result;
  check(tv?.ssh9922 === true, `it reaches the mock TV on this machine (${JSON.stringify(tv)})`);
  session.close();

  const started = Date.now();
  docker('stop', name);
  check(Date.now() - started < 5000, `docker stop is quick (${Date.now() - started} ms)`);
  docker('start', name);
  check(await untilHealthy(), 'it starts again');
  check(/Pairing token\s+(\S+)/.exec(docker('logs', '--since', '1m', name).split('LG Dev Manager bridge').at(-1))?.[1] === token, 'with the same token (kept in /data)');
  const again = await rpc(token);
  const list = (await again.call('store.devices.list')).result?.devices ?? [];
  check(list.some((d) => d.id === 'smoke-tv'), 'and the stored TV (kept in /data)');
  again.close();
} finally {
  if (failures) console.log(docker('logs', name));
  try {
    docker('rm', '-f', name);
    docker('volume', 'rm', '-f', volume);
  } catch {
    /* already gone */
  }
}
if (failures) {
  console.error(`${failures} check(s) failed`);
  process.exit(1);
}
console.log('The Docker image works.');
