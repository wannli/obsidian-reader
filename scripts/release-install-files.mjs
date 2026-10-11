import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readdir, rename, rm, rmdir } from 'node:fs/promises';
import { join } from 'node:path';
import { sha256 } from './artifacts.mjs';

// All paths remain inside the supplied sandbox safety boundary. Production uses
// the existing sandbox module; tests supply an isolated copy rooted in a temp dir.
export function releaseInstallFiles(safe) {
  const { vaultPath, sandboxPath, pluginPath, pluginFiles, assertOwnedVault, assertSafePath, regularFile, createOnly, directory } = safe;
  const hashes = async root => {
    const result = {};
    async function walk(folder, prefix = '') {
      await assertSafePath(folder, 'directory');
      for (const item of (await readdir(folder, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
        const name = prefix + item.name, path = join(folder, item.name);
        if (item.isDirectory()) { result[name + '/'] = 'directory'; await walk(path, name + '/'); }
        else result[name] = sha256(await regularFile(path)); // Reject links, devices and hardlinks.
      }
    }
    await walk(root); return result;
  };
  return {
    guard: async () => { await assertOwnedVault(); await safe.assertNoLegacyPlugin(); },
    async lock() {
      const path = join(sandboxPath, 'release-install.lock');
      await assertSafePath(path, 'directory');
      await mkdir(path); // Exclusive; stale locks require human inspection, no force option.
      return async () => { await assertSafePath(path, 'directory'); await rmdir(path); };
    },
    inventory: () => hashes(vaultPath),
    async backup(before) {
      const root = join(sandboxPath, 'backups'); await directory(root);
      const backup = await mkdtemp(join(root, 'reader-release-vault-'));
      const vault = join(backup, 'vault');
      try {
        await directory(vault);
        for (const [name, hash] of Object.entries(before)) {
          if (hash === 'directory') { await directory(join(vault, name)); continue; }
          const bytes = await regularFile(join(vaultPath, name));
          assert.equal(sha256(bytes), hash, `Vault changed while backing up: ${name}`);
          assert.equal(await createOnly(join(vault, name), bytes), true);
        }
        assert.deepEqual(await hashes(vault), before, 'Backup does not match inventory');
        assert.deepEqual(await hashes(vaultPath), before, 'Vault changed during backup');
        await createOnly(join(backup, 'inventory.json'), JSON.stringify(before, null, 2));
        return { path: backup, plugin: join(vault, '.obsidian/plugins/obsidian-reader'), verified: true };
      } catch (error) {
        error.partialBackup = { path: backup, verified: false };
        throw error;
      }
    },
    async stage(files) {
      const root = join(sandboxPath, 'staging'); await directory(root);
      const path = await mkdtemp(join(root, 'reader-release-'));
      try {
        for (const name of pluginFiles) {
          assert.equal(await createOnly(join(path, name), files[name]), true);
          assert.equal(sha256(await regularFile(join(path, name))), sha256(files[name]));
        }
      } catch (error) { await rm(path, { recursive: true, force: true }); throw error; }
      return path;
    },
    async replace(staging, name, oldHash, expectedHash) {
      assert.ok(pluginFiles.includes(name));
      await assertOwnedVault(); await safe.assertNoLegacyPlugin();
      assert.equal(sha256(await regularFile(join(pluginPath, name))), oldHash, `Concurrent plugin edit: ${name}`);
      assert.equal(sha256(await regularFile(join(staging, name))), expectedHash, `Staged artifact changed: ${name}`);
      await assertSafePath(join(pluginPath, name), 'file');
      await rename(join(staging, name), join(pluginPath, name));
    },
    async installed() {
      return Object.fromEntries(await Promise.all(pluginFiles.map(async name => [name, sha256(await regularFile(join(pluginPath, name)))])));
    },
    async cleanup(staging) { await assertSafePath(staging, 'directory'); await rm(staging, { recursive: true, force: true }); },
  };
}
