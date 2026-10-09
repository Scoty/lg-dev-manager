import { describe, expect, it } from 'vitest';
import { bridgeOutdated } from './BridgeUpdateNotice';
import { APP_VERSION, BRIDGE_RELEASE } from '../lib/version';

describe('bridgeOutdated', () => {
  it('is true only when the running bridge is older than the release', () => {
    expect(bridgeOutdated('1.0.0', '1.0.1')).toBe(true);
    expect(bridgeOutdated('0.9.9', '1.0.0')).toBe(true);
    expect(bridgeOutdated('1.0.1', '1.0.1')).toBe(false);
    expect(bridgeOutdated('1.1.0', '1.0.1')).toBe(false);
  });
  it('ignores versions it can’t read', () => {
    expect(bridgeOutdated('dev', '1.0.0')).toBe(false);
    expect(bridgeOutdated('1.0.0', 'x')).toBe(false);
  });
  it('knows the versions this build was made with', () => {
    expect(APP_VERSION).toMatch(/^\d+\.\d+\.\d+/);
    expect(BRIDGE_RELEASE).toMatch(/^\d+\.\d+\.\d+/);
  });
});
