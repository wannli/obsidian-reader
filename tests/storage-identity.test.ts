import { mark, selection } from './markdown-helpers';
import { describe, expect, it } from 'vitest';
import { DEFAULT_SETTINGS as BASE_SETTINGS } from '../src/types';
const DEFAULT_SETTINGS = BASE_SETTINGS;
import { MemoryStore } from '../src/storage/memory';
import { ReaderRepository } from '../src/storage/repository';
import { parseNote } from '../src/storage/markdown';

describe('path and URL identity without article IDs or GUIDs', () => {
  it('does not deduplicate different URLs merely because feed and GUID agree', async () => {
    const store = new MemoryStore(), repo = new ReaderRepository(store, DEFAULT_SETTINGS);
    const url = 'https://EXAMPLE.com:443/original/?utm_source=first#source';
    let original = await repo.createArticle({ title: 'Original', url, feed: '[[Feeds/First]]', status: 'later', body: 'Saved snapshot' });
    original = await mark(repo, original.path, { quote: 'Saved snapshot' });
    const before = store.snapshot();
    const repeated = await repo.createArticle({ title: 'Changed', url: 'https://example.com/different-link', feed: '[[Feeds/First]]', status: 'feed', body: 'Overwritten' });
    expect(repeated.path).not.toBe(original.path);
    expect(repeated.url).toBe('https://example.com/different-link');
    expect(original.url).toBe(url);
    expect(parseNote(await store.read(original.path)).doc.has('guid')).toBe(false);
    expect(store.snapshot()[original.path]).toBe(before[original.path]);
    const otherFeed = await repo.createArticle({ title: 'Other feed', url: 'https://example.com/other-feed', feed: '[[Feeds/Second]]' });
    expect(otherFeed.path).not.toBe(original.path);
    expect(await repo.listArticles()).toHaveLength(3);
  });

  it('does not deduplicate blank manual URLs or unscoped/blank GUIDs', async () => {
    const store = new MemoryStore(), repo = new ReaderRepository(store, DEFAULT_SETTINGS);
    const articles = await Promise.all([
      repo.createArticle({ title: 'Manual', url: '' }),
      repo.createArticle({ title: 'Manual', url: '   ' }),
      repo.createArticle({ title: 'Unscoped', url: '' }),
      repo.createArticle({ title: 'Unscoped', url: '' }),
      repo.createArticle({ title: 'Blank GUID', url: '', feed: 'Feed' }),
      repo.createArticle({ title: 'Blank GUID', url: '', feed: 'Feed' }),
    ]);
    expect(new Set(articles.map(article => article.path)).size).toBe(6);
    expect(articles.every(article => parseNote(store.snapshot()[article.path]).doc.has('guid') === false)).toBe(true);
    expect(await repo.listArticles()).toHaveLength(6);
    expect(articles.every(article => article.url === '')).toBe(true);
  });

  it('distinguishes repeated passages by current source position, not persisted random IDs', async () => {
    const store = new MemoryStore(), repo = new ReaderRepository(store, DEFAULT_SETTINGS);
    const article = await repo.createArticle({ title: 'Selections', url: '', body: 'same text, same text' });
    const input = await selection(repo, article.path, 'same text', 0);
    await mark(repo, article.path, input);
    const before = store.snapshot();
    await expect(mark(repo, article.path, input)).rejects.toThrow(/changed|revision/i);
    expect(store.snapshot()).toEqual(before);
    const second = await mark(repo, article.path, await selection(repo, article.path, 'same text', 1));
    expect(second.highlights).toHaveLength(2);
    expect(new Set(second.highlights.map(item => item.id)).size).toBe(2);
    expect(second.body).toBe('==same text==, ==same text==');
  });
  it('native rename keeps Markdown identity with the file and invalidates old path work', async () => {
    const store = new MemoryStore({ 'Daily/day.md': 'Old user-owned journal text.' }), repo = new ReaderRepository(store, DEFAULT_SETTINGS);
    const article = await repo.createArticle({ title: 'Before rename', url: '', body: 'Original quote' });
    await mark(repo, article.path, { quote: 'Original quote' });
    const generation = repo.articleGeneration(article.path), to = 'Moved/After rename.md';
    const raw = await store.read(article.path);
    await store.rename(article.path, to, { expectedContent: raw }); await repo.articleRenamed(article.path, to);
    expect(repo.articleGeneration(article.path)).not.toBe(generation);
    expect((await repo.getArticle(to)).body).toBe('==Original quote==');
    expect(await store.read(to)).toBe(raw); expect(await store.read('Daily/day.md')).toBe('Old user-owned journal text.');
  });
  it('allocates distinct paths for repeated manual captures without article IDs', async () => {
    const store = new MemoryStore(), repo = new ReaderRepository(store, DEFAULT_SETTINGS);
    const first = await repo.createArticle({ title: 'Collision', url: '' });
    const second = await repo.createArticle({ title: 'Collision', url: '' });
    expect(first.path).not.toBe(second.path);
    expect(parseNote(await store.read(first.path)).doc.has('id')).toBe(false);
    expect(parseNote(await store.read(second.path)).doc.has('id')).toBe(false);
  });
});
