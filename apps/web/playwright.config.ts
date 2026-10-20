import { cpus } from 'node:os';
import { defineConfig, devices } from '@playwright/test';

const port = Number(process.env.E2E_BRIDGE_PORT ?? 5299);

/**
 * End-to-end tests: the built UI served by a real bridge, talking to mock TVs (see e2e/server.ts).
 * Run `pnpm --filter @lgdm/web build` first; `pnpm --filter @lgdm/web e2e` starts the rig itself.
 */
export default defineConfig({
  testDir: './e2e',
  timeout: 60_000,
  // Tests share one rig (bridge + mock TVs) but not state: each has its own browser storage and uses its own
  // app ids, so they can run side by side.
  fullyParallel: true,
  // The tests mostly wait on the bridge and mock TVs rather than compute, so run at least 4 at once.
  workers: Math.min(8, Math.max(4, cpus().length)),
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? [['github'], ['list']] : 'list',
  use: {
    baseURL: `http://127.0.0.1:${port}`,
    // Recording a trace (screenshots + DOM snapshots) for every test about doubled the suite's time, even though passing
    // tests' traces were thrown away. Now only a retried test (CI retries once) records one; locally use --trace on.
    trace: 'on-first-retry',
    ...devices['Desktop Chrome'],
    // CI: the Google Chrome GitHub's Ubuntu runners come with, instead of downloading Chromium and its libraries on
    // every run (~20 s). Locally: Playwright's own Chromium (`playwright install chromium`).
    ...(process.env.CI ? { channel: 'chrome' } : {}),
  },
  webServer: {
    command: 'tsx e2e/server.ts',
    url: `http://127.0.0.1:${port}/healthz`,
    reuseExistingServer: !process.env.CI,
    stdout: 'pipe',
    timeout: 60_000,
  },
});
