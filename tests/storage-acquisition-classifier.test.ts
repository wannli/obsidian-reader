import { describe, expect, it } from 'vitest';
import { DEFAULT_SETTINGS } from '../src/types';
import { isAcquisitionUrl } from '../src/acquisition-url';
import { isArticleNote, type TemplateExclusions } from '../src/storage/classifier';
import { MemoryStore } from '../src/storage/memory';
import { ReaderRepository } from '../src/storage/repository';
import { newNote, writeNote } from '../src/storage/markdown';

const path = 'Elsewhere/Legacy.md';

describe('shared acquisition URL gate before legacy article allowance', () => {
  it.each(['not-a-url', 'https://', 'https://example.com/%7B%7BVALUE:url%7D%7D', 'https://example.com/%257B%257BVALUE:url%257D%257D', 'https://example.com/INSERT_URL', 'https://example.com/<placeholder>', 'https://example.com/has space', 'https://example.com/%ZZ'])(
    'excludes malformed/nonempty template URLs without metadata or error writes: %s', async url => {
      expect(isAcquisitionUrl(url)).toBe(false);
      expect(isArticleNote(path, { type: 'article', url })).toBe(false);
      const store = new MemoryStore({ [path]: writeNote(newNote({ type: 'article', url }, 'User body.')) });
      const before = store.snapshot(), repo = new ReaderRepository(store, DEFAULT_SETTINGS);
      expect(await repo.listArticles()).toEqual([]);
      await expect(repo.setArticleError(path, 'Invalid URL')).rejects.toThrow();
      await expect(repo.saveContent(path, { title: 'Fetched', markdown: 'Wrong text', status: 'ready', extractor: 'defuddle' })).rejects.toThrow();
      expect(store.snapshot()).toEqual(before);
    },
  );

  it.each([undefined, null, '', '   '])('retains legitimate URL-less manual articles: %s', url => {
    expect(isArticleNote(path, { type: 'article', ...(url === undefined ? {} : { url }) })).toBe(true);
  });

  it('does not reject template syntax in Comments or unknown author properties', async () => {
    const queuedPath = 'Reading/Inbox/Legacy.md';
    const raw = writeNote(newNote({ type: 'article', url: 'https://example.com/valid', comments: '{{VALUE:literal documentation}}', custom: '<% this is authored text %>' }, '## Article\n\n## Comments\n\n{{VALUE:literal example}}\n'));
    const store = new MemoryStore({ [queuedPath]: raw }), repo = new ReaderRepository(store, DEFAULT_SETTINGS);
    expect((await repo.listArticles()).map(article => article.path)).toEqual([queuedPath]);
    expect((await repo.getArticle(queuedPath)).extractor).toBe('pending');
    expect(await store.read(queuedPath)).toBe(raw);
    const exclusions: TemplateExclusions = { files: [path] };
    expect(isArticleNote(path, { type: 'article', url: 'https://example.com/valid' }, exclusions)).toBe(false);
  });
});
