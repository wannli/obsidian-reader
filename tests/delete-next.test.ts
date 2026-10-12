import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { nativeStore } from './helpers/native-store';
import { nativeDeleteHandler } from '../src/native-delete';
import { queued } from '../src/storage/safety';
import { ReaderApp } from '../src/ui/app';
import { ReaderController } from '../src/controller';
import { ReaderRepository } from '../src/storage/repository';
import { MemoryStore } from '../src/storage/memory';
import { DEFAULT_SETTINGS, type Article } from '../src/types';

const mount = vi.hoisted(() => ({ canLeave: vi.fn(() => true), flush: vi.fn(async () => {}) }));
vi.mock('../src/ui/reader', () => ({ mountReader: (pane: HTMLElement, article: Article) => {
  const view = document.createElement('article'); view.className = 'r2-reader'; view.textContent = article.body; pane.replaceChildren(view);
  return Object.assign(() => view.remove(), { canLeave: mount.canLeave, flushPosition: mount.flush,
    setArticleEnd: (footer: HTMLElement) => view.append(footer) });
} }));
const cleanup: (() => Promise<void>)[] = [];
beforeEach(() => { mount.canLeave.mockReturnValue(true); mount.flush.mockReset().mockResolvedValue(); });
afterEach(async () => { for (const stop of cleanup.splice(0)) await stop(); document.body.replaceChildren(); vi.restoreAllMocks(); });
function deferred() { let resolve!: () => void; const promise = new Promise<void>(done => { resolve = done; }); return { promise, resolve }; }
async function fixture(mobile = false, eink = false, count = 2) {
  const store = new MemoryStore(), repo = new ReaderRepository(store, { ...DEFAULT_SETTINGS });
  const articles: Article[] = [];
  for (let i = 0; i < count; i++) articles.push(await repo.createArticle({ title: `Article ${i}`, body: `Authored text ${i}`, url: '', status: 'inbox', extractor: 'manual' }));
  const controller = new ReaderController(repo, vi.fn(), { ...DEFAULT_SETTINGS }); controller.setActive(false);
  const root = document.createElement('div'); document.body.append(root);
  const pickArticle = vi.fn();
  const reader = new ReaderApp(root, controller, { openNote() {}, autoOpen: false, isMobile: mobile, einkEnabled: () => eink, shouldFocus: () => true, pickArticle });
  cleanup.push(async () => { await reader.destroy(); await controller.shutdown(); });
  await reader.refresh(); await reader.open(articles[0].path);
  const button = () => root.querySelector<HTMLButtonElement>('.r2-article-end-delete')!;
  return { store, repo, articles, reader, root, button, pickArticle, controller };
}
it.each([[false, false], [true, false], [true, true]])('trashes then advances (mobile %s, eink %s)', async (mobile, eink) => {
  const f = await fixture(mobile, eink), gate = deferred(), original = f.store.trash.bind(f.store);
  const trash = vi.spyOn(f.store, 'trash').mockImplementation(async (...args) => { await gate.promise; await original(...args); });
  expect(f.button().previousElementSibling?.textContent).toBe('Archive & next');
  f.button().click(); await vi.waitFor(() => expect(trash).toHaveBeenCalledOnce());
  expect(f.reader.getArticle()?.path).toBe(f.articles[0].path); expect(f.button().disabled).toBe(true);
  gate.resolve(); await vi.waitFor(() => expect(f.reader.getArticle()?.path).toBe(f.articles[1].path));
  expect(await f.store.exists(f.articles[0].path)).toBe(false);
});
it('keeps a failed deletion visible and current, with a retryable error', async () => {
  const f = await fixture(); vi.spyOn(f.store, 'trash').mockRejectedValue(new Error('Trash unavailable'));
  f.button().click(); await vi.waitFor(() => expect(f.root.textContent).toContain('Trash unavailable'));
  expect(f.reader.getArticle()?.path).toBe(f.articles[0].path); expect(f.root.textContent).toContain('Authored text 0');
  expect(f.button().disabled).toBe(false); expect(f.pickArticle).not.toHaveBeenCalled();
});
it('does not delete with unfinished annotations', async () => {
  const f = await fixture(), trash = vi.spyOn(f.store, 'trash'); mount.canLeave.mockReturnValue(false);
  f.button().click(); await vi.waitFor(() => expect(f.root.textContent).toContain('annotation is unfinished'));
  expect(trash).not.toHaveBeenCalled();
});
it('invalidates deletion intent when navigation occurs during position flush', async () => {
  const f = await fixture(), gate = deferred(), trash = vi.spyOn(f.store, 'trash'); mount.flush.mockImplementationOnce(() => gate.promise);
  f.button().click(); await vi.waitFor(() => expect(f.button().disabled).toBe(true));
  await f.reader.open(f.articles[1].path); gate.resolve();
  await vi.waitFor(() => expect(f.button().disabled).toBe(false)); expect(trash).not.toHaveBeenCalled();
});
it('returns to the list after successfully trashing the last article', async () => {
  const f = await fixture(true, true, 1); expect(f.button().textContent).toBe('Delete & return to list');
  f.button().click(); await vi.waitFor(() => expect(f.pickArticle).toHaveBeenCalledOnce());
  expect(f.reader.getArticle()).toBeUndefined(); expect(await f.store.exists(f.articles[0].path)).toBe(false);
});
it('skips a deleted/recreated next path rather than opening its replacement', async () => {
  const f = await fixture(false, false, 3), gate = deferred(), entered = deferred(), original = f.store.trash.bind(f.store);
  vi.spyOn(f.store, 'trash').mockImplementationOnce(async (...args) => { await original(...args); entered.resolve(); await gate.promise; });
  f.button().click(); await entered.promise;
  const next = f.articles[1].path, raw = await f.store.read(next);
  await original(next, { expectedContent: raw }); await f.repo.articleDeleted(next); await f.store.create(next, raw);
  gate.resolve(); await vi.waitFor(() => expect(f.reader.getArticle()?.path).toBe(f.articles[2].path));
});
it('rechecks navigation at the trash adapter dispatch boundary', async () => {
  const f = await fixture(), gate = deferred(), entered = deferred(), original = f.store.trash.bind(f.store);
  vi.spyOn(f.store, 'trash').mockImplementationOnce(async (...args) => { entered.resolve(); await gate.promise; await original(...args); });
  f.button().click(); await entered.promise;
  await f.reader.open(f.articles[1].path); gate.resolve();
  await vi.waitFor(() => expect(f.button().disabled).toBe(false));
  expect(await f.store.exists(f.articles[0].path)).toBe(true); expect(f.reader.getArticle()?.path).toBe(f.articles[1].path);
});
it('refuses same-path edits made while deletion waits in the write queue', async () => {
  const f = await fixture(), gate = deferred(), entered = deferred(), trash = vi.spyOn(f.store, 'trash');
  const pending = queued(f.store, async () => { entered.resolve(); await gate.promise; }); await entered.promise;
  f.button().click(); await vi.waitFor(() => expect(f.button().disabled).toBe(true));
  await f.store.process(f.articles[0].path, raw => raw + '\nNew authored text'); gate.resolve(); await pending;
  await vi.waitFor(() => expect(f.button().disabled).toBe(false));
  expect(trash).not.toHaveBeenCalled(); expect(f.reader.getArticle()?.path).toBe(f.articles[0].path);
  expect(await f.store.read(f.articles[0].path)).toContain('New authored text');
});
it('native delete event before trash resolves preserves the mount then advances', async () => {
  const path = 'Reading/Inbox/First.md', next = 'Reading/Inbox/Second.md';
  const raw = '---\ntype: article\n---\nAuthored body';
  const f = nativeStore({ [path]: raw, [next]: raw }), repo = new ReaderRepository(f.store, { ...DEFAULT_SETTINGS });
  const controller = new ReaderController(repo, vi.fn(), { ...DEFAULT_SETTINGS }); controller.setActive(false);
  const root = document.createElement('div'); document.body.append(root);
  const reader = new ReaderApp(root, controller, { openNote() {}, autoOpen: false, isMobile: true, shouldFocus: () => true });
  cleanup.push(async () => { await reader.destroy(); await controller.shutdown(); });
  const gate = deferred(), event = deferred(), report = vi.fn();
  f.vault.on('delete', nativeDeleteHandler(controller, () => { void reader.refresh(); event.resolve(); }, report, () => false));
  const trash = vi.fn(async (file: { path: string }, system: boolean) => {
    expect(system).toBe(false); f.files.delete(file.path); f.disk.delete(file.path); f.vault.trigger('delete', file); await gate.promise;
  });
  Object.assign(f.vault, { trash });
  await reader.refresh(); await reader.open(path);
  root.querySelector<HTMLButtonElement>('.r2-article-end-delete')!.click(); await event.promise; await reader.refresh();
  expect(reader.getArticle()?.path).toBe(path); expect(root.textContent).toContain('Authored body');
  gate.resolve(); await vi.waitFor(() => expect(reader.getArticle()?.path).toBe(next));
  expect(trash).toHaveBeenCalledOnce(); expect(report).not.toHaveBeenCalled();
});
it('repository refuses a stale generation without touching trash', async () => {
  const f = await fixture(), path = f.articles[0].path, generation = f.repo.articleGeneration(path), trash = vi.spyOn(f.store, 'trash');
  await f.repo.articleDeleted(path);
  await expect(f.repo.trashArticle(path, generation, await f.store.read(path), () => {})).rejects.toThrow(); expect(trash).not.toHaveBeenCalled();
});
