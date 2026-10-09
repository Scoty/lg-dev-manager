import { describe, expect, it } from 'vitest';
import { Methods, RpcRequest, UNAUTHENTICATED_METHODS } from './index';

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
