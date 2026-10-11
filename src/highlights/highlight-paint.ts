import { rangeIsInside } from './text-index';
import { rects, visibleBounds } from './paint-geometry';
import { paintFallback } from './paint-fallback';
import { resolveHighlightPalette } from './paint-palette';
import { observePaintChanges } from './paint-changes';
import { prefersHighlightOverlay } from './paint-engine';
import { createNativePaint } from './paint-native';
import type { HighlightColour, ResolvedHighlight } from './types';

const COLOURS: readonly HighlightColour[] = ['yellow', 'green', 'blue', 'pink', 'purple'];
const active = new WeakMap<HTMLElement, () => void>();

export function clearHighlights(root: HTMLElement): void {
  active.get(root)?.();
}

/** Returns all overlapping annotations; CSS highlights themselves are not DOM nodes. */
export function hitTestHighlights(
  root: HTMLElement, resolved: readonly ResolvedHighlight[], x: number, y: number,
): ResolvedHighlight[] {
  const bounds = visibleBounds(root);
  if (!bounds || x < bounds.left || x > bounds.right || y < bounds.top || y > bounds.bottom) return [];
  return resolved.filter((item) => rangeIsInside(root, item.range) && !item.range.collapsed &&
    rects(item.range).some((rect) => rect.width > 0 && rect.height > 0 &&
      x >= rect.left && x <= rect.right && y >= rect.top && y <= rect.bottom));
}

/**
 * Paint after durable vault writes succeed. Never wrap or split canonical text.
 * Fallback rectangles are pointer-transparent and below the Reader's controls.
 * Each call replaces this root's previous painting and returns idempotent cleanup.
 */
export function paintHighlights(
  root: HTMLElement,
  resolved: readonly ResolvedHighlight[],
  options: { forceFallback?: boolean } = {},
): () => void {
  clearHighlights(root);
  const document = root.ownerDocument;
  const window = document.defaultView;
  if (!window) return () => {};
  const highlights = resolved.filter((item) => rangeIsInside(root, item.range) && !item.range.collapsed &&
    COLOURS.includes(item.colour));
  if (!highlights.length) return () => {};
  const dispose: (() => void)[] = [];
  let disposed = false;
  const cleanup = () => {
    if (disposed) return;
    disposed = true;
    for (const release of dispose.splice(0).reverse()) release();
    if (active.get(root) === cleanup) active.delete(root);
  };
  active.set(root, cleanup);

  const palette = resolveHighlightPalette(root);
  const preferOverlay = prefersHighlightOverlay(window.navigator.userAgent);
  const native = options.forceFallback ? null : createNativePaint(root);
  if (native) dispose.push(native.dispose);
  if (!preferOverlay && native?.update(highlights, palette)) {
    dispose.push(observePaintChanges(root, () => native.update(highlights, resolveHighlightPalette(root))));
    return cleanup;
  }
  // Keep a stable underlay/scope. WebKit uses native paint only where article
  // backgrounds would otherwise cover it; routing updates never reacquire scope.
  dispose.push(paintFallback(root, highlights, palette, preferOverlay ? native ?? undefined : undefined));
  return cleanup;
}
