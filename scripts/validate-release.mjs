#!/usr/bin/env node
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repository = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const semver = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
const compareVersions = (left, right) => {
  const a = left.split('.').map(Number), b = right.split('.').map(Number);
  for (let index = 0; index < 3; index += 1) {
    if (a[index] !== b[index]) return a[index] - b[index];
  }
  return 0;
};
const json = async path => JSON.parse(await readFile(path, 'utf8'));

export async function validateRelease(root, { refType, refName } = {}) {
  const manifest = await json(join(root, 'manifest.json'));
  const pkg = await json(join(root, 'package.json'));
  const lock = await json(join(root, 'package-lock.json'));
  const versions = await json(join(root, 'versions.json'));
  for (const key of ['id', 'name', 'version', 'minAppVersion', 'description', 'author'])
    assert.ok(typeof manifest[key] === 'string' && manifest[key].trim(), `Manifest ${key} must be nonempty text`);
  assert.equal(manifest.id, 'obsidian-reader', 'Wrong plugin identity');
  assert.equal(manifest.name, 'Reader', 'Wrong display name');
  assert.equal(manifest.isDesktopOnly, false, 'Reader must remain mobile-compatible');
  assert.match(manifest.version, semver, 'Use a full numeric plugin version');
  assert.match(manifest.minAppVersion, semver, 'Use a full numeric minimum host version');
  assert.equal(pkg.name, 'obsidian-reader', 'Wrong package identity');
  assert.equal(pkg.private, true, 'This project is not an npm publication');
  assert.equal(pkg.version, manifest.version, 'Package version mismatch');
  assert.equal(lock.name, pkg.name, 'Lockfile package identity mismatch');
  assert.equal(lock.version, manifest.version, 'Lockfile version mismatch');
  assert.equal(lock.packages?.['']?.name, pkg.name, 'Lockfile root identity mismatch');
  assert.equal(lock.packages?.['']?.version, manifest.version, 'Lockfile root version mismatch');
  assert.ok(versions && !Array.isArray(versions) && typeof versions === 'object', 'Invalid versions map');
  for (const [version, host] of Object.entries(versions)) {
    assert.match(version, semver, 'Invalid versions map key');
    assert.ok(typeof host === 'string' && semver.test(host), 'Invalid versions map host');
  }
  const compatibleVersion = Object.keys(versions)
    .filter(version => compareVersions(version, manifest.version) <= 0)
    .sort(compareVersions)
    .at(-1);
  assert.ok(compatibleVersion, 'Minimum host version mapping is missing');
  assert.equal(versions[compatibleVersion], manifest.minAppVersion, 'Minimum host version mismatch');
  if (refType === 'tag') assert.equal(refName, manifest.version, 'Tag must exactly equal manifest.version, without v');

  return { version: manifest.version, minAppVersion: manifest.minAppVersion };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  assert.equal(process.argv.length, 2, 'No arguments accepted');
  const result = await validateRelease(repository, { refType: process.env.GITHUB_REF_TYPE, refName: process.env.GITHUB_REF_NAME });
  console.log(`Validated Reader ${result.version}; minimum Obsidian ${result.minAppVersion}`);
}
