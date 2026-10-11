/** Reserve only the part of this Reader covered by visible host overlays/keyboard. */
export function watchReaderViewport(root: HTMLElement, overlays: () => readonly HTMLElement[] = () => [], mobile = false): () => void {
  const doc = root.ownerDocument, view = doc.defaultView, parent = root.parentElement;
  if (!view || !parent || !mobile) return () => {};
  const originalHeight = root.style.height, originalSafe = root.style.getPropertyValue('--r2-safe-bottom');
  let frame = 0, disposed = false;
  const overlaySizes = typeof ResizeObserver === 'undefined' ? undefined : new ResizeObserver(schedule);
  let observed: HTMLElement[] = [];
  function set(name: string, value: string) {
    if (root.style.getPropertyValue(name) === value) return;
    if (value) root.style.setProperty(name, value); else root.style.removeProperty(name);
  }
  function measure() {
    frame = 0;
    if (disposed || !root.isConnected) return;
    const bounds = parent!.getBoundingClientRect(), viewport = view!.visualViewport;
    if (!bounds.width || !bounds.height) return;
    const keyboard = Math.max(0, parseFloat(view!.getComputedStyle(doc.body).getPropertyValue('--keyboard-height')) || 0);
    const visibleBottom = Math.min((viewport?.offsetTop ?? 0) + (viewport?.height ?? view!.innerHeight), doc.documentElement.clientHeight - keyboard);
    let bottom = Math.min(bounds.bottom, visibleBottom), hostBoundary = false;
    const current = [...overlays()];
    if (current.length !== observed.length || current.some((item, index) => item !== observed[index])) {
      overlaySizes?.disconnect(); for (const item of current) overlaySizes?.observe(item); observed = current;
    }
    for (const overlay of current) {
      if (!overlay.isConnected || root.contains(overlay)) continue;
      const rect = overlay.getBoundingClientRect(), style = view!.getComputedStyle(overlay);
      if (!rect.width || !rect.height || style.visibility === 'hidden' || style.display === 'none' || Number(style.opacity) === 0) continue;
      if (rect.right <= bounds.left || rect.left >= bounds.right || rect.bottom <= bounds.top || rect.top >= visibleBottom) continue;
      // A host control already laid out below the leaf must not be counted twice.
      hostBoundary = true;
      if (rect.top >= bounds.top && rect.top < bottom) bottom = Math.max(bounds.top, rect.top - 4);
    }
    set('height', bottom < bounds.bottom - 0.5 ? Math.max(0, Math.floor(bottom - bounds.top)) + 'px' : originalHeight);
    set('--r2-safe-bottom', hostBoundary || visibleBottom < bounds.bottom - 0.5 ? '0px' : originalSafe);
  }
  function schedule() { if (!disposed && !frame) frame = view!.requestAnimationFrame(measure); }
  const parentSize = typeof ResizeObserver === 'undefined' ? undefined : new ResizeObserver(schedule); parentSize?.observe(parent);
  const changes = new MutationObserver(records => {
    if (records.some(record => !root.contains(record.target))) schedule();
  });
  changes.observe(doc.documentElement, { subtree: true, childList: true, attributes: true, attributeFilter: ['class', 'style', 'hidden'] });
  view.addEventListener('resize', schedule); view.visualViewport?.addEventListener('resize', schedule); view.visualViewport?.addEventListener('scroll', schedule);
  doc.addEventListener('transitionend', schedule, true); doc.addEventListener('animationend', schedule, true);
  measure();
  return () => {
    if (disposed) return; disposed = true; if (frame) view.cancelAnimationFrame(frame);
    changes.disconnect(); parentSize?.disconnect(); overlaySizes?.disconnect();
    view.removeEventListener('resize', schedule); view.visualViewport?.removeEventListener('resize', schedule); view.visualViewport?.removeEventListener('scroll', schedule);
    doc.removeEventListener('transitionend', schedule, true); doc.removeEventListener('animationend', schedule, true);
    set('height', originalHeight); set('--r2-safe-bottom', originalSafe);
  };
}
