import assert from 'node:assert/strict';
import { assertRuntimeVault } from './cdp.mjs';
import { assertHeldReaderAbsent } from './safety-hold.mjs';

// Renderer-local network emulation changes navigator.onLine and emits the host
// events. It never disables the machine's network or another Obsidian profile.
// Native requestUrl is not assumed to obey Chromium's offline transport flag.
export async function scopedNetwork(page) {
  await assertRuntimeVault(page);
  const session = await page.context().newCDPSession(page);
  await session.send('Network.enable');
  let offline = false;
  async function setOffline(value) {
    await assertHeldReaderAbsent(page);
    await assertRuntimeVault(page);
    await session.send('Network.emulateNetworkConditions', { offline: value, latency: 0, downloadThroughput: -1, uploadThroughput: -1 });
    offline = value;
    await page.waitForFunction(expected => navigator.onLine === expected, !value);
    assert.equal(await page.evaluate(() => navigator.onLine), !value);
  }
  async function restore() {
    if (offline) await setOffline(false);
    await session.detach();
  }
  return { setOffline, restore };
}
