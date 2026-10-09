import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startMockTv, type MockTv } from '@lgdm/mock-tv';
import type { DeviceTarget } from '@lgdm/protocol';
import { homeDir, listDir, makeDir, readChunk, removePath, renameFile, statFile, writeFile } from './files/files.js';
import { RpcError } from './rpc/errors.js';
import { SshPool } from './ssh/pool.js';
import { storageInfo } from './devices/info.js';

const pool = new SshPool(1000);
let devTv: MockTv; // Dev Mode, SFTP
let rootTv: MockTv; // rooted
let noSftpTv: MockTv;

const devmode = (tv: MockTv): DeviceTarget => ({
  host: tv.host,
  port: tv.sshPort,
  username: 'prisoner',
  auth: { kind: 'key', privateKey: tv.privateKey, passphrase: tv.passphrase },
});
const rooted = (tv: MockTv): DeviceTarget => ({ host: tv.host, port: tv.sshPort, username: 'root', auth: { kind: 'password', password: 'alpine' } });

async function code(p: Promise<unknown>): Promise<string> {
  try {
    await p;
  } catch (e) {
    return e instanceof RpcError ? e.code : `non-rpc: ${(e as Error).message}`;
  }
  return 'no error';
}

beforeAll(async () => {
  [devTv, rootTv, noSftpTv] = await Promise.all([
    startMockTv(),
    startMockTv({ username: 'root', password: 'alpine' }),
    startMockTv({ sftp: false }),
  ]);
});
afterAll(async () => {
  pool.close();
  await Promise.all([devTv.close(), rootTv.close(), noSftpTv.close()]);
});

describe('home and listing', () => {
  it('finds the home folder', async () => {
    expect(await homeDir(pool, devmode(devTv))).toBe('/media/developer');
    expect(await homeDir(pool, rooted(rootTv))).toBe('/home/root');
  });

  it('lists a folder with types, owners, modes, access and symlinks', async () => {
    const { path, items } = await listDir(pool, devmode(devTv), '/media/developer/');
    expect(path).toBe('/media/developer');
    const byName = Object.fromEntries(items.map((i) => [i.name, i]));
    expect(Object.keys(byName)).not.toContain('.');
    expect(byName['notes.txt']).toMatchObject({ type: '-', mode: 'rw-r--r--', user: 'prisoner', group: 'prisoner', access: { read: true, write: true } });
    expect(byName['notes.txt']!.size).toBeGreaterThan(10);
    expect(byName['notes.txt']!.mtime).toBeGreaterThan(1_700_000_000);
    expect(byName['apps']).toMatchObject({ type: 'd', mode: 'rwxrwxr-x' });
    expect(byName['apps-link']).toMatchObject({ type: 'l', link: { target: '/media/developer/apps', type: 'd' } });
    expect(byName['old-link']).toMatchObject({ type: 'l', link: { target: 'gone', broken: true } });
  });

  it('works out access from the owner, group and other bits', async () => {
    const etc = await listDir(pool, devmode(devTv), '/etc');
    // root-owned 0755 folder: the prisoner may read but not write.
    expect(etc.items.find((i) => i.name === 'prefs')).toMatchObject({ user: 'root', access: { read: true, write: false, execute: true } });
    const asRoot = await listDir(pool, rooted(rootTv), '/etc');
    expect(asRoot.items.find((i) => i.name === 'prefs')?.access).toMatchObject({ write: true });
  });

  it('explains missing folders, files and TVs without SFTP', async () => {
    expect(await code(listDir(pool, devmode(devTv), '/nope'))).toBe('file_not_found');
    expect(await code(listDir(pool, devmode(devTv), '/media/developer/notes.txt'))).toBe('not_a_directory');
    expect(await code(listDir(pool, devmode(noSftpTv), '/media/developer'))).toBe('no_sftp');
  });

  it('stats a file through a symlink', async () => {
    expect(await statFile(pool, devmode(devTv), '/media/developer/notes.txt')).toMatchObject({ name: 'notes.txt', type: '-' });
    expect(await statFile(pool, devmode(devTv), '/media/developer/apps-link')).toMatchObject({ type: 'd' });
  });
});

describe('reading', () => {
  it('reads in chunks over SFTP, and with dd without it', async () => {
    const big = Buffer.alloc(200_000, 7);
    big.write('start', 0);
    big.write('end', big.length - 3);
    for (const tv of [devTv, noSftpTv]) {
      tv.state.files.set('/media/developer/big.bin', big);
      const a = await readChunk(pool, devmode(tv), '/media/developer/big.bin', 0, 131072);
      const b = await readChunk(pool, devmode(tv), '/media/developer/big.bin', 131072, 131072);
      expect(a.eof).toBe(false);
      expect(b.eof).toBe(true);
      expect(Buffer.concat([a.data, b.data]).equals(big)).toBe(true);
    }
    expect(await code(readChunk(pool, devmode(devTv), '/media/developer/missing', 0, 65536))).toBe('file_not_found');
    expect(await code(readChunk(pool, devmode(noSftpTv), '/media/developer/missing', 0, 65536))).toBe('file_not_found');
  });
});

describe('changing files', () => {
  it('uploads, refusing to overwrite unless asked', async () => {
    const d = devmode(devTv);
    const sent: number[] = [];
    await writeFile(pool, d, '/media/developer/up.txt', Buffer.from('one'), false, (n) => sent.push(n));
    expect(devTv.state.files.get('/media/developer/up.txt')?.toString()).toBe('one');
    expect(sent.at(-1)).toBe(3);
    expect(await code(writeFile(pool, d, '/media/developer/up.txt', Buffer.from('two'), false))).toBe('file_exists');
    await writeFile(pool, d, '/media/developer/up.txt', Buffer.from('two'), true);
    expect(devTv.state.files.get('/media/developer/up.txt')?.toString()).toBe('two');
    expect(await code(writeFile(pool, d, '/etc/nope.txt', Buffer.from('x'), false))).toBe('file_denied');
  });

  it('makes folders and renames', async () => {
    const d = devmode(devTv);
    expect(await makeDir(pool, d, '/media/developer', 'stuff')).toEqual({ path: '/media/developer/stuff' });
    expect(await code(makeDir(pool, d, '/media/developer', 'stuff'))).toBe('file_exists');
    expect(await code(makeDir(pool, d, '/etc', 'nope'))).toBe('file_denied');
    await writeFile(pool, d, '/media/developer/stuff/a.txt', Buffer.from('a'), false);
    expect(await renameFile(pool, d, '/media/developer', 'stuff', 'things')).toEqual({ path: '/media/developer/things' });
    expect(devTv.state.files.get('/media/developer/things/a.txt')?.toString()).toBe('a');
    expect(await code(renameFile(pool, d, '/media/developer', 'things', 'notes.txt'))).toBe('file_exists');
  });

  it('deletes files and whole folders, and refuses /', async () => {
    const d = devmode(devTv);
    await makeDir(pool, d, '/media/developer', 'trash');
    await writeFile(pool, d, '/media/developer/trash/x', Buffer.from('x'), false);
    await removePath(pool, d, '/media/developer/trash');
    expect(devTv.state.dirs.has('/media/developer/trash')).toBe(false);
    expect(devTv.state.files.has('/media/developer/trash/x')).toBe(false);
    expect(await code(removePath(pool, d, '/media/developer/trash'))).toBe('file_not_found');
    expect(await code(removePath(pool, d, '/etc/prefs'))).toBe('file_denied');
    expect(await code(removePath(pool, d, '/'))).toBe('bad_request');
  });

  it('reports free space for any folder', async () => {
    expect(await storageInfo(pool, devmode(devTv), '/media/developer/apps')).toMatchObject({ total: 1_843_200 });
  });
});
