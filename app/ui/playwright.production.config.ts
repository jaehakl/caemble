import { defineConfig, devices } from '@playwright/test'

export default defineConfig({
  testDir: './e2e',
  fullyParallel: false,
  workers: 1,
  reporter: [['list'], ['html', { open: 'never' }]],
  use: {
    baseURL: 'http://127.0.0.1:4273',
    screenshot: 'only-on-failure',
    trace: 'retain-on-failure',
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  webServer: [
    {
      command: 'npm run preview -- --host 127.0.0.1 --port 4273 --strictPort',
      url: 'http://127.0.0.1:4273',
      reuseExistingServer: false,
      timeout: 120_000,
    },
    {
      command: 'npm run preview -- --host 127.0.0.1 --port 4274 --strictPort',
      url: 'http://127.0.0.1:4274/runner.html',
      reuseExistingServer: false,
      timeout: 120_000,
    },
  ],
})
