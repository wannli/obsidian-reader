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

it('creates subscriptions and latest-20 Stream captures in separate folders, deduplicating retained URLs', async () => {
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
  expect(store.catalog.feeds().map((feed) => feed.path)).toEqual(['Subscriptions/Example.md']);
  expect(store.catalog.list('Stream', '', 0, 100)).toHaveLength(19);
  expect(store.catalog.findUrl('https://example.com/0')?.path).toBe(keep.path);
  expect(store.catalog.findUrl('https://example.com/20')).toBeUndefined();
  for (const article of store.catalog.list('Stream', '', 0, 100)) {
    expect(article.path.startsWith('Disposable/')).toBe(true);
    const doc = readDocument(await vault.read(vault.file(article.path)!));
    expect(doc.properties.feed).toBe('[[Subscriptions/Example.md]]');
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
    if (index >= started.length) return response; // Normal post-subscription refresh.
    started[index].resolve();
    await releases[index].promise;
    return response;
  });
  const network = new Network(),
    oldVault = new MemoryVault(),
    oldStore = storeFor(oldVault);
  const old = new Ingestion(oldStore, vi.fn(), network);
  const first = old.subscribe('https://example.com/one').catch((error) => error);
  const second = old.subscribe('https://example.com/two').catch((error) => error);
  await Promise.all([started[0].promise, started[1].promise]);
  old.stop();
  oldStore.dispose();
  const nextStore = storeFor(new MemoryVault()),
    next = new Ingestion(nextStore, vi.fn(), network);
  const third = next.subscribe('https://example.com/three');
  await Promise.resolve();
  await Promise.resolve();
  expect(external.request).toHaveBeenCalledTimes(2);
  releases[0].resolve();
  await started[2].promise;
  expect(external.request).toHaveBeenCalledTimes(3);
  releases[1].resolve();
  releases[2].resolve();
  expect(await first).toBeInstanceOf(Error);
  expect(await second).toBeInstanceOf(Error);
  await third;
  expect(oldVault.files.size).toBe(0);
  expect(nextStore.catalog.feeds()).toHaveLength(1);
  next.stop();
  network.stop();
});
