import { gunzipSync, gzipSync } from 'node:zlib';

/** Build and read real (if tiny) IPKs: an ar archive with debian-binary, control.tar.gz and data.tar.gz. */

function tar(files: { name: string; data: Buffer }[]): Buffer {
  const parts: Buffer[] = [];
  for (const f of files) {
    const h = Buffer.alloc(512);
    h.write(f.name, 0, 100, 'utf8');
    h.write('0000644\0', 100, 'latin1');
    h.write('0000000\0', 108, 'latin1');
    h.write('0000000\0', 116, 'latin1');
    h.write(`${f.data.length.toString(8).padStart(11, '0')}\0`, 124, 'latin1');
    h.write(`${Math.floor(Date.now() / 1000).toString(8).padStart(11, '0')}\0`, 136, 'latin1');
    h.write('        ', 148, 'latin1');
    h[156] = 48; // '0' regular file
    h.write('ustar\0', 257, 'latin1');
    h.write('00', 263, 'latin1');
    let sum = 0;
    for (const b of h) sum += b;
    h.write(`${sum.toString(8).padStart(6, '0')}\0 `, 148, 'latin1');
    parts.push(h, f.data, Buffer.alloc((512 - (f.data.length % 512)) % 512));
  }
  parts.push(Buffer.alloc(1024));
  return Buffer.concat(parts);
}

function ar(members: { name: string; data: Buffer }[]): Buffer {
  const parts: Buffer[] = [Buffer.from('!<arch>\n', 'latin1')];
  for (const m of members) {
    const header =
      m.name.padEnd(16) + '0'.padEnd(12) + '0'.padEnd(6) + '0'.padEnd(6) + '100644'.padEnd(8) + String(m.data.length).padEnd(10) + '`\n';
    parts.push(Buffer.from(header, 'latin1'), m.data);
    if (m.data.length % 2) parts.push(Buffer.from('\n'));
  }
  return Buffer.concat(parts);
}

/** A minimal IPK for `id`. `padBytes` adds payload so transfers have something to show progress for. */
export function fakeIpk(id: string, version = '1.0.0', title = id, padBytes = 0): Buffer {
  const control = `Package: ${id}\nVersion: ${version}\nSection: misc\nPriority: optional\nArchitecture: all\nDescription: ${title}\n`;
  return ar([
    { name: 'debian-binary', data: Buffer.from('2.0\n') },
    { name: 'control.tar.gz', data: gzipSync(tar([{ name: './control', data: Buffer.from(control) }])) },
    { name: 'data.tar.gz', data: gzipSync(tar([{ name: './payload.bin', data: Buffer.alloc(padBytes, 0x2e) }])) },
  ]);
}

/** Read Package / Version / Description the way opkg would. Null if it isn't an IPK. */
export function readControl(data: Buffer): { id: string; version: string; title?: string } | null {
  try {
    if (data.subarray(0, 8).toString('latin1') !== '!<arch>\n') return null;
    let off = 8;
    while (off + 60 <= data.length) {
      const header = data.subarray(off, off + 60).toString('latin1');
      const name = header.slice(0, 16).trim().replace(/\/$/, '');
      const size = Number.parseInt(header.slice(48, 58).trim(), 10);
      if (name === 'control.tar.gz') {
        const t = gunzipSync(data.subarray(off + 60, off + 60 + size));
        const fileSize = Number.parseInt(t.subarray(124, 136).toString('latin1').replace(/\0.*$/s, '').trim(), 8);
        const text = t.subarray(512, 512 + fileSize).toString('utf8');
        const id = /^Package:\s*([\w.-]+)\s*$/m.exec(text)?.[1];
        if (!id) return null;
        return {
          id,
          version: /^Version:\s*(\S+)\s*$/m.exec(text)?.[1] ?? '1.0.0',
          title: /^Description:\s*(.+?)\s*$/m.exec(text)?.[1],
        };
      }
      off += 60 + size + (size % 2);
    }
  } catch {
    /* not an IPK */
  }
  return null;
}
