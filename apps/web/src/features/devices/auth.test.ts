import { describe, expect, it } from 'vitest';
import { authProblems, describeLogin, emptyAuth, hostProblem, toDeviceAuth } from './auth';
import { iconPath } from '../apps/queries';

describe('add-device form helpers', () => {
  it('accepts IPv4, IPv6 and host names', () => {
    for (const h of ['192.0.2.10', 'lgwebostv', 'tv.local', '[2001:db8::1]', '2001:db8::1']) expect(hostProblem(h)).toBeNull();
    for (const h of ['', 'not a host', 'http://192.0.2.10', 'tv;rm']) expect(hostProblem(h)).not.toBeNull();
  });

  it('requires what each login kind needs', () => {
    expect(authProblems(emptyAuth('devkey'))).toHaveProperty('passphrase');
    expect(authProblems({ kind: 'devkey', passphrase: 'A1B2C3' })).toEqual({});
    expect(authProblems(emptyAuth('password'))).toHaveProperty('password');
    expect(authProblems(emptyAuth('key'))).toHaveProperty('privateKey');
    expect(authProblems(emptyAuth('generated'))).toHaveProperty('privateKey');
    expect(authProblems({ kind: 'keep' })).toEqual({});
  });

  it('turns drafts into stored logins (Dev Mode keys are fetched later)', () => {
    expect(toDeviceAuth({ kind: 'password', password: 'alpine' })).toEqual({ kind: 'password', password: 'alpine' });
    expect(toDeviceAuth({ kind: 'key', privateKey: '  KEY  ', passphrase: '' })).toEqual({ kind: 'key', privateKey: 'KEY\n' });
    expect(toDeviceAuth({ kind: 'key', privateKey: 'KEY', passphrase: 'pp' })).toEqual({ kind: 'key', privateKey: 'KEY\n', passphrase: 'pp' });
    expect(toDeviceAuth({ kind: 'devkey', passphrase: 'A1B2C3' })).toBeNull();
  });

  it('describes logins without revealing them', () => {
    expect(describeLogin({ kind: 'password', password: 'secret' })).toBe('password');
    expect(describeLogin({ kind: 'key', privateKey: 'k', passphrase: 'p' })).toBe('key + passphrase');
  });
});


describe('app icon path', () => {
  it('joins relative icons to the app folder and keeps absolute ones', () => {
    expect(iconPath({ id: 'a', folderPath: '/media/developer/apps/usr/palm/applications/a', icon: 'icon.png' })).toBe(
      '/media/developer/apps/usr/palm/applications/a/icon.png',
    );
    expect(iconPath({ id: 'a', folderPath: '/x/', icon: '/usr/palm/applications/a/icon.png' })).toBe('/usr/palm/applications/a/icon.png');
    expect(iconPath({ id: 'a', folderPath: '/x' })).toBeNull();
  });
});
