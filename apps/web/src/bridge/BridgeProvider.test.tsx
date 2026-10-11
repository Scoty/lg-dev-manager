import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, render } from '@testing-library/react';

// A bridge that isn't running until `up` is set; then it answers the hello.
const bridge = vi.hoisted(() => ({ up: false, attempts: 0 }));
vi.mock('./client', async (orig) => {
  const real = await orig<typeof import('./client')>();
  class FakeClient {
    onClose?: (reason: string) => void;
    async connect() {
      bridge.attempts++;
      if (!bridge.up) throw new real.BridgeError('unreachable', 'Can’t reach the bridge.');
      return { protocolVersion: 1, bridgeVersion: '9.9.9', platform: 'linux' };
    }
    close() {}
  }
  return { ...real, BridgeClient: FakeClient };
});
vi.mock('./settings', async (orig) => ({
  ...(await orig<typeof import('./settings')>()),
  loadSettings: () => ({ url: 'ws://127.0.0.1:5199/rpc', token: 'test-token-0123456789' }),
}));

const { BridgeProvider, useBridge } = await import('./BridgeProvider');

describe('BridgeProvider while the bridge is down', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    bridge.up = false;
    bridge.attempts = 0;
  });
  afterEach(() => {
    cleanup();
    vi.useRealTimers();
  });

  it('retries in the background without going back to "connecting", then connects by itself', async () => {
    const seen: string[] = [];
    function Probe() {
      const { status } = useBridge();
      const label = status.state === 'error' ? `error${status.retrying ? '+retrying' : ''}` : status.state;
      if (seen[seen.length - 1] !== label) seen.push(label);
      return null;
    }
    render(<BridgeProvider><Probe /></BridgeProvider>);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(30_000); // retries at 1, 2, 5, 10, 10 s
    });
    expect(bridge.attempts).toBeGreaterThanOrEqual(5);
    // The page saw one "connecting" (the first try) and then a steady error — no flip on each retry.
    expect(seen).toEqual(['connecting', 'error+retrying']);

    bridge.up = true;
    await act(async () => {
      await vi.advanceTimersByTimeAsync(10_000);
    });
    expect(seen).toEqual(['connecting', 'error+retrying', 'connected']);
  });
});
