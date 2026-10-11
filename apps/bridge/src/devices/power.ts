import type { DeviceTarget, TvPowerState } from '@lgdm/protocol';
import type { SshRunner } from '../ssh/pool.js';
import { lunaCall } from '../ssh/luna.js';

const GET_POWER_STATE = 'luna://com.webos.service.tvpower/power/getPowerState';
const TURN_ON_SCREEN = 'luna://com.webos.service.tvpower/power/turnOnScreen';

/**
 * What `getPowerState` says, as on / screen off / standby. Same reading as Home Assistant's LG integration
 * (aiowebostv `_is_tv_on`): "Active Standby", "Suspend" and "Power Off" are off; a `processing` field such as
 * "Request Power Off" or "Prepare Suspend" means the TV is on its way there. Not part of the original Dev Manager,
 * which launched apps regardless.
 */
export function powerStateOf(msg: Record<string, unknown>): TvPowerState {
  const state = typeof msg.state === 'string' ? msg.state : '';
  const processing = typeof msg.processing === 'string' ? msg.processing : '';
  if (/power ?off|suspend|standby/i.test(processing)) return 'standby';
  if (state === 'Active' || state === 'Screen Saver') return 'on';
  if (state === 'Screen Off') return 'screenOff';
  if (/standby|suspend|power ?off/i.test(state)) return 'standby';
  return 'unknown';
}

/**
 * The TV's power state. In standby with networking on (LG's Quick Start+ / "Always Ready") the system keeps running:
 * SSH, installs, updates and removals work, but a launched app has no screen. Asks over the public bus first (Dev
 * Mode), then — as root — the private one. Anything unexpected is `unknown`, which callers treat as on.
 */
export async function tvPower(pool: SshRunner, device: DeviceTarget): Promise<{ state: TvPowerState; raw?: string }> {
  for (const pub of device.username === 'root' ? [true, false] : [true]) {
    try {
      const msg = await lunaCall(pool, device, GET_POWER_STATE, {}, pub);
      return { state: powerStateOf(msg), raw: [msg.state, msg.processing].filter((v) => typeof v === 'string').join(' · ') || undefined };
    } catch {
      /* not allowed on this bus or not on this firmware: try the next, else unknown */
    }
  }
  return { state: 'unknown' };
}

/** Picture back on for a TV that is on with its screen turned off. Best effort: some firmware doesn't allow it. */
export async function turnOnScreen(pool: SshRunner, device: DeviceTarget): Promise<boolean> {
  for (const pub of device.username === 'root' ? [true, false] : [true]) {
    try {
      await lunaCall(pool, device, TURN_ON_SCREEN, {}, pub);
      return true;
    } catch {
      /* try the next bus */
    }
  }
  return false;
}
