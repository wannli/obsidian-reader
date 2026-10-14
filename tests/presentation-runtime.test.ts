import { afterEach, expect, it, vi } from 'vitest';
import { runtimeFixture } from './helpers/folder-runtime';
import { gate } from './helpers/memory-vault';

const folders = {
  inbox: 'Capture',
  stream: 'Disposable',
  later: 'Plans',
  treasury: 'Kept',
  feeds: 'Subscriptions',
};
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

it('drains a delayed title-only native transition before replacing a folder generation', async () => {
  const f = await runtimeFixture(),
    entered = gate(),
    release = gate();
  const old = f.reader.view,
    oldHost = old.host,
    dispatch = f.reader.setViewState.getMockImplementation()!;
  f.reader.setViewState.mockImplementation(async (state: any) => {
    if (state.state?.readerPresentationOnly) {
      entered.resolve();
      await release.promise;
      return;
    }
    return dispatch(state);
  });
  const refresh = oldHost.refreshPresentation(old);
  await entered.promise;
  const retired = gate();
  f.plugin.ingestion.stop.mockImplementation(() => retired.resolve());
  const apply = f.plugin.applyFolders(folders);
  await retired.promise;
  expect(oldHost.signal.aborted).toBe(true);
  expect(f.runtime.vaults).toHaveLength(1);
  release.resolve();
  await refresh;
  await apply;
  expect(f.reader.setViewState.mock.calls.map(([state]: any) => state)).toEqual([
    { type: 'reader', state: { readerPresentationOnly: true } },
    { type: 'empty', active: false },
    { type: 'reader', state: {}, active: false },
  ]);
  expect(f.reader.view).not.toBe(old);
  expect(f.reader.view.host.signal.aborted).toBe(false);
  await oldHost.refreshPresentation(old);
  expect(f.reader.setViewState).toHaveBeenCalledTimes(3);
});

it('rejects a queued presentation after its originating view stops', async () => {
  const f = await runtimeFixture(),
    entered = gate(),
    release = gate();
  const view = f.reader.view;
  f.reader.setViewState.mockImplementation(async () => {
    entered.resolve();
    await release.promise;
  });
  const first = view.host.refreshPresentation(view, () => true);
  await entered.promise;
  let valid = true;
  const queued = view.host.refreshPresentation(view, () => valid);
  valid = false;
  release.resolve();
  await first;
  await queued;
  expect(f.reader.setViewState).toHaveBeenCalledOnce();
});

it('settles title refreshes before Markdown escape and rejects queued/stale refreshes', async () => {
  const f = await runtimeFixture(),
    entered = gate(),
    release = gate(),
    prepared = gate();
  const view = f.reader.view,
    file = { path: 'Reading/Inbox/Article.md' };
  view.file = file;
  view.prepareMarkdown = vi.fn(async () => {
    prepared.resolve();
  });
  f.app.notes.set(file.path, { file, properties: { type: 'article' } });
  const dispatch = f.reader.setViewState.getMockImplementation()!;
  f.reader.setViewState.mockImplementation(async (state: any) => {
    if (state.state?.readerPresentationOnly) {
      entered.resolve();
      await release.promise;
      return;
    }
    return dispatch(state);
  });
  const refresh = view.host.refreshPresentation(view);
  await entered.promise;
  const queued = view.host.refreshPresentation(view);
  const edit = view.host.edit(view, file);
  await prepared.promise;
  await Promise.resolve();
  expect(f.reader.setViewState).toHaveBeenCalledTimes(1);
  expect(f.plugin.sourceLeaves.get(f.reader)?.transitioning).toBe(true);
  release.resolve();
  await refresh;
  await queued;
  await edit;
  expect(f.reader.setViewState.mock.calls.map(([state]: any) => state.type)).toEqual([
    'reader',
    'markdown',
  ]);
  expect(f.reader.view.getViewType()).toBe('markdown');
  await view.host.refreshPresentation(view);
  expect(f.reader.setViewState).toHaveBeenCalledTimes(2);
});
