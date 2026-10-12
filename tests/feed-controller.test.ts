import { mark } from './markdown-helpers';
import { afterEach, expect, it, vi } from 'vitest';
import { ReaderController } from '../src/controller';
import { ReaderRepository } from '../src/storage/repository';
import { MemoryStore } from '../src/storage/memory';
import { DEFAULT_SETTINGS, type HttpGet } from '../src/types';
import * as ingestion from '../src/ingest/extract';
afterEach(() => vi.restoreAllMocks());
const body = '<p>Genuine publisher text with a <a href="https://publisher.test/reference">reference</a>.</p>';
const rss = (field: 'description' | 'content:encoded') => `<rss version="2.0" xmlns:content="http://purl.org/rss/1.0/modules/content/"><channel><title>Publisher</title><item><guid>entry-one</guid><title>Publisher title</title><link>https://publisher.test/entry</link><${field}><![CDATA[${body}]]></${field}></item></channel></rss>`;
const atom = (field: 'summary' | 'content') => `<feed xmlns="http://www.w3.org/2005/Atom"><title>Publisher</title><entry><id>entry-one</id><title>Publisher title</title><link href="https://publisher.test/entry"/><${field} type="html"><![CDATA[${body}]]></${field}></entry></feed>`;
for (const [label, xml, excerpt] of [['RSS description', rss('description'), true], ['Atom summary', atom('summary'), true], ['RSS full content', rss('content:encoded'), false], ['Atom full content', atom('content'), false]] as const) {
  it(label + ' reaches the article body without dummy replacement or title clobber', async () => {
    const get = vi.fn<HttpGet>().mockImplementation(async url => {
      if (url !== 'https://publisher.test/feed') throw new Error('Article-page HTTP forbidden');
      return { status: 200, headers: {}, text: xml };
    });
    const store = new MemoryStore(), settings = { ...DEFAULT_SETTINGS }, repo = new ReaderRepository(store, settings), controller = new ReaderController(repo, get, settings);
    await controller.subscribeFeed('https://publisher.test/feed'); const [article] = await repo.listArticles();
    expect(article.body).toContain('Genuine publisher text'); expect(article.body).toContain('[reference](https://publisher.test/reference)'); expect(article.title).toBe('Publisher title'); expect(article.path).toMatch(/^Reading\/Stream\/\d{6} Publisher - Publisher title\.md$/);
    expect(await store.read(article.path)).not.toMatch(/^\s*(?:extractor|content|guid|id):/m); expect(await store.read(article.path)).not.toContain('feedText:');
    const before = await store.read(article.path); controller.setActive(true); await new Promise(resolve => setTimeout(resolve, 220)); expect(await store.read(article.path)).toBe(before); expect(get).toHaveBeenCalledTimes(1);
    if (!excerpt) { settings.useDummyContent = false; controller.scheduleAcquisition(); await new Promise(resolve => setTimeout(resolve, 220)); expect(await store.read(article.path)).toBe(before); expect(get).toHaveBeenCalledTimes(1); }
    await controller.shutdown();
  });
}
it('an explicit live fetch cannot overwrite an unproven feed excerpt while dummy remains ON', async () => {
  const get = vi.fn<HttpGet>().mockResolvedValue({ status: 200, headers: {}, text: atom('summary') }), store = new MemoryStore(), settings = { ...DEFAULT_SETTINGS }, repo = new ReaderRepository(store, settings), controller = new ReaderController(repo, get, settings);
  await controller.subscribeFeed('https://publisher.test/feed'); const [article] = await repo.listArticles();
  const extract = vi.spyOn(ingestion, 'extractArticle').mockResolvedValue({ title: 'Live publisher title', markdown: 'Full publisher article.', status: 'ready', extractor: 'defuddle' });
  const before = await store.read(article.path); await expect(controller.fetchFullText(article.path)).rejects.toThrow('Cannot replace'); expect(extract).not.toHaveBeenCalled(); expect(settings.useDummyContent).toBe(true); expect(await store.read(article.path)).toBe(before); await controller.shutdown();
});
it('explicit manual fetch preserves unproven full feed text, title, dummy setting and other notes', async () => {
  const get = vi.fn<HttpGet>().mockResolvedValue({ status: 200, headers: {}, text: atom('content') }), store = new MemoryStore(), settings = { ...DEFAULT_SETTINGS }, repo = new ReaderRepository(store, settings), controller = new ReaderController(repo, get, settings);
  await controller.subscribeFeed('https://publisher.test/feed'); const [article] = await repo.listArticles(); await store.create('Unrelated.md', 'Preserve exactly.');
  const extract = vi.spyOn(ingestion, 'extractArticle').mockResolvedValue({ title: 'Changed extraction title', markdown: 'Fresh full publisher article.', status: 'ready', extractor: 'defuddle' });
  const before = await store.read(article.path); await expect(controller.fetchFullText(article.path)).rejects.toThrow('Cannot replace'); expect(extract).not.toHaveBeenCalled(); expect(await store.read(article.path)).toBe(before); expect(settings.useDummyContent).toBe(true); expect(await store.read('Unrelated.md')).toBe('Preserve exactly.'); await controller.shutdown();
});
it('highlighted full-feed content remains protected even from explicit manual fetch', async () => {
  const get = vi.fn<HttpGet>().mockResolvedValue({ status: 200, headers: {}, text: atom('content') }), store = new MemoryStore(), settings = { ...DEFAULT_SETTINGS }, repo = new ReaderRepository(store, settings), controller = new ReaderController(repo, get, settings);
  await controller.subscribeFeed('https://publisher.test/feed'); const [article] = await repo.listArticles(); const highlighted = await mark(repo, article.path, { quote: 'Genuine publisher text' }); const before = store.snapshot(), extract = vi.spyOn(ingestion, 'extractArticle');
  expect(highlighted.status).toBe('inbox'); await expect(controller.fetchFullText(highlighted.path)).rejects.toThrow(/highlighted/); expect(extract).not.toHaveBeenCalled(); expect(store.snapshot()).toEqual(before); await controller.shutdown();
});
it('ordinary dummy acquisition preserves a supplied title and filename', async () => {
  const store = new MemoryStore(), settings = { ...DEFAULT_SETTINGS }, repo = new ReaderRepository(store, settings), controller = new ReaderController(repo, vi.fn<HttpGet>(), settings);
  const article = await repo.createArticle({ title: 'Publisher title', url: 'https://publisher.test/page' }), result = await controller.acquire(article.path);
  expect(result.title).toBe(article.title); expect(result.path).toBe(article.path); expect(result.body).toContain('Dummy article'); await controller.shutdown();
});
