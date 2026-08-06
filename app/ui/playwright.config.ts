import { defineConfig, devices } from '@playwright/test'

const gpStationE2eApiBaseUrl = process.env.GPSTATION_E2E_API_BASE_URL?.trim()

export default defineConfig({
  testDir: './e2e',
  fullyParallel: false,
  workers: 1,
  reporter: [['list'], ['html', { open: 'never' }]],
  use: {
    baseURL: 'http://127.0.0.1:4173',
    screenshot: 'only-on-failure',
    trace: 'retain-on-failure',
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  webServer: [
    {
      command: 'npm run dev:app -- --port 4173 --host 127.0.0.1',
      url: 'http://127.0.0.1:4173',
      reuseExistingServer: true,
      timeout: 120_000,
      ...(gpStationE2eApiBaseUrl
        ? { env: { VITE_GPSTATION_API_BASE_URL: gpStationE2eApiBaseUrl } }
        : {}),
    },
    {
      command: 'npm run dev:runner -- --port 4174 --host localhost',
      url: 'http://localhost:4174/runner.html',
      reuseExistingServer: true,
      timeout: 120_000,
    },
  ],
})
