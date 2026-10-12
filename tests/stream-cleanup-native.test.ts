import { expect, it, vi } from 'vitest';
import { nativeStore } from './helpers/native-store';
import { ReaderRepository } from '../src/storage/repository';
import { DEFAULT_SETTINGS } from '../src/types';
import { streamCutoff } from '../src/stream-age';

const path = 'Reading/Stream/Old.md';
const raw = '---\ntype: article\nurl: https://example.test/old\npublished: 2020-01-01\n---\n';
const cutoff = streamCutoff(new Date('2026-03-31T12:00:00Z'));
function setup() {
  const f = nativeStore({ [path]: raw });
  const trash = vi.fn(async (file: { path: string }, system: boolean) => {
    expect(system).toBe(false);
    f.files.delete(file.path); f.disk.delete(file.path);
    f.vault.trigger('delete', file);
  });
  Object.assign(f.vault, { trash });
  return { ...f, trash, repo: new ReaderRepository(f.store, DEFAULT_SETTINGS) };
}
it('uses recoverable vault trash for disposable old Stream items', async () => {
  const f = setup();
  expect((await f.repo.cleanupStream(cutoff)).deleted).toEqual([path]);
  expect(f.trash).toHaveBeenCalledTimes(1); expect(f.disk.has(path)).toBe(false);
});
it('defers even clean open Markdown editors, without saving or discarding text', async () => {
  const f = setup(), opened = f.open(path);
  expect((await f.repo.cleanupStream(cutoff)).retained).toEqual([path]);
  expect(f.trash).not.toHaveBeenCalled(); expect(opened.view.save).not.toHaveBeenCalled();
  expect(f.disk.get(path)).toBe(raw);
});
it.each(['bytes', 'generation', 'rename', 'editor'] as const)('rejects %s changes during final trash read', async change => {
  const f = setup(); let reads = 0;
  f.hooks.beforeRead = async () => {
    if (++reads !== 2) return;
    if (change === 'bytes') f.disk.set(path, raw + 'New authored text');
    if (change === 'generation') await f.repo.articleDeleted(path);
    if (change === 'rename') {
      const file = f.files.get(path)!; f.files.delete(path); file.path = 'Reading/Inbox/Old.md'; f.files.set(file.path, file); f.disk.set(file.path, raw);
    }
    if (change === 'editor') f.open(path, raw + 'Unsaved');
  };
  expect((await f.repo.cleanupStream(cutoff)).deleted).toEqual([]);
  expect(f.trash).not.toHaveBeenCalled();
});
it('rechecks in-flight acquisition/promotion at the trash boundary', async () => {
  const f = setup(); let busy = false, reads = 0;
  f.hooks.beforeRead = () => { if (++reads === 2) busy = true; };
  expect((await f.repo.cleanupStream(cutoff, () => busy)).deleted).toEqual([]);
  expect(f.trash).not.toHaveBeenCalled();
});
it('a failing trash does not stop subsequent cleanup', async () => {
  const f = setup();
  const other = 'Reading/Stream/Other.md'; await f.vault.create(other, raw);
  f.trash.mockRejectedValueOnce(new Error('Trash unavailable'));
  const result = await f.repo.cleanupStream(cutoff);
  expect(result.retained).toEqual([path]); expect(result.deleted).toEqual([other]);
});
