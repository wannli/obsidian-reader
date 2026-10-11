import { describe, expect, it, vi } from 'vitest';
import { DEFAULT_SETTINGS } from '../src/types';
import { MemoryStore } from '../src/storage/memory';
import { ReaderRepository } from '../src/storage/repository';
import { parseNote } from '../src/storage/markdown';
import { dummyArticle } from '../src/ingest/dummy';
import { acquisitionState, ReaderController } from '../src/controller';
import { StaleArticleWriteError } from '../src/storage/preconditions';
import { fingerprint } from '../src/storage/fingerprint';

const url = 'https://example.org/read';
const retired = ['id', 'guid', 'pullmanFormat', 'content', 'extractor', 'sourceHash', 'sourceLength'];
const repoFor = (store = new MemoryStore()) => ({ store, repo: new ReaderRepository(store, DEFAULT_SETTINGS) });

describe('seven retired article fields', () => {
  it('never emits them on new article creation or subsequent extraction', async () => {
    const { store, repo } = repoFor();
    const article = await repo.createArticle({ title: 'Fresh', url });
    expect(retired.every(key => !parseNote(store.snapshot()[article.path]).doc.has(key))).toBe(true);
    await repo.saveContent(article.path, dummyArticle(url));
    expect(retired.every(key => !parseNote(store.snapshot()[article.path]).doc.has(key))).toBe(true);
  });

  it('protects authored and full-feed nonempty bodies without verified ownership', async () => {
    const { store, repo } = repoFor();
    for (const input of [
      { title: 'Authored', url, body: 'User writing' },
      { title: 'Feed', url: 'https://example.org/feed', feed: '[[Reading/Wires/Example]]', feedText: { markdown: 'Publisher full text', isExcerpt: false } },
    ]) {
      const article = await repo.createArticle(input);
      const before = await store.read(article.path);
      expect(acquisitionState(article, false)).toBe('protected');
      await repo.saveContent(article.path, { title: 'Replacement', markdown: 'Untrusted replacement', status: 'ready', extractor: 'defuddle' }, { allowFeedReplacement: true });
      expect(await store.read(article.path)).toContain(article.body);
      expect(await store.read(article.path)).not.toContain('Untrusted replacement');
      expect(before).toContain(article.body);
    }
  });

  it('replaces only exact canonical dummy bytes and rejects stale revisions', async () => {
    const { repo } = repoFor();
    const created = await repo.createArticle({ title: 'Dummy', url, body: dummyArticle(url).markdown });
    const snapshot = await repo.getArticle(created.path);
    expect(snapshot.extractor).toBe('dummy');
    await repo.saveContent(created.path, { title: 'Publisher', markdown: 'Real full text', status: 'ready', extractor: 'defuddle' },
      { expectedUrl: url, expectedRevision: snapshot.revision, expectedBody: snapshot.body });
    expect((await repo.getArticle(created.path)).body).toBe('Real full text');
    await expect(repo.saveContent(created.path, dummyArticle(url), { expectedUrl: url, expectedRevision: snapshot.revision }))
      .rejects.toBeInstanceOf(StaleArticleWriteError);
    expect((await repo.getArticle(created.path)).extractor).toBe('manual');
    const other = 'https://example.org/other';
    const modified = await repo.createArticle({ title: 'Edited dummy', url: other, body: dummyArticle(other).markdown + '\nUser suffix' });
    await repo.saveContent(modified.path, { title: 'New', markdown: 'Replacement', status: 'ready', extractor: 'defuddle' });
    expect((await repo.getArticle(modified.path)).body).toContain('User suffix');
  });

  it('retains durable acquisition errors and rejects URL edits at commit', async () => {
    const { repo, store } = repoFor();
    const article = await repo.createArticle({ title: 'Pending', url });
    const before = await repo.getArticle(article.path);
    await repo.setArticleError(article.path, 'Network failed', '2030-01-01T00:00:00Z',
      { expectedUrl: url, expectedRevision: before.revision });
    const failed = await repo.getArticle(article.path);
    expect(failed.content).toBe('error'); expect(failed.retryAfter).toBe('2030-01-01T00:00:00Z');
    expect(retired.every(key => !parseNote(store.snapshot()[article.path]).doc.has(key))).toBe(true);
    await store.process(article.path, raw => raw.replace(url, url + '/changed'));
    await expect(repo.setArticleError(article.path, 'Stale', undefined,
      { expectedUrl: url, expectedRevision: failed.revision })).rejects.toBeInstanceOf(StaleArticleWriteError);
    expect((await repo.getArticle(article.path)).error).toBe('Network failed');
  });

  it('does not treat an unmatched feed excerpt as replaceable', async () => {
    const { repo } = repoFor();
    const article = await repo.createArticle({ title: 'Excerpt', url, summary: 'Feed teaser', body: 'User edited the teaser.' });
    expect(acquisitionState(article, false)).toBe('protected');
    await repo.saveContent(article.path, { title: 'Live', markdown: 'New text', status: 'ready', extractor: 'defuddle' });
    expect((await repo.getArticle(article.path)).body).toBe('User edited the teaser.');
  });

  it('promotes only a successful explicit fetch from a verifiable excerpt', async () => {
    const { repo } = repoFor();
    const article = await repo.createArticle({ title: 'Excerpt', url, status: 'feed', summary: 'RSS excerpt.',
      feedText: { markdown: 'RSS excerpt.', isExcerpt: true } });
    expect(article.extractor).toBe('summary');
    const controller = new ReaderController(repo, vi.fn(), { ...DEFAULT_SETTINGS, useDummyContent: true });
    const extract = await import('../src/ingest/extract');
    const spy = vi.spyOn(extract, 'extractArticle').mockResolvedValueOnce({ title: 'Publisher', markdown: 'Publisher full text.', status: 'ready', extractor: 'defuddle' });
    try {
      const saved = await controller.fetchFullText(article.path);
      expect(saved.status).toBe('inbox'); expect(saved.body).toBe('Publisher full text.');
      expect(spy).toHaveBeenCalledOnce();
      expect(acquisitionState(saved, false)).toBe('protected');
    } finally { spy.mockRestore(); await controller.shutdown(); }
  });

  it('deduplicates feed entries by URL only; manual captures stay distinct', async () => {
    const { repo } = repoFor();
    const base = { title: 'Feed', url, feed: '[[Reading/Wires/Example]]', guid: 'unchanged-guid', status: 'feed' as const };
    const first = await repo.createArticle(base);
    expect((await repo.createArticle(base)).path).toBe(first.path);
    expect((await repo.createArticle({ ...base, url: url + '/changed' })).path).not.toBe(first.path);
    expect((await repo.createArticle({ title: 'Manual', url })).path).not.toBe((await repo.createArticle({ title: 'Manual', url })).path);
  });

  it('reads historical markers without deleting or rewriting them on unrelated saves', async () => {
    const body = 'Legacy publisher body';
    const path = 'Reading/Inbox/261011 Legacy.md';
    const original = `---\ntype: article\nurl: ${url}\nid: article-old\nguid: old-guid\npullmanFormat: inline-v1\ncontent: ready\nextractor: defuddle\nsourceHash: ${fingerprint(body)}\nsourceLength: ${body.length}\ncustom: preserved\n---\n${body}`;
    const { store, repo } = repoFor(new MemoryStore({ [path]: original }));
    const old = await repo.getArticle(path);
    expect(old.extractor).toBe('defuddle');
    await repo.setArticleError(path, 'Retry later');
    const after = parseNote(await store.read(path));
    for (const key of retired) expect(after.doc.get(key)).toBe(parseNote(original).doc.get(key));
    expect(after.doc.get('custom')).toBe('preserved');
  });
});
