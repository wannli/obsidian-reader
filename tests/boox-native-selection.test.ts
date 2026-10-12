import { afterEach, expect, it, vi } from 'vitest';
import { watchCompletedSelection } from '../src/highlights';
import { nativeContextMenu } from './helpers/native-context-menu';

const cleanups: (() => void)[] = [];
function fire(target: EventTarget, type: string, fields: object = {}) {
  const event = Object.assign(new Event(type, { bubbles: true, cancelable: true }), fields);
  target.dispatchEvent(event);
  expect(event.defaultPrevented).toBe(false);
}
function fixture() {
  vi.useFakeTimers();
  const root = document.createElement('article');
  root.innerHTML = '<p><mark>Cobalt cancelled tou</mark>ch should remain readable after saving.</p>';
  document.body.append(root);
  const text = root.querySelector('p')!.lastChild!;
  const selection = document.getSelection()!, complete = vi.fn();
  cleanups.push(watchCompletedSelection(root, 'boox-trace-v1', complete, { settleMs: 900 }));
  function choose(end: number, notify = true) {
    const range = document.createRange(); range.setStart(text, 10); range.setEnd(text, end);
    selection.removeAllRanges(); selection.addRange(range);
    if (notify) fire(document, 'selectionchange');
    return range;
  }
  function takeover(menu: 'native' | 'untrusted' | 'outside' | 'pointer-only' | 'none' = 'native') {
    const pointer = { pointerId: 5, pointerType: 'touch', buttons: 1 };
    const origin = menu === 'outside' ? document.body : root;
    fire(origin, 'pointerdown', pointer);
    if (menu !== 'pointer-only') fire(origin, 'touchstart', { touches: [{ identifier: 5 }] });
    choose(16);
    if (menu === 'untrusted') fire(root, 'contextmenu', { ...pointer, buttons: 0 });
    else if (menu !== 'none') nativeContextMenu(root, { ...pointer, buttons: 0 });
    fire(root, 'pointercancel', { ...pointer, buttons: 0 }); fire(root, 'touchcancel', { touches: [] });
  }
  return { root, text, selection, complete, choose, takeover };
}
afterEach(() => {
  cleanups.splice(0).forEach(stop => stop());
  document.getSelection()?.removeAllRanges(); document.body.replaceChildren();
  vi.restoreAllMocks(); vi.useRealTimers();
});

it('completes the Boox native-handle trace without requiring the later swipe', () => {
  // Real Boox 0.3.0 trace 2026-10-10T10:39:33.559Z, build 10e72bce…:
  // long-press menu -> touch cancellation -> invisible handle adjustments ->
  // a second native contextmenu. Do NOT replay the unrelated swipe at 17.984 s.
  // Synthetic replay proves this event path, not the safety of unobserved gestures.
  const { root, complete, choose, selection } = fixture();
  let now = 0;
  function at(ms: number, action: () => void) { vi.advanceTimersByTime(ms - now); now = ms; action(); }
  const pointer = { pointerId: 5, pointerType: 'touch', buttons: 1 };
  at(3432, () => fire(root, 'pointerdown', pointer));
  at(3435, () => fire(root, 'touchstart', { touches: [{ identifier: 5 }] }));
  at(3944, () => { choose(16, false); nativeContextMenu(root, { ...pointer, buttons: 0 }); });
  at(3994, () => fire(document, 'selectionchange'));
  at(4127, () => fire(root, 'pointercancel', { ...pointer, buttons: 0 }));
  at(4128, () => fire(root, 'touchcancel', { touches: [] }));
  for (const [ms, end] of [[5415, 25], [5442, 26], [5463, 31], [5486, 32], [5577, 38]]) {
    at(ms, () => choose(end));
  }
  const range = selection.getRangeAt(0);
  at(6008, () => nativeContextMenu(document.body, { pointerId: 1, pointerType: 'mouse', buttons: 0 }));
  expect(complete).not.toHaveBeenCalled();
  vi.advanceTimersByTime(899); expect(complete).not.toHaveBeenCalled();
  vi.advanceTimersByTime(1); expect(complete).toHaveBeenCalledTimes(1);
  expect(complete.mock.calls[0][0].anchor.quote.exact).toBe('remain readable after saving');
  expect(complete.mock.calls[0][0].anchor.position).toEqual({ start: 30, end: 58 });
  expect(selection.getRangeAt(0)).toBe(range);
  vi.advanceTimersByTime(20000); expect(complete).toHaveBeenCalledTimes(1);
});

it('requires the paired pointer cancellation before treating touchcancel as native takeover', () => {
  const { root, complete, choose } = fixture();
  fire(root, 'pointerdown', { pointerId: 5, pointerType: 'touch', buttons: 1 });
  fire(root, 'touchstart', { touches: [{ identifier: 5 }] });
  choose(16); nativeContextMenu(root, { pointerId: 5, pointerType: 'touch', buttons: 0 });
  fire(root, 'touchcancel', { touches: [] }); choose(38);
  nativeContextMenu(document.body); vi.advanceTimersByTime(5000);
  expect(complete).not.toHaveBeenCalled();
});
it('rejects an inside-root mouse menu as a native-handle completion cue', () => {
  const { root, complete, choose, takeover } = fixture(); takeover(); choose(38);
  nativeContextMenu(root, { pointerType: 'mouse', buttons: 0 });
  vi.advanceTimersByTime(5000); expect(complete).not.toHaveBeenCalled();
  nativeContextMenu(document.body); vi.advanceTimersByTime(900); expect(complete).toHaveBeenCalledTimes(1);
});
it('does not save during long native-handle pauses without a completion menu', () => {
  const { complete, choose, takeover } = fixture(); takeover(); choose(25);
  vi.advanceTimersByTime(10000); expect(complete).not.toHaveBeenCalled();
  choose(38); vi.advanceTimersByTime(10000); expect(complete).not.toHaveBeenCalled();
  nativeContextMenu(document.body); vi.advanceTimersByTime(900);
  expect(complete).toHaveBeenCalledTimes(1);
});
it('does not infer word-only release from cancellation or a delayed compatibility menu', () => {
  const { complete, takeover } = fixture(); takeover();
  vi.advanceTimersByTime(5000); nativeContextMenu(document.body); vi.advanceTimersByTime(5000);
  expect(complete).not.toHaveBeenCalled();
});
it.each(['untrusted', 'outside', 'pointer-only', 'none'] as const)('rejects %s takeover provenance', kind => {
  const { complete, choose, takeover } = fixture(); takeover(kind); choose(38);
  nativeContextMenu(document.body); vi.advanceTimersByTime(5000);
  expect(complete).not.toHaveBeenCalled();
});
it('rejects synthetic completion menus without weakening production trust checks', () => {
  const { complete, choose, takeover } = fixture(); takeover(); choose(38);
  fire(document.body, 'contextmenu', { pointerType: 'mouse', buttons: 0 });
  vi.advanceTimersByTime(5000); expect(complete).not.toHaveBeenCalled();
  nativeContextMenu(document.body); vi.advanceTimersByTime(900); expect(complete).toHaveBeenCalledTimes(1);
});
it.each([true, false])('revokes completion permission on a new adjustment (notified: %s)', notify => {
  const { complete, choose, takeover, selection, text } = fixture(); takeover(); choose(38);
  nativeContextMenu(document.body); vi.advanceTimersByTime(800);
  selection.getRangeAt(0).setEnd(text, 25);
  if (notify) fire(document, 'selectionchange');
  vi.advanceTimersByTime(5000); expect(complete).not.toHaveBeenCalled();
  nativeContextMenu(document.body); vi.advanceTimersByTime(900);
  expect(complete).toHaveBeenCalledTimes(1); expect(complete.mock.calls[0][0].anchor.quote.exact).toBe('remain readable');
});
it('retains native ownership after delivery and deduplicates repeated menus and unchanged boundaries', () => {
  const { complete, choose, takeover } = fixture(); takeover(); choose(38);
  nativeContextMenu(document.body); fire(document, 'selectionchange'); vi.advanceTimersByTime(900);
  nativeContextMenu(document.body); vi.advanceTimersByTime(1000); expect(complete).toHaveBeenCalledTimes(1);
  choose(25); vi.advanceTimersByTime(5000); expect(complete).toHaveBeenCalledTimes(1);
  nativeContextMenu(document.body); vi.advanceTimersByTime(900); expect(complete).toHaveBeenCalledTimes(2);
});
it('does not flush a pending native selection through an unrelated touch', () => {
  const { complete, choose, takeover } = fixture(); takeover(); choose(38);
  fire(document.body, 'pointerdown', { pointerId: 6, pointerType: 'touch', buttons: 1 });
  fire(document.body, 'touchstart', { touches: [{ identifier: 6 }] });
  fire(document.body, 'pointerup', { pointerId: 6, pointerType: 'touch', buttons: 0 });
  fire(document.body, 'touchend', { touches: [] }); nativeContextMenu(document.body);
  vi.advanceTimersByTime(5000); expect(complete).not.toHaveBeenCalled();
});
it.each(['pointer', 'touch'])('a completion menu cannot release a known held %s', kind => {
  const { complete, choose, takeover } = fixture(); takeover(); choose(38);
  if (kind === 'pointer') fire(document.body, 'pointermove', { pointerId: 9, pointerType: 'pen', buttons: 1 });
  else fire(document.body, 'touchmove', { touches: [{ identifier: 9 }] });
  nativeContextMenu(document.body); vi.advanceTimersByTime(5000); expect(complete).not.toHaveBeenCalled();
  if (kind === 'pointer') fire(document.body, 'pointerup', { pointerId: 9, pointerType: 'pen', buttons: 0 });
  else fire(document.body, 'touchend', { touches: [] });
  vi.advanceTimersByTime(5000); expect(complete).not.toHaveBeenCalled();
  nativeContextMenu(document.body); vi.advanceTimersByTime(900); expect(complete).toHaveBeenCalledTimes(1);
});
it('mouse release recovery cannot authorize a native-handle selection without its completion cue', () => {
  const { complete, choose, takeover } = fixture(); takeover(); choose(38);
  fire(document.body, 'pointermove', { pointerId: 9, pointerType: 'mouse', buttons: 1 });
  fire(document.body, 'pointermove', { pointerId: 9, pointerType: 'mouse', buttons: 0 });
  vi.advanceTimersByTime(5000); expect(complete).not.toHaveBeenCalled();
  nativeContextMenu(document.body); vi.advanceTimersByTime(900);
  expect(complete).toHaveBeenCalledTimes(1);
});
it.each(['Escape', 'blur', 'hidden', 'pagehide', 'collapse', 'outside', 'detach', 'dispose'])(
  'cannot resurrect native ownership after %s', reason => {
    const { root, complete, choose, takeover, selection } = fixture(); takeover(); choose(38);
    nativeContextMenu(document.body); vi.advanceTimersByTime(500);
    if (reason === 'Escape') fire(document, 'keydown', { key: 'Escape' });
    if (reason === 'blur' || reason === 'pagehide') fire(window, reason);
    if (reason === 'hidden') { vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('hidden'); fire(document, 'visibilitychange'); }
    if (reason === 'collapse') selection.collapseToEnd();
    if (reason === 'outside') {
      const outside = document.createElement('p'); outside.textContent = 'other'; document.body.append(outside);
      const range = document.createRange(); range.selectNodeContents(outside); selection.removeAllRanges(); selection.addRange(range);
    }
    if (reason === 'detach') root.remove();
    if (reason === 'dispose') cleanups[0]();
    fire(document, 'selectionchange'); nativeContextMenu(document.body);
    vi.advanceTimersByTime(5000); expect(complete).not.toHaveBeenCalled();
  },
);

it.each(['pointercancel', 'touchcancel'])('does not mistake a later %s for the original handoff pair', type => {
  const { root, complete, choose, takeover } = fixture(); takeover(); choose(38);
  fire(root, type, { pointerId: 5, pointerType: 'touch', buttons: 0, touches: [] });
  nativeContextMenu(document.body); vi.advanceTimersByTime(5000);
  expect(complete).not.toHaveBeenCalled();
});
