import { defineConfig, devices } from '@playwright/test';
export default defineConfig({
  testDir: './apps/dashboard/test/e2e', timeout: 30000, workers: 1, reporter: 'list',
  outputDir: './.local/playwright-results',
  use: { headless: true, trace: 'retain-on-failure' },
  projects: [
    { name: 'desktop', use: { viewport: { width: 1280, height: 720 } } },
    { name: 'mobile', use: { ...devices['iPhone 13'], defaultBrowserType: 'chromium' } },
  ],
});
