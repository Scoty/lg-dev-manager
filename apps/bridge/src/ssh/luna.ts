import { DeviceErrorCodes, LunaErrorCodes, type DeviceTarget } from '@lgdm/protocol';
import { RpcError } from '../rpc/errors.js';
import type { SshRunner } from './pool.js';

/** Single-quote a string for a POSIX shell (escapeSingleQuoteString in dev-manager-desktop). */
export function shellQuote(value: string): string {
  return value
    .split("'")
    .map((s) => `'${s}'`)
    .join("\\'");
}

/**
 * The JSON response in luna-send's output. Usually the whole output; tolerates stray lines around it (warnings,
 * shell noise) by taking the last line that is a JSON object.
 */
export function parseLunaOutput(stdout: string): Record<string, unknown> | null {
  const whole = stdout.trim();
  const tryParse = (s: string) => {
    try {
      const v = JSON.parse(s) as unknown;
      return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
    } catch {
      return null;
    }
  };
  if (!whole) return null;
  const all = tryParse(whole);
  if (all) return all;
  const lines = whole.split('\n').map((l) => l.trim());
  for (let i = lines.length - 1; i >= 0; i--) {
    if (lines[i]!.startsWith('{')) {
      const v = tryParse(lines[i]!);
      if (v) return v;
    }
  }
  return null;
}

/** Everything the TV said, for the error's "Technical details". */
const describeRun = (cmd: string, r: { exitCode: number | null; stdout: string; stderr: string }) =>
  [
    `${cmd}: exit code ${r.exitCode ?? 'none'}`,
    `stdout: ${r.stdout.trim() ? r.stdout.trim().slice(0, 2000) : '(empty)'}`,
    `stderr: ${r.stderr.trim() ? r.stderr.trim().slice(0, 2000) : '(empty)'}`,
  ].join('\n');

/**
 * One-shot luna call over SSH. Port of RemoteLunaService.call (src/app/core/services/remote-luna.service.ts):
 * `luna-send-pub -n 1 <uri> '<json>'`, exit 127 → unsupported, returnValue:false → typed errors.
 * On rooted TVs, if luna-send-pub gives no usable answer, retries with `luna-send` (the private bus, which
 * Homebrew Channel itself uses as root).
 */
export async function lunaCall(
  pool: SshRunner,
  device: DeviceTarget,
  uri: string,
  params: Record<string, unknown> = {},
  pub = true,
  falseAsError = true,
): Promise<Record<string, unknown>> {
  const run = (cmd: string) => pool.exec(device, `${cmd} -n 1 ${uri} ${shellQuote(JSON.stringify(params))}`, { timeoutMs: 60_000 });
  let cmd = pub ? 'luna-send-pub' : 'luna-send';
  let res = await run(cmd);
  let typed = parseLunaOutput(res.stdout);
  const runs = [describeRun(cmd, res)];
  if (!typed && pub && device.username === 'root') {
    cmd = 'luna-send';
    res = await run(cmd);
    typed = parseLunaOutput(res.stdout);
    runs.push(describeRun(cmd, res));
  }
  if (!typed && res.exitCode === 127) {
    throw new RpcError(LunaErrorCodes.Unsupported, `Failed to find command ${cmd}. Is this really a webOS device?`, runs.join('\n\n'));
  }
  if (!typed) {
    throw new RpcError(LunaErrorCodes.BadResponse, `Unexpected response from ${uri}.`, runs.join('\n\n'));
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
  pool: SshRunner,
  device: DeviceTarget,
  uri: string,
  params: Record<string, unknown>,
  onMessage: (msg: Record<string, unknown>) => SubscriptionStep<T>,
  opts: { public?: boolean; timeoutMs?: number } = {},
): Promise<T> {
  try {
    return await subscribeOnce(pool, device, uri, params, onMessage, opts);
  } catch (e) {
    // Same quirk as lunaCall: on a rooted TV whose luna-send-pub says nothing at all, use luna-send.
    const silent = e instanceof RpcError && e.code === LunaErrorCodes.BadResponse && (e as RpcError & { silent?: boolean }).silent;
    if (silent && opts.public !== false && device.username === 'root') {
      return subscribeOnce(pool, device, uri, params, onMessage, { ...opts, public: false });
    }
    throw e;
  }
}

async function subscribeOnce<T>(
  pool: SshRunner,
  device: DeviceTarget,
  uri: string,
  params: Record<string, unknown>,
  onMessage: (msg: Record<string, unknown>) => SubscriptionStep<T>,
  opts: { public?: boolean; timeoutMs?: number },
): Promise<T> {
  const cmd = opts.public === false ? 'luna-send' : 'luna-send-pub';
  const ch = await pool.open(device, `${cmd} -i ${uri} ${shellQuote(JSON.stringify(params))}`);
  const { stream } = ch;
  try {
    return await new Promise<T>((resolve, reject) => {
      let buf = '';
      let stderr = '';
      let settled = false;
      let gotMessage = false;
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
          gotMessage = true;
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
        finish(() => {
          const err = new RpcError(
            LunaErrorCodes.BadResponse,
            `${uri} ended without a result.`,
            describeRun(cmd, { exitCode: code, stdout: buf, stderr }),
          ) as RpcError & { silent?: boolean };
          err.silent = !gotMessage && !buf.trim() && !stderr.trim();
          reject(err);
        });
      });
    });
  } finally {
    ch.close();
  }
}
