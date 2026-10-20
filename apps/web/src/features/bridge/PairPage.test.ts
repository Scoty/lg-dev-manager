import { describe, expect, it } from 'vitest';
import { readPairLink } from './PairPage';

describe('pairing links', () => {
  it('read the token, and a port only when it is one', () => {
    expect(readPairLink('?token=abc_DEF-1')).toEqual({ token: 'abc_DEF-1', port: undefined });
    expect(readPairLink('?token=abc&port=5200')).toEqual({ token: 'abc', port: 5200 });
    expect(readPairLink('?token=abc&port=99999')).toEqual({ token: 'abc', port: undefined });
    expect(readPairLink('?token=abc&port=ws://evil')).toEqual({ token: 'abc', port: undefined });
    expect(readPairLink('?token=')).toBeNull();
    expect(readPairLink('')).toBeNull();
    expect(readPairLink(`?token=${'x'.repeat(600)}`)).toBeNull();
  });
});
