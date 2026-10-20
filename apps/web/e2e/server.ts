/**
 * Test rig for the Playwright suite (and for trying the UI by hand without a TV):
 *  - a Dev Mode mock TV on 127.0.0.1:9922 with its key server on :9991 (the wizard's fixed ports) and webOS's
 *    second-screen port :3000 (so the network scan finds it),
 *  - a rooted mock TV with Homebrew Channel on 127.0.0.1:2222 (user root, password "alpine"),
 *  - a rooted mock TV that refuses PTYs on 127.0.0.1:2223 (root / alpine), for the simple-shell terminal,
 *  - a rooted mock TV in standby on 127.0.0.1:2224 (root / alpine): installs work, launching is refused,
 *  - a fake Homebrew repository on 127.0.0.1:5298 (tools/mock-tv/src/repo.ts) the bridge uses instead of
 *    repo.webosbrew.org,
 *  - a fake LG Developer Mode session service (developer.lge.com) knowing the Dev Mode TV's token,
 *  - a fake GitHub serving Litefin's releases (tools/mock-tv/src/github.ts) on 127.0.0.1:5297,
 *  - a second fake repository on 127.0.0.1:5296, for custom repositories (http on 127.0.0.1, so the bridge runs with
 *    the test-only LGDM_TEST_ALLOW_LOCAL_REPOS — real bridges take https repositories on the internet only),
 *  - the bridge on 127.0.0.1:5299 serving the built web UI (apps/web/dist), pairing token "e2e-token",
 *  - a second bridge on 127.0.0.1:5295 that stores the TVs, repositories and screenshots itself (--store, 2.0;
 *    store.spec.ts), same token.
 * Run with: pnpm --filter @lgdm/web e2e:server
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { MOCK_CUSTOM_REPO_APPS, MOCK_DEVMODE_TOKEN, startMockGithub, startMockLge, startMockRepo, startMockTv } from '@lgdm/mock-tv';
import { startServer } from '../../bridge/src/server.js';

export const E2E = {
  bridgePort: Number(process.env.E2E_BRIDGE_PORT ?? 5299),
  token: 'e2e-token',
  passphrase: 'A1B2C3',
  rootedPort: 2222,
  noPtyPort: 2223,
  standbyPort: 2224,
  repoPort: Number(process.env.E2E_REPO_PORT ?? 5298),
  githubPort: Number(process.env.E2E_GITHUB_PORT ?? 5297),
  /** A second fake repository, added in the tests as a custom (unofficial) one. */
  customRepoPort: Number(process.env.E2E_CUSTOM_REPO_PORT ?? 5296),
  /** A bridge that stores the TVs itself (--store). */
  storeBridgePort: Number(process.env.E2E_STORE_BRIDGE_PORT ?? 5295),
};

const here = dirname(fileURLToPath(import.meta.url));
process.env.LGDM_STATE_DIR = mkdtempSync(join(tmpdir(), 'lgdm-e2e-'));

// The Dev Mode TV also answers on webOS's second-screen port (3000), so the network scan finds it at 127.0.0.1.
process.env.LGDM_SCAN_EXTRA_HOSTS ??= '127.0.0.1';
const devTv = await startMockTv({ sshPort: 9922, keyServerPort: 9991, passphrase: E2E.passphrase, ssapPort: 3000 });
const rootTv = await startMockTv({ username: 'root', password: 'alpine', hbchannel: true, sshPort: E2E.rootedPort });
const noPtyTv = await startMockTv({ username: 'root', password: 'alpine', pty: false, sshPort: E2E.noPtyPort });
const standbyTv = await startMockTv({ username: 'root', password: 'alpine', sshPort: E2E.standbyPort });
standbyTv.state.power = { state: 'Active Standby' };
// Followed logs tick faster than on a real TV, so tests waiting for new lines finish sooner.
for (const tv of [devTv, rootTv, noPtyTv]) tv.state.debug.every = 150;
const repo = await startMockRepo({ port: E2E.repoPort });
const customRepo = await startMockRepo({ port: E2E.customRepoPort, apps: MOCK_CUSTOM_REPO_APPS });
process.env.LGDM_TEST_ALLOW_LOCAL_REPOS = '1';
const github = await startMockGithub({ port: E2E.githubPort });
const lge = await startMockLge({ tokens: { [MOCK_DEVMODE_TOKEN]: (742 * 3600 + 15 * 60) * 1000 } });
// Launching the Developer Mode app with { extend: true } resets the session at LG, like on a real TV.
devTv.state.onDevmodeExtend = () => lge.sessions.set(MOCK_DEVMODE_TOKEN, Date.now() + 1000 * 3600 * 1000);
const origins = [`http://127.0.0.1:${E2E.bridgePort}`, `http://localhost:${E2E.bridgePort}`];
await startServer({
  host: '127.0.0.1',
  port: E2E.bridgePort,
  allowedOrigins: origins,
  token: E2E.token,
  webRoot: join(here, '..', 'dist'),
  repoUrl: repo.url,
  lgeUrl: lge.url,
  litefinUrl: github.url,
  dev: true,
});

const storeOrigins = [`http://127.0.0.1:${E2E.storeBridgePort}`, `http://localhost:${E2E.storeBridgePort}`];
await startServer({
  host: '127.0.0.1',
  port: E2E.storeBridgePort,
  allowedOrigins: storeOrigins,
  token: E2E.token,
  webRoot: join(here, '..', 'dist'),
  repoUrl: repo.url,
  lgeUrl: lge.url,
  litefinUrl: github.url,
  dev: true,
  storeDir: mkdtempSync(join(tmpdir(), 'lgdm-e2e-store-')),
});

console.log(`e2e rig ready: UI ${origins[0]}  token ${E2E.token}`);
console.log(`  Storing bridge ${storeOrigins[0]} (keeps TVs, repositories and screenshots itself)`);
console.log(`  Dev Mode TV 127.0.0.1:${devTv.sshPort} (key server ${devTv.keyServerPort}, passphrase ${E2E.passphrase})`);
console.log(`  Rooted TV   127.0.0.1:${rootTv.sshPort} (root / alpine, Homebrew Channel)`);
console.log(`  No-PTY TV   127.0.0.1:${noPtyTv.sshPort} (root / alpine, refuses PTYs)`);
console.log(`  Standby TV  127.0.0.1:${standbyTv.sshPort} (root / alpine, in standby: launching is refused)`);
console.log(`  Repository  ${repo.url} (fake Homebrew repo, ${repo.apps.length} apps)`);
console.log(`  Litefin     ${github.url} (fake GitHub releases)`);
console.log(`  Custom repo ${customRepo.url}/apps.json (add it under Setup → Custom repos)`);
