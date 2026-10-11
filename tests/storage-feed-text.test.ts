import { mark } from './markdown-helpers';
import { readNoteRaw, rawStore } from './markdown-helpers';
import { describe, expect, it } from 'vitest';
import { DEFAULT_SETTINGS } from '../src/types';
import { MemoryStore } from '../src/storage/memory';
import { ReaderRepository } from '../src/storage/repository';
import { parseNote, writeNote } from '../src/storage/markdown';
import { dummyArticle } from '../src/ingest/dummy';

const url = 'https://example.com/publisher-title';
const feedText = { markdown: 'Genuine **publisher excerpt**.\n\nA second paragraph.', isExcerpt: true };
const live = { title: 'Live publisher title', markdown: 'Genuine acquired full text.', status: 'ready' as const, extractor: 'defuddle' as const };
function fixture() {
  const store = new MemoryStore();
  return { store, repo: new ReaderRepository(store, DEFAULT_SETTINGS) };
}

describe('transient supplied feed text persistence', () => {
  it('retains exact summary bytes as the only restart-safe proof for excerpt upgrade', async () => {
    const { store, repo } = fixture();
    const article = await repo.createArticle({ title: 'Publisher title', url, body: feedText.markdown, summary: feedText.markdown, content: 'partial', feed: 'Feeds/Publisher.md', guid: 'stable-guid' });
    const note = parseNote(await readNoteRaw(store, article.path));
    expect(note.doc.get('summary')).toBe(feedText.markdown);
    expect(note.doc.toJS()).toMatchObject({ type: 'article', feed: 'Feeds/Publisher.md' });
    for (const field of ['id', 'guid', 'pullmanFormat', 'content', 'extractor', 'sourceHash', 'sourceLength']) expect(note.doc.has(field)).toBe(false);
    const restarted = new ReaderRepository(store, DEFAULT_SETTINGS);
    expect(await restarted.getArticle(article.path)).toMatchObject({ body: feedText.markdown, extractor: 'summary' });
    const before = store.snapshot();
    await restarted.saveContent(article.path, dummyArticle(url));
    expect(store.snapshot()).toEqual(before);
    expect((await restarted.saveContent(article.path, live)).body).toBe(live.markdown);
  });

  it.each([
    { body: '', summary: 'Sole RSS text' },
    { body: 'Full text', summary: 'Different excerpt' },
    { body: 'Excerpt', summary: ' Excerpt ' },
    { body: 'Excerpt', summary: 'Excerpt', extractor: 'pending' as const },
  ])('retains nonredundant summary or summary needed by the dummy veto (%j)', async input => {
    const { store, repo } = fixture();
    const article = await repo.createArticle({ title: 'Publisher title', url, ...input });
    expect(parseNote(await readNoteRaw(store, article.path)).doc.get('summary')).toBe(input.summary);
    const before = store.snapshot();
    await repo.saveContent(article.path, dummyArticle(url));
    expect(store.snapshot()).toEqual(before);
  });

  it('protects edited duplicate-summary bodies after their metadata was omitted', async () => {
    const { store, repo } = fixture();
    const article = await repo.createArticle({ title: 'Publisher title', url, body: 'Excerpt', summary: 'Excerpt' });
    await store.process(article.path, raw => raw.replace('---\nExcerpt', '---\nEdited excerpt'));
    const saved = await repo.saveContent(article.path, live);
    expect(saved.content).toBe('protected');
    expect(saved.body).toBe('Edited excerpt');
  });

  it('protects excerpts whose stored summary differs, without duplicating source metadata', async () => {
    const { store, repo } = fixture();
    const article = await repo.createArticle({ title: 'Publisher title', url, status: 'feed', summary: 'Older duplicate summary', feedText });
    expect(article).toMatchObject({ title: 'Publisher title', status: 'feed', body: feedText.markdown, content: 'protected', extractor: 'manual' });
    expect(article.path).toMatch(/\/\d{6} Feed - Publisher title\.md$/);
    const note = parseNote(await readNoteRaw(store, article.path));
    expect(note.body).toBe(feedText.markdown);
    expect(note.doc.has('feedText')).toBe(false);
    expect(note.doc.get('summary')).toBe('Older duplicate summary');
    expect(note.doc.has('sourceLength')).toBe(false);
    await expect(new ReaderRepository(store, DEFAULT_SETTINGS).getArticle(article.path)).resolves.toMatchObject({ extractor: 'manual', content: 'protected', body: feedText.markdown });
  });

  it('leaves imported publisher text/title/path and all metadata completely untouched by dummy acquisition', async () => {
    const { store, repo } = fixture();
    const article = await repo.createArticle({ title: 'Publisher title', url, feedText });
    const before = store.snapshot();
    const result = await repo.saveContent(article.path, dummyArticle(url));
    expect(parseNote(await store.read(article.path)).body).toBe(parseNote(before[article.path]).body);
    expect(result.title).toBe(article.title);
    expect(result.path).toBe(article.path);
    expect(result.content).toBe('protected');
  });

  it('protects a personal suffix from live acquisition even when the excerpt bytes are intact', async () => {
    const { store, repo } = fixture();
    const article = await repo.createArticle({ title: 'Publisher title', url, feedText });
    await store.process(article.path, raw => raw + '\n\n## Comments\n\nPersonal note.\n');
    const result = await repo.saveContent(article.path, live);
    expect(result.extractor).toBe('manual');
    expect(result.content).toBe('protected');
    expect(result.body).toContain(feedText.markdown);
    expect(parseNote(await readNoteRaw(store, article.path)).body).toContain('## Comments\n\nPersonal note.');
  });

  it('vetoes a late dummy completion against latest newly supplied summary content', async () => {
    const { store, repo } = fixture();
    const article = await repo.createArticle({ title: 'Publisher title', url });
    await rawStore(store).process(article.path, raw => {
      const note = parseNote(raw);
      note.doc.set('extractor', 'summary'); note.doc.set('content', 'partial');
      note.doc.set('summary', 'Real excerpt'); note.body = 'Real excerpt';
      return writeNote(note);
    });
    const before = store.snapshot();
    await repo.saveContent(article.path, dummyArticle(url));
    expect(store.snapshot()).toEqual(before);
  });

  it('does not replace an edited, highlighted, or protected excerpt with live text', async () => {
    for (const state of ['edited', 'highlighted', 'protected']) {
      const { store, repo } = fixture();
      const article = await repo.createArticle({ title: 'Publisher title', url, feedText });
      if (state === 'edited') await store.process(article.path, raw => raw.replace('Genuine **publisher excerpt**.', 'My edited excerpt.'));
      if (state === 'highlighted') await mark(repo, article.path, { quote: 'publisher excerpt' });
      if (state === 'protected') await rawStore(store).process(article.path, raw => { const note = parseNote(raw); note.doc.set('content', 'protected'); return writeNote(note); });
      const before = parseNote(await readNoteRaw(store, article.path)).body;
      expect((await repo.saveContent(article.path, live)).content).toBe('protected');
      expect(parseNote(await readNoteRaw(store, article.path)).body).toBe(before);
    }
  });

  it('preserves publisher Article/Comments headings as source when its whole-prefix hash proves ownership', async () => {
    const { repo } = fixture();
    const markdown = 'Intro.\n\n## Article\n\nPublisher part.\n\n## Comments\n\nPublisher comments.';
    const article = await repo.createArticle({ title: 'Publisher title', url, feedText: { markdown, isExcerpt: true } });
    expect(article.body).toBe(markdown);
    expect((await repo.getArticle(article.path)).body).toBe(markdown);
  });

  it('never substitutes the dummy fixture title for an existing publisher or capture title', async () => {
    const { store, repo } = fixture();
    const article = await repo.createArticle({ title: 'Publisher title', url });
    expect((await repo.saveContent(article.path, dummyArticle(url))).title).toBe(article.title);
    expect(parseNote(await readNoteRaw(store, article.path)).doc.get('title')).toBe('Publisher title');
  });

  it('deduplicates feed imports by URL, but preserves a changed-URL entry as a distinct article', async () => {
    const { store, repo } = fixture();
    const input = { title: 'Publisher title', url, feed: '[[Wires/Publisher]]', guid: 'shared-guid', feedText };
    const first = await repo.createArticle(input);
    const before = await store.read(first.path);
    expect((await repo.createArticle(input)).path).toBe(first.path);
    const changed = await repo.createArticle({ ...input, url: url + '/updated' });
    expect(changed.path).not.toBe(first.path);
    expect(changed.url).toBe(url + '/updated');
    expect((await repo.listArticles()).length).toBe(2);
    expect(await store.read(first.path)).toBe(before);
    expect(parseNote(await store.read(changed.path)).doc.has('guid')).toBe(false);
  });

  it('does not automatically repair or overwrite a duplicate existing dummy-backed note during import', async () => {
    const { store, repo } = fixture();
    const article = await repo.createArticle({ title: 'Publisher title', url });
    await repo.saveContent(article.path, dummyArticle(url));
    const before = store.snapshot();
    const second = await repo.createArticle({ title: 'Publisher title', url, feedText });
    expect(second.path).not.toBe(article.path); // Manual captures are distinct; only feed imports deduplicate.
    expect(await store.read(article.path)).toBe(before[article.path]);
    expect((await repo.getArticle(second.path)).body).toBe(feedText.markdown);
  });
});
