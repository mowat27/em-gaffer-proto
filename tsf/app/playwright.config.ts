/**
 * Playwright setup (DESIGN 15, Lot K): one real factory on faux for the whole run. `globalSetup` installs a temp project,
 * starts `node bin/tsf.mjs start` on a fixed port and writes `test-results/factory.json`; `globalTeardown` stops it.
 * The port is fixed (`TSF_E2E_PORT`, default 48731) because the config is read before `globalSetup` runs, so `baseURL`
 * cannot come from the file.
 */
import { defineConfig, devices } from "@playwright/test";

export const E2E_PORT = Number(process.env.TSF_E2E_PORT) || 48731;

export default defineConfig({
  testDir: "tests/e2e",
  outputDir: "test-results",
  workers: 1,
  fullyParallel: false,
  timeout: 60_000,
  expect: { timeout: 10_000 },
  globalSetup: "./tests/e2e/global-setup.ts",
  globalTeardown: "./tests/e2e/global-teardown.ts",
  reporter: [["list"]],
  use: {
    baseURL: `http://127.0.0.1:${E2E_PORT}`,
    viewport: { width: 1440, height: 900 },
    trace: "retain-on-failure",
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"], viewport: { width: 1440, height: 900 } } }],
});
