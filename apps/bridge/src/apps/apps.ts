import { createHash } from 'node:crypto';
import { posix } from 'node:path';
import {
  APP_ID_HBCHANNEL,
  AppInfo,
  AppsErrorCodes,
  LunaErrorCodes,
  RepoErrorCodes,
  TEMP_IPK_DIR,
  type DeviceTarget,
  type OpProgress,
} from '@lgdm/protocol';
import { RpcError } from '../rpc/errors.js';
import { lunaCall, lunaSubscribe, type SubscriptionStep } from '../ssh/luna.js';
import type { SshRunner } from '../ssh/pool.js';
import { serveToDevice } from '../ssh/serve.js';
import { mkdirp, putFile, readFile, rmFile, sha256sum } from '../ssh/transfer.js';
import { readIpkControl } from './ipk.js';
import type { HttpTrace, RepoClient } from '../repo/repo.js';

/**
 * App management. Port of AppManagerService (dev-manager-desktop src/app/core/services/app-manager.service.ts)
 * and ares-install (ares-cli-rs ares-install/src/install.rs).
 */

export type Progress = (p: Omit<OpProgress, 'opId'>) => void;

const ICON_MAX_BYTES = 1024 * 1024;
const ICON_TYPES: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.bmp': 'image/bmp',
};

export async function listApps(pool: SshRunner, device: DeviceTarget): Promise<AppInfo[]> {
  const resp = await lunaCall(pool, device, 'luna://com.webos.applicationManager/dev/listApps').catch((e: RpcError) => {
    if (e.code === LunaErrorCodes.UnknownMethod) {
      return lunaCall(pool, device, 'luna://com.webos.applicationManager/listApps', {}, false);
    }
    throw e;
  });
  const apps = Array.isArray(resp.apps) ? resp.apps : [];
  return apps.flatMap((a) => {
    const r = AppInfo.safeParse(a);
    return r.success ? [r.data] : [];
  });
}

export async function launchApp(pool: SshRunner, device: DeviceTarget, id: string, params?: Record<string, unknown>) {
  await lunaCall(pool, device, 'luna://com.webos.applicationManager/launch', { id, subscribe: false, params }, true);
}

export async function appIcon(pool: SshRunner, device: DeviceTarget, path: string) {
  const mime = ICON_TYPES[posix.extname(path).toLowerCase()];
  if (!mime) throw new RpcError('bad_request', 'Only image files can be read as app icons.');
  const data = await readFile(pool, device, path, ICON_MAX_BYTES);
  return { mime, base64: data.toString('base64') };
}

/**
 * appinstalld subscription messages → done / keep going / error (mapAppinstalldResponse in app-manager.service.ts,
 * map_installer_message in ares-install).
 */
export function appinstalldStep(
  msg: Record<string, unknown>,
  expect: RegExp,
  failCode: string,
  onState?: (state: string) => void,
): SubscriptionStep<string | undefined> {
  const details = (msg.details ?? {}) as Record<string, unknown>;
  const state = typeof details.state === 'string' ? details.state : '';
  if (/FAILED/i.test(state)) {
    const reason = typeof details.reason === 'string' ? details.reason : state;
    const errorCode = typeof details.errorCode === 'number' ? details.errorCode : undefined;
    if (reason === 'FAILED_IPKG_INSTALL' && errorCode === -5) {
      throw new RpcError(AppsErrorCodes.InsufficientSpace, "Can't install because there isn't enough free space on the TV.", JSON.stringify(details));
    }
    throw new RpcError(failCode, errorCode !== undefined ? `${errorCode}: ${reason}` : reason, JSON.stringify(details));
  }
  if (/^SUCCESS/i.test(state) || expect.test(state)) {
    return { done: typeof details.packageId === 'string' ? details.packageId : undefined };
  }
  if (state) onState?.(state);
  return undefined;
}

/** Percent from appinstalld states like "installing : 40%" or a numeric `progress`. */
function percentOf(msg: Record<string, unknown>, state: string): number | undefined {
  const details = (msg.details ?? {}) as Record<string, unknown>;
  if (typeof details.progress === 'number') return Math.max(0, Math.min(100, details.progress));
  const m = /(\d{1,3})\s*%/.exec(state);
  return m ? Math.min(100, Number(m[1])) : undefined;
}

export async function removeApp(pool: SshRunner, device: DeviceTarget, id: string, progress?: Progress) {
  progress?.({ stage: 'remove', text: 'Removing…' });
  await lunaSubscribe(pool, device, 'luna://com.webos.appInstallService/dev/remove', { id, subscribe: true }, (msg) =>
    appinstalldStep(msg, /removed/i, AppsErrorCodes.RemoveFailed, (state) => progress?.({ stage: 'remove', text: state })),
  ).catch((e: RpcError) => {
    if (e.code === LunaErrorCodes.Response) throw new RpcError(AppsErrorCodes.RemoveFailed, e.message, e.detail);
    throw e;
  });
}

/** Homebrew Channel's configuration (getHbChannelConfig in device-manager.service.ts); `installed: false` without it. */
export async function hbChannelConfig(pool: SshRunner, device: DeviceTarget): Promise<{ installed: boolean; root?: boolean }> {
  try {
    const conf = await lunaCall(pool, device, 'luna://org.webosbrew.hbchannel.service/getConfiguration', {});
    return { installed: true, ...(typeof conf.root === 'boolean' ? { root: conf.root } : {}) };
  } catch (e) {
    if (e instanceof RpcError && e.code === LunaErrorCodes.ServiceNotFound) return { installed: false, root: false };
    return { installed: false };
  }
}

async function hasHbChannel(pool: SshRunner, device: DeviceTarget): Promise<boolean> {
  return (await hbChannelConfig(pool, device)).installed;
}

/**
 * A failure Homebrew Channel reported. `installer` marks the one the original treats as final (InstallError in
 * app-manager.service.ts: "-5: FAILED_IPKG_INSTALL", out of space); any other failure may be retried with the
 * dev install.
 */
class HbInstallError extends RpcError {
  constructor(code: string, message: string, detail: string, readonly installer: boolean) {
    super(code, message, detail);
  }
}

/** Copy the IPK to the developer partition and run appinstalld's dev install (tempDownloadIpk + devInstall). */
async function devInstall(pool: SshRunner, device: DeviceTarget, data: Buffer, sha256: string, progress?: Progress) {
  await mkdirp(pool, device, TEMP_IPK_DIR, 0o777);
  const path = `${TEMP_IPK_DIR}/devman_dl_${Date.now()}_${sha256.slice(0, 8)}.ipk`;
  try {
    progress?.({ stage: 'upload', percent: 0, text: 'Sending IPK to the TV…' });
    let last = -1;
    await putFile(pool, device, path, data, (sent) => {
      const pct = Math.floor((sent / data.length) * 100);
      if (pct !== last) {
        last = pct;
        progress?.({ stage: 'upload', percent: pct, text: 'Sending IPK to the TV…' });
      }
    });
    progress?.({ stage: 'verify', text: 'Checking the upload…' });
    const remoteSum = await sha256sum(pool, device, path);
    if (remoteSum !== null && remoteSum !== sha256) {
      throw new RpcError(AppsErrorCodes.ChecksumMismatch, 'The IPK was damaged while copying it to the TV. Try again.', `expected ${sha256}, got ${remoteSum}`);
    }
    progress?.({ stage: 'install', text: 'Installing…' });
    return await lunaSubscribe(
      pool,
      device,
      'luna://com.webos.appInstallService/dev/install',
      { id: 'com.ares.defaultName', ipkUrl: path, subscribe: true },
      (msg) =>
        appinstalldStep(msg, /installed/i, AppsErrorCodes.InstallFailed, (state) =>
          progress?.({ stage: 'install', percent: percentOf(msg, state), text: state.replace(/^installing\s*:\s*/i, 'Installing ') }),
        ),
    ).catch((e: RpcError) => {
      if (e.code === LunaErrorCodes.Response) throw new RpcError(AppsErrorCodes.InstallFailed, e.message, e.detail);
      throw e;
    });
  } finally {
    progress?.({ stage: 'cleanup', text: 'Cleaning up…' });
    await rmFile(pool, device, path).catch(() => {});
  }
}

/** Homebrew Channel install from a URL served over a reverse tunnel (hbChannelInstall + serveLocal). */
async function hbInstall(pool: SshRunner, device: DeviceTarget, name: string, data: Buffer, sha256: string, progress?: Progress) {
  const served = await serveToDevice(pool, device, name, data);
  return pool.traceOp(device, 'tunnel', `serve ${name} to the TV at ${served.url} (SSH reverse tunnel)`, () =>
    hbInstallVia(pool, device, served, sha256, progress),
  );
}

async function hbInstallVia(
  pool: SshRunner,
  device: DeviceTarget,
  served: Awaited<ReturnType<typeof serveToDevice>>,
  sha256: string,
  progress?: Progress,
) {
  try {
    await hbInstallUrl(pool, device, served.url, sha256, 'Sending IPK to the TV…', progress);
  } finally {
    await served.close().catch(() => {});
  }
}

/** `hbchannel.service/install` from a URL the TV downloads itself (hbChannelInstall in app-manager.service.ts). */
async function hbInstallUrl(
  pool: SshRunner,
  device: DeviceTarget,
  ipkUrl: string,
  sha256: string | undefined,
  downloadText: string,
  progress?: Progress,
) {
  progress?.({ stage: 'install', text: 'Homebrew Channel is installing…' });
  await lunaSubscribe(
    pool,
    device,
    'luna://org.webosbrew.hbchannel.service/install',
    { ipkUrl, ...(sha256 ? { ipkHash: sha256 } : {}), subscribe: true },
    (msg): SubscriptionStep<true> => {
      if (msg.returnValue === false) {
        const text = typeof msg.errorText === 'string' ? msg.errorText : 'Homebrew Channel could not install the app.';
        const m = /(-?\d+): +(\w+)/.exec(text);
        if (m?.[2] === 'FAILED_IPKG_INSTALL' && m[1] === '-5') {
          throw new HbInstallError(AppsErrorCodes.InsufficientSpace, "Can't install because there isn't enough free space on the TV.", text, true);
        }
        throw new HbInstallError(AppsErrorCodes.InstallFailed, text, JSON.stringify(msg), false);
      }
      if (msg.finished) return { done: true };
      // Updating Homebrew Channel itself: the service forks the update and exits without `finished`.
      if (msg.statusText === 'Self-update') return { done: true };
      if (msg.subscribed === false && msg.returnValue) return { done: true };
      const status = typeof msg.statusText === 'string' ? msg.statusText : undefined;
      const stage = status && /download/i.test(status) ? 'upload' : status && /verif/i.test(status) ? 'verify' : 'install';
      progress?.({
        stage,
        percent: typeof msg.progress === 'number' ? Math.max(0, Math.min(100, msg.progress)) : undefined,
        text: status === 'Downloading…' ? downloadText : status,
      });
      return undefined;
    },
  );
}

/**
 * Install an IPK held in memory. Like installByPath in app-manager.service.ts: Homebrew Channel's installer
 * when present (keeps root on rooted TVs), else appinstalld's dev install. If the TV refuses the tunnel the
 * Homebrew Channel path needs, falls back to the dev install.
 */
export async function installIpk(
  pool: SshRunner,
  device: DeviceTarget,
  name: string,
  data: Buffer,
  progress?: Progress,
): Promise<{ appId?: string; via: 'devmode' | 'hbchannel' }> {
  const sha256 = createHash('sha256').update(data).digest('hex');
  // Homebrew Channel doesn't say what it installed, so read the id from the package itself.
  const packageId = readIpkControl(data)?.Package;
  if (await hasHbChannel(pool, device)) {
    try {
      await hbInstall(pool, device, name, data, sha256, progress);
      return { appId: packageId, via: 'hbchannel' };
    } catch (e) {
      const tunnelRefused = e instanceof RpcError && e.code === AppsErrorCodes.TransferFailed && /tunnel/.test(e.message);
      if (!tunnelRefused) throw e;
    }
  }
  const appId = await devInstall(pool, device, data, sha256, progress);
  return { appId: appId || packageId, via: 'devmode' };
}

/**
 * Where an app with this id is installed, if anywhere (findInstallLocation in app-manager.service.ts):
 * the developer partition, cryptofs (LG Content Store) or the system image.
 */
export async function findInstallLocation(pool: SshRunner, device: DeviceTarget, id: string): Promise<'developer' | 'cryptofs' | 'system' | null> {
  if (device.username === 'root') {
    return lunaCall(pool, device, 'luna://com.webos.service.applicationManager/getAppInfo', { id }, false, true)
      .then((r) => {
        const info = (r.appInfo ?? {}) as { folderPath?: unknown; systemApp?: unknown };
        if (info.systemApp === true) return 'system' as const;
        // No folder path: unknown (the original fails here and treats it as not installed).
        if (typeof info.folderPath !== 'string') return null;
        return info.folderPath.startsWith('/media/developer/') ? ('developer' as const) : ('cryptofs' as const);
      })
      .catch(() => null);
  }
  const apps = await listApps(pool, device);
  if (apps.some((a) => a.id === id)) return 'developer';
  // The original launches the app when getAppLoadStatus is missing (old webOS); we don't start apps as a probe.
  const status = await lunaCall(pool, device, 'luna://com.webos.service.applicationManager/getAppLoadStatus', { appId: id }, true, true).catch(
    () => ({ exist: false }) as Record<string, unknown>,
  );
  return status.exist === true ? 'cryptofs' : null;
}

/**
 * Install or update an app from the Homebrew repository (installPackage in apps.component.ts +
 * installByManifest in app-manager.service.ts): refuse if the id belongs to a store/system app; with Homebrew
 * Channel let the TV download the IPK (falling back to the dev install unless the installer itself failed, or the
 * app is Homebrew Channel); otherwise download it here, check the sha256 and dev install.
 */
export async function installFromRepo(
  pool: SshRunner,
  repo: RepoClient,
  device: DeviceTarget,
  id: string,
  channel: 'stable' | 'beta',
  progress?: Progress,
  trace?: HttpTrace,
): Promise<{ appId: string; version: string; via: 'devmode' | 'hbchannel' }> {
  const pkg = await repo.get(id, trace);
  const manifest = channel === 'beta' ? pkg.manifestBeta : pkg.manifest;
  if (!manifest) {
    throw new RpcError(RepoErrorCodes.NoManifest, `${pkg.title} has no ${channel === 'beta' ? 'beta' : 'release'} to install.`);
  }
  const location = await findInstallLocation(pool, device, pkg.id).catch(() => null);
  if (location && location !== 'developer') {
    throw new RpcError(
      AppsErrorCodes.Conflict,
      location === 'system'
        ? `${pkg.title} can't be installed: a built-in app with the same id (${pkg.id}) is on the TV.`
        : `Another app with the same id (${pkg.id}) is already installed. If it came from the LG Content Store, uninstall it first.`,
    );
  }
  if (await hasHbChannel(pool, device)) {
    try {
      await hbInstallUrl(pool, device, manifest.ipkUrl, manifest.ipkHash?.sha256, 'The TV is downloading the IPK…', progress);
      return { appId: pkg.id, version: manifest.version, via: 'hbchannel' };
    } catch (e) {
      // Like installByManifest: retry with the dev install unless the installer ran out of space, and never for
      // Homebrew Channel itself.
      if ((e instanceof HbInstallError && e.installer) || pkg.id === APP_ID_HBCHANNEL) throw e;
    }
  }
  progress?.({ stage: 'upload', text: 'Downloading the IPK…' });
  const { data, sha256, done } = await repo.download(manifest, progress, trace);
  try {
    const appId = await devInstall(pool, device, data, sha256, progress);
    return { appId: appId || pkg.id, version: manifest.version, via: 'devmode' };
  } finally {
    done();
  }
}
