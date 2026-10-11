import { afterEach, expect, it, vi } from 'vitest';
import { ReaderController } from '../src/controller';
import * as ingestion from '../src/ingest/extract';
import { MemoryStore } from '../src/storage/memory';
import { ReaderRepository } from '../src/storage/repository';
import { parseNote } from '../src/storage/markdown';
import { DEFAULT_SETTINGS, type HttpGet } from '../src/types';

afterEach(() => vi.restoreAllMocks());
const path = 'Elsewhere/Old article.md';
const raw = '---\ntype: article\nurl: https://publisher.example/article\nstatus: later\ncontent: pending\nextractor: pending\n---\n';

it('keeps typed nonqueue articles readable and out of queue listings, with absent runtime queue', async () => {
  const store = new MemoryStore({ [path]: raw }), repo = new ReaderRepository(store, DEFAULT_SETTINGS);
  expect(await repo.listArticles()).toEqual([]);
  await expect(repo.getArticle(path)).resolves.toMatchObject({ path, status: undefined, content: 'pending', url: 'https://publisher.example/article' });
  expect(await store.read(path)).toBe(raw);
});

it('never auto-acquires an unqueued article on activation or reconnect, but explicit fetch is allowed in place', async () => {
  const store = new MemoryStore({ [path]: raw }), settings = { ...DEFAULT_SETTINGS }, repo = new ReaderRepository(store, settings);
  const get = vi.fn<HttpGet>().mockResolvedValue({ status: 200, headers: {}, text: '<html>ignored</html>' });
  const controller = new ReaderController(repo, get, settings);
  const extract = vi.spyOn(ingestion, 'extractArticle').mockResolvedValue({ title: 'Fetched', markdown: 'Full text.', status: 'ready', extractor: 'defuddle' });
  controller.setActive(true);
  await new Promise(resolve => setTimeout(resolve, 220));
  controller.setOnline(false); controller.setOnline(true);
  await new Promise(resolve => setTimeout(resolve, 220));
  expect(extract).not.toHaveBeenCalled(); expect(await store.read(path)).toBe(raw);

  const fetched = await controller.fetchFullText(path);
  expect(extract).toHaveBeenCalledExactlyOnceWith('https://publisher.example/article', get, 'defuddle');
  expect(fetched).toMatchObject({ path, status: undefined, body: 'Full text.' });
  expect(parseNote(await store.read(path)).doc.has('extractor')).toBe(true); // Legacy metadata is preserved.
  expect(await store.exists(path)).toBe(true);
  expect(await store.read(path)).toContain('status: later');
  expect((await repo.listArticles())).toEqual([]);
  await controller.shutdown();
});
