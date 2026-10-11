import { describe, expect, it } from 'vitest';
import { DEFAULT_SETTINGS } from '../src/types';
import { MemoryStore } from '../src/storage/memory';
import { ReaderRepository } from '../src/storage/repository';
import { parseNote } from '../src/storage/markdown';
import { dummyArticle } from '../src/ingest/dummy';

const url = 'https://example.com/full';
const feedText = { markdown: '# Publisher full article\n\nComplete publisher text.', isExcerpt: false };

describe('full supplied feed text', () => {
  it('persists full feed text without retired metadata and protects its unverified ownership', async () => {
    const store = new MemoryStore(), repo = new ReaderRepository(store, DEFAULT_SETTINGS);
    const article = await repo.createArticle({ title: 'Publisher full title', url, status: 'feed', summary: 'Legacy duplicate', extractor: 'pending', content: 'pending', feedText });
    expect(article).toMatchObject({ title: 'Publisher full title', body: feedText.markdown, extractor: 'manual', content: 'protected', status: 'feed' });
    expect(article.path).toMatch(/\/\d{6} Feed - Publisher full title\.md$/);
    const note = parseNote(await store.read(article.path));
    for (const field of ['id', 'guid', 'pullmanFormat', 'content', 'extractor', 'sourceHash', 'sourceLength', 'feedText']) expect(note.doc.has(field)).toBe(false);
    expect(note.doc.get('summary')).toBe('Legacy duplicate');
    expect(await new ReaderRepository(new MemoryStore(store.snapshot()), DEFAULT_SETTINGS).getArticle(article.path)).toMatchObject({ body: feedText.markdown, content: 'protected' });
  });

  it('preserves full feed body, publisher title/path, and metadata against dummy and live acquisition', async () => {
    const store = new MemoryStore(), repo = new ReaderRepository(store, DEFAULT_SETTINGS);
    const article = await repo.createArticle({ title: 'Publisher full title', url, feedText });
    await repo.saveContent(article.path, dummyArticle(url));
    await repo.saveContent(article.path, { title: 'Different acquired title', markdown: 'Different live text.', status: 'ready', extractor: 'defuddle' }, { allowFeedReplacement: true });
    const after = await repo.getArticle(article.path);
    expect(after).toMatchObject({ body: feedText.markdown, title: article.title, path: article.path, content: 'protected' });
    expect(parseNote(await store.read(article.path)).doc.get('error')).toMatch(/Snapshot protected/);
  });

  it('does not discard an explicit protection request when creating supplied feed content', async () => {
    const store = new MemoryStore(), repo = new ReaderRepository(store, DEFAULT_SETTINGS);
    const article = await repo.createArticle({ title: 'Pinned publisher text', url, feedText, content: 'protected' });
    expect(article.content).toBe('protected');
    expect(article.extractor).toBe('manual');
    expect(parseNote(await store.read(article.path)).doc.has('content')).toBe(false);
  });

  it('rejects empty or contradictory new source inputs rather than silently discarding them', async () => {
    const store = new MemoryStore(), repo = new ReaderRepository(store, DEFAULT_SETTINGS);
    await expect(repo.createArticle({ title: 'Empty', url, feedText: { markdown: ' ', isExcerpt: true } })).rejects.toThrow();
    await expect(repo.createArticle({ title: 'Contradictory', url, body: 'Separate authored text.', feedText })).rejects.toThrow('Conflicting body');
    expect(store.snapshot()).toEqual({});
  });
});
