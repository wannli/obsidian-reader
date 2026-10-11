#!/usr/bin/env node
import assert from 'node:assert/strict';
import { lstat, mkdir, readFile, writeFile } from 'node:fs/promises';
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
const sections = ['Features', 'Installation', 'Limitations', 'Verification'];
const json = async path => JSON.parse(await readFile(path, 'utf8'));

export async function validateRelease(root, { refType, refName, release = true } = {}) {
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

  if (!release && refType !== 'tag') return { version: manifest.version, minAppVersion: manifest.minAppVersion };
  const source = await readFile(join(root, 'releases', manifest.version + '.md'), 'utf8');
  const frontmatter = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(source);
  // Existing release drafts may still contain frontmatter; new drafts are plain Markdown.
  const notes = (frontmatter ? source.slice(frontmatter[0].length) : source).trim() + '\n';
  assert.ok(!/\b(?:TODO|TBD|RELEASE_DRAFT)\b/i.test(notes), 'Release notes contain unresolved placeholders');
  assert.equal(notes.split(/\r?\n/)[0], '# Reader ' + manifest.version, 'Release heading must match the version');
  const content = new Map();
  for (const match of notes.matchAll(/^## ([^\r\n]+)\r?\n([\s\S]*?)(?=^## |$(?![\s\S]))/gm)) {
    assert.ok(!content.has(match[1]), 'Duplicate release section: ' + match[1]);
    content.set(match[1], match[2].replace(/<!--[\s\S]*?-->/g, '').trim());
  }
  for (const heading of sections) {
    const text = content.get(heading);
    assert.ok(text && text.length >= 40 && /[A-Za-z]{3,}/.test(text), `Release ${heading} must have substantive content`);
    assert.ok(!/^(?:[-*]\s*)?(?:TODO|TBD|N\/A|none|pending|not run)[.!]?$/i.test(text), `Release ${heading} is a placeholder`);
  }
  for (const asset of ['main.js', 'manifest.json', 'styles.css', '.obsidian/plugins/obsidian-reader/'])
    assert.ok(content.get('Installation').includes(asset), 'Installation must specify ' + asset);
  return { version: manifest.version, minAppVersion: manifest.minAppVersion, notes };
}

async function writeNotes(notes) {
  const dist = join(repository, 'dist'), target = join(dist, 'release-notes.md');
  for (const [path, directory] of [[dist, true], [target, false]]) {
    const stat = await lstat(path).catch(error => { if (error.code !== 'ENOENT') throw error; });
    if (stat) assert.ok(!stat.isSymbolicLink() && (directory ? stat.isDirectory() : stat.isFile() && stat.nlink === 1), 'Unsafe generated release-notes path');
  }
  await mkdir(dist, { recursive: true });
  await writeFile(target, notes);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  assert.ok(args.every(arg => ['--release', '--write-notes'].includes(arg)) && new Set(args).size === args.length, 'Only --release and --write-notes are accepted');
  const result = await validateRelease(repository, { release: args.length > 0, refType: process.env.GITHUB_REF_TYPE, refName: process.env.GITHUB_REF_NAME });
  if (args.includes('--write-notes')) await writeNotes(result.notes);
  console.log(`Validated Reader ${result.version}; minimum Obsidian ${result.minAppVersion}`);
}
