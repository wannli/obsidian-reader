import { mkdtemp, rename, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { assertNoSafetyHold } from './safety-hold.mjs';
import {
  assertNoLegacyPlugin,
  assertOwnedVault,
  assertSafePath,
  createOnly,
  directory,
  pluginId,
  pluginPath,
  regularFile,
  statOrNull,
  vaultPath,
} from './sandbox.mjs';

export const hotReloadVersion = '0.3.1';
const json = (value) => `${JSON.stringify(value, null, 2)}\n`;
const configuration = join(vaultPath, '.obsidian');
const hotReloadPath = join(configuration, 'plugins', 'hot-reload');

async function assertTarget() {
  await assertNoSafetyHold('development build/Hot Reload setup');
  await assertOwnedVault();
  await assertNoLegacyPlugin();
}

function validateHotReload(files) {
  const manifest = JSON.parse(files['manifest.json']);
  if (
    manifest.id !== 'hot-reload' ||
    manifest.version !== hotReloadVersion ||
    !files['main.js'].length
  ) {
    throw new Error('Unexpected or incomplete Hot Reload installation');
  }
}

async function installedHotReload() {
  const files = {};
  for (const name of ['manifest.json', 'main.js'])
    files[name] = await regularFile(join(hotReloadPath, name));
  validateHotReload(files);
}

export async function assertDevelopmentVault() {
  await assertTarget();
  await regularFile(join(pluginPath, '.hotreload'));
  await installedHotReload();
  const manifest = JSON.parse(await regularFile(join(pluginPath, 'manifest.json')));
  if (manifest.id !== pluginId) throw new Error('Unexpected installed development plugin');
}

async function download(name) {
  const url = `https://github.com/pjeby/hot-reload/releases/download/${hotReloadVersion}/${name}`;
  const response = await fetch(url, { signal: AbortSignal.timeout(15_000) });
  if (!response.ok) throw new Error(`Hot Reload download failed (${response.status}): ${name}`);
  return Buffer.from(await response.arrayBuffer());
}

// Explicit setup only. Builds never download, seed notes, or enable plugins.
export async function setupHotReload({ fetchAsset = download } = {}) {
  await assertTarget();
  const enabledPath = join(configuration, 'community-plugins.json');
  const appPath = join(configuration, 'app.json');
  const enabledBytes = await regularFile(enabledPath),
    appBytes = await regularFile(appPath);
  const enabled = JSON.parse(enabledBytes),
    app = JSON.parse(appBytes);
  if (!Array.isArray(enabled) || enabled.some((id) => typeof id !== 'string'))
    throw new Error('Invalid enabled-plugin list');
  if (!app || typeof app !== 'object' || Array.isArray(app))
    throw new Error('Invalid vault app configuration');
  const fresh = !(await statOrNull(hotReloadPath));
  let files;
  if (fresh) {
    files = Object.fromEntries(
      await Promise.all(
        ['manifest.json', 'main.js'].map(async (name) => [name, await fetchAsset(name)]),
      ),
    );
    validateHotReload(files);
  } else await installedHotReload();
  // The download may take time; recheck ownership and both configuration revisions.
  await assertTarget();
  if (
    !(await regularFile(enabledPath)).equals(enabledBytes) ||
    !(await regularFile(appPath)).equals(appBytes)
  ) {
    throw new Error('Vault configuration changed during Hot Reload setup; retry');
  }
  if (fresh) {
    await assertSafePath(hotReloadPath, 'directory');
    if (await statOrNull(hotReloadPath))
      throw new Error('Hot Reload installation appeared during setup; retry');
    const staging = await mkdtemp(join(configuration, 'plugins', '.hot-reload-'));
    try {
      for (const [name, bytes] of Object.entries(files))
        await createOnly(join(staging, name), bytes);
      await assertTarget();
      await rename(staging, hotReloadPath);
    } finally {
      await rm(staging, { recursive: true, force: true });
    }
  }
  await createOnly(join(pluginPath, '.hotreload'), '');
  const nextEnabled = [...enabled];
  for (const id of ['hot-reload', pluginId]) if (!nextEnabled.includes(id)) nextEnabled.push(id);
  const updates = [
    [enabledPath, enabledBytes, Buffer.from(json(nextEnabled))],
    [appPath, appBytes, Buffer.from(json({ ...app, safeMode: false }))],
  ].filter(([, old, next]) => !old.equals(next));
  if (updates.length) {
    await directory(configuration);
    const staging = await mkdtemp(join(configuration, '.hot-reload-config-'));
    try {
      for (const [i, [, , bytes]] of updates.entries())
        await createOnly(join(staging, String(i)), bytes);
      for (const [i, [path, old]] of updates.entries()) {
        await assertTarget();
        if (!(await regularFile(path)).equals(old))
          throw new Error('Vault configuration changed during setup; retry');
        await rename(join(staging, String(i)), path);
      }
    } finally {
      await rm(staging, { recursive: true, force: true });
    }
  }
  await assertDevelopmentVault();
  console.log(`Hot Reload ${hotReloadVersion} ready: ${vaultPath}`);
}
