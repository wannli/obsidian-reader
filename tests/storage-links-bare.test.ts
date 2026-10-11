import { parseInlineMarkdown } from '../src/inline';
import { expect, it } from 'vitest';
import { DEFAULT_SETTINGS } from '../src/types';
import { MemoryStore } from '../src/storage/memory';
import { ReaderRepository } from '../src/storage/repository';
import { mark } from './markdown-helpers';

it.each(['selected text', '自然 与 科学'])('primary Link writes ordinary bare wikilink without creating a file: %s', async quote => {
  const store = new MemoryStore(), repo = new ReaderRepository(store, DEFAULT_SETTINGS);
  const article = await repo.createArticle({ title: 'Source', url: '', body: 'Before ' + quote + ' after.' });
  const marked = await mark(repo, article.path, { quote });
  const linked = await repo.setHighlightLink(article.path, marked.highlights[0].id, quote);
  expect(linked.body).toBe('Before [[' + quote + ']] after.');
  expect(linked.highlights).toHaveLength(0);
  expect(parseInlineMarkdown(linked.body, { stripTitle: linked.title }).links[0]).toMatchObject({ target: quote, quote });
  expect(Object.keys(store.snapshot())).toEqual([article.path]);
  await repo.deleteLink(article.path, parseInlineMarkdown(linked.body, { stripTitle: linked.title }).links[0].id);
  expect((await repo.getArticle(article.path)).body).toBe(article.body);
});
it('Link to a different note preserves the selected words as alias', async () => {
  const store = new MemoryStore(), repo = new ReaderRepository(store, DEFAULT_SETTINGS);
  const article = await repo.createArticle({ title: 'Source', url: '', body: 'selected text' });
  const marked = await mark(repo, article.path, { quote: 'selected text' });
  const linked = await repo.setHighlightLink(article.path, marked.highlights[0].id, 'Folder/Chosen note');
  expect(linked.body).toBe('[[Folder/Chosen note|selected text]]');
  const before = store.snapshot();
  await expect(repo.setHighlightLink(article.path, marked.highlights[0].id, 'Other')).rejects.toThrow(/changed/i);
  expect(store.snapshot()).toEqual(before);
});
it.each(['bad|name', 'bracket[name]', 'first\nsecond', '<unsafe>', 'name:colon', '\u0000name'])('rejects unsafe direct target without changing source: %j', async target => {
  const store = new MemoryStore(), repo = new ReaderRepository(store, DEFAULT_SETTINGS);
  const article = await repo.createArticle({ title: 'Source', url: '', body: 'Selected words.' });
  const marked = await mark(repo, article.path, { quote: 'Selected words.' }), before = store.snapshot();
  await expect(repo.setHighlightLink(article.path, marked.highlights[0].id, target)).rejects.toThrow();
  expect(store.snapshot()).toEqual(before);
});
it('literal escaped link-looking words remain literal after unhighlight', async () => {
  const store = new MemoryStore(), repo = new ReaderRepository(store, DEFAULT_SETTINGS);
  const article = await repo.createArticle({ title: 'Source', url: '', body: 'Literal \\[label\\] here.' });
  const marked = await mark(repo, article.path, { quote: '[label]' });
  await repo.deleteHighlight(article.path, marked.highlights[0].id);
  expect((await repo.getArticle(article.path)).body).toBe(article.body);
  expect(parseInlineMarkdown((await repo.getArticle(article.path)).body).links).toHaveLength(0);
});
