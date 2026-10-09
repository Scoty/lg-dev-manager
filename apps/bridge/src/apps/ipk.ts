import { gunzipSync } from 'node:zlib';

/**
 * Read the control fields of an IPK (an `ar` archive holding debian-binary, control.tar.gz and data.tar.gz),
 * so the bridge knows which app it is installing even when the installer doesn't say.
 * Returns null for anything that isn't a well-formed IPK; installing then proceeds without the id.
 */
export function readIpkControl(ipk: Buffer): Record<string, string> | null {
  try {
    const control = arMember(ipk, /^control\.tar\.gz\/?$/);
    if (!control) return null;
    const file = tarMember(gunzipSync(control, { maxOutputLength: 4 * 1024 * 1024 }), /^(\.\/)?control$/);
    if (!file) return null;
    const fields: Record<string, string> = {};
    for (const line of file.toString('utf8').split('\n')) {
      const m = /^([A-Za-z][\w-]*):\s*(.*?)\s*$/.exec(line);
      if (m) fields[m[1]!] = m[2]!;
    }
    return fields.Package ? fields : null;
  } catch {
    return null;
  }
}

function arMember(buf: Buffer, name: RegExp): Buffer | null {
  if (buf.subarray(0, 8).toString('latin1') !== '!<arch>\n') return null;
  let off = 8;
  while (off + 60 <= buf.length) {
    const header = buf.subarray(off, off + 60).toString('latin1');
    if (header.slice(58, 60) !== '`\n') return null;
    const member = header.slice(0, 16).trim();
    const size = Number.parseInt(header.slice(48, 58).trim(), 10);
    if (!Number.isFinite(size) || size < 0) return null;
    const start = off + 60;
    if (name.test(member)) return buf.subarray(start, start + size);
    off = start + size + (size % 2);
  }
  return null;
}

function tarMember(buf: Buffer, name: RegExp): Buffer | null {
  let off = 0;
  while (off + 512 <= buf.length) {
    const header = buf.subarray(off, off + 512);
    if (header.every((b) => b === 0)) return null;
    const entry = header.subarray(0, 100).toString('utf8').replace(/\0.*$/s, '');
    const size = Number.parseInt(header.subarray(124, 136).toString('latin1').replace(/\0.*$/s, '').trim() || '0', 8);
    const type = String.fromCharCode(header[156] ?? 48);
    const start = off + 512;
    if ((type === '0' || type === '\0') && name.test(entry)) return buf.subarray(start, start + size);
    off = start + Math.ceil(size / 512) * 512;
  }
  return null;
}
