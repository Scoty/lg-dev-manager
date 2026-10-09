/**
 * Test rig for the Playwright suite (and for trying the UI by hand without a TV):
 *  - a Dev Mode mock TV on 127.0.0.1:9922 with its key server on :9991 (the wizard's fixed ports) and webOS's
 *    second-screen port :3000 (so the network scan finds it),
 *  - a rooted mock TV with Homebrew Channel on 127.0.0.1:2222 (user root, password "alpine"),
 *  - the bridge on 127.0.0.1:5299 serving the built web UI (apps/web/dist), pairing token "e2e-token".
 * Run with: pnpm --filter @lgdm/web e2e:server
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { startMockTv } from '@lgdm/mock-tv';
import { startServer } from '../../bridge/src/server.js';

export const E2E = {
  bridgePort: Number(process.env.E2E_BRIDGE_PORT ?? 5299),
  token: 'e2e-token',
  passphrase: 'A1B2C3',
  rootedPort: 2222,
};

const here = dirname(fileURLToPath(import.meta.url));
process.env.LGDM_STATE_DIR = mkdtempSync(join(tmpdir(), 'lgdm-e2e-'));

// The Dev Mode TV also answers on webOS's second-screen port (3000), so the network scan finds it at 127.0.0.1.
process.env.LGDM_SCAN_EXTRA_HOSTS ??= '127.0.0.1';
const devTv = await startMockTv({ sshPort: 9922, keyServerPort: 9991, passphrase: E2E.passphrase, ssapPort: 3000 });
const rootTv = await startMockTv({ username: 'root', password: 'alpine', hbchannel: true, sshPort: E2E.rootedPort });
const origins = [`http://127.0.0.1:${E2E.bridgePort}`, `http://localhost:${E2E.bridgePort}`];
await startServer({
  host: '127.0.0.1',
  port: E2E.bridgePort,
  allowedOrigins: origins,
  token: E2E.token,
  webRoot: join(here, '..', 'dist'),
  dev: true,
});

console.log(`e2e rig ready: UI ${origins[0]}  token ${E2E.token}`);
console.log(`  Dev Mode TV 127.0.0.1:${devTv.sshPort} (key server ${devTv.keyServerPort}, passphrase ${E2E.passphrase})`);
console.log(`  Rooted TV   127.0.0.1:${rootTv.sshPort} (root / alpine, Homebrew Channel)`);
