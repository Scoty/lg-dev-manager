import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startMockTv, type MockTv } from '@lgdm/mock-tv';
import { createServer, type AddressInfo, type Server } from 'node:net';
import { parseDescription, parseSsdpResponse, probeSsap, scanNetwork } from './devices/scan.js';
import { checkConnection } from './devices/ports.js';
import { sshBanner } from './devices/webos.js';

let tv: MockTv;
/** Something else with "port 3000" open — e.g. another brand of TV or a dev server. */
let other: Server;
let otherPort: number;
beforeAll(async () => {
  tv = await startMockTv({ ssapPort: 0 });
  other = createServer((s) => {
    s.on('error', () => {});
    s.end('HTTP/1.1 200 OK\r\nContent-Length: 2\r\n\r\nhi');
  });
  await new Promise<void>((r) => other.listen(0, '127.0.0.1', () => r()));
  otherPort = (other.address() as AddressInfo).port;
});
afterAll(async () => {
  other.close();
  await tv.close();
});

describe('SSDP parsing', () => {
  it('keeps LG webOS answers and ignores other devices', () => {
    const lg = 'HTTP/1.1 200 OK\r\nCACHE-CONTROL: max-age=1800\r\nLOCATION: http://192.0.2.20:1271/\r\nSERVER: WebOS/4.1.0 UPnP/1.0\r\nST: urn:lge-com:service:webos-second-screen:1\r\n\r\n';
    expect(parseSsdpResponse(lg, '192.0.2.20')).toMatchObject({ host: '192.0.2.20', location: 'http://192.0.2.20:1271/' });
    const other = 'HTTP/1.1 200 OK\r\nLOCATION: http://192.0.2.30:8008/ssdp/device-desc.xml\r\nSERVER: Linux/3.8 UPnP/1.0 Chromecast\r\nST: urn:dial-multiscreen-org:service:dial:1\r\n\r\n';
    expect(parseSsdpResponse(other, '192.0.2.30')).toBeNull();
    expect(parseSsdpResponse('garbage', '192.0.2.40')).toBeNull();
  });

  it('reads the friendly and model name from the description', () => {
    const xml = '<root><device><friendlyName>[LG] webOS TV OLED55C2 &amp; more</friendlyName><modelName>OLED55C24LA</modelName></device></root>';
    expect(parseDescription(xml)).toEqual({ name: '[LG] webOS TV OLED55C2 & more', modelName: 'OLED55C24LA' });
  });
});

describe('scan', () => {
  const ports = () => ({ ssh22: 1, ssh9922: tv.sshPort, keyServer: tv.keyServerPort, webos: [tv.ssapPort!] });

  it('finds a TV by its second-screen port and checks its SSH ports', async () => {
    const tvs = await scanNetwork({ ssdp: false, networks: [], extraHosts: ['127.0.0.1'], ports: ports() });
    expect(tvs).toEqual([
      { host: '127.0.0.1', ports: { ssh22: false, ssh9922: true, keyServer: true, webos: true }, via: ['sweep'] },
    ]);
  });

  it('finds nothing where nothing is listening', async () => {
    expect(await scanNetwork({ ssdp: false, networks: [], extraHosts: ['127.0.0.1'], ports: { ...ports(), webos: [1] } })).toEqual([]);
  });

  it('reports webOS on the port check even when SSH is closed', async () => {
    expect(await checkConnection('127.0.0.1', { ...ports(), ssh9922: 1, keyServer: 1 }, 1000)).toEqual({
      ssh22: false,
      ssh9922: false,
      keyServer: false,
      webos: true,
    });
  });
});

describe('telling LG TVs from other devices', () => {
  const ports = () => ({ ssh22: 1, ssh9922: tv.sshPort, keyServer: tv.keyServerPort, webos: [tv.ssapPort!] });

  it('recognises webOS by its second-screen WebSocket reply', async () => {
    expect(await probeSsap('127.0.0.1', tv.ssapPort!, false)).toBe(true);
    expect(await probeSsap('127.0.0.1', otherPort, false)).toBe(false);
    expect(await probeSsap('127.0.0.1', 1, false)).toBe(false);
  });

  it('reads the SSH banner', async () => {
    expect(await sshBanner('127.0.0.1', tv.sshPort)).toMatch(/^SSH-2\.0-dropbear/);
    expect(await sshBanner('127.0.0.1', 1)).toBeNull();
  });

  it('drops a device that only has port 3000 open', async () => {
    const tvs = await scanNetwork({ ssdp: false, networks: [], extraHosts: ['127.0.0.1'], ports: { ...ports(), ssh9922: 1, keyServer: 1, webos: [otherPort] } });
    expect(tvs).toEqual([]);
  });

  it('keeps a device whose second-screen port is quiet but whose SSH is dropbear', async () => {
    const tvs = await scanNetwork({ ssdp: false, networks: [], extraHosts: ['127.0.0.1'], ports: { ...ports(), webos: [otherPort] } });
    expect(tvs.map((t) => t.host)).toEqual(['127.0.0.1']);
  });
});
