import { afterEach, expect, it, vi } from 'vitest';
import { runtimeFixture } from './helpers/folder-runtime';

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

it('connects plugin reporting and attributed runtime errors to vault adapter logs, then stops on unload', async () => {
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
  const path = '.custom/plugins/obsidian-reader/logs/errors.jsonl';
  await vi.waitFor(() => expect(files.get(path)).toContain('runtime.unhandled-rejection'));
  const entries = files
    .get(path)!
    .trim()
    .split('\n')
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
