import { afterEach, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import ts from 'typescript';
import { ReaderController } from '../src/controller';
import { ReaderRepository } from '../src/storage/repository';
import { MemoryStore } from '../src/storage/memory';
import { DEFAULT_SETTINGS, type HttpGet } from '../src/types';
import { captureSelection, buildCanonicalTextIndex, rangeFromPosition, type SelectionSnapshot } from '../src/highlights';
import { mountReader, type ReaderHost, type ReaderMount } from '../src/ui/reader';
import { parseInlineMarkdown } from '../src/inline/parser';
import type { ReadingPosition } from '../src/reading-position';

const watchers = vi.hoisted(() => new WeakMap<HTMLElement, (selection: SelectionSnapshot) => void>());
vi.mock('../src/highlights/index', async original => {
  const actual = await original<typeof import('../src/highlights/index')>();
  return { ...actual, watchCompletedSelection: (...args: Parameters<typeof actual.watchCompletedSelection>) => {
    watchers.set(args[0], args[2]); return actual.watchCompletedSelection(...args);
  } };
});
const cleanup: (() => void | Promise<void>)[] = [];
afterEach(async () => {
  for (const stop of cleanup.splice(0)) await stop();
  document.getSelection()?.removeAllRanges(); document.body.replaceChildren();
  vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.useRealTimers();
});
const tick = () => vi.advanceTimersByTimeAsync(1);
function gate() { let release!: () => void; const promise = new Promise<void>(resolve => { release = resolve; }); return { release, promise }; }

// SDK-only fixture, matching the native adapter contract without an Obsidian vault.
function nativeMenus() {
  const menus: Menu[] = [];
  let choose: (target: string | null) => void = () => {};
  class Menu {
    items = new Map<string, () => unknown>();
    constructor() { menus.push(this); }
    addItem(make: (item: any) => void) {
      let title = '', callback = () => {};
      const item = { setTitle(value: string) { title = value; return item; }, setIcon() { return item; }, onClick(value: () => void) { callback = value; return item; } };
      make(item); this.items.set(title, callback); return this;
    }
    showAtPosition() {} hide() {}
  }
  class Picker {
    constructor(_app: unknown, _quote: string, _reason: string | undefined, callback: typeof choose) { choose = callback; }
    open() {} close() { choose(null); }
  }
  const deps: Record<string, unknown> = { obsidian: { Menu, Notice: class {} }, './highlight-link-picker': { HighlightLinkPicker: Picker }, './default-highlight-target': { defaultHighlightTarget: () => ({ target: 'one' }) } };
  const js = ts.transpileModule(readFileSync('src/ui/native-popups.ts', 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
  const exports: any = {}; new Function('require', 'exports', js)((name: string) => deps[name], exports);
  return { host: { highlightMenu: exports.nativeHighlightMenu({}), linkMenu: exports.nativeLinkMenu } as Partial<ReaderHost>, action: (title: string) => menus.at(-1)!.items.get(title)!(), choose: (target: string) => choose(target) };
}
async function fixture(options: { mobile?: boolean; eink?: boolean; source?: string; native?: boolean; position?: ReadingPosition; host?: Partial<ReaderHost> } = {}) {
  vi.useFakeTimers();
  vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} });
  const settings = DEFAULT_SETTINGS, store = new MemoryStore(), repository = new ReaderRepository(store, settings);
  let article = await repository.createArticle({ title: 'Finish safely', url: '', body: options.source ?? 'one two three', status: 'inbox', extractor: 'manual' });
  if (options.position) {
    await repository.saveReadingPosition(article.path, options.position, article.id, repository.articleGeneration(article.path));
    article = await repository.getArticle(article.path);
  }
  const controller = new ReaderController(repository, vi.fn<HttpGet>(), settings); controller.setActive(false);
  const root = document.createElement('div'); document.body.append(root);
  const native = options.native ? nativeMenus() : undefined;
  let chooseTarget: (target: string | null) => void = () => {};
  const host: ReaderHost = { isMobile: options.mobile ?? true, einkEnabled: () => options.eink ?? false, openNote: vi.fn(),
    pickLinkTarget: (_quote, choose) => { chooseTarget = choose; }, ...native?.host, ...options.host };
  const mount = mountReader(root, article, controller, host, () => {});
  if (options.position) mount.restorePosition!(options.position);
  const footer = document.createElement('nav'); footer.className = 'r2-article-end'; footer.dataset.readerUi = 'article-end';
  const button = document.createElement('button'); button.textContent = 'Archive & next'; footer.append(button); mount.setArticleEnd!(footer);
  const body = root.querySelector<HTMLElement>('.r2-article-body')!;
  const choose = (start = 0, end = 3) => {
    const range = rangeFromPosition(buildCanonicalTextIndex(body), { start, end });
    const selection = document.getSelection()!; selection.removeAllRanges(); selection.addRange(range); document.dispatchEvent(new Event('selectionchange'));
    return captureSelection(body, body.dataset.articleVersion!)!;
  };
  const collapse = () => { document.getSelection()!.removeAllRanges(); document.dispatchEvent(new Event('selectionchange')); };
  const complete = (snapshot = choose()) => watchers.get(body)!(snapshot);
  const action = (text: string) => native ? native.action(text) : [...root.querySelectorAll<HTMLButtonElement>('button')].find(item => item.textContent === text)!.click();
  cleanup.push(async () => { await mount(); await controller.shutdown(); });
  return { root, body, article, controller, repository, store, mount, footer, button, choose, collapse, complete, action, host,
    chooseTarget: (target: string, highlight = false) => native && highlight ? native.choose(target) : chooseTarget(target) };
}

it('adds one scrolling-mobile footer after the body, never to source HTML, Markdown or the canonical index', async () => {
  const f = await fixture(), before = f.store.snapshot(), html = f.body.innerHTML, canonical = buildCanonicalTextIndex(f.body).text;
  expect(f.footer.parentElement).toBe(f.root.querySelector('.r2-reading-page'));
  expect(f.body.contains(f.footer)).toBe(false);
  expect(f.body.compareDocumentPosition(f.footer) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  f.mount.setArticleEnd!(f.footer); expect(f.root.querySelectorAll('.r2-article-end')).toHaveLength(1);
  const replacement = f.footer.cloneNode(true) as HTMLElement; f.mount.setArticleEnd!(replacement);
  expect(f.footer.isConnected).toBe(false); expect(f.root.querySelectorAll('.r2-article-end')).toHaveLength(1);
  expect(f.body.innerHTML).toBe(html); expect(buildCanonicalTextIndex(f.body).text).toBe(canonical); expect(f.store.snapshot()).toEqual(before);
  expect(f.mount.canLeave!()).toBe(true); await f.mount(); expect(f.mount.canLeave!()).toBe(false);
});
it.each([{ mobile: false, eink: false }, { mobile: false, eink: true }])('does not mount completion UI on desktop: %j', async options => {
  const f = await fixture(options); expect(f.root.querySelector('.r2-article-end')).toBeNull(); expect(f.footer.isConnected).toBe(false);
});
it('mounts Boox completion UI outside the source columns and keeps it hidden until the final page', async () => {
  const f = await fixture({ mobile: true, eink: true }), before = f.store.snapshot();
  const html = f.body.innerHTML, canonical = buildCanonicalTextIndex(f.body).text;
  expect(f.footer.parentElement).toBe(f.root.querySelector('.r2-reader-scroll'));
  expect(f.footer.hidden).toBe(true);
  expect(f.body.contains(f.footer)).toBe(false);
  expect(buildCanonicalTextIndex(f.body).text).toBe(canonical);
  expect(f.body.innerHTML).toBe(html); expect(f.store.snapshot()).toEqual(before);
});
it('blocks before selection settles and through its inline write, then permits the saved native selection', async () => {
  const f = await fixture(), hold = gate(), original = f.controller.highlight.bind(f.controller);
  // Keep the real controller/write pipeline behind the gate, not sidecar records.
  const delayed = vi.spyOn(f.controller, 'highlight').mockImplementation(async (...args) => { await hold.promise; return original(...args); });
  const selectedNode = f.body.firstChild, snapshot = f.choose(), nativeRange = document.getSelection()!.getRangeAt(0);
  expect(f.mount.canLeave!()).toBe(false);
  const down = new MouseEvent('pointerdown', { bubbles: true, cancelable: true }); f.button.dispatchEvent(down);
  expect(down.defaultPrevented).toBe(true); expect(document.getSelection()!.toString()).toBe('one');
  f.button.dispatchEvent(new MouseEvent('pointerup', { bubbles: true }));
  await vi.advanceTimersByTimeAsync(899); expect(delayed).not.toHaveBeenCalled();
  try {
    await vi.advanceTimersByTimeAsync(2); expect(delayed).toHaveBeenCalledOnce(); expect(f.mount.canLeave!()).toBe(false);
    f.collapse(); expect(f.mount.canLeave!()).toBe(false); document.getSelection()!.addRange(nativeRange);
  } finally { hold.release(); await tick(); }
  expect((await f.repository.getArticle(f.article.path)).body).toBe('==one== two three');
  expect(f.body.firstChild).toBe(selectedNode); expect(document.getSelection()!.getRangeAt(0)).toBe(nativeRange);
  expect(f.mount.canLeave!()).toBe(true); expect(snapshot.anchor.quote.exact).toBe('one');
  const savedDown = new MouseEvent('pointerdown', { bubbles: true, cancelable: true }); f.button.dispatchEvent(savedDown); expect(savedDown.defaultPrevented).toBe(false);
});
it('keeps queued selections guarded and rebinds their positions to the new inline revision', async () => {
  const f = await fixture(), hold = gate(), original = f.controller.highlight.bind(f.controller);
  const save = vi.spyOn(f.controller, 'highlight').mockImplementationOnce(async (...args) => { await hold.promise; return original(...args); });
  try { f.complete(); f.complete(f.choose(4, 7)); f.collapse(); expect(f.mount.canLeave!()).toBe(false); }
  finally { hold.release(); await tick(); }
  expect(save).toHaveBeenCalledTimes(2); expect(save.mock.calls[0][2].version).not.toBe(save.mock.calls[1][2].version);
  expect((await f.repository.getArticle(f.article.path)).body).toBe('==one== ==two== three'); expect(f.mount.canLeave!()).toBe(true);
});
it('retains failure after collapse and metadata adoption; only a successful retry of that selection clears it', async () => {
  const f = await fixture(); vi.spyOn(f.controller, 'highlight').mockRejectedValueOnce(new Error('Could not save inline highlight'));
  f.complete(); await tick(); expect(f.root.querySelector('.r2-error')?.textContent).toBe('Could not save inline highlight');
  expect(f.mount.canLeave!()).toBe(false); f.collapse(); f.mount.update!({ ...f.article, error: 'Metadata only' }); expect(f.mount.canLeave!()).toBe(false);
  f.complete(f.choose(4, 7)); await tick(); f.collapse(); expect(f.mount.canLeave!()).toBe(false);
  expect(f.root.querySelector('.r2-save-state')?.textContent).toBe('Not fully saved');
  expect(f.root.querySelector('.r2-error')?.textContent).toBe('Could not save inline highlight');
  f.complete(); await tick(); expect(f.mount.canLeave!()).toBe(true);
});
it('does not treat a failed durable save as completed just because refreshed source contains its delimiters', async () => {
  const f = await fixture(), original = f.controller.highlight.bind(f.controller);
  vi.spyOn(f.controller, 'highlight').mockImplementationOnce(async (...args) => { await original(...args); throw new Error('Durability verification failed'); });
  f.complete(); await tick(); f.collapse();
  expect(f.body.querySelector('mark')?.textContent).toBe('one'); expect(f.mount.canLeave!()).toBe(false);
  f.complete(); await tick(); expect(f.mount.canLeave!()).toBe(false);
});
it('uses parsed source positions/quotes, not the article highlight array or matching words elsewhere', async () => {
  const f = await fixture({ source: 'one one' });
  f.mount.update!({ ...f.article, highlights: parseInlineMarkdown('==one== one').highlights }); f.choose(); expect(f.mount.canLeave!()).toBe(false);
  f.complete(); await tick(); f.mount.update!({ ...(await f.repository.getArticle(f.article.path)), highlights: [] });
  expect(f.mount.canLeave!()).toBe(true); f.choose(4, 7); expect(f.mount.canLeave!()).toBe(false);
});
it.each(['different words', '**one** two three'])('rejects externally stale selected DOM (%s) and invalidated generations', async source => {
  const f = await fixture(); f.choose(); f.mount.update!({ ...f.article, body: source }); expect(f.mount.canLeave!()).toBe(false);
  f.collapse(); expect(f.mount.canLeave!()).toBe(true);
  vi.spyOn(f.repository, 'articleGeneration').mockReturnValue(999); expect(f.mount.canLeave!()).toBe(false);
});
it.each(['- one two', '> ==one== two', '`one` two'])('blocks unsupported selections instead of relying on painted highlights: %s', async source => {
  const f = await fixture({ source }); f.choose(); expect(f.mount.canLeave!()).toBe(false); f.complete(); await tick(); f.collapse(); expect(f.mount.canLeave!()).toBe(false);
});
it('blocks a cross-body/footer range even when captureSelection returns null', async () => {
  const f = await fixture(), range = document.createRange(); range.setStart(f.body.querySelector('p')!.firstChild!, 0); range.setEnd(f.button.firstChild!, 7);
  document.getSelection()!.addRange(range); expect(captureSelection(f.body, f.body.dataset.articleVersion!)).toBeNull(); expect(f.mount.canLeave!()).toBe(false);
});
it('freezes delayed selection callbacks and link clicks without changing body HTML or the reading anchor', async () => {
  const position = { marker: 'two three' }, f = await fixture({ source: 'one [[two]] three', position });
  const snapshot = f.choose(), html = f.body.innerHTML, save = vi.spyOn(f.controller, 'highlight'); f.collapse();
  expect(f.mount.canLeave!()).toBe(true); f.mount.setNavigationBusy!(true); f.complete(snapshot);
  const click = new MouseEvent('click', { bubbles: true, cancelable: true }); f.body.querySelector('a')!.dispatchEvent(click);
  expect(click.defaultPrevented).toBe(true); expect(f.body.hasAttribute('inert')).toBe(true); expect(save).not.toHaveBeenCalled();
  expect(f.body.innerHTML).toBe(html); expect(f.mount.getPosition!()).toEqual(position);
  await f.mount.flushPosition!(); expect((await f.repository.getArticle(f.article.path)).readingPosition).toEqual(position);
  f.mount.setNavigationBusy!(false); expect(f.body.hasAttribute('inert')).toBe(false); f.complete(); await tick(); expect(save).toHaveBeenCalledOnce();
});
it('never retargets delayed annotation callbacks to the new path when only position writing is remapped', async () => {
  const f = await fixture(), snapshot = f.choose(), save = vi.spyOn(f.controller, 'highlight'); f.collapse();
  f.mount.setNavigationBusy!(true); const moved = await f.controller.move(f.article.path, 'archive'); f.mount.remapPosition!(moved.path);
  f.complete(snapshot); f.mount.setNavigationBusy!(false); f.complete(snapshot); await tick();
  expect(save).not.toHaveBeenCalled(); expect(f.mount.canLeave!()).toBe(false); expect((await f.repository.getArticle(moved.path)).body).toBe('one two three');
});
it.each(['link', 'highlight'])('rejects a captured %s write runner even if its host does not dispose picker callbacks', async kind => {
  let current!: () => boolean, run!: () => Promise<unknown>;
  const f = await fixture({ source: kind === 'link' ? '[[Before|one]] two' : '==one== two', host: {
    linkMenu: (...args) => { const actions = args[6]!; current = actions.isCurrent; run = () => actions.unlink!(); return () => {}; },
    highlightMenu: (...args) => { current = args[7]!; run = () => args[8]!(() => args[3].deleteHighlight(args[1].path, args[2].id)); return () => {}; },
  } });
  const write = vi.spyOn(f.controller, kind === 'link' ? 'unlink' : 'deleteHighlight');
  f.body.querySelector<HTMLElement>(kind === 'link' ? 'a' : 'mark')!.click(); expect(current()).toBe(true);
  f.mount.setNavigationBusy!(true); expect(current()).toBe(false); await expect(Promise.resolve().then(run)).rejects.toThrow('Article changed');
  f.mount.setNavigationBusy!(false); expect(current()).toBe(false); await expect(Promise.resolve().then(run)).rejects.toThrow('Article changed');
  expect(write).not.toHaveBeenCalled(); expect(f.mount.canLeave!()).toBe(true);
  f.body.querySelector<HTMLElement>(kind === 'link' ? 'a' : 'mark')!.click(); expect(current()).toBe(true);
});
it.each(['link', 'highlight'])('keeps execution revision-bound while recovering a %s failure across a syntax-only revision', async kind => {
  let current!: () => boolean, run!: () => Promise<unknown>;
  const f = await fixture({ source: (kind === 'link' ? '[[Before|one]]' : '==one==') + ' ==two==', host: {
    linkMenu: (...args) => { const actions = args[6]!; current = actions.isCurrent; run = () => actions.unlink!(); return () => {}; },
    highlightMenu: (...args) => { current = args[7]!; run = async () => { const next = await args[8]!(() => args[3].deleteHighlight(args[1].path, args[2].id)); args[6](next); }; return () => {}; },
  } });
  const write = vi.spyOn(f.controller, kind === 'link' ? 'unlink' : 'deleteHighlight').mockRejectedValueOnce(new Error('A failed'));
  const open = () => f.body.querySelector<HTMLElement>(kind === 'link' ? 'a' : 'mark')!.click();
  open(); await expect(run()).rejects.toThrow('A failed'); expect(f.mount.canLeave!()).toBe(false);
  const parsed = parseInlineMarkdown(f.article.body, { stripTitle: f.article.title });
  const updated = await f.controller.deleteHighlight(f.article.path, parsed.highlights.at(-1)!.id); f.mount.update!(updated);
  const calls = write.mock.calls.length;
  expect(current()).toBe(false); await expect(Promise.resolve().then(run)).rejects.toThrow('Article changed'); expect(write).toHaveBeenCalledTimes(calls);
  expect(f.mount.canLeave!()).toBe(false); open(); expect(current()).toBe(true); await run();
  expect((await f.repository.getArticle(f.article.path)).body).toBe('one two'); expect(f.mount.canLeave!()).toBe(true);
  expect(f.root.querySelector('.r2-reading-page > .r2-error')?.textContent).toBe('');
});
it.each(['link', 'highlight'])('does not reuse %s retry identity across canonical text changes', async kind => {
  const f = await fixture({ source: kind === 'link' ? '[[Before|one]] two' : '==one== two' });
  vi.spyOn(f.controller, kind === 'link' ? 'unlink' : 'deleteHighlight').mockRejectedValueOnce(new Error('Original text write failed'));
  const act = () => { f.body.querySelector<HTMLElement>(kind === 'link' ? 'a' : 'mark')!.click(); f.action(kind === 'link' ? 'Unlink' : 'Remove highlight'); };
  act(); await tick();
  // The same range/quote in another text snapshot cannot acknowledge old work.
  await f.store.process(f.article.path, source => source.replace(' two', ' changed'));
  f.mount.update!(await f.repository.getArticle(f.article.path)); act(); await tick();
  expect((await f.repository.getArticle(f.article.path)).body).toBe('one changed');
  expect(f.mount.canLeave!()).toBe(false); expect(f.root.querySelector('.r2-reading-page > .r2-error')?.textContent).toBe('Original text write failed');
});
it('permits archive/next after inline saving and preserves Markdown/position through remap and disposal', async () => {
  const position = { marker: 'two three' }, f = await fixture({ position });
  f.complete(); await tick(); expect(f.mount.canLeave!()).toBe(true); const selectedNode = f.body.firstChild;
  f.mount.setNavigationBusy!(true); await f.mount.flushPosition!(); expect(f.mount.canLeave!()).toBe(true);
  expect(f.body.firstChild).toBe(selectedNode); expect(document.getSelection()!.isCollapsed).toBe(true);
  const moved = await f.controller.move(f.article.path, 'archive'); f.mount.remapPosition!(moved.path); await f.mount();
  const saved = await f.repository.getArticle(moved.path); expect(saved.body).toBe('==one== two three'); expect(saved.readingPosition).toEqual(position);
  const source = await f.store.read(moved.path); expect(source).not.toMatch(/Archive & next|r2-article-end|<nav|## Highlights|## Comments/);
  expect(Object.keys(f.store.snapshot())).toEqual([moved.path]);
  const next = await f.repository.createArticle({ title: 'Next', body: 'next words', url: '', status: 'inbox', extractor: 'manual' });
  const nextMount: ReaderMount = mountReader(f.root, next, f.controller, f.host, () => {}); cleanup.push(nextMount);
  expect(nextMount.canLeave!()).toBe(true); expect(f.root.querySelector('.r2-article-body')!.hasAttribute('inert')).toBe(false);
  f.mount.setNavigationBusy!(false); expect(f.mount.canLeave!()).toBe(false);
});

const operations = [
  { source: '==one== two', selector: 'mark', action: 'Link', method: 'linkHighlight', result: '[[one]] two' },
  { source: '==one== two', selector: 'mark', action: 'Remove highlight', method: 'deleteHighlight', result: 'one two' },
  { source: '[[Before|one]] two', selector: 'a', action: 'Edit link…', method: 'setLinkTarget', result: '[[After|one]] two' },
  { source: '[[Before|one]] two', selector: 'a', action: 'Unlink', method: 'unlink', result: 'one two' },
  { source: '==[[Before|one]]== two', selector: 'a', action: 'Remove highlight', method: 'deleteHighlight', result: '[[Before|one]] two' },
] as const;
for (const native of [false, true]) {
  it.each([
    { from: 'first link', to: 'highlight text' },
    { from: 'first link', to: 'second link' },
    { from: 'highlight text', to: 'second link' },
  ])('recovers ' + (native ? 'native' : 'synthetic') + ' enclosing-highlight removal from $from via $to', async ({ from, to }) => {
    const source = '==before [[First|one]] between [[Second|two]] after==';
    const f = await fixture({ source, native }), write = vi.spyOn(f.controller, 'deleteHighlight').mockRejectedValueOnce(new Error('Remove highlight failed'));
    const remove = (entry: string) => {
      const target = entry === 'highlight text' ? f.body.querySelector('mark')! : f.body.querySelectorAll('a')[entry === 'first link' ? 0 : 1];
      target.click(); f.action('Remove highlight');
    };
    remove(from); await tick();
    expect((await f.repository.getArticle(f.article.path)).body).toBe(source);
    expect(f.mount.canLeave!()).toBe(false); expect(f.root.querySelector('.r2-reading-page > .r2-error')?.textContent).toBe('Remove highlight failed');
    remove(to); await tick();
    expect(write).toHaveBeenCalledTimes(2); expect(write.mock.calls[1][1]).toBe(write.mock.calls[0][1]);
    expect((await f.repository.getArticle(f.article.path)).body).toBe('before [[First|one]] between [[Second|two]] after');
    expect(f.body.querySelector('mark')).toBeNull(); expect(f.body.querySelectorAll('a')).toHaveLength(2);
    expect(f.root.querySelector('.r2-reading-page > .r2-error')?.textContent).toBe('');
    expect(f.root.querySelector('.r2-save-state')?.textContent).toBe('Saved'); expect(f.mount.canLeave!()).toBe(true);
  });
  it.each(operations)('recovers failed ' + (native ? 'native' : 'synthetic') + ' $method after another annotation changes the revision', async operation => {
    // B precedes A and repeats its words: source offsets/IDs change when B is
    // removed, but A's canonical position/quote still identify the failed work.
    const f = await fixture({ source: '==one== ' + operation.source, native });
    const write = vi.spyOn(f.controller, operation.method).mockRejectedValueOnce(new Error('A failed'));
    const targetA = () => [...f.body.querySelectorAll<HTMLElement>(operation.selector)].at(-1)!;
    const editA = () => { targetA().click(); f.action(operation.action); if (operation.action === 'Edit link…') f.chooseTarget('After'); };
    const idA = () => targetA().dataset[operation.selector === 'mark' ? 'inlineHighlightId' : 'inlineLinkId'];
    const firstId = idA(), canonical = buildCanonicalTextIndex(f.body).text;
    editA(); await tick(); expect(f.mount.canLeave!()).toBe(false);
    expect((await f.repository.getArticle(f.article.path)).body).toBe('==one== ' + operation.source);
    f.body.querySelector('mark')!.click(); f.action('Remove highlight'); await tick();
    expect((await f.repository.getArticle(f.article.path)).body).toBe('one ' + operation.source);
    expect(buildCanonicalTextIndex(f.body).text).toBe(canonical); expect(idA()).not.toBe(firstId);
    expect(f.mount.canLeave!()).toBe(false); expect(f.root.querySelector('.r2-reading-page > .r2-error')?.textContent).toBe('A failed');
    editA(); await tick();
    expect(write.mock.calls.at(-1)![1]).not.toBe(write.mock.calls[0][1]);
    expect((await f.repository.getArticle(f.article.path)).body).toBe('one ' + operation.result);
    expect(f.root.querySelector('.r2-reading-page > .r2-error')?.textContent).toBe('');
    expect(f.root.querySelector('.r2-save-state')?.textContent).toBe('Saved'); expect(f.mount.canLeave!()).toBe(true);
  });
  it.each(operations)('guards dispatched ' + (native ? 'native' : 'synthetic') + ' $method writes even after menu dismissal', async operation => {
    const f = await fixture({ source: operation.source, native }), hold = gate(), original = f.store.process.bind(f.store);
    const write = vi.spyOn(f.controller, operation.method); vi.spyOn(f.store, 'process').mockImplementationOnce(async (...args) => { await hold.promise; return original(...args); });
    try {
      f.body.querySelector<HTMLElement>(operation.selector)!.click(); f.action(operation.action);
      if (operation.action === 'Edit link…') f.chooseTarget('After');
      expect(write).toHaveBeenCalledOnce(); expect(f.mount.canLeave!()).toBe(false);
      // Even a forced close cannot erase the independently tracked dispatched write.
      f.mount.setNavigationBusy!(true); f.mount.setNavigationBusy!(false); expect(f.mount.canLeave!()).toBe(false);
    } finally { hold.release(); await tick(); }
    expect((await f.repository.getArticle(f.article.path)).body).toBe(operation.result); expect(f.mount.canLeave!()).toBe(true);
  });
  it.each(['link', 'highlight'])('invalidates ' + (native ? 'native' : 'synthetic') + ' %s picker callbacks across lock/unlock and path remap', async kind => {
    const f = await fixture({ source: kind === 'link' ? '[[Before|one]] two' : '==one== two', native });
    const write = vi.spyOn(f.controller, kind === 'link' ? 'setLinkTarget' : 'linkHighlight');
    f.body.querySelector<HTMLElement>(kind === 'link' ? 'a' : 'mark')!.click(); f.action(kind === 'link' ? 'Edit link…' : 'Link to…');
    expect(f.mount.canLeave!()).toBe(true); f.mount.setNavigationBusy!(true); f.chooseTarget('During', kind === 'highlight');
    f.mount.setNavigationBusy!(false); f.chooseTarget('After unlock', kind === 'highlight'); await tick(); expect(write).not.toHaveBeenCalled();
    const moved = await f.controller.move(f.article.path, 'archive'); f.mount.remapPosition!(moved.path); f.chooseTarget('Old path', kind === 'highlight'); await tick();
    expect(write).not.toHaveBeenCalled(); expect((await f.repository.getArticle(moved.path)).body).toBe(f.article.body);
  });
  it.each(operations)('retains failed ' + (native ? 'native' : 'synthetic') + ' $method writes independently of menu lifetime', async operation => {
    const f = await fixture({ source: operation.source, native }); vi.spyOn(f.controller, operation.method).mockRejectedValueOnce(new Error('Inline write failed'));
    f.body.querySelector<HTMLElement>(operation.selector)!.click(); f.action(operation.action); if (operation.action === 'Edit link…') f.chooseTarget('After'); await tick();
    expect(f.root.querySelector('.r2-reading-page > .r2-error')?.textContent).toBe('Inline write failed'); expect(f.mount.canLeave!()).toBe(false);
    f.mount.setNavigationBusy!(true); f.mount.setNavigationBusy!(false); expect(f.mount.canLeave!()).toBe(false);
    f.body.querySelector<HTMLElement>(operation.selector)!.click(); f.action(operation.action); if (operation.action === 'Edit link…') f.chooseTarget('After'); await tick();
    expect(f.mount.canLeave!()).toBe(true); expect(f.root.querySelector('.r2-reading-page > .r2-error')?.textContent).toBe('');
    expect((await f.repository.getArticle(f.article.path)).body).toBe(operation.result);
  });
}
