import { defineConfig, devices } from '@playwright/test';
export default defineConfig({
  testDir: './tests/e2e',
  fullyParallel: false,
  workers: 1,
  retries: 0,
  use: { baseURL: 'http://127.0.0.1:8787', trace: 'retain-on-failure' },
  webServer: {
    command: 'node scripts/preview.mjs',
    url: 'http://127.0.0.1:8787/api/config',
    timeout: 120000,
    reuseExistingServer: false,
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
});
