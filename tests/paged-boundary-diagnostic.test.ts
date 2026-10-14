// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import * as render from '../src/reader/render';
import { ReadingSurface } from '../src/reader/surface';

let surface: ReadingSurface | undefined;
let frames: Map<number, FrameRequestCallback>;
let frameId: number;
let notifyResize: () => void;
beforeEach(() => {
  frames = new Map();
  frameId = 0;
  vi.stubGlobal(
    'ResizeObserver',
    class {
      constructor(callback: ResizeObserverCallback) {
        notifyResize = () => callback([], this as unknown as ResizeObserver);
      }
      observe() {}
      disconnect() {}
    },
  );
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
    frames.set(++frameId, callback);
    return frameId;
  });
  vi.stubGlobal('cancelAnimationFrame', (id: number) => frames.delete(id));
  // Exercise boundary arithmetic, not jsdom text geometry or position writes.
  vi.spyOn(render, 'textBookmark').mockReturnValue('');
});
afterEach(() => {
  surface?.dispose();
  surface = undefined;
  document.getSelection()?.removeAllRanges();
  document.body.replaceChildren();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function fixture(
  usedWidth: number,
  { paged = true, ready = true, columns = 5, trailingInset = 0 } = {},
) {
  const gap = 32,
    height = 200,
    contentWidth = columns * usedWidth + (columns - 1) * gap,
    maxLeft = contentWidth + trailingInset - usedWidth;
  const metrics = {
    clientWidth: Math.round(usedWidth),
    clientHeight: height,
    scrollWidth: Math.round(contentWidth + trailingInset),
    scrollHeight: 1001,
    flowWidth: Math.round(contentWidth),
  };
  let left = 0;
  const current = new ReadingSurface(document.body, paged, vi.fn());
  surface = current;
  // CSSOM client/scroll dimensions are integers; scrollLeft may be fractional.
  // Model full columns at their used CSS width and actual scroll clamping. These
  // are synthetic inputs, not Boox measurements or evidence of its paging mode.
  Object.defineProperties(current.viewport, {
    clientWidth: { get: () => metrics.clientWidth },
    clientHeight: { get: () => metrics.clientHeight },
    scrollWidth: { get: () => metrics.scrollWidth },
    scrollHeight: { get: () => metrics.scrollHeight },
    scrollLeft: {
      get: () => left,
      set: (value: number) => {
        left = Math.max(0, Math.min(maxLeft, value));
      },
    },
  });
  Object.defineProperty(current.flow, 'scrollWidth', { get: () => metrics.flowWidth });
  if (ready) current.setBody('Synthetic article text.', '');
  return { current, maxLeft, metrics };
}

// Unlike the defensive extent fixtures above, this model follows the width that
// layout assigns. It verifies the CSS/stride contract, not actual Chromium layout.
function layoutFixture(availableWidth: number) {
  const current = new ReadingSurface(document.body, true, vi.fn());
  surface = current;
  let width = availableWidth,
    left = 0;
  const column = () => parseFloat(current.flow.style.width) || width;
  const extent = () => 9 * column() + 8 * 32;
  const maxLeft = () => Math.max(0, extent() - width);
  Object.defineProperties(current.viewport, {
    clientWidth: { get: () => Math.round(width) },
    clientHeight: { value: 200 },
    scrollWidth: { get: () => Math.round(extent()) },
    scrollLeft: {
      get: () => left,
      set: (value: number) => {
        left = Math.max(0, Math.min(maxLeft(), value));
      },
    },
  });
  Object.defineProperty(current.flow, 'scrollWidth', { get: () => Math.round(extent()) });
  current.setBody('Synthetic article text.', '');
  return {
    current,
    maxLeft,
    resize(value: number) {
      width = value;
      notifyResize();
    },
  };
}

it.each([299.6, 300.4, 366, 719.25])(
  'aligns flow width and page stride without a ninth micro-page at %s px',
  (availableWidth) => {
    const { current, maxLeft } = layoutFixture(availableWidth);
    const width = Math.round(availableWidth),
      stride = width + 32;
    expect(current.flow.style.width).toBe(`${width}px`);
    expect(current.flow.style.columnWidth).toBe(`${width}px`);
    for (let step = 1; step <= 8; step++) {
      expect(current.atBoundary(1)).toBe(false);
      expect(current.canPage(1)).toBe(true);
      current.page(1);
      expect(current.viewport.scrollLeft).toBeCloseTo(Math.min(step * stride, maxLeft()));
    }
    expect(maxLeft() - current.viewport.scrollLeft).toBeLessThan(1);
    expect(current.atBoundary(1)).toBe(true);
    expect(current.canPage(1)).toBe(false);
    const end = current.viewport.scrollLeft;
    current.page(1);
    expect(current.viewport.scrollLeft).toBe(end);
    current.viewport.scrollLeft = end - 5;
    expect(current.atBoundary(1)).toBe(false);
  },
);

it('updates flow width and stride together on resize without resetting the current page', () => {
  const { current, resize } = layoutFixture(300.4);
  current.page(1);
  current.page(1);
  expect(current.viewport.scrollLeft).toBe(664);
  resize(719.25);
  expect(current.flow.style.width).toBe('719px');
  expect(current.flow.style.columnWidth).toBe('719px');
  expect(current.viewport.scrollLeft).toBe(1502);
  const pending = [...frames.values()];
  frames.clear();
  for (const callback of pending) callback(0);
  current.page(1);
  expect(current.viewport.scrollLeft).toBe(2253);
});

it('defers resized flow width and stride together during a native selection', () => {
  const { current, resize } = layoutFixture(300.4);
  const range = document.createRange();
  range.selectNodeContents(current.body);
  document.getSelection()!.addRange(range);
  resize(366.4);
  expect(current.flow.style.width).toBe('300px');
  expect(current.flow.style.columnWidth).toBe('300px');
  document.getSelection()!.removeAllRanges();
  document.dispatchEvent(new Event('selectionchange'));
  expect(current.flow.style.width).toBe('366px');
  expect(current.flow.style.columnWidth).toBe('366px');
});

it('uses the same minimum width for the paged flow and stride', () => {
  const { current } = layoutFixture(60.4);
  expect(current.flow.style.width).toBe('100px');
  expect(current.flow.style.columnWidth).toBe('100px');
  current.page(1);
  expect(current.viewport.scrollLeft).toBe(132);
});

it('leaves scroll-mode flow width under CSS control', () => {
  const { current } = fixture(300.4, { paged: false });
  expect(current.flow.style.width).toBe('');
  notifyResize();
  expect(current.flow.style.width).toBe('');
  expect(current.flow.style.columnWidth).toBe('');
});

it.each([299.6, 300, 300.4])(
  'recognizes the reachable final page at %s px used column width',
  (usedWidth) => {
    const { current, maxLeft } = fixture(usedWidth);
    expect(current.atBoundary(-1)).toBe(true);
    expect(current.atBoundary(1)).toBe(false);
    expect(current.canPage(-1)).toBe(false);
    expect(current.canPage(1)).toBe(true);
    for (let i = 0; i < 6; i++) current.page(1);
    expect(current.viewport.scrollLeft).toBeCloseTo(maxLeft);
    expect(current.atBoundary(-1)).toBe(false);
    expect(current.atBoundary(1)).toBe(true);
    // The same reached endpoint must let both keyboard and existing Next routing advance.
    expect(current.canPage(1)).toBe(false);
    expect(current.canPage(-1)).toBe(true);
    const reached = current.viewport.scrollLeft;
    current.page(1);
    expect(current.viewport.scrollLeft).toBe(reached);
    expect(current.atBoundary(1)).toBe(true);
    current.viewport.scrollLeft = 0;
    expect(current.atBoundary(-1)).toBe(true);
    expect(current.atBoundary(1)).toBe(false);
  },
);

it.each([299.6, 300, 300.4])(
  'does not hand off before the reachable end at %s px used column width',
  (usedWidth) => {
    const { current, maxLeft } = fixture(usedWidth);
    current.viewport.scrollLeft = maxLeft - 4;
    expect(current.atBoundary(1)).toBe(false);
    expect(current.atBoundary(-1)).toBe(false);
    if (usedWidth <= 300) expect(current.canPage(1)).toBe(false);
  },
);

it.each([
  { usedWidth: 300.4, columns: 5 },
  { usedWidth: 417.25, columns: 7 },
  { usedWidth: 281.2, columns: 11 },
])(
  'keeps the final content reachable without a phantom Next page at $usedWidth px / $columns columns',
  ({ usedWidth, columns }) => {
    const { current, maxLeft } = fixture(usedWidth, { columns });
    current.viewport.scrollLeft = maxLeft - 4;
    expect(current.atBoundary(1)).toBe(false);
    expect(current.canPage(1)).toBe(true);
    current.page(1);
    expect(current.viewport.scrollLeft).toBeCloseTo(maxLeft);
    expect(current.atBoundary(1)).toBe(true);
    expect(current.canPage(1)).toBe(false);
  },
);

it('uses viewport extent to cap a nominal endpoint, not flow overflow alone', () => {
  const { current, maxLeft, metrics } = fixture(299.6);
  metrics.flowWidth += 400;
  current.viewport.scrollLeft = maxLeft - 4;
  expect(current.atBoundary(1)).toBe(false);
  expect(current.canPage(1)).toBe(true);
  current.viewport.scrollLeft = maxLeft;
  expect(current.atBoundary(1)).toBe(true);
  expect(current.canPage(1)).toBe(false);
});

it('does not turn an unready or pending-restore phantom page into an advance', () => {
  const { current, maxLeft } = fixture(300.4, { ready: false });
  current.viewport.scrollLeft = maxLeft;
  expect(current.atBoundary(1)).toBe(false);
  expect(current.canPage(1)).toBe(true);
  current.setBody('Synthetic article text.', '');
  expect(current.atBoundary(1)).toBe(true);
  expect(current.canPage(1)).toBe(false);
  const range = document.createRange();
  range.selectNodeContents(current.body);
  document.getSelection()!.addRange(range);
  current.restore('missing marker');
  expect(current.atBoundary(1)).toBe(false);
  expect(current.canPage(1)).toBe(true);
  document.getSelection()!.removeAllRanges();
  document.dispatchEvent(new Event('selectionchange'));
  expect(current.atBoundary(1)).toBe(true);
  expect(current.canPage(1)).toBe(false);
});

it('does not require paging into trailing clearance beyond the nominal last column', () => {
  const { current, maxLeft } = fixture(300, { trailingInset: 24 });
  const lastColumn = maxLeft - 24;
  current.viewport.scrollLeft = lastColumn - 4;
  expect(current.atBoundary(1)).toBe(false);
  current.viewport.scrollLeft = lastColumn;
  expect(current.atBoundary(1)).toBe(true);
  expect(current.canPage(1)).toBe(false);
});

it('retains the nominal bound when the scroll extent has not been measured', () => {
  const { current, maxLeft, metrics } = fixture(300);
  metrics.scrollWidth = 0;
  expect(current.atBoundary(1)).toBe(false);
  current.viewport.scrollLeft = maxLeft - 4;
  expect(current.atBoundary(1)).toBe(false);
  current.viewport.scrollLeft = maxLeft;
  expect(current.atBoundary(1)).toBe(true);
});

it('recognizes both ends of a settled single-page article', () => {
  const { current, maxLeft } = fixture(299.6, { columns: 1 });
  expect(maxLeft).toBe(0);
  expect(current.atBoundary(-1)).toBe(true);
  expect(current.atBoundary(1)).toBe(true);
});

it.each(['clientWidth', 'clientHeight', 'flowWidth'] as const)(
  'rejects zero %s geometry at either end',
  (key) => {
    const { current, maxLeft, metrics } = fixture(299.6);
    metrics[key] = 0;
    expect(current.atBoundary(-1)).toBe(false);
    current.viewport.scrollLeft = maxLeft;
    expect(current.atBoundary(1)).toBe(false);
  },
);

it('rejects both ends until the article has a rendered source index', () => {
  const { current, maxLeft } = fixture(299.6, { ready: false });
  expect(current.atBoundary(-1)).toBe(false);
  current.viewport.scrollLeft = maxLeft;
  expect(current.atBoundary(1)).toBe(false);
});

it('rejects both ends after disposal', () => {
  const { current, maxLeft } = fixture(299.6);
  current.dispose();
  expect(current.atBoundary(-1)).toBe(false);
  current.viewport.scrollLeft = maxLeft;
  expect(current.atBoundary(1)).toBe(false);
});

it('rejects both ends while a selection defers restoration', () => {
  const { current, maxLeft } = fixture(299.6);
  const range = document.createRange();
  range.selectNodeContents(current.body);
  document.getSelection()!.addRange(range);
  current.restore('Synthetic article text.');
  expect(current.atBoundary(-1)).toBe(false);
  current.viewport.scrollLeft = maxLeft;
  expect(current.atBoundary(1)).toBe(false);
});

it('rejects the end during restoration and accepts it after the restore frame', () => {
  const { current, maxLeft } = fixture(300);
  current.viewport.scrollLeft = maxLeft;
  const range = document.createRange();
  Object.defineProperty(range, 'getBoundingClientRect', {
    value: () => new DOMRect(0, 0, 10, 10),
  });
  vi.spyOn(render, 'bookmarkRange').mockReturnValue(range);
  current.restore('Synthetic article text.');
  expect(current.atBoundary(1)).toBe(false);
  const pending = [...frames.values()];
  frames.clear();
  expect(pending).toHaveLength(1);
  for (const callback of pending) callback(0);
  expect(current.atBoundary(1)).toBe(true);
});

it('preserves scroll-mode bottom detection with fractional scrollTop', () => {
  const { current } = fixture(299.6, { paged: false });
  expect(current.atBoundary(-1)).toBe(true);
  current.viewport.scrollTop = 797;
  expect(current.atBoundary(1)).toBe(false);
  current.viewport.scrollTop = 800.6;
  expect(current.atBoundary(1)).toBe(true);
});
