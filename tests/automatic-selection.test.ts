import { afterEach, expect, it, vi } from 'vitest';
import { watchCompletedSelection, type CompletedSelectionOptions } from '../src/highlights';
const completedCleanups: (() => void)[] = [];
function fire(type: string, values: object = {}, target: EventTarget = document) {
  const event = Object.assign(new Event(type, { bubbles: true, cancelable: true }), values);
  target.dispatchEvent(event); expect(event.defaultPrevented).toBe(false);
}
function automatic(options?: CompletedSelectionOptions) {
  vi.useFakeTimers();
  const root = document.createElement('article'); root.textContent = 'one two three'; document.body.append(root);
  const callback = vi.fn(), stop = watchCompletedSelection(root, 'v1', callback, options);
  completedCleanups.push(stop);
  const selection = document.getSelection()!;
  function choose(start = 0, end = 3, notify = true) {
    const range = document.createRange(); range.setStart(root.firstChild!, start); range.setEnd(root.firstChild!, end);
    selection.removeAllRanges(); selection.addRange(range); if (notify) fire('selectionchange'); return range;
  }
  return { root, callback, stop, selection, choose };
}
afterEach(() => {
  completedCleanups.splice(0).forEach(stop => stop());
  document.getSelection()?.removeAllRanges(); document.body.replaceChildren();
  vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.useRealTimers();
});

it.each(['pointer', 'touch', 'keyboard', 'WebKit pointer takeover'])('does not complete during a paused %s gesture', kind => {
  const { callback, choose, selection } = automatic({ settleMs: 100 });
  if (kind === 'pointer' || kind.includes('WebKit')) fire('pointerdown', { pointerId: 1, pointerType: 'touch' }, document.body);
  if (kind === 'touch' || kind.includes('WebKit')) fire('touchstart', { touches: [{ identifier: 1 }] }, document.body);
  if (kind === 'keyboard') fire('keydown', { key: 'ArrowRight', code: 'ArrowRight', shiftKey: true });
  if (kind.includes('WebKit')) fire('pointercancel', { pointerId: 1 });
  choose(); vi.advanceTimersByTime(2000); expect(callback).not.toHaveBeenCalled();
  const range = choose(0, 7); vi.advanceTimersByTime(2000); expect(callback).not.toHaveBeenCalled();
  if (kind === 'pointer') fire('pointerup', { pointerId: 1 });
  if (kind === 'touch' || kind.includes('WebKit')) fire('touchend', { touches: [] });
  if (kind === 'keyboard') fire('keyup', { key: 'ArrowRight', code: 'ArrowRight' });
  vi.advanceTimersByTime(99); expect(callback).not.toHaveBeenCalled();
  vi.advanceTimersByTime(1); expect(callback).toHaveBeenCalledTimes(1);
  expect(callback.mock.calls[0][0].anchor.quote.exact).toBe('one two'); expect(selection.getRangeAt(0)).toBe(range);
});
it('waits for every pointer and touch to release, including a missing touch pointerup', () => {
  const { choose, callback } = automatic();
  for (const pointerId of [1, 2]) fire('pointerdown', { pointerId, pointerType: 'touch' });
  fire('touchstart', { touches: [{ identifier: 1 }, { identifier: 2 }] }); choose();
  fire('pointerup', { pointerId: 1 }); fire('touchend', { touches: [{ identifier: 2 }] });
  vi.advanceTimersByTime(5000); expect(callback).not.toHaveBeenCalled();
  fire('touchend', { touches: [] }); vi.advanceTimersByTime(650); expect(callback).toHaveBeenCalledTimes(1);
});
it('deduplicates an unchanged native range, but emits subsequent selection revisions', () => {
  const { choose, callback, selection } = automatic(); const range = choose();
  vi.advanceTimersByTime(649); expect(callback).not.toHaveBeenCalled();
  vi.advanceTimersByTime(1); expect(callback).toHaveBeenCalledTimes(1);
  fire('selectionchange'); fire('pointerdown', { pointerId: 1 }); fire('pointerup', { pointerId: 1 });
  vi.advanceTimersByTime(1000); expect(callback).toHaveBeenCalledTimes(1); expect(selection.getRangeAt(0)).toBe(range);
  choose(4, 7); vi.advanceTimersByTime(650); choose(); vi.advanceTimersByTime(650);
  expect(callback.mock.calls.map(([snapshot]) => snapshot.anchor.quote.exact)).toEqual(['one', 'two', 'one']);
});
it('cancels pending completion when a new handle gesture begins without changing the range', () => {
  const { choose, callback } = automatic(); choose(); vi.advanceTimersByTime(600);
  fire('touchstart', { touches: [{ identifier: 1 }] }); vi.advanceTimersByTime(2000); expect(callback).not.toHaveBeenCalled();
  fire('touchend', { touches: [] }); vi.advanceTimersByTime(649); expect(callback).not.toHaveBeenCalled();
  vi.advanceTimersByTime(1); expect(callback).toHaveBeenCalledTimes(1);
});
it('rechecks native boundaries and restarts settling even without a selectionchange event', () => {
  const { choose, callback } = automatic(), range = choose(); vi.advanceTimersByTime(300);
  range.setEnd(range.endContainer, 7); vi.advanceTimersByTime(350); expect(callback).not.toHaveBeenCalled();
  vi.advanceTimersByTime(649); expect(callback).not.toHaveBeenCalled();
  vi.advanceTimersByTime(1); expect(callback.mock.calls[0][0].anchor.quote.exact).toBe('one two');
});
it.each(['collapse', 'outside', 'pointercancel', 'touchcancel', 'Escape', 'blur', 'hidden', 'detached', 'dispose'])(
  'aborts pending completion on %s', reason => {
    const { choose, callback, selection, root, stop } = automatic(); choose(); vi.advanceTimersByTime(100);
    if (reason === 'collapse') selection.collapseToEnd();
    if (reason === 'outside') {
      const outside = document.createElement('p'); outside.textContent = 'outside'; document.body.append(outside);
      const range = document.createRange(); range.selectNodeContents(outside); selection.removeAllRanges(); selection.addRange(range);
    }
    if (reason === 'pointercancel') fire('pointercancel', { pointerId: 1 });
    if (reason === 'touchcancel') fire('touchcancel', { touches: [] });
    if (reason === 'Escape') fire('keydown', { key: 'Escape' });
    if (reason === 'blur') fire('blur', {}, window);
    if (reason === 'hidden') { vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('hidden'); fire('visibilitychange'); }
    if (reason === 'detached') root.remove();
    if (reason === 'dispose') { stop(); stop(); }
    fire('selectionchange'); vi.advanceTimersByTime(2000); expect(callback).not.toHaveBeenCalled();
    fire('focus', {}, window); fire('pointerup', { pointerId: 1 }); vi.advanceTimersByTime(2000);
    expect(callback).not.toHaveBeenCalled();
  },
);
it('recovers after cancellation only for a fresh input/selection revision', () => {
  const { choose, callback } = automatic(); choose(); fire('touchcancel', { touches: [] });
  fire('touchstart', { touches: [{ identifier: 2 }] }); choose(4, 7); fire('touchend', { touches: [] });
  vi.advanceTimersByTime(650); expect(callback.mock.calls[0][0].anchor.quote.exact).toBe('two');
});
