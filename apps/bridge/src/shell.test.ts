import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startMockTv, type MockTv } from '@lgdm/mock-tv';
import type { CmdLog, DeviceTarget, ShellExit, ShellOutput } from '@lgdm/protocol';
import { ShellSessions } from './shell/shells.js';
import { SshPool } from './ssh/pool.js';
import { RpcError } from './rpc/errors.js';

const pool = new SshPool(1000);
let ptyTv: MockTv;
let dumbTv: MockTv;

const rooted = (tv: MockTv, password = 'alpine'): DeviceTarget => ({ host: tv.host, port: tv.sshPort, username: 'root', auth: { kind: 'password', password } });

function harness() {
  const events: { event: string; data: unknown }[] = [];
  const shells = new ShellSessions(pool, (event, data) => events.push({ event, data }));
  const output = (id: string, stream?: 'stderr') =>
    events
      .filter((e) => e.event === 'shell.output' && (e.data as ShellOutput).shellId === id && (e.data as ShellOutput).stream === stream)
      .map((e) => Buffer.from((e.data as ShellOutput).data, 'base64').toString('utf8'))
      .join('');
  const exit = (id: string) => events.find((e) => e.event === 'shell.exit' && (e.data as ShellExit).shellId === id)?.data as ShellExit | undefined;
  const until = async (pred: () => boolean, ms = 3000) => {
    const end = Date.now() + ms;
    while (!pred()) {
      if (Date.now() > end) throw new Error('timed out');
      await new Promise((r) => setTimeout(r, 10));
    }
  };
  return { events, shells, output, exit, until };
}

beforeAll(async () => {
  [ptyTv, dumbTv] = await Promise.all([
    startMockTv({ username: 'root', password: 'alpine' }),
    startMockTv({ username: 'root', password: 'alpine', pty: false }),
  ]);
});
afterAll(async () => {
  pool.close();
  await Promise.all([ptyTv.close(), dumbTv.close()]);
});

describe('interactive shells', () => {
  it('opens a PTY shell, echoes input, runs commands, resizes and exits', async () => {
    const h = harness();
    const { shellId, pty, title } = await h.shells.open(rooted(ptyTv), 24, 80);
    expect(pty).toBe(true);
    expect(title).toBe(`root@${ptyTv.host}`);
    await h.until(() => h.output(shellId).includes('# '));
    h.shells.write(shellId, 'stty size\r');
    await h.until(() => h.output(shellId).includes('24 80'));
    h.shells.resize(shellId, 40, 120);
    await new Promise((r) => setTimeout(r, 30));
    h.shells.write(shellId, 'stty size\r');
    await h.until(() => h.output(shellId).includes('40 120'));
    h.shells.write(shellId, 'exit\r');
    await h.until(() => !!h.exit(shellId));
    expect(h.exit(shellId)).toEqual({ shellId, code: 0 });
    expect(h.shells.count).toBe(0);
    // The console sees that a shell ran, never what was typed.
    const logs = h.events.filter((e) => e.event === 'cmd.log').map((e) => e.data as CmdLog);
    expect(logs.map((l) => [l.phase, l.command])).toEqual([
      ['start', 'shell (PTY 80×24)'],
      ['end', 'shell (PTY 80×24)'],
    ]);
    expect(JSON.stringify(logs)).not.toContain('stty');
  });

  it('falls back to a shell without a PTY when the TV refuses one', async () => {
    const h = harness();
    const { shellId, pty } = await h.shells.open(rooted(dumbTv), 24, 80);
    expect(pty).toBe(false);
    h.shells.write(shellId, 'whoami;echo command-1:$?\n');
    await h.until(() => h.output(shellId).includes('command-1:0'));
    expect(h.output(shellId)).toBe('root\ncommand-1:0\n');
    h.shells.write(shellId, 'nope\n');
    await h.until(() => h.output(shellId, 'stderr').includes('not found'));
    h.shells.resize(shellId, 30, 100); // ignored without a PTY
    h.shells.close(shellId);
    await h.until(() => !!h.exit(shellId));
  });

  it('can be asked for no PTY, and closes everything on disconnect', async () => {
    const h = harness();
    const a = await h.shells.open(rooted(ptyTv), 24, 80, false);
    const b = await h.shells.open(rooted(ptyTv), 24, 80);
    expect(a.pty).toBe(false);
    expect(h.shells.count).toBe(2);
    h.shells.closeAll();
    await h.until(() => !!h.exit(a.shellId) && !!h.exit(b.shellId));
    expect(h.shells.count).toBe(0);
    expect(() => h.shells.write(a.shellId, 'x')).toThrow(RpcError);
  });

  it('pauses a flooding shell until the client acknowledges what it has shown', async () => {
    const h = harness();
    const { shellId } = await h.shells.open(rooted(ptyTv), 24, 80);
    await h.until(() => h.output(shellId).includes('# '));
    h.shells.write(shellId, 'seq 1 400000\r'); // ~2.7 MB
    const bytes = () =>
      h.events
        .filter((e) => e.event === 'shell.output' && (e.data as ShellOutput).shellId === shellId)
        .reduce((n, e) => n + Buffer.from((e.data as ShellOutput).data, 'base64').length, 0);
    await h.until(() => bytes() > 1024 * 1024);
    await new Promise((r) => setTimeout(r, 300));
    const stalled = bytes();
    expect(stalled).toBeLessThan(1024 * 1024 + 256 * 1024);
    expect(h.output(shellId)).not.toContain('399999\r\n400000');
    // Acknowledge everything, repeatedly, until the rest arrives.
    let acked = 0;
    await h.until(() => {
      const b = bytes();
      if (b > acked) {
        h.shells.ack(shellId, b - acked);
        acked = b;
      }
      return h.output(shellId).includes('399999\r\n400000');
    }, 10_000);
    h.shells.close(shellId);
  });

  it('ends a shell that was still opening when the connection closed', async () => {
    const h = harness();
    const opening = h.shells.open(rooted(ptyTv), 24, 80);
    h.shells.closeAll();
    await expect(opening).rejects.toMatchObject({ code: 'shell_failed' });
    expect(h.shells.count).toBe(0);
    await expect(h.shells.open(rooted(ptyTv), 24, 80)).rejects.toMatchObject({ code: 'shell_failed' });
  });

  it('reports a failed login and limits how many shells are open', async () => {
    const h = harness();
    await expect(h.shells.open(rooted(ptyTv, 'wrong'), 24, 80)).rejects.toMatchObject({ code: 'ssh_auth_failed' });
    const opened = await Promise.all(Array.from({ length: 8 }, () => h.shells.open(rooted(ptyTv), 24, 80)));
    await expect(h.shells.open(rooted(ptyTv), 24, 80)).rejects.toMatchObject({ code: 'shell_too_many' });
    h.shells.closeAll();
    await h.until(() => opened.every((o) => !!h.exit(o.shellId)));
  });
});
