import { afterEach, expect, it, vi } from 'vitest';
import { ReaderRepository } from '../src/storage/repository';
import { ReaderController } from '../src/controller';
import { MemoryStore } from '../src/storage/memory';
import { DEFAULT_SETTINGS } from '../src/types';
import { mark } from './markdown-helpers';
import { nativeStore } from './helpers/native-store';

const path = 'Reading/Stream/Article.md', inbox = 'Reading/Inbox/Article.md';
const note = (body: string, extra = '') => `---\ntype: article\npublished: 2020-01-01\n${extra}---\n${body}`;
afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers(); });
it('does not promote a replacement created after the annotation commits', async () => {
  const store = new MemoryStore({ [path]: note('Words') }), repo = new ReaderRepository(store, DEFAULT_SETTINGS);
  const process = store.process.bind(store), replacement = note('Replacement');
  vi.spyOn(store, 'process').mockImplementationOnce(async (...args) => {
    await process(...args); await repo.articleDeleted(path); await process(path, () => replacement);
  });
  await expect(mark(repo, path, { quote: 'Words' })).rejects.toThrow(/stale/);
  expect(await store.read(path)).toBe(replacement); expect(await store.exists(inbox)).toBe(false);
});
it.each(['annotation', 'cleanup', 'native'] as const)('fences raw changes between %s inspection and the mover reread', async mode => {
  const store = new MemoryStore({ [path]: note(mode === 'annotation' ? 'Words' : '==Words==') }), repo = new ReaderRepository(store, DEFAULT_SETTINGS);
  const read = store.read.bind(store), replacement = note('Replacement'); let reads = 0;
  // annotation helper reads once before writing; result reads next; mover reads third.
  vi.spyOn(store, 'read').mockImplementation(async target => {
    if (target === path && ++reads === (mode === 'annotation' ? 3 : 2)) await store.process(path, () => replacement);
    return read(target);
  });
  if (mode === 'annotation') await expect(mark(repo, path, { quote: 'Words' })).rejects.toThrow(/could not move/);
  else expect((await (mode === 'cleanup' ? repo.cleanupStream(Date.now()) : repo.promoteAnnotatedStream())).retained).toEqual([path]);
  expect(await store.read(path)).toBe(replacement); expect(await store.exists(inbox)).toBe(false);
});
it.each(['annotation', 'cleanup', 'native'] as const)('fences even byte-identical delete/recreate at %s rename dispatch', async mode => {
  const store = new MemoryStore({ [path]: note(mode === 'annotation' ? 'Words' : '==Words==') }), repo = new ReaderRepository(store, DEFAULT_SETTINGS);
  const rename = store.rename.bind(store);
  vi.spyOn(store, 'rename').mockImplementationOnce(async (...args) => { await repo.articleDeleted(path); return rename(...args); });
  if (mode === 'annotation') await expect(mark(repo, path, { quote: 'Words' })).rejects.toThrow(/could not move/);
  else expect((await (mode === 'cleanup' ? repo.cleanupStream(Date.now()) : repo.promoteAnnotatedStream())).retained).toEqual([path]);
  expect(await store.read(path)).toContain('==Words=='); expect(await store.exists(inbox)).toBe(false);
});
it.each(['highlight', 'topic', 'author'])('promotes a recent native %s after a debounced vault event without waiting for expiration', async kind => {
  vi.useFakeTimers();
  const store = new MemoryStore({ [path]: note('Words').replace('2020-01-01', '2099-01-01') }), repo = new ReaderRepository(store, DEFAULT_SETTINGS);
  const controller = new ReaderController(repo, vi.fn(), DEFAULT_SETTINGS);
  await store.process(path, () => note(kind === 'highlight' ? '==Words==' : 'Words', kind === 'topic' ? 'topics: ["[[Nodes/Topic]]"]\n' : kind === 'author' ? 'authors: ["[[Nodes/Person]]"]\n' : '').replace('2020-01-01', '2099-01-01'));
  controller.vaultChanged(); controller.vaultChanged(); await vi.advanceTimersByTimeAsync(250);
  expect((await repo.getArticle(inbox)).status).toBe('inbox'); expect(await store.exists(path)).toBe(false);
  await controller.shutdown();
});
it('retries native promotion on a later layout event after the editor closes', async () => {
  vi.useFakeTimers();
  const f = nativeStore({ [path]: note('==Words==') }), repo = new ReaderRepository(f.store, DEFAULT_SETTINGS), controller = new ReaderController(repo, vi.fn(), DEFAULT_SETTINGS);
  f.open(path); controller.vaultChanged(); await vi.advanceTimersByTimeAsync(250);
  expect(f.disk.has(path)).toBe(true); expect(controller.message).toContain('deferred');
  f.leaves.length = 0; controller.vaultChanged(); await vi.advanceTimersByTimeAsync(250);
  expect(f.disk.has(inbox)).toBe(true); expect(f.disk.has(path)).toBe(false); await controller.shutdown();
});
it('does not infer native authorship from ordinary publisher links or unknown full text', async () => {
  const raw = note('Unknown publisher text with [[Target]] and [source](https://example.com)'), store = new MemoryStore({ [path]: raw }), repo = new ReaderRepository(store, DEFAULT_SETTINGS);
  expect(await repo.promoteAnnotatedStream()).toEqual({ promoted: [], retained: [] }); expect(await store.read(path)).toBe(raw);
});
