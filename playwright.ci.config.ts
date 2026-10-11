import { defineConfig } from '@playwright/test';
import base from './playwright.config';

const port = Number(process.env.READER_BROWSER_PORT ?? 5190);
if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error('Invalid isolated browser port');
const url = `http://127.0.0.1:${port}`;

/** Deliberately scoped synthetic UI gates; never connect to an Obsidian vault. */
export default defineConfig({
  ...base,
  // Parallelize independent files/projects without running tests inside a file concurrently.
  workers: 2,
  testMatch: [
    '**/reader.spec.ts', '**/reading-position.spec.ts', '**/reader-queue-shortcuts.spec.ts',
    '**/mobile-queue-navigation.spec.ts', '**/mobile-reading-finish.spec.ts', '**/branding.spec.ts', '**/inline*.spec.ts',
    '**/metadata-folder.spec.ts', '**/eink*.spec.ts', '**/highlight-paint*.spec.ts',
  ],
  use: { ...base.use, baseURL: url },
  webServer: {
    command: `mise exec -- npm run preview -- --port ${port} --strictPort`,
    url,
    reuseExistingServer: false,
    timeout: 30_000,
  },
});
