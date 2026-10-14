// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import * as render from '../src/reader/render';
import { ReadingSurface } from '../src/reader/surface';
import { VisibleText } from '../src/reader/text';

const first = 'Alpha first paragraph has enough words.';
const second = 'Bravo **second** [inline](https://example.com) text anchors here.';
const markdown = `${first}\n\n${second}`;
const secondMarker = 'Bravo second inline text anchors';
let surface: ReadingSurface;
let width: number, height: number, columns: number;
let notifyResize: () => void;
let frames: Map<number, FrameRequestCallback>, frameId: number;
let position: ReturnType<typeof vi.fn<(marker: string) => void>>;
let disposers: ReturnType<typeof vi.fn>[];
const disconnect = vi.fn(),
  observe = vi.fn();
const originalRects = Object.getOwnPropertyDescriptor(Range.prototype, 'getClientRects');
const originalBounds = Object.getOwnPropertyDescriptor(Range.prototype, 'getBoundingClientRect');

// Deliberately small synthetic boxes: each block occupies one page (or one vertical step).
// These jsdom checks cover arithmetic and lifecycle, not browser layout or device behavior.
function rangeRect(range: Range): DOMRect {
  const block = range.startContainer.parentElement?.closest('p,h2');
  const index = Math.max(0, [...surface.body.querySelectorAll('p,h2')].indexOf(block!));
  return new DOMRect(
    surface.paged ? index * (Math.max(100, width) + 32) + 20 - surface.viewport.scrollLeft : 20,
    surface.paged ? 20 : index * 240 + 20 - surface.viewport.scrollTop,
    240,
    20,
  );
}
function fixture(paged = true, renderError?: (error: unknown) => void): ReadingSurface {
  surface = new ReadingSurface(document.body, paged, position, renderError);
  Object.defineProperties(surface.viewport, {
    clientWidth: { get: () => width },
    clientHeight: { get: () => height },
  });
  Object.defineProperty(surface.flow, 'scrollWidth', {
    get: () => columns * Math.max(100, width) + (columns - 1) * 32,
  });
  vi.spyOn(surface.viewport, 'getBoundingClientRect').mockImplementation(
    () => new DOMRect(0, 0, width, height),
  );
  return surface;
}
it('reports only settled, actually reached paged article boundaries, not a rounded near-final column', () => {
  fixture(true);
  expect(surface.atBoundary(-1)).toBe(false);
  surface.setBody(markdown, '');
  frame();
  expect(surface.atBoundary(-1)).toBe(true);
  expect(surface.atBoundary(1)).toBe(false);
  surface.viewport.scrollLeft = 500;
  expect(surface.canPage(1)).toBe(false); // Existing paging rounds; boundary evidence must not.
  expect(surface.atBoundary(1)).toBe(false);
  expect(surface.atBoundary(-1)).toBe(false);
  surface.viewport.scrollLeft = 664;
  expect(surface.atBoundary(1)).toBe(true);
  width = 0;
  expect(surface.atBoundary(1)).toBe(false);
  width = 300;
  surface.dispose();
  expect(surface.atBoundary(1)).toBe(false);
});

it('reports scroll boundaries only with measured content and no pending restoration', () => {
  fixture(false);
  Object.defineProperty(surface.viewport, 'scrollHeight', { get: () => 1000 });
  surface.setBody(markdown, '');
  frame();
  expect(surface.atBoundary(-1)).toBe(true);
  expect(surface.atBoundary(1)).toBe(false);
  surface.viewport.scrollTop = 400;
  expect(surface.atBoundary(-1)).toBe(false);
  expect(surface.atBoundary(1)).toBe(false);
  surface.viewport.scrollTop = 800;
  expect(surface.atBoundary(1)).toBe(true);
  height = 0;
  expect(surface.atBoundary(1)).toBe(false);
  height = 200;
  surface.restore(secondMarker);
  expect(surface.atBoundary(1)).toBe(false);
});

function frame(): void {
  const pending = [...frames.values()];
  frames.clear();
  for (const callback of pending) callback(0);
}
function select(): Range {
  const range = document.createRange();
  range.setStart(surface.body.querySelector('p')!.firstChild!, 0);
  range.setEnd(range.startContainer, 5);
  document.getSelection()!.addRange(range);
  return range;
}
function deselect(): void {
  document.getSelection()!.removeAllRanges();
  document.dispatchEvent(new Event('selectionchange'));
}
function pointer(type: string, target: EventTarget = surface.body, id = 1): Event {
  const event = new MouseEvent(type, { button: 0, bubbles: true, cancelable: true });
  Object.defineProperty(event, 'pointerId', { value: id });
  target.dispatchEvent(event);
  return event;
}

beforeEach(() => {
  vi.useFakeTimers();
  width = 300;
  height = 200;
  columns = 3;
  frames = new Map();
  frameId = 0;
  position = vi.fn();
  disposers = [];
  observe.mockClear();
  disconnect.mockClear();
  vi.stubGlobal(
    'ResizeObserver',
    class {
      constructor(callback: ResizeObserverCallback) {
        notifyResize = () => callback([], this as unknown as ResizeObserver);
      }
      observe = observe;
      disconnect = disconnect;
    },
  );
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
    frames.set(++frameId, callback);
    return frameId;
  });
  vi.stubGlobal('cancelAnimationFrame', (id: number) => {
    frames.delete(id);
  });
  Object.defineProperty(Range.prototype, 'getClientRects', {
    configurable: true,
    value: function (this: Range) {
      return [rangeRect(this)];
    },
  });
  Object.defineProperty(Range.prototype, 'getBoundingClientRect', {
    configurable: true,
    value: function (this: Range) {
      return rangeRect(this);
    },
  });
  const actual = render.renderBody;
  vi.spyOn(render, 'renderBody').mockImplementation((...args) => {
    const dispose = vi.fn(actual(...args));
    disposers.push(dispose);
    return dispose;
  });
  vi.spyOn(render, 'textBookmark');
  vi.spyOn(render, 'bookmarkRange');
});
afterEach(() => {
  surface?.dispose();
  document.getSelection()?.removeAllRanges();
  document.body.replaceChildren();
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  for (const [key, descriptor] of [
    ['getClientRects', originalRects],
    ['getBoundingClientRect', originalBounds],
  ] as const) {
    if (descriptor) Object.defineProperty(Range.prototype, key, descriptor);
    else Reflect.deleteProperty(Range.prototype, key);
  }
});

it('creates native DOM and renders even an initially empty body', () => {
  fixture().setBody('', 'https://example.com');
  expect(surface.viewport.parentElement).toBe(document.body);
  expect(surface.flow.children).toHaveLength(2);
  expect(surface.body.tagName).toBe('ARTICLE');
  expect(surface.viewport.classList.contains('reader-paged')).toBe(true);
  expect(surface.flow.style.columnGap).toBe('32px');
  expect(surface.flow.style.getPropertyValue('--reader-page-height')).toBe('200px');
  expect(render.renderBody).toHaveBeenCalledOnce();
  expect(observe).toHaveBeenCalledWith(surface.viewport);
  surface.flush();
  expect(position).not.toHaveBeenCalled();
});

it('exposes only successfully displayed source, not queued source', () => {
  fixture();
  expect(surface.displayedBody).toBeUndefined();
  surface.setBody(markdown, '');
  expect(surface.displayedBody).toBe(markdown);
  select();
  surface.setBody('New source.', '');
  expect(surface.displayedBody).toBe(markdown);
  deselect();
  expect(surface.displayedBody).toBe('New source.');
  surface.dispose();
  expect(surface.displayedBody).toBeUndefined();
});

it.each(['selection', 'pointer'] as const)(
  'reports a deferred %s-release rendering failure once and disables the stale surface',
  (gesture) => {
    const failed = vi.fn();
    fixture(true, failed).setBody(markdown, '');
    if (gesture === 'selection') select();
    else pointer('pointerdown');
    const error = new Error('Content is too large.');
    vi.mocked(render.renderBody).mockImplementationOnce(() => {
      throw error;
    });
    surface.setBody('Bad body.', '');
    expect(failed).not.toHaveBeenCalled();
    expect(surface.displayedBody).toBe(markdown);
    if (gesture === 'selection') deselect();
    else pointer('pointerup', document);
    expect(failed).toHaveBeenCalledExactlyOnceWith(error);
    expect(surface.displayedBody).toBeUndefined();
    expect(surface.selection()).toBeUndefined();
    expect(disconnect).toHaveBeenCalledOnce();
    surface.refresh();
    surface.setBody(markdown, '');
    surface.flush();
    notifyResize();
    vi.runAllTimers();
    expect(failed).toHaveBeenCalledOnce();
    expect(position).not.toHaveBeenCalled();
  },
);

it('reports an initial rendering failure through the same callback', () => {
  const failed = vi.fn(),
    error = new Error('Bad Markdown');
  fixture(false, failed);
  vi.mocked(render.renderBody).mockImplementationOnce(() => {
    throw error;
  });
  expect(() => surface.setBody('Bad body.', '')).not.toThrow();
  expect(failed).toHaveBeenCalledExactlyOnceWith(error);
  expect(surface.displayedBody).toBeUndefined();
});

it('caches one text index until the body or URL base changes', () => {
  fixture().setBody(markdown, 'https://example.com');
  surface.flush();
  const index = vi.mocked(render.textBookmark).mock.calls[0][2];
  expect(index).toBeInstanceOf(VisibleText);
  surface.restore(secondMarker);
  frame();
  notifyResize();
  frame();
  surface.flush();
  surface.setBody(markdown, 'https://example.com');
  expect(render.renderBody).toHaveBeenCalledOnce();
  for (const call of vi.mocked(render.bookmarkRange).mock.calls) expect(call[2]).toBe(index);
  for (const call of vi.mocked(render.textBookmark).mock.calls) expect(call[2]).toBe(index);
  surface.setBody(`${markdown}\n\nChanged ending.`, 'https://example.com');
  frame();
  surface.flush();
  expect(vi.mocked(render.textBookmark).mock.lastCall?.[2]).not.toBe(index);
  expect(disposers[0]).toHaveBeenCalledOnce();
  surface.setBody(`${markdown}\n\nChanged ending.`, 'https://other.example');
  expect(render.renderBody).toHaveBeenCalledTimes(3);
  expect(disposers[1]).toHaveBeenCalledOnce();
});

it.each([
  ['# Same **title**\n\nBody.', 'Same title', true],
  ['## Same title\n\nBody.', 'Same title', true],
  ['# Different heading\n\nBody.', 'Display title', false],
  ['Intro.\n\n# Same title', 'Same title', false],
  ['# same title\n\nBody.', 'Same title', false],
] as const)('deduplicates only the synthetic title for %s', (body, title, hidden) => {
  fixture(false).setBody(body, '');
  const authored = surface.body.innerHTML;
  surface.setTitle(title);
  expect(surface.title.hidden).toBe(hidden);
  expect(surface.title.textContent).toBe(title);
  expect(surface.body.innerHTML).toBe(authored);
  expect(surface.displayedBody).toBe(body);
  const heading = surface.body.querySelector<HTMLElement>('h1,h2')!;
  expect(heading.hidden).toBe(false);
  expect(heading.id).toBeTruthy();
  expect(render.bookmarkRange(surface.body, heading.textContent!)?.toString()).toBe(
    heading.textContent,
  );
  expect([...surface.flow.children]).toEqual([surface.title, surface.body]);
  expect(surface.viewport.querySelector('button,.reader-finish')).toBeNull();
});

it('updates title deduplication with deferred rendering without replacing selected authored nodes', () => {
  fixture(false).setBody('# Title\n\nAlpha words.', '');
  surface.setTitle('Title');
  expect(surface.title.hidden).toBe(true);
  const range = select(),
    node = range.startContainer;
  surface.setTitle('New title');
  surface.setBody('# New title\n\nAlpha words.', '');
  expect(surface.title.textContent).toBe('Title');
  expect(range.startContainer).toBe(node);
  expect(document.getSelection()!.toString()).toBe('Alpha');
  deselect();
  expect(surface.title.textContent).toBe('New title');
  expect(surface.title.hidden).toBe(true);
  expect(surface.body.querySelector('h1')!.textContent).toBe('New title');
  surface.setTitle('Different display title');
  expect(surface.title.hidden).toBe(false);
});

it('pages only authored content and the optional title, with no reserved footer column', () => {
  columns = 2;
  fixture().setBody(markdown, '');
  expect(surface.canPage(-1)).toBe(false);
  expect(surface.canPage(1)).toBe(true);
  surface.page(1);
  expect(surface.canPage(1)).toBe(false);
  expect(surface.canPage(-1)).toBe(true);
  surface.page(1);
  expect(surface.viewport.scrollLeft).toBe(332);
  expect(surface.flow.textContent).not.toContain('End of article');
  expect(surface.flow.children).toHaveLength(2);
});

it('clamps page turns and retains the last text bookmark on an image-only page', () => {
  fixture().setBody(`${markdown}\n\n![figure](https://example.com/image.png)`, '');
  surface.page(-1);
  expect(surface.viewport.scrollLeft).toBe(0);
  surface.page(1);
  expect(surface.viewport.scrollLeft).toBe(332);
  expect(position).toHaveBeenLastCalledWith(secondMarker);
  const calls = position.mock.calls.length;
  surface.page(1);
  surface.page(1);
  surface.flush();
  expect(surface.viewport.scrollLeft).toBe(664);
  expect(position).toHaveBeenCalledTimes(calls);
  expect(position.mock.calls.every(([marker]) => !!marker)).toBe(true);
  notifyResize();
  expect(render.bookmarkRange).not.toHaveBeenCalled();
  expect(surface.viewport.scrollLeft).toBe(664);
  frame();
  surface.restore(secondMarker); // An explicit restore overrides the local fallback.
  expect(surface.viewport.scrollLeft).toBe(332);
  expect(position).toHaveBeenCalledTimes(calls);
});

it.each([true, false])(
  'keeps the current paged=%s image-only viewport through late loads and resize',
  (paged) => {
    fixture(paged).setBody(`${markdown}\n\n![figure](https://example.com/image.png)`, '');
    if (paged) surface.page(1);
    else {
      surface.viewport.scrollTop = 260;
      surface.flush();
    }
    expect(position).toHaveBeenLastCalledWith(secondMarker);
    const calls = position.mock.calls.length;
    if (paged) surface.page(1);
    else {
      surface.viewport.scrollTop = 500;
      surface.viewport.dispatchEvent(new Event('scroll'));
    }
    const loadTarget = surface.body.querySelector('img') ?? surface.body;
    loadTarget.dispatchEvent(new Event('load')); // Also overtakes the scroll debounce.
    expect(surface.viewport.scrollLeft).toBe(paged ? 664 : 0);
    expect(surface.viewport.scrollTop).toBe(paged ? 0 : 500);
    frame();
    width = 420;
    height = 180;
    notifyResize();
    frame();
    loadTarget.dispatchEvent(new Event('load'));
    frame();
    surface.flush();
    expect(surface.viewport.scrollLeft).toBe(paged ? 904 : 0);
    expect(surface.viewport.scrollTop).toBe(paged ? 0 : 500);
    expect(render.bookmarkRange).not.toHaveBeenCalled();
    expect(position).toHaveBeenCalledTimes(calls);
    expect(surface.flow.style.getPropertyValue('--reader-page-height')).toBe(paged ? '180px' : '');
    // Returning to text makes the textual anchor usable for reflow again.
    if (paged) surface.page(-1);
    else {
      surface.viewport.scrollTop = 260;
      surface.flush();
    }
    notifyResize();
    expect(render.bookmarkRange).toHaveBeenLastCalledWith(
      surface.body,
      secondMarker,
      expect.any(VisibleText),
    );
  },
);

it('uses the same minimum column width for layout, turning and restoration', () => {
  fixture();
  width = 60;
  surface.setBody(markdown, '');
  expect(surface.flow.style.columnWidth).toBe('100px');
  surface.page(1);
  expect(surface.viewport.scrollLeft).toBe(132);
  surface.restore(secondMarker);
  expect(surface.viewport.scrollLeft).toBe(132);
});

it.each([true, false])(
  'restores a cross-inline bookmark in paged=%s mode without saving the restoration',
  (paged) => {
    fixture(paged).setBody(markdown, '');
    surface.restore(secondMarker);
    expect(surface.viewport.scrollLeft).toBe(paged ? 332 : 0);
    expect(surface.viewport.scrollTop).toBe(paged ? 0 : 260);
    surface.viewport.dispatchEvent(new Event('scroll'));
    surface.flush();
    vi.advanceTimersByTime(500);
    expect(position).not.toHaveBeenCalled();
    frame();
    surface.flush();
    expect(position).toHaveBeenLastCalledWith(secondMarker);
    if (!paged) expect(surface.flow.style.columnWidth).toBe('');
  },
);

it('debounces scroll capture, supports flush, and cancels a queued save on disposal', () => {
  fixture(false).setBody(markdown, '');
  surface.viewport.scrollTop = 260;
  surface.viewport.dispatchEvent(new Event('scroll'));
  vi.advanceTimersByTime(200);
  surface.viewport.dispatchEvent(new Event('scroll'));
  vi.advanceTimersByTime(299);
  expect(position).not.toHaveBeenCalled();
  vi.advanceTimersByTime(1);
  expect(position).toHaveBeenLastCalledWith(secondMarker);
  surface.viewport.dispatchEvent(new Event('scroll'));
  surface.flush();
  expect(position).toHaveBeenCalledTimes(2);
  vi.advanceTimersByTime(300);
  expect(position).toHaveBeenCalledTimes(2);
  surface.viewport.dispatchEvent(new Event('scroll'));
  surface.dispose();
  vi.advanceTimersByTime(500);
  expect(position).toHaveBeenCalledTimes(2);
});

it.each(['body', 'resize'])(
  'captures a pending scroll before a %s update can restore an older bookmark',
  (update) => {
    fixture(false).setBody(markdown, '');
    surface.flush();
    surface.viewport.scrollTop = 260;
    surface.viewport.dispatchEvent(new Event('scroll'));
    if (update === 'body') surface.setBody(`${markdown}\n\nNew ending.`, '');
    else notifyResize();
    expect(position).toHaveBeenLastCalledWith(secondMarker);
    expect(surface.viewport.scrollTop).toBe(260);
  },
);

it.each(['position', 'body disposer'])(
  'does not resume rendering if the %s callback disposes the surface',
  (callback) => {
    fixture(false).setBody(markdown, '');
    if (callback === 'position') {
      position.mockImplementation(() => surface.dispose());
      surface.viewport.dispatchEvent(new Event('scroll'));
    } else disposers[0].mockImplementation(() => surface.dispose());
    surface.setBody('Never rendered.', '');
    expect(render.renderBody).toHaveBeenCalledOnce();
    expect(disposers[0]).toHaveBeenCalledOnce();
  },
);

it('defers the latest body, resize, image reflow and restore while a native selection is active', () => {
  fixture().setBody(markdown, '');
  const range = select(),
    node = range.startContainer;
  surface.setBody(`Superseded draft.\n\n${second}`, '');
  surface.setBody(`Latest draft.\n\n${second}`, '');
  width = 450;
  height = 220;
  notifyResize();
  surface.body.dispatchEvent(new Event('load'));
  surface.restore(secondMarker);
  surface.page(1);
  surface.flush();
  surface.refresh();
  expect(render.renderBody).toHaveBeenCalledOnce();
  expect(disposers[0]).not.toHaveBeenCalled();
  expect(surface.flow.style.columnWidth).toBe('300px');
  expect(surface.viewport.scrollLeft).toBe(0);
  expect(surface.selection()?.quote).toBe('Alpha');
  expect(range.startContainer).toBe(node);
  expect(position).not.toHaveBeenCalled();
  expect(render.bookmarkRange).not.toHaveBeenCalled();
  deselect();
  expect(surface.body.textContent).toContain('Latest draft.');
  expect(render.renderBody).toHaveBeenCalledTimes(2);
  expect(disposers[0]).toHaveBeenCalledOnce();
  expect(surface.flow.style.columnWidth).toBe('450px');
  expect(surface.flow.style.height).toBe('220px');
  expect(surface.viewport.scrollLeft).toBe(482);
});

it.each(['pointerup', 'pointercancel'])(
  'freezes body and geometry from pointerdown through %s, before a range exists',
  (release) => {
    fixture().setBody(markdown, '');
    expect(pointer('pointerdown').defaultPrevented).toBe(false);
    expect(surface.selection()).toBeUndefined();
    surface.setBody(`Latest draft.\n\n${second}`, '');
    width = 420;
    height = 180;
    notifyResize();
    surface.body.dispatchEvent(new Event('load'));
    surface.restore(secondMarker);
    surface.page(1);
    surface.flush();
    surface.refresh();
    expect(render.renderBody).toHaveBeenCalledOnce();
    expect(render.bookmarkRange).not.toHaveBeenCalled();
    expect(surface.flow.style.columnWidth).toBe('300px');
    expect(surface.flow.style.getPropertyValue('--reader-page-height')).toBe('200px');
    expect(surface.viewport.scrollLeft).toBe(0);
    expect(position).not.toHaveBeenCalled();
    pointer(release, document.body); // Release outside the surface is still observed.
    expect(render.renderBody).toHaveBeenCalledTimes(2);
    expect(surface.body.textContent).toContain('Latest draft.');
    expect(surface.flow.style.columnWidth).toBe('420px');
    expect(surface.flow.style.getPropertyValue('--reader-page-height')).toBe('180px');
    expect(surface.viewport.scrollLeft).toBe(452);
  },
);

it('keeps deferring after pointerup while a noncollapsed native selection remains', () => {
  fixture().setBody(markdown, '');
  pointer('pointerdown');
  select();
  surface.setBody('Deferred.', '');
  width = 420;
  notifyResize();
  pointer('pointerup', document);
  expect(render.renderBody).toHaveBeenCalledOnce();
  expect(surface.flow.style.columnWidth).toBe('300px');
  deselect();
  expect(surface.body.textContent).toContain('Deferred.');
  expect(surface.flow.style.columnWidth).toBe('420px');
});

it('waits for every active pointer and releases an interrupted gesture on window blur', () => {
  fixture().setBody(markdown, '');
  pointer('pointerdown');
  pointer('pointerdown', surface.body, 2);
  surface.setBody('Deferred.', '');
  pointer('pointerup', document, 1);
  expect(render.renderBody).toHaveBeenCalledOnce();
  pointer('pointercancel', document, 2);
  expect(render.renderBody).toHaveBeenCalledTimes(2);
  pointer('pointerdown');
  surface.setBody('After blur.', '');
  window.dispatchEvent(new Event('blur'));
  expect(surface.body.textContent).toContain('After blur.');
});

it('retains a blank viewport scrolled to during a gesture even when the debounce expires while frozen', () => {
  fixture(false).setBody(markdown, '');
  surface.viewport.scrollTop = 260;
  surface.flush();
  pointer('pointerdown');
  surface.viewport.scrollTop = 500;
  surface.viewport.dispatchEvent(new Event('scroll'));
  surface.body.dispatchEvent(new Event('load'));
  vi.advanceTimersByTime(300);
  pointer('pointerup', document);
  frame();
  expect(surface.viewport.scrollTop).toBe(500);
  expect(render.bookmarkRange).not.toHaveBeenCalled();
  expect(position).toHaveBeenCalledExactlyOnceWith(secondMarker);
});

it('discards a queued edit when the latest snapshot reverts to the current body', () => {
  fixture().setBody(markdown, 'base');
  select();
  surface.setBody('Obsolete edit.', 'changed-base');
  surface.setBody(markdown, 'base');
  deselect();
  surface.refresh();
  expect(render.renderBody).toHaveBeenCalledOnce();
  expect(disposers[0]).not.toHaveBeenCalled();
  expect(surface.body.textContent).toContain('Alpha');
});

it('protects native selections crossing into the external action row, even though they are not saveable quotes', () => {
  fixture().setBody(markdown, '');
  const action = document.createElement('button');
  action.textContent = 'Next';
  document.body.append(action);
  const range = select();
  range.setEnd(action.firstChild!, 2);
  expect(surface.selection()).toBeUndefined();
  surface.setBody('Deferred.', '');
  width = 400;
  notifyResize();
  expect(surface.body.textContent).toContain('Alpha');
  expect(surface.flow.style.columnWidth).toBe('300px');
  deselect();
  expect(surface.body.textContent).toContain('Deferred.');
  expect(surface.flow.style.columnWidth).toBe('400px');
});

it.each([true, false])(
  'reveals inline heading targets with paged=%s alignment and selection protection',
  (paged) => {
    fixture(paged).setBody(
      `${first}\n\n## A **linked** heading\n\nMore target text follows here.`,
      '',
    );
    const heading = surface.body.querySelector('h2')!;
    select();
    surface.reveal(heading);
    expect(surface.viewport.scrollLeft).toBe(0);
    expect(surface.viewport.scrollTop).toBe(0);
    expect(render.bookmarkRange).not.toHaveBeenCalled();
    deselect();
    expect(surface.viewport.scrollLeft).toBe(paged ? 332 : 0);
    expect(surface.viewport.scrollTop).toBe(paged ? 0 : 260);
    frame();
    vi.mocked(render.bookmarkRange).mockClear();
    surface.reveal(surface.title);
    surface.reveal(document.createElement('h2'));
    const empty = document.createElement('span');
    surface.body.append(empty);
    surface.reveal(empty);
    expect(render.bookmarkRange).not.toHaveBeenCalled();
  },
);

it('ignores stale animation frames and all public/event callbacks after idempotent disposal', () => {
  fixture().setBody(markdown, '');
  surface.restore(secondMarker);
  const stale = [...frames.values()][0];
  surface.restore(secondMarker);
  stale(0);
  surface.flush();
  expect(position).not.toHaveBeenCalled();
  const pending = [...frames.values()][0];
  select();
  pointer('pointerdown');
  surface.setBody('Never rendered.', '');
  notifyResize();
  surface.dispose();
  surface.dispose();
  expect(disconnect).toHaveBeenCalledOnce();
  expect(disposers[0]).toHaveBeenCalledOnce();
  expect(frames.size).toBe(0);
  const previous = surface.viewport.scrollLeft,
    styles = surface.flow.style.cssText;
  vi.mocked(render.bookmarkRange).mockClear();
  vi.mocked(render.textBookmark).mockClear();
  width = 999;
  pending(0);
  stale(0);
  notifyResize();
  deselect();
  pointer('pointerup', document);
  pointer('pointerdown');
  pointer('pointercancel', document);
  window.dispatchEvent(new Event('blur'));
  surface.setBody('Also never rendered.', '');
  surface.refresh();
  surface.restore(first);
  surface.reveal(surface.body);
  surface.page(1);
  surface.flush();
  surface.body.dispatchEvent(new Event('load'));
  surface.viewport.dispatchEvent(new Event('scroll'));
  vi.advanceTimersByTime(1000);
  expect(render.renderBody).toHaveBeenCalledOnce();
  expect(render.bookmarkRange).not.toHaveBeenCalled();
  expect(render.textBookmark).not.toHaveBeenCalled();
  expect(position).not.toHaveBeenCalled();
  expect(disposers[0]).toHaveBeenCalledOnce();
  expect(surface.selection()).toBeUndefined();
  expect(surface.viewport.scrollLeft).toBe(previous);
  expect(surface.flow.style.cssText).toBe(styles);
});
