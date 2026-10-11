import { defineConfig } from '@playwright/test';
import base from './playwright.config';
/** Isolated browser simulation; never opens or mutates an Obsidian vault. */
export default defineConfig({
  ...base,
  testMatch: ['**/eink*.spec.ts'],
  timeout: 60_000,
  use: { ...base.use, baseURL: 'http://127.0.0.1:5198' },
  projects: [{ name: 'eink-chromium', use: { browserName: 'chromium' } }],
  webServer: {
    command: 'npm run preview -- --host 127.0.0.1 --port 5198 --strictPort',
    url: 'http://127.0.0.1:5198',
    reuseExistingServer: true,
    timeout: 30_000,
  },
});
