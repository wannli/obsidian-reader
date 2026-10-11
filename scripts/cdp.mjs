import { chromium } from '@playwright/test';
import { setTimeout as delay } from 'node:timers/promises';
import { cdpURL, markerName, ownership, vaultPath } from './sandbox.mjs';

// Only read-only discovery is permitted before this guard succeeds. Never create
// a context/page, navigate an unknown renderer, enable plugins, or open a vault.
export async function connectToTestVault(timeout = 30_000) {
  const browser = await chromium.connectOverCDP(cdpURL, { timeout });
  try {
    const deadline = Date.now() + timeout;
    let candidates = [];
    do {
      candidates = browser.contexts().flatMap(context => context.pages())
        .filter(page => page.url().startsWith('app://obsidian.md/'));
      if (candidates.length) break;
      await delay(250);
    } while (Date.now() < deadline);
    if (!candidates.length) throw new Error(`No actual Obsidian renderer at ${cdpURL}; run npm run vault:open`);
    for (const page of candidates) await verifyVaultPage(page, timeout);
    return { browser, page: candidates[0], verifiedVault: vaultPath };
  } catch (error) {
    // A CDP-connected browser close disconnects our client, not the existing app.
    await browser.close();
    throw error;
  }
}

export async function verifyVaultPage(page, timeout = 30_000) {
  await page.waitForFunction(() => typeof window.app?.vault?.adapter?.getBasePath === 'function', undefined, { timeout });
  const actual = await page.evaluate(() => window.app.vault.adapter.getBasePath());
  if (actual !== vaultPath) throw new Error(`REFUSING unexpected vault: ${JSON.stringify(actual)}; expected ${vaultPath}`);
  const marker = await page.evaluate(async name => JSON.parse(await window.app.vault.adapter.read(name)), markerName);
  for (const [key, value] of Object.entries(ownership)) {
    if (marker[key] !== value) throw new Error(`REFUSING invalid runtime ownership marker (${key})`);
  }
}

export async function assertRuntimeVault(page) {
  const actual = await page.evaluate(() => window.app?.vault?.adapter?.getBasePath?.());
  if (actual !== vaultPath) throw new Error(`REFUSING unexpected vault: ${JSON.stringify(actual)}`);
}
