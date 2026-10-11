import assert from 'node:assert/strict';
import { copyFile, mkdtemp, mkdir, readFile, realpath, writeFile, rm } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { validateRelease } from './validate-release.mjs';

const version = '1.2.3';
const notes = `# Reader ${version}

## Features

- Add safe folder queues and date-leading article filenames for saved reading.

## Installation

Copy main.js, manifest.json, and styles.css into your test vault's .obsidian/plugins/obsidian-reader/ folder, then enable Reader.

## Limitations

Physical iOS and real sync remain untested. This experimental plugin requires careful test-vault acceptance.

## Verification

Unit tests, metadata checks and browser bundle validation passed for this build; native acceptance is separate.
`;
async function fixture(t, mutate = () => {}) {
  const root = await mkdtemp(join(tmpdir(), 'reader-release-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const manifest = { id: 'obsidian-reader', name: 'Reader', version, minAppVersion: '1.8.0', description: 'An offline Markdown-first reader.', author: 'Reader', isDesktopOnly: false };
  const pkg = { name: 'obsidian-reader', version, private: true };
  const data = { manifest, pkg, lock: { name: pkg.name, version, packages: { '': { name: pkg.name, version } } }, versions: { [version]: manifest.minAppVersion }, notes };
  mutate(data);
  await mkdir(join(root, 'releases'));
  for (const [file, value] of [['manifest.json', data.manifest], ['package.json', data.pkg], ['package-lock.json', data.lock], ['versions.json', data.versions]])
    await writeFile(join(root, file), JSON.stringify(value));
  if (data.notes !== null) await writeFile(join(root, 'releases', version + '.md'), data.notes);
  return root;
}

test('validates matching metadata on branches with plain Markdown release notes', async t => {
  const root = await fixture(t);
  const result = await validateRelease(root, { refType: 'branch', refName: 'main' });
  assert.equal(result.version, version);
  assert.equal(result.minAppVersion, '1.8.0');
  assert.ok(result.notes.startsWith('# Reader 1.2.3\n'));
  assert.equal(result.notes, notes);
  for (const heading of ['Features', 'Installation', 'Limitations', 'Verification']) assert.ok(result.notes.includes('## ' + heading));
  assert.deepEqual(await validateRelease(root, { refType: 'tag', refName: version }), result);
});
test('legacy frontmatter is stripped from release body without requiring attribution', async t => {
  const root = await fixture(t, d => { d.notes = '---\ncreated-by: ai\n---\n' + d.notes; });
  assert.equal((await validateRelease(root)).notes, notes);
});
test('versions.json may inherit the latest compatible minimum app version', async t => {
  const root = await fixture(t, d => { d.versions = { '1.2.2': d.manifest.minAppVersion }; });
  assert.equal((await validateRelease(root, { release: false })).minAppVersion, '1.8.0');
});
test('metadata-only mode allows missing notes, while tags always enforce notes', async t => {
  const root = await fixture(t, d => { d.notes = null; });
  assert.equal((await validateRelease(root, { release: false })).version, version);
  await assert.rejects(validateRelease(root, { release: false, refType: 'tag', refName: version }), /ENOENT/);
  await assert.rejects(validateRelease(root, { release: true }), /ENOENT/);
});
test('metadata-only mode still rejects invalid metadata without a releases directory', async t => {
  for (const [mutate, expected] of [
    [d => { d.manifest.id = 'wrong'; }, /plugin identity/],
    [d => { d.manifest.isDesktopOnly = true; }, /mobile-compatible/],
    [d => { d.pkg.version = '1.2.4'; }, /Package version mismatch/],
    [d => { d.lock.version = '1.2.4'; }, /Lockfile version mismatch/],
    [d => { d.versions[version] = '1.9.0'; }, /Minimum host version mismatch/],
  ]) {
    const root = await fixture(t, d => { d.notes = null; mutate(d); });
    await rm(join(root, 'releases'), { recursive: true });
    await assert.rejects(validateRelease(root, { release: false }), expected);
  }
  const root = await fixture(t, d => { d.notes = null; });
  await rm(join(root, 'releases'), { recursive: true });
  await assert.rejects(validateRelease(root, { release: false, refType: 'tag', refName: 'v' + version }), /Tag must exactly equal/);
});
test('CLI branch defaults to metadata-only and explicit release/write-notes enforce notes', async t => {
  const root = await fixture(t, d => { d.notes = null; });
  await rm(join(root, 'releases'), { recursive: true });
  await mkdir(join(root, 'scripts'));
  const script = join(await realpath(root), 'scripts/validate-release.mjs');
  await copyFile(new URL('./validate-release.mjs', import.meta.url), script);
  const cli = (args = [], refType = 'branch') => spawnSync(process.execPath, [script, ...args], {
    encoding: 'utf8', env: { ...process.env, GITHUB_REF_TYPE: refType, GITHUB_REF_NAME: version },
  });
  assert.equal(cli().status, 0);
  assert.notEqual(cli(['--release']).status, 0);
  assert.notEqual(cli(['--write-notes']).status, 0);
  assert.notEqual(cli([], 'tag').status, 0);
  await mkdir(join(root, 'releases'));
  await writeFile(join(root, 'releases', version + '.md'), notes);
  assert.equal(cli(['--release', '--write-notes']).status, 0);
  assert.ok((await readFile(join(root, 'dist/release-notes.md'), 'utf8')).startsWith('# Reader ' + version));
  assert.notEqual(cli(['--unknown']).status, 0);
});
test('long draft placeholders are rejected even with substantive neighboring text', async t => {
  const root = await fixture(t, d => { d.notes += '\nTODO replace this draft after reviewing the cumulative release changes.\n'; });
  await assert.rejects(validateRelease(root), /placeholders/);
});
for (const refName of ['v1.2.3', '1.2.4', '1.2', '1.2.3-beta.1', '$(touch unsafe)', undefined]) {
  test('rejects a mismatched or unsafe tag: ' + refName, async t => {
    await assert.rejects(validateRelease(await fixture(t), { refType: 'tag', refName }), /Tag must exactly equal/);
  });
}
for (const [name, mutate, expected] of [
  ['plugin identity', d => { d.manifest.id = 'reader2'; }, /plugin identity/],
  ['display identity', d => { d.manifest.name = 'Reader 2'; }, /display name/],
  ['missing author', d => { delete d.manifest.author; }, /author must/],
  ['blank description', d => { d.manifest.description = '  '; }, /description must/],
  ['mobile declaration', d => { d.manifest.isDesktopOnly = true; }, /mobile-compatible/],
  ['non-numeric version', d => { d.manifest.version = 'v1.2.3'; }, /numeric plugin/],
  ['minimum host syntax', d => { d.manifest.minAppVersion = '1.8'; }, /numeric minimum/],
  ['package identity', d => { d.pkg.name = 'wrong'; }, /package identity/],
  ['npm publication', d => { d.pkg.private = false; }, /npm publication/],
  ['package version', d => { d.pkg.version = '1.2.4'; }, /Package version/],
  ['lock identity', d => { d.lock.name = 'wrong'; }, /Lockfile package identity/],
  ['lock version', d => { d.lock.version = '1.2.4'; }, /Lockfile version/],
  ['lock root identity', d => { d.lock.packages[''].name = 'wrong'; }, /Lockfile root identity/],
  ['lock root version', d => { d.lock.packages[''].version = '1.2.4'; }, /Lockfile root version/],
  ['missing lock root', d => { delete d.lock.packages['']; }, /Lockfile root identity/],
  ['minimum host mismatch', d => { d.versions[version] = '1.9.0'; }, /Minimum host version/],
  ['missing compatible version entry', d => { d.versions = { '2.0.0': '1.8.0' }; }, /mapping is missing/],
  ['bad version map', d => { d.versions = []; }, /Invalid versions map/],
  ['bad historical version', d => { d.versions['v1.0.0'] = '1.8.0'; }, /versions map key/],
  ['missing release file', d => { d.notes = null; }, /ENOENT/],
  ['unexpected frontmatter body', d => { d.notes = '---\nauthor: someone\n---\n' + d.notes.replace('# Reader 1.2.3', '# Reader 9.9.9'); }, /heading must match/],
  ['wrong heading', d => { d.notes = d.notes.replace('# Reader 1.2.3', '# Reader 9.9.9'); }, /heading must match/],
  ['missing section', d => { d.notes = d.notes.replace('## Features', '## Other'); }, /Features must/],
  ['empty section', d => { d.notes = d.notes.replace(/## Features[\s\S]*?(?=## Installation)/, '## Features\n\n'); }, /Features must/],
  ['comment-only section', d => { d.notes = d.notes.replace(/## Features[\s\S]*?(?=## Installation)/, '## Features\n\n<!-- long hidden text is not a substantive release description -->\n\n'); }, /Features must/],
  ['placeholder section', d => { d.notes = d.notes.replace(/## Features[\s\S]*?(?=## Installation)/, '## Features\n\nTODO\n\n'); }, /placeholders/],
  ['duplicate section', d => { d.notes += '\n## Features\n\nDuplicate declarations must not replace an existing required section.\n'; }, /Duplicate release section/],
  ['missing asset', d => { d.notes = d.notes.replace('styles.css', 'other.css'); }, /Installation must specify styles.css/],
  ['wrong install folder', d => { d.notes = d.notes.replace('.obsidian/plugins/obsidian-reader/', '.obsidian/plugins/wrong/'); }, /Installation must specify/],
]) {
  test('rejects ' + name, async t => {
    await assert.rejects(validateRelease(await fixture(t, mutate)), expected);
  });
}
