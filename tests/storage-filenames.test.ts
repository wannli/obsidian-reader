import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_SETTINGS, type HttpGet } from '../src/types';
import { ReaderController } from '../src/controller';
import { MemoryStore } from '../src/storage/memory';
import { ReaderRepository } from '../src/storage/repository';
import { parseNote } from '../src/storage/markdown';

beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(new Date(2026, 9, 9, 12)); });
afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers(); });
const fixture = (files: Record<string, string> = {}) => {
  const store = new MemoryStore(files), repo = new ReaderRepository(store, { ...DEFAULT_SETTINGS });
  return { store, repo };
};
const feedPath = 'Reading/Wires/Publisher.md';
const feed = '[[Reading/Wires/Publisher]]';
const feedNote = (prefix?: string) => `---\ntype: feed\nurl: https://publisher.example/rss\ntitle: Publisher display title\n${prefix === undefined ? '' : `prefix: ${JSON.stringify(prefix)}\n`}custom: preserve\n---\nPersonal feed notes.\n`;
const rss = (published?: string) => `<rss version="2.0"><channel><title>Publisher display title</title><item><guid isPermaLink="false">entry-1</guid><title>Story</title><link>https://publisher.example/story</link>${published === undefined ? '' : `<pubDate>${published}</pubDate>`}<description>Genuine summary.</description></item></channel></rss>`;

async function importFeed(published?: string, prefix = 'Wired') {
  const { store, repo } = fixture({ [feedPath]: feedNote(prefix) });
  const get = vi.fn<HttpGet>().mockResolvedValue({ status: 200, text: rss(published), headers: {} });
  const controller = new ReaderController(repo, get, { ...DEFAULT_SETTINGS });
  try { await controller.refreshFeeds(); return { store, repo, article: (await repo.listArticles())[0], get }; }
  finally { await controller.shutdown(); }
}

describe('dated queue filenames', () => {
  it('uses the local added day for manual articles, not a supplied publication day or the legacy folder', async () => {
    const { store, repo } = fixture();
    const article = await repo.createArticle({ title: 'Manual', url: '', published: '2000-01-01' });
    expect(article.path).toBe('Reading/Inbox/261009 Manual.md');
    expect(parseNote(await store.read(article.path)).doc.has('status')).toBe(false);
    expect((await store.list()).some(path => path.startsWith('Reading/Articles/'))).toBe(false);
  });

  it('hides the date only from filename-derived article titles', async () => {
    const { repo } = fixture({
      'Reading/Inbox/261009 Authored.md': '---\ntype: article\ntitle: 261009 Keep this title\n---\n',
      'Reading/Inbox/261009 Unrelated.md': '---\ntype: article\n---\n',
      'Reading/Inbox/261009 123456 Starts with digits.md': '---\ntype: article\n---\n',
      'Reading/Wires/261009 Feed.md': '---\ntype: feed\nurl: https://example.com/feed\n---\n',
    });
    expect((await repo.createArticle({ title: 'Manual', url: '' })).title).toBe('Manual');
    expect((await repo.createArticle({ title: 'Story', url: '', status: 'feed', feed, feedPrefix: 'Wired' })).title).toBe('Story');
    expect((await repo.getArticle('Reading/Inbox/261009 Authored.md')).title).toBe('261009 Keep this title');
    expect((await repo.getArticle('Reading/Inbox/261009 Unrelated.md')).title).toBe('Unrelated');
    expect((await repo.getArticle('Reading/Inbox/261009 123456 Starts with digits.md')).title).toBe('123456 Starts with digits');
    expect((await repo.listFeeds())[0].title).toBe('261009 Feed');
  });

  it('uses local calendar components even when the UTC date differs', async () => {
    vi.spyOn(Date.prototype, 'getFullYear').mockReturnValue(2030);
    vi.spyOn(Date.prototype, 'getMonth').mockReturnValue(11);
    vi.spyOn(Date.prototype, 'getDate').mockReturnValue(31);
    vi.setSystemTime(new Date('2031-01-01T01:30:00Z'));
    const { repo } = fixture();
    expect((await repo.createArticle({ title: 'Local', url: '' })).path).toBe('Reading/Inbox/301231 Local.md');
  });

  it.each([
    ['2026-10-08', '261008'], ['2026-10-08T00:15:00Z', '261008'],
    ['2026-10-08T00:15:00+14:00', '261007'], ['2026-10-08T23:45:00-12:00', '261009'],
  ])('uses the UTC publication day, never the host-local day: %s', async (published, stamp) => {
    vi.spyOn(Date.prototype, 'getDate').mockReturnValue(1);
    const { repo } = fixture();
    const article = await repo.createArticle({ title: 'Story', url: '', status: 'feed', feed, feedPrefix: 'Wired', published });
    expect(article.path).toBe(`Reading/Stream/${stamp} Wired - Story.md`);
  });

  it.each([
    ['Thu, 08 Oct 2026 00:15:00 +1400', '261007'], ['Thu, 08 Oct 2026 23:45:00 -1200', '261009'],
  ])('retains the parser-normalized UTC date through the actual RSS import pipeline: %s', async (published, stamp) => {
      const { article, repo, store, get } = await importFeed(published);
      expect(article.path).toBe(`Reading/Stream/${stamp} Wired - Story.md`);
      expect(article.status).toBe('feed');
      expect(article.body).toContain('Genuine summary.');
      expect((await repo.listFeeds())[0].prefix).toBe('Wired');
      expect(await store.read(feedPath)).toContain('Personal feed notes.');
      expect(get).toHaveBeenCalledTimes(1);
    },
  );

  it.each([undefined, '', 'invalid', '2026-02-30'])('falls back to added day without inventing published metadata: %s', async published => {
    const { article, store } = await importFeed(published);
    expect(article.path).toBe('Reading/Stream/261009 Wired - Story.md');
    expect(article.published).toBeUndefined();
    expect(parseNote(await store.read(article.path)).doc.has('published')).toBe(false);
  });

  it.each([undefined, '', '   '])('falls back to the feed title for an absent/blank prefix: %s', async prefix => {
    const { repo } = fixture({ [feedPath]: feedNote(prefix) });
    const article = await repo.createArticle({ title: 'Story', url: '', feed, status: 'feed', published: '2026-10-08' });
    expect(article.path).toBe('Reading/Stream/261008 Publisher display title - Story.md');
  });

  it('creates feed definitions in Wires and persists their optional YAML prefix', async () => {
    const { store, repo } = fixture();
    const created = await repo.createFeed('Publisher', 'https://publisher.example/rss');
    expect(created.path).toBe(feedPath);
    await repo.updateFeed(created.path, { prefix: 'Wired' });
    expect((await repo.listFeeds())[0].prefix).toBe('Wired');
    expect(parseNote(await store.read(created.path)).doc.get('prefix')).toBe('Wired');
    expect(await repo.listArticles()).toEqual([]);
  });

  it('sanitizes both prefix and title and allocates a distinct non-overwriting collision suffix', async () => {
    const { store, repo } = fixture();
    const input = { title: '../[A]: title/?', url: '', feed, feedPrefix: '../../Wired:?"|\u0001', status: 'feed' as const, published: '2026-10-08' };
    const first = await repo.createArticle(input), before = await store.read(first.path);
    const second = await repo.createArticle(input);
    for (const article of [first, second]) {
      expect(article.path.split('/')).toHaveLength(3);
      expect(article.path).toMatch(/^Reading\/Stream\/261008 /);
      expect(article.path.split('/').at(-1)).not.toMatch(/[\\/:*?"<>|#^[\]\x00-\x1f]/);
    }
    expect(second.path).toBe(first.path.replace(/\.md$/, '-2.md'));
    expect(await store.read(first.path)).toBe(before);
  });

  it('checks case-insensitive dated collisions and provides an empty-title fallback', async () => {
    const files = { 'Reading/Inbox/261009 Same.md': 'First', 'Reading/Inbox/261009 same-2.md': 'Second' };
    const { store, repo } = fixture(files);
    expect((await repo.createArticle({ title: 'Same', url: '' })).path).toBe('Reading/Inbox/261009 Same-3.md');
    expect((await repo.createArticle({ title: '', url: '' })).path).toBe('Reading/Inbox/261009 Untitled.md');
    for (const [path, text] of Object.entries(files)) expect(await store.read(path)).toBe(text);
  });

  it('bounds UTF-8 filename/prefix bytes, normalizes NFC, and reserves room for collision suffixes', async () => {
    const { repo } = fixture();
    const input = { title: '😀e\u0301'.repeat(100), url: '', feed, feedPrefix: '界'.repeat(100), status: 'feed' as const, published: '2026-10-08' };
    const first = await repo.createArticle(input), second = await repo.createArticle(input);
    for (const article of [first, second]) {
      const basename = article.path.split('/').at(-1)!;
      expect(Buffer.byteLength(basename, 'utf8')).toBeLessThanOrEqual(240);
      expect(basename).toBe(basename.normalize('NFC'));
      expect(basename).not.toMatch(/[\uD800-\uDFFF]/u);
      const prefix = /^261008 (.*?) - /.exec(basename)?.[1];
      expect(prefix).toBeDefined();
      expect(Buffer.byteLength(prefix!, 'utf8')).toBeLessThanOrEqual(80);
    }
    expect(second.path).not.toBe(first.path);
    expect(second.path).toMatch(/-2\.md$/);
    const decomposed = await repo.createArticle({ title: 'Cafe\u0301', url: '' });
    const composed = await repo.createArticle({ title: 'Café', url: '' });
    expect(decomposed.path).toBe('Reading/Inbox/261009 Café.md');
    expect(composed.path).toBe('Reading/Inbox/261009 Café-2.md');
  });

  it('retains the explicit feed title and protects an unstamped excerpt through moving without changing the dated filename', async () => {
    const { store, repo } = fixture();
    const article = await repo.createArticle({ title: 'Story', url: 'https://publisher.example/title', feed, feedPrefix: 'Wired', status: 'feed', published: '2026-10-08', feedText: { markdown: 'Publisher excerpt.', isExcerpt: true } });
    expect(article.title).toBe('Story');
    expect(parseNote(await store.read(article.path)).doc.get('title')).toBe('Story');
    const before = await store.read(article.path);
    const extracted = await repo.saveContent(article.path, { title: 'Different extracted title', markdown: 'Full source.', status: 'ready', extractor: 'defuddle' });
    expect(extracted.content).toBe('protected'); expect(extracted.path).toBe(article.path);
    expect(parseNote(await store.read(article.path)).body).toBe(parseNote(before).body);
    expect(parseNote(await store.read(article.path)).doc.get('error')).toMatch(/Snapshot protected/);
    const moved = await repo.setStatus(article.path, 'later');
    expect(moved.title).toBe('Story');
    expect(moved.path).toBe('Reading/Later/261008 Wired - Story.md');
    const saved = parseNote(await store.read(moved.path));
    expect(saved.body).toBe('Publisher excerpt.');
    expect(saved.doc.get('title')).toBe('Story'); expect(saved.doc.has('status')).toBe(false);
  });

  it('does not restamp on a later-day move and deduplicates matching URLs without relying on GUID', async () => {
    const { store, repo } = fixture();
    const input = { title: 'Story', url: 'https://publisher.example/old', feed, feedPrefix: 'Wired', guid: 'same-entry', status: 'feed' as const, published: '2026-10-08', body: 'Saved source.' };
    const article = await repo.createArticle(input);
    vi.setSystemTime(new Date(2027, 0, 2, 12));
    const moved = await repo.setStatus(article.path, 'later');
    expect(moved.path).toBe('Reading/Later/261008 Wired - Story.md');
    const before = store.snapshot();
    const duplicate = await repo.createArticle({ ...input, title: 'Changed title', published: '2027-01-02', body: 'Replacement.' });
    expect(duplicate).toMatchObject(moved);
    expect(store.snapshot()).toEqual(before);
    const changedUrl = await repo.createArticle({ ...input, title: 'Changed title', url: 'https://publisher.example/new', published: '2027-01-02', body: 'Replacement.' });
    expect(changedUrl.path).toBe('Reading/Stream/270102 Wired - Changed title.md');
    expect(changedUrl.body).toBe('Replacement.');
    expect(await store.read(moved.path)).toBe(before[moved.path]);
    expect(await repo.listArticles()).toHaveLength(2);
  });
});
