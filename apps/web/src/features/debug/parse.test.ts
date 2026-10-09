import { describe, expect, it } from 'vitest';
import { MAX_REPLIES, MonitorCapture, levelRank, matchBracket, monitorMatches, parseCrashName, parseDmesg, parseMonitorLine, parseMonitorQuery, parseSyslog, shortTime } from './parse';

describe('parseSyslog (parsePmLog)', () => {
  it('reads PmLog lines with extras and message', () => {
    const e = parseSyslog('2026-10-09T14:51:00.123456Z [3723.418000] user.info sam [] sam APP_LAUNCH {"APP_ID":"com.webos.app.home","N":{"a":"}"}} launching app', 1)!;
    expect(e).toMatchObject({
      time: '2026-10-09T14:51:00.123456Z',
      monotonic: 3723.418,
      level: 'info',
      facility: 'user',
      process: 'sam',
      context: 'sam',
      msgid: 'APP_LAUNCH',
      message: 'launching app',
      extras: { APP_ID: 'com.webos.app.home', N: { a: '}' } },
    });
    expect(e.pid).toBeUndefined();
    expect(shortTime(e)).toBe('14:51:00.123');
  });

  it('keeps pid:tid and maps level spellings', () => {
    const e = parseSyslog('2026-10-09T14:51:00Z [1.5] daemon.warn surface-manager [812:830] sm SM_FOCUS {} focus changed', 2)!;
    expect(e).toMatchObject({ pid: '812:830', level: 'warning', message: 'focus changed' });
  });

  it('falls back for lines in another format', () => {
    expect(parseSyslog('2026-10-09T14:51:00.5Z kernel: syslogd started', 3)).toMatchObject({ time: '2026-10-09T14:51:00.5Z', level: 'info', message: 'kernel: syslogd started' });
    expect(parseSyslog('garbage line', 4, () => 'NOW')).toMatchObject({ time: 'NOW', message: 'garbage line' });
    expect(parseSyslog('   ', 5)).toBeNull();
  });

  it('matches brackets inside JSON strings', () => {
    expect(matchBracket('{"a":"{"} rest', 0)).toBe(8);
    expect(matchBracket('{"a":"\\"}"} x', 0)).toBe(10);
    expect(matchBracket('{unclosed', 0)).toBe(-1);
  });
});

describe('parseDmesg', () => {
  it('reads dmesg -x lines', () => {
    expect(parseDmesg('kern  :warn  : [   12.345678] mtk_vdec: buffer underrun on stream 0', 1)).toMatchObject({
      facility: 'kern',
      level: 'warning',
      monotonic: 12.345678,
      context: 'mtk_vdec',
      message: 'buffer underrun on stream 0',
    });
    expect(parseDmesg('kern  :info  : [    1.000000] Booting Linux', 2)).toMatchObject({ message: 'Booting Linux' });
  });

  it('reads busybox lines with and without a priority', () => {
    expect(parseDmesg('<3>[    5.100000] wlan0: deauthenticating', 1)).toMatchObject({ level: 'err', context: 'wlan0', message: 'deauthenticating' });
    expect(parseDmesg('[    5.100000] plain message', 2)).toMatchObject({ level: 'info', message: 'plain message' });
    expect(parseDmesg('something else', 3)).toMatchObject({ message: 'something else' });
  });

  it('ranks levels', () => {
    expect(levelRank('emerg')).toBeLessThan(levelRank('err'));
    expect(levelRank('warn')).toBe(levelRank('warning'));
    expect(levelRank('whatever')).toBe(levelRank('info'));
  });
});

describe('parseCrashName (CrashReport.parseTitle)', () => {
  it('names app crashes by app id and pid', () => {
    expect(parseCrashName('\x01usr\x01palm\x01applications\x01com.example.crashy\x01crashy____crashy.4242.core.gz')).toEqual({
      title: 'com.example.crashy (4242)',
      summary: 'crashy',
      saveName: 'usr_palm_applications_com.example.crashy_crashy',
    });
  });

  it('names other processes by process name and pid', () => {
    expect(parseCrashName('\x01usr\x01sbin\x01surface-manager____surface-manager.1001.core.gz')).toMatchObject({
      title: 'surface-manager (1001)',
      summary: '/usr/sbin/surface-manager',
    });
  });

  it('falls back for unknown names', () => {
    expect(parseCrashName('oops.txt')).toEqual({ title: 'Unknown crash', summary: 'oops.txt', saveName: 'oops.txt' });
  });
});

describe('luna monitor', () => {
  const call = (token: number, method: string, extra: object = {}) => ({
    type: 'call', transport: 'TX', token, senderUniqueName: ':1.1', destinationUniqueName: ':1.9',
    sender: 'com.webos.app.home', destination: 'com.webos.service.config', methodCategory: '/', method, payload: { a: 1 }, ...extra,
  });
  const ret = (token: number, payload: object) => ({
    type: 'return', transport: 'TX', replyToken: token, senderUniqueName: ':1.9', destinationUniqueName: ':1.1',
    sender: 'com.webos.service.config', destination: 'com.webos.app.home', payload,
  });

  it('groups calls with their replies', () => {
    const c = new MonitorCapture();
    expect(c.add(call(5, 'getConfigs'))).toBe(true);
    expect(c.add({ ...call(5, 'getConfigs'), transport: 'RX' })).toBe(false); // RX copies are ignored
    expect(c.add(ret(5, { returnValue: true }))).toBe(true);
    c.add(call(6, 'setConfigs'));
    c.add(ret(6, { returnValue: false, errorText: 'Denied' }));
    c.add(call(7, 'subscribe'));
    c.add({ type: 'callCancel', transport: 'TX', senderUniqueName: ':1.1', destinationUniqueName: ':1.9', payload: { token: 7 } });
    // Answered, then cancelled by the caller (what a real TV does for most calls): still "replied".
    c.add(call(8, 'getMemState'));
    c.add(ret(8, { returnValue: true }));
    c.add({ type: 'callCancel', transport: 'TX', senderUniqueName: ':1.1', destinationUniqueName: ':1.9', payload: { token: 8 } });
    expect(c.calls.map((e) => [e.name, e.status, e.messages.length])).toEqual([
      ['com.webos.service.config/getConfigs', 'ok', 2],
      ['com.webos.service.config/setConfigs', 'error', 2],
      ['com.webos.service.config/subscribe', 'cancelled', 2],
      ['com.webos.service.config/getMemState', 'ok', 3],
    ]);
    expect(c.calls[0]!.information).toBe('{"a":1}');
  });

  it('keeps the call and its newest replies', () => {
    const c = new MonitorCapture();
    c.add(call(9, 'subscribe'));
    for (let i = 0; i < MAX_REPLIES + 5; i++) c.add(ret(9, { n: i }));
    const e = c.calls[0]!;
    expect(e.messages).toHaveLength(MAX_REPLIES + 1);
    expect(e.messages[0]!.type).toBe('call');
    expect(e.messages[1]!.payload).toEqual({ n: 5 });
    expect(e.skipped).toBe(5);
  });

  it('keeps only the newest calls', () => {
    const c = new MonitorCapture(3);
    for (let i = 0; i < 5; i++) c.add(call(i, `m${i}`));
    expect(c.calls.map((e) => e.name.split('/').pop())).toEqual(['m2', 'm3', 'm4']);
    expect(c.add(ret(0, {}))).toBe(false); // its call was dropped
    expect(c.add(ret(4, {}))).toBe(true);
  });

  it('parses lines and queries', () => {
    expect(parseMonitorLine('not json')).toBeNull();
    expect(parseMonitorLine('{"type":"call"}')).toEqual({ type: 'call' });
    const q = parseMonitorQuery('sender:com.webos.app.home -destination:com.webos.service.settings Config');
    expect(q).toEqual({ text: ['config'], sender: ['com.webos.app.home'], destination: [], exclude: { text: [], sender: [], destination: ['com.webos.service.settings'] } });
    const e = { name: 'com.webos.service.config/getConfigs', sender: 'com.webos.app.home', destination: 'com.webos.service.config', information: '{}' };
    expect(monitorMatches(e, q)).toBe(true);
    expect(monitorMatches({ ...e, sender: 'other' }, q)).toBe(false);
    expect(monitorMatches({ ...e, destination: 'com.webos.service.settings' }, q)).toBe(false);
    expect(monitorMatches(e, parseMonitorQuery('-getconfigs'))).toBe(false);
  });
});
