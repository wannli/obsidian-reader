#!/usr/bin/env node
import { assertRuntimeVault, connectToTestVault } from './cdp.mjs';
import { assertNoSafetyHold } from './safety-hold.mjs';
import { disableFixtureFeed } from './runtime-ingestion.mjs';
import { setDummyMode } from './runtime-modes.mjs';
import { scopedNetwork } from './runtime-network.mjs';
import { assertOwnedVault, vaultPath } from './sandbox.mjs';

if (process.argv.length !== 2) throw new Error('Only the fixed marked Reader test vault is allowed');
await assertNoSafetyHold('default-vault UI/testing/restoration entrypoint');
await assertOwnedVault();
const { browser, page } = await connectToTestVault();
let network;
try {
  await assertRuntimeVault(page);
  // Cleanup intentionally does not require unchanged sources: even a stale-build
  // failure must leave live extraction OFF in this exact synthetic vault.
  const mode = await setDummyMode(page, true);
  const feeds = await page.evaluate(() => window.app.plugins.plugins['obsidian-reader'].controller.repository.listFeeds());
  const disabled = [];
  for (const feed of feeds) {
    let url; try { url = new URL(feed.url); } catch { continue; }
    if (url.hostname === '127.0.0.1' && url.pathname.startsWith('/reader-runtime/') && feed.enabled) {
      await disableFixtureFeed(page, { feedURL: feed.url }); disabled.push(feed.path);
    }
  }
  network = await scopedNetwork(page); await network.setOffline(false);
  console.log(JSON.stringify({ vaultPath, useDummyContent: mode.current, disabledControlledFixtureFeeds: disabled, navigatorOnline: true }, null, 2));
} finally { if (network) await network.restore(); await browser.close(); }
