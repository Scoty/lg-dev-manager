import { describe, expect, it } from 'vitest';
import type { RepoPackage } from '@lgdm/protocol';
import { hasUpdate, incompatibility, stateOf } from './logic';

const pkg = (over: Partial<RepoPackage> = {}): RepoPackage => ({
  id: 'com.example.x',
  title: 'X',
  hasDescription: false,
  manifest: { id: 'com.example.x', version: '1.2.0', ipkUrl: 'https://example.com/x.ipk' },
  ...over,
});

describe('hasUpdate (PackageManifest.hasUpdate)', () => {
  it.each([
    ['1.2.0', '1.1.9', true],
    ['1.2.0', '1.2.0', false],
    ['1.2.0', '1.3.0', false],
    ['1.2.3.4', '1.2.3.3', true],
    ['1.2.3.10', '1.2.3.9', true],
    ['1.2.3.b', '1.2.3.a', true],
    ['1.2.3.1', '1.2.3', true],
    ['0.5.0', '0.4.6', true],
    ['2.0', '1.9', true],
  ])('%s over %s → %s', (repo, installed, expected) => {
    expect(hasUpdate(repo, installed)).toBe(expected);
  });

  it('is null when a version is missing', () => {
    expect(hasUpdate(undefined, '1.0.0')).toBeNull();
    expect(hasUpdate('1.0.0', undefined)).toBeNull();
  });
});

describe('incompatibility (RepositoryItem.checkIncompatibility)', () => {
  it('checks the webOS range, SoC lists and root', () => {
    const tv = { osVersion: '8.0.0', socName: 'k8lp' };
    expect(incompatibility(pkg({ requirements: { webosRelease: '>=5.0' } }), tv, { root: true })).toBeNull();
    expect(incompatibility(pkg({ requirements: { webosRelease: '>=99.0' } }), tv, { root: true })).toEqual(['release']);
    expect(incompatibility(pkg({ requirements: { deviceSoC: ['!k8lp'] } }), tv, {})).toEqual(['soc']);
    expect(incompatibility(pkg({ requirements: { deviceSoC: ['m16'] } }), tv, {})).toEqual(['soc']);
    expect(incompatibility(pkg({ requirements: { deviceSoC: ['k8lp', 'm16'] } }), tv, {})).toBeNull();
    const rootOnly = pkg({ manifest: { id: 'x', version: '1', ipkUrl: 'https://e.x/a.ipk', rootRequired: true } });
    expect(incompatibility(rootOnly, tv, { root: false })).toEqual(['root']);
    expect(incompatibility(rootOnly, tv, undefined)).toBeNull();
  });

  it('does not hold unknown facts against the app', () => {
    expect(incompatibility(pkg({ requirements: { webosRelease: '>=99', deviceSoC: ['x'] } }), undefined, undefined)).toBeNull();
    expect(incompatibility(pkg({ requirements: { webosRelease: 'not a range' } }), { osVersion: '8.0.0' }, undefined)).toBeNull();
  });
});

describe('stateOf', () => {
  it('picks install, update or installed', () => {
    expect(stateOf(pkg(), undefined)).toBe('install');
    expect(stateOf(pkg(), '1.0.0')).toBe('update');
    expect(stateOf(pkg(), '1.2.0')).toBe('installed');
  });
});
