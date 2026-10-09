import { deflateSync } from 'node:zlib';
import { posix } from 'node:path';

export interface MockApp {
  id: string;
  title: string;
  version: string;
  type: string;
  vendor: string;
  folderPath: string;
  icon: string;
  visible: boolean;
  removable: boolean;
  systemApp: boolean;
}

/** Everything about one fake TV that commands can change. Each startMockTv() gets its own. */
export interface MockState {
  username: string;
  /** Homebrew Channel installed (its luna service answers). */
  hbchannel: boolean;
  apps: MockApp[];
  files: Map<string, Buffer>;
  dirs: Set<string>;
  /** App ids launched, newest last — lets tests assert on launches. */
  launched: string[];
  /** Total / available KiB reported by `df`. */
  diskKb: { total: number; available: number };
}

export const DEV_APPS_DIR = '/media/developer/apps/usr/palm/applications';

function crc32(buf: Buffer): number {
  let c = ~0;
  for (const b of buf) {
    c ^= b;
    for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1));
  }
  return ~c >>> 0;
}

/** A small solid-colour PNG with a lighter inset square, so the apps list has something to show. */
export function makeIconPng(rgb: [number, number, number], size = 64): Buffer {
  const chunk = (type: string, data: Buffer) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const td = Buffer.concat([Buffer.from(type, 'ascii'), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(td));
    return Buffer.concat([len, td, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // RGB
  const raw = Buffer.alloc((size * 3 + 1) * size);
  for (let y = 0; y < size; y++) {
    raw[y * (size * 3 + 1)] = 0;
    for (let x = 0; x < size; x++) {
      const inset = x > size * 0.3 && x < size * 0.7 && y > size * 0.3 && y < size * 0.7;
      const o = y * (size * 3 + 1) + 1 + x * 3;
      for (let i = 0; i < 3; i++) raw[o + i] = inset ? Math.min(255, rgb[i]! + 70) : rgb[i]!;
    }
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

const PALETTE: [number, number, number][] = [
  [37, 99, 235],
  [16, 185, 129],
  [139, 92, 246],
  [249, 115, 22],
  [236, 72, 153],
  [20, 184, 166],
];

export function devApp(id: string, title: string, version: string, vendor = 'webOS Homebrew'): MockApp {
  return {
    id,
    title,
    version,
    type: 'web',
    vendor,
    folderPath: `${DEV_APPS_DIR}/${id}`,
    icon: 'icon.png',
    visible: true,
    removable: true,
    systemApp: false,
  };
}

/** Default apps on the fake TV (Dev Mode partition). Extend as features land; keep shapes close to real webOS. */
export const MOCK_APPS: MockApp[] = [
  devApp('com.example.hello', 'Hello World', '1.0.0', 'Example Inc.'),
  devApp('org.webosbrew.hbchannel', 'Homebrew Channel', '0.7.2'),
  devApp('youtube.leanback.v4', 'YouTube AdFree', '0.4.6'),
  devApp('com.limelight.webos', 'Moonlight', '1.2.1'),
];

export function addFile(state: MockState, path: string, data: Buffer) {
  ensureDir(state, posix.dirname(path));
  state.files.set(path, data);
}

export function ensureDir(state: MockState, dir: string) {
  let d = posix.normalize(dir);
  const chain: string[] = [];
  while (d !== '/' && !state.dirs.has(d)) {
    chain.push(d);
    d = posix.dirname(d);
  }
  for (const c of chain) state.dirs.add(c);
}

export function addApp(state: MockState, app: MockApp) {
  state.apps = [...state.apps.filter((a) => a.id !== app.id), app];
  const color = PALETTE[state.apps.length % PALETTE.length]!;
  addFile(state, `${app.folderPath}/${app.icon}`, makeIconPng(color));
  addFile(state, `${app.folderPath}/appinfo.json`, Buffer.from(JSON.stringify({ id: app.id, title: app.title, version: app.version })));
}

export function createState(opts: { username: string; hbchannel?: boolean; apps?: MockApp[] }): MockState {
  const state: MockState = {
    username: opts.username,
    hbchannel: opts.hbchannel ?? false,
    apps: [],
    files: new Map(),
    dirs: new Set(['/', '/tmp', '/media', '/media/developer']),
    launched: [],
    diskKb: { total: 1_843_200, available: 1_204_400 },
  };
  for (const app of opts.apps ?? MOCK_APPS) addApp(state, app);
  if (!state.hbchannel) state.apps = state.apps.filter((a) => a.id !== 'org.webosbrew.hbchannel');
  addFile(state, '/etc/prefs/properties/machineName', Buffer.from('mock-soc\n'));
  return state;
}

/** Which paths a user may write. Dev Mode's `prisoner` is jailed to the developer partition and /tmp. */
export function canWrite(state: MockState, path: string): boolean {
  if (state.username === 'root') return true;
  return path.startsWith('/media/developer/') || path === '/media/developer' || path.startsWith('/tmp/');
}

export { fakeIpk, readControl } from './ipk.js';
