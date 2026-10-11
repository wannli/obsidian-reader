import { afterEach, expect, it, vi } from 'vitest';
import { ReaderApp } from '../src/ui/app';
import { ReaderController } from '../src/controller';
import { ReaderRepository } from '../src/storage/repository';
import { MemoryStore } from '../src/storage/memory';
import { DEFAULT_SETTINGS, type Article, type HttpGet } from '../src/types';
import type { ReadingPosition } from '../src/ui/eink-types';

// Isolate ReaderApp's mount lifecycle/anchor contract from browser geometry.
vi.mock('../src/ui/reader', () => ({ mountReader: (pane: HTMLElement, article: Article) => {
  const view = document.createElement('div'); view.className = 'r2-reader';
  const title = document.createElement('h1'); title.className = 'r2-article-title'; title.tabIndex = -1; title.textContent = article.title;
  view.append(title); pane.replaceChildren(view);
  return Object.assign(() => view.remove(), {
    getPosition: (): ReadingPosition => ({ marker: view.dataset.marker ?? '' }),
    restorePosition: (position: ReadingPosition) => { view.dataset.marker = position.marker; },
    setArticleEnd: (footer: HTMLElement) => { if (footer.parentElement !== view) view.append(footer); },
  });
} }));
const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => { for (const stop of cleanup.splice(0)) await stop(); document.body.replaceChildren(); });
async function fixture(mobile = false, populated = false) {
  const store = new MemoryStore(), settings = { ...DEFAULT_SETTINGS }, repository = new ReaderRepository(store, settings);
  const article = await repository.createArticle({ title: 'Keep my page', url: '', status: 'inbox', extractor: 'manual', body: 'Preserved article text.' });
  if (populated) await repository.createArticle({ title: 'Later article', url: '', status: 'later', extractor: 'manual', body: 'Another preserved article.' });
  const controller = new ReaderController(repository, vi.fn<HttpGet>(), settings); controller.setActive(false);
  const root = document.createElement('div'); document.body.append(root);
  let change = () => {};
  const unsubscribe = vi.fn(), notify = vi.fn();
  const reader = new ReaderApp(root, controller, {
    openNote: () => {}, autoOpen: false, notify,
    einkEnabled: () => true, isMobile: mobile,
    onEinkChange: callback => { change = callback; return unsubscribe; },
  });
  cleanup.push(async () => { await reader.destroy(); await controller.shutdown(); });
  await reader.refresh(); await reader.open(article.path);
  root.querySelector<HTMLElement>('.r2-reader')!.dataset.marker = 'saved place';
  const press = (key: string) => document.activeElement!.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }));
  return { root, reader, store, article, press, change: () => change(), unsubscribe, notify };
}
it('h/l through an empty queue retains the e-ink text anchor without changing notes', async () => {
  const f = await fixture(), before = f.store.snapshot();
  f.press('l');
  expect(f.reader.getState()).toMatchObject({ queue: 'later', file: undefined });
  expect(f.notify).toHaveBeenLastCalledWith('Queue: Later (empty).');
  f.press('h');
  await vi.waitFor(() => expect(f.reader.getState()).toMatchObject({ file: f.article.path, queue: 'inbox', readingPosition: { marker: 'saved place' } }));
  expect(f.store.snapshot()).toEqual(before);
});
for (const populated of [false, true]) it(`mobile native queue navigation retains e-ink anchors through a ${populated ? 'populated' : 'empty'} queue`, async () => {
  const f = await fixture(true, populated), before = f.store.snapshot();
  expect(f.root.querySelector('.r2-reader-toolbar')).toBeNull();
  expect(f.root.querySelector('.r2-article-end')).not.toBeNull();
  await f.reader.navigateQueue(1);
  await vi.waitFor(() => {
    expect(f.reader.getState().queue).toBe('later');
    if (populated) expect(f.reader.getArticle()?.status).toBe('later');
    else expect(f.root.textContent).toContain('No articles in Later.');
  });
  if (populated) f.root.querySelector<HTMLElement>('.r2-reader')!.dataset.marker = 'new place';
  await f.reader.navigateQueue(-1);
  await vi.waitFor(() => expect(f.reader.getState()).toMatchObject({ file: f.article.path, queue: 'inbox', readingPosition: { marker: 'saved place' } }));
  await f.reader.navigateQueue(1);
  await vi.waitFor(() => {
    if (populated) expect(f.reader.getState()).toMatchObject({ queue: 'later', readingPosition: { marker: 'new place' } });
    else expect(f.root.textContent).toContain('No articles in Later.');
  });
  expect(f.store.snapshot()).toEqual(before);
});
it('mobile queue selection and desktop shortcuts share the same e-ink anchor cache', async () => {
  const f = await fixture(), before = f.store.snapshot();
  await f.reader.navigateQueue(1);
  expect(f.root.contains(document.activeElement)).toBe(true);
  f.press('h');
  await vi.waitFor(() => expect(f.reader.getState()).toMatchObject({ queue: 'inbox', readingPosition: { marker: 'saved place' } }));
  f.press('l'); await f.reader.navigateQueue(-1);
  expect(f.reader.getState()).toMatchObject({ queue: 'inbox', readingPosition: { marker: 'saved place' } });
  expect(f.store.snapshot()).toEqual(before);
});
it('merged queue wiring retains e-ink remount subscription and disposal', async () => {
  const f = await fixture(), previous = f.root.querySelector('.r2-reader');
  f.change();
  await vi.waitFor(() => {
    expect(f.root.querySelector('.r2-reader')).not.toBeNull();
    expect(f.root.querySelector('.r2-reader')).not.toBe(previous);
    expect(f.reader.getState().readingPosition).toEqual({ marker: 'saved place' });
  });
  await f.reader.destroy(); expect(f.unsubscribe).toHaveBeenCalledTimes(1);
});
