// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { HighlightFeedback } from '../src/reader/highlight-feedback';

let feedback: HighlightFeedback;
let viewport: HTMLElement;
let body: HTMLElement;
let range: Range;
let rects: DOMRect[];
const status = () => document.querySelector<HTMLElement>('.reader-highlight-feedback')!;
beforeEach(() => {
  vi.useFakeTimers();
  const parent = document.createElement('div');
  viewport = document.createElement('div');
  body = document.createElement('article');
  body.textContent = 'selected passage';
  viewport.append(body);
  parent.append(viewport);
  document.body.append(parent);
  vi.spyOn(viewport, 'getBoundingClientRect').mockReturnValue(new DOMRect(100, 50, 300, 250));
  feedback = new HighlightFeedback(viewport, body);
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
