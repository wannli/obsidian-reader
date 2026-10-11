import assert from 'node:assert/strict';
import test from 'node:test';
import { cp, link, mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { sha256 } from './artifacts.mjs';
import { assertInstallAuthorization, installRelease, installVerifiedRelease, originalRepository } from './release-install.mjs';
import { releaseInstallFiles } from './release-install-files.mjs';

const source = dirname(fileURLToPath(import.meta.url));
function request() {
  const version = '0.1.9';
  const manifest = Buffer.from(JSON.stringify({ id: 'obsidian-reader', name: 'Reader', version, minAppVersion: '1.8.7', description: 'Reader', author: 'Author', isDesktopOnly: false }));
  const styles = Buffer.from('.reader {}'), bundled = Buffer.from('throw new Error("Fixture must never execute");\n');
  const buildId = sha256(Buffer.concat([bundled, manifest, styles]));
  const files = { 'main.js': Buffer.concat([bundled, Buffer.from(`\nObject.defineProperty(module.exports.default ?? module.exports, '__readerBuildId', { value: "${buildId}" });\n`)]), 'manifest.json': manifest, 'styles.css': styles };
  return { install: true, repo: 'wannli/obsidian-reader', expectedSha: 'a'.repeat(40), commit: 'a'.repeat(40), version, buildId, files,
    assets: Object.entries(files).map(([name, bytes]) => ({ name, size: bytes.length, digest: 'sha256:' + sha256(bytes) })) };
}
async function fixture(t, hooks = {}) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'release-install-test-')));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, 'scripts'));
  for (const name of ['sandbox.mjs', 'safety-hold.mjs']) await cp(join(source, name), join(root, 'scripts', name));
  const safe = await import(pathToFileURL(join(root, 'scripts/sandbox.mjs')).href);
  await mkdir(safe.pluginPath, { recursive: true });
  await writeFile(join(safe.vaultPath, safe.markerName), JSON.stringify(safe.ownership));
  for (const name of safe.pluginFiles) await writeFile(join(safe.pluginPath, name), 'old-' + name);
  await writeFile(join(safe.pluginPath, 'data.json'), '{"keep":true}');
  await writeFile(join(safe.vaultPath, 'Note.md'), '# Authored note\n');
  await mkdir(join(safe.vaultPath, 'Empty'));
  const storage = releaseInstallFiles(safe), events = [], req = request();
  const wrapped = Object.fromEntries(Object.entries(storage).map(([name, fn]) => [name, async (...args) => {
    events.push(name); if (hooks[name]) await hooks[name](...args);
    return fn(...args);
  }]));
  const runtime = {
    guard: async () => {}, capture: async () => ({ settings: { keep: true } }),
    unload: async () => { events.push('unload'); },
    activate: async () => { events.push('activate'); assert.ok(events.includes('backup')); await hooks.activate?.(safe); },
    verify: async () => { await hooks.verify?.(); return { buildId: req.buildId, manifest: { version: req.version } }; },
    restore: async () => { await hooks.restore?.(); return { settingsPreserved: true }; },
    assertClean: async () => {}, resume: async () => { events.push('resume'); }, close: async () => { events.push('close'); },
  };
  return { root, safe, storage, events, req, runtime, run: () => installVerifiedRelease(req, { storage: wrapped, connect: async () => runtime }) };
}

test('production authorization requires explicit install/SHA/repo/original checkout/Acceptance', async () => {
  const req = request(), context = { repository: originalRepository, runtimeTarget: 'acceptance', vaultPath: originalRepository + '/.sandbox/Reader2 Acceptance Vault' };
  assertInstallAuthorization(req, context);
  for (const changes of [{ install: false }, { expectedSha: undefined }, { repo: 'other/reader' }, { commit: 'b'.repeat(40) }])
    assert.throws(() => assertInstallAuthorization({ ...req, ...changes }, context));
  for (const changes of [{ runtimeTarget: 'default' }, { repository: originalRepository + '-worktree' }, { vaultPath: '/personal' }])
    assert.throws(() => assertInstallAuthorization(req, { ...context, ...changes }));
  // Fails before any runtime imports or live-vault inspection in this worktree.
  await assert.rejects(installRelease({ ...req, repo: 'not/authorized' }), /only permits/);
});

test('installs downloaded bytes after verified full backup; preserves settings/notes, then verifies runtime', async t => {
  const f = await fixture(t), before = await f.storage.inventory();
  const result = await f.run();
  assert.equal(result.status, 'installed');
  assert.equal(result.settingsPreserved, true);
  assert.equal(result.loadedBuildId, f.req.buildId);
  assert.ok(f.events.indexOf('unload') < f.events.indexOf('backup'));
  assert.ok(f.events.indexOf('backup') < f.events.indexOf('replace'));
  assert.ok(f.events.indexOf('replace') < f.events.indexOf('activate'));
  for (const name of f.safe.pluginFiles) {
    assert.deepEqual(await readFile(join(f.safe.pluginPath, name)), f.req.files[name]);
    assert.equal((await readFile(join(result.backup.plugin, name))).toString(), 'old-' + name);
  }
  assert.equal((await readFile(join(result.backup.path, 'vault/Note.md'))).toString(), '# Authored note\n');
  assert.deepEqual(JSON.parse(await readFile(join(result.backup.path, 'inventory.json'))), before);
  assert.equal((await readFile(join(f.safe.pluginPath, 'data.json'))).toString(), '{"keep":true}');
});

for (const legacy of ['pullman', 'obsidian-reader2']) for (const identity of ['installed', 'enabled']) test(`legacy ${legacy} blocks release install without mutation: ` + identity, async t => {
  const f = await fixture(t);
  if (identity === 'installed') await mkdir(join(f.safe.vaultPath, '.obsidian/plugins', legacy));
  else await writeFile(join(f.safe.vaultPath, '.obsidian/community-plugins.json'), JSON.stringify([legacy]));
  const before = await f.storage.inventory();
  await assert.rejects(f.run(), /Legacy (?:pullman|obsidian-reader2) plugin/);
  assert.deepEqual(f.events, ['guard']);
  assert.deepEqual(await f.storage.inventory(), before);
});

test('invalid marker, symlink or hardlink fails before runtime connection/mutation', async t => {
  for (const kind of ['marker', 'symlink', 'hardlink']) {
    const f = await fixture(t);
    if (kind === 'marker') await writeFile(join(f.safe.vaultPath, f.safe.markerName), '{}');
    else if (kind === 'symlink') await symlink(join(f.safe.vaultPath, 'Note.md'), join(f.safe.vaultPath, 'unsafe'));
    else await link(join(f.safe.vaultPath, 'Note.md'), join(f.safe.vaultPath, 'unsafe'));
    await assert.rejects(f.run());
    assert.equal(f.events.includes('unload'), false);
    assert.equal((await readFile(join(f.safe.pluginPath, 'main.js'))).toString(), 'old-main.js');
  }
});

test('backup failure and concurrent changes prevent installation and never activate', async t => {
  for (const failure of ['backup', 'stage']) {
    const f = await fixture(t, { [failure]: async () => { throw new Error('fixture failure'); } });
    await assert.rejects(f.run(), error => {
      assert.equal(error.installation.leftUnloaded, true); assert.equal(error.installation.replaced.length, 0); return true;
    });
    assert.equal(f.events.includes('activate'), false);
  }
  const f = await fixture(t);
  const backup = f.storage.backup;
  const storage = { ...f.storage, backup: async before => {
    const result = await backup(before); await writeFile(join(f.safe.vaultPath, 'Note.md'), 'concurrent edit'); return result;
  } };
  await assert.rejects(installVerifiedRelease(f.req, { storage, connect: async () => f.runtime }), /Vault changed after backup/);
  assert.equal(f.events.includes('activate'), false);
});

test('partial replace and runtime failure retain backups and fail closed without automatic rollback', async t => {
  let count = 0;
  const f = await fixture(t, { replace: async () => { if (++count === 2) throw new Error('rename failed'); } });
  await assert.rejects(f.run(), error => {
    assert.deepEqual(error.installation.replaced, ['main.js']); assert.ok(error.installation.backup.verified); return true;
  });
  assert.equal(f.events.includes('activate'), false);
  for (const failure of ['activate', 'verify', 'restore']) {
    const f = await fixture(t, { [failure]: async () => { throw new Error('runtime failure'); } });
    await assert.rejects(f.run(), error => { assert.equal(error.installation.leftUnloaded, true); return true; });
    assert.equal(f.events.includes('resume'), false);
  }
});

test('conversion changes are surfaced with backup; settings mutations are failures', async t => {
  const f = await fixture(t, { activate: async safe => { await writeFile(join(safe.vaultPath, 'Note.md'), '# Converted note\n'); } });
  const result = await f.run();
  assert.equal(result.status, 'installed-with-note-changes');
  assert.equal(result.noteChanges[0].path, 'Note.md');
  const bad = await fixture(t, { activate: async safe => { await writeFile(join(safe.pluginPath, 'data.json'), '{}'); } });
  await assert.rejects(bad.run(), /settings or unrelated plugins changed/);
  assert.equal(bad.events.includes('resume'), false);
});

test('invalid downloaded bytes and disabled/dirty session fail before unload', async t => {
  const f = await fixture(t); f.req.files['styles.css'][0] ^= 1;
  await assert.rejects(f.run(), /digest mismatch/); assert.equal(f.events.length, 0);
  const dirty = await fixture(t); dirty.runtime.capture = async () => { throw new Error('dirty/disabled fixture'); };
  await assert.rejects(dirty.run(), /dirty\/disabled/); assert.equal(dirty.events.includes('unload'), false);
});
