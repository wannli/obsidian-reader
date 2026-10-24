import { beforeEach, expect, it, vi } from 'vitest';
import type { App, TFile } from 'obsidian';
import { FolderRuntime } from '../src/host/folder-runtime';
import { defaultFolders } from '../src/core/folders';
import { defaultStatusFolders } from '../src/core/status-folders';
import type { Network } from '../src/host/network';
import type { LibraryChange } from '../src/host/vault';
import { gate } from './helpers/memory-vault';

const controls = vi.hoisted(() => ({
  stop: vi.fn(),
  dispose: vi.fn(),
  unwatch: vi.fn(),
  drain: vi.fn(),
  watch: vi.fn(),
  callbacks: [] as ((change: LibraryChange) => void)[],
  notices: [] as ((message: string) => void)[],
}));
vi.mock('../src/host/vault', () => ({
  ObsidianVault: class {
    drain = controls.drain;
  },
  watchLibrary: (...args: unknown[]) => {
    controls.watch();
    controls.callbacks.push(args[2] as (change: LibraryChange) => void);
    return controls.unwatch;
  },
}));
vi.mock('../src/core/store', () => ({
  ArticleStore: class {
    setStatusFolders = vi.fn();
    dispose = controls.dispose;
  },
}));
vi.mock('../src/host/ingestion', () => ({
  Ingestion: class {
    stop = controls.stop;
    constructor(_store: unknown, notice: (message: string) => void) {
      controls.notices.push(notice);
    }
  },
}));
beforeEach(() => {
  vi.resetAllMocks();
  controls.callbacks = [];
  controls.notices = [];
  controls.drain.mockResolvedValue(undefined);
});
function start(runtime = new FolderRuntime()) {
  const changed = vi.fn(),
    notice = vi.fn(),
    stopNetwork = vi.fn();
  runtime.start(
    {} as App,
    defaultFolders,
    defaultStatusFolders,
    { stop: stopNetwork } as unknown as Network,
    changed,
    notice,
  );
  return { runtime, changed, notice, stopNetwork };
}
it('stops each owned service once without stopping the plugin-wide network', () => {
  const f = start();
  f.runtime.stop();
  f.runtime.stop();
  expect(f.runtime.signal.aborted).toBe(true);
  expect(controls.stop).toHaveBeenCalledOnce();
  expect(controls.unwatch).toHaveBeenCalledOnce();
  expect(controls.dispose).toHaveBeenCalledOnce();
  expect(f.stopNetwork).not.toHaveBeenCalled();
  expect(() => start(f.runtime)).toThrow('cannot restart');
});
it('keeps old callbacks and recovery state separate from the replacement generation', () => {
  const old = start();
  old.runtime.attempted.add('Old.md');
  const callback = controls.callbacks[0],
    notice = controls.notices[0];
  old.runtime.stop();
  const file = { path: 'Existing.md' } as TFile;
  const next = start(new FolderRuntime({ recoverStartup: false, deferredSeeds: [file] }));
  callback({ path: 'Old.md' });
  notice('Old failure');
  controls.callbacks[1]({ path: file.path });
  controls.notices[1]('Current failure');
  expect(old.changed).not.toHaveBeenCalled();
  expect(old.notice).not.toHaveBeenCalled();
  expect(next.changed).toHaveBeenCalledWith({ path: file.path });
  expect(next.notice).toHaveBeenCalledWith('Current failure');
  expect(next.runtime.signal.aborted).toBe(false);
  expect(next.runtime.attempted.size).toBe(0);
  expect(old.runtime.attempted.has('Old.md')).toBe(true);
  expect(next.runtime.startupCaptureRecoveryPending).toBe(false);
  expect(next.runtime.deferredCaptureSeeds.has(file)).toBe(true);
});
it('drains actual native work after stop instead of releasing it early', async () => {
  const f = start(),
    held = gate();
  controls.drain.mockReturnValueOnce(held.promise);
  f.runtime.stop();
  let done = false;
  const draining = f.runtime.drain().then(() => {
    done = true;
  });
  await Promise.resolve();
  expect(done).toBe(false);
  held.resolve();
  await draining;
  expect(done).toBe(true);
  expect(controls.drain).toHaveBeenCalledOnce();
});
it('cleans partial startup and remains stopped if watcher construction fails', () => {
  const runtime = new FolderRuntime();
  controls.watch.mockImplementationOnce(() => {
    throw new Error('Watcher failed');
  });
  expect(() => start(runtime)).toThrow('Watcher failed');
  expect(runtime.signal.aborted).toBe(true);
  expect(controls.stop).toHaveBeenCalledOnce();
  expect(controls.dispose).toHaveBeenCalledOnce();
  runtime.stop();
  expect(controls.dispose).toHaveBeenCalledOnce();
});
it('still disposes the store when watcher disposal throws, and does not replay disposal', () => {
  const f = start();
  controls.unwatch.mockImplementationOnce(() => {
    throw new Error('Unwatch failed');
  });
  expect(() => f.runtime.stop()).toThrow('Unwatch failed');
  expect(controls.dispose).toHaveBeenCalledOnce();
  expect(() => f.runtime.stop()).not.toThrow();
  expect(controls.unwatch).toHaveBeenCalledOnce();
});
it('can stop and drain before startup without creating services', async () => {
  const runtime = new FolderRuntime();
  runtime.stop();
  await runtime.drain();
  expect(runtime.signal.aborted).toBe(true);
  expect(controls.watch).not.toHaveBeenCalled();
  expect(controls.stop).not.toHaveBeenCalled();
  expect(() => start(runtime)).toThrow('cannot restart');
});
