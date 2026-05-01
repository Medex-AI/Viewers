import { defineConfig, devices } from '@playwright/test';
import { config as loadEnv } from 'dotenv';
import path from 'path';

loadEnv({ path: path.resolve(__dirname, '.env.test') });

const playwrightPort = Number(process.env.PLAYWRIGHT_PORT || process.env.OHIF_PORT || 3000);
const appConfig = process.env.PLAYWRIGHT_APP_CONFIG || process.env.APP_CONFIG || 'config/e2e.js';
const baseURL = process.env.PLAYWRIGHT_BASE_URL || `http://localhost:${playwrightPort}`;
const useManagedWebServer = !process.env.PLAYWRIGHT_BASE_URL;

export default defineConfig({
  testDir: './tests',
  fullyParallel: !!process.env.CI,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 3 : 0,
  workers: process.env.CI ? 8 : undefined,
  snapshotPathTemplate: './tests/screenshots{/projectName}/{testFilePath}/{arg}{ext}',
  outputDir: './tests/test-results',
  reporter: [[process.env.CI ? 'blob' : 'html', { outputFolder: './tests/playwright-report' }]],
  globalTimeout: 800_000,
  timeout: 800_000,
  use: {
    baseURL,
    trace: 'on-first-retry',
    video: 'on',
    testIdAttribute: 'data-cy',
    actionTimeout: 10_000,
  },

  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'], deviceScaleFactor: 1 },
    },
    // TODO: Fix firefox tests
    // {
    //  name: 'firefox',
    //  use: { ...devices['Desktop Firefox'], deviceScaleFactor: 1 },
    // },
    // This is commented out until SharedArrayBuffer is enabled in WebKit
    // See: https://github.com/microsoft/playwright/issues/14043

    //{
    //  name: 'webkit',
    //  use: { ...devices['Desktop Safari'], deviceScaleFactor: 1 },
    //},
  ],
  webServer: useManagedWebServer
    ? {
        command: `cross-env OHIF_PORT=${playwrightPort} APP_CONFIG=${appConfig} COVERAGE=true nyc yarn start`,
        url: `http://localhost:${playwrightPort}`,
        reuseExistingServer: !process.env.CI,
        timeout: 360_000,
      }
    : undefined,
});
