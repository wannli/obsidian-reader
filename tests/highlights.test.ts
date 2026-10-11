import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { buildCanonicalTextIndex, captureSelection, clearHighlights, createAnchor, paintHighlights, hitTestHighlights,
  rangeFromPosition, resolveAnchor, type ArticleAnchor } from '../src/highlights';
import { resolveHighlightPalette } from '../src/highlights/paint-palette';
import { observePaintChanges } from '../src/highlights/paint-changes';
import { prefersHighlightOverlay } from '../src/highlights/paint-engine';
import { textRangeRects } from '../src/highlights/paint-geometry';

const rangeRectsDescriptor = Object.getOwnPropertyDescriptor(Range.prototype, 'getClientRects');
beforeEach(() => {
  Object.defineProperty(Range.prototype, 'getClientRects', { configurable: true, writable: true, value: () => [] });
  vi.spyOn(navigator, 'userAgent', 'get').mockReturnValue('Mozilla/5.0 AppleWebKit/537.36 Chrome/145.0.0.0 Safari/537.36');
});
function mockRangeRects(rects: () => DOMRect[]) { vi.spyOn(Range.prototype, 'getClientRects').mockImplementation(rects as unknown as () => DOMRectList); }
import type { CompactAnchor } from '../src/types';

function article(html: string, version = 'body-hash-1'): HTMLElement {
  const root = document.createElement('article');
  root.innerHTML = html; root.dataset.articleVersion = version; document.body.append(root);
  return root;
}
function select(root: HTMLElement, quote: string, last = false): Range {
  const index = buildCanonicalTextIndex(root);
  const offset = last ? index.text.lastIndexOf(quote) : index.text.indexOf(quote);
  if (offset < 0) throw new Error('Missing fixture quote');
  const start = Array.from(index.text.slice(0, offset)).length;
  return rangeFromPosition(index, { start, end: start + Array.from(quote).length });
}
function save(root: HTMLElement, quote: string) {
  const anchor = createAnchor(root, select(root, quote), root.dataset.articleVersion!);
  const compact: CompactAnchor = { ...anchor.position, prefix: anchor.quote.prefix,
    suffix: anchor.quote.suffix, version: anchor.articleVersion };
  return JSON.parse(JSON.stringify({ quote: anchor.quote.exact, anchor: compact })) as { quote: string; anchor: CompactAnchor };
}
function restore(root: HTMLElement, saved: ReturnType<typeof save>) {
  const { start, end, prefix, suffix, version } = saved.anchor;
  return resolveAnchor(root, { normalisationVersion: 1, articleVersion: version ?? 'legacy',
    position: { start, end }, quote: { exact: saved.quote, prefix, suffix } } satisfies ArticleAnchor);
}
afterEach(() => {
  document.querySelectorAll<HTMLElement>('article').forEach(clearHighlights);
  document.getSelection()?.removeAllRanges(); document.body.replaceChildren();
  for (const element of [document.body, document.documentElement]) { element.className = ''; element.removeAttribute('style'); }
  document.querySelectorAll('[data-test-palette]').forEach(element => element.remove());
  vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.useRealTimers();
  if (rangeRectsDescriptor) Object.defineProperty(Range.prototype, 'getClientRects', rangeRectsDescriptor);
  else Reflect.deleteProperty(Range.prototype, 'getClientRects');
});

it.each([
  ['甲😀e\u0301 אבג مرحبا 👩‍👩‍👧', '甲😀e\u0301 אבג مرحبا 👩‍👩‍👧'],
  ['<p> Hel<em>lo</em>&nbsp;world</p><p>next<br>line</p>', 'Hello world next line'],
  ['<table><tr><td>A &amp; B</td><td>C</td></tr></table><pre>x\n  y</pre>', 'A & B C x y'],
  ['\u2003a\u0085b\u202fc\u3000', 'a b c'],
  ['a<span hidden>bad</span><i aria-hidden="true">bad</i><b data-reader-ui>bad</b><script>bad</script>b', 'ab'],
])('indexes canonical Unicode/DOM text: %s', (html, expected) => {
  const root = article(html), index = buildCanonicalTextIndex(root);
  expect(index.text).toBe(expected);
  expect(index.codePoints).toEqual(Array.from(expected));
  const saved = save(root, expected), result = restore(root, saved);
  expect(saved.anchor.end).toBe(Array.from(expected).length);
  expect(result.state).toBe('resolved');
});
it('uses UTF-16 native boundaries, snaps surrogate edges and preserves decomposed accents', () => {
  const root = article('  😀e\u0301  '), range = document.createRange();
  range.setStart(root.firstChild!, 3); range.setEnd(root.firstChild!, 8);
  const anchor = createAnchor(root, range, 'v1'), index = buildCanonicalTextIndex(root);
  expect(anchor.quote.exact).toBe('😀e\u0301'); expect(anchor.position).toEqual({ start: 0, end: 3 });
  expect(index.units[0].end.offset).toBe(4); expect(index.units[2].value).toBe('\u0301');
});
it('restores compact anchors across changed markup and shifted body fingerprints', () => {
  const root = article(`<p>${'a'.repeat(40)} 甲😀 e\u0301 ${'z'.repeat(40)}</p>`);
  const saved = save(root, '甲😀 e\u0301');
  expect(restore(root, saved)).toMatchObject({ state: 'resolved', method: 'position' });
  root.innerHTML = `<p>Inserted</p><p>${'a'.repeat(40)} 甲<em>😀</em> e\u0301 ${'z'.repeat(40)}</p>`;
  root.dataset.articleVersion = 'body-hash-2';
  expect(restore(root, saved)).toMatchObject({ state: 'resolved', method: 'quote',
    position: { start: saved.anchor.start + 9, end: saved.anchor.end + 9 } });
  delete saved.anchor.version;
  expect(restore(root, saved)).toMatchObject({ state: 'resolved', method: 'quote' });
});
it('verifies exact text and context even when the version is unchanged', () => {
  const root = article('left target right'), saved = save(root, 'target');
  root.textContent = 'left tamper right';
  expect(restore(root, saved)).toEqual({ state: 'orphaned', reason: 'not-found' });
  root.textContent = 'else target where';
  expect(restore(root, saved)).toEqual({ state: 'orphaned', reason: 'context-mismatch' });
});
it.each([['same same', 'same'], ['aaaa', 'aaa']])('orphans ambiguous and overlapping quotes: %s', (text, quote) => {
  const root = article(text), saved = save(root, quote);
  saved.anchor.prefix = ''; saved.anchor.suffix = ''; delete saved.anchor.version;
  expect(restore(root, saved)).toEqual({ state: 'orphaned', reason: 'ambiguous' });
});
it('uses saved context, not proximity, when a position points at the wrong duplicate', () => {
  const root = article('left repeated right. other repeated end'), saved = save(root, 'repeated');
  const wrong = createAnchor(root, select(root, 'repeated', true), root.dataset.articleVersion!);
  saved.anchor = { ...saved.anchor, ...wrong.position };
  expect(restore(root, saved)).toMatchObject({ state: 'resolved', method: 'quote', position: { start: 5, end: 13 } });
});
it('never lets a structural path break quote ambiguity or contradict a valid position', () => {
  const text = `${'a'.repeat(40)} target ${'b'.repeat(40)}`, root = article(`<p>${text}</p><p>${text}</p>`);
  const one = createAnchor(root, select(root, 'target'), root.dataset.articleVersion!);
  const two = createAnchor(root, select(root, 'target', true), root.dataset.articleVersion!);
  for (const position of [one.position, { start: 900, end: 906 }]) {
    expect(resolveAnchor(root, { ...one, position, structural: two.structural }))
      .toEqual({ state: 'orphaned', reason: 'ambiguous' });
  }
});
it('rejects malformed anchors, unsupported normalization and partial-surrogate matches', () => {
  const root = article('😀 target'), anchor = createAnchor(root, select(root, 'target'), 'v1');
  for (const value of [null, [], {}, { ...anchor, quote: null }, { ...anchor, normalisationVersion: 99 },
    { ...anchor, position: { start: 0.5, end: 6.5 } }, { ...anchor, position: { start: -1, end: 5 } }]) {
    expect(resolveAnchor(root, value).state).toBe('orphaned');
  }
  expect(resolveAnchor(root, { ...anchor, quote: { exact: '\ude00', prefix: '', suffix: '' },
    position: { start: 0, end: 1 } })).toEqual({ state: 'orphaned', reason: 'not-found' });
});
it('keeps a snapshot after selection collapses, without changing native selection', () => {
  const root = article('<p>Hello <em>world</em></p>'), range = select(root, 'Hello world');
  const selection = document.getSelection()!; selection.addRange(range);
  const snapshot = captureSelection(root, root.dataset.articleVersion!)!;
  expect(selection.getRangeAt(0)).toBe(range); expect(snapshot.range).not.toBe(range);
  selection.removeAllRanges(); expect(snapshot.range.toString()).toBe('Hello world');
  expect(captureSelection(root, 'v1')).toBeNull();
  selection.addRange(select(article('outside'), 'outside')); expect(captureSelection(root, 'v1')).toBeNull();
});
it.each(['native', 'forced fallback', 'partial WebKit'])('paints %s without mutating article nodes or selection', (mode) => {
  const registry = new Map<string, unknown>(); vi.stubGlobal('CSS', { highlights: registry });
  vi.stubGlobal('Highlight', class { constructor(..._ranges: Range[]) { if (mode === 'partial WebKit') throw Error('partial'); } });
  const root = article('one <em>two</em> three'), range = select(root, 'one two');
  document.getSelection()!.addRange(range);
  vi.spyOn(root, 'getBoundingClientRect').mockReturnValue(new DOMRect(0, 0, 500, 500));
  mockRangeRects(() => [new DOMRect(10, 20, 70, 18)]);
  const nodes = [...root.childNodes], html = root.innerHTML, observer = new MutationObserver(() => {});
  observer.observe(root, { subtree: true, childList: true, characterData: true, attributes: true });
  const highlights = [{ id: 'unsafe } CSS id', range, colour: 'yellow' as const }];
  const dispose = paintHighlights(root, highlights, { forceFallback: mode === 'forced fallback' });
  expect(root.innerHTML).toBe(html); expect([...root.childNodes]).toEqual(nodes);
  expect(document.getSelection()!.getRangeAt(0)).toBe(range); expect(range.toString()).toBe('one two');
  if (mode === 'native') {
    expect([...registry.keys()][0]).toMatch(/^readerhl-\d+-yellow$/);
    expect(document.querySelector('style[data-reader-ui]')!.textContent).toContain('rgb(248, 230, 163)');
    expect(document.querySelector('style[data-reader-ui]')!.textContent).not.toContain('var(');
  } else {
    const layer = document.querySelector<HTMLElement>('[data-reader-ui="highlight-overlay"]')!;
    expect(root.contains(layer)).toBe(false); expect(layer.style.pointerEvents).toBe('none');
    expect(layer.children).toHaveLength(1); expect(layer.style.zIndex).toBe('1');
  }
  paintHighlights(root, highlights, { forceFallback: true }); dispose();
  expect(document.querySelector('[data-reader-ui="highlight-overlay"]')).not.toBeNull();
  clearHighlights(root); clearHighlights(root);
  expect(registry.size).toBe(0); expect(document.querySelector('[data-reader-ui]')).toBeNull();
  expect(observer.takeRecords()).toEqual([]); observer.disconnect();
});
it('clips fallback paint and translates/scales coordinates without wrapping text', () => {
  vi.useFakeTimers();
  const root = article('hello'), host = document.createElement('section'), scroll = document.createElement('div');
  host.className = 'r2-reading-page'; scroll.className = 'r2-reader-scroll'; scroll.style.overflowY = 'auto';
  document.body.append(scroll); scroll.append(host); host.append(root);
  const range = select(root, 'hello');
  vi.spyOn(root, 'getBoundingClientRect').mockReturnValue(new DOMRect(100, 200, 500, 500));
  vi.spyOn(scroll, 'getBoundingClientRect').mockReturnValue(new DOMRect(110, 220, 60, 40));
  const rects = vi.fn(() => [new DOMRect(120, 240, 70, 30)]);
  mockRangeRects(rects);
  const original = HTMLElement.prototype.getBoundingClientRect;
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
    return this.dataset.readerUi === 'highlight-overlay' ? new DOMRect(100, 200, 2, 2) : original.call(this);
  });
  const dispose = paintHighlights(root, [{ id: 'a', range, colour: 'yellow' }], { forceFallback: true });
  const box = host.querySelector<HTMLElement>('[data-reader-ui] span')!;
  expect([box.style.left, box.style.top, box.style.width, box.style.height]).toEqual(['10px', '20px', '35px', '10px']);
  expect(box.style.backgroundColor).toBe('rgb(248, 230, 163)');
  expect(box.parentElement!.parentElement).toBe(host); expect(host.style.isolation).toBe('isolate');
  rects.mockReturnValue([new DOMRect(120, 230, 70, 30)]); scroll.dispatchEvent(new Event('scroll'));
  vi.advanceTimersByTime(20); expect(host.querySelector<HTMLElement>('[data-reader-ui] span')!.style.top).toBe('15px');
  scroll.dispatchEvent(new Event('scroll')); dispose();
  const calls = rects.mock.calls.length; vi.advanceTimersByTime(20);
  scroll.dispatchEvent(new Event('scroll')); vi.advanceTimersByTime(20); expect(rects).toHaveBeenCalledTimes(calls);
  expect(host.style.isolation).toBe(''); expect(root.innerHTML).toBe('hello');
});

function paintFixture() {
  const root = article('one <em>two</em> three'), range = select(root, 'one two');
  vi.spyOn(root, 'getBoundingClientRect').mockReturnValue(new DOMRect(0, 0, 500, 500));
  mockRangeRects(() => [new DOMRect(10, 20, 70, 24)]);
  return { root, range, items: [{ id: 'yellow', range, colour: 'yellow' as const }, { id: 'linked', range, colour: 'blue' as const }] };
}
function nativeRegistry() {
  const registry = new Map<string, unknown>(); vi.stubGlobal('CSS', { highlights: registry });
  vi.stubGlobal('Highlight', class { constructor(..._ranges: Range[]) {} });
  return registry;
}
async function flushPaint() { await Promise.resolve(); vi.advanceTimersByTime(40); await Promise.resolve(); }

it.each(['light', 'dark'])('resolves concrete %s palette defaults without mutating article text', theme => {
  document.body.className = 'theme-' + theme;
  const { root, range } = paintFixture(), before = root.innerHTML;
  document.getSelection()!.addRange(range);
  const palette = resolveHighlightPalette(root);
  expect(palette.yellow).toBe(theme === 'dark' ? 'rgb(88, 67, 21)' : 'rgb(248, 230, 163)');
  expect(palette.blue).toBe(theme === 'dark' ? 'rgb(24, 63, 89)' : 'rgb(196, 225, 245)');
  expect(root.innerHTML).toBe(before); expect(document.getSelection()!.getRangeAt(0)).toBe(range);
  expect(document.querySelector('[data-reader-ui]')).toBeNull();
});
it.each(['light', 'dark'])('uses the same article-local %s colours in native and external fallback paint', theme => {
  nativeRegistry(); document.body.className = 'theme-' + theme;
  const { root, items } = paintFixture();
  root.style.setProperty('--r2-highlight-yellow', '#826420'); root.style.setProperty('--r2-highlight-blue', '#234b6a');
  const expected = resolveHighlightPalette(root);
  paintHighlights(root, items);
  const style = document.querySelector<HTMLStyleElement>('style[data-reader-ui="highlight-styles"]')!;
  expect(style).not.toBeNull(); expect(style.textContent).not.toContain('var(');
  const rules = [...style.sheet!.cssRules] as CSSStyleRule[];
  const native = rules.map(rule => rule.style.getPropertyValue('background-color'));
  expect(native).toEqual(expect.arrayContaining([expected.yellow, expected.blue]));
  expect(rules.every(rule => !rule.style.getPropertyValue('color'))).toBe(true);
  paintHighlights(root, items, { forceFallback: true });
  const spans = [...document.querySelectorAll<HTMLElement>('[data-reader-ui="highlight-overlay"] span')];
  expect(spans.map(span => span.style.backgroundColor)).toEqual(native);
  expect(spans.map(span => span.dataset.readerHighlightColour)).toEqual(['yellow', 'blue']);
  expect(root.contains(spans[0])).toBe(false);
});
it.each([false, true])('refreshes theme colours and cancels observers/timers on cleanup (fallback=%s)', async forceFallback => {
  vi.useFakeTimers(); const registry = nativeRegistry(), { root, items } = paintFixture();
  document.body.className = 'theme-light'; const dispose = paintHighlights(root, items, { forceFallback });
  const painted = () => forceFallback ? document.querySelector<HTMLElement>('[data-reader-ui="highlight-overlay"] span')?.style.backgroundColor
    : document.querySelector('style[data-reader-ui="highlight-styles"]')?.textContent;
  expect(painted()).toContain('rgb(248, 230, 163)'); document.body.className = 'theme-dark'; await flushPaint();
  expect(painted()).toContain('rgb(88, 67, 21)');
  document.body.className = 'theme-light'; await Promise.resolve(); dispose(); dispose(); await flushPaint();
  expect(registry.size).toBe(0); expect(document.querySelector('[data-reader-ui]')).toBeNull();
  document.body.className = 'theme-dark'; await flushPaint(); expect(document.querySelector('[data-reader-ui]')).toBeNull();
});
it('coalesces observed ancestor/stylesheet/media changes, ignores renderer styles and disconnects', async () => {
  vi.useFakeTimers(); const root = article('observer'), refresh = vi.fn(), media = new EventTarget();
  vi.stubGlobal('matchMedia', vi.fn(() => media));
  const dispose = observePaintChanges(root, refresh);
  try {
    document.body.className = 'theme-dark'; document.body.style.color = 'white'; media.dispatchEvent(new Event('change'));
    await flushPaint(); expect(refresh).toHaveBeenCalledTimes(1);
    const own = document.createElement('style'); own.dataset.readerUi = 'highlight-styles'; document.head.append(own);
    own.textContent = '::highlight(own) { background-color: red; }'; await flushPaint();
    expect(refresh).toHaveBeenCalledTimes(1); own.remove();
    const sheet = document.createElement('style'); sheet.dataset.testPalette = ''; document.head.append(sheet);
    await flushPaint(); expect(refresh).toHaveBeenCalledTimes(2);
    sheet.textContent = 'body { color: white; }'; await flushPaint(); expect(refresh).toHaveBeenCalledTimes(3);
    document.body.className = 'theme-light'; await Promise.resolve(); dispose(); await flushPaint();
    media.dispatchEvent(new Event('change')); sheet.textContent = 'body { color: black; }'; await flushPaint();
    expect(refresh).toHaveBeenCalledTimes(3);
  } finally { dispose(); }
});
it('keeps hit targets on original ranges, rejects zero-area fragments and respects visible clipping', () => {
  const { root, range, items } = paintFixture();
  expect(hitTestHighlights(root, items, 20, 43)).toEqual(items); // Near original bottom, not a reduced paint band.
  expect(hitTestHighlights(root, items, 20, 45)).toEqual([]);
  expect(hitTestHighlights(root, items, -1, 25)).toEqual([]);
  vi.spyOn(root, 'getBoundingClientRect').mockReturnValue(new DOMRect(0, 0, 500, 30));
  expect(hitTestHighlights(root, items, 20, 43)).toEqual([]);
  Object.defineProperty(range, 'getClientRects', { configurable: true, value: () => [new DOMRect(10, 20, 0, 24)] });
  expect(hitTestHighlights(root, items, 10, 25)).toEqual([]);
});

it.each([
  ['Safari desktop / desktop-mode iPad', 'AppleWebKit/605.1.15 Version/26.0 Safari/605.1.15', true],
  ['iPhone Safari', 'iPhone AppleWebKit/605.1.15 Mobile/15E148 Safari/604.1', true],
  ['Chrome iOS', 'iPhone AppleWebKit/605.1.15 CriOS/145.0 Mobile/15E148 Safari/604.1', true],
  ['Firefox iOS', 'iPhone AppleWebKit/605.1.15 FxiOS/145.0 Mobile/15E148 Safari/605.1.15', true],
  ['Edge iOS', 'iPhone AppleWebKit/605.1.15 EdgiOS/145.0 Mobile/15E148 Safari/605.1.15', true],
  ['Chrome desktop', 'AppleWebKit/537.36 Chrome/145.0.0.0 Safari/537.36', false],
  ['Chrome Android', 'Android 15 AppleWebKit/537.36 Chrome/145.0.0.0 Mobile Safari/537.36', false],
  ['Firefox desktop', 'Gecko/20100101 Firefox/145.0', false],
])('deterministically selects the approved engine policy: %s', (_name, userAgent, overlay) => {
  expect(prefersHighlightOverlay(userAgent)).toBe(overlay);
  const registry = nativeRegistry(), { root, items } = paintFixture();
  vi.spyOn(navigator, 'userAgent', 'get').mockReturnValue(userAgent);
  paintHighlights(root, items);
  expect(registry.size).toBe(overlay ? 0 : 2);
  expect(document.querySelectorAll('[data-reader-ui="highlight-overlay"]').length).toBe(overlay ? 1 : 0);
});
it.each(['missing', 'second-registration-throws'])('rolls back native resources before %s fallback', failure => {
  const registry = nativeRegistry(), { root, items } = paintFixture(); let calls = 0;
  if (failure === 'missing') vi.stubGlobal('Highlight', undefined);
  else vi.stubGlobal('Highlight', class { constructor() { if (++calls === 2) throw Error('partial registry'); } });
  paintHighlights(root, items);
  expect(registry.size).toBe(0); expect(document.querySelector('style[data-reader-ui="highlight-styles"]')).toBeNull();
  expect(document.querySelectorAll('[data-reader-ui="highlight-overlay"] span')).toHaveLength(2);
});
it('extracts only selected text fragments, deduplicates and rejects zero/nonfinite/container rectangles', () => {
  const root = article('<p>before <em>selected</em> after</p><p>next</p>'), range = select(root, 'selected after');
  const original = { html: root.innerHTML, start: range.startContainer, startOffset: range.startOffset, end: range.endContainer, endOffset: range.endOffset };
  const calls: { text: string; start: number; end: number }[] = [];
  vi.spyOn(Range.prototype, 'getClientRects').mockImplementation(function (this: Range) {
    expect(this.startContainer.nodeType).toBe(Node.TEXT_NODE); expect(this.endContainer).toBe(this.startContainer);
    calls.push({ text: this.toString(), start: this.startOffset, end: this.endOffset });
    const rect = new DOMRect(10, 20, 50, 18);
    return [rect, rect, new DOMRect(1, 2, 0, 18), new DOMRect(1, 2, 20, 0), new DOMRect(NaN, 2, 20, 18)] as unknown as DOMRectList;
  });
  const boxes = textRangeRects(range);
  expect(boxes).toHaveLength(1); expect(boxes[0]).toMatchObject({ left: 10, right: 60, top: 20, bottom: 38 });
  expect(calls.map(call => call.text)).toEqual(['selected', ' after']);
  expect({ html: root.innerHTML, start: range.startContainer, startOffset: range.startOffset, end: range.endContainer, endOffset: range.endOffset }).toEqual(original);
  range.collapse(); expect(textRangeRects(range)).toEqual([]);
});
it('bounds text-fragment traversal to a small selected interval near the end of a long article', () => {
  const root = article(Array.from({ length: 1000 }, (_, i) => `<p>paragraph ${i} content</p>`).join(''));
  const range = document.createRange(); range.setStart(root.children[995].firstChild!, 2); range.setEnd(root.children[996].firstChild!, 5);
  mockRangeRects(() => [new DOMRect(10, 20, 50, 18)]);
  const createWalker = document.createTreeWalker.bind(document); let advances = 0;
  vi.spyOn(document, 'createTreeWalker').mockImplementation((...args) => {
    const walker = createWalker(...args), next = walker.nextNode.bind(walker);
    vi.spyOn(walker, 'nextNode').mockImplementation(() => { advances++; return next(); }); return walker;
  });
  expect(textRangeRects(range).length).toBeGreaterThan(0);
  expect(advances).toBeLessThanOrEqual(6);
});
