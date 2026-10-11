import { afterEach, expect, it, vi } from 'vitest';
import type { Article } from '../src/types';
import type { ReaderController } from '../src/controller';
import { ReaderApp } from '../src/ui/app';
const mounts = vi.hoisted(() => [] as { path: string; disposalPath?: string; drain: Promise<void>; dispose: ReturnType<typeof vi.fn>; remap: ReturnType<typeof vi.fn>; flush: ReturnType<typeof vi.fn> }[]);
vi.mock('../src/ui/reader', () => ({ mountReader: (pane: HTMLElement, article: Article) => {
  const shell = document.createElement('div'); shell.className = 'r2-reader'; pane.replaceChildren(shell);
  const entry = { path: article.path, disposalPath: undefined as string | undefined, drain: Promise.resolve(), dispose: vi.fn(), remap: vi.fn(), flush: vi.fn() };
  entry.dispose.mockImplementation(() => { entry.disposalPath = entry.path; shell.remove(); return entry.drain; });
  entry.remap.mockImplementation((path: string) => { entry.path = path; }); entry.flush.mockImplementation(() => entry.drain); mounts.push(entry);
  return Object.assign(entry.dispose, { getPosition: () => ({ marker: 'later words' }), remapPosition: entry.remap, flushPosition: entry.flush, restorePosition: vi.fn(), update: () => true });
} }));
const cleanup: ReaderApp[] = [];
afterEach(async () => { await Promise.all(cleanup.splice(0).map(app => app.destroy())); mounts.length = 0; document.body.replaceChildren(); });
function deferred() { let resolve!: () => void; const promise = new Promise<void>(done => { resolve = done; }); return { promise, resolve }; }
async function fixture() {
  let items = [{ path: 'inbox/A.md', title: 'A', status: 'inbox', body: 'one', highlights: [] }, { path: 'archive/B.md', title: 'B', status: 'archive', body: 'two', highlights: [] }] as unknown as Article[];
  let mode = () => {};
  const repo = { articleGeneration: vi.fn((_path: string) => 0), listArticles: vi.fn(async () => items), getArticle: vi.fn(async (path: string) => items.find(item => item.path === path)!) };
  const controller = { repository: repo, subscribe: () => () => {}, scheduleAcquisition: vi.fn() };
  const root = document.createElement('div'); document.body.append(root);
  const app = new ReaderApp(root, controller as unknown as ReaderController, { autoOpen: false, openNote() {}, onEinkChange: callback => { mode = callback; return () => {}; } }); cleanup.push(app);
  await app.refresh(); await app.open(items[0].path);
  return { app, repo, mode: () => mode(), setItems: (next: Article[]) => { items = next; }, items };
}
it('public flush captures the current mount and drains retired writes without disposing or disabling persistence', async () => {
  const f = await fixture(), first = deferred(), second = deferred(); mounts[0].drain = first.promise;
  await f.app.open(f.items[1].path); mounts[1].drain = second.promise;
  let done = false; const flushed = f.app.flushPosition().then(() => { done = true; });
  expect(mounts[1].flush).toHaveBeenCalledTimes(1); expect(mounts[1].dispose).not.toHaveBeenCalled();
  first.resolve(); await Promise.resolve(); expect(done).toBe(false); second.resolve(); await flushed;
  mounts[1].drain = Promise.resolve(); await f.app.flushPosition(); expect(mounts[1].flush).toHaveBeenCalledTimes(2); expect(mounts[1].dispose).not.toHaveBeenCalled();
});
it('drains a retired mount after adjacent-empty-queue navigation followed immediately by destroy', async () => {
  const f = await fixture(), pending = deferred(); mounts[0].drain = pending.promise;
  const navigation = f.app.navigateQueue(1); let done = false; const closing = f.app.destroy().then(() => { done = true; });
  await navigation; await Promise.resolve(); expect(done).toBe(false); expect(mounts[0].dispose).toHaveBeenCalledTimes(1);
  pending.resolve(); await closing; expect(done).toBe(true);
});
it('drains every retired mount across ordinary navigation and mode toggle, not just the latest one', async () => {
  const f = await fixture(), first = deferred(), second = deferred(); mounts[0].drain = first.promise;
  await f.app.open(f.items[1].path); mounts[1].drain = second.promise; f.mode(); await vi.waitFor(() => expect(mounts).toHaveLength(3));
  let done = false; const closing = f.app.destroy().then(() => { done = true; });
  second.resolve(); await Promise.resolve(); expect(done).toBe(false); first.resolve(); await closing;
  expect(mounts.map(m => m.dispose.mock.calls.length)).toEqual([1, 1, 1]);
});
it('remaps position destination before retiring a renamed mount', async () => {
  const f = await fixture(), pending = deferred(); mounts[0].drain = pending.promise;
  const renamed = { ...f.items[0], path: 'later/A.md', status: 'later' as const }; f.setItems([renamed, f.items[1]]);
  f.app.remapPath(f.items[0].path, renamed.path); await vi.waitFor(() => expect(mounts).toHaveLength(2));
  expect(mounts[0].remap).toHaveBeenCalledWith(renamed.path); expect(mounts[0].disposalPath).toBe(renamed.path);
  const closing = f.app.destroy(); pending.resolve(); await closing;
});
it('tracks deletion-refresh retirement until shutdown drains its guard/result', async () => {
  const f = await fixture(), pending = deferred(); mounts[0].drain = pending.promise; f.setItems([]); await f.app.refresh();
  let done = false; const closing = f.app.destroy().then(() => { done = true; }); await Promise.resolve(); expect(done).toBe(false);
  pending.resolve(); await closing; expect(mounts[0].dispose).toHaveBeenCalledTimes(1);
});
