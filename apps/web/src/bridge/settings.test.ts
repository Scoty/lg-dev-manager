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
  it('uses same origin when served by the local bridge', () => {
    expect(defaultBridgeUrl({ protocol: 'http:', host: 'localhost:5199', hostname: 'localhost' })).toBe('ws://localhost:5199/rpc');
  });
  it('ignores other http hosts', () => {
    expect(defaultBridgeUrl({ protocol: 'http:', host: '192.0.2.20:8080', hostname: '192.0.2.20' })).toBe('ws://127.0.0.1:5199/rpc');
  });
});
