import { expect, it } from 'vitest';
import { ReaderRepository } from '../src/storage/repository';
import { MemoryStore } from '../src/storage/memory';
import { DEFAULT_SETTINGS } from '../src/types';
import { sidecarPath } from './sidecar-helpers';

const path = 'Reading/Inbox/Legacy.md', raw = '---\ntype: article\n---\nAuthored text.\n';
const current = sidecarPath(path), old = current.replace('Reading/Metadata/', 'Reading/Pullman Metadata/');
const json = JSON.stringify({ schema: 1, path, metadata: { id: 'article-old', extractor: 'manual', content: 'ready' } });

it.each([current, old])('reports and preserves historical JSON byte-for-byte: %s', async location => {
  const store = new MemoryStore({ [path]: raw, [location]: json }), before = store.snapshot();
  const repo = new ReaderRepository(store, DEFAULT_SETTINGS);
  expect((await repo.prepareStorage()).errors.length).toBeGreaterThan(0);
  await expect(repo.setArticleError(path, 'must not overwrite legacy-owned Markdown')).rejects.toThrow(/blocked|legacy/i);
  expect(store.snapshot()).toEqual(before);
});

it('preserves conflicting locations and protects their owner across restart', async () => {
  const store = new MemoryStore({ [path]: raw, [current]: json, [old]: json }), before = store.snapshot();
  for (let n = 0; n < 2; n++) {
    const repo = new ReaderRepository(store, DEFAULT_SETTINGS);
    expect((await repo.prepareStorage()).errors.length).toBeGreaterThan(0);
    await expect(repo.setStatus(path, 'later')).rejects.toThrow(/blocked|legacy/i);
    expect(store.snapshot()).toEqual(before);
  }
});

it('does not create metadata files for a current note or a new QuickAdd-style article stub', async () => {
  const store = new MemoryStore({ 'Projects/Metadata/notes.md': 'User notes.' });
  const repo = new ReaderRepository(store, DEFAULT_SETTINGS);
  const article = await repo.createArticle({ title: 'New', url: '', body: 'Readable text.' });
  expect(Object.keys(store.snapshot()).sort()).toEqual(['Projects/Metadata/notes.md', article.path].sort());
  expect((await repo.getArticle(article.path)).body).toBe('Readable text.');
});
