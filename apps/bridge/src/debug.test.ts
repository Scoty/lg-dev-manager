import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import WebSocket from 'ws';
import { CRASH_DIR, SYSLOG, startMockTv, type MockTv } from '@lgdm/mock-tv';
import { PROTOCOL_VERSION } from '@lgdm/protocol';
import { startServer } from './server.js';
import { SshPool } from './ssh/pool.js';
import { RepoClient } from './repo/repo.js';
import { LineBatcher } from './debug/debug.js';

const TOKEN = 'debug-test-token';
const ORIGIN = 'http://localhost:5173';
let server: Server;
let root: MockTv;
let dev: MockTv;
let ws: WebSocket;
let nextId = 1;
const frames: any[] = [];

function call(method: string, params?: unknown): Promise<any> {
  const id = nextId++;
  return new Promise((resolve) => {
    ws.on('message', function onMsg(raw) {
      const msg = JSON.parse(raw.toString());
      if (msg.id === id) {
        ws.off('message', onMsg);
        resolve(msg);
      }
    });
    ws.send(JSON.stringify({ id, method, params }));
  });
}
const lines = (opId: string) => frames.filter((m) => m.event === 'logs.lines' && m.data.opId === opId).flatMap((m) => m.data.lines as string[]);
const until = async (fn: () => boolean, ms = 5000) => {
  const end = Date.now() + ms;
  while (!fn()) {
    if (Date.now() > end) throw new Error('timed out');
    await new Promise((r) => setTimeout(r, 50));
  }
};

beforeAll(async () => {
  [root, dev] = await Promise.all([startMockTv({ username: 'root', password: 'alpine' }), startMockTv()]);
  root.state.debug.every = 100;
  server = await startServer({ host: '127.0.0.1', port: 0, allowedOrigins: [ORIGIN], token: TOKEN, dev: true }, new SshPool(), new RepoClient('http://127.0.0.1:1/api'));
  ws = new WebSocket(`ws://127.0.0.1:${(server.address() as AddressInfo).port}/rpc`, { headers: { Origin: ORIGIN } });
  ws.on('message', (raw) => frames.push(JSON.parse(raw.toString())));
  await new Promise((r) => ws.once('open', r));
  await call('system.hello', { token: TOKEN, protocolVersion: PROTOCOL_VERSION });
});
afterAll(async () => {
  ws.close();
  await new Promise<void>((r) => server.close(() => r()));
  await Promise.all([root.close(), dev.close()]);
});

const rooted = () => ({ host: root.host, port: root.sshPort, username: 'root', auth: { kind: 'password', password: 'alpine' } });
const devmode = () => ({ host: dev.host, port: dev.sshPort, username: 'prisoner', auth: { kind: 'key', privateKey: dev.privateKey, passphrase: dev.passphrase } });

describe('logs.stream', () => {
  it('follows the system log: history first, then new lines, until stopped', async () => {
    const running = call('logs.stream', { device: rooted(), source: 'syslog', opId: 's1', lines: 5 });
    await until(() => lines('s1').length >= 8);
    expect(lines('s1').slice(0, 5).every((l) => /^\d{4}-\d\d-\d\dT/.test(l))).toBe(true);
    expect(root.state.debug.devLogs).toBe(true); // developer logging switched on first
    expect((await call('logs.stop', { opId: 's1' })).result).toEqual({ stopped: true });
    expect((await running).result).toEqual({ exitCode: null, stopped: true });
    // The console saw the commands.
    const cmds = frames.filter((m) => m.event === 'cmd.log' && m.data.phase === 'start').map((m) => m.data.command as string);
    expect(cmds.some((c) => c.includes('config/setConfigs'))).toBe(true);
    expect(cmds.some((c) => c.includes('{ tail -f -n 5 /var/log/messages; }'))).toBe(true);
    expect((await call('logs.stop', { opId: 's1' })).result).toEqual({ stopped: false });
  });

  it('follows dmesg and ls-monitor', async () => {
    const d = call('logs.stream', { device: rooted(), source: 'dmesg', opId: 'd1' });
    const m = call('logs.stream', { device: rooted(), source: 'lsmonitor', opId: 'm1' });
    await until(() => lines('d1').length >= 6 && lines('m1').length >= 4);
    expect(lines('d1')[0]).toMatch(/^kern\s*:info\s*: \[\s*\d+\.\d+\] usb 1-1/);
    const msg = JSON.parse(lines('m1')[0]!);
    expect(msg).toMatchObject({ type: 'call', transport: 'TX' });
    await call('logs.stop', { opId: 'd1' });
    await call('logs.stop', { opId: 'm1' });
    expect((await d).result.stopped).toBe(true);
    expect((await m).result.stopped).toBe(true);
  });

  it('captures the luna bus again after stopping, and takes over from a leftover ls-monitor', async () => {
    for (const opId of ['again1', 'again2']) {
      const m = call('logs.stream', { device: rooted(), source: 'lsmonitor', opId });
      await until(() => lines(opId).length >= 2);
      await call('logs.stop', { opId });
      const res = await m;
      expect(res.error).toBeUndefined();
      expect(res.result.stopped).toBe(true);
      await until(() => !root.state.debug.monitorRunning); // the wrapper ended it on the TV
    }
    // One left running on the TV (an older bridge didn't stop it): the next capture still starts.
    root.state.debug.monitorRunning = true;
    const m = call('logs.stream', { device: rooted(), source: 'lsmonitor', opId: 'again3' });
    await until(() => lines('again3').length >= 2);
    await call('logs.stop', { opId: 'again3' });
    expect((await m).result.stopped).toBe(true);
  });

  it('needs root, and reports a TV that refuses', async () => {
    expect((await call('logs.stream', { device: devmode(), source: 'syslog', opId: 'x1' })).error.code).toBe('wrong_login');
    // The TV refusing a root login's command: make the mock's commands act as if not root (login is unaffected).
    root.state.username = 'nobody-root';
    try {
      const res = await call('logs.stream', { device: rooted(), source: 'dmesg', opId: 'x2' });
      expect(res.error).toMatchObject({ code: 'command_failed', message: 'The TV refused to show this log.' });
      expect(res.error.detail).toContain('Operation not permitted');
    } finally {
      root.state.username = 'root';
    }
  });

  it('rejects unknown sources (no free-form commands)', async () => {
    const res = await call('logs.stream', { device: rooted(), source: 'cat /etc/shadow', opId: 'x3' });
    expect(res.error.code).toBe('bad_request');
  });
});

describe('logs.clear', () => {
  it('empties the system log and the kernel buffer', async () => {
    expect((await call('logs.clear', { device: rooted(), source: 'syslog' })).result).toEqual({});
    expect(root.state.files.get(SYSLOG)!.length).toBe(0);
    expect((await call('logs.clear', { device: rooted(), source: 'dmesg' })).result).toEqual({});
    expect(root.state.debug.dmesg).toEqual([]);
  });
});

describe('pmlog', () => {
  it('shows and sets context levels', async () => {
    const shown = await call('pmlog.show', { device: rooted() });
    expect(shown.result.contexts).toContainEqual({ name: '<default>', level: 'info' });
    expect(shown.result.contexts).toContainEqual({ name: 'ls-hubd', level: 'err' });
    expect((await call('pmlog.set', { device: rooted(), context: 'sam', level: 'debug' })).result).toEqual({ changed: ['sam'] });
    expect(root.state.debug.pmlog.get('sam')).toBe('debug');
    const all = await call('pmlog.set', { device: rooted(), context: '*', level: 'warning' });
    expect(all.result.changed.length).toBe(root.state.debug.pmlog.size);
    expect([...root.state.debug.pmlog.values()].every((l) => l === 'warning')).toBe(true);
  });

  it('validates context names and levels', async () => {
    expect((await call('pmlog.set', { device: rooted(), context: "x'; reboot", level: 'info' })).error.code).toBe('bad_request');
    expect((await call('pmlog.set', { device: rooted(), context: 'sam', level: 'loud' })).error.code).toBe('bad_request');
    expect((await call('pmlog.show', { device: devmode() })).error.code).toBe('wrong_login');
  });
});

describe('crash reports', () => {
  it('lists, reads (unzipping) and deletes', async () => {
    const list = await call('crashes.list', { device: rooted() });
    expect(list.result.dir).toBe(CRASH_DIR);
    expect(list.result.reports).toHaveLength(3);
    const crashy = list.result.reports.find((r: any) => r.name.includes('crashy'));
    expect(crashy.writable).toBe(true);
    const text = await call('crashes.read', { device: rooted(), path: crashy.path });
    expect(text.result.text).toContain('Signal: 11 (SIGSEGV)');
    expect(text.result.truncated).toBe(false);
    const plain = list.result.reports.find((r: any) => r.name === 'oops.txt');
    expect((await call('crashes.read', { device: rooted(), path: plain.path })).result.text).toBe('Kernel oops (plain text report)');
    expect((await call('crashes.delete', { device: rooted(), path: plain.path })).result).toEqual({});
    expect(root.state.files.has(`${CRASH_DIR}/oops.txt`)).toBe(false);
  });

  it('works for Developer Mode logins too, and only inside the crash folders', async () => {
    expect((await call('crashes.list', { device: devmode() })).result.reports.length).toBeGreaterThan(0);
    expect((await call('crashes.read', { device: rooted(), path: '/etc/prefs/properties/machineName' })).error.code).toBe('bad_request');
    expect((await call('crashes.delete', { device: rooted(), path: `${CRASH_DIR}/../../etc/passwd` })).error.code).toBe('bad_request');
  });

  it('is empty when no crash folder exists', async () => {
    for (const k of [...root.state.files.keys()]) if (k.startsWith(CRASH_DIR)) root.state.files.delete(k);
    root.state.dirs.delete(CRASH_DIR);
    expect((await call('crashes.list', { device: rooted() })).result).toEqual({ dir: null, reports: [] });
  });
});

describe('LineBatcher', () => {
  it('splits lines across chunks and multi-byte characters', () => {
    const got: string[] = [];
    const b = new LineBatcher((l) => got.push(...l));
    const euro = Buffer.from('€');
    b.push(Buffer.concat([Buffer.from('one\r\ntw'), euro.subarray(0, 1)]));
    b.push(Buffer.concat([euro.subarray(1), Buffer.from('o\nthree')]));
    b.flush(true);
    expect(got).toEqual(['one', 'tw€o', 'three']);
  });

  it('cuts over-long lines once and skips the rest of them', () => {
    const got: string[] = [];
    const b = new LineBatcher((l) => got.push(...l), 10);
    b.push(Buffer.from('short\n0123456789abc'));
    b.push(Buffer.from('defgh'));
    b.push(Buffer.from('ijk\nnext\n'));
    b.flush(true);
    expect(got).toEqual(['short', '0123456789 …', 'next']);
  });

  it('drops and counts what it can’t keep up with', () => {
    const batches: [number, number][] = [];
    const b = new LineBatcher((l, dropped) => batches.push([l.length, dropped]));
    b.push(Buffer.from('x\n'.repeat(12_000)));
    b.flush(true);
    expect(batches.reduce((n, [l]) => n + l, 0)).toBe(10_000);
    expect(batches[0]![1]).toBe(2000);
    expect(batches.every(([l]) => l <= 2000)).toBe(true);
  });
});
