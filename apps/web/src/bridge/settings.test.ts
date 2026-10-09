import { describe, expect, it } from 'vitest';
import { defaultBridgeUrl } from './settings';

describe('defaultBridgeUrl', () => {
  it('uses localhost bridge from the public site', () => {
    expect(defaultBridgeUrl({ protocol: 'https:', host: 'lg.scoty.uk', hostname: 'lg.scoty.uk' })).toBe(
      'ws://127.0.0.1:5199/rpc',
    );
  });
  it('uses localhost bridge from the Vite dev server', () => {
    expect(defaultBridgeUrl({ protocol: 'http:', host: 'localhost:5173', hostname: 'localhost' })).toBe('ws://127.0.0.1:5199/rpc');
  });
  it('uses same origin when served by a bridge (e.g. NAS)', () => {
    expect(defaultBridgeUrl({ protocol: 'http:', host: '192.168.1.20:5199', hostname: '192.168.1.20' })).toBe(
      'ws://192.168.1.20:5199/rpc',
    );
  });
});
