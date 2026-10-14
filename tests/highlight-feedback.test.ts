// @vitest-environment jsdom
import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { HighlightFeedback } from '../src/reader/highlight-feedback';

let feedback: HighlightFeedback;
let parent: HTMLElement;
let viewport: HTMLElement;
let body: HTMLElement;
let range: Range;
let rects: DOMRect[];
const status = () => document.querySelector<HTMLElement>('.reader-highlight-feedback')!;
beforeEach(() => {
  vi.useFakeTimers();
  parent = document.createElement('div');
  parent.className = 'reader-article';
  parent.style.position = 'relative';
  viewport = document.createElement('div');
  body = document.createElement('article');
  body.textContent = 'selected passage';
  viewport.append(body);
  parent.append(viewport);
  document.body.append(parent);
  vi.spyOn(viewport, 'getBoundingClientRect').mockReturnValue(new DOMRect(100, 50, 300, 250));
  feedback = new HighlightFeedback(viewport, body);
  // jsdom has no layout/offset-parent computation. Model the real leaf-owned host.
  Object.defineProperty(status(), 'offsetParent', { configurable: true, get: () => parent });
  vi.spyOn(status(), 'getBoundingClientRect').mockReturnValue(new DOMRect(0, 0, 110, 28));
  range = document.createRange();
  range.selectNodeContents(body.firstChild!);
  document.getSelection()!.removeAllRanges();
  document.getSelection()!.addRange(range);
  rects = [new DOMRect(120, 80, 200, 20), new DOMRect(120, 110, 80, 20)];
  Object.defineProperty(Range.prototype, 'getClientRects', {
    configurable: true,
    value: () => rects,
  });
});
afterEach(() => {
  feedback.dispose();
  document.getSelection()!.removeAllRanges();
  document.body.replaceChildren();
  delete (Range.prototype as any).getClientRects;
  vi.restoreAllMocks();
  vi.useRealTimers();
});
it('waits for confirmation and paints below the last line without replacing text or selection', () => {
  const node = body.firstChild;
  const confirm = feedback.prepare(range);
  expect(status().hidden).toBe(true);
  confirm();
  expect(status().textContent).toBe('Highlight saved');
  expect(status().getAttribute('role')).toBe('status');
  expect(status().getAttribute('aria-live')).toBe('polite');
  expect(status().getAttribute('aria-atomic')).toBe('true');
  expect(status().parentElement).toBe(parent);
  expect(body.contains(status())).toBe(false);
  expect(status().style.top).toBe('136px');
  expect(status().style.left).toBe('120px');
  expect(body.firstChild).toBe(node);
  expect(document.getSelection()!.toString()).toBe('selected passage');
  vi.advanceTimersByTime(2200);
  expect(status().hidden).toBe(true);
});
it('clamps at pane edges and ignores offscreen final lines', () => {
  rects = [new DOMRect(380, 270, 30, 20), new DOMRect(380, 400, 30, 20)];
  feedback.prepare(range)();
  expect(status().style.left).toBe('282px');
  expect(status().style.top).toBe('264px');
});
function hostGeometry({
  scaleX = 1,
  scaleY = scaleX,
  borderLeft = 0,
  borderTop = 0,
  scrollLeft = 0,
  scrollTop = 0,
  measured = true,
}: {
  scaleX?: number;
  scaleY?: number;
  borderLeft?: number;
  borderTop?: number;
  scrollLeft?: number;
  scrollTop?: number;
  measured?: boolean;
} = {}) {
  const box = new DOMRect(200, 100, 300 * scaleX, 250 * scaleY);
  Object.defineProperties(parent, {
    offsetWidth: { configurable: true, value: measured ? 300 : 0 },
    offsetHeight: { configurable: true, value: measured ? 250 : 0 },
    clientLeft: { configurable: true, value: borderLeft },
    clientTop: { configurable: true, value: borderTop },
  });
  parent.scrollLeft = scrollLeft;
  parent.scrollTop = scrollTop;
  vi.spyOn(parent, 'getBoundingClientRect').mockReturnValue(box);
  vi.mocked(viewport.getBoundingClientRect).mockReturnValue(box);
  vi.mocked(status().getBoundingClientRect).mockReturnValue(
    new DOMRect(0, 0, 110 * scaleX, 28 * scaleY),
  );
  rects = [new DOMRect(220, 113, 100, 20)];
  return {
    paintedPosition: () => ({
      left: box.left + (parseFloat(status().style.left) + borderLeft - scrollLeft) * scaleX,
      top: box.top + (parseFloat(status().style.top) + borderTop - scrollTop) * scaleY,
    }),
  };
}

it('uses leaf-owned absolute positioning in the production stylesheet', () => {
  const style = document.createElement('style');
  style.textContent = readFileSync('src/reader/styles.css', 'utf8');
  document.head.append(style);
  try {
    expect(getComputedStyle(status()).position).toBe('absolute');
    parent.style.removeProperty('position');
    expect(getComputedStyle(parent).position).toBe('relative');
  } finally {
    style.remove();
  }
});

it.each([false, true])(
  'positions below the highlight in an offset contained=%s pane',
  (contained) => {
    parent.style.contain = contained ? 'layout paint' : 'none';
    const { paintedPosition } = hostGeometry();
    feedback.prepare(range)();
    expect(status().hidden).toBe(false);
    expect(status().style.left).toBe('20px');
    expect(status().style.top).toBe('39px');
    expect(paintedPosition()).toEqual({ left: 220, top: 139 });
    expect(status().style.maxWidth).toBe('284px');
  },
);

it('converts to the offset-parent padding origin including borders and scroll', () => {
  const { paintedPosition } = hostGeometry({
    borderLeft: 4,
    borderTop: 6,
    scrollLeft: 12,
    scrollTop: 34,
  });
  feedback.prepare(range)();
  expect(status().style.left).toBe('28px');
  expect(status().style.top).toBe('67px');
  expect(paintedPosition()).toEqual({ left: 220, top: 139 });
});

it.each([
  { scaleX: 0.75, scaleY: 0.75 },
  { scaleX: 2, scaleY: 2 },
  { scaleX: 1.5, scaleY: 2 },
])('converts scaled/zoomed geometry ($scaleX × $scaleY) and max-width', ({ scaleX, scaleY }) => {
  const { paintedPosition } = hostGeometry({ scaleX, scaleY });
  feedback.prepare(range)();
  expect(parseFloat(status().style.left)).toBeCloseTo(20 / scaleX);
  expect(parseFloat(status().style.top)).toBeCloseTo(39 / scaleY);
  expect(parseFloat(status().style.maxWidth)).toBeCloseTo((300 * scaleX - 16) / scaleX);
  expect(paintedPosition().left).toBeCloseTo(220);
  expect(paintedPosition().top).toBeCloseTo(139);
});

it('clamps in viewport coordinates before converting a scaled, bordered, scrolled host', () => {
  const { paintedPosition } = hostGeometry({
    scaleX: 2,
    borderLeft: 4,
    borderTop: 6,
    scrollLeft: 12,
    scrollTop: 34,
  });
  vi.mocked(viewport.getBoundingClientRect).mockReturnValue(new DOMRect(240, 180, 400, 300));
  rects = [new DOMRect(620, 450, 30, 20)];
  feedback.prepare(range)();
  expect(status().style.left).toBe('114px');
  expect(status().style.top).toBe('186px');
  expect(status().style.maxWidth).toBe('192px');
  expect(paintedPosition()).toEqual({ left: 412, top: 416 });
});

it('uses the actual offsetParent rather than assuming the direct parent owns coordinates', () => {
  hostGeometry();
  const ancestor = document.createElement('div');
  ancestor.style.position = 'relative';
  document.body.append(ancestor);
  ancestor.append(parent);
  parent.style.position = 'static';
  vi.spyOn(ancestor, 'getBoundingClientRect').mockReturnValue(new DOMRect(50, 25, 500, 400));
  Object.defineProperties(ancestor, {
    offsetWidth: { value: 500 },
    offsetHeight: { value: 400 },
  });
  Object.defineProperty(status(), 'offsetParent', { get: () => ancestor });
  // Reparenting is fixture setup, not a selection-changing interaction under test.
  range.selectNodeContents(body.firstChild!);
  document.getSelection()!.removeAllRanges();
  document.getSelection()!.addRange(range);
  feedback.prepare(range)();
  expect(status().style.left).toBe('170px');
  expect(status().style.top).toBe('114px');
});

it('keeps finite unscaled coordinates when parent dimensions are unmeasured', () => {
  hostGeometry({ measured: false });
  feedback.prepare(range)();
  expect(status().style.left).toBe('20px');
  expect(status().style.top).toBe('39px');
  expect(status().style.maxWidth).toBe('284px');
});

it('still dismisses feedback taller than the visible pane', () => {
  hostGeometry({ scaleX: 2 });
  vi.mocked(status().getBoundingClientRect).mockReturnValue(new DOMRect(0, 0, 220, 600));
  feedback.prepare(range)();
  expect(status().hidden).toBe(true);
});

it.each(['scroll', 'selectionchange', 'pointerdown', 'keydown', 'visibilitychange'])(
  'dismisses and invalidates pending confirmation on %s',
  (event) => {
    const confirm = feedback.prepare(range);
    confirm();
    document.dispatchEvent(new Event(event));
    expect(status().hidden).toBe(true);
    confirm();
    expect(status().hidden).toBe(true);
  },
);
it('invalidates on resize and disposal', () => {
  const confirm = feedback.prepare(range);
  window.dispatchEvent(new Event('resize'));
  confirm();
  expect(status().hidden).toBe(true);
  feedback.dispose();
  confirm();
  expect(status()).toBeNull();
});
it('does not acknowledge a changed selection even before selectionchange dispatch', () => {
  const confirm = feedback.prepare(range);
  document.getSelection()!.collapse(body.firstChild, 1);
  confirm();
  expect(status().hidden).toBe(true);
});
it('does not acknowledge disconnected or offscreen passages', () => {
  const confirm = feedback.prepare(range);
  rects = [new DOMRect(120, 400, 80, 20)];
  confirm();
  expect(status().hidden).toBe(true);
  viewport.remove();
  confirm();
  expect(status().hidden).toBe(true);
});
