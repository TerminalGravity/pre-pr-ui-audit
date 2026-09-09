import { defineConfig, devices } from '@playwright/test'

/**
 * The self-test runs against installed Chrome rather than a downloaded Chromium.
 * These probes are DOM geometry measurements — the engine build is immaterial,
 * and not requiring a browser download keeps the self-test runnable anywhere.
 * Override with PW_CHANNEL=chromium once `playwright install` has run.
 */
export default defineConfig({
  testDir: './test',
  reporter: [['list']],
  use: {
    ...devices['Desktop Chrome'],
    channel: process.env.PW_CHANNEL ?? 'chrome',
  },
})
