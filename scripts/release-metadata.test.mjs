import assert from 'node:assert/strict';
import { copyFile, mkdtemp, mkdir, realpath, writeFile, rm } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { validateRelease } from './validate-release.mjs';

const version = '1.2.3';
async function fixture(t, mutate = () => {}) {
  const root = await mkdtemp(join(tmpdir(), 'reader-release-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const manifest = { id: 'obsidian-reader', name: 'Reader', version, minAppVersion: '1.8.0', description: 'An offline Markdown-first reader.', author: 'Reader', isDesktopOnly: false };
  const pkg = { name: 'obsidian-reader', version, private: true };
  const data = { manifest, pkg, lock: { name: pkg.name, version, packages: { '': { name: pkg.name, version } } }, versions: { [version]: manifest.minAppVersion } };
  mutate(data);
  for (const [file, value] of [['manifest.json', data.manifest], ['package.json', data.pkg], ['package-lock.json', data.lock], ['versions.json', data.versions]])
    await writeFile(join(root, file), JSON.stringify(value));
  return root;
}

test('validates matching branch and tag metadata without handwritten notes', async t => {
  const root = await fixture(t);
  const result = { version, minAppVersion: '1.8.0' };
  assert.deepEqual(await validateRelease(root, { refType: 'branch', refName: 'main' }), result);
  assert.deepEqual(await validateRelease(root, { refType: 'tag', refName: version }), result);
});
test('versions.json may inherit the latest compatible minimum app version', async t => {
  const root = await fixture(t, d => { d.versions = { '1.2.2': d.manifest.minAppVersion }; });
  assert.equal((await validateRelease(root)).minAppVersion, '1.8.0');
});
test('CLI validates metadata without notes and rejects obsolete arguments', async t => {
  const root = await fixture(t);
  await mkdir(join(root, 'scripts'));
  const script = join(await realpath(root), 'scripts/validate-release.mjs');
  await copyFile(new URL('./validate-release.mjs', import.meta.url), script);
  const cli = (args = [], refType = 'branch', refName = version) => spawnSync(process.execPath, [script, ...args], {
    encoding: 'utf8', env: { ...process.env, GITHUB_REF_TYPE: refType, GITHUB_REF_NAME: refName },
  });
  assert.equal(cli().status, 0);
  assert.equal(cli([], 'tag').status, 0);
  assert.notEqual(cli([], 'tag', 'v' + version).status, 0);
  for (const flag of ['--release', '--write-notes', '--unknown']) assert.notEqual(cli([flag]).status, 0);
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
]) {
  test('rejects ' + name, async t => {
    await assert.rejects(validateRelease(await fixture(t, mutate)), expected);
  });
}
