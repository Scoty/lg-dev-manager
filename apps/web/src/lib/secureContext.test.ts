import { afterEach, describe, expect, it, vi } from 'vitest';
import { copyText, randomId } from './secureContext';

/** A page a LAN bridge serves over plain HTTP has no crypto.randomUUID and no navigator.clipboard. */
describe('on a plain-HTTP page (LAN mode)', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('still makes random ids', () => {
    const real = crypto.randomUUID;
    Object.defineProperty(crypto, 'randomUUID', { value: undefined, configurable: true });
    try {
      const a = randomId();
      expect(a).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
      expect(randomId()).not.toBe(a);
    } finally {
      Object.defineProperty(crypto, 'randomUUID', { value: real, configurable: true });
    }
  });

  it('still copies, with the older copy command', async () => {
    vi.stubGlobal('navigator', { ...navigator, clipboard: undefined });
    const exec = vi.fn(() => true);
    Object.defineProperty(document, 'execCommand', { value: exec, configurable: true });
    await copyText('ssh-ed25519 AAAA');
    expect(exec).toHaveBeenCalledWith('copy');
    expect(document.querySelector('textarea')).toBeNull(); // cleaned up
    exec.mockReturnValueOnce(false);
    await expect(copyText('x')).rejects.toThrow(/refused/);
  });
});
