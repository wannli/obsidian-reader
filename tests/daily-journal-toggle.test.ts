import { expect, it } from 'vitest';
import { DEFAULT_SETTINGS } from '../src/types';
import { MemoryStore } from '../src/storage/memory';
import { ReaderRepository } from '../src/storage/repository';
import { mark } from './markdown-helpers';
it('annotations and restart preserve existing journal bytes without creating copies', async () => {
  const daily = 'Daily/old.md', journal = '> Old user-owned excerpt\n\n[[Old article#^hl-old]]\n';
  const store = new MemoryStore({ [daily]: journal }), repo = new ReaderRepository(store, DEFAULT_SETTINGS);
  const article = await repo.createArticle({ title: 'Source', url: '', body: 'Readable words.' });
  const saved = await mark(repo, article.path, { quote: 'Readable' });
  await repo.setHighlightLink(article.path, saved.highlights[0].id, 'Target');
  expect(await store.read(daily)).toBe(journal);
  expect(Object.keys(store.snapshot()).sort()).toEqual([article.path, daily].sort());
});
