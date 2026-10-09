import { defineConfig, devices } from '@playwright/test';

const port = Number(process.env.E2E_BRIDGE_PORT ?? 5299);

/**
 * End-to-end tests: the built UI served by a real bridge, talking to mock TVs (see e2e/server.ts).
 * Run `pnpm --filter @lgdm/web build` first; `pnpm --filter @lgdm/web e2e` starts the rig itself.
 */
export default defineConfig({
  testDir: './e2e',
  timeout: 60_000,
  fullyParallel: false,
  workers: 1,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? [['github'], ['list']] : 'list',
  use: {
    baseURL: `http://127.0.0.1:${port}`,
    trace: 'retain-on-failure',
    ...devices['Desktop Chrome'],
  },
  webServer: {
    command: 'tsx e2e/server.ts',
    url: `http://127.0.0.1:${port}/healthz`,
    reuseExistingServer: !process.env.CI,
    stdout: 'pipe',
    timeout: 60_000,
  },
});
