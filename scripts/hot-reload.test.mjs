import test from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { link, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { fixture, snapshot } from './tooling-fixture.mjs';

const succeeds = (result) => assert.equal(result.status, 0, result.output);
function refuses(result, reason) {
  assert.notEqual(result.status, 0, result.output);
  assert.match(result.output, reason);
}

test('Hot Reload setup is offline-testable, idempotent and preserves notes/settings', async (t) => {
  const f = await fixture(t);
  succeeds(f.run());
  const enabled = join(f.vault, '.obsidian/community-plugins.json'),
    app = join(f.vault, '.obsidian/app.json');
  await writeFile(enabled, '["obsidian-reader", "another-plugin"]');
  await writeFile(app, '{"customSetting":42}');
  const before = await snapshot(f.vault);
  succeeds(await f.enableHotReload());
  const after = await snapshot(f.vault);
  for (const [name, entry] of Object.entries(before)) {
    if (!['.obsidian/community-plugins.json', '.obsidian/app.json'].includes(name))
      assert.deepEqual(after[name], entry, name);
  }
  assert.deepEqual(JSON.parse(await readFile(enabled)), [
    'obsidian-reader',
    'another-plugin',
    'hot-reload',
  ]);
  assert.deepEqual(JSON.parse(await readFile(app)), { customSetting: 42, safeMode: false });
  assert.equal((await readFile(join(f.plugin, '.hotreload'))).length, 0);
  succeeds(await f.enableHotReload());
  assert.deepEqual(await snapshot(f.vault), after);
});

test('setup refuses malformed config and unexpected Hot Reload installations without mutation', async (t) => {
  for (const problem of ['app', 'enabled', 'installation']) {
    const f = await fixture(t);
    succeeds(f.run());
    if (problem === 'app') await writeFile(join(f.vault, '.obsidian/app.json'), '[]');
    else if (problem === 'enabled')
      await writeFile(join(f.vault, '.obsidian/community-plugins.json'), '{}');
    else {
      const hot = join(f.vault, '.obsidian/plugins/hot-reload');
      await mkdir(hot);
      await writeFile(join(hot, 'manifest.json'), '{"id":"some-other-plugin"}');
      await writeFile(join(hot, 'main.js'), 'do not replace');
    }
    const before = await snapshot(f.vault);
    refuses(await f.enableHotReload(), /Invalid|Unexpected/);
    assert.deepEqual(await snapshot(f.vault), before);
  }
});

test('failed or invalid downloads do not enable plugins or create a partial installation', async (t) => {
  const f = await fixture(t);
  succeeds(f.run());
  const before = await snapshot(f.vault);
  for (const body of ['throw new Error("offline")', 'return Buffer.from("{}");']) {
    await writeFile(
      join(f.root, 'scripts/failure.mjs'),
      `
      import { setupHotReload } from './hot-reload.mjs';
      await setupHotReload({ fetchAsset: async () => { ${body} } });
    `,
    );
    refuses(f.run('failure.mjs'), /offline|Unexpected/);
    assert.deepEqual(await snapshot(f.vault), before);
  }
});

test('dev requires explicit Hot Reload setup and refuses holds, invalid ownership and symlinks', async (t) => {
  const f = await fixture(t);
  succeeds(f.run());
  await f.enableBuild();
  await writeFile(join(f.root, 'src/main.ts'), 'export default class Reader {}');
  const beforeSetup = await snapshot(f.vault);
  refuses(f.run('dev.mjs'), /ENOENT/);
  assert.deepEqual(await snapshot(f.vault), beforeSetup);
  succeeds(await f.enableHotReload());
  const before = await snapshot(f.vault);
  const hold = join(f.root, '.sandbox/reader2-safety-hold.json');
  await writeFile(
    hold,
    JSON.stringify({ schemaVersion: 1, state: 'held', repository: f.root, vaultPath: f.vault }),
  );
  refuses(f.run('dev.mjs'), /READER SAFETY HOLD/);
  refuses(await f.enableHotReload(), /READER SAFETY HOLD/);
  assert.deepEqual(await snapshot(f.vault), before);
  await rm(hold);
  const marker = join(f.vault, '.reader2-test-vault.json'),
    originalMarker = await readFile(marker);
  await writeFile(marker, '{}');
  const invalid = await snapshot(f.vault);
  refuses(f.run('dev.mjs'), /ownership marker/);
  assert.deepEqual(await snapshot(f.vault), invalid);
  await writeFile(marker, originalMarker);
  const outside = join(f.root, 'outside.js');
  await writeFile(outside, 'untouched');
  await rm(join(f.plugin, 'main.js'));
  await symlink(outside, join(f.plugin, 'main.js'));
  refuses(f.run('dev.mjs'), /symlink/);
  assert.equal(await readFile(outside, 'utf8'), 'untouched');
});

test('build and dev reject missing or unsafe source styles without changing either destination', async (t) => {
  for (const kind of ['missing', 'directory-symlink', 'file-symlink', 'hardlink']) {
    const f = await fixture(t);
    succeeds(f.run());
    succeeds(await f.enableHotReload());
    await f.enableBuild();
    await writeFile(join(f.root, 'src/main.ts'), 'export default class Reader {}');
    const styles = join(f.root, 'src/reader/styles.css'),
      outside = join(f.root, 'outside');
    await mkdir(outside);
    await writeFile(join(outside, 'styles.css'), 'untouched external styles');
    if (kind === 'directory-symlink') {
      await rm(join(f.root, 'src/reader'), { recursive: true });
      await symlink(outside, join(f.root, 'src/reader'), 'dir');
    } else if (kind === 'hardlink') await link(styles, join(outside, 'linked.css'));
    else {
      await rm(styles);
      if (kind === 'file-symlink') await symlink(join(outside, 'styles.css'), styles);
    }
    const vault = await snapshot(f.vault),
      dist = await snapshot(join(f.root, 'dist')),
      external = await snapshot(outside);
    for (const script of ['build.mjs', 'dev.mjs']) {
      refuses(f.run(script), /ENOENT|symlink|unlinked|Unsafe file/);
      assert.deepEqual(await snapshot(f.vault), vault);
      assert.deepEqual(await snapshot(join(f.root, 'dist')), dist);
      assert.deepEqual(await snapshot(outside), external);
    }
  }
});

test('compilation failure preserves the installed working build', async (t) => {
  const f = await fixture(t);
  succeeds(f.run());
  succeeds(await f.enableHotReload());
  await f.enableBuild();
  await writeFile(join(f.root, 'src/main.ts'), 'export default class { broken');
  const before = await snapshot(f.vault);
  refuses(f.run('dev.mjs'), /error|ERROR/);
  assert.deepEqual(await snapshot(f.vault), before);
});
