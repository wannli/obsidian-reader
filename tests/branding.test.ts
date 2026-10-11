import { readFileSync } from 'node:fs';
import { expect, it, vi } from 'vitest';
import { readerCommands } from '../src/ui/commands';

it('ships Reader under its own plugin identity with matching package versions', () => {
  const manifest = JSON.parse(readFileSync('manifest.json', 'utf8'));
  const pkg = JSON.parse(readFileSync('package.json', 'utf8'));
  const lock = JSON.parse(readFileSync('package-lock.json', 'utf8'));
  expect(manifest.id).toBe('obsidian-reader');
  expect(manifest.name).toBe('Reader');
  expect(manifest.isDesktopOnly).toBe(false);
  expect(pkg.name).toBe('obsidian-reader');
  expect(lock.name).toBe(pkg.name);
  expect(lock.packages[''].name).toBe(pkg.name);
  expect(manifest.version).toBe(pkg.version);
  expect(lock.version).toBe(pkg.version);
  expect(lock.packages[''].version).toBe(pkg.version);
  const versions = JSON.parse(readFileSync('versions.json', 'utf8'));
  const compatibleVersion = Object.keys(versions)
    .filter(version => version.localeCompare(manifest.version, undefined, { numeric: true }) <= 0)
    .sort((left, right) => left.localeCompare(right, undefined, { numeric: true }))
    .at(-1)!;
  expect(versions[compatibleVersion]).toBe(manifest.minAppVersion);
});

it('offers the branded opening command', async () => {
  const ensure = vi.fn(async () => undefined);
  const command = readerCommands({} as never, { ensure } as never).find(command => command.name === 'Open Reader');
  expect(command).toBeDefined();
  expect(command!.id).toBe('open-reader');
  expect(command!.available()).toBe(true);
  await command!.run();
  expect(ensure).toHaveBeenCalledOnce();
});
