import { createHash } from 'node:crypto';
import ssh2 from 'ssh2';
import { DeviceErrorCodes, LunaErrorCodes, type DeviceTarget, type ResultOf } from '@lgdm/protocol';
import { RpcError } from '../rpc/errors.js';
import { readFile, rmFile } from '../ssh/transfer.js';
import { lunaCall, shellQuote } from '../ssh/luna.js';
import type { SshRunner } from '../ssh/pool.js';

// ssh2 is CommonJS: use the default export under native Node ESM.
const { utils } = ssh2;

const str = (v: unknown) => (typeof v === 'string' && v.trim() ? v.trim() : undefined);
const omitEmpty = <T extends Record<string, unknown>>(o: T) =>
  Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as T;

/**
 * Port of DeviceManagerService.getDeviceInfo (src/app/core/services/device-manager.service.ts). Each source is
 * optional here: whatever the TV answers is returned, and it only fails if neither system info nor OS info works.
 */
export async function deviceInfo(pool: SshRunner, device: DeviceTarget): Promise<ResultOf<'device.info'>> {
  let systemError: unknown;
  const systemInfo = await lunaCall(
    pool,
    device,
    'luna://com.webos.service.tv.systemproperty/getSystemInfo',
    { keys: ['firmwareVersion', 'modelName', 'sdkVersion', 'otaId'] },
    true,
    false,
  ).catch((e: unknown) => {
    systemError = e;
    return {} as Record<string, unknown>;
  });
  const osInfo = await lunaCall(pool, device, 'luna://com.palm.systemservice/osInfo/query', {
    parameters: ['device_name', 'webos_manufacturing_version', 'webos_release'],
  }).catch(() => null);
  if (systemError && !osInfo) throw systemError;

  let otaId = str(systemInfo.otaId);
  if (!otaId) {
    otaId = await lunaCall(pool, device, 'luna://com.webos.service.sdx/getDeviceUuid', {})
      .then((r) => (typeof r.billingId === 'string' ? (new URLSearchParams(r.billingId).get('modelName') ?? undefined) : undefined))
      .catch(() => undefined);
  }
  let socName = str(osInfo?.device_name);
  if (!socName) {
    socName = await pool
      .exec(device, `cat ${shellQuote('/etc/prefs/properties/machineName')}`, { timeoutMs: 10_000 })
      .then((r) => (r.exitCode === 0 ? str(r.stdout) : undefined))
      .catch(() => undefined);
  }
  return omitEmpty({
    modelName: str(systemInfo.modelName),
    osVersion: str(osInfo?.webos_release) ?? str(systemInfo.sdkVersion),
    firmwareVersion: str(systemInfo.firmwareVersion),
    otaId,
    socName,
  });
}

/**
 * `df` of the developer partition (getStorageInfo in device-manager.service.ts). Parses every number after the
 * header so it copes with df wrapping long filesystem names onto their own line.
 */
export async function storageInfo(pool: SshRunner, device: DeviceTarget, mountPoint = '/media/developer') {
  const res = await pool.exec(device, `df ${shellQuote(mountPoint)}`, { timeoutMs: 15_000 });
  if (res.exitCode !== 0) return null;
  const lines = res.stdout.trim().split('\n').slice(1).join(' ');
  const nums = lines
    .split(/\s+/)
    .filter((s) => /^\d+$/.test(s))
    .map(Number);
  if (nums.length < 3) return null;
  const [total, used, available] = nums as [number, number, number];
  return { total, used, available };
}

/** New ed25519 key pair in OpenSSH format (the original's per-app key, here kept by the browser). */
export function generateKey(comment = 'lg-dev-manager'): ResultOf<'device.generateKey'> {
  const pair = utils.generateKeyPairSync('ed25519', { comment });
  const parsed = utils.parseKey(pair.public);
  const key = Array.isArray(parsed) ? parsed[0] : parsed;
  if (!key || key instanceof Error) throw new Error('Generated key did not parse');
  const fingerprint = `SHA256:${createHash('sha256').update(key.getPublicSSH()).digest('base64').replace(/=+$/, '')}`;
  return { privateKey: pair.private, publicKey: pair.public.trim(), fingerprint };
}

const SCREENSHOT_MAX = 32 * 1024 * 1024;

/**
 * A screenshot (takeScreenshot + legacyScreenshot in device-manager.service.ts): `com.webos.service.capture`, or on
 * older firmware `com.webos.service.tv.capture` — retried at 1920×1080 when it refuses a capture without a size
 * (CAPTURE_ERROR_03). The PNG goes to /tmp, is read back and deleted. Root only, like the original.
 */
export async function takeScreenshot(pool: SshRunner, device: DeviceTarget, method: 'DISPLAY' | 'VIDEO' | 'GRAPHIC' = 'DISPLAY') {
  if (device.username !== 'root') {
    throw new RpcError(DeviceErrorCodes.WrongLogin, 'Screenshots need a rooted TV (logged in as root).');
  }
  const path = `/tmp/devman_shot_${Date.now()}.png`;
  const param: Record<string, unknown> = { path, method, format: 'PNG' };
  try {
    await lunaCall(pool, device, 'luna://com.webos.service.capture/executeOneShot', param, false).catch(async (e: RpcError) => {
      if (e.code !== LunaErrorCodes.ServiceNotFound) throw e;
      const legacy = 'luna://com.webos.service.tv.capture/executeOneShot';
      await lunaCall(pool, device, legacy, param, false).catch((e2: RpcError) => {
        if (/CAPTURE_ERROR_03|size is out of range/i.test(`${e2.message} ${e2.detail ?? ''}`)) {
          return lunaCall(pool, device, legacy, { ...param, width: 1920, height: 1080 }, false);
        }
        throw e2;
      });
    });
    const data = await readFile(pool, device, path, SCREENSHOT_MAX);
    return { mime: 'image/png', base64: data.toString('base64') };
  } finally {
    await rmFile(pool, device, path).catch(() => {});
  }
}
