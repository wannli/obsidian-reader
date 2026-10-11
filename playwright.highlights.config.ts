import { defineConfig } from '@playwright/test';
import base from './playwright.config';

// Opt-in: the default Chromium-only workflow does not require a WebKit install.
// Both projects are browser simulations, never physical iOS acceptance.
export default defineConfig({
  ...base,
  testMatch: '**/highlight-paint*.spec.ts',
  use: { ...base.use, viewport: { width: 390, height: 844 }, deviceScaleFactor: 1,
    isMobile: true, hasTouch: true },
  projects: [
    { name: 'highlight-chromium', use: { browserName: 'chromium' } },
    { name: 'highlight-webkit', use: { browserName: 'webkit' } },
  ],
});
