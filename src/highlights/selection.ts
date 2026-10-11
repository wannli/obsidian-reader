import { createAnchor } from './selectors';
import { buildCanonicalTextIndex, rangeFromPosition } from './text-index';
import type { SelectionSnapshot } from './types';

/** Snapshot before a toolbar button/keyboard steals focus and collapses selection. */
export function captureSelection(
  root: HTMLElement, articleVersion: string, selection = root.ownerDocument.getSelection(),
): SelectionSnapshot | null {
  if (!selection || selection.rangeCount !== 1 || selection.isCollapsed) return null;
  try {
    const anchor = createAnchor(root, selection.getRangeAt(0), articleVersion);
    const range = rangeFromPosition(buildCanonicalTextIndex(root), anchor.position);
    const rect = typeof range.getBoundingClientRect === 'function' ? range.getBoundingClientRect() : null;
    return { anchor, range: range.cloneRange(), rect };
  } catch {
    return null; // Outside root, detached range, whitespace-only, or inaccessible DOM.
  }
}
