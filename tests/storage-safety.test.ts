import { mark } from './markdown-helpers';
import { readNoteRaw } from './markdown-helpers';
import { describe, expect, it } from 'vitest';
import { DEFAULT_SETTINGS as BASE_SETTINGS } from '../src/types';
const DEFAULT_SETTINGS = BASE_SETTINGS;
import { MemoryStore } from '../src/storage/memory';
import { ReaderRepository } from '../src/storage/repository';
import { parseNote } from '../src/storage/markdown';

const articleNote = (extra = '', body = 'Source') => '---\ntype: article\nid: manual-id\n' + extra + '---\n' + body;

describe('storage safety', () => {
  it.each(['../out.md', '/absolute.md', 'folder/../../out.md', 'folder\\out.md', 'C:/out.md', './out.md', 'folder/%2e%2e/out.md', 'folder//out.md', 'not-markdown.json'])(
    'rejects unsafe note destination %s without changing the source', async destination => {
      const store = new MemoryStore({ 'Manual.md': articleNote() }), repo = new ReaderRepository(store, DEFAULT_SETTINGS);
      const before = store.snapshot();
      await expect(repo.setArticleError(destination, 'Invalid path')).rejects.toThrow();
      expect(store.snapshot()).toEqual(before);
      await expect(repo.getArticle(destination)).rejects.toThrow();
    },
  );

  it.each(['---\ntype: article\n', '---\ntype: article\nbroken: [\n---\nBody', '---\ntype: article\ntype: feed\n---\nBody', '---\n- article\n---\nBody'])(
    'never rewrites malformed frontmatter', async raw => {
      const store = new MemoryStore({ 'Damaged.md': raw }), repo = new ReaderRepository(store, DEFAULT_SETTINGS);
      await expect(repo.setStatus('Damaged.md', 'archive')).rejects.toThrow();
      expect(await store.read('Damaged.md')).toBe(raw);
      const report = await repo.prepareStorage();
      expect(report.converted).toBe(0); expect(report.errors).toHaveLength(1);
    },
  );

  it('does not hide valid manually made articles behind unrelated malformed notes', async () => {
    const store = new MemoryStore({ 'Broken.md': '---\nmissing: [\n---\n', 'Elsewhere/Manual.md': '---\ntype: article\n---\nActual source' });
    const repo = new ReaderRepository(store, DEFAULT_SETTINGS);
    expect(await repo.listArticles()).toEqual([]);
    await expect(repo.getArticle('Elsewhere/Manual.md')).resolves.toMatchObject({ path: 'Elsewhere/Manual.md', url: '', status: undefined });
    const saved = await mark(repo, 'Elsewhere/Manual.md', { quote: 'Actual source' });
    expect(saved.id).toBe(''); expect(saved.highlights).toHaveLength(1);
    expect(parseNote(await store.read('Elsewhere/Manual.md')).doc.has('id')).toBe(false);
  });
  it('rejects duplicate note identities before any mutation or daily repair', async () => {
    const store = new MemoryStore({ 'One.md': articleNote(), 'Two.md': articleNote() }), repo = new ReaderRepository(store, DEFAULT_SETTINGS);
    const before = store.snapshot();
    await expect(repo.setStatus('One.md', 'archive')).rejects.toThrow(/Duplicate (?:note|article) ID/);
    await expect(repo.setArticleError('One.md', 'Do not write')).rejects.toThrow(/Duplicate/);
    expect(store.snapshot()).toEqual(before);
  });
  it('refuses ambiguous legacy block ownership without erasing either excerpt', async () => {
    const raw = articleNote('highlights: [{id: hl-old}]\n', '## Highlights\n\n> First\n\n^hl-old\n\n> Second\n\n^hl-old\n\n## Article\n\nFirst Second');
    const store = new MemoryStore({ 'Legacy.md': raw }), repo = new ReaderRepository(store, DEFAULT_SETTINGS), before = store.snapshot();
    expect((await repo.prepareStorage()).errors.length).toBeGreaterThan(0); expect(store.snapshot()).toEqual(before);
  });
  it('same inline syntax in different articles needs no global annotation identity', async () => {
    const store = new MemoryStore({ 'One.md': articleNote('', '==Quote=='), 'Two.md': articleNote('', '==Quote==').replace('manual-id', 'other-id') });
    const repo = new ReaderRepository(store, DEFAULT_SETTINGS);
    const first = await repo.getArticle('One.md'); await repo.deleteHighlight('One.md', first.highlights[0].id);
    expect((await repo.getArticle('One.md')).body).toBe('Quote'); expect((await repo.getArticle('Two.md')).body).toBe('==Quote==');
  });
  it('unused legacy daily destinations never modify articles, feeds or malformed journals', async () => {
    const journal = '---\ntags: [broken\n---\nPersonal writing.';
    const store = new MemoryStore({ 'Article.md': articleNote(), 'Feed.md': '---\ntype: feed\n---\nFeed notes', 'Daily/day.md': journal });
    const repo = new ReaderRepository(store, DEFAULT_SETTINGS), before = store.snapshot();
    const marked = await mark(repo, 'Article.md', { quote: 'Source' });
    await repo.deleteHighlight('Article.md', marked.highlights[0].id);
    expect(await store.read('Feed.md')).toBe(before['Feed.md']); expect(await store.read('Daily/day.md')).toBe(journal);
    expect(Object.keys(store.snapshot())).toEqual(Object.keys(before));
  });

  it('processes latest content and preserves edits made after a preceding read', async () => {
    class EditingStore extends MemoryStore {
      override async process(path: string, update: (current: string) => string): Promise<void> {
        return super.process(path, current => update(current.replace('Source', 'User changed source')));
      }
    }
    const store = new EditingStore({ 'Article.md': articleNote() }), repo = new ReaderRepository(store, DEFAULT_SETTINGS);
    expect((await repo.getArticle('Article.md')).body).toBe('Source');
    await repo.setArticleError('Article.md', 'Retry later');
    expect(parseNote(await readNoteRaw(store, 'Article.md')).body).toBe('User changed source');
  });

  it('rejects feed identity changes and conflicting URLs without losing unknown fields', async () => {
    const store = new MemoryStore(), repo = new ReaderRepository(store, DEFAULT_SETTINGS);
    const feed = await repo.createFeed('First', 'https://example.com/first');
    await repo.createFeed('Second', 'https://example.com/second');
    const before = store.snapshot();
    await expect(repo.updateFeed(feed.path, { path: 'Elsewhere.md' })).rejects.toThrow('immutable');
    await expect(repo.updateFeed(feed.path, { id: 'other-id' })).rejects.toThrow('immutable');
    await expect(repo.updateFeed(feed.path, { url: 'https://example.com/second#another' })).rejects.toThrow('Duplicate');
    expect(store.snapshot()).toEqual(before);
    await repo.updateFeed(feed.path, { enabled: false }); // A rejected operation must not poison the queue.
    expect((await repo.listFeeds()).find(item => item.path === feed.path)?.enabled).toBe(false);
  });
});
