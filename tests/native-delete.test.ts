import { expect, it, vi } from 'vitest';
import { nativeDeleteHandler } from '../src/native-delete';
import { ReaderController } from '../src/controller';
import { ReaderRepository } from '../src/storage/repository';
import { MemoryStore } from '../src/storage/memory';
import { sidecarPath } from './sidecar-helpers';
import { DEFAULT_SETTINGS, type HttpGet } from '../src/types';

const path = 'Reading/Inbox/Deleted.md';
const raw = '---\ntype: article\nurl: https://example.com/article\n---\nFresh text';
it('native handler invalidates every Markdown child once and ignores non-Markdown files', async () => {
  const controller = { articleDeleted: vi.fn().mockResolvedValue(undefined), vaultChanged: vi.fn() };
  const changed = vi.fn(), report = vi.fn(), handler = nativeDeleteHandler(controller, changed, report, () => false);
  handler({ path: 'Reading', children: [{ path }, { path }, { path: 'Reading/Other.md' }, { path: sidecarPath(path) }] });
  await vi.waitFor(() => expect(changed).toHaveBeenCalledOnce());
  expect(controller.articleDeleted.mock.calls).toEqual([[path], ['Reading/Other.md']]);
  expect(report).not.toHaveBeenCalled();
});
it('native handler reports child failure but still invalidates other deleted children', async () => {
  const controller = { articleDeleted: vi.fn(async (target: string) => { if (target === path) throw new Error('Failure'); }), vaultChanged: vi.fn() };
  const report = vi.fn(), changed = vi.fn();
  nativeDeleteHandler(controller, changed, report, () => false)({ path: 'Reading', children: [{ path }, { path: 'Reading/Other.md' }] });
  await vi.waitFor(() => expect(changed).toHaveBeenCalledOnce());
  expect(controller.articleDeleted).toHaveBeenCalledTimes(2); expect(report).toHaveBeenCalledOnce();
});
it('deletion invalidates acquisition, preserves journals, and allows fresh Markdown identity', async () => {
  const store = new MemoryStore({ 'Daily/day.md': 'User journal.' }), repo = new ReaderRepository(store, DEFAULT_SETTINGS);
  const generation = repo.articleGeneration(path); await repo.articleDeleted(path);
  expect(repo.articleGeneration(path)).not.toBe(generation);
  await store.create(path, raw);
  expect(await repo.getArticle(path)).not.toHaveProperty('id');
  expect(await store.read('Daily/day.md')).toBe('User journal.');
  expect(Object.keys(store.snapshot()).sort()).toEqual(['Daily/day.md', path].sort());
});
it('duplicate delete events allow filename reuse with fresh Markdown while invalidating the old generation', async () => {
  const store = new MemoryStore(), repo = new ReaderRepository(store, DEFAULT_SETTINGS), input = { title: 'Reused', url: '' };
  const old = await repo.createArticle(input), generation = repo.articleGeneration(old.path);
  await store.rename(old.path, 'Trash.md', { expectedContent: await store.read(old.path) });
  await store.process('Trash.md', () => 'Unrelated placeholder');
  await Promise.all([repo.articleDeleted(old.path), repo.articleDeleted(old.path)]);
  const fresh = await repo.createArticle(input);
  expect(fresh.path).toBe(old.path);
  expect(repo.articleGeneration(fresh.path)).not.toBe(generation);
  expect(await store.read(fresh.path)).not.toContain('Unrelated placeholder');
  await expect(repo.saveReadingPosition(fresh.path, { marker: 'Stale position' }, generation)).rejects.toThrow();
  expect((await repo.getArticle(fresh.path)).readingPosition).toBeUndefined();
  expect(Object.keys(store.snapshot()).every(path => path.endsWith('.md'))).toBe(true);
});
it('controller awaits invalidation before notifying/scheduling and does not announce failed deletion', async () => {
  const repo = new ReaderRepository(new MemoryStore(), DEFAULT_SETTINGS), controller = new ReaderController(repo, vi.fn<HttpGet>(), DEFAULT_SETTINGS);
  let finish!: () => void;
  const deletion = vi.spyOn(repo, 'articleDeleted').mockImplementation(() => new Promise(resolve => { finish = resolve; }));
  const changed = vi.fn(), schedule = vi.spyOn(controller, 'scheduleAcquisition'); controller.subscribe(changed);
  const pending = controller.articleDeleted(path);
  expect(changed).not.toHaveBeenCalled(); expect(schedule).not.toHaveBeenCalled();
  finish(); await pending; expect(changed).toHaveBeenCalledOnce(); expect(schedule).toHaveBeenCalledOnce();
  changed.mockClear(); schedule.mockClear(); deletion.mockRejectedValue(new Error('Invalidation failed'));
  await expect(controller.articleDeleted(path)).rejects.toThrow('Invalidation failed');
  expect(changed).not.toHaveBeenCalled(); expect(schedule).not.toHaveBeenCalled(); await controller.shutdown();
});
it.each(['{invalid', JSON.stringify({ schema: 1, path, metadata: { queueMove: {} } })])('deletion preserves unrelated JSON without blocking fresh Markdown: %s', async json => {
  const jsonPath = sidecarPath(path), store = new MemoryStore({ [jsonPath]: json }), repo = new ReaderRepository(store, DEFAULT_SETTINGS);
  await repo.articleDeleted(path);
  await store.create(path, raw);
  expect(await store.read(path)).toBe(raw);
  expect(await store.read(jsonPath)).toBe(json);
});
it.each(['acquire', 'fetchFullText'] as const)('%s cannot write late network failure onto a recreated note', async method => {
  const store = new MemoryStore({ [path]: raw.replace('Fresh text', '') });
  const settings = { ...DEFAULT_SETTINGS, useDummyContent: false }, repo = new ReaderRepository(store, settings);
  let fail!: (error: Error) => void;
  const get = vi.fn<HttpGet>(() => new Promise((_resolve, reject) => { fail = reject; }));
  const controller = new ReaderController(repo, get, settings); controller.setOnline(true);
  const work = controller[method](path), rejected = expect(work).rejects.toThrow();
  try {
    await vi.waitFor(() => expect(get).toHaveBeenCalledOnce());
    await store.rename(path, 'Trash.md', { expectedContent: await store.read(path) }); await controller.articleDeleted(path);
    await store.create(path, raw); const before = store.snapshot(); fail(new Error('Late failure')); await rejected;
    expect(store.snapshot()).toEqual(before);
  } finally { await controller.shutdown(); }
});
