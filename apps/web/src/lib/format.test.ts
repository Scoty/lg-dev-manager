import { describe, expect, it } from 'vitest';
import { count, fmtBytes, fmtKilobytes } from './format';

describe('format', () => {
  it('sizes, in powers of 1024', () => {
    expect(fmtBytes(512)).toBe('512 B');
    expect(fmtBytes(1536)).toBe('1.5 KB');
    expect(fmtBytes(120 * 1024)).toBe('120 KB');
    expect(fmtBytes(5 * 1024 ** 2)).toBe('5.0 MB');
    expect(fmtBytes(1.25 * 1024 ** 3)).toBe('1.3 GB');
    expect(fmtKilobytes(2048)).toBe('2.0 MB');
  });

  it('counted nouns', () => {
    expect(count(1, 'TV')).toBe('1 TV');
    expect(count(3, 'TV')).toBe('3 TVs');
    expect(count(0, 'custom repository', 'custom repositories')).toBe('0 custom repositories');
  });
});
