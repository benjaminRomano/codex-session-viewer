import { defineConfig, devices } from '@playwright/test';
export default defineConfig({
  timeout: 90000,
  globalTimeout: 600000,
  testDir: './tests',
  testMatch: '**/*.spec.ts',
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  failOnFlakyTests: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  workers: 2,
  reporter: [['list'], ['html', { outputFolder: 'output/playwright/report', open: 'never' }]],
  outputDir: 'output/playwright/results',
  use: {
    baseURL: 'http://127.0.0.1:5177',
    channel: process.env.PLAYWRIGHT_CHANNEL || 'chrome',
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'], viewport: { width: 1440, height: 1000 } },
    },
  ],
  webServer: {
    command: 'node scripts/test-server.mjs',
    url: 'http://127.0.0.1:5177',
    reuseExistingServer: false,
    timeout: 30000,
  },
});
