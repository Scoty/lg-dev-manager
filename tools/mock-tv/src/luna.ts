import { createHash } from 'node:crypto';
import { get } from 'node:http';
import { addApp, addFile, devApp, makeIconPng, readControl, type MockState } from './state.js';

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

function capture(p: Record<string, unknown>, s: MockState): Record<string, unknown> {
  const path = String(p.path ?? '');
  if (!path.startsWith('/tmp/')) return { returnValue: false, errorCode: 'CAPTURE_ERROR_01', errorText: 'Invalid path' };
  const color: [number, number, number] = p.method === 'GRAPHIC' ? [37, 99, 235] : p.method === 'VIDEO' ? [16, 185, 129] : [139, 92, 246];
  addFile(s, path, makeIconPng(color, 160));
  return { returnValue: true };
}

const appsOf = (state: MockState) => state.apps.map((a) => ({ ...a }));

export const LUNA: Record<string, LunaHandler> = {
  // Developer logging (PmLogComponent.logRead): webOS 4+ uses the config service, 3.x pmlogd.
  'luna://com.webos.service.config/setConfigs': (params, state) => {
    const configs = (params.configs ?? {}) as Record<string, unknown>;
    if (state.username !== 'root') return { returnValue: false, errorCode: -1, errorText: 'Denied method call "setConfigs"' };
    if ('system.collectDevLogs' in configs) state.debug.devLogs = configs['system.collectDevLogs'] === true;
    return { returnValue: true };
  },
  'luna://com.webos.pmlogd/setdevlogstatus': (params, state) => {
    state.debug.devLogs = params.recordDevLogs === true;
    return { returnValue: true };
  },
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
  // Without dev/: every app, including store and system apps.
  'luna://com.webos.applicationManager/listApps': (_p, s) => ({ returnValue: true, apps: [...appsOf(s), ...s.storeApps.map((a) => ({ ...a }))] }),
  // Where an app lives (findInstallLocation in app-manager.service.ts). Real TVs answer this to root only.
  'luna://com.webos.service.applicationManager/getAppInfo': (p, s) => {
    if (s.username !== 'root') return { returnValue: false, errorCode: -1, errorText: 'Denied method call "getAppInfo" for category "/"' };
    const app = [...s.apps, ...s.storeApps].find((a) => a.id === p.id);
    if (!app) return { returnValue: false, errorCode: -101, errorText: `"${String(p.id)}" was not found OR Unsupported Application Type` };
    return { returnValue: true, appId: app.id, appInfo: { ...app } };
  },
  'luna://com.webos.service.applicationManager/getAppLoadStatus': (p, s) => ({
    returnValue: true,
    appId: p.appId,
    exist: [...s.apps, ...s.storeApps].some((a) => a.id === p.appId),
  }),
  'luna://com.webos.applicationManager/launch': (p, s) => {
    if (![...s.apps, ...s.storeApps].some((a) => a.id === p.id)) {
      return { returnValue: false, errorCode: -101, errorText: `Cannot find proper launchPoint for ${String(p.id)}` };
    }
    s.launched.push(String(p.id));
    if (p.id === 'com.palmdts.devmode' && (p.params as { extend?: unknown } | undefined)?.extend === true) {
      s.devmodeExtends++;
      s.onDevmodeExtend?.();
    }
    return { returnValue: true, appId: p.id };
  },
  // Screenshots (takeScreenshot in device-manager.service.ts): write a PNG where asked.
  'luna://com.webos.service.capture/executeOneShot': (p, s) => {
    if (s.legacyCapture) return notFound('com.webos.service.capture');
    return capture(p, s);
  },
  // The older service: some models refuse a capture without an explicit size (CAPTURE_ERROR_03).
  'luna://com.webos.service.tv.capture/executeOneShot': (p, s) => {
    if (!s.legacyCapture) return notFound('com.webos.service.tv.capture');
    if (p.width === undefined) return { returnValue: false, errorCode: 'CAPTURE_ERROR_03', errorText: 'Specified size is out of range' };
    return capture(p, s);
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
    // Packages whose id ends in ".hbfail" make Homebrew Channel's own install step fail (a generic appinstalld
    // error, which the bridge retries with the dev install).
    if (readControl(data)?.id.endsWith('.hbfail')) {
      yield { returnValue: false, errorText: 'Installation failed: -1: FAILED_IPKG_INSTALL' };
      return;
    }
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
