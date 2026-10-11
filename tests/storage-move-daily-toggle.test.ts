import { expect, it } from 'vitest';
import { DEFAULT_SETTINGS } from '../src/types';
import { MemoryStore } from '../src/storage/memory';
import { ReaderRepository } from '../src/storage/repository';
import { mark } from './markdown-helpers';
it('queue moves preserve inline Markdown and user journals', async () => {
  const journal = '> User-edited journal excerpt\n\n[[Unrelated#^old]]\n', daily = 'Daily/old.md';
  const store = new MemoryStore({ [daily]: journal }), repo = new ReaderRepository(store, DEFAULT_SETTINGS);
  const article = await repo.createArticle({ title: 'Move', url: '', body: 'Source quote. Other words.' });
  await mark(repo, article.path, { quote: 'Source quote.' });
  const before = await store.read(article.path), moved = await repo.setStatus(article.path, 'later');
  expect(await store.read(moved.path)).toBe(before); expect(await store.exists(article.path)).toBe(false);
  expect(await store.read(daily)).toBe(journal); expect(moved.highlights[0].quote).toBe('Source quote.');
  const restarted = new ReaderRepository(new MemoryStore(store.snapshot()), DEFAULT_SETTINGS);
  expect((await restarted.getArticle(moved.path)).body).toBe('==Source quote.== Other words.');
  expect(Object.keys(store.snapshot()).sort()).toEqual([daily, moved.path].sort());
});
it('a move cannot strand existing journal block backlinks; rejection preserves all bytes', async () => {
  const path = 'Reading/Inbox/Old.md', daily = 'Daily/old.md';
  const raw = '---\ntype: article\n---\nReadable source.\n\n> Inert old excerpt\n\n^hl-old\n';
  const store = new MemoryStore({ [path]: raw, [daily]: '[[Reading/Inbox/Old#^hl-old|Old source]]\nUser writing.' });
  const before = store.snapshot(), repo = new ReaderRepository(store, DEFAULT_SETTINGS);
  await expect(repo.setStatus(path, 'later')).rejects.toThrow(); expect(store.snapshot()).toEqual(before);
});
it('destination collision preserves source annotations and both files', async () => {
  const store = new MemoryStore(), repo = new ReaderRepository(store, DEFAULT_SETTINGS);
  const article = await repo.createArticle({ title: 'Move', url: '', body: 'Source quote.' });
  await mark(repo, article.path, { quote: 'Source quote.' });
  const to = article.path.replace('/Inbox/', '/Later/'); await store.create(to, 'Other user note.');
  const before = store.snapshot(); await expect(repo.setStatus(article.path, 'later')).rejects.toThrow(); expect(store.snapshot()).toEqual(before);
});
it.each([false, true])('rename interruption preserves source and journal bytes (after=%s)', async after => {
  class FaultStore extends MemoryStore {
    override async rename(from: string, to: string, options: { expectedContent: string }) {
      if (after) await super.rename(from, to, options);
      throw new Error('Rename acknowledgement lost');
    }
  }
  const store = new FaultStore({ 'Daily/old.md': 'Personal journal.' }), repo = new ReaderRepository(store, DEFAULT_SETTINGS);
  const article = await repo.createArticle({ title: 'Move', url: '', body: '==Source quote.==' });
  const raw = await store.read(article.path), to = article.path.replace('/Inbox/', '/Later/');
  await expect(repo.setStatus(article.path, 'later')).rejects.toThrow('Rename acknowledgement lost');
  expect(await store.read(after ? to : article.path)).toBe(raw);
  expect(await store.exists(after ? article.path : to)).toBe(false);
  expect(await store.read('Daily/old.md')).toBe('Personal journal.');
});
