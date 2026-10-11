import { mark } from './markdown-helpers';
import { noteMetadata } from './markdown-helpers';
import { describe, expect, it } from 'vitest';
import { DEFAULT_SETTINGS } from '../src/types';
import { MemoryStore } from '../src/storage/memory';
import { ReaderRepository } from '../src/storage/repository';
import { parseNote } from '../src/storage/markdown';

const setup = (initial: Record<string, string> = {}) => {
  const store = new MemoryStore(initial);
  return { store, repo: new ReaderRepository(store, { ...DEFAULT_SETTINGS }) };
};

describe('Markdown repository', () => {
  it.each([undefined, '', '   ', 'unknown', 'not-a-date'])('omits unknown/invalid new publication date %s', async published => {
    const { store, repo } = setup();
    const article = await repo.createArticle({ title: 'Undated', url: 'https://example.com/undated', published });
    expect(article.published).toBeUndefined();
    expect(parseNote(await store.read(article.path)).doc.has('published')).toBe(false);
  });

  it.each(['2026-10-09', '2026-10-09T12:34:56Z'])('retains known publication date %s verbatim', async published => {
    const { store, repo } = setup();
    const article = await repo.createArticle({ title: 'Dated', url: 'https://example.com/dated', published });
    expect(article.published).toBe(published);
    expect(parseNote(await store.read(article.path)).doc.get('published')).toBe(published);
  });

  it('creates clean, human-readable article/feed notes without retired article fields', async () => {
    const { store, repo } = setup();
    const article = await repo.createArticle({ title: 'A useful article', url: 'https://example.com/a', body: '# Source\n\nOriginal snapshot.\n' });
    const feed = await repo.createFeed('A feed', 'https://example.com/feed.xml');
    expect(article.body).toBe('# Source\n\nOriginal snapshot.\n');
    expect(article.content).toBe('protected');
    expect(article.title).toBe('A useful article');
    expect(parseNote(await store.read(article.path)).doc.get('title')).toBe('A useful article');
    expect(feed.enabled).toBe(false);
    expect(parseNote(await store.read(feed.path)).doc.get('enabled')).toBe(false);
    for (const path of [article.path, feed.path]) {
      const content = await store.read(path);
      expect(path.endsWith('.md')).toBe(true);
      expect((await noteMetadata(store, path))['created-by']).toBeUndefined();
      expect(parseNote(content).doc.has('id')).toBe(path === feed.path);
      if (path === article.path) for (const key of ['guid', 'pullmanFormat', 'content', 'extractor', 'sourceHash', 'sourceLength']) expect(parseNote(content).doc.has(key)).toBe(false);
      expect(parseNote(content).doc.has('highlights')).toBe(false);
      expect(content).not.toMatch(/<!--|reader:|JSON|BEGIN|END/);
      expect(parseNote(content).doc.get('type')).toMatch(/article|feed/);
    }
    const copy = store.snapshot(); copy[article.path] = 'not the store';
    expect(await repo.getArticle(article.path)).toMatchObject({ path: article.path, body: article.body, url: article.url });
  });

  it('deduplicates normalized feed URLs without touching existing status, metadata, body or highlights', async () => {
    const { store, repo } = setup();
    let original = await repo.createArticle({ title: 'Original', url: ' https://EXAMPLE.com:443/a/?b=2&a=1#top ', status: 'later', body: 'Saved text', feed: '[[Reading/Wires/Feed]]' });
    original = await mark(repo, original.path, { quote: 'Saved text' });
    const before = store.snapshot();
    const duplicate = await repo.createArticle({ title: 'Replacement', url: 'https://example.com/a/?b=2&a=1#other', status: 'feed', body: 'NEW CONTENT', feed: '[[Reading/Wires/Feed]]' });
    expect(duplicate).toEqual(original);
    expect(store.snapshot()).toEqual(before);
    expect(await repo.listArticles()).toHaveLength(1);
  });

  it('serializes duplicate creation and mutations across repositories sharing a local store', async () => {
    const { store, repo } = setup();
    const other = new ReaderRepository(store, DEFAULT_SETTINGS);
    const articles = await Promise.all(Array.from({ length: 12 }, (_, i) => (i % 2 ? repo : other).createArticle({ title: 'Same', url: 'https://example.com/same#' + i, feed: '[[Reading/Wires/Feed]]' })));
    expect(new Set(articles.map(article => article.path)).size).toBe(1);
    const path = articles[0].path;
    const [, moved] = await Promise.all([
      repo.saveContent(path, { title: 'Snapshot', markdown: 'Unchanged snapshot.', status: 'ready', extractor: 'defuddle' }),
      other.setStatus(path, 'archive'),
    ]);
    // Consumers follow the returned path rather than issuing writes to the old queue.
    await Promise.all([
      mark(repo, moved.path, { quote: 'Unchanged' }),
      other.saveContent(moved.path, { title: 'Lost', markdown: 'Destructive replacement', status: 'ready', extractor: 'defuddle' }),
    ]);
    const result = await repo.getArticle(moved.path);
    expect(result.status).toBe('archive');
    expect(result.body).toBe('==Unchanged== snapshot.');
    expect(result.highlights).toHaveLength(1);
    expect(result.title).toBe('Same');
    expect(parseNote(await store.read(moved.path)).doc.get('title')).toBe('Same');
  });

  it('initial extraction never replaces a snapshot, even without highlights or ready metadata', async () => {
    const { store, repo } = setup();
    const article = await repo.createArticle({ title: 'Pending', url: 'https://example.com/pending' });
    await repo.setArticleError(article.path, 'Network unavailable');
    expect((await repo.getArticle(article.path)).content).toBe('error');
    await repo.saveContent(article.path, { title: 'Extracted', markdown: '## Content\n\nSaved!', status: 'partial', warning: 'Paywall', extractor: 'defuddle' });
    const beforeBody = (await repo.getArticle(article.path)).body;
    await repo.saveContent(article.path, { title: 'Changed', markdown: 'New version', status: 'ready', extractor: 'defuddle' });
    expect((await repo.getArticle(article.path)).body).toBe(beforeBody);
    expect((await repo.getArticle(article.path)).error).toMatch(/protected/i);
    await repo.setArticleError(article.path, 'Transient error');
    // An explicit failed attempt is visible without losing the completed cached snapshot.
    const failed = await repo.getArticle(article.path);
    expect(failed.content).toBe('protected');
    expect(failed.error).toBe('Transient error');
    expect(failed.extractor).toBe('manual');
    expect(failed.body).toBe('## Content\n\nSaved!');
  });

  it('preserves unknown YAML properties, comments, scalars, and the body verbatim', async () => {
    const body = '\n# Manual source\n\nUser paragraph.\n\n## Extras\nKeep this\n';
    const { store, repo } = setup({ 'Outside/Manual.md': '---\ntype: article\n# Keep this comment\ncustom: &settings\n  rating: 5\n  nested: [one, two]\ncopy: *settings\nsummary: |\n  multiline\n  user prose\n---\n' + body });
    expect(await repo.listArticles()).toEqual([]);
    const manual = await repo.getArticle('Outside/Manual.md');
    expect(manual.url).toBe(''); expect(manual.title).toBe('Manual'); expect(manual.id).toBe(''); expect(manual.status).toBeUndefined();
    const updated = await repo.setStatus(manual.path, 'archive');
    expect(updated.id).toBe(manual.id);
    const raw = await store.read(updated.path), note = parseNote(raw);
    expect(note.body).toBe(body);
    expect(raw).toContain('# Keep this comment');
    expect(note.doc.toJS()).toMatchObject({ custom: { rating: 5, nested: ['one', 'two'] }, copy: { rating: 5 }, summary: 'multiline\nuser prose\n' });
    const highlighted = await mark(repo, updated.path, { quote: 'User paragraph.' });
    expect(highlighted.id).toBe('');
    expect(highlighted.body).toBe(body.replace('User paragraph.', '==User paragraph.=='));
    expect(parseNote(await store.read(updated.path)).body).toBe(body.replace('User paragraph.', '==User paragraph.=='));
  });

  it('discovers all note types outside configured folders and updates feeds without losing content', async () => {
    const initial = '---\ntype: feed\nurl: https://example.com/feed\ncustom: [keep, me]\n---\n\nMy feed notes.\n';
    const { store, repo } = setup({ 'Elsewhere/Feed.md': initial, 'Unrelated.md': '# Just a note' });
    const feed = (await repo.listFeeds())[0];
    expect(feed.title).toBe('Feed');
    expect(feed.enabled).toBe(true); // Preserve legacy notes without an explicit enabled field.
    await repo.updateFeed(feed.path, { enabled: false, etag: 'v2', checked: '2026-01-01', error: '' });
    const changed = (await repo.listFeeds())[0];
    expect(changed).toMatchObject({ enabled: false, etag: 'v2', checked: '2026-01-01', error: '' });
    expect(changed.id).not.toBe('');
    expect(parseNote(await store.read(feed.path)).body).toBe('\nMy feed notes.\n');
    expect(parseNote(await store.read(feed.path)).doc.toJS().custom).toEqual(['keep', 'me']);
    expect(await repo.createFeed('Ignored', 'https://EXAMPLE.com:443/feed#fragment')).toEqual(changed);
    expect(await store.read('Unrelated.md')).toBe('# Just a note');
  });

  it('allocates collision-safe filenames without overwriting unrelated notes', async () => {
    const now = new Date(), stamp = String(now.getFullYear()).slice(-2) + String(now.getMonth() + 1).padStart(2, '0') + String(now.getDate()).padStart(2, '0');
    const base = `Reading/Inbox/${stamp} `;
    const { store, repo } = setup({ [base + 'Same.md']: 'User note', [base + 'same-2.md']: 'Another user note' });
    const article = await repo.createArticle({ title: 'Same', url: 'https://example.com/new' });
    expect(article.path).toBe(base + 'Same-3.md');
    expect(article.title).toBe('Same');
    expect(await store.read(base + 'Same.md')).toBe('User note');
    const dangerous = await repo.createArticle({ title: '../[A]: title/?', url: 'https://example.com/dangerous-title' });
    expect(dangerous.path.split('/')).toHaveLength(3);
    expect(parseNote(await store.read(dangerous.path)).doc.has('title')).toBe(true);
    expect(dangerous.title).toBe('../[A]: title/?');
  });
});
