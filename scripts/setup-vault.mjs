#!/usr/bin/env node
import { mkdtemp, readdir, rename, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { readBuild } from './artifacts.mjs';
import { assertNoSafetyHold } from './safety-hold.mjs';
import { seedFiles, seedSidecarPath } from './seed.mjs';
import { assertNoLegacyPlugin, assertOwnedVault, assertSafePath, createOnly, directory, isMain, markerName, ownership, pluginFiles, pluginPath, regularFile, sandboxPath, statOrNull, vaultPath } from './sandbox.mjs';

export { repository, vaultPath } from './sandbox.mjs';

export async function setupVault() {
  await assertNoSafetyHold('vault bootstrap/setup');
  await assertNoLegacyPlugin();
  const build = await readBuild();
  await assertSafePath(vaultPath, 'directory');
  if (await statOrNull(vaultPath)) {
    if (await statOrNull(join(vaultPath, markerName))) await assertOwnedVault();
    else if ((await readdir(vaultPath)).length) throw new Error('Refusing an unmarked, nonempty vault. Never adopt or overwrite a personal vault.');
  }
  const seeds = {
    [markerName]: `${JSON.stringify(ownership, null, 2)}\n`,
    ...seedFiles(),
    ...Object.fromEntries(pluginFiles.map(name => [`.obsidian/plugins/obsidian-reader/${name}`, build.files[name]])),
  };
  // Validate every existing destination before creating even the ownership marker.
  for (const path of Object.keys(seeds)) await assertSafePath(join(vaultPath, path), 'file');
  // Never reseed a missing note over surviving legacy state. JSON is not a seed
  // destination or authority here; only verified startup conversion may retire it.
  const preservePairs = new Set();
  for (const path of Object.keys(seeds).filter(path => /^Reading\/.*\.md$/.test(path))) {
    const current = seedSidecarPath(path);
    for (const relative of [current, current.replace('Reading/Metadata/', 'Reading/Pullman Metadata/')]) {
      await assertSafePath(join(vaultPath, relative), 'file');
      if (await statOrNull(join(vaultPath, relative))) preservePairs.add(path);
    }
  }
  const created = [], preserved = [];
  for (const [relative, content] of Object.entries(seeds)) {
    if (preservePairs.has(relative)) { preserved.push(relative); continue; }
    const added = await createOnly(join(vaultPath, relative), content);
    (added ? created : preserved).push(relative);
  }
  await assertOwnedVault();
  const result = { vaultPath, mode: 'create-only', availableBuildId: build.metadata.buildId, created, preserved };
  console.log(JSON.stringify(result, null, 2));
  return result;
}

export async function updatePlugin() {
  await assertNoSafetyHold('vault plugin update');
  await assertNoLegacyPlugin();
  // No setup/seed operation here: update is restricted to these three artifacts.
  await assertOwnedVault();
  const build = await readBuild();
  const originals = {};
  for (const name of pluginFiles) originals[name] = await regularFile(join(pluginPath, name));
  const backups = join(sandboxPath, 'backups');
  const stagingRoot = join(sandboxPath, 'staging');
  await assertSafePath(backups, 'directory');
  await assertSafePath(stagingRoot, 'directory');
  await directory(backups);
  const backup = await mkdtemp(join(backups, 'reader-plugin-'));
  // The backup directory contains ONLY the three original plugin files.
  for (const name of pluginFiles) await createOnly(join(backup, name), originals[name]);
  console.log(`Original plugin files backed up to ${backup}`);
  await directory(stagingRoot);
  const staging = await mkdtemp(join(stagingRoot, 'reader-plugin-'));
  try {
    for (const name of pluginFiles) await createOnly(join(staging, name), build.files[name]);
    await assertOwnedVault();
    for (const name of pluginFiles) {
      // A concurrent edit should not be silently overwritten.
      if (!(await regularFile(join(pluginPath, name))).equals(originals[name])) throw new Error(`Plugin changed during update: ${name}`);
    }
    for (const name of pluginFiles) {
      await assertSafePath(join(pluginPath, name), 'file');
      await assertNoSafetyHold('install staged Reader artifact');
      await assertNoLegacyPlugin();
      await rename(join(staging, name), join(pluginPath, name));
    }
  } finally { await rm(staging, { recursive: true, force: true }); }
  const result = { vaultPath, mode: 'update-plugin', buildId: build.metadata.buildId, backup, updated: [...pluginFiles] };
  console.log(JSON.stringify(result, null, 2));
  return result;
}

if (isMain(import.meta.url)) {
  const args = process.argv.slice(2);
  if (args.length === 0) await setupVault();
  else if (args.length === 1 && args[0] === '--update-plugin') await updatePlugin();
  else throw new Error('Only --update-plugin is accepted. The synthetic test vault path is fixed; no personal vault paths are accepted.');
}
