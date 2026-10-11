import { parseInlineMarkdown } from '../src/inline';
import { expect, it } from 'vitest';
import { DEFAULT_SETTINGS } from '../src/types';
import { MemoryStore } from '../src/storage/memory';
import { ReaderRepository } from '../src/storage/repository';
import { parseNote } from '../src/storage/markdown';
import { fingerprint } from '../src/storage/fingerprint';
import { mark } from './markdown-helpers';
async function fixture() {
  const daily = 'Daily/old.md', store = new MemoryStore({ [daily]: 'User-edited old journal copy.' });
  const repo = new ReaderRepository(store, DEFAULT_SETTINGS);
  const article = await repo.createArticle({ title: 'Source', url: '', body: 'Before selected words after.\n\nUnrelated paragraph.' });
  const saved = await mark(repo, article.path, { quote: 'selected words' });
  return { store, repo, article, saved, daily };
}
it('uses portable SHA-256 source fingerprints', () => {
  expect(fingerprint('abc')).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
});
it.each(['Notes/Target', 'https://example.com/reference#section'])('links inline and unlinks without losing words: %s', async target => {
  const { store, repo, article, saved, daily } = await fixture();
  const linked = await repo.setHighlightLink(article.path, saved.highlights[0].id, target);
  expect(linked.highlights).toHaveLength(0); expect(parseInlineMarkdown(linked.body, { stripTitle: linked.title }).links).toHaveLength(1);
  expect(parseInlineMarkdown(linked.body, { stripTitle: linked.title }).links[0]).toMatchObject({ quote: 'selected words', target });
  const restarted = new ReaderRepository(new MemoryStore(store.snapshot()), DEFAULT_SETTINGS);
  expect(parseInlineMarkdown((await restarted.getArticle(article.path)).body, { stripTitle: linked.title }).links).toEqual(parseInlineMarkdown(linked.body, { stripTitle: linked.title }).links);
  await repo.deleteLink(article.path, parseInlineMarkdown(linked.body, { stripTitle: linked.title }).links[0].id);
  expect(parseNote(await store.read(article.path)).body).toBe(article.body);
  expect(await store.read(daily)).toBe('User-edited old journal copy.');
  expect(Object.keys(store.snapshot()).sort()).toEqual([article.path, daily].sort());
});
it.each(['javascript:alert(1)', 'ftp://example.com/a', 'https://user:password@example.com/', '../Escape', '/Absolute', '[[Note|Injected]]', 'Note\nOther', 'Note]] bad', 'Folder/%2e%2e/out'])('rejects unsafe target without any writes: %j', async target => {
  const { store, repo, article, saved } = await fixture(), before = store.snapshot();
  await expect(repo.setHighlightLink(article.path, saved.highlights[0].id, target)).rejects.toThrow();
  expect(store.snapshot()).toEqual(before);
});
it('treats publisher links as ordinary links, preserving labels on unlink', async () => {
  const store = new MemoryStore(), repo = new ReaderRepository(store, DEFAULT_SETTINGS);
  const article = await repo.createArticle({ title: 'Publisher', url: '', body: 'Read [the publisher](https://example.com) today.' });
  await repo.deleteLink(article.path, parseInlineMarkdown(article.body, { stripTitle: article.title }).links[0].id);
  expect((await repo.getArticle(article.path)).body).toBe('Read the publisher today.');
});
