import { createHash } from 'node:crypto';
import { get } from 'node:http';
import { addApp, devApp, readControl, type MockState } from './state.js';

/** Canned luna-send responses. Keep payload shapes close to real webOS. */
export type LunaHandler = (params: Record<string, unknown>, state: MockState) => Record<string, unknown>;
/** A subscription (`luna-send -i`): yields responses until done. `signal` aborts when the client closes. */
export type LunaSubscription = (
  params: Record<string, unknown>,
  state: MockState,
  signal: AbortSignal,
) => AsyncGenerator<Record<string, unknown>>;

const HB = 'luna://org.webosbrew.hbchannel.service';

const notFound = (service: string) => ({ returnValue: false, errorCode: -1, errorText: `Service does not exist: ${service}.` });

const appsOf = (state: MockState) => state.apps.map((a) => ({ ...a }));

export const LUNA: Record<string, LunaHandler> = {
  'luna://com.palm.systemservice/osInfo/query': () => ({
    returnValue: true,
    webos_name: 'webOS TV',
    webos_release: '8.0.0',
    webos_build_id: 'mock',
    device_name: 'mock-tv',
  }),
  'luna://com.webos.service.tv.systemproperty/getSystemInfo': () => ({
    returnValue: true,
    modelName: 'OLED55C36LC',
    firmwareVersion: '03.00.00',
    sdkVersion: '8.0.0',
    boardType: 'MOCK',
  }),
  'luna://com.webos.service.sdx/getDeviceUuid': () => ({ returnValue: true, uuid: '00000000-0000-0000-0000-000000000000' }),
  'luna://com.webos.applicationManager/dev/listApps': (_p, s) => ({ returnValue: true, apps: appsOf(s) }),
  'luna://com.webos.applicationManager/listApps': (_p, s) => ({ returnValue: true, apps: appsOf(s) }),
  'luna://com.webos.applicationManager/launch': (p, s) => {
    if (!s.apps.some((a) => a.id === p.id)) {
      return { returnValue: false, errorCode: -101, errorText: `Cannot find proper launchPoint for ${String(p.id)}` };
    }
    s.launched.push(String(p.id));
    return { returnValue: true, appId: p.id };
  },
  [`${HB}/getConfiguration`]: (_p, s) =>
    s.hbchannel
      ? { returnValue: true, root: s.username === 'root', telnetDisabled: false, failsafe: false, sshdEnabled: true, blockUpdates: false }
      : notFound('org.webosbrew.hbchannel.service'),
};

/** Install a package the way appinstalld would, or explain why not. */
function installPackage(state: MockState, data: Buffer | undefined): { ok: true; id: string } | { ok: false; errorCode: number; reason: string } {
  if (!data) return { ok: false, errorCode: -1, reason: 'FAILED_IPKG_INSTALL' };
  const control = readControl(data);
  if (!control) return { ok: false, errorCode: -1, reason: 'FAILED_IPKG_INSTALL' };
  // A package described as MOCK_NO_SPACE fails like a full developer partition.
  if (control.title === 'MOCK_NO_SPACE') return { ok: false, errorCode: -5, reason: 'FAILED_IPKG_INSTALL' };
  addApp(state, devApp(control.id, control.title ?? control.id, control.version));
  state.diskKb.available = Math.max(0, state.diskKb.available - Math.ceil(data.length / 1024));
  return { ok: true, id: control.id };
}

const tick = (ms = 5) => new Promise((r) => setTimeout(r, ms));

export const SUBSCRIPTIONS: Record<string, LunaSubscription> = {
  // appinstalld's dev install: progress states, then "installed" (or "... failed").
  'luna://com.webos.appInstallService/dev/install': async function* (p, s) {
    yield { returnValue: true, subscribed: true };
    const path = String(p.ipkUrl ?? '');
    for (const pct of [10, 50, 90]) {
      await tick();
      yield { returnValue: true, subscribed: true, id: p.id, details: { state: `installing : ${pct}%`, progress: pct } };
    }
    const res = installPackage(s, s.files.get(path));
    if (res.ok) {
      yield { returnValue: true, subscribed: true, id: p.id, details: { state: 'installed', packageId: res.id } };
    } else {
      yield { returnValue: true, subscribed: true, id: p.id, details: { state: 'install failed', reason: res.reason, errorCode: res.errorCode } };
    }
  },
  'luna://com.webos.appInstallService/dev/remove': async function* (p, s) {
    const app = s.apps.find((a) => a.id === p.id);
    if (!app) {
      yield { returnValue: false, errorCode: -1, errorText: `${String(p.id)} is not installed` };
      return;
    }
    yield { returnValue: true, subscribed: true };
    await tick();
    yield { returnValue: true, subscribed: true, details: { state: 'removing', packageId: app.id } };
    s.apps = s.apps.filter((a) => a.id !== app.id);
    for (const f of [...s.files.keys()]) if (f.startsWith(`${app.folderPath}/`)) s.files.delete(f);
    yield { returnValue: true, subscribed: true, details: { state: 'removed', packageId: app.id } };
  },
  // Homebrew Channel's installer downloads the IPK itself, checks the sha256, then installs
  // (webos-homebrew-channel services/service.ts 'install').
  [`${HB}/install`]: async function* (p, s, signal) {
    if (!s.hbchannel) {
      yield notFound('org.webosbrew.hbchannel.service');
      return;
    }
    yield { returnValue: true, subscribed: true, statusText: 'Downloading…' };
    let data: Buffer;
    try {
      data = await new Promise<Buffer>((resolve, reject) => {
        const req = get(String(p.ipkUrl), { signal }, (res) => {
          if (res.statusCode !== 200) return reject(new Error(`HTTP ${res.statusCode}`));
          const chunks: Buffer[] = [];
          res.on('data', (c: Buffer) => chunks.push(c));
          res.on('end', () => resolve(Buffer.concat(chunks)));
          res.on('error', reject);
        });
        req.on('error', reject);
      });
    } catch (e) {
      yield { returnValue: false, errorText: `Download failed: ${(e as Error).message}` };
      return;
    }
    yield { returnValue: true, subscribed: true, statusText: 'Downloading…', progress: 100 };
    yield { returnValue: true, subscribed: true, statusText: 'Verifying…' };
    const sum = createHash('sha256').update(data).digest('hex');
    if (sum !== p.ipkHash) {
      yield { returnValue: false, errorText: `Invalid file checksum (${String(p.ipkHash)} expected, got ${sum}` };
      return;
    }
    yield { returnValue: true, subscribed: true, statusText: 'Installing…' };
    const res = installPackage(s, data);
    if (!res.ok) {
      yield { returnValue: false, errorText: `Installation failed: ${res.errorCode}: ${res.reason}` };
      return;
    }
    yield { returnValue: true, subscribed: true, statusText: 'Finished.', finished: true };
  },
};

const serviceOf = (uri: string) => uri.split('/').slice(0, 3).join('/');
const KNOWN_SERVICES = new Set([...Object.keys(LUNA), ...Object.keys(SUBSCRIPTIONS)].map(serviceOf));

/** Answer for a URI nobody handles: unknown method on a known service, else unknown service. */
export function lunaMiss(uri: string): Record<string, unknown> {
  const service = serviceOf(uri);
  if (KNOWN_SERVICES.has(service)) {
    return { returnValue: false, errorCode: -1, errorText: `Unknown method "${uri.slice(service.length)}" for category "/"` };
  }
  return notFound(service.slice('luna://'.length));
}

export function handleLuna(uri: string, params: Record<string, unknown>, state: MockState): Record<string, unknown> {
  const h = LUNA[uri];
  return h ? h(params, state) : lunaMiss(uri);
}
