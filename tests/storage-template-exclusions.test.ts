import { describe, expect, it } from 'vitest';
import { DEFAULT_SETTINGS } from '../src/types';
import { MemoryStore } from '../src/storage/memory';
import { ReaderRepository } from '../src/storage/repository';
import { newNote, parseNote, writeNote } from '../src/storage/markdown';
import { isArticleNote, type ArticleTemplateExclusions } from '../src/storage/classifier';

const metadata = { type: 'article', url: 'https://example.com/resolved-template' };
const text = writeNote(newNote(metadata, '## Article\n\n## Comments\n\nKeep template bytes.\n'));

describe('configured template exclusions shared by routing and storage', () => {
  it('uses exact files and folder component boundaries before explicit article type', () => {
    const exclusions = { folders: ['Assets/Article templates/'], files: ['Elsewhere/Exact.md'] };
    expect(isArticleNote('Assets/Article templates/Capture.md', metadata, exclusions)).toBe(false);
    expect(isArticleNote('Assets/Article templates/Nested/Capture.md', metadata, exclusions)).toBe(false);
    expect(isArticleNote('Elsewhere/Exact.md', metadata, exclusions)).toBe(false);
    expect(isArticleNote('Assets/Article templates-other/Manual.md', metadata, exclusions)).toBe(true);
    expect(isArticleNote('Elsewhere/Exact.md2.md', metadata, exclusions)).toBe(true);
    expect(isArticleNote('Manual.md', { type: 'article' }, { folders: ['', '/'] })).toBe(true);
  });

  it('does not guess that every folder named Templates is excluded', () => {
    expect(isArticleNote('Templates/Authored article.md', { type: 'article' })).toBe(true);
    expect(isArticleNote('Templates/Unresolved.md', { type: 'article', url: '{{VALUE:url}}' })).toBe(false);
  });

  it('uses the injected policy for discovery, explicit reads, and zero-write mutations', async () => {
    const path = 'Assets/Templates/Fixed.md';
    const store = new MemoryStore({ [path]: text });
    const repo = new ReaderRepository(store, DEFAULT_SETTINGS, { folders: ['Assets/Templates'] });
    const before = store.snapshot();
    expect(await repo.listArticles()).toEqual([]);
    await expect(repo.getArticle(path)).rejects.toThrow();
    await expect(repo.setArticleError(path, 'Invalid URL', '2030-01-01T00:00:00Z')).rejects.toThrow();
    await expect(repo.setStatus(path, 'later')).rejects.toThrow();
    await expect(repo.saveContent(path, { title: 'Dummy', markdown: 'Sample', status: 'ready', extractor: 'dummy' })).rejects.toThrow();
    expect(store.snapshot()).toEqual(before);
  });
  it('rechecks a synchronous exclusion provider at the latest process boundary', async () => {
    const path = 'Reading/Inbox/Now a template.md';
    let exclusions: ArticleTemplateExclusions = {};
    class LatePolicyStore extends MemoryStore {
      override async process(target: string, update: (current: string) => string): Promise<void> {
        exclusions = { files: [target] };
        return super.process(target, update);
      }
    }
    const store = new LatePolicyStore({ [path]: text }), before = store.snapshot();
    const repo = new ReaderRepository(store, DEFAULT_SETTINGS, () => exclusions);
    expect((await repo.listArticles()).length).toBe(1);
    await expect(repo.setArticleError(path, 'Late failure')).rejects.toThrow();
    expect(store.snapshot()).toEqual(before);
    expect(await repo.listArticles()).toEqual([]);
    expect(parseNote(await store.read(path)).doc.has('id')).toBe(false);
  });
});
