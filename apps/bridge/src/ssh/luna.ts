import { DeviceErrorCodes, LunaErrorCodes, type DeviceTarget } from '@lgdm/protocol';
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
    const err = lunaFailure(uri, typed);
    if (err.code !== LunaErrorCodes.Response || falseAsError) throw err;
  }
  return typed;
}

/** Map a `returnValue: false` payload to a typed error (LunaUnknownMethodError etc. in remote-luna.service.ts). */
export function lunaFailure(uri: string, typed: Record<string, unknown>): RpcError {
  const errorText = typeof typed.errorText === 'string' ? typed.errorText : '';
  const detail = JSON.stringify(typed);
  if (errorText.startsWith('Unknown method')) return new RpcError(LunaErrorCodes.UnknownMethod, errorText, detail);
  if (errorText.startsWith('Service does not exist')) return new RpcError(LunaErrorCodes.ServiceNotFound, errorText, detail);
  return new RpcError(LunaErrorCodes.Response, errorText || `${uri} returned an error.`, detail);
}

/**
 * What a subscription handler says about each message: keep listening (`undefined`), finish with a value,
 * or fail by throwing.
 */
export type SubscriptionStep<T> = undefined | { done: T };

/**
 * `luna-send -i` subscription (RemoteLunaService.subscribe). Each output line is one JSON response.
 * `onMessage` decides when it's finished; the channel is then closed (the original's unsubscribe).
 * `returnValue: false` messages fail the subscription unless `onMessage` handles them first.
 */
export async function lunaSubscribe<T>(
  pool: SshPool,
  device: DeviceTarget,
  uri: string,
  params: Record<string, unknown>,
  onMessage: (msg: Record<string, unknown>) => SubscriptionStep<T>,
  opts: { public?: boolean; timeoutMs?: number } = {},
): Promise<T> {
  const cmd = opts.public === false ? 'luna-send' : 'luna-send-pub';
  const ch = await pool.open(device, `${cmd} -i ${uri} ${shellQuote(JSON.stringify(params))}`);
  const { stream } = ch;
  try {
    return await new Promise<T>((resolve, reject) => {
      let buf = '';
      let stderr = '';
      let settled = false;
      const finish = (fn: () => void) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        fn();
      };
      const timer = setTimeout(
        () => finish(() => reject(new RpcError(DeviceErrorCodes.Timeout, `${uri} did not finish in time.`))),
        opts.timeoutMs ?? 600_000,
      );
      stream.stderr.on('data', (c: Buffer) => {
        stderr += c.toString('utf8');
      });
      stream.on('data', (c: Buffer) => {
        buf += c.toString('utf8');
        let nl: number;
        while (!settled && (nl = buf.indexOf('\n')) >= 0) {
          const line = buf.slice(0, nl).trim();
          buf = buf.slice(nl + 1);
          if (!line) continue;
          let msg: Record<string, unknown>;
          try {
            msg = JSON.parse(line);
          } catch {
            finish(() => reject(new RpcError(LunaErrorCodes.BadResponse, `Unexpected response from ${uri}.`, line.slice(0, 4000))));
            return;
          }
          try {
            const step = onMessage(msg);
            if (step) finish(() => resolve(step.done));
            else if (msg.returnValue === false) finish(() => reject(lunaFailure(uri, msg)));
          } catch (e) {
            finish(() => reject(e));
          }
        }
      });
      stream.on('close', (code: number | null) => {
        if (code === 127) {
          finish(() => reject(new RpcError(LunaErrorCodes.Unsupported, `Failed to find command ${cmd}. Is this really a webOS device?`)));
        }
        finish(() =>
          reject(new RpcError(LunaErrorCodes.BadResponse, `${uri} ended without a result.`, (buf || stderr).slice(0, 4000) || undefined)),
        );
      });
    });
  } finally {
    ch.close();
  }
}
