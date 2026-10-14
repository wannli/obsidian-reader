import { afterEach, expect, it, vi } from 'vitest';
import type { TFile } from 'obsidian';
import { ArticleStore } from '../src/core/store';
import { readDocument } from '../src/core/document';
import { MemoryVault, gate } from './helpers/memory-vault';

const external = vi.hoisted(() => ({ request: vi.fn(), items: [] as any[] }));
vi.mock('obsidian', () => ({ requestUrl: external.request }));
vi.mock('../src/content/feed', () => ({
  parseFeed: () => ({ title: 'Example', items: external.items }),
  feedMarkdown: async (item: any) => item.body ?? '',
}));
vi.mock('../src/content/extract', () => ({ extract: vi.fn() }));
import { Ingestion } from '../src/host/ingestion';
import { Network } from '../src/host/network';

const folders = {
  inbox: 'Capture',
  stream: 'Disposable',
  later: 'Plans',
  treasury: 'Kept',
  feeds: 'Subscriptions',
};
const response = { text: '<rss/>', status: 200, headers: {} };
const storeFor = (vault: MemoryVault) =>
  new ArticleStore(vault, folders) as unknown as ArticleStore<TFile>;
afterEach(() => {
  external.request.mockReset();
  external.items = [];
});

it('adds locally, then explicitly syncs latest-20 Stream captures in separate folders, deduplicating retained URLs', async () => {
  const vault = new MemoryVault(),
    store = storeFor(vault);
  external.items = Array.from({ length: 25 }, (_, i) => ({
    url: `https://example.com/${i}`,
    title: `Article ${i}`,
    body: `Body ${i}`,
    published: new Date(Date.now() - i * 60_000).toISOString(),
  }));
  external.request.mockResolvedValue(response);
  const keep = await store.capture({
    url: 'https://example.com/0',
    title: 'Existing',
    queue: 'Treasury',
    body: 'Authored',
  });
  const ingestion = new Ingestion(store, vi.fn());
  await ingestion.subscribe('https://example.com/feed');
  expect(store.catalog.feeds().map((feed) => feed.path)).toEqual(['Subscriptions/example.com.md']);
  expect(external.request).not.toHaveBeenCalled();
  expect(store.catalog.list('Stream', '', 0, 100)).toEqual([]);
  await ingestion.refreshAll();
  expect(store.catalog.list('Stream', '', 0, 100)).toHaveLength(19);
  expect(store.catalog.findUrl('https://example.com/0')?.path).toBe(keep.path);
  expect(store.catalog.findUrl('https://example.com/20')).toBeUndefined();
  for (const article of store.catalog.list('Stream', '', 0, 100)) {
    expect(article.path.startsWith('Disposable/')).toBe(true);
    const doc = readDocument(await vault.read(vault.file(article.path)!));
    expect(doc.properties.feed).toBe('[[Subscriptions/example.com.md]]');
    expect(doc.properties).not.toHaveProperty('queue');
  }
  ingestion.stop();
});

it('does not discover or import unconfigured feed notes', async () => {
  const store = storeFor(new MemoryVault());
  for (const path of ['Reading/Wires/Old.md', 'Elsewhere/Feed.md', 'Subscriptions extra/Feed.md'])
    store.catalog.update(path, { type: 'feed', url: 'https://example.com/feed' });
  const ingestion = new Ingestion(store, vi.fn());
  await ingestion.refreshAll();
  expect(external.request).not.toHaveBeenCalled();
  expect(store.catalog.feeds()).toEqual([]);
  ingestion.stop();
});

it('retains native network slots when replacing a stopped ingestion generation', async () => {
  const releases = [gate(), gate(), gate()],
    started = [gate(), gate(), gate()];
  external.request.mockImplementation(async () => {
    const index = external.request.mock.calls.length - 1;
    started[index].resolve();
    await releases[index].promise;
    return response;
  });
  const network = new Network(),
    oldVault = new MemoryVault(),
    oldStore = storeFor(oldVault);
  const old = new Ingestion(oldStore, vi.fn(), network);
  external.items = [
    { url: 'https://example.com/article', title: 'Article', body: 'Publisher text' },
  ];
  await Promise.all([
    old.subscribe('https://example.com/one'),
    old.subscribe('https://example.com/two'),
  ]);
  expect(external.request).not.toHaveBeenCalled();
  const before = new Map(oldVault.bytes);
  const oldSync = old.refreshAll();
  await Promise.all([started[0].promise, started[1].promise]);
  old.stop();
  oldStore.dispose();
  const nextStore = storeFor(new MemoryVault()),
    next = new Ingestion(nextStore, vi.fn(), network);
  await next.subscribe('https://example.com/three');
  const third = next.refreshAll();
  await Promise.resolve();
  await Promise.resolve();
  expect(external.request).toHaveBeenCalledTimes(2);
  releases[0].resolve();
  await started[2].promise;
  expect(external.request).toHaveBeenCalledTimes(3);
  releases[1].resolve();
  releases[2].resolve();
  await Promise.all([oldSync, third]);
  expect(oldVault.files.size).toBe(2); // Only the subscriptions saved before stopping.
  expect(oldVault.bytes).toEqual(before); // No late article imports or error writes.
  expect(nextStore.catalog.feeds()).toHaveLength(1);
  expect(nextStore.catalog.list('Stream')).toHaveLength(1);
  next.stop();
  network.stop();
});
