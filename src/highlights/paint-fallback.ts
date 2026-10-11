import { rangeIsInside } from './text-index';
import { intersects, textRangeFragments, textRangeRects, visibleBounds } from './paint-geometry';
import { backgroundOccludesHighlight } from './paint-background';
import type { NativePaint } from './paint-native';
import { resolveHighlightPalette } from './paint-palette';
import { observePaintChanges } from './paint-changes';
import { acquireScope } from './paint-scope';
import type { HighlightColour, ResolvedHighlight } from './types';

/** Pointer-transparent rectangles outside the canonical article; no text mutation. */
export function paintFallback(
  root: HTMLElement, highlights: readonly ResolvedHighlight[], colours: Record<HighlightColour, string>,
  nativeOccluded?: NativePaint,
): () => void {
  const document = root.ownerDocument;
  const window = document.defaultView as (Window & { ResizeObserver?: typeof ResizeObserver }) | null;
  const host = root.parentElement?.closest<HTMLElement>('[data-reader-highlight-scope], .r2-reading-page, .reader, .personal-reader')
    ?? root.parentElement;
  if (!window || !host) return () => {};
  const dispose: (() => void)[] = [acquireScope(host)];
  let palette = colours;
  let disposed = false;
  const layer = document.createElement('div');
  layer.className = 'reader-highlight-layer';
  layer.setAttribute('data-reader-ui', 'highlight-overlay');
  layer.setAttribute('aria-hidden', 'true');
  // A one-CSS-pixel probe supplies local coordinates under translated/scaled panes.
  // Each rectangle is explicitly clipped; children can extend outside this tiny box.
  layer.style.cssText = 'position:absolute;left:0;top:0;width:1px;height:1px;pointer-events:none;z-index:1;overflow:visible;';
  host.append(layer);
  dispose.push(() => layer.remove());
  function update() {
    if (disposed) return;
    layer.replaceChildren();
    const bounds = visibleBounds(root);
    if (!bounds) return;
    const origin = layer.getBoundingClientRect();
    const scaleX = origin.width || 1;
    const scaleY = origin.height || 1;
    const overlays: ResolvedHighlight[] = [];
    const native: ResolvedHighlight[] = [];
    const occluded = nativeOccluded ? backgroundOccludesHighlight(root) : undefined;
    for (const item of highlights) {
      if (!rangeIsInside(root, item.range)) continue;
      if (!occluded) { overlays.push(item); continue; }
      for (const range of textRangeFragments(item.range)) {
        (occluded(range) ? native : overlays).push({ ...item, range });
      }
    }
    // Native paint is necessary above source backgrounds. If the API fails, keep
    // the old underlay behavior rather than alter text, backgrounds or foreground.
    if (nativeOccluded && !nativeOccluded.update(native, palette)) {
      overlays.push(...native);
      nativeOccluded = undefined;
    }
    const fragment = document.createDocumentFragment();
    const seen = new Set<string>();
    for (const item of overlays) {
      for (const rect of textRangeRects(item.range, root)) {
        const clipped = intersects(bounds, rect);
        if (!clipped) continue;
        const key = JSON.stringify([item.id, item.colour, clipped]);
        if (seen.has(key)) continue;
        seen.add(key);
        const box = document.createElement('span');
        box.setAttribute('data-reader-highlight-colour', item.colour);
        box.style.cssText = 'position:absolute;pointer-events:none;';
        box.style.backgroundColor = palette[item.colour];
        box.style.left = `${(clipped.left - origin.left) / scaleX}px`;
        box.style.top = `${(clipped.top - origin.top) / scaleY}px`;
        box.style.width = `${(clipped.right - clipped.left) / scaleX}px`;
        box.style.height = `${(clipped.bottom - clipped.top) / scaleY}px`;
        fragment.append(box);
      }
    }
    layer.append(fragment);
  }
  let frame: number | undefined;
  const requestFrame = window.requestAnimationFrame?.bind(window)
    ?? ((callback: FrameRequestCallback) => window.setTimeout(callback, 16));
  const cancelFrame = window.cancelAnimationFrame?.bind(window) ?? window.clearTimeout.bind(window);
  function schedule() {
    if (!disposed && frame === undefined) {
      frame = requestFrame(() => { frame = undefined; update(); });
    }
  }
  dispose.push(observePaintChanges(root, () => {
    palette = resolveHighlightPalette(root);
    schedule();
  }));
  document.addEventListener('scroll', schedule, true);
  window.addEventListener('resize', schedule);
  window.visualViewport?.addEventListener('resize', schedule);
  window.visualViewport?.addEventListener('scroll', schedule);
  root.addEventListener('load', schedule, true); // Images may change line positions.
  document.fonts?.addEventListener('loadingdone', schedule);
  void document.fonts?.ready?.then(() => { if (!disposed) schedule(); });
  const observer = window.ResizeObserver ? new window.ResizeObserver(schedule) : undefined;
  observer?.observe(root);
  dispose.push(() => {
    if (frame !== undefined) cancelFrame(frame);
    observer?.disconnect();
    document.removeEventListener('scroll', schedule, true);
    window.removeEventListener('resize', schedule);
    window.visualViewport?.removeEventListener('resize', schedule);
    window.visualViewport?.removeEventListener('scroll', schedule);
    root.removeEventListener('load', schedule, true);
    document.fonts?.removeEventListener('loadingdone', schedule);
  });
  update();
  return () => {
    if (disposed) return;
    disposed = true;
    for (const release of dispose.splice(0).reverse()) release();
  };
}
