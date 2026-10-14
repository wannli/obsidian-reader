import test from 'node:test';
import assert from 'node:assert/strict';
import { link, mkdir, readFile, readdir, rename, rm, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseDocument } from 'yaml';
import { seedFiles, seedBody, seedTitle } from './seed.mjs';
import { fixture, snapshot } from './tooling-fixture.mjs';

function succeeds(result) {
  assert.equal(result.status, 0, result.output);
}
function refuses(result, reason) {
  assert.notEqual(result.status, 0, result.output);
  assert.match(result.output, reason);
}

test('setup is create-only, preserves all existing bytes/mtimes, and seeds clean Markdown', async (t) => {
  const f = await fixture(t);
  succeeds(f.run());
  const welcome = join(f.vault, 'Welcome.md');
  await writeFile(welcome, (await readFile(welcome, 'utf8')) + '\nUnrelated user content.\n');
  await writeFile(
    join(f.plugin, 'data.json'),
    '{"root":"Custom Reading","pollMinutes":30,"unrelated":42}',
  );
  await writeFile(join(f.vault, '.obsidian/core-plugins.json'), '["daily-notes","bookmarks"]');
  await writeFile(join(f.vault, '.obsidian/daily-notes.json'), '{"folder":"Journal"}');
  const before = await snapshot(f.vault);
  await f.build('v2');
  succeeds(f.run());
  assert.deepEqual(await snapshot(f.vault), before);
  for (const [name, entry] of Object.entries(before).filter(([name]) => name.endsWith('.md'))) {
    const text = Buffer.from(entry.bytes, 'base64').toString();
    if (/^Reading\/(?:Inbox|Later|Stream|Treasury|Wires)\//.test(name)) {
      const { metadata, body } = parsed(text);
      assert.equal(Object.hasOwn(metadata, 'created-by'), false, name);
      if (name.startsWith('Reading/Wires/')) {
        assert.equal(metadata.type, 'feed', name);
        for (const key of ['id', 'pullmanFormat'])
          assert.equal(Object.hasOwn(metadata, key), false, name);
        assert.equal(metadata.enabled, false, name);
      } else {
        assert.equal(metadata.type, 'article', name);
        assert.ok(body.trim(), name);
        for (const key of [
          'id',
          'guid',
          'pullmanFormat',
          'content',
          'extractor',
          'sourceHash',
          'sourceLength',
        ])
          assert.equal(Object.hasOwn(metadata, key), false, `${name}: ${key}`);
      }
      for (const key of ['highlights', 'queueMove'])
        assert.equal(Object.hasOwn(metadata, key), false, name);
      assert.doesNotMatch(body, /^## (?:Highlights|Article|Comments)$/m, name);
    } else assert.doesNotMatch(text, /^created-by:/m, name);
    assert.ok(!text.includes('<!--'), name);
  }
  assert.deepEqual(
    JSON.parse(await readFile(join(f.vault, '.obsidian', 'community-plugins.json'))),
    ['obsidian-reader'],
  );
});

test('explicit update backs up exactly three plugin files, changing nothing else', async (t) => {
  const f = await fixture(t);
  succeeds(f.run());
  const before = await snapshot(f.vault);
  const replacement = await f.build('v2');
  succeeds(f.run('setup-vault.mjs', ['--update-plugin']));
  const after = await snapshot(f.vault);
  const backups = join(f.root, '.sandbox', 'backups');
  const directories = await readdir(backups);
  assert.equal(directories.length, 1);
  assert.deepEqual(await readdir(join(f.root, '.sandbox', 'staging')), []);
  const backup = join(backups, directories[0]);
  assert.deepEqual((await readdir(backup)).sort(), ['main.js', 'manifest.json', 'styles.css']);
  for (const name of Object.keys(before)) {
    const file = name.split('/').pop();
    if (name.startsWith('.obsidian/plugins/obsidian-reader/') && Object.hasOwn(replacement, file)) {
      assert.equal(Buffer.from(after[name].bytes, 'base64').toString(), replacement[file]);
      assert.equal((await readFile(join(backup, file))).toString('base64'), before[name].bytes);
    } else assert.deepEqual(after[name], before[name], name);
  }
});

test('explicit update publishes matching styles and manifest before main.js', async (t) => {
  const f = await fixture(t);
  succeeds(f.run());
  await f.build('v2');
  // Observe real renames in an isolated child; do not replace the filesystem guards.
  await writeFile(
    join(f.root, 'scripts/update-order-probe.mjs'),
    `
    import assert from 'node:assert/strict';
    import fs from 'node:fs/promises';
    import { syncBuiltinESMExports } from 'node:module';
    import { basename, dirname, join } from 'node:path';
    import { pluginPath, repository } from './sandbox.mjs';
    const rename = fs.rename, published = [];
    fs.rename = async (from, to) => {
      if (dirname(to) === pluginPath) {
        if (basename(to) === 'main.js') for (const name of ['manifest.json', 'styles.css']) {
          assert.deepEqual(await fs.readFile(join(pluginPath, name)), await fs.readFile(join(repository, 'dist', name)));
        }
        published.push(basename(to));
      }
      return rename(from, to);
    };
    syncBuiltinESMExports();
    try {
      const { updatePlugin } = await import('./setup-vault.mjs');
      const result = await updatePlugin();
      assert.deepEqual(published, ['manifest.json', 'styles.css', 'main.js']);
      assert.deepEqual(result.updated, published);
    } finally { fs.rename = rename; syncBuiltinESMExports(); }
  `,
  );
  succeeds(f.run('update-order-probe.mjs'));
});

test('unmarked nonempty vault is never adopted', async (t) => {
  const f = await fixture(t);
  await mkdir(f.vault, { recursive: true });
  await writeFile(join(f.vault, 'Personal.md'), 'do not touch');
  const before = await snapshot(f.vault);
  refuses(f.run(), /unmarked, nonempty vault/);
  assert.deepEqual(await snapshot(f.vault), before);
});

test('ownership marker is checked on repeated setup and update', async (t) => {
  const f = await fixture(t);
  succeeds(f.run());
  await writeFile(
    join(f.vault, '.reader2-test-vault.json'),
    '{"schemaVersion":1,"purpose":"not owned"}',
  );
  const before = await snapshot(f.vault);
  refuses(f.run(), /ownership marker/);
  refuses(f.run('setup-vault.mjs', ['--update-plugin']), /ownership marker/);
  assert.deepEqual(await snapshot(f.vault), before);
});

test('symlinked sandbox or vault is rejected without touching its target', async (t) => {
  for (const location of ['.sandbox', '.sandbox/Reader2 Test Vault']) {
    const f = await fixture(t);
    const outside = join(f.root, 'outside');
    await mkdir(outside);
    await writeFile(join(outside, 'Personal.md'), 'unchanged');
    if (location.includes('/')) await mkdir(join(f.root, '.sandbox'));
    await symlink(outside, join(f.root, location), 'dir');
    refuses(f.run(), /symlink/);
    assert.deepEqual(await readdir(outside), ['Personal.md']);
    assert.equal(await readFile(join(outside, 'Personal.md'), 'utf8'), 'unchanged');
  }
});

test('symlinked plugin files and unrelated symlinks are rejected, not skipped', async (t) => {
  for (const location of ['.obsidian/plugins/obsidian-reader/main.js', 'Unrelated.md']) {
    const f = await fixture(t);
    succeeds(f.run());
    const target = join(f.vault, location),
      outside = join(f.root, 'outside.txt');
    await writeFile(outside, 'unchanged');
    await rm(target, { force: true });
    await symlink(outside, target);
    refuses(f.run(), /symlink/);
    refuses(f.run('setup-vault.mjs', ['--update-plugin']), /symlink/);
    assert.equal(await readFile(outside, 'utf8'), 'unchanged');
  }
});

test('bad distribution identity fails before vault mutation; arbitrary path arguments fail closed', async (t) => {
  const f = await fixture(t);
  await writeFile(join(f.root, 'dist', 'main.js'), 'tampered');
  refuses(f.run(), /does not match build-meta/);
  await assert.rejects(readdir(f.vault), { code: 'ENOENT' });
  refuses(f.run('setup-vault.mjs', ['--vault', '/personal']), /path is fixed/);
  refuses(f.run('setup-vault.mjs', ['--update-plugin', '/personal']), /path is fixed/);
});

test('browser bundle permits only obsidian external, carries identity, and rejects builtins', async (t) => {
  const f = await fixture(t);
  await f.enableBuild();
  await writeFile(join(f.root, 'src', 'type.ts'), 'export class Model {}\n');
  await writeFile(
    join(f.root, 'src', 'main.ts'),
    "import { Plugin } from 'obsidian'; import { Model } from './type'; export default class Reader extends Plugin { declare model: Model; }\n",
  );
  await assert.rejects(readFile(join(f.root, 'styles.css')), { code: 'ENOENT' });
  succeeds(f.run('build.mjs'));
  assert.deepEqual(
    await readFile(join(f.root, 'dist/styles.css')),
    await readFile(join(f.root, 'src/reader/styles.css')),
  );
  const meta = JSON.parse(await readFile(join(f.root, 'dist', 'build-meta.json')));
  assert.deepEqual(meta.external, ['obsidian']);
  assert.equal(meta.platform, 'browser');
  const externals = Object.values(meta.metafile.outputs).flatMap((output) =>
    output.imports.filter((entry) => entry.external).map((entry) => entry.path),
  );
  assert.deepEqual([...new Set(externals)], ['obsidian']);
  assert.deepEqual((await readdir(join(f.root, 'dist'))).sort(), [
    'build-meta.json',
    'main.js',
    'manifest.json',
    'styles.css',
  ]);
  assert.match(await readFile(join(f.root, 'dist', 'main.js'), 'utf8'), /__readerBuildId/);
  const before = await snapshot(join(f.root, 'dist'));
  for (const name of [
    'node:fs',
    'fs',
    'fs/promises',
    'electron',
    'electron/main',
    'node:test',
    'node:unknown-builtin',
  ]) {
    await writeFile(
      join(f.root, 'src', 'main.ts'),
      `import runtime from ${JSON.stringify(name)}; console.log(runtime);\n`,
    );
    refuses(f.run('build.mjs'), /Node\/Electron import is forbidden/);
    assert.deepEqual(await snapshot(join(f.root, 'dist')), before);
  }
});

function parsed(raw) {
  const match = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(raw);
  assert.ok(match);
  const doc = parseDocument(match[1], { uniqueKeys: true });
  assert.deepEqual(doc.errors, []);
  assert.deepEqual(doc.warnings, []);
  return { metadata: doc.toJS(), body: raw.slice(match[0].length) };
}
const day = '2026-10-09';
test('seed library emits YAML-backed inline Markdown without active sidecars', () => {
  const files = seedFiles(day);
  const notes = Object.entries(files).filter(([path]) => /^Reading\/.*\.md$/.test(path));
  assert.equal(notes.length, 5);
  assert.equal(
    Object.keys(files).filter((path) => /^Reading\/(?:Metadata|Pullman Metadata)\//.test(path))
      .length,
    0,
  );
  for (const [path, raw] of notes) {
    const { metadata, body } = parsed(raw);
    assert.equal(Object.hasOwn(metadata, 'created-by'), false);
    for (const key of ['highlights', 'queueMove'])
      assert.equal(Object.hasOwn(metadata, key), false);
    assert.doesNotMatch(body, /^## (?:Comments|Highlights|Article)$/m);
    assert.doesNotMatch(raw, /<!--/);
    if (path.includes('/Wires/')) {
      assert.equal(metadata.type, 'feed');
      for (const key of ['id', 'pullmanFormat']) assert.equal(Object.hasOwn(metadata, key), false);
      assert.equal(metadata.enabled, false);
      assert.equal(metadata.prefix, 'Synthetic');
      assert.equal(metadata.url, 'https://example.invalid/reader/feed.xml');
    } else {
      assert.equal(metadata.type, 'article');
      assert.ok(body.trim());
      for (const key of [
        'id',
        'guid',
        'pullmanFormat',
        'content',
        'extractor',
        'sourceHash',
        'sourceLength',
      ])
        assert.equal(Object.hasOwn(metadata, key), false, `${path}: ${key}`);
    }
  }
  const path = `Reading/Inbox/261009 ${seedTitle}.md`;
  assert.ok(files[path].endsWith(seedBody));
  assert.equal(parsed(files[path]).metadata.url, 'https://example.invalid/reader/quiet-library');
  assert.equal(parsed(files[path]).metadata['test-note'], 'Preserve this unknown property');
  assert.doesNotMatch(files['Welcome.md'], /^created-by:|QuickAdd/m);
  const daily = parsed(files[`Daily/${day}.md`]);
  assert.deepEqual(daily.metadata, { date: day });
  assert.match(daily.body, /Preserve this existing synthetic daily note and its unrelated text/);
  assert.equal(Object.hasOwn(files, '.obsidian/core-plugins.json'), false);
  assert.equal(Object.hasOwn(files, '.obsidian/daily-notes.json'), false);
  assert.deepEqual(JSON.parse(files['.obsidian/plugins/obsidian-reader/data.json']), {
    folders: {
      inbox: 'Reading/Inbox',
      stream: 'Reading/Stream',
      later: 'Reading/Later',
      treasury: 'Reading/Treasury',
      feeds: 'Reading/Wires',
    },
  });
  assert.deepEqual(seedFiles(day), files);
});

for (const legacy of ['pullman', 'obsidian-reader2'])
  for (const existingReader of [false, true]) {
    for (const identity of ['installed', 'enabled']) {
      test(`setup/update refuses legacy ${legacy} (${identity}, Reader present: ${existingReader}) without migration`, async (t) => {
        const f = await fixture(t);
        if (existingReader) assert.equal(f.run().status, 0);
        await mkdir(join(f.vault, '.obsidian/plugins'), { recursive: true });
        if (identity === 'installed') {
          const plugin = join(f.vault, '.obsidian/plugins', legacy);
          await mkdir(plugin);
          await writeFile(join(plugin, 'data.json'), '{"preserve":"legacy settings"}');
        } else {
          await writeFile(
            join(f.vault, '.obsidian/community-plugins.json'),
            JSON.stringify([legacy]),
          );
        }
        const before = await snapshot(f.vault);
        for (const args of [[], ['--update-plugin']]) {
          const result = f.run('setup-vault.mjs', args);
          assert.notEqual(result.status, 0);
          assert.match(
            result.output,
            /Legacy (?:pullman|obsidian-reader2) plugin.*explicit migration approval/,
          );
          assert.deepEqual(await snapshot(f.vault), before);
        }
      });
    }
  }
async function hold(
  f,
  value = { schemaVersion: 1, state: 'held', repository: f.root, vaultPath: f.vault },
) {
  await mkdir(join(f.root, '.sandbox'), { recursive: true });
  await writeFile(
    join(f.root, '.sandbox/reader2-safety-hold.json'),
    typeof value === 'string' ? value : JSON.stringify(value),
  );
}
const load = (f, name) => import(pathToFileURL(join(f.root, 'scripts', name)).href);
test('hold blocks bootstrap/update and low-level restoration of a quarantined main.js', async (t) => {
  const f = await fixture(t);
  assert.equal(f.run().status, 0);
  await rename(join(f.plugin, 'main.js'), join(f.root, 'quarantined-main.js'));
  await hold(f);
  const before = await snapshot(f.vault);
  for (const args of [[], ['--update-plugin']]) {
    const run = f.run('setup-vault.mjs', args);
    assert.notEqual(run.status, 0);
    assert.match(run.output, /READER SAFETY HOLD/);
  }
  const { createOnly } = await load(f, 'sandbox.mjs');
  for (const name of ['main.js', 'styles.css', 'manifest.json']) {
    await assert.rejects(createOnly(join(f.plugin, name), 'unsafe replacement'), {
      code: 'READER_SAFETY_HOLD',
    });
  }
  for (const id of ['pullman', 'obsidian-reader2'])
    for (const name of ['main.js', 'styles.css', 'manifest.json']) {
      await assert.rejects(
        createOnly(join(f.vault, '.obsidian/plugins', id, name), 'unsafe legacy restoration'),
        { code: 'READER_SAFETY_HOLD' },
      );
    }
  await assert.rejects(
    createOnly(join(f.vault, '.obsidian/community-plugins.json'), '["obsidian-reader"]'),
    { code: 'READER_SAFETY_HOLD' },
  );
  assert.deepEqual(await snapshot(f.vault), before);
});

test('invalid, released-looking and symlinked sentinels cannot bypass the hold', async (t) => {
  const f = await fixture(t),
    guard = await load(f, 'safety-hold.mjs');
  for (const value of [
    '{broken',
    { schemaVersion: 1, state: 'released', repository: f.root, vaultPath: f.vault },
  ]) {
    await hold(f, value);
    await assert.rejects(guard.assertNoSafetyHold('enable'), { code: 'READER_SAFETY_HOLD' });
  }
  const path = join(f.root, '.sandbox/reader2-safety-hold.json');
  await rename(path, join(f.root, 'real-hold.json'));
  await symlink(join(f.root, 'real-hold.json'), path);
  await assert.rejects(guard.assertNoSafetyHold('enable'), { code: 'READER_SAFETY_HOLD' });
});

test('missing hold allows setup; malformed and identity-mismatched holds block all mutation', async (t) => {
  const f = await fixture(t);
  const guard = await load(f, 'safety-hold.mjs');
  assert.equal(await guard.readSafetyHold(), null);
  await guard.assertNoSafetyHold('fixture setup');
  succeeds(f.run());
  const before = await snapshot(f.vault);
  for (const value of [
    '{broken',
    null,
    {},
    { schemaVersion: 1, state: 'held', repository: '/elsewhere', vaultPath: f.vault },
    { schemaVersion: 1, state: 'held', repository: f.root, vaultPath: f.vault + '-copy' },
    { schemaVersion: 1, state: 'released', repository: f.root, vaultPath: f.vault },
  ]) {
    await hold(f, value);
    for (const args of [[], ['--update-plugin']])
      refuses(f.run('setup-vault.mjs', args), /READER SAFETY HOLD/);
    assert.deepEqual(await snapshot(f.vault), before);
  }
});

test('hardlinked vault files, markers and hold sentinels fail closed', async (t) => {
  for (const relative of [
    '.reader2-test-vault.json',
    '.obsidian/plugins/obsidian-reader/main.js',
    'Welcome.md',
  ]) {
    const f = await fixture(t);
    succeeds(f.run());
    const target = join(f.vault, relative),
      outside = join(f.root, 'hardlink');
    await link(target, outside);
    const before = await snapshot(f.vault),
      bytes = await readFile(outside);
    for (const args of [[], ['--update-plugin']])
      refuses(f.run('setup-vault.mjs', args), /unlinked|Unsafe file/);
    assert.deepEqual(await snapshot(f.vault), before);
    assert.deepEqual(await readFile(outside), bytes);
  }
  const f = await fixture(t);
  await hold(f);
  await link(join(f.root, '.sandbox/reader2-safety-hold.json'), join(f.root, 'hold-link'));
  refuses(f.run(), /READER SAFETY HOLD/);
});

test('update refuses missing artifacts and unsafe backup/staging roots without mutation', async (t) => {
  for (const kind of ['missing-plugin', 'backups', 'staging']) {
    const f = await fixture(t);
    succeeds(f.run());
    await f.build('v2');
    const outside = join(f.root, 'outside');
    await mkdir(outside);
    await writeFile(join(outside, 'keep'), 'untouched');
    if (kind === 'missing-plugin') await rm(join(f.plugin, 'styles.css'));
    else await symlink(outside, join(f.root, '.sandbox', kind), 'dir');
    const before = await snapshot(f.vault),
      external = await snapshot(outside);
    refuses(f.run('setup-vault.mjs', ['--update-plugin']), /ENOENT|symlink/);
    assert.deepEqual(await snapshot(f.vault), before);
    assert.deepEqual(await snapshot(outside), external);
  }
});

test('build rejects unsafe output destinations before replacing any artifact', async (t) => {
  for (const kind of ['directory-symlink', 'file-symlink', 'hardlink']) {
    const f = await fixture(t);
    await f.enableBuild();
    await writeFile(join(f.root, 'src/main.ts'), 'export default class Reader {}\n');
    const dist = join(f.root, 'dist'),
      outside = join(f.root, 'outside');
    await mkdir(outside);
    await writeFile(join(outside, 'keep'), 'untouched');
    if (kind === 'directory-symlink') {
      await rename(dist, join(f.root, 'original-dist'));
      await symlink(outside, dist, 'dir');
    } else if (kind === 'file-symlink') {
      await rm(join(dist, 'styles.css'));
      await symlink(join(outside, 'keep'), join(dist, 'styles.css'));
    } else await link(join(dist, 'styles.css'), join(outside, 'linked.css'));
    const before = await snapshot(dist),
      external = await snapshot(outside);
    refuses(f.run('build.mjs'), /symlink|unlinked/);
    assert.deepEqual(await snapshot(dist), before);
    assert.deepEqual(await snapshot(outside), external);
    assert.equal(
      (await readdir(dist)).some((name) => name.startsWith('.build-')),
      false,
    );
  }
});

test('artifact identity rejects extra externals, wrong platform and mismatched manifest before setup', async (t) => {
  const f = await fixture(t);
  for (const patch of [
    { external: ['obsidian', 'electron'] },
    { external: [] },
    { platform: 'node' },
    { plugin: { id: 'pullman', version: 'v1' } },
    { plugin: { id: 'obsidian-reader', version: 'wrong' } },
  ]) {
    await f.build();
    const path = join(f.root, 'dist/build-meta.json');
    const metadata = JSON.parse(await readFile(path, 'utf8'));
    await writeFile(path, JSON.stringify({ ...metadata, ...patch }));
    refuses(f.run(), /invalid browser build identity|Unexpected Reader plugin manifest/);
    await assert.rejects(readdir(f.vault), { code: 'ENOENT' });
  }
});

test('path guards reject traversal and marker identity changes', async (t) => {
  const f = await fixture(t),
    sandbox = await load(f, 'sandbox.mjs');
  for (const path of [join(f.root, '..', 'outside'), f.root + '-copy/file']) {
    assert.throws(() => sandbox.inside(f.root, path), /outside/);
    await assert.rejects(sandbox.createOnly(path, 'no'), /outside/);
  }
  succeeds(f.run());
  for (const [key, value] of Object.entries(sandbox.ownership)) {
    await writeFile(
      join(f.vault, sandbox.markerName),
      JSON.stringify({ ...sandbox.ownership, [key]: `${value}-wrong` }),
    );
    const before = await snapshot(f.vault);
    for (const args of [[], ['--update-plugin']])
      refuses(f.run('setup-vault.mjs', args), /ownership marker/);
    assert.deepEqual(await snapshot(f.vault), before);
  }
});

test('acceptance target cannot bypass createOnly protection of held default-vault identities', async (t) => {
  const f = await fixture(t);
  succeeds(f.run());
  await rename(join(f.plugin, 'main.js'), join(f.root, 'quarantined-main.js'));
  await hold(f);
  const before = await snapshot(f.vault);
  // Select the environment before importing any sandbox module in a fresh process.
  await writeFile(
    join(f.root, 'scripts', 'acceptance-hold-probe.mjs'),
    `
    import assert from 'node:assert/strict';
    import { join } from 'node:path';
    process.env.READER_RUNTIME_TARGET = 'acceptance';
    const { createOnly, defaultVaultPath, vaultPath, pluginFiles } = await import('./sandbox.mjs');
    const { setupVault } = await import('./setup-vault.mjs');
    assert.notEqual(vaultPath, defaultVaultPath);
    await setupVault();
    for (const id of ['obsidian-reader', 'pullman', 'obsidian-reader2']) {
      for (const name of pluginFiles) {
        await assert.rejects(createOnly(join(defaultVaultPath, '.obsidian/plugins', id, name), 'unsafe restoration'),
          { code: 'READER_SAFETY_HOLD' });
      }
    }
    await assert.rejects(createOnly(join(defaultVaultPath, '.obsidian/community-plugins.json'), '["obsidian-reader"]'),
      { code: 'READER_SAFETY_HOLD' });
  `,
  );
  succeeds(f.run('acceptance-hold-probe.mjs'));
  assert.deepEqual(await snapshot(f.vault), before);
  await assert.rejects(readFile(join(f.plugin, 'main.js')), { code: 'ENOENT' });
});

test('dev builds directly into the opted-in dummy plugin, preserving notes, root and dist', async (t) => {
  const f = await fixture(t);
  succeeds(f.run());
  succeeds(await f.enableHotReload());
  await f.enableBuild();
  await writeFile(
    join(f.root, 'src/main.ts'),
    "import { Plugin } from 'obsidian'; export default class Reader extends Plugin {}\n",
  );
  await writeFile(join(f.root, 'main.js'), 'root artifact must remain untouched');
  await writeFile(join(f.root, 'styles.css'), 'obsolete root stylesheet must remain untouched');
  const before = await snapshot(f.vault),
    dist = await snapshot(join(f.root, 'dist'));
  const rootFiles = ['main.js', 'manifest.json', 'styles.css', 'src/reader/styles.css'];
  const bytes = await Promise.all(rootFiles.map((name) => readFile(join(f.root, name))));
  const entries = await readdir(f.root);
  succeeds(f.run('dev.mjs'));
  const after = await snapshot(f.vault);
  const artifact =
    /^\.obsidian\/plugins\/obsidian-reader\/(?:main\.js|manifest\.json|styles\.css|build-meta\.json)$/;
  for (const name of new Set([...Object.keys(before), ...Object.keys(after)])) {
    if (!artifact.test(name)) assert.deepEqual(after[name], before[name], name);
  }
  assert.deepEqual(await snapshot(join(f.root, 'dist')), dist);
  assert.deepEqual(await readdir(f.root), entries);
  for (const [i, name] of rootFiles.entries())
    assert.deepEqual(await readFile(join(f.root, name)), bytes[i]);
  assert.match(await readFile(join(f.plugin, 'main.js'), 'utf8'), /__readerBuildId/);
  assert.deepEqual(
    await readFile(join(f.plugin, 'styles.css')),
    await readFile(join(f.root, 'src/reader/styles.css')),
  );
  assert.equal(
    (await readdir(f.plugin)).some((name) => name.startsWith('.build-')),
    false,
  );
});
