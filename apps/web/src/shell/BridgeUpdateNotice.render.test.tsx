import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';

const status = vi.hoisted(() => ({ current: {} as Record<string, unknown> }));
vi.mock('../bridge/BridgeProvider', () => ({ useBridge: () => ({ status: status.current }) }));

const { BridgeUpdateNotice } = await import('./BridgeUpdateNotice');

const old = (distribution?: string) => {
  status.current = { state: 'connected', bridgeVersion: '0.0.1', platform: 'linux', distribution };
  render(<BridgeUpdateNotice always />);
};

describe('BridgeUpdateNotice: how to update', () => {
  afterEach(cleanup);

  it('points the app to the releases page', () => {
    old('app');
    expect(screen.getByRole('link', { name: 'releases page' }).getAttribute('href')).toBe('https://github.com/Scoty/lg-dev-manager/releases/latest');
    expect(screen.queryByText(/npx/)).toBeNull();
  });

  it('gives npx and clone users their own command', () => {
    old('npm');
    expect(screen.getByText('npx lg-dev-manager-bridge@latest')).toBeTruthy();
    expect(screen.queryByRole('link')).toBeNull();
    cleanup();
    old('source');
    expect(screen.getByText('git pull')).toBeTruthy();
    expect(screen.queryByText(/npx/)).toBeNull();
  });

  it('lists every way for bridges that don’t say how they were installed', () => {
    old(undefined);
    expect(screen.getByText('npx lg-dev-manager-bridge@latest')).toBeTruthy();
    expect(screen.getByRole('link', { name: 'releases page' })).toBeTruthy();
  });
});
