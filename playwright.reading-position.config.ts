import { defineConfig } from '@playwright/test';
import base from './playwright.config';
/** Isolated synthetic BrowserStore, no vault access or reused sessions. */
export default defineConfig({
  ...base,
  testMatch: ['**/reading-position.spec.ts', '**/eink*.spec.ts', '**/reader.spec.ts', '**/reader-queue-shortcuts.spec.ts'],
  use: { ...base.use, baseURL: 'http://127.0.0.1:5217' },
  projects: [{ name: 'position-chromium', use: { browserName: 'chromium' } }],
  webServer: {
    command: 'npm run preview -- --host 127.0.0.1 --port 5217 --strictPort',
    url: 'http://127.0.0.1:5217', reuseExistingServer: false, timeout: 30_000,
  },
});
