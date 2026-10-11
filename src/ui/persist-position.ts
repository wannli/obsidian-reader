import { validReadingPosition, type ReadingPosition } from '../reading-position';

/** No controller broadcast: a position write must not remount the article. */
export function persistPosition(viewport: HTMLElement, get: () => ReadingPosition | undefined,
  save: (position: ReadingPosition) => Promise<void>, report: (error: unknown) => void, sourceEpoch: () => number = () => 0) {
  const doc = viewport.ownerDocument, win = doc.defaultView!;
  let timer = 0, disposed = false, last = JSON.stringify(get());
  let writes = Promise.resolve();
  function flush(): Promise<void> {
    if (disposed) return writes; // Drain the terminal snapshot; never recapture a retired DOM.
    win.clearTimeout(timer); timer = 0;
    const position = validReadingPosition(get());
    if (!position || JSON.stringify(position) === last) return writes;
    const key = JSON.stringify(position), capturedEpoch = sourceEpoch(); last = key;
    // A queued sample belongs to its capture-time source, even if a stale DOM
    // has since rerendered and become readable again. Own text-preserving edits
    // deliberately retain the caller's epoch.
    writes = writes.then(() => { if (capturedEpoch === sourceEpoch()) return save(position); }).catch(error => {
      if (last === key) last = ''; // Permit a later event/lifecycle flush to retry.
      report(error);
    });
    return writes;
  }
  function changed() {
    if (disposed) return;
    win.clearTimeout(timer); timer = win.setTimeout(() => { void flush(); }, 600);
  }
  const hidden = () => { if (doc.visibilityState === 'hidden') void flush(); };
  const leaving = () => { void flush(); };
  viewport.addEventListener('scroll', changed, { passive: true });
  doc.addEventListener('visibilitychange', hidden); win.addEventListener('pagehide', leaving);
  return {
    changed, flush,
    restored() { last = JSON.stringify(get()); },
    remapped() { if (!disposed) last = ''; }, // Queue a guarded destination write even if an old-path request is pending.
    dispose(): Promise<void> {
      if (disposed) return writes;
      const terminal = flush(); disposed = true;
      viewport.removeEventListener('scroll', changed);
      doc.removeEventListener('visibilitychange', hidden); win.removeEventListener('pagehide', leaving);
      return terminal;
    },
  };
}
