import { afterEach, expect, it, vi } from 'vitest';
import { runtimeFixture } from './helpers/folder-runtime';
import { gate } from './helpers/memory-vault';

const folders = {
  articles: 'Capture',
  feeds: 'Subscriptions',
};
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

it('does not let an old refresh expire notes or clear the new generation refreshing flag', async () => {
  const f = await runtimeFixture(),
    release = gate();
  f.plugin.referencesRecovered = true;
  f.plugin.ingestion.refreshAll.mockImplementation(() => release.promise);
  const oldTick = f.plugin.tick(true);
  await f.plugin.applyFolders(folders);
  const expire = vi.spyOn(f.plugin, 'expire');
  f.plugin.refreshing = true;
  release.resolve();
  await oldTick;
  expect(expire).not.toHaveBeenCalled();
  expect(f.plugin.refreshing).toBe(true);
});

it('never promotes into new paths after an old generation read settles', async () => {
  const f = await runtimeFixture(),
    release = gate();
  const file = { path: 'Reading/Articles/Old.md' },
    store = f.plugin.store;
  f.app.notes.set(file.path, { file, properties: { type: 'article' } });
  store.catalog.update(file.path, { type: 'article' });
  f.plugin.promotions.set(file, true);
  vi.spyOn(store, 'read').mockImplementation(async () => {
    await release.promise;
    return { file, path: file.path, body: '==Keep==', properties: { type: 'article' } } as any;
  });
  const oldMove = vi.spyOn(store, 'move');
  const promotion = f.plugin.promote(file);
  await f.plugin.applyFolders(folders);
  const nextMove = vi.spyOn(f.plugin.store, 'move');
  f.plugin.promoting.add(file);
  release.resolve();
  await promotion;
  expect(oldMove).not.toHaveBeenCalled();
  expect(nextMove).not.toHaveBeenCalled();
  expect(f.plugin.promoting.has(file)).toBe(true);
});

it('waits for a previously dispatched view transition and stops its late-created old view', async () => {
  const f = await runtimeFixture(),
    entered = gate(),
    release = gate();
  // Simulate an old native view transition dispatched before Apply.
  const late = f.leaf();
  const pending = f.plugin.dispatchView(async () => {
    entered.resolve();
    await release.promise;
    await late.setViewState({ type: 'reader', state: {} });
  });
  await entered.promise;
  const retired = gate();
  f.plugin.ingestion.stop.mockImplementation(() => retired.resolve());
  const apply = f.plugin.applyFolders(folders);
  await retired.promise;
  expect(f.runtime.vaults).toHaveLength(1);
  release.resolve();
  await pending;
  await apply;
  expect(late.view.host.signal.aborted).toBe(false);
  expect(late.view.host.store.folders).toEqual(folders);
  expect(late.setViewState.mock.calls.at(-1)?.[0]).toEqual({
    type: 'reader',
    state: {},
    active: false,
  });
});

it('does not replace a native view reached while old Reader tabs are being cleared', async () => {
  const f = await runtimeFixture();
  const native = f.native.view;
  f.reader.setViewState.mockImplementationOnce(async () => {
    f.reader.view = native;
  });
  await f.plugin.applyFolders(folders);
  expect(f.reader.view).toBe(native);
  expect(f.reader.setViewState).toHaveBeenCalledTimes(1);
});

it('cannot reactivate after unload while waiting for dispatched writes', async () => {
  const f = await runtimeFixture(),
    entered = gate(),
    release = gate();
  f.runtime.vaults[0].drain.mockImplementation(async () => {
    entered.resolve();
    await release.promise;
  });
  const apply = f.plugin.applyFolders(folders);
  await entered.promise;
  f.plugin.onunload();
  release.resolve();
  await expect(apply).rejects.toThrow(/stopped/);
  expect(f.runtime.vaults).toHaveLength(1);
  expect(f.plugin.signal.aborted).toBe(true);
});

it('stays paused if native Reader-tab clearing fails, allowing an explicit retry', async () => {
  const f = await runtimeFixture();
  f.reader.setViewState.mockRejectedValueOnce(new Error('Host transition failed'));
  await expect(f.plugin.applyFolders(folders)).rejects.toThrow(/paused/);
  expect(f.plugin.signal.aborted).toBe(true);
  expect(f.runtime.vaults).toHaveLength(1);
  await f.plugin.applyFolders(folders);
  expect(f.plugin.signal.aborted).toBe(false);
  expect(f.reader.view.host.store.folders).toEqual(folders);
});

it('leaves malformed fresh saved configuration paused, but allows explicit repair', async () => {
  const f = await runtimeFixture({ captureFolders: { articles: 'Only one' } });
  expect(f.plugin.signal.aborted).toBe(true);
  expect(f.plugin.ingestion.stop).toHaveBeenCalledOnce();
  expect(f.runtime.notices[0]).toMatch(/paused/);
  await f.plugin.applyFolders(folders);
  expect(f.plugin.signal.aborted).toBe(false);
  expect(f.plugin.store.folders).toEqual(folders);
});

it.each([
  [undefined, 'Reading/Stream/Story.md', 'Later'],
  ['feed', 'Reading/Stream/Story.md', 'Later'],
  ['inbox', 'Reading/Stream/Story.md', 'Later'],
  ['later', 'Reading/Stream/Story.md', 'Later'],
  ['archive', 'Reading/Stream/Story.md', 'Later'],
  ['', 'Reading/Stream/Story.md', 'Later'],
  [null, 'Reading/Stream/Story.md', 'Later'],
  ['Feed', 'Reading/Stream/Story.md', 'Later'],
  ['feed', 'Elsewhere/Story.md', undefined],
  ['feed', 'Reading/Later/Story.md', undefined],
])(
  'rechecks folder membership despite fresh YAML status %j at %s before native promotion',
  async (status, path, destination) => {
    const f = await runtimeFixture();
    const file = { path },
      store = f.plugin.store;
    f.app.notes.set(file.path, { file });
    // The index is stale: the source bytes below are authoritative.
    store.catalog.update(file.path, { type: 'article', status: 'feed' });
    const properties = status === undefined ? { type: 'article' } : { type: 'article', status };
    const snapshot = { file, path: file.path, body: '==Keep==', properties } as any;
    vi.spyOn(store, 'read').mockResolvedValue(snapshot);
    const move = vi.spyOn(store, 'move').mockResolvedValue(snapshot);
    f.plugin.promotions.set(file, true);
    await f.plugin.promote(file);
    if (destination) expect(move).toHaveBeenCalledExactlyOnceWith(snapshot, destination);
    else expect(move).not.toHaveBeenCalled();
  },
);
