import { DeviceErrorCodes, FilesErrorCodes, type DeviceTarget, type ResultOf } from '@lgdm/protocol';
import { RpcError } from '../rpc/errors.js';
import { lunaCall } from '../ssh/luna.js';
import type { SshRunner } from '../ssh/pool.js';
import { readFile } from '../ssh/transfer.js';
import type { HttpTrace } from '../repo/repo.js';

/**
 * Developer Mode session (port of src-tauri/src/plugins/devmode.rs and DeviceManagerService.extendDevMode).
 * The token gives control over the TV's Dev Mode session, so it is read without console output and the
 * console only ever sees the LG URL with the token blanked out.
 */

export const DEFAULT_LGE_URL = 'https://developer.lge.com/secure';
const TOKEN_FILE = '/var/luna/preferences/devmode_enabled';

const devModeOnly = (device: DeviceTarget) => {
  if (device.username !== 'prisoner') {
    throw new RpcError(DeviceErrorCodes.WrongLogin, 'The Developer Mode session only applies to Developer Mode logins (prisoner).');
  }
};

/** The session token, or null if the TV has none (valid_token: letters and digits only). */
export async function devModeToken(pool: SshRunner, device: DeviceTarget): Promise<string | null> {
  devModeOnly(device);
  const data = await readFile(pool, device, TOKEN_FILE, 4096).catch((e: RpcError) => {
    if (e.code === DeviceErrorCodes.CommandFailed || e.code === FilesErrorCodes.NotFound) return null;
    throw e;
  });
  const token = data?.toString('utf8').trim() ?? '';
  return /^[0-9a-zA-Z]+$/.test(token) ? token : null;
}

/** Time left on the session, from LG's CheckDevModeSession service. */
export async function devModeStatus(
  pool: SshRunner,
  device: DeviceTarget,
  lgeUrl: string = DEFAULT_LGE_URL,
  trace: HttpTrace = (_t, _c, fn) => fn(),
): Promise<ResultOf<'devmode.status'>> {
  const token = await devModeToken(pool, device);
  if (!token) return {};
  const base = lgeUrl.replace(/\/+$/, '');
  const url = `${base}/CheckDevModeSession.dev?sessionToken=${encodeURIComponent(token)}`;
  const redacted = `GET ${base}/CheckDevModeSession.dev?sessionToken=…`;
  try {
    const res = await trace(new URL(base).host, redacted, async () => {
      const r = await fetch(url, { signal: AbortSignal.timeout(15_000), headers: { accept: 'application/json' } });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      return (await r.json()) as { result?: unknown; errorCode?: unknown; errorMsg?: unknown };
    });
    if (res.result === 'success' && typeof res.errorMsg === 'string') return { token, remaining: res.errorMsg };
    const msg = typeof res.errorMsg === 'string' && res.errorMsg ? res.errorMsg : `LG answered “${String(res.result ?? 'unknown')}”.`;
    return { token, problem: msg };
  } catch (e) {
    return { token, problem: `Couldn’t ask LG’s server how long is left (${(e as Error).message}).` };
  }
}

/** Renew: launch the Developer Mode app with `{ extend: true }`, as the original does. */
export async function renewDevMode(pool: SshRunner, device: DeviceTarget): Promise<void> {
  devModeOnly(device);
  await lunaCall(pool, device, 'luna://com.webos.applicationManager/launch', { id: 'com.palmdts.devmode', subscribe: false, params: { extend: true } }, true);
}
