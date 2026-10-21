import { randomBytes } from 'node:crypto';
import { chmodSync, closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, statSync, writeSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { z } from 'zod';
import {
  DeviceAuth,
  STORE_LIMITS,
  StoreErrorCodes,
  StoredCustomRepo,
  StoredDevice as StoredDeviceSchema,
  StoredDeviceInput,
  StoredDeviceRef,
  StoredShot,
  type DeviceTarget,
  type LoginSummary,
  type StoreChanged,
  type StoredDevice,
} from '@lgdm/protocol';
import { RpcError } from '../rpc/errors.js';
import { sniffImage } from '../net/image.js';
import type { HostKeyPolicy } from '../ssh/pool.js';

/** A stored TV with its login — only ever in this file and in the bridge's memory. */
const DeviceRecord = StoredDeviceInput.extend({
  auth: DeviceAuth,
  /** The TV's SSH host key (SHA256 fingerprint), recorded on the first connection with this login; then required. */
  hostKey: z.string().max(100).optional(),
  createdAt: z.number(),
  updatedAt: z.number(),
});
type DeviceRecord = z.infer<typeof DeviceRecord>;

const DevicesFile = z.object({ version: z.literal(1), devices: z.array(DeviceRecord) });
const ReposFile = z.object({ version: z.literal(1), repos: z.array(StoredCustomRepo) });
const ShotsFile = z.object({ version: z.literal(1), shots: z.array(StoredShot) });

/**
 * What a browser may see of a stored TV: the fields of StoredDevice only (zod drops everything else), so a field added
 * to the record later never reaches a browser by accident.
 */
function publicDevice(r: DeviceRecord): StoredDevice {
  const login: LoginSummary = r.auth.kind === 'key' ? { kind: 'key', hasPassphrase: !!r.auth.passphrase } : { kind: 'password' };
  return StoredDeviceSchema.parse({ ...r, auth: undefined, hostKey: undefined, login });
}

/** The same login (whatever the key order). */
function sameLogin(a: DeviceTarget['auth'], b: DeviceTarget['auth']): boolean {
  if (a.kind === 'password') return b.kind === 'password' && a.password === b.password;
  return b.kind === 'key' && a.privateKey === b.privateKey && (a.passphrase ?? '') === (b.passphrase ?? '');
}

/**
 * The bridge's storage (2.0, `--store`): the TVs (with their logins), the custom repositories and the screenshots, in
 * its data folder (LGDM_STATE_DIR; /data in Docker), next to the pairing token. Files are readable by this user only
 * (0600, folder 0700) and written atomically (a temporary file renamed into place). Writes run one at a time.
 *
 * Logins go in and never come back out: `publicDevice` is all a browser gets, and `target` hands the full login only
 * to the call that connects to the TV.
 */
export class BridgeStore implements HostKeyPolicy {
  private devices: DeviceRecord[];
  private repos: z.infer<typeof StoredCustomRepo>[];
  private shots: z.infer<typeof StoredShot>[];
  private readonly shotsDir: string;
  private queue: Promise<unknown> = Promise.resolve();
  /** Told about every change (the server tells every paired browser). */
  onChange: (change: StoreChanged) => void = () => {};

  constructor(readonly dir: string) {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    tighten(dir, 0o700);
    this.shotsDir = join(dir, 'screenshots');
    mkdirSync(this.shotsDir, { recursive: true, mode: 0o700 });
    tighten(this.shotsDir, 0o700);
    this.devices = this.read('devices.json', DevicesFile, (f) => f.devices, []);
    this.repos = this.read('repos.json', ReposFile, (f) => f.repos, []);
    this.shots = this.read('screenshots.json', ShotsFile, (f) => f.shots, []).filter((s) => existsSync(this.shotPath(s.id, s.mime)));
  }

  // ---- TVs ----

  listDevices(): StoredDevice[] {
    return [...this.devices].sort((a, b) => a.name.localeCompare(b.name)).map(publicDevice);
  }

  /** The full target for a call that names a stored TV ({ stored: id }): its stored address and login, as they are. */
  target(ref: unknown): DeviceTarget {
    const r = StoredDeviceRef.safeParse(ref);
    if (!r.success) throw new RpcError('bad_request', 'Not a stored TV reference.');
    const d = this.devices.find((x) => x.id === r.data.stored);
    if (!d) throw new RpcError(StoreErrorCodes.NotFound, 'That TV isn’t saved on the bridge any more. Reload the page.');
    return { host: d.host, port: d.port, username: d.username, auth: d.auth };
  }

  /**
   * HostKeyPolicy (ssh/pool.ts): a connection with a stored TV's address and login must meet that TV's host key —
   * also when a browser sends the login itself. The first one records it.
   */
  forTarget(t: DeviceTarget) {
    const d = this.devices.find((x) => x.host === t.host && x.port === t.port && x.username === t.username && sameLogin(x.auth, t.auth));
    if (!d) return undefined;
    return {
      expected: d.hostKey,
      remember: (fingerprint: string) => {
        void this.write(async () => {
          const current = this.devices.find((x) => x.id === d.id);
          if (!current || current.hostKey || current.host !== t.host || current.port !== t.port || !sameLogin(current.auth, t.auth)) return;
          const next = this.devices.map((x) => (x.id === d.id ? { ...x, hostKey: fingerprint } : x));
          this.persist('devices.json', { version: 1, devices: next });
          this.devices = next;
        }).catch(() => {});
      },
    };
  }

  saveDevice(input: z.infer<typeof StoredDeviceInput>): Promise<StoredDevice> {
    return this.write(async () => {
      const now = Date.now();
      const current = this.devices.find((d) => d.id === input.id);
      if (!current && !input.auth) throw new RpcError('bad_request', 'A new TV needs its login.');
      if (!current && this.devices.length >= STORE_LIMITS.devices) throw new RpcError(StoreErrorCodes.Full, `The bridge keeps up to ${STORE_LIMITS.devices} TVs.`);
      // A stored password goes only where it was entered for: moving a TV to another address with the kept password
      // needs its host key (the new address must be the same TV), else the password again.
      const moved = !!current && (current.host !== input.host || current.port !== input.port || current.username !== input.username);
      if (current && !input.auth && moved && current.auth.kind === 'password' && !current.hostKey) {
        throw new RpcError(StoreErrorCodes.LoginRequired, 'Enter the TV’s password again to change its address or user name.');
      }
      const record = DeviceRecord.parse({
        ...current,
        ...stripUndefined(input),
        info: input.info ?? current?.info,
        auth: input.auth ?? current!.auth,
        // A new login starts over: the next connection records the TV's host key again (a reset TV has a new one).
        hostKey: input.auth ? undefined : current?.hostKey,
        createdAt: current?.createdAt ?? now,
        updatedAt: now,
      });
      const next = current ? this.devices.map((d) => (d.id === record.id ? record : d)) : [...this.devices, record];
      this.persist('devices.json', { version: 1, devices: next });
      this.devices = next;
      this.onChange({ what: 'devices' });
      return publicDevice(record);
    });
  }

  setDeviceInfo(id: string, info: DeviceRecord['info']): Promise<void> {
    return this.write(async () => {
      const current = this.devices.find((d) => d.id === id);
      if (!current || JSON.stringify(current.info) === JSON.stringify(info)) return;
      const next = this.devices.map((d) => (d.id === id ? { ...d, info } : d));
      this.persist('devices.json', { version: 1, devices: next });
      this.devices = next;
      this.onChange({ what: 'devices' });
    });
  }

  removeDevice(id: string): Promise<void> {
    return this.write(async () => {
      const next = this.devices.filter((d) => d.id !== id);
      if (next.length === this.devices.length) return;
      this.persist('devices.json', { version: 1, devices: next });
      this.devices = next;
      this.dropShots(this.shots.filter((s) => s.deviceId === id).map((s) => s.id));
      this.onChange({ what: 'devices' });
      this.onChange({ what: 'shots', deviceId: id });
    });
  }

  /** Many TVs with their logins (a browser moving its own TVs here, a backup). Same id: replaced. */
  importDevices(list: (z.infer<typeof StoredDeviceInput> & { createdAt?: number; updatedAt?: number })[]): Promise<number> {
    return this.write(async () => {
      const now = Date.now();
      const byId = new Map(this.devices.map((d) => [d.id, d]));
      for (const input of list) {
        if (!input.auth) throw new RpcError('bad_request', `“${input.name}” has no login.`);
        byId.set(input.id, DeviceRecord.parse({ ...stripUndefined(input), createdAt: input.createdAt ?? now, updatedAt: input.updatedAt ?? now }));
      }
      if (byId.size > STORE_LIMITS.devices) throw new RpcError(StoreErrorCodes.Full, `The bridge keeps up to ${STORE_LIMITS.devices} TVs.`);
      const next = [...byId.values()];
      this.persist('devices.json', { version: 1, devices: next });
      this.devices = next;
      this.onChange({ what: 'devices' });
      return list.length;
    });
  }

  // ---- Custom repositories ----

  getRepos() {
    return [...this.repos];
  }

  setRepos(repos: z.infer<typeof StoredCustomRepo>[]): Promise<void> {
    return this.write(async () => {
      // Same address: kept once. Same id for another address (two browsers' lists): a new id.
      const ids = new Set<string>();
      const unique = repos
        .filter((r, i) => repos.findIndex((x) => x.url === r.url) === i)
        .map((r) => {
          const id = ids.has(r.id) ? randomBytes(9).toString('hex') : r.id;
          ids.add(id);
          return id === r.id ? r : { ...r, id };
        })
        .slice(0, STORE_LIMITS.customRepos);
      this.persist('repos.json', { version: 1, repos: unique });
      this.repos = unique;
      this.onChange({ what: 'repos' });
    });
  }

  // ---- Screenshots ----

  listShots(deviceId: string) {
    return this.shots.filter((s) => s.deviceId === deviceId).sort((a, b) => a.at - b.at);
  }

  getShot(id: string): { mime: string; base64: string } {
    const s = this.shots.find((x) => x.id === id);
    if (!s) throw new RpcError(StoreErrorCodes.NotFound, 'That screenshot isn’t on the bridge any more.');
    return { mime: s.mime, base64: readFileSync(this.shotPath(s.id, s.mime)).toString('base64') };
  }

  /** `keepExisting`: refuse (store_full) instead of dropping older screenshots to make room — moving a browser's in. */
  addShot(deviceId: string, method: z.infer<typeof StoredShot>['method'], base64: string, at = Date.now(), keepExisting = false) {
    return this.write(async () => {
      if (!this.devices.some((d) => d.id === deviceId)) throw new RpcError(StoreErrorCodes.NotFound, 'That TV isn’t saved on the bridge.');
      const data = Buffer.from(base64, 'base64');
      if (data.length > STORE_LIMITS.shotBytes) throw new RpcError(StoreErrorCodes.Full, 'That screenshot is too big to keep.');
      const mime = sniffImage(data);
      if (mime !== 'image/png' && mime !== 'image/jpeg') throw new RpcError('bad_request', 'Only PNG and JPEG screenshots can be kept.');
      const shot = StoredShot.parse({ id: randomBytes(12).toString('base64url'), deviceId, at, method, mime, bytes: data.length });
      // Over the limit for this TV, or for all of them together: the oldest go.
      const mine = this.listShots(deviceId);
      const drop = new Set(mine.slice(0, Math.max(0, mine.length + 1 - STORE_LIMITS.shotsPerDevice)).map((s) => s.id));
      let total = data.length + this.shots.reduce((n, s) => n + (drop.has(s.id) ? 0 : s.bytes), 0);
      for (const s of [...this.shots].sort((a, b) => a.at - b.at)) {
        if (total <= STORE_LIMITS.shotsTotalBytes) break;
        if (drop.has(s.id)) continue;
        drop.add(s.id);
        total -= s.bytes;
      }
      if (keepExisting && drop.size) {
        throw new RpcError(StoreErrorCodes.Full, `The bridge keeps up to ${STORE_LIMITS.shotsPerDevice} screenshots of a TV and ${STORE_LIMITS.shotsTotalBytes / 1024 ** 3} GB in all, and has no room for this one without removing others.`);
      }
      const next = [...this.shots.filter((s) => !drop.has(s.id)), shot];
      try {
        atomicWrite(this.shotPath(shot.id, mime), data);
        this.persist('screenshots.json', { version: 1, shots: next });
      } catch (e) {
        this.unlinkShot(shot.id);
        if (e instanceof RpcError) throw e;
        throw new RpcError(StoreErrorCodes.WriteFailed, `The bridge couldn’t save to its data folder (${this.dir}). Check that it can write there.`, (e as Error).message);
      }
      this.shots = next;
      for (const id of drop) this.unlinkShot(id);
      this.onChange({ what: 'shots', deviceId });
      return shot;
    });
  }

  removeShots(ids: string[]): Promise<void> {
    return this.write(async () => {
      const devices = new Set(this.shots.filter((s) => ids.includes(s.id)).map((s) => s.deviceId));
      this.dropShots(ids);
      for (const deviceId of devices) this.onChange({ what: 'shots', deviceId });
    });
  }

  // ---- Files ----

  private dropShots(ids: string[]) {
    if (!ids.length) return;
    const gone = this.shots.filter((s) => ids.includes(s.id));
    const next = this.shots.filter((s) => !ids.includes(s.id));
    this.persist('screenshots.json', { version: 1, shots: next });
    this.shots = next;
    for (const s of gone) this.unlinkShot(s.id);
  }

  private unlinkShot(id: string) {
    for (const ext of ['png', 'jpg']) rmSync(join(this.shotsDir, `${id}.${ext}`), { force: true });
  }

  private shotPath(id: string, mime: string) {
    return join(this.shotsDir, `${id}.${mime === 'image/jpeg' ? 'jpg' : 'png'}`);
  }

  /** One write at a time, in order; a failed one doesn't stop the next. */
  private write<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.queue.then(fn, fn);
    this.queue = run.catch(() => {});
    return run;
  }

  private persist(file: string, data: unknown) {
    try {
      atomicWrite(join(this.dir, file), Buffer.from(JSON.stringify(data, null, 1)));
    } catch (e) {
      throw new RpcError(StoreErrorCodes.WriteFailed, `The bridge couldn’t save to its data folder (${this.dir}). Check that it can write there.`, (e as Error).message);
    }
  }

  private read<F, T>(file: string, schema: z.ZodType<F>, pick: (f: F) => T, empty: T): T {
    const path = join(this.dir, file);
    if (!existsSync(path)) return empty;
    tighten(path, 0o600);
    const parsed = schema.safeParse(JSON.parse(readFileSync(path, 'utf8')));
    // A file this version can't read is never overwritten silently: the bridge stops and says so.
    if (!parsed.success) throw new Error(`${path} isn't a file this bridge can read (${parsed.error.issues[0]?.message ?? 'bad format'}). Move it away to start empty.`);
    return pick(parsed.data);
  }
}

/** Write to a new temporary file (0600), flush it to disk, rename it into place, then flush the folder. */
function atomicWrite(path: string, data: Buffer) {
  const tmp = `${path}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`;
  const fd = openSync(tmp, 'wx', 0o600);
  try {
    for (let off = 0; off < data.length; ) off += writeSync(fd, data, off);
    fsyncSync(fd);
  } catch (e) {
    closeSync(fd);
    rmSync(tmp, { force: true });
    throw e;
  }
  closeSync(fd);
  renameSync(tmp, path);
  if (process.platform !== 'win32') {
    try {
      const dir = openSync(dirname(path), 'r');
      try {
        fsyncSync(dir);
      } finally {
        closeSync(dir);
      }
    } catch {
      /* some filesystems can't flush a folder */
    }
  }
}

/** Readable by this user only. Says so when that can't be done (a folder owned by another user, a mount without permissions). */
function tighten(path: string, mode: number) {
  if (process.platform === 'win32') return; // the profile folder's ACLs apply
  try {
    chmodSync(path, mode);
  } catch {
    /* checked below */
  }
  try {
    if (statSync(path).mode & 0o077) {
      console.warn(`[bridge] warning: ${path} can be read by other users of this computer, and it holds the TVs' logins. Make it readable by the user the bridge runs as only.`);
    }
  } catch {
    /* gone */
  }
}

function stripUndefined<T extends Record<string, unknown>>(o: T): T {
  return Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as T;
}
