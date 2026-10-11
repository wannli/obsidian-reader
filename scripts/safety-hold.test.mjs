import assert from 'node:assert/strict';
import test from 'node:test';
import { cp, mkdir, readdir, rename, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { fixture, snapshot } from './tooling-fixture.mjs';
import { spawnSync } from 'node:child_process';

async function hold(f, value = { schemaVersion: 1, state: 'held', repository: f.root, vaultPath: f.vault }) {
  await mkdir(join(f.root, '.sandbox'), { recursive: true });
  await writeFile(join(f.root, '.sandbox/reader2-safety-hold.json'), typeof value === 'string' ? value : JSON.stringify(value));
}
const load = (f, name) => import(pathToFileURL(join(f.root, 'scripts', name)).href);
async function allHelpers(f) {
  const source = fileURLToPath(new URL('.', import.meta.url));
  for (const name of await readdir(source)) if (name.endsWith('.mjs')) await cp(join(source, name), join(f.root, 'scripts', name));
  await f.enableBuild();
}

test('hold blocks bootstrap/update and low-level restoration of a quarantined main.js', async t => {
  const f = await fixture(t); assert.equal(f.run().status, 0);
  await rename(join(f.plugin, 'main.js'), join(f.root, 'quarantined-main.js'));
  await hold(f); const before = await snapshot(f.vault);
  for (const args of [[], ['--update-plugin']]) {
    const run = f.run('setup-vault.mjs', args); assert.notEqual(run.status, 0); assert.match(run.output, /READER SAFETY HOLD/);
  }
  const { createOnly } = await load(f, 'sandbox.mjs');
  for (const name of ['main.js', 'styles.css', 'manifest.json']) {
    await assert.rejects(createOnly(join(f.plugin, name), 'unsafe replacement'), { code: 'READER_SAFETY_HOLD' });
  }
  for (const id of ['pullman', 'obsidian-reader2']) for (const name of ['main.js', 'styles.css', 'manifest.json']) {
    await assert.rejects(createOnly(join(f.vault, '.obsidian/plugins', id, name), 'unsafe legacy restoration'), { code: 'READER_SAFETY_HOLD' });
  }
  await assert.rejects(createOnly(join(f.vault, '.obsidian/community-plugins.json'), '["obsidian-reader"]'), { code: 'READER_SAFETY_HOLD' });
  assert.deepEqual(await snapshot(f.vault), before);
});

test('enable/reload/session/mode helpers reject before touching CDP, including late finally calls', async t => {
  const f = await fixture(t); await allHelpers(f);
  const guard = await load(f, 'safety-hold.mjs'); await guard.assertNoSafetyHold('initial preflight');
  await hold(f); // Models a hold arriving while an older task is in flight.
  const page = new Proxy({}, { get() { throw new Error('CDP was touched despite the hold'); } });
  const plugin = await load(f, 'runtime-plugin.mjs'), modes = await load(f, 'runtime-modes.mjs');
  const session = await load(f, 'runtime-session.mjs'), commands = await load(f, 'runtime-native.mjs');
  const update = await load(f, 'update-runtime.mjs');
  const calls = [() => plugin.enableReader(page, 'old'), () => plugin.reloadReader(page, 'old'),
    () => plugin.verifyInstalledBuild({}), () => plugin.verifyReader(page, 'old'),
    () => modes.setDummyMode(page, true), () => modes.assertNoRepeatedWrites(page, []),
    () => session.restoreSession(page, {}), () => commands.nativeReaderCommand(page, 'open-reader'),
    () => update.updateRunningTestPlugin(), () => guard.assertNoSafetyHold('finally resume Reader')];
  for (const call of calls) await assert.rejects(call(), { code: 'READER_SAFETY_HOLD' });
});

test('old UI/bootstrap/verification/restoration entrypoints fail closed without changing the vault', async t => {
  const f = await fixture(t); assert.equal(f.run().status, 0); await allHelpers(f); await hold(f);
  const before = await snapshot(f.vault);
  for (const name of ['open-vault.mjs', 'setup-quickadd.mjs', 'update-runtime.mjs', 'show-reader.mjs', 'restore-runtime.mjs',
    'test-obsidian.mjs', 'test-quickadd.mjs', 'test-quickadd-native.mjs', 'verify.mjs']) {
    const result = f.run(name); assert.notEqual(result.status, 0, name); assert.match(result.output, /READER SAFETY HOLD/, name);
  }
  assert.deepEqual(await snapshot(f.vault), before);
});

test('invalid, released-looking and symlinked sentinels cannot bypass the hold', async t => {
  const f = await fixture(t), guard = await load(f, 'safety-hold.mjs');
  for (const value of ['{broken', { schemaVersion: 1, state: 'released', repository: f.root, vaultPath: f.vault }]) {
    await hold(f, value); await assert.rejects(guard.assertNoSafetyHold('enable'), { code: 'READER_SAFETY_HOLD' });
  }
  const path = join(f.root, '.sandbox/reader2-safety-hold.json');
  await rename(path, join(f.root, 'real-hold.json')); await symlink(join(f.root, 'real-hold.json'), path);
  await assert.rejects(guard.assertNoSafetyHold('enable'), { code: 'READER_SAFETY_HOLD' });
});

test('fixed acceptance target cannot bypass protection of the default quarantined vault', async t => {
  const f = await fixture(t); assert.equal(f.run().status, 0);
  await rename(join(f.plugin, 'main.js'), join(f.root, 'quarantined-main.js')); await hold(f);
  const before = await snapshot(f.vault);
  const code = `import assert from 'node:assert/strict';
    import {vaultPath,defaultVaultPath,cdpPort,createOnly} from './scripts/sandbox.mjs';
    import {setupVault} from './scripts/setup-vault.mjs';
    assert.equal(cdpPort,19225); assert.notEqual(vaultPath,defaultVaultPath);
    await setupVault();
    for (const id of ['obsidian-reader', 'pullman', 'obsidian-reader2']) {
      await assert.rejects(createOnly(defaultVaultPath+'/.obsidian/plugins/'+id+'/main.js','unsafe'),{code:'READER_SAFETY_HOLD'});
    }`;
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', code], { cwd: f.root, encoding: 'utf8', env: { ...process.env, READER_RUNTIME_TARGET: 'acceptance' } });
  assert.equal(result.status, 0, result.stderr); assert.deepEqual(await snapshot(f.vault), before);
  const invalid = spawnSync(process.execPath, ['--input-type=module', '-e', "import './scripts/sandbox.mjs'"], { cwd: f.root, encoding: 'utf8', env: { ...process.env, READER_RUNTIME_TARGET: 'personal' } });
  assert.notEqual(invalid.status, 0); assert.match(invalid.stderr, /Only fixed default or acceptance/);
  for (const selector of ['READER2_RUNTIME_TARGET', 'PULLMAN_RUNTIME_TARGET']) {
    for (const value of ['', 'default', 'acceptance', 'personal']) {
      const env = { ...process.env, [selector]: value };
      const obsolete = spawnSync(process.execPath, ['--input-type=module', '-e', "import './scripts/sandbox.mjs'"], { cwd: f.root, encoding: 'utf8', env });
      assert.notEqual(obsolete.status, 0); assert.match(obsolete.stderr, /Use READER_RUNTIME_TARGET/);
      assert.ok(obsolete.stderr.includes(selector));
    }
  }
});

test('renaming cannot bypass a held old or new plugin in the renderer', async t => {
  const f = await fixture(t); await hold(f); const guard = await load(f, 'safety-hold.mjs');
  for (const id of ['obsidian-reader', 'pullman', 'obsidian-reader2']) {
    for (const loaded of [true, false]) {
      const app = { vault: { adapter: { getBasePath: () => f.vault } }, plugins: {
        plugins: loaded ? { [id]: {} } : {}, enabledPlugins: new Set(loaded ? [] : [id]),
      } };
      const page = { evaluate: async (fn, path) => new Function('window', 'path', `return (${fn.toString()})(path)` )({ app }, path) };
      await assert.rejects(guard.assertHeldReaderAbsent(page), /unexpected Reader state/);
    }
  }
});

test('held network cleanup is allowed only with Reader unloaded and disabled', async t => {
  const f = await fixture(t); await hold(f); const guard = await load(f, 'safety-hold.mjs');
  const page = state => ({ evaluate: async (_fn, expected) => { assert.equal(expected, f.vault); return state; } });
  await guard.assertHeldReaderAbsent(page({ loaded: false, enabled: false }));
  for (const state of [{ loaded: true, enabled: false }, { loaded: false, enabled: true }]) {
    await assert.rejects(guard.assertHeldReaderAbsent(page(state)), /unexpected Reader state/);
  }
});
