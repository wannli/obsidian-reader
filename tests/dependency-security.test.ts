import { readFileSync } from 'node:fs';
import { expect, it } from 'vitest';

it('keeps every locked Moment copy at the CVE-2026-17495 fixed version or newer', () => {
  const lock = JSON.parse(readFileSync('package-lock.json', 'utf8')) as {
    packages: Record<string, { version?: string }>;
  };
  const copies = Object.entries(lock.packages).filter(([path]) => /(^|\/)node_modules\/moment$/.test(path));
  expect(copies.length).toBeGreaterThan(0);
  for (const [path, pkg] of copies) {
    const version = pkg.version ?? '';
    expect(version, path).toMatch(/^\d+\.\d+\.\d+$/);
    const [major, minor] = version.split('.').map(Number);
    expect(major > 2 || major === 2 && minor >= 31, `${path}@${version} must be >=2.31.0`).toBe(true);
  }
});
