import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { ReaderApp } from '../src/ui/app';
import { ReaderController } from '../src/controller';
import { ReaderRepository } from '../src/storage/repository';
import { MemoryStore } from '../src/storage/memory';
import { DEFAULT_SETTINGS, type Article, type ArticleStatus, type HttpGet } from '../src/types';
import { queueFolder, queueLabel } from '../src/reading-layout';
import { mark } from './markdown-helpers';
import { parseNote } from '../src/storage/markdown';
import { readFileSync } from 'node:fs';
import ts from 'typescript';
import { validateHighlightTypes } from '../src/typed-highlights';
import { validReadingPosition as readingPosition } from '../src/reading-position';
import { nativeDeleteHandler } from '../src/native-delete';
import * as einkDevice from '../src/eink-device';

const mount = vi.hoisted(() => ({ rendered: vi.fn(), flush: vi.fn(async () => {}), canLeave: vi.fn(() => true), navigationBusy: vi.fn(), update: vi.fn((_article: Article) => false) }));
// Exercise the actual completion component, attached after the body inside the page.
vi.mock('../src/ui/reader', () => ({ mountReader: (pane: HTMLElement, article: Article) => {
  mount.rendered(article.path);
  const view = document.createElement('div'); view.className = 'r2-reader';
  view.dataset.articlePath = article.path; view.dataset.navigationBusy = 'false';
  const scroll = document.createElement('div'); scroll.className = 'r2-reader-scroll';
  const page = document.createElement('article'); page.className = 'r2-reading-page';
  const title = document.createElement('h1'); title.className = 'r2-article-title'; title.tabIndex = -1; title.textContent = article.title;
  const body = document.createElement('div'); body.className = 'r2-article-body'; body.textContent = article.body;
  page.append(title, body); scroll.append(page); view.append(scroll); pane.replaceChildren(view);
  return Object.assign(() => view.remove(), {
    flushPosition: mount.flush, canLeave: mount.canLeave, update: mount.update,
    // App contract only: the real mount separately tests inert/selection behavior.
    setNavigationBusy: (busy: boolean) => { view.dataset.navigationBusy = String(busy); mount.navigationBusy(article.path, busy, view); },
    setArticleEnd: (footer: HTMLElement) => { if (footer.parentElement !== page) page.append(footer); },
  });
} }));
const cleanup: (() => Promise<void>)[] = [];
beforeEach(() => { mount.rendered.mockClear(); mount.navigationBusy.mockClear(); mount.flush.mockReset().mockResolvedValue(); mount.canLeave.mockReturnValue(true); mount.update.mockReset().mockReturnValue(false); });
afterEach(async () => {
  for (const stop of cleanup.splice(0)) await stop();
  document.getSelection()?.removeAllRanges(); document.body.replaceChildren(); vi.restoreAllMocks();
});
function deferred<T>() {
  let resolve!: (value: T) => void, reject!: (error: Error) => void;
  const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
}
async function fixture(statuses: ArticleStatus[] = ['inbox', 'inbox', 'later', 'feed', 'archive'], mobile = true, eink = false) {
  const store = new MemoryStore(), settings = { ...DEFAULT_SETTINGS }, repo = new ReaderRepository(store, settings);
  const articles: Article[] = [];
  for (const [index, status] of statuses.entries()) articles.push(await repo.createArticle({ title: `Article ${index}`, url: '', status, extractor: 'manual', body: 'Preserved article text. Another quote.' }));
  const controller = new ReaderController(repo, vi.fn<HttpGet>(), settings); controller.setActive(false);
  const root = document.createElement('div'); document.body.append(root);
  const notify = vi.fn(), pickArticle = vi.fn(), openMarkdown = vi.fn(async () => {}), stopActive = vi.fn();
  let active = true, activeChanged = () => {};
  const reader = new ReaderApp(root, controller, {
    openNote: () => {}, autoOpen: false, isMobile: mobile,
    einkEnabled: () => eink, notify, pickArticle, openMarkdown, shouldFocus: () => active,
    onActiveChange: callback => { activeChanged = callback; return stopActive; },
  });
  cleanup.push(async () => { await reader.destroy(); await controller.shutdown(); });
  await reader.refresh(); await reader.open(articles[0].path);
  const button = (text: string) => {
    const found = [...root.querySelectorAll<HTMLButtonElement>('.r2-article-end button')].find(control => !control.hidden && control.textContent === text);
    expect(found, text).toBeDefined(); return found!;
  };
  return { reader, root, store, repo, controller, articles, notify, pickArticle, openMarkdown, button, stopActive,
    setActive: (value: boolean) => { active = value; activeChanged(); } };
}
async function pauseMove(f: Awaited<ReturnType<typeof fixture>>) {
  const gate = deferred<void>(), original = f.controller.move.bind(f.controller);
  const move = vi.spyOn(f.controller, 'move').mockImplementation(async (path, status) => { await gate.promise; return original(path, status); });
  f.button(f.reader.canNavigate(1) ? 'Archive & next' : 'Archive & return to list').click();
  await vi.waitFor(() => expect(move).toHaveBeenCalledTimes(1));
  return { gate, move };
}

it.each(['inbox', 'later', 'feed'] as const)('archives from %s and advances only within the origin queue', async queue => {
  const f = await fixture([queue, 'archive', queue, 'inbox']);
  expect(f.root.querySelector('.r2-reader-toolbar')).toBeNull();
  const footer = f.root.querySelector('.r2-article-end')!;
  expect(footer.parentElement?.className).toBe('r2-reading-page');
  expect(footer.previousElementSibling?.className).toBe('r2-article-body');
  expect(footer.textContent).toContain('Up next in ' + queueLabel(queue));
  expect(footer.textContent).toContain(f.articles[2].title);
  f.button('Archive & next').click();
  await vi.waitFor(() => expect(f.reader.getArticle()?.path).toBe(f.articles[2].path));
  expect(f.reader.getState().queue).toBe(queue); expect(f.pickArticle).not.toHaveBeenCalled();
  const moved = (await f.repo.listArticles()).find(article => article.path === queueFolder('archive') + '/' + f.articles[0].path.split('/').at(-1))!;
  expect(moved.status).toBe('archive'); expect(moved.body).toBe(f.articles[0].body);
});

it('next without archiving and back to the native list never mutate notes', async () => {
  const f = await fixture(), before = f.store.snapshot();
  f.button('Next without archiving').click();
  await vi.waitFor(() => expect(f.reader.getArticle()?.path).toBe(f.articles[1].path));
  expect(f.root.querySelector('.r2-article-end-next')?.hasAttribute('hidden')).toBe(true);
  f.button('Back to reading list').click();
  await vi.waitFor(() => expect(f.pickArticle).toHaveBeenCalledTimes(1));
  expect(f.pickArticle.mock.calls[0][0].map((article: Article) => article.path)).toEqual(f.articles.slice(0, 2).map(article => article.path));
  expect(f.pickArticle.mock.calls[0][1]).toBe('inbox');
  expect(f.reader.getState()).toMatchObject({ file: f.articles[1].path, queue: 'inbox' });
  expect(f.store.snapshot()).toEqual(before);
});

it('Treasury offers Next article and no Archive, using the currently visible article after each mount', async () => {
  const f = await fixture(['archive', 'archive', 'archive', 'inbox']), before = f.store.snapshot();
  const footer = f.root.querySelector('.r2-article-end');
  expect(f.root.querySelector<HTMLButtonElement>('.r2-article-end-primary:not([hidden])')?.textContent).toBe('Next article');
  expect([...f.root.querySelectorAll<HTMLButtonElement>('.r2-article-end button')].filter(button => !button.hidden).map(button => button.textContent)).toEqual(['Next article', 'Back to reading list']);
  for (const next of f.articles.slice(1, 3)) {
    f.button('Next article').click(); await vi.waitFor(() => expect(f.reader.getArticle()?.path).toBe(next.path));
    expect(f.reader.getState().queue).toBe('archive'); expect(f.root.querySelector('.r2-article-end')).toBe(footer);
  }
  expect(f.reader.canNavigate(1)).toBe(false); expect(f.store.snapshot()).toEqual(before);
});

it.each(['inbox', 'later', 'feed'] as const)('last footer archive in %s ends the queue without backwards fallback, then opens its native list', async queue => {
  const f = await fixture([queue, queue, 'archive']); await f.reader.open(f.articles[1].path);
  const move = vi.spyOn(f.controller, 'move');
  f.pickArticle.mockImplementation(() => { expect(f.root.textContent).toContain('End of ' + queueLabel(queue) + ' queue.'); });
  f.button('Archive & return to list').click();
  await vi.waitFor(() => expect(f.pickArticle).toHaveBeenCalledTimes(1));
  expect(f.reader.getState()).toMatchObject({ file: undefined, queue });
  expect(f.root.querySelector('.r2-article-end')).toBeNull();
  expect(f.notify).toHaveBeenCalledWith('End of ' + queueLabel(queue) + ' queue.');
  const [remaining, origin, choose] = f.pickArticle.mock.calls[0];
  expect(remaining.map((article: Article) => article.path)).toEqual([f.articles[0].path]); expect(origin).toBe(queue);
  choose(f.articles[0].path); await vi.waitFor(() => expect(f.reader.getArticle()?.path).toBe(f.articles[0].path));
  expect(f.reader.getState().queue).toBe(queue); expect(move).toHaveBeenCalledTimes(1);
});

it('a truly empty origin still opens the native list, while native move retains backwards fallback', async () => {
  const last = await fixture(['inbox']); last.button('Archive & return to list').click();
  await vi.waitFor(() => expect(last.pickArticle).toHaveBeenCalledWith([], 'inbox', expect.any(Function)));
  const native = await fixture(['later', 'later']); await native.reader.open(native.articles[1].path);
  await native.reader.move('archive');
  expect(native.reader.getState()).toMatchObject({ file: native.articles[0].path, queue: 'later' }); expect(native.pickArticle).not.toHaveBeenCalled();
});

it('double taps and native moves share one token; archive preserves inline marks, YAML position and existing journals', async () => {
  const f = await fixture();
  await f.store.create('Daily/test.md', '## Reading\n\n> Existing user-edited excerpt.\n');
  await mark(f.repo, f.articles[0].path, { quote: 'Preserved article text.' });
  await mark(f.repo, f.articles[0].path, { quote: 'Another quote.' });
  await f.reader.refresh(); await f.reader.open(f.articles[0].path);
  await f.repo.saveReadingPosition(f.articles[0].path, { marker: 'Another quote.' }, f.repo.articleGeneration(f.articles[0].path));
  const raw = await f.store.read(f.articles[0].path);
  const before = await f.repo.getArticle(f.articles[0].path), daily = await f.store.read('Daily/test.md');
  const control = f.button('Archive & next'), gate = deferred<void>(), original = f.controller.move.bind(f.controller);
  const move = vi.spyOn(f.controller, 'move').mockImplementation(async (path, status) => { await gate.promise; return original(path, status); });
  control.click(); control.click();
  await vi.waitFor(() => expect(move).toHaveBeenCalledTimes(1));
  expect(f.root.querySelector('.r2-article-end')?.getAttribute('aria-busy')).toBe('true');
  expect([...f.root.querySelectorAll<HTMLButtonElement>('.r2-article-end button')].every(button => button.disabled)).toBe(true);
  await f.reader.move('later'); expect(move).toHaveBeenCalledTimes(1);
  gate.resolve(); await vi.waitFor(() => expect(f.reader.getArticle()?.path).toBe(f.articles[1].path));
  expect(f.button('Archive & return to list').disabled).toBe(false);
  const path = queueFolder('archive') + '/' + before.path.split('/').at(-1), saved = await f.repo.getArticle(path);
  expect(saved.body).toBe(before.body); expect(saved.highlights).toEqual(before.highlights);
  expect(saved.body).toBe('==Preserved article text.== ==Another quote.==');
  expect(saved.readingPosition).toEqual({ marker: 'Another quote.' });
  expect(await f.store.read(path)).toBe(raw);
  expect(await f.store.read('Daily/test.md')).toBe(daily);
  expect(Object.keys(f.store.snapshot()).some(path => path.endsWith('.json'))).toBe(false);
  const reopened = await new ReaderRepository(new MemoryStore(f.store.snapshot()), DEFAULT_SETTINGS).getArticle(path);
  expect(reopened.body).toBe(saved.body); expect(reopened.readingPosition).toEqual(saved.readingPosition);
  expect(parseNote(await f.store.read(path)).doc.toJS().reading_position).toEqual(saved.readingPosition?.marker);
});

it('failed moves stay on the same body with a visible footer error and can be retried', async () => {
  const f = await fixture(), before = f.store.snapshot(), body = f.root.querySelector('.r2-article-body');
  vi.spyOn(f.controller, 'move').mockRejectedValueOnce(new Error('Write refused'));
  f.button('Archive & next').click();
  await vi.waitFor(() => expect(f.root.querySelector('[role="alert"]')?.textContent).toBe('Write refused'));
  expect(f.reader.getState()).toMatchObject({ file: f.articles[0].path, queue: 'inbox' });
  expect(f.root.querySelector('.r2-article-body')).toBe(body); expect(f.store.snapshot()).toEqual(before);
  expect(f.pickArticle).not.toHaveBeenCalled(); expect(f.button('Archive & next').disabled).toBe(false);
  await f.reader.refresh(); expect(f.root.querySelector('[role="alert"]')?.textContent).toBe('Write refused');
  f.button('Archive & next').click(); await vi.waitFor(() => expect(f.reader.getArticle()?.path).toBe(f.articles[1].path));
  expect(f.root.querySelector('[role="alert"]')?.textContent).toBe('');
});

it('queue refresh changes the next title without remounting the body or disturbing selection', async () => {
  const f = await fixture(), body = f.root.querySelector('.r2-article-body')!, footer = f.root.querySelector('.r2-article-end');
  const range = document.createRange(); range.setStart(body.firstChild!, 0); range.setEnd(body.firstChild!, 9);
  document.getSelection()!.addRange(range); const selected = document.getSelection()!.toString(), renders = mount.rendered.mock.calls.length;
  const articles = await f.repo.listArticles();
  const listing = vi.spyOn(f.repo, 'listArticles').mockResolvedValue(articles.map(article => article.path === f.articles[1].path ? { ...article, title: 'Fresh next title' } : article));
  await f.reader.refresh();
  expect(footer?.textContent).toContain('Fresh next title'); expect(f.root.querySelector('.r2-article-end')).toBe(footer);
  expect(f.root.querySelector('.r2-article-body')).toBe(body); expect(mount.rendered).toHaveBeenCalledTimes(renders);
  expect(document.getSelection()!.toString()).toBe(selected);
  listing.mockResolvedValue(articles.filter(article => article.path !== f.articles[1].path)); await f.reader.refresh();
  expect(f.button('Archive & return to list')).toBeDefined(); expect(footer?.textContent).not.toContain('Fresh next title');
  expect(document.getSelection()!.toString()).toBe(selected);
});

it.each([false, true])('adopts inline edits without remounting the selected body (native move pending=%s)', async moving => {
  const f = await fixture(), gate = deferred<void>(), original = f.controller.move.bind(f.controller);
  const move = vi.spyOn(f.controller, 'move').mockImplementation(async (path, queue) => { await gate.promise; return original(path, queue); });
  mount.update.mockReturnValue(true);
  const operation = moving ? f.reader.move('archive') : undefined;
  if (moving) await vi.waitFor(() => expect(move).toHaveBeenCalledOnce());
  const body = f.root.querySelector('.r2-article-body')!, range = document.createRange();
  range.setStart(body.firstChild!, 0); range.setEnd(body.firstChild!, 9); document.getSelection()!.removeAllRanges(); document.getSelection()!.addRange(range);
  expect(document.getSelection()!.getRangeAt(0)).toBe(range);
  const rendered = mount.rendered.mock.calls.length;
  try {
    const updated = await mark(f.repo, f.articles[0].path, { quote: 'Preserved article text.' });
    await f.reader.refresh();
    expect(mount.update).toHaveBeenCalledWith(expect.objectContaining({ path: updated.path, body: updated.body })); expect(mount.rendered).toHaveBeenCalledTimes(rendered);
    expect(f.root.querySelector('.r2-article-body')).toBe(body); expect(document.getSelection()!.getRangeAt(0)).toBe(range);
    expect(f.reader.getArticle()?.body).toBe(updated.body);
  } finally { document.getSelection()!.removeAllRanges(); gate.resolve(); await operation; }
});

it('removes completion when the displayed article disappears while retaining queue navigation', async () => {
  const f = await fixture(), move = vi.spyOn(f.controller, 'move');
  vi.spyOn(f.repo, 'listArticles').mockResolvedValue(f.articles.slice(1));
  await f.reader.refresh();
  expect(f.reader.getArticle()).toBeUndefined(); expect(f.root.textContent).toContain('This article is no longer available.');
  expect(f.root.querySelector('.r2-article-end')).toBeNull(); expect(f.reader.canNavigate(1)).toBe(false);
  expect(f.reader.canNavigateQueue(1)).toBe(true); await f.reader.move('archive'); expect(move).not.toHaveBeenCalled();
});

it('footer preflight and destroy both drain retired mount position writes', async () => {
  const f = await fixture(), retired = deferred<void>(), move = vi.spyOn(f.controller, 'move');
  mount.flush.mockImplementationOnce(() => retired.promise);
  await f.reader.open(f.articles[1].path);
  f.button('Archive & return to list').click();
  await vi.waitFor(() => expect(f.root.querySelector('[aria-busy="true"]')).not.toBeNull());
  expect(move).not.toHaveBeenCalled();
  let closed = false; const closing = f.reader.destroy().then(() => { closed = true; });
  await Promise.resolve(); expect(closed).toBe(false);
  retired.resolve(); await closing;
  expect(closed).toBe(true); expect(move).not.toHaveBeenCalled(); expect(f.root.childElementCount).toBe(0);
});

it.each(['Archive & next', 'Next without archiving', 'Back to reading list'])('does not lose unfinished highlights through %s', async action => {
  const f = await fixture(), move = vi.spyOn(f.controller, 'move'); mount.canLeave.mockReturnValue(false);
  f.button(action).click();
  await vi.waitFor(() => expect(f.root.querySelector('[role="alert"]')?.textContent).toBe('An annotation is unfinished or failed. Wait for saving to finish, or resolve the error above and retry.'));
  expect(move).not.toHaveBeenCalled(); expect(f.pickArticle).not.toHaveBeenCalled(); expect(f.reader.getArticle()?.path).toBe(f.articles[0].path);
  mount.canLeave.mockReturnValue(true); f.button(action).click();
  await vi.waitFor(() => action === 'Back to reading list' ? expect(f.pickArticle).toHaveBeenCalledTimes(1) : expect(f.reader.getArticle()?.path).toBe(f.articles[1].path));
});

it.each(['open', 'queue', 'library', 'markdown', 'inactive', 'destroy'] as const)('pending archive does not steal focus or open another list after %s', async navigation => {
  const f = await fixture(['inbox', 'later']), { gate } = await pauseMove(f);
  if (navigation === 'open') await f.reader.open(f.articles[1].path);
  if (navigation === 'queue') await f.reader.navigateQueue(1);
  if (navigation === 'library') await f.reader.openLibrary();
  if (navigation === 'markdown') await f.reader.openMarkdown();
  if (navigation === 'inactive') { f.setActive(false); f.setActive(true); }
  if (navigation === 'destroy') await f.reader.destroy();
  const external = document.createElement('button'); document.body.append(external); external.focus();
  gate.resolve();
  await vi.waitFor(async () => expect((await f.repo.listArticles()).find(article => article.path === queueFolder('archive') + '/' + f.articles[0].path.split('/').at(-1))?.status).toBe('archive'));
  await vi.waitFor(() => expect(f.root.querySelector('[aria-busy="true"]')).toBeNull());
  expect(document.activeElement).toBe(external); expect(f.pickArticle).toHaveBeenCalledTimes(navigation === 'library' ? 1 : 0);
  if (navigation === 'open' || navigation === 'queue') expect(f.reader.getState()).toMatchObject({ file: f.articles[1].path, queue: 'later' });
  if (navigation === 'destroy') { expect(f.root.childElementCount).toBe(0); expect(f.stopActive).toHaveBeenCalledTimes(1); }
});

it.each(['open', 'library', 'destroy', 'rename'] as const)('revalidates identity after position flush before mutating on %s', async navigation => {
  const f = await fixture(), flush = deferred<void>(), move = vi.spyOn(f.controller, 'move');
  mount.flush.mockImplementationOnce(() => flush.promise);
  f.button('Archive & next').click(); await vi.waitFor(() => expect(f.root.querySelector('[aria-busy="true"]')).not.toBeNull());
  if (navigation === 'open') await f.reader.open(f.articles[1].path);
  if (navigation === 'library') await f.reader.openLibrary();
  const destroyed = navigation === 'destroy' ? f.reader.destroy() : undefined;
  if (navigation === 'rename') {
    const moved = await f.repo.setStatus(f.articles[0].path, 'later'); f.reader.remapPath(f.articles[0].path, moved.path);
  }
  flush.resolve(); await destroyed; await vi.waitFor(() => expect(f.root.querySelector('[aria-busy="true"]')).toBeNull());
  expect(move).not.toHaveBeenCalled();
});

it('a highlight started during position flush still blocks footer archive', async () => {
  const f = await fixture(), flush = deferred<void>(), move = vi.spyOn(f.controller, 'move');
  mount.flush.mockImplementationOnce(() => flush.promise);
  f.button('Archive & next').click(); await vi.waitFor(() => expect(f.root.querySelector('[aria-busy="true"]')).not.toBeNull());
  mount.canLeave.mockReturnValue(false); flush.resolve();
  await vi.waitFor(() => expect(f.root.querySelector('[role="alert"]')?.textContent).toBe('An annotation is unfinished or failed. Wait for saving to finish, or resolve the error above and retry.'));
  expect(move).not.toHaveBeenCalled(); expect(f.button('Archive & next').disabled).toBe(false);
});

it('repeated completion actions archive the currently visible article, not the initial mount', async () => {
  const f = await fixture(['inbox', 'inbox', 'inbox']), move = vi.spyOn(f.controller, 'move');
  for (const article of f.articles.slice(1)) {
    f.button('Archive & next').click(); await vi.waitFor(() => expect(f.reader.getArticle()?.path).toBe(article.path));
  }
  f.button('Archive & return to list').click(); await vi.waitFor(() => expect(f.pickArticle).toHaveBeenCalledTimes(1));
  expect(move.mock.calls).toEqual(f.articles.map(article => [article.path, 'archive']));
  expect(f.pickArticle.mock.calls[0].slice(0, 2)).toEqual([[], 'inbox']);
});

it('native rename and controller refresh before move returns do not cancel forward completion', async () => {
  const f = await fixture(), original = f.controller.move.bind(f.controller);
  vi.spyOn(f.controller, 'move').mockImplementation(async (path, destination) => {
    const saved = await original(path, destination); f.reader.remapPosition(path, saved.path); f.reader.remapPath(path, saved.path); await f.reader.refresh(); return saved;
  });
  f.button('Archive & next').click(); await vi.waitFor(() => expect(f.reader.getArticle()?.path).toBe(f.articles[1].path));
  expect(f.reader.getState().queue).toBe('inbox'); expect(f.pickArticle).not.toHaveBeenCalled();
});

it.each(['open', 'destroy', 'newer-list'] as const)('ignores delayed native list results after %s', async navigation => {
  const f = await fixture(), pending = deferred<Article[]>(), articles = await f.repo.listArticles();
  vi.spyOn(f.repo, 'listArticles').mockImplementationOnce(() => pending.promise);
  const listing = f.reader.openLibrary();
  if (navigation === 'open') await f.reader.open(f.articles[2].path);
  if (navigation === 'destroy') await f.reader.destroy();
  if (navigation === 'newer-list') await f.reader.openLibrary('feed');
  pending.resolve(articles); await listing;
  expect(f.pickArticle).toHaveBeenCalledTimes(navigation === 'newer-list' ? 1 : 0);
  if (navigation === 'newer-list') expect(f.pickArticle.mock.calls[0][1]).toBe('feed');
});

it('a delayed article load cannot take focus from an already-open native list', async () => {
  const f = await fixture(), pending = deferred<Article>();
  vi.spyOn(f.repo, 'getArticle').mockImplementationOnce(() => pending.promise);
  const opening = f.reader.open(f.articles[1].path); await f.reader.openLibrary();
  const picker = document.createElement('input'); document.body.append(picker); picker.focus();
  pending.resolve(f.articles[1]); await opening;
  expect(document.activeElement).toBe(picker); expect(f.pickArticle).toHaveBeenCalledTimes(1);
});

it('stale list failures do not overwrite the footer of a newer article', async () => {
  const f = await fixture(), pending = deferred<Article[]>();
  vi.spyOn(f.repo, 'listArticles').mockImplementationOnce(() => pending.promise);
  const listing = f.reader.openLibrary(); await f.reader.open(f.articles[2].path);
  pending.reject(new Error('Old list failure')); await listing;
  expect(f.root.textContent).not.toContain('Old list failure'); expect(f.notify).not.toHaveBeenCalled();
});

it('a delayed end-of-queue list cannot open over a newer article', async () => {
  const f = await fixture(['inbox', 'later']), pending = deferred<Article[]>(), original = f.reader.openLibrary.bind(f.reader);
  const library = vi.spyOn(f.reader, 'openLibrary').mockImplementationOnce(queue => {
    vi.spyOn(f.repo, 'listArticles').mockImplementationOnce(() => pending.promise); return original(queue);
  });
  f.button('Archive & return to list').click(); await vi.waitFor(() => expect(library).toHaveBeenCalledTimes(1));
  expect(f.root.textContent).toContain('End of Inbox queue.'); await f.reader.open(f.articles[1].path);
  pending.resolve(await f.repo.listArticles()); await vi.waitFor(() => expect(f.reader.getArticle()?.path).toBe(f.articles[1].path));
  await Promise.resolve(); expect(f.pickArticle).not.toHaveBeenCalled(); expect(f.reader.getState().queue).toBe('later');
});

it('list failures are visible in the footer and stale list choices cannot replace newer navigation', async () => {
  const f = await fixture(); vi.spyOn(f.repo, 'listArticles').mockRejectedValueOnce(new Error('Cannot read list'));
  f.button('Back to reading list').click(); await vi.waitFor(() => expect(f.root.querySelector('[role="alert"]')?.textContent).toBe('Cannot read list'));
  expect(f.reader.getArticle()?.path).toBe(f.articles[0].path); expect(f.pickArticle).not.toHaveBeenCalled();
  await f.reader.openLibrary(); const choose = f.pickArticle.mock.calls[0][2]; await f.reader.open(f.articles[2].path);
  choose(f.articles[1].path); await Promise.resolve(); expect(f.reader.getArticle()?.path).toBe(f.articles[2].path);
});

it('locks only the footer-moved source through native remap loading and unlocks the next article', async () => {
  const f = await fixture(), returning = deferred<void>(), remapped = deferred<Article>(), original = f.controller.move.bind(f.controller);
  const sourceView = f.root.querySelector<HTMLElement>('.r2-reader')!;
  const move = vi.spyOn(f.controller, 'move').mockImplementation(async (path, destination) => {
    const saved = await original(path, destination); f.reader.remapPosition(path, saved.path); f.reader.remapPath(path, saved.path); remapped.resolve(saved);
    await returning.promise; return saved;
  });
  const flush = deferred<void>(); mount.flush.mockImplementationOnce(() => flush.promise);
  f.button('Archive & next').click();
  try {
    await vi.waitFor(() => expect(f.root.querySelector('[aria-busy="true"]')).not.toBeNull());
    expect(sourceView.dataset.navigationBusy).toBe('true'); expect(move).not.toHaveBeenCalled();
    flush.resolve(); const saved = await remapped.promise;
    await vi.waitFor(() => expect(f.reader.getArticle()?.path).toBe(saved.path));
    const remounted = f.root.querySelector<HTMLElement>('.r2-reader')!;
    expect(remounted).not.toBe(sourceView); expect(remounted.dataset.articlePath).toBe(saved.path);
    expect(remounted.dataset.navigationBusy).toBe('true');
    expect(mount.navigationBusy).toHaveBeenCalledWith(saved.path, true, remounted);
  } finally { flush.resolve(); returning.resolve(); }
  await vi.waitFor(() => expect(f.reader.getArticle()?.path).toBe(f.articles[1].path));
  expect(f.root.querySelector<HTMLElement>('.r2-reader')?.dataset.navigationBusy).toBe('false');
  expect(mount.navigationBusy.mock.calls.some(([path, busy]) => path === f.articles[1].path && busy)).toBe(false);
});

it('unlocks the source after a rejected footer archive without remounting it', async () => {
  const f = await fixture(), { gate } = await pauseMove(f), source = f.root.querySelector<HTMLElement>('.r2-reader')!;
  try { expect(source.dataset.navigationBusy).toBe('true'); }
  finally { gate.reject(new Error('Write refused')); }
  await vi.waitFor(() => expect(f.root.querySelector('[role="alert"]')?.textContent).toContain('Write refused'));
  expect(f.root.querySelector('.r2-reader')).toBe(source); expect(source.dataset.navigationBusy).toBe('false');
  expect(mount.navigationBusy).toHaveBeenCalledWith(f.articles[0].path, false, source);
});

it('does not freeze another article opened while a footer archive is still pending', async () => {
  const f = await fixture(), { gate } = await pauseMove(f), source = f.root.querySelector<HTMLElement>('.r2-reader')!;
  try {
    expect(source.dataset.navigationBusy).toBe('true'); await f.reader.open(f.articles[1].path);
    const next = f.root.querySelector<HTMLElement>('.r2-reader')!;
    expect(next.dataset.navigationBusy).toBe('false'); expect(f.reader.getArticle()?.path).toBe(f.articles[1].path);
    expect(mount.navigationBusy.mock.calls.some(([path, busy]) => path === f.articles[1].path && busy)).toBe(false);
  } finally { gate.resolve(); }
  await vi.waitFor(() => expect(f.root.querySelector('[aria-busy="true"]')).toBeNull());
  expect(f.reader.getArticle()?.path).toBe(f.articles[1].path);
});

it('native moves retain their existing source-interaction behavior rather than acquiring the footer lock', async () => {
  const f = await fixture(), gate = deferred<void>(), original = f.controller.move.bind(f.controller);
  const move = vi.spyOn(f.controller, 'move').mockImplementation(async (path, destination) => { await gate.promise; return original(path, destination); });
  const moving = f.reader.move('archive');
  try {
    await vi.waitFor(() => expect(move).toHaveBeenCalledTimes(1));
    expect(f.root.querySelector<HTMLElement>('.r2-reader')?.dataset.navigationBusy).toBe('false');
    expect(mount.navigationBusy.mock.calls.some(([, busy]) => busy)).toBe(false);
  } finally { gate.resolve(); await moving; }
});

it.each(['open', 'library'] as const)('reports a rejected footer archive after %s without changing the newer navigation', async navigation => {
  const f = await fixture(), { gate } = await pauseMove(f);
  if (navigation === 'open') await f.reader.open(f.articles[2].path);
  else await f.reader.openLibrary();
  const state = f.reader.getState(), body = f.root.querySelector('.r2-article-body'), pickerCount = f.pickArticle.mock.calls.length;
  const external = document.createElement('input'); document.body.append(external); external.focus();
  gate.reject(new Error('Write refused after navigation'));
  await vi.waitFor(() => expect(f.root.querySelector('[aria-busy="true"]')).toBeNull());
  expect(f.notify).toHaveBeenCalledWith(expect.stringContaining('Write refused after navigation'));
  expect(f.reader.getState()).toEqual(state); expect(f.root.querySelector('.r2-article-body')).toBe(body);
  expect(f.pickArticle).toHaveBeenCalledTimes(pickerCount); expect(document.activeElement).toBe(external);
  if (navigation === 'open') expect(f.root.querySelector('[role="alert"]')?.textContent).toBe('');
});

it.each(['last', 'followed', 'reused-path'] as const)('follows the next stable article id after its native rename during archive (%s)', async scenario => {
  const f = await fixture(scenario === 'last' ? ['inbox', 'inbox', 'later'] : ['inbox', 'inbox', 'inbox', 'later']);
  const next = f.articles[1], { gate } = await pauseMove(f), renamedPath = queueFolder('inbox') + '/Renamed next article.md';
  try {
    await f.store.rename(next.path, renamedPath, { expectedContent: await f.store.read(next.path) });
    await f.repo.articleRenamed(next.path, renamedPath); f.reader.remapPath(next.path, renamedPath);
    expect((await f.repo.getArticle(renamedPath)).body).toBe(next.body);
    if (scenario === 'reused-path') {
      const replacement = await f.repo.createArticle({ title: 'Replacement article', url: '', status: 'inbox', extractor: 'manual', body: 'A different article reusing the old filename.' });
      await f.store.rename(replacement.path, next.path, { expectedContent: await f.store.read(replacement.path) });
      await f.repo.articleRenamed(replacement.path, next.path);
      expect((await f.repo.getArticle(next.path)).body).toBe(replacement.body); expect(replacement.body).not.toBe(next.body);
    }
    await f.reader.refresh();
  } finally { gate.resolve(); }
  await vi.waitFor(() => expect(f.reader.getArticle()?.path).toBe(renamedPath));
  expect(f.reader.getState()).toMatchObject({ file: renamedPath, queue: 'inbox' });
  expect(f.pickArticle).not.toHaveBeenCalled(); expect(f.root.textContent).not.toContain('End of Inbox queue.');
});

it.each([[false, false], [false, true], [true, false], [true, true]] as const)('follows the next path without persisted IDs (edited=%s, remap=%s)', async (edited, rename) => {
  const f = await fixture(['inbox', 'inbox', 'inbox', 'inbox']), source = f.articles[1], next = f.articles[2];
  if (edited) await f.store.process(next.path, raw => raw.replace('Preserved article text.', 'Edited next article text.'));
  await f.reader.refresh(); await f.reader.open(source.path);
  const { gate } = await pauseMove(f); let expectedPath = next.path;
  try {
    if (rename) {
      expectedPath = queueFolder('inbox') + '/Renamed ambiguous next.md';
      await f.store.rename(next.path, expectedPath, { expectedContent: await f.store.read(next.path) });
      await f.repo.articleRenamed(next.path, expectedPath); f.reader.remapPath(next.path, expectedPath); await f.reader.refresh();
    }
  } finally { gate.resolve(); }
  await vi.waitFor(() => expect(f.reader.getArticle()?.path).toBe(expectedPath));
  expect(f.reader.getState().queue).toBe('inbox'); expect(f.pickArticle).not.toHaveBeenCalled();
  expect(f.reader.getArticle()?.path).not.toBe(f.articles[0].path);
});

it.each([false, true])('retries a stale final queue snapshot when the next idless article is renamed during the read (edited=%s)', async edited => {
  const f = await fixture(['inbox', 'inbox', 'later']), next = f.articles[1];
  if (edited) await f.store.process(next.path, raw => raw.replace('Preserved article text.', 'Edited next article text.'));
  const list = f.repo.listArticles.bind(f.repo), move = f.controller.move.bind(f.controller);
  const listing = vi.spyOn(f.repo, 'listArticles');
  const getting = vi.spyOn(f.repo, 'getArticle');
  await f.reader.refresh();
  const snapshotReady = deferred<Article[]>(), release = deferred<void>(); let finalReads = 0;
  vi.spyOn(f.controller, 'move').mockImplementation(async (path, destination) => {
    const saved = await move(path, destination);
    // Controller broadcasts have already started their reads; delay the app's final listing only.
    listing.mockImplementation(async () => {
      const snapshot = await list();
      if (++finalReads === 1) { snapshotReady.resolve(snapshot); await release.promise; }
      return snapshot;
    });
    return saved;
  });
  f.button('Archive & next').click();
  const renamed = queueFolder('inbox') + '/Renamed during final list.md';
  try {
    await vi.waitFor(() => expect(finalReads).toBe(1));
    const stale = await snapshotReady.promise; expect(stale.some(article => article.path === next.path)).toBe(true);
    await f.store.rename(next.path, renamed, { expectedContent: await f.store.read(next.path) });
    await f.repo.articleRenamed(next.path, renamed); f.reader.remapPath(next.path, renamed);
    expect(stale.some(article => article.path === renamed)).toBe(false);
  } finally { release.resolve(); }
  await vi.waitFor(() => expect(f.reader.getArticle()?.path).toBe(renamed));
  expect(finalReads).toBeGreaterThanOrEqual(2); expect(finalReads).toBeLessThanOrEqual(3);
  expect(f.reader.getState().queue).toBe('inbox'); expect(f.reader.getArticle()?.path).toBe(renamed);
  expect(getting).not.toHaveBeenCalledWith(next.path);
  expect(f.pickArticle).not.toHaveBeenCalled(); expect(f.root.textContent).not.toContain('End of Inbox queue.');
});

it('bounds continuously invalidated final queue reads and shows a visible error instead of ending the queue', async () => {
  const f = await fixture(['inbox', 'inbox']), list = f.repo.listArticles.bind(f.repo), move = f.controller.move.bind(f.controller);
  const listing = vi.spyOn(f.repo, 'listArticles'); let finalReads = 0, nextPath = f.articles[1].path;
  vi.spyOn(f.controller, 'move').mockImplementation(async (path, destination) => {
    const saved = await move(path, destination);
    listing.mockImplementation(async () => {
      // Bound a broken implementation in the test too, so an accidental retry loop cannot hang Vitest.
      if (++finalReads > 5) throw new Error('Test guard: unbounded queue changes');
      const stale = await list(), renamed = queueFolder('inbox') + `/Continuously renamed ${finalReads}.md`;
      await f.store.rename(nextPath, renamed, { expectedContent: await f.store.read(nextPath) });
      await f.repo.articleRenamed(nextPath, renamed); f.reader.remapPath(nextPath, renamed); nextPath = renamed;
      return stale;
    });
    return saved;
  });
  f.button('Archive & next').click();
  await vi.waitFor(() => expect(f.root.querySelector('[role="alert"]')?.textContent).toMatch(/chang/i));
  expect(finalReads).toBe(3); expect(f.root.querySelector('[aria-busy="true"]')).toBeNull();
  expect(f.root.querySelector<HTMLElement>('.r2-reader')?.dataset.navigationBusy).toBe('false');
  expect(f.reader.getArticle()?.path).toBe(queueFolder('archive') + '/' + f.articles[0].path.split('/').at(-1)); expect(f.reader.getState().queue).toBe('inbox');
  expect(f.pickArticle).not.toHaveBeenCalled(); expect(f.root.textContent).not.toContain('End of Inbox queue.');
});

it('rechecks the first loaded article revision after position flush even when the path is reused', async () => {
  const f = await fixture(), flush = deferred<void>(), move = vi.spyOn(f.controller, 'move');
  const original = f.articles[0], oldRevision = (await f.repo.getArticle(original.path)).revision;
  expect(f.root.querySelector<HTMLElement>('.r2-reader')?.dataset.articlePath).toBe(original.path);
  mount.flush.mockImplementationOnce(() => flush.promise); f.button('Archive & next').click();
  try {
    await vi.waitFor(() => expect(f.root.querySelector('[aria-busy="true"]')).not.toBeNull());
    await f.store.rename(original.path, 'Trash.md', { expectedContent: await f.store.read(original.path) });
    await f.repo.articleDeleted(original.path);
    await f.store.create(original.path, '---\ntype: article\nurl: ""\n---\nReplacement body at reused path.');
    await f.reader.refresh();
    expect(f.reader.getArticle()?.revision).not.toBe(oldRevision);
  } finally { flush.resolve(); }
  await vi.waitFor(() => expect(f.root.querySelector('[aria-busy="true"]')).toBeNull());
  expect(move).not.toHaveBeenCalled(); expect(f.reader.getState().file).toBe(original.path);
  expect(f.root.querySelector<HTMLElement>('.r2-reader')?.dataset.navigationBusy).toBe('false');
});

it.each(['journal block backlink', 'directory-relative source link', 'collision'])('footer archive blocks unsafe %s without mutating any note', async unsafe => {
  const f = await fixture(), source = f.articles[0].path;
  await mark(f.repo, source, { quote: 'Preserved article text.' });
  if (unsafe === 'journal block backlink') {
    await f.store.process(source, raw => raw + '\n\n> Inert legacy excerpt\n\n^hl-old\n');
    await f.store.create('Daily/old.md', `User journal.\n[[${source.replace(/\.md$/, '')}#^hl-old|Saved source]]\n`);
  } else if (unsafe === 'directory-relative source link') {
    await f.store.process(source, raw => raw + '\n\n[[./Neighbour]]\n');
    await f.store.create('Reading/Inbox/Neighbour.md', 'Native neighbour.');
  } else await f.store.create(source.replace('/Inbox/', '/Treasury/'), 'A different note at the destination.');
  await f.reader.refresh(); await f.reader.open(source);
  const before = f.store.snapshot(), body = f.root.querySelector('.r2-article-body');
  f.button('Archive & next').click();
  await vi.waitFor(() => expect(f.root.querySelector('.r2-article-end-error')?.textContent).not.toBe(''));
  expect(f.store.snapshot()).toEqual(before); expect(f.reader.getState().file).toBe(source);
  expect(f.root.querySelector('.r2-article-body')).toBe(body); expect(f.pickArticle).not.toHaveBeenCalled();
});

// SDK event bridge + real controller/repository; only article geometry is mocked above.
async function nativeFinishFixture() {
  const store = new MemoryStore(), repo = new ReaderRepository(store, { ...DEFAULT_SETTINGS });
  const source = await repo.createArticle({ title: 'A source', url: '', body: 'First article.', status: 'inbox' });
  const next = await repo.createArticle({ title: 'B legacy next', url: '', body: 'Next article.', status: 'inbox' });
  const events = new Map<string, Function>(), factories = new Map<string, (leaf: any) => any>(), leaves: any[] = [], timers: number[] = [];
  class TFile { extension = 'md'; basename = 'Article'; constructor(public path: string) {} }
  const files = new Map((await store.list()).map(path => [path, new TFile(path)]));
  class FileView {
    app: any; file: any; titleEl = document.createElement('div'); contentEl: any;
    constructor(public leaf: any) { this.app = leaf.app; const node = document.createElement('div'); this.contentEl = Object.assign(node, { addClass: (name: string) => node.classList.add(name) }); document.body.append(node); }
    async setState(state: any) { this.file = state.file ? this.app.vault.getFileByPath(state.file) : null; }
    async onClose() {} async onRename() {} onPaneMenu() {}
  }
  class Plugin {
    constructor(public app: any) {} async loadData() { return {}; }
    registerView(type: string, factory: any) { factories.set(type, factory); }
    addCommand() {} addRibbonIcon() {} addSettingTab() {} register() {} registerEvent() {} registerDomEvent() {}
    registerInterval(timer: number) { timers.push(timer); }
  }
  const pickArticles = vi.fn(), notify = vi.fn();
  class NativeReaderUI { pickArticles = pickArticles; dispose() {} }
  const sdk = { Plugin, FileView, TFile, Platform: { isMobile: true, isAndroidApp: false }, Notice: class { constructor(message: string) { notify(message); } }, parseLinktext: (target: string) => ({ path: target, subpath: '' }) };
  const dependencies: Record<string, unknown> = {
    obsidian: sdk, './native-delete': { nativeDeleteHandler }, './reading-position': { validReadingPosition: readingPosition }, './eink-device': einkDevice,
    './typed-highlights': { validateHighlightTypes }, './types': { DEFAULT_SETTINGS }, './storage/repository': { ReaderRepository: class { constructor() { return repo; } } },
    './obsidian-store': { ObsidianStore: class {} }, './controller': { ReaderController }, './transport': { obsidianGet: vi.fn() }, './ui/app': { ReaderApp },
    './settings': { ReaderSettingsTab: class {} }, './routing': { installArticleRouting: () => ({ dispose() {}, remapPath() {} }) },
    './ui/native': { NativeReaderUI }, './ui/native-popups': { nativeHighlightMenu: vi.fn(), nativeLinkMenu: vi.fn() },
    './settings-migration': { settingsData: async (data: unknown) => ({ data }) },
    './template-exclusions': { readTemplateExclusions: async () => ({ folders: [], files: [] }) }, './storage/classifier': { isArticleTemplatePath: () => false },
  };
  const output = ts.transpileModule(readFileSync('src/main.ts', 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
  const exports: Record<string, any> = {};
  new Function('require', 'exports', output)((name: string) => { if (!(name in dependencies)) throw new Error('Unexpected dependency: ' + name); return dependencies[name]; }, exports);
  const app: any = { vault: { on: (name: string, fn: Function) => { events.set(name, fn); }, getFileByPath: (path: string) => files.get(path) ?? null, getMarkdownFiles: () => [...files.values()] } };
  app.workspace = { activeLeaf: null, getLeavesOfType: (type: string) => leaves.filter(leaf => leaf.view.getViewType() === type), iterateAllLeaves: (fn: Function) => leaves.forEach(leaf => fn(leaf)), requestSaveLayout() {}, onLayoutReady() {}, on() {}, offref() {} };
  const plugin = new exports.default(app); await plugin.onload(); plugin.controller.setOnline(false);
  const leaf: any = { app, updateHeader() {}, async setViewState(state: any) { if (state.type !== 'reader') { this.view = { getViewType: () => state.type }; return; } this.view = factories.get('reader')!(this); await this.view.onOpen(); await this.view.setState(state.state ?? {}, {}); } };
  leaves.push(leaf); app.workspace.activeLeaf = leaf;
  await leaf.setViewState({ type: 'reader', state: { file: source.path } });
  const reader: ReaderApp = leaf.view.getReader(); await reader.refresh();
  cleanup.push(async () => { timers.forEach(timer => window.clearInterval(timer)); plugin.onunload(); await app[Symbol.for('reader.shutdown')]; });
  return { store, repo, source, next, events, files, plugin, leaf, reader, pickArticles, notify };
}

it.each([false, true])('early native rename observes an idless next note while the deferred bridge is blocked (during final list=%s)', async duringList => {
  const f = await nativeFinishFixture(), sourceView = f.leaf.view, root = sourceView.contentEl as HTMLElement;
  const moveGate = deferred<void>(), renameGate = deferred<void>(), listGate = deferred<void>(), listStarted = deferred<void>();
  const move = f.plugin.controller.move.bind(f.plugin.controller), renamed = f.plugin.controller.articleRenamed.bind(f.plugin.controller), list = f.repo.listArticles.bind(f.repo);
  vi.spyOn(f.plugin.controller, 'articleRenamed').mockImplementation(async (from, to) => { await renamed(from, to); if (from === f.next.path) await renameGate.promise; });
  let finalReads = 0;
  vi.spyOn(f.plugin.controller, 'move').mockImplementation(async (path, queue) => {
    await moveGate.promise; const saved = await move(path, queue);
    if (duringList) vi.spyOn(f.repo, 'listArticles').mockImplementation(async () => {
      const snapshot = await list(); if (++finalReads === 1) { listStarted.resolve(); await listGate.promise; } return snapshot;
    });
    return saved;
  });
  root.querySelector<HTMLButtonElement>('.r2-article-end-primary')!.click();
  await vi.waitFor(() => expect(f.plugin.controller.move).toHaveBeenCalledOnce());
  if (duringList) { moveGate.resolve(); await listStarted.promise; }
  const before = sourceView.getState(), nativeFile = sourceView.file, body = root.querySelector('.r2-article-body');
  const to = 'Reading/Inbox/Renamed idless next.md', file = f.files.get(f.next.path)!;
  try {
    await f.store.rename(f.next.path, to, { expectedContent: await f.store.read(f.next.path) });
    f.files.delete(f.next.path); file.path = to; f.files.set(to, file);
    f.events.get('rename')!(file, f.next.path);
    // No late ReaderView.remapPath yet, and no incidental remount/identity adoption.
    expect(sourceView.getState()).toEqual(before); expect(sourceView.file).toBe(nativeFile);
    expect(root.querySelector('.r2-article-body')).toBe(body);
    expect((await f.repo.getArticle(to)).body).toBe(f.next.body);
    moveGate.resolve(); listGate.resolve();
    await vi.waitFor(() => expect(f.reader.getArticle()?.path).toBe(to));
    expect(f.reader.getState().queue).toBe('inbox'); expect(f.pickArticles).not.toHaveBeenCalled();
    // The rename broadcasts a refresh; a final snapshot may need one or two retries.
    if (duringList) { expect(finalReads).toBeGreaterThanOrEqual(3); expect(finalReads).toBeLessThanOrEqual(4); }
  } finally { moveGate.resolve(); listGate.resolve(); renameGate.resolve(); }
  await Promise.all([...(f.plugin as any).nativeRenames]);
  expect(f.reader.getState()).toMatchObject({ file: to, queue: 'inbox' });
  expect(f.reader.getArticle()?.path).toBe(to); expect(f.notify).not.toHaveBeenCalled();
});

it.each([[false, false], [false, true]])('has no completion footer or hidden toolbar for desktop mobile=%s, eink=%s', async (mobile, eink) => {
  const f = await fixture(['inbox'], mobile, eink); expect(f.root.querySelector('.r2-article-end,.r2-reader-toolbar')).toBeNull();
});
it('mounts the mobile completion actions in Boox mode without a toolbar', async () => {
  const f = await fixture(['inbox'], true, true);
  expect(f.root.querySelector('.r2-reader-toolbar')).toBeNull();
  expect(f.root.querySelector('.r2-article-end')).not.toBeNull();
});
