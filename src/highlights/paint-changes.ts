/** Observe theme/background attributes and stylesheets, never document-wide text. */
export function observePaintChanges(root: HTMLElement, refresh: () => void): () => void {
  const document = root.ownerDocument;
  const window = document.defaultView;
  if (!window || typeof window.MutationObserver !== 'function') return () => {};
  let disposed = false;
  let frame: number | undefined;
  const request = window.requestAnimationFrame?.bind(window)
    ?? ((callback: FrameRequestCallback) => window.setTimeout(callback, 16));
  const cancel = window.cancelAnimationFrame?.bind(window) ?? window.clearTimeout.bind(window);
  function schedule() {
    if (!disposed && frame === undefined) frame = request(() => {
      frame = undefined;
      if (!disposed) refresh();
    });
  }
  const Observer = window.MutationObserver;
  const observer = new Observer(schedule);
  // Source descendant backgrounds can change hybrid routing. Renderer-owned nodes
  // remain outside root, so this article-scoped attribute observer cannot loop.
  observer.observe(root, { attributes: true, attributeFilter: ['class', 'style', 'data-theme'], subtree: true });
  for (let element = root.parentElement; element; element = element.parentElement) {
    observer.observe(element, { attributes: true, attributeFilter: ['class', 'style', 'data-theme'] });
  }
  const sheets = new Map<Element, MutationObserver>();
  function syncSheets() {
    const current = new Set(document.head?.querySelectorAll('style:not([data-reader-ui]), link[rel~="stylesheet"]'));
    for (const [element, watcher] of sheets) {
      if (current.has(element)) continue;
      watcher.disconnect();
      element.removeEventListener('load', schedule);
      sheets.delete(element);
    }
    for (const element of current) {
      if (sheets.has(element)) continue;
      const watcher = new Observer(schedule);
      watcher.observe(element, { attributes: true, childList: true, characterData: true, subtree: true });
      element.addEventListener('load', schedule);
      sheets.set(element, watcher);
    }
  }
  syncSheets();
  const head = new Observer((records) => {
    // Ignore our native style updates, overlay nodes and measurement probes.
    if (!records.some((record) => [...record.addedNodes, ...record.removedNodes].some((node) =>
      node.nodeType === 1 && !(node as Element).hasAttribute('data-reader-ui') &&
      (node as Element).matches('style, link[rel~="stylesheet"]')))) return;
    syncSheets();
    schedule();
  });
  if (document.head) head.observe(document.head, { childList: true });
  const media = window.matchMedia?.('(prefers-color-scheme: dark)');
  media?.addEventListener?.('change', schedule);
  return () => {
    if (disposed) return;
    disposed = true;
    if (frame !== undefined) cancel(frame);
    observer.disconnect();
    head.disconnect();
    for (const [element, watcher] of sheets) {
      watcher.disconnect();
      element.removeEventListener('load', schedule);
    }
    sheets.clear();
    media?.removeEventListener?.('change', schedule);
  };
}
