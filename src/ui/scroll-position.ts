import { captureReadingPosition, rangeForReadingPosition } from './eink-anchor';
import type { ReadingPosition } from './eink-types';

/** Ordinary scrolling only: a hidden leaf must never replace its last text anchor with zero. */
export function trackScrollPosition(viewport: HTMLElement, body: HTMLElement) {
  const win = viewport.ownerDocument.defaultView!;
  let cached: ReadingPosition = { marker: '' };
  let capturedScrollTop: number | undefined;
  let pending: ReadingPosition | undefined, disposed = false, frame = 0;
  let restoredScrollTop: number | undefined;
  let stopWatching: (() => void) | undefined;
  const usable = () => !disposed && viewport.isConnected && viewport.clientWidth > 0 && viewport.clientHeight > 0
    && !['hidden', 'collapse'].includes(win.getComputedStyle(viewport).visibility);
  function cache() {
    if (pending || !usable()) return;
    // Restoration's 24px inset can expose a preceding line. Keep the exact
    // requested character until scrolling moves, including delayed scroll events
    // from our own restore. Check on reads too: scroll events arrive asynchronously.
    if (restoredScrollTop !== undefined && viewport.scrollTop === restoredScrollTop) return;
    restoredScrollTop = undefined;
    if (viewport.scrollTop !== capturedScrollTop) {
      cached = captureReadingPosition(viewport, body); capturedScrollTop = viewport.scrollTop;
    }
  }
  function stop() {
    if (frame) win.cancelAnimationFrame(frame);
    frame = 0; stopWatching?.(); stopWatching = undefined;
  }
  function restore() {
    if (!pending || !usable()) return;
    if (!pending.marker) viewport.scrollTop = 0;
    else {
      // Wait for an unrendered body, but start over if visible text no longer matches.
      if (!body.textContent?.trim()) return;
      const range = rangeForReadingPosition(body, pending);
      const rect = range?.getBoundingClientRect?.();
      if (!range) { viewport.scrollTop = 0; pending = { marker: '' }; }
      else {
        if (!rect || rect.width <= 0 || rect.height <= 0) return;
        viewport.scrollTop += rect.top - viewport.getBoundingClientRect().top - 24;
      }
    }
    restoredScrollTop = viewport.scrollTop;
    cached = pending; capturedScrollTop = viewport.scrollTop; pending = undefined; stop();
  }
  function schedule() {
    if (!disposed && pending && !frame) frame = win.requestAnimationFrame(() => { frame = 0; restore(); });
  }
  function watch() {
    if (stopWatching) return;
    // Observe only during an unresolved restore, never continuously repin ordinary scrolling.
    const resize = typeof win.ResizeObserver === 'function' ? new win.ResizeObserver(schedule) : undefined;
    resize?.observe(viewport); resize?.observe(body);
    const changes = new win.MutationObserver(schedule);
    changes.observe(body, { subtree: true, childList: true, characterData: true,
      attributes: true, attributeFilter: ['class', 'style', 'hidden'] });
    for (let ancestor: HTMLElement | null = viewport; ancestor; ancestor = ancestor.parentElement) {
      changes.observe(ancestor, { attributes: true, attributeFilter: ['class', 'style', 'hidden'] });
    }
    win.addEventListener('resize', schedule);
    viewport.ownerDocument.addEventListener('visibilitychange', schedule);
    body.addEventListener('load', schedule, true);
    stopWatching = () => {
      resize?.disconnect(); changes.disconnect();
      win.removeEventListener('resize', schedule);
      viewport.ownerDocument.removeEventListener('visibilitychange', schedule);
      body.removeEventListener('load', schedule, true);
    };
  }
  viewport.addEventListener('scroll', cache, { passive: true });
  cache();
  return {
    getPosition(): ReadingPosition {
      cache();
      return { ...(pending ?? cached) };
    },
    restorePosition(position: ReadingPosition) {
      if (disposed) return;
      pending = { ...position }; restore();
      if (pending) watch();
    },
    dispose() {
      disposed = true; pending = undefined; stop();
      viewport.removeEventListener('scroll', cache);
    },
  };
}
