import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startMockTv, type MockTv } from '@lgdm/mock-tv';
import type { DeviceTarget } from '@lgdm/protocol';
import { fetchKey, resolveRedirect } from './devices/keyserver.js';
import { verifyKey } from './devices/keys.js';
import { checkConnection } from './devices/ports.js';
import { SshPool } from './ssh/pool.js';
import { lunaCall, shellQuote } from './ssh/luna.js';
import { RpcError } from './rpc/errors.js';

let tv: MockTv;
let rootTv: MockTv;
const pool = new SshPool(1000);

const devmode = (): DeviceTarget => ({
  host: tv.host,
  port: tv.sshPort,
  username: 'prisoner',
  auth: { kind: 'key', privateKey: tv.privateKey, passphrase: tv.passphrase },
});
const rooted = (password = 'alpine'): DeviceTarget => ({
  host: rootTv.host,
  port: rootTv.sshPort,
  username: 'root',
  auth: { kind: 'password', password },
});

async function code(p: Promise<unknown>): Promise<string> {
  try {
    await p;
  } catch (e) {
    return e instanceof RpcError ? e.code : `non-rpc: ${(e as Error).message}`;
  }
  return 'no error';
}

beforeAll(async () => {
  tv = await startMockTv({ passphrase: 'A1B2C3' });
  rootTv = await startMockTv({ username: 'root', password: 'alpine' });
});
afterAll(async () => {
  pool.close();
  await Promise.all([tv.close(), rootTv.close()]);
});

describe('key server', () => {
  it('fetches the key, following a same-host redirect', async () => {
    const key = await fetchKey(tv.host, tv.keyServerPort);
    expect(key).toContain('Proc-Type: 4,ENCRYPTED');
  });

  it('refuses redirects to another host', () => {
    expect(() => resolveRedirect({ host: '10.0.0.2', port: 9991, path: '/webos_rsa' }, 'http://evil.example/key')).toThrow(RpcError);
  });

  it('resolves relative redirects', () => {
    expect(resolveRedirect({ host: 'tv', port: 9991, path: '/dir/webos_rsa?x=1' }, 'key#part')).toEqual({ host: 'tv', port: 9991, path: '/dir/key' });
    expect(resolveRedirect({ host: 'tv', port: 9991, path: '/webos_rsa' }, '//tv:9922')).toEqual({ host: 'tv', port: 9922, path: '/' });
  });

  it('reports an unreachable key server', async () => {
    expect(await code(fetchKey('127.0.0.1', 1))).toBe('key_server_unreachable');
  });
});

describe('key verification', () => {
  it('needs, rejects and accepts passphrases like the original', () => {
    expect(() => verifyKey(tv.privateKey)).toThrow(expect.objectContaining({ code: 'passphrase_required' }));
    expect(() => verifyKey(tv.privateKey, 'WRONG1')).toThrow(expect.objectContaining({ code: 'bad_passphrase' }));
    expect(verifyKey(tv.privateKey, 'A1B2C3').fingerprint).toMatch(/^SHA256:/);
    expect(() => verifyKey('hello')).toThrow(expect.objectContaining({ code: 'bad_key' }));
  });
});

describe('port check', () => {
  it('sees open and closed ports', async () => {
    const res = await checkConnection(tv.host, { ssh22: 1, ssh9922: tv.sshPort, keyServer: tv.keyServerPort }, 2000);
    expect(res).toEqual({ ssh22: false, ssh9922: true, keyServer: true });
  });
});

describe('ssh + luna', () => {
  it('runs commands over a Dev Mode key login and reuses the connection', async () => {
    const res = await pool.exec(devmode(), 'id -u');
    expect(res).toEqual({ stdout: '1000\n', stderr: '', exitCode: 0 });
    await pool.exec(devmode(), 'echo again');
    expect(pool.size).toBe(1);
  });

  it('passes stdin through', async () => {
    expect((await pool.exec(devmode(), 'cat', { stdin: 'hello\n' })).stdout).toBe('hello\n');
  });

  it('logs in to a rooted TV with a password', async () => {
    expect((await pool.exec(rooted(), 'id -u')).stdout.trim()).toBe('0');
  });

  it('maps a wrong password to ssh_auth_failed', async () => {
    expect(await code(pool.exec(rooted('nope'), 'id -u'))).toBe('ssh_auth_failed');
  });

  it('maps a closed port to ssh_unreachable', async () => {
    expect(await code(pool.exec({ ...devmode(), port: 1 }, 'id -u'))).toBe('ssh_unreachable');
  });

  it('times out hung commands', async () => {
    expect(await code(pool.exec(devmode(), 'sleep 100', { timeoutMs: 300 }))).toBe('ssh_timeout');
  });

  it('calls luna services', async () => {
    const res = await lunaCall(pool, devmode(), 'luna://com.webos.service.tv.systemproperty/getSystemInfo', { keys: ['modelName'] });
    expect(res.modelName).toBe('MOCK55TV');
  });

  it('maps luna failures to typed errors', async () => {
    expect(await code(lunaCall(pool, devmode(), 'luna://com.webos.applicationManager/launch', { id: 'missing' }))).toBe('luna_error');
    expect(await code(lunaCall(pool, devmode(), 'luna://com.webos.applicationManager/nope'))).toBe('luna_unknown_method');
    expect(await code(lunaCall(pool, devmode(), 'luna://com.nothing.here/x'))).toBe('luna_service_not_found');
  });

  it('can return returnValue:false without throwing', async () => {
    const res = await lunaCall(pool, devmode(), 'luna://com.webos.applicationManager/launch', { id: 'missing' }, true, false);
    expect(res.returnValue).toBe(false);
  });

  it('escapes quotes in params', async () => {
    expect(shellQuote(`it's`)).toBe(`'it'\\''s'`);
    const res = await lunaCall(pool, devmode(), 'luna://com.webos.applicationManager/launch', { id: "it's" }, true, false);
    expect(res.errorText).toContain("it's");
  });
});
