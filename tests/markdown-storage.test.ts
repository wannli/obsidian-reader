import { describe, expect, it } from 'vitest';
import { ReaderRepository } from '../src/storage/repository';
import { MemoryStore } from '../src/storage/memory';
import { DEFAULT_SETTINGS } from '../src/types';
import { parseNote, writeNote, newNote } from '../src/storage/markdown';
import { parseInlineMarkdown } from '../src/inline';
import { fingerprint } from '../src/storage/fingerprint';
const settings = DEFAULT_SETTINGS;
const repo = (store: MemoryStore) => new ReaderRepository(store, settings);
const selection = (body: string, quote: string, title?: string) => ({ quote, revision: parseInlineMarkdown(body, { stripTitle: title }).revision });
describe('Markdown-only active storage', () => {
  it('keeps retry and feed identity in YAML without retired article fields or JSON', async () => {
    const store = new MemoryStore(), reader = repo(store);
    const article = await reader.createArticle({ title: 'Article', url: 'https://example.com/a', feed: '[[Reading/Wires/Feed]]', body: 'Publisher text', extractor: 'feed' });
    await reader.setArticleError(article.path, 'Offline', '2030-01-01T00:00:00.000Z');
    const note = parseNote(await store.read(article.path));
    expect(note.doc.toJS()).toMatchObject({ type: 'article', feed: '[[Reading/Wires/Feed]]', error: 'Offline' });
    for (const key of ['id', 'guid', 'pullmanFormat', 'content', 'extractor', 'sourceHash', 'sourceLength']) expect(note.doc.has(key)).toBe(false);
    expect(note.doc.has('highlights')).toBe(false);
    expect((await store.list()).every(path => path.endsWith('.md'))).toBe(true);
    expect((await reader.createArticle({ title: 'Another name', url: 'https://example.com/b', feed: article.feed })).path).not.toBe(article.path);
  });
  it('adds native marks, converts to bare links, and preserves existing journals', async () => {
    const journal = '# Journal\n\nMy old entry and [[Old#^hl-old]].\n';
    const store = new MemoryStore({ 'Daily/2026-10-09.md': journal }), reader = repo(store);
    let article = await reader.createArticle({ title: 'Article', url: '', body: 'A clear source phrase.', extractor: 'manual' });
    const before = parseNote(await store.read(article.path));
    article = await reader.addHighlight(article.path, selection(article.body, 'clear source', article.title));
    expect(article.body).toBe('A ==clear source== phrase.');
    expect(article.content).toBe('protected');
    expect(article.highlights).toHaveLength(1);
    expect(parseNote(await store.read(article.path)).doc.get('sourceHash')).toBe(before.doc.get('sourceHash'));
    const oldId = article.highlights[0].id;
    article = await reader.setHighlightLink(article.path, oldId, 'Topic');
    expect(article.body).toBe('A [[Topic|clear source]] phrase.');
    expect(article.highlights).toEqual([]);
    await expect(reader.deleteHighlight(article.path, oldId)).rejects.toThrow(/changed/i);
    const link = parseInlineMarkdown(article.body, { stripTitle: article.title }).links[0];
    article = await reader.deleteLink(article.path, link.id);
    expect(article.body).toBe('A clear source phrase.');
    expect(article.content).toBe('protected');
    expect(await store.read('Daily/2026-10-09.md')).toBe(journal);
    expect(Object.keys(store.snapshot())).toHaveLength(2);
    expect(await store.read(article.path)).not.toMatch(/highlights:|dailyPath:|## Highlights|\^hl-/);
  });

  it('preserves custom YAML, Comments and authored ownership across sectioned mutations', async () => {
    const path = 'Reading/Inbox/Article.md';
    const original = '---\ntype: article\ntitle: Article\ncustom: keep # authored YAML comment\ncontent: ready\nextractor: manual\n---\n## Article\n\nFirst source paragraph.\n\n## Comments\n\nKeep my comments.\n';
    const store = new MemoryStore({ [path]: original }), reader = repo(store);
    const article = await reader.getArticle(path);
    const marked = await reader.addHighlight(path, selection(article.body, 'source', article.title));
    expect(marked.body).toBe('First ==source== paragraph.');
    const raw = await store.read(path), note = parseNote(raw);
    expect(raw).toContain('custom: keep # authored YAML comment');
    expect(raw).toContain('## Comments\n\nKeep my comments.\n');
    expect(note.doc.has('sourceHash')).toBe(false);
    expect(note.doc.get('extractor')).toBe('manual');
    await reader.saveContent(path, { title: 'Replacement', markdown: 'Do not replace this.', status: 'ready', extractor: 'defuddle' });
    expect(parseNote(await store.read(path)).body).toBe(note.body);
    expect(parseNote(await store.read(path)).doc.get('error')).toMatch(/Snapshot protected/);
  });

  it('keeps verified section layout without granting extraction ownership after annotation', async () => {
    const path = 'Reading/Inbox/Article.md', source = '\nFirst source.\n\n## Publisher section\n\nMore text.\n\n';
    const original = writeNote(newNote({ type: 'article', articleSection: 'Article', extractor: 'summary', content: 'partial', sourceLayoutHash: fingerprint(source), sourceLayoutLength: source.length },
      '## Article\n' + source + '## Authored footer\n\nLeave this outside Reader.'));
    const store = new MemoryStore({ [path]: original }), reader = repo(store);
    const initial = await reader.getArticle(path);
    const marked = await reader.addHighlight(path, selection(initial.body, 'First source', initial.title));
    expect(marked.body).toBe('==First source==.\n\n## Publisher section\n\nMore text.');
    expect(marked.body).not.toContain('Authored footer');
    const note = parseNote(await store.read(path));
    expect(note.doc.has('sourceHash')).toBe(false);
    expect(note.doc.has('sourceLength')).toBe(false);
    expect(note.doc.get('sourceLayoutHash')).not.toBe(fingerprint(source));
    await reader.deleteHighlight(path, marked.highlights[0].id);
    expect((await reader.getArticle(path)).body).toBe(initial.body);
    expect((await reader.getArticle(path)).content).toBe('protected');
    expect(await store.read(path)).toContain('## Authored footer\n\nLeave this outside Reader.');
  });

  it('rejects stale selection revisions and stale acquisition identities without writes', async () => {
    const store = new MemoryStore(), reader = repo(store);
    const article = await reader.createArticle({ title: 'Pending', url: 'https://example.com/a', body: 'Source text.', extractor: 'summary' });
    const stale = selection(article.body, 'Source', article.title);
    await store.process(article.path, raw => raw.replace('Source text.', 'Edited Source text.'));
    const before = store.snapshot();
    await expect(reader.addHighlight(article.path, stale)).rejects.toThrow(/changed/i);
    await expect(reader.saveContent(article.path, { title: 'No', markdown: 'Replacement', status: 'ready', extractor: 'defuddle' }, { expectedUrl: 'https://example.com/b' })).rejects.toThrow();
    await expect(reader.setArticleError(article.path, 'No', undefined, { expectedRevision: 'stale raw note' })).rejects.toThrow();
    expect(store.snapshot()).toEqual(before);
  });

  it('refuses YAML alias side effects on custom properties', async () => {
    const path = 'Reading/Inbox/Alias.md', raw = '---\ntype: article\ncontent: &state ready\ncustom: *state\n---\nSource text.';
    const store = new MemoryStore({ [path]: raw }), reader = repo(store);
    const article = await reader.getArticle(path);
    await reader.addHighlight(path, selection(article.body, 'Source', article.title));
    const saved = parseNote(await store.read(path));
    expect(saved.doc.toJS().custom).toBe('ready');
    expect(saved.body).toContain('==Source==');
  });

  it('takes its mutation source from the latest process buffer, not a prior read', async () => {
    class EditingStore extends MemoryStore {
      override async process(path: string, update: (raw: string) => string) {
        return super.process(path, raw => update(raw.replace('Source text.', 'A native edit.')));
      }
    }
    const path = 'Reading/Inbox/Article.md';
    const store = new EditingStore({ [path]: writeNote(newNote({ type: 'article' }, 'Source text.')) }), reader = repo(store);
    const article = await reader.getArticle(path);
    await expect(reader.addHighlight(path, selection(article.body, 'Source', article.title))).rejects.toThrow(/changed/i);
    expect(await store.read(path)).toContain('Source text.');
  });

  it('moves exact bytes only when ordinary links remain valid, without journal repair', async () => {
    const path = 'Reading/Inbox/Article.md', raw = writeNote(newNote({ type: 'article', pullmanFormat: 'inline-v1' }, 'A ==phrase== and [[Topic]].'));
    const daily = '> historical\n\n[[Article#^hl-old]]';
    const store = new MemoryStore({ [path]: raw, 'Daily/Old.md': daily, 'Topic.md': 'A topic' }), reader = repo(store);
    expect((await reader.setStatus(path, 'later')).path).toBe('Reading/Later/Article.md');
    expect(await store.read('Reading/Later/Article.md')).toBe(raw);
    expect(await store.read('Daily/Old.md')).toBe(daily);
    await store.process('Daily/Old.md', () => '> historical\n\n[[Reading/Later/Article#^hl-old]]');
    const before = store.snapshot();
    await expect(reader.setStatus('Reading/Later/Article.md', 'archive')).rejects.toThrow(/reference/i);
    expect(store.snapshot()).toEqual(before);
  });
});
