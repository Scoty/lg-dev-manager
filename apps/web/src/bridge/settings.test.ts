import { afterEach, describe, expect, it } from 'vitest';
import { bridgeUrlProblem, defaultBridgeUrl, loadSettings } from './settings';

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
  it('uses same origin when served by a bridge on the network (LAN mode)', () => {
    expect(defaultBridgeUrl({ protocol: 'http:', host: '192.0.2.20:5199', hostname: '192.0.2.20' })).toBe('ws://192.0.2.20:5199/rpc');
    expect(defaultBridgeUrl({ protocol: 'http:', host: 'nas.local:5199', hostname: 'nas.local' })).toBe('ws://nas.local:5199/rpc');
    // Behind an HTTPS reverse proxy.
    expect(defaultBridgeUrl({ protocol: 'https:', host: 'lg.home.example', hostname: 'lg.home.example' })).toBe('wss://lg.home.example/rpc');
  });
  it('uses another port on this computer when a pairing link names one', () => {
    expect(defaultBridgeUrl({ protocol: 'https:', host: 'lg.scoty.uk', hostname: 'lg.scoty.uk' }, 5200)).toBe('ws://127.0.0.1:5200/rpc');
  });
});

describe('bridgeUrlProblem', () => {
  afterEach(() => localStorage.clear());

  it('accepts the bridge on this computer', () => {
    for (const url of ['ws://127.0.0.1:5199/rpc', 'ws://localhost:5199/rpc', 'ws://127.0.0.1:5299/rpc', ' ws://localhost:6000/rpc ']) {
      expect(bridgeUrlProblem(url)).toBeNull();
    }
  });

  it('refuses anything that would send the token and TV logins elsewhere', () => {
    for (const url of [
      'ws://192.0.2.20:5199/rpc',
      'wss://evil.example/rpc',
      'ws://evil.example:5199/rpc',
      'ws://127.0.0.1.evil.example:5199/rpc',
      'ws://localhost.evil.example/rpc',
      'ws://user:pass@127.0.0.1:5199/rpc',
      'http://127.0.0.1:5199/rpc',
      'wss://127.0.0.1:5199/rpc',
      '127.0.0.1:5199',
      'not a url',
    ]) {
      expect(bridgeUrlProblem(url), url).toMatch(/The bridge runs on this computer/);
    }
  });

  it('on a page a LAN bridge serves, accepts that page’s own address and nothing else', () => {
    const nas = { protocol: 'http:', host: 'nas.local:5199', hostname: 'nas.local' };
    expect(bridgeUrlProblem('ws://nas.local:5199/rpc', nas)).toBeNull();
    expect(bridgeUrlProblem('ws://127.0.0.1:5199/rpc', nas)).toBeNull();
    for (const url of ['ws://nas.local:5200/rpc', 'wss://nas.local:5199/rpc', 'ws://other.local:5199/rpc', 'ws://u:p@nas.local:5199/rpc']) {
      expect(bridgeUrlProblem(url, nas), url).not.toBeNull();
    }
    const proxied = { protocol: 'https:', host: 'lg.home.example', hostname: 'lg.home.example' };
    expect(bridgeUrlProblem('wss://lg.home.example/rpc', proxied)).toBeNull();
    expect(bridgeUrlProblem('ws://lg.home.example/rpc', proxied)).not.toBeNull();
    // lg.scoty.uk itself is never a bridge.
    const site = { protocol: 'https:', host: 'lg.scoty.uk', hostname: 'lg.scoty.uk' };
    expect(bridgeUrlProblem('wss://lg.scoty.uk/rpc', site)).not.toBeNull();
  });

  it('ignores a saved pairing for a bridge that is not on this computer', () => {
    localStorage.setItem('lgdm-bridge', JSON.stringify({ url: 'wss://evil.example/rpc', token: 't' }));
    expect(loadSettings()).toBeNull();
    localStorage.setItem('lgdm-bridge', JSON.stringify({ url: 'ws://127.0.0.1:5199/rpc', token: 't' }));
    expect(loadSettings()).toEqual({ url: 'ws://127.0.0.1:5199/rpc', token: 't' });
  });
});
