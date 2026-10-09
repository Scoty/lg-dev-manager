import { createHash } from 'node:crypto';
import ssh2 from 'ssh2';

// ssh2 is CommonJS: use the default export under native Node ESM.
const { utils } = ssh2;
import { DeviceErrorCodes } from '@lgdm/protocol';
import { RpcError } from '../rpc/errors.js';

export interface KeyInfo {
  fingerprint: string;
  type: string;
}

/**
 * Parse a private key with an optional passphrase. Mirrors `key_verify` / `novacom_getkey` in
 * dev-manager-desktop (src-tauri/src/device_manager/manager.rs): an empty passphrase on an encrypted key
 * is `passphrase_required`, a wrong one is `bad_passphrase`.
 */
export function verifyKey(privateKey: string, passphrase?: string): KeyInfo {
  const parsed = utils.parseKey(privateKey, passphrase || undefined);
  const key = Array.isArray(parsed) ? parsed[0] : parsed;
  if (!key || key instanceof Error) {
    const msg = key instanceof Error ? key.message : '';
    if (/no passphrase given/i.test(msg)) {
      throw new RpcError(DeviceErrorCodes.PassphraseRequired, 'This key is protected. Enter the passphrase shown in the Developer Mode app.');
    }
    if (/passphrase/i.test(msg) || /encrypted/i.test(msg)) {
      throw new RpcError(DeviceErrorCodes.BadPassphrase, 'The passphrase is not correct. It is case-sensitive.');
    }
    throw new RpcError(DeviceErrorCodes.BadKey, 'This does not look like a private key.');
  }
  const hash = createHash('sha256').update(key.getPublicSSH()).digest('base64').replace(/=+$/, '');
  return { fingerprint: `SHA256:${hash}`, type: key.type };
}
