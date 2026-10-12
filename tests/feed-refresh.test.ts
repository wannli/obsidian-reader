import { afterEach, expect, it, vi } from 'vitest';
import { ReaderController } from '../src/controller';
import { ReaderRepository } from '../src/storage/repository';
import { MemoryStore } from '../src/storage/memory';
import { parseNote } from '../src/storage/markdown';
import { DEFAULT_SETTINGS, type HttpGet } from '../src/types';

const path = 'Reading/Wires/News.md';
const xml = '<rss><channel><title>News</title></channel></rss>';
const response = { status: 200, text: xml, headers: { etag: 'server-tag', 'last-modified': 'Tue, 01 Jan 2030 00:00:00 GMT' } };
const raw = '---\ntype: feed\nid: feed-news\ntitle: News\nurl: https://example.test/rss\nenabled: true\nchecked: 2099-01-01 # Authored\nmodified: my date\netag: my tag\ncustom: [keep, me]\n---\n\n# My feed notes\nKeep this.\n';
function setup(initial = raw) {
  const store = new MemoryStore({ [path]: initial }), settings = { ...DEFAULT_SETTINGS };
  const repo = new ReaderRepository(store, settings), get = vi.fn<HttpGet>().mockResolvedValue(response);
  const controller = new ReaderController(repo, get, settings);
  return { store, settings, repo, get, controller };
}
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

it('leaves legacy/authored metadata and the entire feed byte-identical on 200 and 304, including restart', async () => {
  const { store, repo, get, controller, settings } = setup();
  const update = vi.spyOn(repo, 'updateFeed');
  await controller.refreshFeeds(false); // A future legacy checked value must not skip this.
  get.mockResolvedValueOnce({ ...response, status: 304, text: '' });
  await controller.refreshFeeds();
  expect(await store.read(path)).toBe(raw);
  expect(update).not.toHaveBeenCalled();
  await controller.shutdown();
  const restarted = new ReaderController(repo, get, settings);
  await restarted.refreshFeeds(false);
  expect(get.mock.calls).toEqual(Array.from({ length: 3 }, () => ['https://example.test/rss']));
  expect(await store.read(path)).toBe(raw);
  expect(update).not.toHaveBeenCalled();
  await restarted.shutdown();
});

it('does not persist timestamps, validators or an empty error when subscribing', async () => {
  const { store, repo, controller } = setup();
  const feed = await controller.subscribeFeed('https://example.test/new');
  const contents = await store.read(feed.path);
  expect(contents).not.toMatch(/^(checked|modified|etag|error):/m);
  expect(await repo.listFeeds()).toHaveLength(2);
  await controller.shutdown();
});

it('throttles minute ticks for four hours, but manual refresh bypasses the throttle', async () => {
  vi.useFakeTimers(); vi.setSystemTime(0);
  const { controller, get } = setup();
  await controller.refreshFeeds(false);
  for (let minute = 1; minute < 240; minute++) {
    vi.setSystemTime(minute * 60000);
    await controller.refreshFeeds(false);
  }
  expect(get).toHaveBeenCalledTimes(1);
  vi.setSystemTime(240 * 60000);
  await controller.refreshFeeds(false);
  expect(get).toHaveBeenCalledTimes(2);
  await controller.refreshFeeds();
  expect(get).toHaveBeenCalledTimes(3);
  await controller.refreshFeeds(false);
  expect(get).toHaveBeenCalledTimes(3);
  await controller.shutdown();
});

it('respects custom intervals and retries a changed feed URL immediately', async () => {
  vi.useFakeTimers(); vi.setSystemTime(0);
  const { controller, get, settings, repo } = setup(); settings.pollMinutes = 60;
  await controller.refreshFeeds(false);
  vi.setSystemTime(59 * 60000); await controller.refreshFeeds(false);
  expect(get).toHaveBeenCalledTimes(1);
  vi.setSystemTime(60 * 60000); await controller.refreshFeeds(false);
  expect(get).toHaveBeenCalledTimes(2);
  await repo.updateFeed(path, { url: 'https://example.test/changed' });
  await controller.refreshFeeds(false);
  expect(get).toHaveBeenLastCalledWith('https://example.test/changed');
  expect(get).toHaveBeenCalledTimes(3);
  await controller.shutdown();
});

it('retries an offline startup failure automatically on reconnect without polling each minute', async () => {
  vi.useFakeTimers(); vi.setSystemTime(0);
  const { controller, get, repo } = setup();
  controller.setOnline(false);
  get.mockRejectedValue(new TypeError('Network unavailable'));
  await controller.refreshFeeds(false);
  for (let minute = 1; minute <= 5; minute++) {
    vi.setSystemTime(minute * 60000);
    await controller.refreshFeeds(false);
  }
  expect(get).toHaveBeenCalledTimes(1);
  get.mockResolvedValue(response);
  // Same order as main's online event: update connectivity, then scheduled refresh.
  controller.setOnline(true);
  await controller.refreshFeeds(false);
  expect(get).toHaveBeenCalledTimes(2);
  expect((await repo.listFeeds())[0].error).toBe('');
  controller.setOnline(false); controller.setOnline(true);
  await controller.refreshFeeds(false);
  expect(get).toHaveBeenCalledTimes(2); // Success cleared the reconnect retry flag.
  await controller.shutdown();
});

it.each([404, 500])('does not bypass HTTP %i failure cadence on reconnect', async status => {
  vi.useFakeTimers(); vi.setSystemTime(0);
  const { controller, get } = setup();
  controller.setOnline(false);
  get.mockResolvedValue({ ...response, status });
  await controller.refreshFeeds(false);
  controller.setOnline(true);
  vi.setSystemTime(60000); await controller.refreshFeeds(false);
  expect(get).toHaveBeenCalledTimes(1);
  vi.setSystemTime(240 * 60000); await controller.refreshFeeds(false);
  expect(get).toHaveBeenCalledTimes(2);
  await controller.shutdown();
});

it('does not treat import failures as transport failures on reconnect', async () => {
  const { controller, repo, get } = setup();
  controller.setOnline(false);
  get.mockResolvedValue({ ...response, text: '<rss><channel><title>News</title><item><title>A</title><link>https://example.test/a</link></item></channel></rss>' });
  vi.spyOn(repo, 'createArticle').mockRejectedValue(new Error('Read-only vault'));
  await controller.refreshFeeds(false);
  controller.setOnline(true);
  await controller.refreshFeeds(false);
  expect(get).toHaveBeenCalledTimes(1);
  await controller.shutdown();
});

it.each([200, 304])('records errors only on change and clears them once on HTTP %i', async status => {
  vi.useFakeTimers(); vi.setSystemTime(0);
  const { store, repo, get, controller } = setup();
  const update = vi.spyOn(repo, 'updateFeed');
  get.mockRejectedValue(new Error('Offline'));
  await controller.refreshFeeds(false);
  expect((await repo.listFeeds())[0].error).toBe('Offline');
  expect(update).toHaveBeenCalledTimes(1);
  vi.setSystemTime(60000); await controller.refreshFeeds(false);
  expect(get).toHaveBeenCalledTimes(1); // Failed attempts obey the schedule too.
  await controller.refreshFeeds();
  expect(update).toHaveBeenCalledTimes(1);
  get.mockResolvedValue({ ...response, status, text: status === 304 ? '' : xml });
  await controller.refreshFeeds();
  expect((await repo.listFeeds())[0].error).toBe('');
  expect(update).toHaveBeenCalledTimes(2);
  const recovered = await store.read(path);
  await controller.refreshFeeds();
  expect(await store.read(path)).toBe(recovered);
  expect(update).toHaveBeenCalledTimes(2);
  expect(recovered).toContain('checked: 2099-01-01 # Authored\nmodified: my date\netag: my tag');
  expect(parseNote(recovered).doc.toJS().custom).toEqual(['keep', 'me']);
  expect(recovered).toContain('# My feed notes\nKeep this.');
  await controller.shutdown();
});
