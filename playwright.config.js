import { defineConfig, devices } from '@playwright/test';

const baseURL = process.env.E2E_BASE_URL || 'http://127.0.0.1:4173';
const useExternalServer = process.env.E2E_EXTERNAL_SERVER === '1';

export default defineConfig({
  testDir: './tests',
  testMatch: 'e2e.spec.js',
  outputDir: 'test-results/e2e',
  fullyParallel: false,
  forbidOnly: Boolean(process.env.CI),
  retries: process.env.CI ? 2 : 0,
  workers: 1,
  reporter: process.env.CI
    ? [['line'], ['html', { open: 'never', outputFolder: 'playwright-report' }]]
    : [['list'], ['html', { open: 'never', outputFolder: 'playwright-report' }]],
  use: {
    baseURL,
    locale: 'zh-TW',
    timezoneId: 'Asia/Taipei',
    colorScheme: 'light',
    actionTimeout: 10_000,
    navigationTimeout: 20_000,
    trace: 'on-first-retry',
    screenshot: 'only-on-failure',
    video: 'retain-on-failure',
  },
  webServer: useExternalServer
    ? undefined
    : {
        command: 'npm start',
        url: new URL('/healthz', baseURL).href,
        reuseExistingServer: !process.env.CI,
        timeout: 45_000,
      },
  projects: [
    {
      name: 'chromium',
      use: {
        ...devices['Desktop Chrome'],
      },
    },
  ],
});
