import { LunaErrorCodes, type DeviceTarget } from '@lgdm/protocol';
import { RpcError } from '../rpc/errors.js';
import type { SshPool } from './pool.js';

/** Single-quote a string for a POSIX shell (escapeSingleQuoteString in dev-manager-desktop). */
export function shellQuote(value: string): string {
  return value
    .split("'")
    .map((s) => `'${s}'`)
    .join("\\'");
}

/**
 * One-shot luna call over SSH. Port of RemoteLunaService.call (src/app/core/services/remote-luna.service.ts):
 * `luna-send-pub -n 1 <uri> '<json>'`, exit 127 → unsupported, returnValue:false → typed errors.
 */
export async function lunaCall(
  pool: SshPool,
  device: DeviceTarget,
  uri: string,
  params: Record<string, unknown> = {},
  pub = true,
  falseAsError = true,
): Promise<Record<string, unknown>> {
  const cmd = pub ? 'luna-send-pub' : 'luna-send';
  const res = await pool.exec(device, `${cmd} -n 1 ${uri} ${shellQuote(JSON.stringify(params))}`, { timeoutMs: 60_000 });
  if (res.exitCode === 127) {
    throw new RpcError(LunaErrorCodes.Unsupported, `Failed to find command ${cmd}. Is this really a webOS device?`);
  }
  let typed: Record<string, unknown>;
  try {
    typed = JSON.parse(res.stdout.trim());
  } catch {
    throw new RpcError(LunaErrorCodes.BadResponse, `Unexpected response from ${uri}.`, (res.stdout || res.stderr).slice(0, 4000));
  }
  if (typed.returnValue === false) {
    const errorText = typeof typed.errorText === 'string' ? typed.errorText : '';
    const detail = JSON.stringify(typed);
    if (errorText.startsWith('Unknown method')) throw new RpcError(LunaErrorCodes.UnknownMethod, errorText, detail);
    if (errorText.startsWith('Service does not exist')) throw new RpcError(LunaErrorCodes.ServiceNotFound, errorText, detail);
    if (falseAsError) throw new RpcError(LunaErrorCodes.Response, errorText || `${uri} returned an error.`, detail);
  }
  return typed;
}
