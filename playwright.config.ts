import { defineConfig, devices } from '@playwright/test';
import { lstatSync, realpathSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(fileURLToPath(import.meta.url));
const evidence = join(root, '.sandbox', 'evidence', 'browser');
if (realpathSync(root) !== root) throw new Error('Refusing a symlinked project path');
for (let path = evidence; path !== root; path = dirname(path)) {
  try {
    const stat = lstatSync(path);
    if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error(`Unsafe browser evidence directory: ${path}`);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
}
const run = join(evidence, new Date().toISOString().replaceAll(':', '-') + '-' + process.pid);

export default defineConfig({
  testDir: './tests',
  testMatch: '**/*.spec.ts',
  fullyParallel: false,
  workers: 1,
  forbidOnly: Boolean(process.env.CI),
  retries: 0,
  timeout: 30_000,
  expect: { timeout: 10_000 },
  outputDir: join(run, 'artifacts'),
  reporter: [['list'], ['html', { outputFolder: join(run, 'report'), open: 'never' }]],
  use: {
    baseURL: 'http://127.0.0.1:5184',
    screenshot: 'only-on-failure',
    trace: 'retain-on-failure',
  },
  projects: [
    { name: 'desktop-chromium', use: { ...devices['Desktop Chrome'] } },
    // Mobile viewport is browser simulation, NOT native iOS acceptance.
    { name: 'mobile-chromium', use: { ...devices['iPhone 13'], defaultBrowserType: 'chromium' } },
  ],
  webServer: {
    command: 'npm run preview -- --strictPort',
    url: 'http://127.0.0.1:5184',
    reuseExistingServer: !process.env.CI,
    timeout: 30_000,
  },
});
