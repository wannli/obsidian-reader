import { afterEach, expect, it, vi } from 'vitest';
import { ReaderApp } from '../src/ui/app';
import { ReaderController } from '../src/controller';
import { ReaderRepository } from '../src/storage/repository';
import { MemoryStore } from '../src/storage/memory';
import { DEFAULT_SETTINGS, type Article, type ArticleStatus, type HttpGet } from '../src/types';
import { queueFolder, queueLabel } from '../src/reading-layout';

vi.mock('../src/ui/reader', () => ({ mountReader: (pane: HTMLElement, article: Article) => {
  const view = document.createElement('div'); view.className = 'r2-reader';
  const scroll = document.createElement('div'); scroll.className = 'r2-reader-scroll';
  const title = document.createElement('h1'); title.className = 'r2-article-title'; title.tabIndex = -1; title.textContent = article.title;
  scroll.append(title); view.append(scroll); pane.replaceChildren(view); return () => view.remove();
} }));
const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => { for (const stop of cleanup.splice(0)) await stop(); vi.restoreAllMocks(); document.body.replaceChildren(); });
const queues: ArticleStatus[] = ['inbox', 'later', 'feed', 'archive'];
function press(key: string, shifted = false) {
  const event = new KeyboardEvent('keydown', { key: shifted ? key.toUpperCase() : key, shiftKey: shifted, bubbles: true, cancelable: true });
  (document.activeElement ?? document).dispatchEvent(event); return event;
}
async function fixture(statuses: ArticleStatus[] = queues) {
  const store = new MemoryStore(), settings = { ...DEFAULT_SETTINGS }, repo = new ReaderRepository(store, settings);
  for (const [index, status] of statuses.entries()) await repo.createArticle({ title: 'Article ' + index, url: 'https://example.org/article/' + index, status, extractor: 'manual', body: 'Preserved source text. Another quote.' });
  const controller = new ReaderController(repo, vi.fn<HttpGet>(), settings); controller.setActive(false);
  const root = document.createElement('div'); document.body.append(root);
  const notify = vi.fn(), onStateChange = vi.fn();
  // Omit shouldFocus to exercise the Reader-local focus fallback, including empty queues.
  const reader = new ReaderApp(root, controller, { openNote: () => {}, autoOpen: false, notify, onStateChange });
  cleanup.push(async () => { reader.destroy(); await controller.shutdown(); });
  await reader.refresh(); const articles = await repo.listArticles(); if (articles[0]) await reader.open(articles[0].path);
  return { store, repo, controller, reader, root, notify, onStateChange, articles };
}
it('h/l switch queues in picker order without wrapping or writing notes; j/k stay within the queue', async () => {
  const f = await fixture(['inbox', 'later', 'later', 'feed', 'archive']);
  await f.reader.open(f.articles.find(article => article.status === 'inbox')!.path);
  const before = f.store.snapshot();
  expect(press('h').defaultPrevented).toBe(true); expect(f.notify).toHaveBeenLastCalledWith('Already at the first queue: Inbox.');
  for (const queue of queues.slice(1)) {
    press('l'); await vi.waitFor(() => expect(f.reader.getArticle()?.status).toBe(queue));
    expect(f.reader.getState().queue).toBe(queue); expect(f.notify).toHaveBeenLastCalledWith('Queue: ' + queueLabel(queue) + '.');
  }
  press('l'); expect(f.notify).toHaveBeenLastCalledWith('Already at the last queue: Treasury.');
  for (const queue of ['feed', 'later'] as ArticleStatus[]) { press('h'); await vi.waitFor(() => expect(f.reader.getArticle()?.status).toBe(queue)); }
  const later = f.articles.filter(article => article.status === 'later');
  expect(f.reader.getState().file).toBe(later[0].path);
  press('j'); await vi.waitFor(() => expect(f.reader.getArticle()?.path).toBe(later[1].path));
  press('k'); await vi.waitFor(() => expect(f.reader.getArticle()?.path).toBe(later[0].path));
  expect(f.store.snapshot()).toEqual(before);
});
it('empty queues stay selected and focused, notify, and allow navigation onward', async () => {
  const f = await fixture(['inbox', 'feed']); await f.reader.open(f.articles.find(article => article.status === 'inbox')!.path);
  const before = f.store.snapshot(); press('l');
  expect(f.reader.getState()).toMatchObject({ queue: 'later', file: undefined });
  expect(f.root.textContent).toContain('No articles in Later.'); expect(f.root.contains(document.activeElement)).toBe(true);
  expect(f.notify).toHaveBeenLastCalledWith('Queue: Later (empty).');
  press('l', true); expect(f.notify).toHaveBeenLastCalledWith('No article to move.');
  expect(press('j').defaultPrevented).toBe(false);
  press('l'); await vi.waitFor(() => expect(f.reader.getArticle()?.status).toBe('feed'));
  expect(f.store.snapshot()).toEqual(before);
});
for (const [origin, destination, key] of [
  ['inbox', 'later', 'l'], ['later', 'feed', 'l'], ['feed', 'archive', 'l'],
  ['archive', 'feed', 'h'], ['feed', 'later', 'h'], ['later', 'inbox', 'h'],
] as const) it(`Shift+${key} moves ${origin} → ${destination}, preserves highlights/backlinks, and advances within the origin`, async () => {
  const f = await fixture([origin, origin]), selected = f.articles[0], next = f.articles[1];
  await f.store.create('Daily/test.md', 'Existing user-owned journal text.');
  // Seed existing Markdown annotations: creating new ones now promotes Stream.
  await f.store.process(selected.path, raw => raw.replace('Preserved source text. Another quote.', '==Preserved source text.== ==Another quote.=='));
  await f.reader.refresh(); await f.reader.open(selected.path);
  const before = await f.repo.getArticle(selected.path), daily = await f.store.read('Daily/test.md');
  expect(press(key, true).defaultPrevented).toBe(true);
  await vi.waitFor(() => expect(f.notify).toHaveBeenLastCalledWith('Moved to ' + queueLabel(destination) + '.'));
  const path = queueFolder(destination) + '/' + selected.path.split('/').at(-1), saved = await f.repo.getArticle(path);
  expect(await f.store.exists(selected.path)).toBe(false); expect(saved.body).toBe(before.body);
  expect(saved.highlights.map(({ id, quote }) => ({ id, quote }))).toEqual(before.highlights.map(({ id, quote }) => ({ id, quote })));
  expect(await f.store.read('Daily/test.md')).toBe(daily);
  expect(f.reader.getState()).toMatchObject({ file: next.path, queue: origin });
});
it('moving the last article leaves an empty origin queue that h/l can leave', async () => {
  const f = await fixture(['inbox']); press('l', true);
  await vi.waitFor(() => expect(f.notify).toHaveBeenLastCalledWith('Moved to Later.'));
  expect(f.reader.getState()).toMatchObject({ file: undefined, queue: 'inbox' });
  expect(f.root.contains(document.activeElement)).toBe(true);
  press('l'); await vi.waitFor(() => expect(f.reader.getArticle()?.status).toBe('later'));
});
it('shifted boundary keys never wrap or mutate notes', async () => {
  const f = await fixture(['inbox', 'archive']), before = f.store.snapshot();
  for (const [queue, key] of [['inbox', 'h'], ['archive', 'l']] as const) {
    await f.reader.open(f.articles.find(article => article.status === queue)!.path); press(key, true);
    expect(f.notify).toHaveBeenLastCalledWith('Already at the ' + (key === 'h' ? 'first' : 'last') + ' queue: ' + queueLabel(queue) + '.');
  }
  expect(f.store.snapshot()).toEqual(before);
});
it('failed moves keep the article and queue, show an error, and never claim success', async () => {
  const f = await fixture(['inbox']), before = f.store.snapshot();
  vi.spyOn(f.controller, 'move').mockRejectedValue(new Error('Write refused'));
  press('l', true); await vi.waitFor(() => expect(f.notify).toHaveBeenLastCalledWith('Write refused'));
  expect(f.reader.getState()).toMatchObject({ file: f.articles[0].path, queue: 'inbox' });
  expect(f.store.snapshot()).toEqual(before); expect(f.notify).toHaveBeenCalledTimes(1);
});
it('rapid queue switches ignore a stale article load', async () => {
  const f = await fixture(); await f.reader.open(f.articles.find(article => article.status === 'inbox')!.path);
  const later = f.articles.find(article => article.status === 'later')!;
  const original = f.repo.getArticle.bind(f.repo); let finish!: (article: Article) => void;
  vi.spyOn(f.repo, 'getArticle').mockImplementation(path => path === later.path ? new Promise(resolve => { finish = resolve; }) : original(path));
  press('l');
  // Native hosts retain active-leaf identity while a load temporarily removes focus.
  document.querySelector<HTMLElement>('.r2-content')!.tabIndex = -1; document.querySelector<HTMLElement>('.r2-content')!.focus();
  press('l'); await vi.waitFor(() => expect(f.reader.getArticle()?.status).toBe('feed'));
  finish(later); await Promise.resolve(); expect(f.reader.getState().queue).toBe('feed'); expect(f.reader.getArticle()?.status).toBe('feed');
});
it('a pending move is not repeated and does not take over a later queue selection', async () => {
  const f = await fixture(['inbox', 'feed']); await f.reader.open(f.articles.find(article => article.status === 'inbox')!.path);
  const original = f.controller.move.bind(f.controller); let finish!: () => void;
  const gate = new Promise<void>(resolve => { finish = resolve; });
  const move = vi.spyOn(f.controller, 'move').mockImplementation(async (path, status) => { await gate; return original(path, status); });
  press('l', true); press('l', true); await vi.waitFor(() => expect(move).toHaveBeenCalledTimes(1));
  expect(f.notify).toHaveBeenLastCalledWith('An article move is already in progress.');
  press('l'); press('l'); await vi.waitFor(() => expect(f.reader.getArticle()?.status).toBe('feed'));
  finish(); await vi.waitFor(() => expect(f.notify).toHaveBeenLastCalledWith('Moved to Later.'));
  expect(f.reader.getState().queue).toBe('feed'); expect(f.reader.getArticle()?.status).toBe('feed');
});
