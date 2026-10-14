import { afterEach, expect, it, vi } from 'vitest';
import { runtimeFixture } from './helpers/folder-runtime';
import { gate } from './helpers/memory-vault';
import { defaultFolders } from '../src/core/folders';

const folders = {
  inbox: 'Capture',
  stream: 'Disposable',
  later: 'Plans',
  treasury: 'Kept',
  feeds: 'Subscriptions',
};
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

it('ignores legacy settings, applies the whole group, and recreates only Reader leaves as lists', async () => {
  const legacy = {
    root: 'Ignored',
    feedsFolder: 'Old feeds',
    pollMinutes: 1,
    maxFeedItems: 999,
    custom: { untouched: true },
  };
  const f = await runtimeFixture(legacy);
  const old = f.reader.view,
    host = old.host,
    native = f.native.view,
    vault = f.runtime.vaults[0];
  const oldStore = f.plugin.store,
    oldIngestion = f.plugin.ingestion;
  const exemption = { file: {}, transitioning: false };
  f.plugin.sourceLeaves.set(f.native, exemption);
  f.app.notes.set('Reading/Inbox/Old.md', {
    file: { path: 'Reading/Inbox/Old.md' },
    properties: { type: 'article', url: 'https://example.com/old' },
    raw: 'Unchanged authored bytes',
  });
  f.app.notes.set('Subscriptions/Feed.md', {
    properties: { type: 'feed', url: 'https://example.com/feed' },
  });
  expect(oldStore.folders).toEqual(defaultFolders);
  await f.plugin.applyFolders(folders);
  expect(f.plugin.data).toEqual({ ...legacy, folders });
  expect(f.plugin.store.folders).toEqual(folders);
  expect(f.plugin.store.catalog.article('Reading/Inbox/Old.md')?.queue).toBeUndefined();
  expect(f.plugin.store.catalog.findUrl('https://example.com/old')?.path).toBe(
    'Reading/Inbox/Old.md',
  );
  expect(f.plugin.store.catalog.feeds()).toHaveLength(1);
  expect(f.app.notes.get('Reading/Inbox/Old.md').raw).toBe('Unchanged authored bytes');
  expect(old.stopped).toBe(true);
  expect(host.signal.aborted).toBe(true);
  expect(host.store).toBe(oldStore);
  expect(host.ingestion).toBe(oldIngestion);
  expect(vault.active()).toBe(false);
  expect(f.runtime.vaults[1].active()).toBe(true);
  expect(oldIngestion.stop).toHaveBeenCalledOnce();
  expect(f.runtime.watchers[0].stop).toHaveBeenCalledOnce();
  expect(f.plugin.ingestion.network).toBe(oldIngestion.network);
  expect(oldIngestion.network.stop).not.toHaveBeenCalled();
  expect(f.reader.view).not.toBe(old);
  expect(f.reader.view.host.store).toBe(f.plugin.store);
  expect(f.reader.setViewState.mock.calls.map(([state]: any) => state)).toEqual([
    { type: 'empty', active: false },
    { type: 'reader', state: {}, active: false },
  ]);
  expect(f.native.view).toBe(native);
  expect(f.native.setViewState).not.toHaveBeenCalled();
  expect(f.plugin.sourceLeaves.get(f.native)).toBe(exemption);
  expect(f.plugin.ingestion.acquire).not.toHaveBeenCalled();
  expect(f.plugin.ingestion.refreshAll).not.toHaveBeenCalled();
  const capture = vi.spyOn(f.plugin, 'capture'),
    feeds = vi.spyOn(f.plugin, 'feeds'),
    edit = vi.spyOn(f.plugin, 'edit');
  host.capture();
  host.feeds();
  await host.edit(old, {});
  expect(capture).not.toHaveBeenCalled();
  expect(feeds).not.toHaveBeenCalled();
  expect(edit).not.toHaveBeenCalled();
  localStorage.setItem('obsidian-reader:eink', '1');
  expect(f.reader.view.host.paged).toBe(true);
});

it('rejects invalid groups or failed persistence before retiring the current generation', async () => {
  const f = await runtimeFixture();
  const signal = f.plugin.signal,
    store = f.plugin.store;
  expect(() => f.plugin.applyFolders({ ...folders, feeds: 'Capture/nested' })).toThrow(/overlap/);
  expect(f.plugin.saveData).not.toHaveBeenCalled();
  f.plugin.saveData.mockRejectedValueOnce(new Error('Disk full'));
  await expect(f.plugin.applyFolders(folders)).rejects.toThrow('Disk full');
  expect(signal.aborted).toBe(false);
  expect(f.plugin.store).toBe(store);
  expect(f.reader.view.stopped).toBe(false);
});

it('drains dispatched writes before activating replacements, with immutable old callbacks', async () => {
  const f = await runtimeFixture();
  const entered = gate(),
    release = gate(),
    oldHost = f.reader.view.host;
  f.runtime.vaults[0].drain.mockImplementation(async () => {
    entered.resolve();
    await release.promise;
  });
  const apply = f.plugin.applyFolders(folders);
  await entered.promise;
  expect(oldHost.signal.aborted).toBe(true);
  expect(f.plugin.store).toBe(oldHost.store);
  expect(f.runtime.vaults).toHaveLength(1);
  release.resolve();
  await apply;
  expect(f.runtime.vaults).toHaveLength(2);
  expect(oldHost.signal.aborted).toBe(true);
  expect(f.plugin.signal.aborted).toBe(false);
});

it('serializes overlapping applies and preserves unknown data through each persistence', async () => {
  const f = await runtimeFixture({ extra: true });
  const entered = gate(),
    release = gate();
  f.plugin.saveData.mockImplementationOnce(async (data: unknown) => {
    entered.resolve();
    await release.promise;
    f.plugin.data = data;
  });
  const first = f.plugin.applyFolders(folders),
    secondFolders = { ...folders, inbox: 'Other capture' };
  const second = f.plugin.applyFolders(secondFolders);
  await entered.promise;
  expect(f.plugin.saveData).toHaveBeenCalledTimes(1);
  expect(f.plugin.store.folders).toEqual(defaultFolders);
  release.resolve();
  await Promise.all([first, second]);
  expect(f.plugin.saveData).toHaveBeenCalledTimes(2);
  expect(f.plugin.data).toEqual({ extra: true, folders: secondFolders });
  expect(f.plugin.store.folders).toEqual(secondFolders);
  expect(
    f.runtime.watchers.slice(0, -1).every((watcher: any) => watcher.stop.mock.calls.length === 1),
  ).toBe(true);
});

it('rejects unload during save and never starts a replacement runtime', async () => {
  const f = await runtimeFixture();
  const entered = gate(),
    release = gate();
  f.plugin.saveData.mockImplementationOnce(async () => {
    entered.resolve();
    await release.promise;
  });
  const result = f.plugin.applyFolders(folders);
  await entered.promise;
  f.plugin.onunload();
  release.resolve();
  await expect(result).rejects.toThrow(/stopped/);
  expect(f.runtime.vaults).toHaveLength(1);
  expect(f.plugin.signal.aborted).toBe(true);
  expect(f.plugin.ingestion.network.stop).toHaveBeenCalledOnce();
});
