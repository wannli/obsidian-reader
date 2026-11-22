import { afterEach, expect, it, vi } from 'vitest';
import { runtimeFixture } from './helpers/folder-runtime';
import * as storage from '../src/host/diagnostic-storage';

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

it('connects plugin reporting to device-specific Markdown logs, then stops on unload', async () => {
  const { plugin, app } = await runtimeFixture();
  const files = new Map<string, string>();
  app.vault.adapter = {
    exists: async (path: string) => files.has(path),
    mkdir: async (path: string) => {
      files.set(path, '');
    },
    stat: async (path: string) => (files.has(path) ? { size: files.get(path)!.length } : null),
    read: async (path: string) => files.get(path),
    write: vi.fn(async (path: string, value: string) => {
      files.set(path, value);
    }),
  };
  vi.spyOn(storage, 'diagnosticStorage').mockReturnValue(app.vault.adapter);
  plugin.manifest = { dir: '.custom/plugins/obsidian-reader', version: 'test-version' };
  plugin.loadReader = vi.fn(async () => {});
  const listeners = new Map<string, (event: any) => void>();
  plugin.registerDomEvent = vi.fn((_target, name, callback) => {
    listeners.set(name, callback);
  });
  vi.spyOn(console, 'error').mockImplementation(() => {});
  await plugin.onload();
  plugin.notice(new Error('Handled failure'));
  const error = new Error('Uncaught failure');
  error.stack = 'Error\n at save (plugin:obsidian-reader:33:4)';
  listeners.get('error')!({ error });
  listeners.get('unhandledrejection')!({ reason: error });
  listeners.get('error')!({ error: new Error('Unrelated failure') });
  await vi.waitFor(() =>
    expect([...files.values()].join('')).toContain('runtime.unhandled-rejection'),
  );
  const path = [...files.keys()].find((path) =>
    /Reader Diagnostics\/errors-[a-f0-9]{32}\.md$/.test(path),
  )!;
  expect(path).toBeTruthy();
  expect(storage.diagnosticStorage).toHaveBeenCalledWith(app, expect.any(Function));
  const entries = files
    .get(path)!
    .split('\n')
    .filter((line) => line.startsWith('{'))
    .map((line) => JSON.parse(line));
  expect(entries.map((entry) => entry.operation)).toEqual([
    'reader',
    'runtime.error',
    'runtime.unhandled-rejection',
  ]);
  expect(entries.every((entry) => entry.reader === 'test-version')).toBe(true);
  const before = files.get(path);
  plugin.onunload();
  listeners.get('error')!({ error });
  await Promise.resolve();
  expect(files.get(path)).toBe(before);
});
