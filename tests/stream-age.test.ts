import { afterEach, expect, it, vi } from 'vitest';
import { streamCutoff, expiredStreamItem } from '../src/stream-age';
import { ReaderController } from '../src/controller';
import { ReaderRepository } from '../src/storage/repository';
import { MemoryStore } from '../src/storage/memory';
import { DEFAULT_SETTINGS, type HttpGet } from '../src/types';
import { dummyArticle } from '../src/ingest/dummy';

const now = new Date('2026-03-31T12:34:56.789Z');
const cutoff = streamCutoff(now);
const old = '2026-02-28T12:34:56.788Z';
const boundary = '2026-02-28T12:34:56.789Z';
const path = 'Reading/Stream/Old.md';
const note = (extra = '', body = '') => `---\ntype: article\ntitle: Old\nurl: https://example.test/old\npublished: ${old}\n${extra}---\n${body}`;
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });
it.each([
  ['2026-03-31T12:34:56.789Z', boundary],
  ['2024-03-31T12:34:56.789Z', '2024-02-29T12:34:56.789Z'],
  ['2026-01-15T00:00:00.000Z', '2025-12-15T00:00:00.000Z'],
  ['2026-10-12T06:00:00.000Z', '2026-09-12T06:00:00.000Z'],
])('clamps the previous UTC calendar month: %s', (today, expected) => {
  expect(new Date(streamCutoff(new Date(today))).toISOString()).toBe(expected);
});
it('uses publication first, legacy fetched only as fallback, and preserves unknown age/boundary', () => {
  expect(expiredStreamItem(old, boundary, cutoff)).toBe(true);
  expect(expiredStreamItem(boundary, old, cutoff)).toBe(false);
  expect(expiredStreamItem('2026-02-30', old, cutoff)).toBe(true);
  expect(expiredStreamItem(undefined, old, cutoff)).toBe(true);
  expect(expiredStreamItem('bad', 'bad', cutoff)).toBe(false);
});
it('actually removes expired disposable Stream notes but never saved/library or undated notes', async () => {
  const initial = {
    [path]: note(),
    'Reading/Stream/Summary.md': note('summary: Publisher excerpt\n', 'Publisher excerpt'),
    'Reading/Stream/Legacy.md': note().replace(`published: ${old}`, `fetched: ${old}`),
    'Reading/Stream/Boundary.md': note().replace(old, boundary),
    'Reading/Stream/260101 Undated.md': note().replace(`published: ${old}\n`, ''),
    'Reading/Inbox/Old.md': note(), 'Reading/Later/Old.md': note(), 'Reading/Treasury/Old.md': note(),
    'Library/Old.md': note(),
  };
  const store = new MemoryStore(initial), repo = new ReaderRepository(store, DEFAULT_SETTINGS);
  const result = await repo.cleanupStream(cutoff);
  expect(result.deleted.sort()).toEqual([path, 'Reading/Stream/Summary.md', 'Reading/Stream/Legacy.md'].sort());
  for (const [key, value] of Object.entries(initial)) if (!result.deleted.includes(key)) expect(await store.read(key)).toBe(value);
  expect(repo.articleGeneration(path)).toBeGreaterThan(0);
});
it.each([
  note('', 'Unowned full feed text or authored text'),
  note('summary: Publisher excerpt\n', 'Publisher excerpt\n\n## Comments\nAuthored'),
  note('custom: preserve\n'), note('topics: [Important]\n'), note('# User YAML comment\n'),
  note('content: protected\n'), note('reading_position: {}\n'),
  note('', '<!-- user comment -->'),
])('preserves protected text, annotations and unknown metadata byte-for-byte', async raw => {
  const store = new MemoryStore({ [path]: raw }), repo = new ReaderRepository(store, DEFAULT_SETTINGS);
  expect((await repo.cleanupStream(cutoff)).retained).toEqual([path]);
  expect(await store.read(path)).toBe(raw);
});
it.each(['[[Old]]', '[[Reading/Stream/Old#Heading|Saved]]', '[Saved](Reading/Stream/Old.md)', '[Saved](Reading/Stream/Old)', '[saved]: Reading/Stream/Old.md'])('preserves referenced and busy notes: %s', async reference => {
  const store = new MemoryStore({ [path]: note(), 'Journal.md': reference }), repo = new ReaderRepository(store, DEFAULT_SETTINGS);
  expect((await repo.cleanupStream(cutoff)).deleted).toEqual([]);
  const solo = new ReaderRepository(new MemoryStore({ [path]: note() }), DEFAULT_SETTINGS);
  expect((await solo.cleanupStream(cutoff, () => true)).retained).toEqual([path]);
});
it('deletes a recognized dummy snapshot without weakening ownership checks', async () => {
  const store = new MemoryStore({ [path]: note('', dummyArticle('https://example.test/old').markdown) });
  expect((await new ReaderRepository(store, DEFAULT_SETTINGS).cleanupStream(cutoff)).deleted).toEqual([path]);
});
function setup(get: HttpGet, initial: Record<string, string> = { [path]: note() }) {
  vi.useFakeTimers(); vi.setSystemTime(now);
  const store = new MemoryStore(initial), settings = { ...DEFAULT_SETTINGS, maxFeedItems: 1 };
  const repo = new ReaderRepository(store, settings), controller = new ReaderController(repo, get, settings);
  return { store, repo, controller };
}
const xml = `<rss><channel><title>News</title><item><title>Old</title><link>https://example.test/old</link><pubDate>${old}</pubDate></item><item><title>Recent</title><link>https://example.test/recent</link><pubDate>${boundary}</pubDate></item></channel></rss>`;
it('filters before the item cap on subscribe and refresh; never reimports expired items', async () => {
  const get = vi.fn<HttpGet>().mockResolvedValue({ status: 200, text: xml, headers: {} });
  const { repo, controller, store } = setup(get);
  const feed = await controller.subscribeFeed('https://example.test/rss');
  expect(await store.exists(path)).toBe(false);
  expect((await repo.listArticles()).map(a => a.url)).toEqual(['https://example.test/recent']);
  await repo.updateFeed(feed.path, { enabled: true });
  await controller.refreshFeeds();
  expect((await repo.listArticles()).map(a => a.url)).toEqual(['https://example.test/recent']);
  await controller.shutdown();
});
it.each(['no feeds', 'disabled', '304', 'failure', 'not due'] as const)('cleans up even with %s', async mode => {
  const get = vi.fn<HttpGet>().mockImplementation(async () => {
    if (mode === 'failure') throw new Error('Offline');
    return { status: 304, text: '', headers: {} };
  });
  const { repo, controller, store } = setup(get);
  if (mode !== 'no feeds') {
    const feed = await repo.createFeed('News', 'https://example.test/rss');
    await repo.updateFeed(feed.path, { enabled: mode !== 'disabled' });
    if (mode === 'not due') {
      await controller.refreshFeeds(false);
      // Reintroduce an expired note to prove even a throttled check still cleans.
      await store.create(path, note());
      get.mockClear();
    }
  }
  await controller.refreshFeeds(mode !== 'not due');
  expect(await store.exists(path)).toBe(false);
  if (mode === 'failure') expect(controller.message).toContain('Offline');
  if (mode === 'not due') expect(get).not.toHaveBeenCalled();
  await controller.shutdown();
});
it('cleans before a failed subscription request and reports protected cleanup exceptions on refresh', async () => {
  const { controller, store } = setup(async () => { throw new Error('Offline'); }, { [path]: note(), 'Reading/Stream/Protected.md': note('', 'Authored') });
  await expect(controller.subscribeFeed('https://example.test/rss')).rejects.toThrow('Offline');
  expect(await store.exists(path)).toBe(false);
  await controller.refreshFeeds(); expect(controller.message).toContain('retained 1');
  await controller.shutdown();
});
