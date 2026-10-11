import { constants } from 'node:fs';
import { lstat, mkdir, open, readdir, realpath } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const repository = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export const sandboxPath = join(repository, '.sandbox');
for (const legacy of ['READER2_RUNTIME_TARGET', 'PULLMAN_RUNTIME_TARGET']) {
  if (process.env[legacy] !== undefined) throw new Error(`Use READER_RUNTIME_TARGET; ${legacy} is not accepted`);
}
export const runtimeTarget = process.env.READER_RUNTIME_TARGET ?? 'default';
if (!['default', 'acceptance'].includes(runtimeTarget)) throw new Error('Only fixed default or acceptance runtime targets are allowed');
// Vault names and ownership markers identify existing safety boundaries, not the plugin brand.
export const defaultVaultPath = join(sandboxPath, 'Reader2 Test Vault');
export const vaultPath = runtimeTarget === 'default' ? defaultVaultPath : join(sandboxPath, 'Reader2 Acceptance Vault');
export const pluginId = 'obsidian-reader';
export const pluginFiles = Object.freeze(['main.js', 'manifest.json', 'styles.css']);
export const pluginPath = join(vaultPath, '.obsidian', 'plugins', pluginId);
export const markerName = '.reader2-test-vault.json';
export const ownership = Object.freeze({
  schemaVersion: 1,
  purpose: 'Reader2 synthetic test vault',
  repository,
  vaultPath,
});

export function inside(root, path) {
  const resolved = resolve(path);
  const rel = relative(root, resolved);
  if (rel === '..' || rel.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`) || isAbsolute(rel)) {
    throw new Error(`Path is outside ${root}: ${path}`);
  }
  return resolved;
}

export async function statOrNull(path) {
  try { return await lstat(path); }
  catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}

// Never follow a symlink, including one in any existing ancestor directory.
export async function assertSafePath(path, kind) {
  path = inside(repository, path);
  if (await realpath(repository) !== repository) throw new Error('Symlinked repository paths are not allowed');
  const parents = [];
  for (let current = path; current !== repository; current = dirname(current)) parents.unshift(current);
  for (const current of parents) {
    const stat = await statOrNull(current);
    if (!stat) continue;
    if (stat.isSymbolicLink()) throw new Error(`Refusing symlink: ${current}`);
    if (current !== path || kind === 'directory') {
      if (!stat.isDirectory()) throw new Error(`Expected directory: ${current}`);
    } else if (kind === 'file') {
      if (!stat.isFile() || stat.nlink !== 1) throw new Error(`Expected regular, unlinked file: ${current}`);
    }
  }
}

export async function directory(path) {
  path = inside(repository, path);
  await assertSafePath(path, 'directory');
  if (path !== repository) {
    await directory(dirname(path));
    try { await mkdir(path); }
    catch (error) { if (error.code !== 'EEXIST') throw error; }
  }
  await assertSafePath(path, 'directory');
}

export async function regularFile(path) {
  await assertSafePath(path, 'file');
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.nlink !== 1) throw new Error(`Unsafe file: ${path}`);
    return await handle.readFile();
  } finally { await handle.close(); }
}

export async function createOnly(path, content) {
  // A brand change must not release the original quarantined artifacts either.
  const heldPlugins = [pluginId, 'pullman', 'obsidian-reader2'].map(id => join(defaultVaultPath, '.obsidian', 'plugins', id));
  if (heldPlugins.some(plugin => pluginFiles.some(name => resolve(path) === join(plugin, name))) || resolve(path) === join(defaultVaultPath, '.obsidian', 'community-plugins.json')) {
    const { assertDefaultVaultNotHeld } = await import('./safety-hold.mjs');
    await assertDefaultVaultNotHeld('create/reseed installed Reader artifacts or plugin enablement');
  }
  await assertSafePath(path, 'file');
  await directory(dirname(path));
  let handle;
  try { handle = await open(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600); }
  catch (error) {
    if (error.code !== 'EEXIST') throw error;
    await regularFile(path);
    return false;
  }
  try { await handle.writeFile(content); }
  finally { await handle.close(); }
  return true;
}

export async function assertSafeTree(root) {
  await assertSafePath(root, 'directory');
  for (const entry of await readdir(root, { withFileTypes: true })) {
    const path = join(root, entry.name);
    if (entry.isSymbolicLink()) throw new Error(`Refusing symlink: ${path}`);
    if (entry.isDirectory()) await assertSafeTree(path);
    else await regularFile(path);
  }
}

// Installation/activation only: never adopt a legacy installation or create a second identity.
export async function assertNoLegacyPlugin() {
  const legacyIds = ['pullman', 'obsidian-reader2'];
  for (const id of legacyIds) {
    const legacy = join(vaultPath, '.obsidian/plugins', id);
    await assertSafePath(legacy, 'directory');
    if (await statOrNull(legacy)) throw new Error(`Legacy ${id} plugin exists; explicit migration approval required before installing Reader`);
  }
  const enabledPath = join(vaultPath, '.obsidian/community-plugins.json');
  await assertSafePath(enabledPath, 'file');
  if (await statOrNull(enabledPath)) {
    const enabled = JSON.parse(await regularFile(enabledPath));
    if (!Array.isArray(enabled)) throw new Error('Invalid enabled-plugin list; refusing installation');
    for (const id of legacyIds) {
      if (enabled.includes(id)) throw new Error(`Legacy ${id} plugin is enabled; explicit migration approval required before installing Reader`);
    }
  }
}

export async function assertOwnedVault() {
  await assertSafePath(vaultPath, 'directory');
  const marker = JSON.parse(await regularFile(join(vaultPath, markerName)));
  for (const [key, value] of Object.entries(ownership)) {
    if (marker[key] !== value) throw new Error(`Invalid test vault ownership marker (${key})`);
  }
  await assertSafeTree(vaultPath);
  return marker;
}

export function localDay(date = new Date()) {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}

export function isMain(url) {
  return Boolean(process.argv[1]) && resolve(process.argv[1]) === fileURLToPath(url);
}
