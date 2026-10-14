import { readFileSync } from 'node:fs';
import { expect, it } from 'vitest';

const read = (path: string) => readFileSync(path, 'utf8');

it('ships Reader as a standalone mobile-compatible plugin with consistent versions', () => {
  const manifest = JSON.parse(read('manifest.json'));
  const pkg = JSON.parse(read('package.json'));
  const lock = JSON.parse(read('package-lock.json'));
  expect(manifest.id).toBe('obsidian-reader');
  expect(manifest.name).toBe('Reader');
  expect(manifest.isDesktopOnly).toBe(false);
  expect(pkg.name).toBe(manifest.id);
  expect(lock.name).toBe(pkg.name);
  expect(lock.packages[''].name).toBe(pkg.name);
  expect(manifest.version).toBe(pkg.version);
  expect(lock.version).toBe(pkg.version);
  expect(lock.packages[''].version).toBe(pkg.version);
  const versions = JSON.parse(read('versions.json'));
  const compatible = Object.keys(versions)
    .filter((version) => version.localeCompare(manifest.version, undefined, { numeric: true }) <= 0)
    .sort((left, right) => left.localeCompare(right, undefined, { numeric: true }))
    .at(-1)!;
  expect(versions[compatible]).toBe(manifest.minAppVersion);
  expect(read('README.md')).toContain('wannli/obsidian-reader');
});

it('keeps historical safety identities without restoring legacy runtime compatibility', () => {
  const sandbox = read('scripts/sandbox.mjs');
  for (const identity of [
    'Reader2 Test Vault',
    'Reader2 Acceptance Vault',
    '.reader2-test-vault.json',
    'Reader2 synthetic test vault',
  ]) {
    expect(sandbox).toContain(identity);
  }
  expect(read('scripts/safety-hold.mjs')).toContain('reader2-safety-hold.json');
});
