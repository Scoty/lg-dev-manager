// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { crc32, zip } from './zip';

describe('zip', () => {
  it('computes the standard CRC-32', () => {
    expect(crc32(new TextEncoder().encode('123456789'))).toBe(0xcbf43926);
  });

  it('writes stored entries that can be read back', async () => {
    const a = new TextEncoder().encode('hello');
    const b = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0, 1, 2, 3]);
    const blob = zip([
      { name: 'a.txt', data: a, date: new Date(2026, 9, 9, 17, 35, 52) },
      { name: 'shot-1.png', data: b },
    ]);
    const buf = new Uint8Array(await blob.arrayBuffer());
    const v = new DataView(buf.buffer);
    // End of central directory: 2 entries, central directory right after the data.
    const end = buf.length - 22;
    expect(v.getUint32(end, true)).toBe(0x06054b50);
    expect(v.getUint16(end + 10, true)).toBe(2);
    const cdOffset = v.getUint32(end + 16, true);
    expect(cdOffset).toBe(30 + 5 + 5 + 30 + 10 + 8);
    // Walk the central directory and read each file through its local header.
    const out: Record<string, number[]> = {};
    let p = cdOffset;
    for (let i = 0; i < 2; i++) {
      expect(v.getUint32(p, true)).toBe(0x02014b50);
      const size = v.getUint32(p + 20, true);
      const nameLen = v.getUint16(p + 28, true);
      const local = v.getUint32(p + 42, true);
      const name = new TextDecoder().decode(buf.subarray(p + 46, p + 46 + nameLen));
      expect(v.getUint32(local, true)).toBe(0x04034b50);
      const start = local + 30 + v.getUint16(local + 26, true);
      const data = buf.subarray(start, start + size);
      expect(v.getUint32(local + 14, true)).toBe(crc32(data));
      out[name] = [...data];
      p += 46 + nameLen;
    }
    expect(out).toEqual({ 'a.txt': [...a], 'shot-1.png': [...b] });
  });
});
