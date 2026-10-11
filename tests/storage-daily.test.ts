import { parseInlineMarkdown } from '../src/inline';
import { expect, it } from 'vitest';
import { DEFAULT_SETTINGS } from '../src/types';
import { ReaderRepository } from '../src/storage/repository';
import { MemoryStore } from '../src/storage/memory';
import { mark } from './markdown-helpers';

it.each([
  '---\ncustom: keep\n---',
  '## Reading\n\nUser journal writing.\n',
  '```md\n## Reading\nUnclosed fence',
  'Reading\n=======\n\n[[Old#^hl-old|Source]]\n',
  '\uFEFF---\r\ncustom: keep\r\n---\r\nJournal text.\r\n',
])('annotation operations preserve every journal byte: %j', async journal => {
  const daily = 'Daily/2026-10-09.md', store = new MemoryStore({ [daily]: journal });
  const repo = new ReaderRepository(store, DEFAULT_SETTINGS);
  const article = await repo.createArticle({ title: 'Source', url: '', body: 'A useful quote.' });
  const marked = await mark(repo, article.path, { quote: 'useful quote' });
  const linked = await repo.setHighlightLink(article.path, marked.highlights[0].id, 'Target');
  await repo.deleteLink(article.path, parseInlineMarkdown(linked.body, { stripTitle: linked.title }).links[0].id);
  await new ReaderRepository(store, DEFAULT_SETTINGS).prepareStorage();
  expect(await store.read(daily)).toBe(journal);
  expect(Object.keys(store.snapshot()).sort()).toEqual([daily, article.path].sort());
});
