#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { createConnection } from 'node:net';
import { readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { sha256 } from './artifacts.mjs';
import { connectToTestVault } from './cdp.mjs';
import { setupVault } from './setup-vault.mjs';
import { assertNoSafetyHold } from './safety-hold.mjs';
import { assertOwnedVault, assertSafePath, cdpPort, cdpURL, createOnly, directory, isMain, ownership, profilePath, regularFile, statOrNull, vaultPath } from './sandbox.mjs';

async function portIsOpen() {
  return new Promise((resolve, reject) => {
    const socket = createConnection({ host: '127.0.0.1', port: cdpPort });
    socket.once('connect', () => { socket.destroy(); resolve(true); });
    socket.once('error', error => {
      socket.destroy();
      if (error.code === 'ECONNREFUSED') resolve(false); else reject(error);
    });
    socket.setTimeout(1500, () => { socket.destroy(); reject(new Error(`Cannot determine ownership of CDP port ${cdpPort}`)); });
  });
}

async function prepareProfile() {
  await assertSafePath(profilePath, 'directory');
  const markerPath = join(profilePath, '.reader2-profile.json');
  if (await statOrNull(profilePath) && !(await statOrNull(markerPath)) && (await readdir(profilePath)).length) {
    throw new Error(`Refusing an unmarked, nonempty profile: ${profilePath}`);
  }
  await directory(profilePath);
  await createOnly(markerPath, `${JSON.stringify(ownership, null, 2)}\n`);
  const marker = JSON.parse(await regularFile(markerPath));
  for (const [key, value] of Object.entries(ownership)) if (marker[key] !== value) throw new Error(`Invalid profile ownership (${key})`);
  const configPath = join(profilePath, 'obsidian.json');
  await createOnly(configPath, `${JSON.stringify({ vaults: { [sha256(vaultPath).slice(0, 16)]: { path: vaultPath, ts: Date.now(), open: true } } }, null, 2)}\n`);
  const config = JSON.parse(await regularFile(configPath));
  const vaults = Object.values(config.vaults ?? {});
  if (vaults.length !== 1 || vaults[0].path !== vaultPath || vaults[0].open !== true) {
    throw new Error('Isolated profile must contain only the exact Reader test vault, marked open. Existing profile config was not modified.');
  }
}

export async function openVault() {
  await assertNoSafetyHold('open/bootstrap default test vault');
  if (process.platform !== 'darwin') throw new Error('This launcher supports macOS /Applications/Obsidian.app only');
  if (await portIsOpen()) {
    await assertOwnedVault();
    const { browser } = await connectToTestVault(10_000);
    await browser.close();
    console.log(`Already running the verified test vault at ${cdpURL}; no app launched or restarted.`);
    return;
  }
  const processes = spawnSync('/bin/ps', ['-axo', 'command='], { encoding: 'utf8' });
  if (processes.status !== 0) throw new Error('Could not check for an already-running isolated profile');
  if (processes.stdout.includes(`--user-data-dir=${profilePath}`)) {
    throw new Error('The isolated profile is already running without its CDP port. No restart attempted; close that test instance manually if needed.');
  }
  await setupVault();
  await prepareProfile();
  const result = spawnSync('/usr/bin/open', [
    '-n', '-a', '/Applications/Obsidian.app', '--args',
    `--user-data-dir=${profilePath}`, '--remote-debugging-address=127.0.0.1', `--remote-debugging-port=${cdpPort}`,
  ], { stdio: 'inherit' });
  if (result.error || result.status !== 0) throw new Error(`Could not launch isolated Obsidian: ${result.error?.message ?? result.status}`);
  console.log(`Launched a NEW isolated Obsidian profile at ${profilePath}; existing app sessions were not touched.`);
  for (let attempt = 0; attempt < 60; attempt++) {
    if (await portIsOpen()) {
      const { browser } = await connectToTestVault(30_000);
      await browser.close();
      console.log(`Verified ${vaultPath} on ${cdpURL}. Run npm run test:obsidian.`);
      return;
    }
    await delay(500);
  }
  throw new Error(`CDP ${cdpPort} did not start. No app will be killed or restarted automatically.`);
}

if (isMain(import.meta.url)) {
  if (process.argv.length !== 2) throw new Error('No arguments accepted; vault, profile, and CDP port are fixed');
  await openVault();
}
