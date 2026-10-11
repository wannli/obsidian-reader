import { defineConfig } from '@playwright/test';
import base from './playwright.config';

/** Isolated synthetic gate for this storage change; never an Obsidian vault. */
export default defineConfig({
  ...base,
  testMatch: ['**/inline*.spec.ts', '**/metadata-folder.spec.ts'],
  use: { ...base.use, baseURL: 'http://127.0.0.1:5196' },
  webServer: {
    command: 'mise exec -- npm run preview -- --port 5196 --strictPort',
    url: 'http://127.0.0.1:5196',
    reuseExistingServer: false,
    timeout: 30_000,
  },
});
