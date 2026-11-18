import { constants, gunzipSync } from 'node:zlib';

/**
 * When an IPK was packaged, from the first bytes of the file (2.1.0, litefin.installed): ares-package copies the build
 * into a fresh folder and archives it, so every entry of data.tar.gz carries the same time — the moment that build ran.
 * The TV keeps those times when it installs the package, so the installed files say which build they came from.
 *
 * Reads the ar container, inflates the start of data.tar.gz and returns the first tar header's mtime (seconds), or
 * null when `head` isn't the start of such an IPK.
 */
export function ipkBuildTime(head: Buffer): number | null {
  if (head.subarray(0, 8).toString('latin1') !== '!<arch>\n') return null;
  let off = 8;
  while (off + 60 <= head.length) {
    const header = head.subarray(off, off + 60).toString('latin1');
    const name = header.slice(0, 16).trim().replace(/\/$/, '');
    const size = Number.parseInt(header.slice(48, 58).trim(), 10);
    if (!Number.isFinite(size) || size < 0) return null;
    if (name === 'data.tar.gz') return firstTarTime(head.subarray(off + 60, off + 60 + size));
    off += 60 + size + (size % 2);
  }
  return null;
}

function firstTarTime(gz: Buffer): number | null {
  let tar: Buffer;
  try {
    // Only the start of the stream is here: inflate what there is.
    tar = gunzipSync(gz, { finishFlush: constants.Z_SYNC_FLUSH, maxOutputLength: 64 * 1024 });
  } catch {
    return null;
  }
  if (tar.length < 512) return null;
  const h = tar.subarray(0, 512);
  // A real header: its checksum (with the checksum field as spaces) must add up.
  const stored = Number.parseInt(h.subarray(148, 156).toString('latin1').replace(/\0.*$/s, '').trim(), 8);
  let sum = 0;
  for (let i = 0; i < 512; i++) sum += i >= 148 && i < 156 ? 32 : h[i]!;
  if (!Number.isFinite(stored) || stored !== sum) return null;
  const mtime = Number.parseInt(h.subarray(136, 148).toString('latin1').replace(/\0.*$/s, '').trim(), 8);
  return Number.isFinite(mtime) && mtime > 0 ? mtime : null;
}
