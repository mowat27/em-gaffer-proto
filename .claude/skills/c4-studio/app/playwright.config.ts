import { defineConfig, devices } from '@playwright/test';

// The studio server is started separately (`just c4-studio serve`); tests never start it.
export default defineConfig({
  testDir: 'tests/e2e',
  timeout: 30_000,
  expect: { timeout: 7_500 },
  fullyParallel: false,
  workers: 1,
  reporter: [['list']],
  use: {
    baseURL: process.env.C4_STUDIO_URL ?? 'http://127.0.0.1:47145',
    trace: 'retain-on-failure',
    viewport: { width: 1440, height: 900 },
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
});
