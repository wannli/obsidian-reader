import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { captureReadingPosition, rangeForReadingPosition } from '../src/ui/eink-anchor';
import { trackScrollPosition } from '../src/ui/scroll-position';

vi.mock('../src/ui/eink-anchor', () => ({ captureReadingPosition: vi.fn(), rangeForReadingPosition: vi.fn() }));
const anchor = { marker: 'restored character' };
const predecessor = { marker: 'preceding visible line' };
let viewport: HTMLElement, body: HTMLElement;
let tracker: ReturnType<typeof trackScrollPosition>;
let frames: Map<number, FrameRequestCallback>;
let disconnectResize: ReturnType<typeof vi.fn>;
const visualRange = () => ({ getBoundingClientRect: () => ({ top: 500 - viewport.scrollTop, width: 10, height: 20 }) }) as Range;
async function flushLayout() {
  await Promise.resolve(); // Deliver MutationObserver records before the animation frame.
  const callbacks = [...frames.values()]; frames.clear();
  callbacks.forEach(callback => callback(0));
}
beforeEach(() => {
  vi.resetAllMocks(); frames = new Map(); let nextFrame = 0;
  vi.spyOn(window, 'requestAnimationFrame').mockImplementation(callback => { frames.set(++nextFrame, callback); return nextFrame; });
  vi.spyOn(window, 'cancelAnimationFrame').mockImplementation(id => { frames.delete(id); });
  disconnectResize = vi.fn();
  vi.stubGlobal('ResizeObserver', class { observe() {} disconnect = disconnectResize; });
  viewport = document.createElement('div'); body = document.createElement('article');
  body.textContent = 'restored character preceded by preceding visible line'; viewport.append(body); document.body.append(viewport);
  Object.defineProperties(viewport, {
    clientWidth: { get: () => viewport.style.display === 'none' ? 0 : 600 },
    clientHeight: { get: () => viewport.style.display === 'none' ? 0 : 800 },
  });
  vi.spyOn(viewport, 'getBoundingClientRect').mockReturnValue({ top: 0 } as DOMRect);
  vi.mocked(rangeForReadingPosition).mockImplementation(visualRange);
  vi.mocked(captureReadingPosition).mockReturnValue(predecessor);
  tracker = trackScrollPosition(viewport, body);
  vi.mocked(captureReadingPosition).mockClear();
});
afterEach(() => {
  tracker.dispose(); document.body.replaceChildren(); vi.restoreAllMocks(); vi.unstubAllGlobals();
});

it('returns the exact restored anchor immediately, not the predecessor exposed by its inset', () => {
  tracker.restorePosition(anchor);
  expect(viewport.scrollTop).toBe(476);
  expect(tracker.getPosition()).toEqual(anchor);
  expect(captureReadingPosition).not.toHaveBeenCalled();
});
it('ignores immediate and delayed restore-generated scroll notifications at the same scrollTop', async () => {
  tracker.restorePosition(anchor);
  viewport.dispatchEvent(new Event('scroll'));
  expect(tracker.getPosition()).toEqual(anchor);
  await flushLayout(); viewport.dispatchEvent(new Event('scroll'));
  expect(tracker.getPosition()).toEqual(anchor);
  expect(captureReadingPosition).not.toHaveBeenCalled();
});
it('copies the restore request and returned anchor', () => {
  const request = { ...anchor }; tracker.restorePosition(request); request.marker = 'changed';
  tracker.getPosition().marker = 'changed';
  expect(tracker.getPosition()).toEqual(anchor);
});
it('recaptures movement even before its scroll notification', () => {
  tracker.restorePosition(anchor); viewport.scrollTop += 100;
  expect(tracker.getPosition()).toEqual(predecessor);
  expect(captureReadingPosition).toHaveBeenCalledOnce();
});
it('a genuine scroll notification invalidates restoration, even after returning to its old scrollTop', () => {
  tracker.restorePosition(anchor); const restoredTop = viewport.scrollTop;
  viewport.scrollTop += 100; viewport.dispatchEvent(new Event('scroll'));
  viewport.scrollTop = restoredTop; viewport.dispatchEvent(new Event('scroll'));
  expect(tracker.getPosition()).toEqual(predecessor);
});
it('tracks ordinary scrolling when no restoration was requested', () => {
  viewport.scrollTop = 100; viewport.dispatchEvent(new Event('scroll'));
  expect(tracker.getPosition()).toEqual(predecessor);
  expect(captureReadingPosition).toHaveBeenCalled();
});
it('preserves a start anchor until scrolling away from the title', () => {
  viewport.scrollTop = 100; const start = { marker: '' };
  tracker.restorePosition(start); viewport.dispatchEvent(new Event('scroll'));
  expect(viewport.scrollTop).toBe(0); expect(tracker.getPosition()).toEqual(start);
  viewport.scrollTop = 1; expect(tracker.getPosition()).toEqual(predecessor);
});
it('pins to the actual scrollTop when the browser clamps a restore near the end', () => {
  let top = 0;
  Object.defineProperty(viewport, 'scrollTop', { get: () => top, set: value => { top = Math.min(400, value); } });
  tracker.restorePosition(anchor); viewport.dispatchEvent(new Event('scroll'));
  expect(viewport.scrollTop).toBe(400); expect(tracker.getPosition()).toEqual(anchor);
  viewport.scrollTop = 399; expect(tracker.getPosition()).toEqual(predecessor);
});
for (const hidden of ['visibility', 'display'] as const) {
  it(`hidden reads and scroll notifications preserve a completed restore (${hidden})`, () => {
    tracker.restorePosition(anchor); const top = viewport.scrollTop;
    viewport.style[hidden] = hidden === 'visibility' ? 'hidden' : 'none'; viewport.scrollTop = 0;
    viewport.dispatchEvent(new Event('scroll'));
    expect(tracker.getPosition()).toEqual(anchor);
    viewport.style[hidden] = ''; viewport.scrollTop = top;
    expect(tracker.getPosition()).toEqual(anchor);
  });
  it(`defers a hidden restore and retains its exact anchor after reveal (${hidden})`, async () => {
    viewport.style[hidden] = hidden === 'visibility' ? 'hidden' : 'none';
    tracker.restorePosition(anchor); await flushLayout();
    expect(viewport.scrollTop).toBe(0); expect(tracker.getPosition()).toEqual(anchor);
    viewport.style[hidden] = ''; await flushLayout();
    expect(viewport.scrollTop).toBe(476); expect(tracker.getPosition()).toEqual(anchor);
    viewport.dispatchEvent(new Event('scroll')); await flushLayout();
    expect(tracker.getPosition()).toEqual(anchor);
    expect(disconnectResize).toHaveBeenCalledOnce();
  });
}
it('falls back to start when a saved marker is missing from a rendered article', () => {
  vi.mocked(rangeForReadingPosition).mockReturnValue(null);
  viewport.scrollTop = 120;
  tracker.restorePosition({ marker: 'missing from article' });
  expect(viewport.scrollTop).toBe(0);
  expect(tracker.getPosition()).toEqual({ marker: '' });
});
it('an unresolved restore stays authoritative until body content can be rendered', async () => {
  vi.mocked(rangeForReadingPosition).mockReturnValue(null); body.textContent = '';
  tracker.restorePosition(anchor); viewport.scrollTop = 40; viewport.dispatchEvent(new Event('scroll'));
  expect(tracker.getPosition()).toEqual(anchor);
  vi.mocked(rangeForReadingPosition).mockImplementation(visualRange);
  body.textContent = 'Content has arrived'; await flushLayout();
  expect(viewport.scrollTop).toBe(476); expect(tracker.getPosition()).toEqual(anchor);
});
it('the latest deferred restoration wins, not an earlier pending anchor', async () => {
  viewport.style.display = 'none'; tracker.restorePosition(predecessor); tracker.restorePosition(anchor);
  viewport.style.display = ''; await flushLayout();
  expect(tracker.getPosition()).toEqual(anchor);
  expect(rangeForReadingPosition).toHaveBeenLastCalledWith(body, anchor);
});
it('layout notifications do not repin ordinary scrolling after restoration', async () => {
  viewport.style.display = 'none'; tracker.restorePosition(anchor);
  viewport.style.display = ''; await flushLayout();
  vi.mocked(rangeForReadingPosition).mockClear();
  viewport.scrollTop = 700; viewport.dispatchEvent(new Event('scroll'));
  window.dispatchEvent(new Event('resize')); body.dispatchEvent(new Event('load')); body.textContent = 'Updated';
  await flushLayout();
  expect(viewport.scrollTop).toBe(700); expect(tracker.getPosition()).toEqual(predecessor);
  expect(rangeForReadingPosition).not.toHaveBeenCalled();
});
it('disposal cancels deferred work, disconnects observers and ignores later requests', async () => {
  const disconnectChanges = vi.spyOn(MutationObserver.prototype, 'disconnect');
  viewport.style.display = 'none'; tracker.restorePosition(anchor);
  window.dispatchEvent(new Event('resize')); expect(frames.size).toBe(1);
  tracker.dispose(); expect(frames.size).toBe(0);
  expect(disconnectResize).toHaveBeenCalledOnce(); expect(disconnectChanges).toHaveBeenCalledOnce();
  viewport.style.display = ''; body.textContent = 'Arrived after disposal'; await flushLayout();
  window.dispatchEvent(new Event('resize')); body.dispatchEvent(new Event('load'));
  document.dispatchEvent(new Event('visibilitychange')); viewport.dispatchEvent(new Event('scroll'));
  tracker.restorePosition(anchor); await flushLayout();
  expect(viewport.scrollTop).toBe(0); expect(frames.size).toBe(0);
  expect(rangeForReadingPosition).not.toHaveBeenCalled(); expect(captureReadingPosition).not.toHaveBeenCalled();
});
it('disposal keeps the completed anchor and removes the scroll listener', () => {
  tracker.restorePosition(anchor); const remove = vi.spyOn(viewport, 'removeEventListener');
  tracker.dispose(); viewport.scrollTop = 700; viewport.dispatchEvent(new Event('scroll'));
  expect(tracker.getPosition()).toEqual(anchor);
  expect(remove).toHaveBeenCalledWith('scroll', expect.any(Function));
  expect(captureReadingPosition).not.toHaveBeenCalled();
});
