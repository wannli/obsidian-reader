import { afterEach, expect, it, vi } from 'vitest';
import type { Article } from '../src/types';
import type { ReadingPosition } from '../src/ui/eink-types';
import type { ReaderController } from '../src/controller';
import { mountReader, type ReaderMount } from '../src/ui/reader';
const tracking = vi.hoisted(() => ({ position: { marker: '' } as ReadingPosition }));
vi.mock('../src/ui/scroll-position', () => ({ trackScrollPosition: () => ({ getPosition: () => tracking.position, restorePosition: (position: ReadingPosition) => { tracking.position = position; }, dispose: vi.fn() }) }));
const cleanup: ReaderMount[] = [];
afterEach(async () => { await Promise.all(cleanup.splice(0).map(stop => stop())); document.getSelection()?.removeAllRanges(); document.body.replaceChildren(); vi.useRealTimers(); });
function fixture() {
  tracking.position = { marker: '' }; vi.useFakeTimers();
  const article: Article = { path: 'Reading/Inbox/A.md', title: 'A', url: '', status: 'inbox', body: 'one two three', highlights: [], content: 'ready', extractor: 'manual' };
  const generations = new Map([[article.path, 0]]), saveReadingPosition = vi.fn(async (_path: string, _position: ReadingPosition, _generation: number) => {}), notify = vi.fn();
  const controller = { repository: { articleGeneration: (path: string) => generations.get(path) ?? 0, saveReadingPosition },
    highlight: vi.fn(async () => ({ ...article, body: '==one== two three' })) };
  const root = document.createElement('div'); document.body.append(root);
  const mount = mountReader(root, article, controller as unknown as ReaderController, { openNote() {}, notify }, () => {}); cleanup.push(mount);
  const select = () => { const body = root.querySelector('.r2-article-body')!, range = document.createRange(); range.setStart(body.querySelector('p')!.firstChild!, 0); range.setEnd(body.querySelector('p')!.firstChild!, 3); document.getSelection()!.addRange(range); };
  return { mount, root, article, saveReadingPosition, generations, notify, select, controller };
}
it('retains queued samples through its own canonical-text-preserving highlight save', async () => {
  const f = fixture(); let release!: () => void;
  f.saveReadingPosition.mockImplementationOnce(async () => { await new Promise<void>(done => { release = done; }); });
  tracking.position = { marker: 'two' }; const first = f.mount.flushPosition!(); await Promise.resolve();
  tracking.position = { marker: 'three' }; const queued = f.mount.flushPosition!();
  f.select(); document.dispatchEvent(new Event('selectionchange'));
  try {
    await vi.advanceTimersByTimeAsync(1000); expect(f.controller.highlight).toHaveBeenCalledTimes(1);
    expect(f.root.querySelector('.r2-save-state')?.textContent).toBe('Saved');
  } finally { release(); await Promise.all([first, queued]); }
  expect(f.saveReadingPosition).toHaveBeenCalledTimes(2);
  expect(f.saveReadingPosition).toHaveBeenLastCalledWith(f.article.path, { marker: 'three' }, 0);
});
it('remaps the position writer before disposal while leaving annotation identity immutable', async () => {
  const f = fixture(); tracking.position = { marker: 'two' }; f.generations.set(f.article.path, 1);
  f.mount.remapPosition!('Reading/Later/A.md'); await f.mount();
  expect(f.saveReadingPosition).toHaveBeenCalledWith('Reading/Later/A.md', { marker: 'two' }, 0);
});
it('queues the latest anchor to the renamed destination after an already dispatched old-path write fails', async () => {
  const f = fixture(); let release!: () => void;
  f.saveReadingPosition.mockImplementationOnce(async () => { await new Promise<void>(done => { release = done; }); throw new Error('Stale old path'); });
  tracking.position = { marker: 'two' }; const first = f.mount.flushPosition!(); await Promise.resolve();
  f.generations.set(f.article.path, 1); f.mount.remapPosition!('Reading/Later/A.md'); const draining = f.mount(); release();
  await Promise.all([first, draining]);
  expect(f.saveReadingPosition.mock.calls.map(args => args[0])).toEqual([f.article.path, 'Reading/Later/A.md']);
  expect(f.saveReadingPosition).toHaveBeenLastCalledWith('Reading/Later/A.md', { marker: 'two' }, 0);
});
it('does not dispatch an old-path position write after native deletion/generation invalidation', async () => {
  const f = fixture(); tracking.position = { marker: 'two' }; f.generations.set(f.article.path, 1); await f.mount();
  expect(f.saveReadingPosition).not.toHaveBeenCalled(); expect(f.notify).toHaveBeenCalledWith(expect.stringContaining('Article changed'));
});
it.each(['different words', '**one** two three'])('does not persist from externally stale selected DOM: %s', async body => {
  const f = fixture(); f.select(); tracking.position = { marker: 'two' };
  f.mount.update!({ ...f.article, body }); await f.mount.flushPosition!(); await f.mount();
  expect(f.saveReadingPosition).not.toHaveBeenCalled();
});
it('drops a captured but not yet dispatched position when external editing invalidates selected DOM', async () => {
  const f = fixture(); f.select(); tracking.position = { marker: 'two' };
  const write = f.mount.flushPosition!(); f.mount.update!({ ...f.article, body: '**one** two three' }); await write;
  expect(f.saveReadingPosition).not.toHaveBeenCalled();
});
it('returns the terminal serialized write from repeated disposal without recapturing a detached view', async () => {
  const f = fixture(); let release!: () => void;
  f.saveReadingPosition.mockImplementation(async () => { await new Promise<void>(done => { release = done; }); });
  tracking.position = { marker: 'two' }; const first = f.mount(); await Promise.resolve();
  tracking.position = { marker: 'later words' }; expect(f.mount()).toBe(first); expect(f.mount.flushPosition!()).toBe(first);
  release(); await first; expect(f.saveReadingPosition).toHaveBeenCalledTimes(1);
});
