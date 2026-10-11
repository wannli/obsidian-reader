import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const ci = await readFile(new URL('../.github/workflows/ci.yml', import.meta.url), 'utf8');
const release = await readFile(new URL('../.github/workflows/release.yml', import.meta.url), 'utf8');
const config = JSON.parse(await readFile(new URL('../release-please-config.json', import.meta.url), 'utf8'));
const manifest = JSON.parse(await readFile(new URL('../.release-please-manifest.json', import.meta.url), 'utf8'));
const pkg = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
const pluginManifest = JSON.parse(await readFile(new URL('../manifest.json', import.meta.url), 'utf8'));

test('supported checks use metadata validation without handwritten release notes', () => {
  assert.equal(Object.hasOwn(pkg.scripts, 'validate:release'), false);
  assert.equal(pkg.scripts['validate:metadata'], 'node scripts/validate-release.mjs');
  assert.deepEqual(pkg.scripts.check.split(' && '), [
    'npm run validate:metadata', 'npm run typecheck', 'npm test',
    'npm run test:tooling', 'npm run build',
  ]);
  for (const workflow of [ci, release]) {
    assert.equal(workflow.split('npm run validate:metadata').length - 1, 1);
    assert.doesNotMatch(workflow, /validate:release|--write-notes|releases\//);
  }
});

test('preview-only commands and CI browser steps are retired', () => {
  assert.equal(Object.hasOwn(pkg.scripts, 'preview'), false);
  assert.equal(Object.keys(pkg.scripts).some(name => name.startsWith('test:browser')), false);
  assert.equal(Object.hasOwn(pkg.devDependencies, 'vite'), false);
  assert.ok(pkg.devDependencies['@playwright/test'], 'Native sandbox automation still uses Playwright');
  assert.doesNotMatch(ci, /playwright install|test:browser|browser-failure-diagnostics/);
});

test('CI retains PR/manual checks without an independent tag publication path', () => {
  const triggers = ci.split('\npermissions:')[0];
  assert.match(triggers, /  pull_request:/);
  assert.match(triggers, /  workflow_dispatch:/);
  assert.doesNotMatch(triggers, /  push:/);
  assert.doesNotMatch(ci, /\n  release:\n/);
  for (const command of ['npm run typecheck', 'npm test', 'npm run test:tooling', 'npm run build'])
    assert.equal(ci.split(command).length - 1, 1, command);
});

test('main pushes build before Release Please and publish only its created release', () => {
  assert.match(release, /push:\n    branches: \[main\]/);
  assert.match(release, /actions\/checkout@v7/);
  assert.match(release, /actions\/setup-node@v7/);
  assert.match(release, /googleapis\/release-please-action@v5/);
  assert.ok(release.indexOf('npm run build') < release.indexOf('googleapis/release-please-action@v5'));
  assert.match(release, /if: \$\{\{ steps\.release\.outputs\.release_created \}\}/);
  assert.match(release, /test "\$VERSION" = "\$TAG"/);
  assert.match(release, /gh release upload "\$TAG"/);
  assert.match(release, /gh release edit "\$TAG" --draft=false/);
  assert.doesNotMatch(release, /--clobber/);
});

test('Release Please uses the last published version and Obsidian-compatible numeric tags', () => {
  assert.equal(config['release-type'], 'node');
  assert.equal(config['bump-minor-pre-major'], true, 'Breaking 0.x changes must propose the approved minor release');
  assert.equal(config['include-v-in-tag'], false);
  assert.equal(config.draft, true);
  assert.equal(config['force-tag-creation'], true);
  assert.deepEqual(manifest, { '.': pluginManifest.version });
  assert.deepEqual(config.packages['.']['extra-files'], [{ type: 'json', path: 'manifest.json', jsonpath: '$.version' }]);
});
