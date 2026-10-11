import { afterEach, expect, it, vi } from 'vitest';
import { ReaderApp } from '../src/ui/app';
import type { ReaderController } from '../src/controller';
import type { Article, ArticleStatus } from '../src/types';

vi.mock('../src/ui/reader', () => ({ mountReader: (pane: HTMLElement, article: Article) => {
  const view = document.createElement('div'); view.className = 'r2-reader'; view.textContent = article.title;
  pane.replaceChildren(view); return Object.assign(() => view.remove(), { setArticleEnd: (footer: HTMLElement) => { if (footer.parentElement !== view) view.append(footer); } });
} }));
const cleanup: ReaderApp[] = [];
afterEach(() => { cleanup.splice(0).forEach(reader => reader.destroy()); document.body.replaceChildren(); vi.restoreAllMocks(); });
const makeArticle = (status: ArticleStatus, index = 1) => ({ path: `${status}/${index}.md`, title: `${status} ${index}`, status, body: 'Unchanged article text.', highlights: [] } as unknown as Article);
function deferred<T>() {
  let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done; }); return { promise, resolve };
}
async function fixture(items = ['inbox', 'later', 'feed', 'archive'].flatMap(status => [makeArticle(status as ArticleStatus), makeArticle(status as ArticleStatus, 2)])) {
  const repository = { articleGeneration: vi.fn((_path: string) => 0), listArticles: vi.fn(async () => items), getArticle: vi.fn(async (path: string) => items.find(article => article.path === path)!) };
  const controller = { repository, subscribe: () => () => {}, scheduleAcquisition: vi.fn(), move: vi.fn() };
  const root = document.createElement('div'); document.body.append(root);
  const reader = new ReaderApp(root, controller as unknown as ReaderController, { openNote: async () => {}, autoOpen: false, isMobile: true }); cleanup.push(reader);
  await reader.refresh(); await reader.open(items[0].path);
  return { reader, root, repository, controller, items };
}
it('removes the permanent five-button strip in favor of article-end controls', async () => {
  const { root, reader } = await fixture();
  expect(root.querySelector('.r2-reader-toolbar')).toBeNull();
  expect(root.querySelector('.r2-article-end')).not.toBeNull();
  for (const label of ['Previous queue', 'Previous article', 'Next queue', 'More']) expect(root.querySelector(`button[aria-label="${label}"]`)).toBeNull();
  expect(reader.canNavigateQueue(-1)).toBe(false);
});
it('browses queues both ways without wrapping, opens first article, and never moves articles', async () => {
  const { reader, controller, items } = await fixture(); const before = JSON.stringify(items);
  await reader.navigateQueue(-1); expect(reader.getState().queue).toBe('inbox');
  for (const [queue, delta] of [['later', 1], ['feed', 1], ['archive', 1], ['feed', -1], ['later', -1], ['inbox', -1]] as const) {
    await reader.navigateQueue(delta);
    expect(reader.getState()).toMatchObject({ queue, file: `${queue}/1.md` });
    expect(reader.canNavigate(-1)).toBe(false); expect(reader.canNavigate(1)).toBe(true);
    if (queue === 'archive') { expect(reader.canNavigateQueue(1)).toBe(false); await reader.navigateQueue(1); expect(reader.getState().queue).toBe('archive'); }
  }
  expect(controller.move).not.toHaveBeenCalled(); expect(JSON.stringify(items)).toBe(before);
});
it('native article navigation stays within the browsing queue', async () => {
  const { reader } = await fixture(); await reader.navigateQueue(1);
  reader.navigate(1); await vi.waitFor(() => expect(reader.getArticle()?.path).toBe('later/2.md'));
  expect(reader.canNavigate(1)).toBe(false); expect(reader.getState().queue).toBe('later');
  reader.navigate(-1); await vi.waitFor(() => expect(reader.getArticle()?.path).toBe('later/1.md'));
});
it('keeps empty queue identity and leaves queue navigation available', async () => {
  const { reader, root } = await fixture([makeArticle('inbox'), makeArticle('archive')]);
  await reader.navigateQueue(1); await reader.refresh();
  expect(reader.getState()).toMatchObject({ queue: 'later', file: undefined }); expect(reader.getArticle()).toBeUndefined();
  expect(root.textContent).toContain('No articles in Later.');
  expect(reader.canNavigate(-1)).toBe(false); expect(reader.canNavigate(1)).toBe(false);
  expect(reader.canNavigateQueue(-1)).toBe(true); expect(reader.canNavigateQueue(1)).toBe(true);
  await reader.navigateQueue(1); expect(root.textContent).toContain('No articles in Stream.');
  await reader.navigateQueue(1); expect(reader.getState().file).toBe('archive/1.md');
});
it('updates the queue synchronously for rapid taps and ignores stale list results', async () => {
  const { reader, repository, items } = await fixture(); const pending = deferred<Article[]>();
  repository.listArticles.mockImplementationOnce(() => pending.promise);
  const first = reader.navigateQueue(1); expect(reader.getState().queue).toBe('later');
  const second = reader.navigateQueue(1); expect(reader.getState().queue).toBe('feed');
  await second; pending.resolve(items); await first;
  expect(reader.getState()).toMatchObject({ queue: 'feed', file: 'feed/1.md' });
});
it('does not let a stale article load replace a newer empty queue', async () => {
  const { reader, repository, root } = await fixture([makeArticle('inbox'), makeArticle('later')]); const pending = deferred<Article>();
  repository.getArticle.mockImplementationOnce(() => pending.promise);
  const first = reader.navigateQueue(1); await vi.waitFor(() => expect(reader.getState().file).toBe('later/1.md'));
  await reader.navigateQueue(1); pending.resolve(makeArticle('later')); await first;
  expect(reader.getState()).toMatchObject({ queue: 'feed', file: undefined }); expect(reader.getArticle()).toBeUndefined();
  expect(root.textContent).toContain('No articles in Stream.');
});
it('does not let an outstanding default open overwrite an empty queue', async () => {
  const { reader, repository, items } = await fixture([makeArticle('inbox')]);
  const pending = deferred<Article[]>(); repository.listArticles.mockImplementationOnce(() => pending.promise);
  const opening = reader.openDefault(); await reader.navigateQueue(1); pending.resolve(items); await opening;
  expect(reader.getState()).toMatchObject({ queue: 'later', file: undefined });
});
it('ignores a queued list result after an explicit article open', async () => {
  const { reader, repository, items } = await fixture(); const pending = deferred<Article[]>();
  repository.listArticles.mockImplementationOnce(() => pending.promise);
  const switching = reader.navigateQueue(1); await reader.open('archive/2.md'); pending.resolve(items); await switching;
  expect(reader.getState()).toMatchObject({ queue: 'archive', file: 'archive/2.md' });
});
it('shows list failures without losing queue identity or disabling further queue browsing', async () => {
  const { reader, repository, root } = await fixture(); repository.listArticles.mockRejectedValueOnce(new Error('Cannot read queues'));
  await reader.navigateQueue(1); expect(root.textContent).toContain('Cannot read queues');
  expect(reader.getState()).toMatchObject({ queue: 'later', file: undefined }); expect(reader.canNavigateQueue(1)).toBe(true);
  await reader.navigateQueue(1); expect(reader.getState().file).toBe('feed/1.md');
});

it('ignores stale list failures after newer navigation and results after disposal', async () => {
  const { reader, repository, root, items } = await fixture();
  let reject!: (error: Error) => void;
  repository.listArticles.mockImplementationOnce(() => new Promise((_, fail) => { reject = fail; }));
  const first = reader.navigateQueue(1); await reader.navigateQueue(1);
  reject(new Error('Old failure')); await first;
  expect(reader.getState()).toMatchObject({ queue: 'feed', file: 'feed/1.md' });
  expect(root.textContent).not.toContain('Old failure');
  const pending = deferred<Article[]>(); repository.listArticles.mockImplementationOnce(() => pending.promise);
  const last = reader.navigateQueue(1); reader.destroy(); pending.resolve(items); await last;
  expect(root.childElementCount).toBe(0); expect(reader.getArticle()).toBeUndefined();
});
it('native queue navigation during position flush invalidates advancement, not the already-requested move', async () => {
  const { reader, controller, items } = await fixture();
  const pending = deferred<Article>(); controller.move.mockImplementation(() => pending.promise);
  const moving = reader.move('later'); await reader.navigateQueue(1); await reader.navigateQueue(1);
  pending.resolve({ ...items[0], path: 'later/moved.md', status: 'later' }); await moving;
  expect(controller.move).toHaveBeenCalledTimes(1);
  expect(reader.getState()).toMatchObject({ queue: 'feed', file: 'feed/1.md' });
});
it('rejects invalid queue deltas without loading or changing the selection', async () => {
  const { reader, repository } = await fixture(); repository.listArticles.mockClear();
  for (const delta of [0, 2, -2, NaN]) { expect(reader.canNavigateQueue(delta)).toBe(false); await reader.navigateQueue(delta); }
  expect(repository.listArticles).not.toHaveBeenCalled();
  expect(reader.getState()).toMatchObject({ queue: 'inbox', file: 'inbox/1.md' });
});

it('keeps an explicitly typed nonqueue article readable with no runtime queue or same-queue controls', async () => {
  const path = 'Elsewhere/Legacy.md', article = { ...makeArticle('inbox'), path, status: undefined } as unknown as Article;
  const repository = { articleGeneration: vi.fn((_path: string) => 0), listArticles: vi.fn(async () => []), getArticle: vi.fn(async () => article) };
  const controller = { repository, subscribe: () => () => {}, scheduleAcquisition: vi.fn(), move: vi.fn() };
  const root = document.createElement('div'); document.body.append(root);
  const reader = new ReaderApp(root, controller as unknown as ReaderController, { openNote: async () => {}, autoOpen: false, isMobile: true }); cleanup.push(reader);
  await reader.open(path);
  expect(reader.getArticle()).toMatchObject({ path, status: undefined });
  expect(reader.getState()).toMatchObject({ file: path }); expect(reader.getState().queue).toBeUndefined();
  expect(reader.canNavigate(-1)).toBe(false); expect(reader.canNavigate(1)).toBe(false);
  expect(reader.canNavigateQueue(-1)).toBe(false); expect(reader.canNavigateQueue(1)).toBe(false);
  expect(root.querySelector('.r2-article-end')).toBeNull();
  await reader.refresh(); expect(reader.getArticle()?.path).toBe(path); expect(root.textContent).toContain(article.title);
});
