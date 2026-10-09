/** Canned luna-send responses. Extend as features land (keep payload shapes close to real webOS). */
export type LunaHandler = (params: Record<string, unknown>) => Record<string, unknown>;

export const MOCK_APPS = [
  { id: 'com.example.hello', title: 'Hello World', version: '1.0.0', type: 'web', folderPath: '/media/developer/apps/usr/palm/applications/com.example.hello', visible: true },
  { id: 'org.webosbrew.hbchannel', title: 'Homebrew Channel', version: '0.7.2', type: 'web', folderPath: '/media/developer/apps/usr/palm/applications/org.webosbrew.hbchannel', visible: true },
];

export const LUNA: Record<string, LunaHandler> = {
  'luna://com.palm.systemservice/osInfo/query': () => ({
    returnValue: true,
    webos_name: 'webOS TV',
    webos_release: '8.0.0',
    webos_build_id: 'mock',
    device_name: 'mock-tv',
  }),
  'luna://com.webos.service.tv.systemproperty/getSystemInfo': () => ({
    returnValue: true,
    modelName: 'MOCK55TV',
    firmwareVersion: '03.00.00',
    sdkVersion: '8.0.0',
    boardType: 'MOCK',
  }),
  'luna://com.webos.service.sdx/getDeviceUuid': () => ({ returnValue: true, uuid: '00000000-0000-0000-0000-000000000000' }),
  'luna://com.webos.applicationManager/dev/listApps': () => ({ returnValue: true, apps: MOCK_APPS }),
  'luna://com.webos.applicationManager/listApps': () => ({ returnValue: true, apps: MOCK_APPS }),
  'luna://com.webos.applicationManager/launch': (p) =>
    MOCK_APPS.some((a) => a.id === p.id)
      ? { returnValue: true, appId: p.id }
      : { returnValue: false, errorCode: -101, errorText: `Cannot find proper launchPoint for ${String(p.id)}` },
};

const KNOWN_SERVICES = new Set(Object.keys(LUNA).map((u) => u.split('/').slice(0, 3).join('/')));

export function handleLuna(uri: string, params: Record<string, unknown>): Record<string, unknown> {
  const h = LUNA[uri];
  if (h) return h(params);
  const service = uri.split('/').slice(0, 3).join('/');
  if (KNOWN_SERVICES.has(service)) {
    return { returnValue: false, errorCode: -1, errorText: `Unknown method "${uri.slice(service.length)}" for category "/"` };
  }
  return { returnValue: false, errorCode: -1, errorText: `Service does not exist: ${service.slice('luna://'.length)}.` };
}
