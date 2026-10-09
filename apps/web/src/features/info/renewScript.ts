import type { SavedDevice } from '../../devices/store';
import { isValidHost, isValidUsername } from '../../devices/validate';

/** LG's renew endpoint (what the Developer Mode app calls). Always the real one, even when the bridge is tested. */
export const resetUrl = (token: string) => `https://developer.lge.com/secure/ResetDevModeSession.dev?sessionToken=${encodeURIComponent(token)}`;

/** Single-quote a value for sh. */
const q = (v: string) => `'${v.replace(/'/g, `'\\''`)}'`;
/** A name that is safe in a temp file name. */
const slug = (v: string) => v.replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'tv';

/**
 * The original's renew script (src/app/info/renew-script/renew-script.sh.ts), filled in for one TV: it logs in
 * with the TV's key, reads the session token and asks LG to reset the session. Values are shell-quoted here
 * (the original pasted them in raw).
 */
/** A PEM / OpenSSH private key and nothing else — so it can't smuggle commands past the heredoc. */
const KEY_SHAPE = /^-----BEGIN [A-Z0-9 ]+-----\n[A-Za-z0-9+/=:,\- \n]+\n-----END [A-Z0-9 ]+-----$/;

/**
 * The address and user name as ssh should get them, or null if either could be mistaken for an ssh option or
 * isn't something the add / edit forms would accept (the script passes them after -l / --, but refuses anyway).
 */
function sshTarget(device: Pick<SavedDevice, 'host' | 'port' | 'username'>): { host: string; port: number; username: string } | null {
  const { host, port, username } = device;
  if (!isValidUsername(username) || !isValidHost(host) || host.startsWith('-')) return null;
  if (!Number.isInteger(port) || port < 1 || port > 65535) return null;
  // ssh wants IPv6 addresses without brackets.
  return { host: host.replace(/^\[(.*)\]$/, '$1'), port, username };
}

/** Stands in for the key / passphrase in the on-screen copy of the script (`redact`). */
export const HIDDEN_KEY = '[private key hidden]';
export const HIDDEN_PASSPHRASE = '[passphrase hidden]';

/**
 * `redact` gives the same script with the private key and passphrase replaced by placeholders — what the page
 * shows until the user asks to see the key (screens get shared and recorded). Copy / download use the real one.
 */
export function renewScript(device: SavedDevice, opts: { redact?: boolean } = {}): string | null {
  if (device.auth.kind !== 'key') return null;
  const target = sshTarget(device);
  if (!target) return null;
  const key = device.auth.privateKey.replace(/\r\n?/g, '\n').trim();
  if (!KEY_SHAPE.test(key)) return null;
  const passphrase = opts.redact && device.auth.passphrase ? HIDDEN_PASSPHRASE : (device.auth.passphrase ?? '');
  const keyText = opts.redact ? HIDDEN_KEY : key;
  return `#!/bin/sh
# Renews the webOS Developer Mode session of "${device.name.replace(/[\r\n"]/g, ' ')}".
# Made by LG Dev Manager. Run it on a computer on the same network as the TV, e.g. once a day with cron:
#   15 4 * * * sh /path/to/this/script.sh
# (or make it executable first: chmod 700 /path/to/this/script.sh)
#
# WARNING: this file contains the TV's private SSH key. Keep it private, and don't run it as root.
# If $SESSION_TOKEN_CACHE is a symlink, its target will be overwritten.

DEVICE_NAME=${q(slug(device.name))}
DEVICE_HOST=${q(target.host)}
DEVICE_PORT=${q(String(target.port))}
DEVICE_USERNAME=${q(target.username)}
DEVICE_PASSPHRASE=${q(passphrase)}

umask 077

if ! TEMP_KEY_DIR="$(mktemp -d)"; then
    echo "Failed to create random temporary directory for key; using fallback" >&2
    TEMP_KEY_DIR="/tmp/renew-script.$$"
    if ! mkdir "\${TEMP_KEY_DIR}"; then
        echo "Fallback temporary directory \${TEMP_KEY_DIR} already exists" >&2
        exit 1
    fi
fi

PRIV_KEY_FILE="\${TEMP_KEY_DIR}/webos_privkey_\${DEVICE_NAME}"

cat >"\${PRIV_KEY_FILE}" <<'END_OF_PRIVKEY'
${keyText}
END_OF_PRIVKEY

if [ -n "\${DEVICE_PASSPHRASE}" ]; then
  ssh-keygen -p -P "\${DEVICE_PASSPHRASE}" -N '' -f "\${PRIV_KEY_FILE}" >/dev/null
fi

SESSION_TOKEN=$(ssh -i "\${PRIV_KEY_FILE}" \\
  -o ConnectTimeout=3 -o StrictHostKeyChecking=no \\
  -o HostKeyAlgorithms=+ssh-rsa \\
  -o PubkeyAcceptedKeyTypes=+ssh-rsa \\
  -p "\${DEVICE_PORT}" -l "\${DEVICE_USERNAME}" -- "\${DEVICE_HOST}" \\
  cat /var/luna/preferences/devmode_enabled)

rm -rf "\${TEMP_KEY_DIR}"

SESSION_TOKEN_CACHE="/tmp/webos_devmode_token_\${DEVICE_NAME}.txt"

if [ -z "$SESSION_TOKEN" ]; then
  echo "ssh into TV failed, loading previous SESSION_TOKEN from \${SESSION_TOKEN_CACHE}" >&2
  SESSION_TOKEN=$(cat "\${SESSION_TOKEN_CACHE}")
else
  echo "Got SESSION_TOKEN from TV - writing to \${SESSION_TOKEN_CACHE}" >&2
  echo "$SESSION_TOKEN" >"\${SESSION_TOKEN_CACHE}"
fi

if [ -z "$SESSION_TOKEN" ]; then
  echo "Unable to get token" >&2
  exit 1
fi

CHECK_RESULT=$(curl --max-time 3 -s "https://developer.lge.com/secure/ResetDevModeSession.dev?sessionToken=$SESSION_TOKEN")

echo "\${CHECK_RESULT}"
`;
}

/** "742:15:03" → milliseconds. Null if it isn't that shape (devmode-countdown.pipe.ts). */
export function parseRemaining(v: string | undefined): number | null {
  const m = /^(\d+):(\d+):(\d+)$/.exec(v ?? '');
  if (!m) return null;
  return ((Number(m[1]) * 60 + Number(m[2])) * 60 + Number(m[3])) * 1000;
}

export function fmtCountdown(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${pad(Math.floor(s / 3600))}:${pad(Math.floor((s % 3600) / 60))}:${pad(s % 60)}`;
}
