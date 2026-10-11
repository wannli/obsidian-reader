import { expect, it } from 'vitest';
import { ReaderRepository } from '../src/storage/repository';
import { DEFAULT_SETTINGS } from '../src/types';
import { gate, nativeStore } from './helpers/native-store';

const path = 'Reading/Inbox/Race.md';
const markdown = '---\ntype: article\nurl: https://example.com\nid: article-old\n---\nOriginal text';
const replacement = markdown.replace('article-old', 'article-new').replace('Original text', 'Replacement user text');
it.each(['success', 'failure'] as const)('delete/recreate during a dispatched acquisition %s write preserves replacement', async result => {
  const f = nativeStore({ [path]: markdown }), repo = new ReaderRepository(f.store, DEFAULT_SETTINGS), entered = gate(), held = gate();
  const process = f.vault.process.getMockImplementation()!;
  f.vault.process.mockImplementation(async (file, update) => { entered.release(); await held.promise; return process(file, update); });
  const options = { expectedGeneration: repo.articleGeneration(path), expectedId: 'article-old', expectedUrl: 'https://example.com' };
  const operation = result === 'success' ? repo.saveContent(path, { title: 'Late', markdown: 'Late fetched text', extractor: 'defuddle', status: 'ready' }, options) : repo.setArticleError(path, 'Late error', '2030-01-01T00:00:00Z', options);
  const outcome = operation.catch(error => error);
  await entered.promise; f.files.delete(path); f.disk.delete(path); await repo.articleDeleted(path); await f.vault.create(path, replacement);
  held.release(); expect(await outcome).toBeInstanceOf(Error);
  expect(f.disk.get(path)).toBe(replacement); expect([...f.disk.keys()]).toEqual([path]);
});
it('plugin rename delayed by folder creation cannot relocate a deleted source', async () => {
  const to = 'Reading/Later/Race.md', f = nativeStore({ [path]: markdown });
  const entered = gate(), held = gate(), folder = f.vault.createFolder.getMockImplementation()!;
  f.vault.createFolder.mockImplementation(async target => { if (target === 'Reading/Later') { entered.release(); await held.promise; } return folder(target); });
  const moving = f.store.rename(path, to, { expectedContent: markdown }).catch(error => error);
  await entered.promise; f.files.delete(path); f.disk.delete(path); held.release();
  expect(await moving).toBeInstanceOf(Error); expect(f.disk.has(to)).toBe(false); expect(f.vault.rename).not.toHaveBeenCalled();
});
it('Markdown creation delayed by folder creation honors an invalidated guard at Vault.create boundary', async () => {
  const f = nativeStore({}), entered = gate(), held = gate(); let valid = true;
  const folder = f.vault.createFolder.getMockImplementation()!;
  f.vault.createFolder.mockImplementation(async target => { if (target === 'Reading/Inbox') { entered.release(); await held.promise; } return folder(target); });
  const writing = f.store.create(path, markdown, { guard: () => { if (!valid) throw new Error('Deleted generation'); } }).catch(error => error);
  await entered.promise; valid = false; held.release();
  expect(await writing).toBeInstanceOf(Error); expect(f.disk.has(path)).toBe(false); expect(f.vault.create).not.toHaveBeenCalled();
});
it('a replacement appearing after native rename preflight is never overwritten', async () => {
  const to = 'Reading/Later/Race.md', f = nativeStore({ [path]: markdown });
  f.hooks.beforeRename = async () => { await f.vault.create(to, replacement); };
  await expect(f.store.rename(path, to, { expectedContent: markdown })).rejects.toThrow();
  expect(f.disk.get(path)).toBe(markdown); expect(f.disk.get(to)).toBe(replacement);
});
it('repository creation delayed before dispatch cannot resurrect a deleted path', async () => {
  const f = nativeStore({}), repo = new ReaderRepository(f.store, DEFAULT_SETTINGS), entered = gate(), held = gate();
  const folder = f.vault.createFolder.getMockImplementation()!;
  f.vault.createFolder.mockImplementation(async target => { if (target === 'Reading/Inbox') { entered.release(); await held.promise; } return folder(target); });
  const writing = repo.createArticle({ title: 'Race', url: '' }).catch(error => error);
  await entered.promise;
  const date = new Date(), pad = (n: number) => String(n).padStart(2, '0');
  const target = `Reading/Inbox/${pad(date.getFullYear() % 100)}${pad(date.getMonth() + 1)}${pad(date.getDate())} Race.md`;
  await repo.articleDeleted(target); held.release();
  expect(await writing).toBeInstanceOf(Error); expect(f.disk.has(target)).toBe(false);
});
