import { describe, expect, it } from 'vitest';
import { AppId, Methods, OpProgress, RpcRequest, UNAUTHENTICATED_METHODS } from './index';

describe('protocol', () => {
  it('validates a hello request', () => {
    const req = RpcRequest.parse({ id: 1, method: 'system.hello', params: { token: 'abc', protocolVersion: 1 } });
    expect(Methods['system.hello'].params.parse(req.params)).toMatchObject({ token: 'abc' });
  });

  it('rejects hello without a token', () => {
    expect(() => Methods['system.hello'].params.parse({ protocolVersion: 1 })).toThrow();
  });

  it('only allows hello before auth', () => {
    expect(UNAUTHENTICATED_METHODS).toEqual(['system.hello']);
  });
});

describe('M3 schemas', () => {
  const device = { host: '192.0.2.10', port: 9922, username: 'prisoner', auth: { kind: 'password', password: 'x' } };

  it('accepts webOS app ids and rejects shell metacharacters', () => {
    expect(AppId.parse('org.webosbrew.hbchannel')).toBe('org.webosbrew.hbchannel');
    expect(() => AppId.parse('a b')).toThrow();
    expect(() => AppId.parse("x';reboot")).toThrow();
  });

  it('only allows absolute icon paths without ..', () => {
    const icon = Methods['apps.icon'].params;
    expect(icon.safeParse({ device, path: '/media/developer/apps/x/icon.png' }).success).toBe(true);
    expect(icon.safeParse({ device, path: 'icon.png' }).success).toBe(false);
    expect(icon.safeParse({ device, path: '/media/../etc/shadow' }).success).toBe(false);
  });

  it('caps upload chunks and checks base64', () => {
    const chunk = Methods['upload.chunk'].params;
    expect(chunk.safeParse({ uploadId: 'u', offset: 0, data: 'aGVsbG8=' }).success).toBe(true);
    expect(chunk.safeParse({ uploadId: 'u', offset: 0, data: 'not base64!' }).success).toBe(false);
  });

  it('describes progress events', () => {
    expect(OpProgress.parse({ opId: '1', stage: 'install', percent: 40 })).toMatchObject({ percent: 40 });
    expect(() => OpProgress.parse({ opId: '1', stage: 'install', percent: 140 })).toThrow();
  });
});
