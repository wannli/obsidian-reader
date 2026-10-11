export interface Bounds { left: number; right: number; top: number; bottom: number }

export function intersects(a: Bounds, b: Bounds): Bounds | null {
  const value = {
    left: Math.max(a.left, b.left), right: Math.min(a.right, b.right),
    top: Math.max(a.top, b.top), bottom: Math.min(a.bottom, b.bottom),
  };
  return value.right > value.left && value.bottom > value.top ? value : null;
}

export function visibleBounds(root: HTMLElement): Bounds | null {
  const window = root.ownerDocument.defaultView;
  if (!window) return null;
  let bounds = intersects(root.getBoundingClientRect(), {
    left: 0, top: 0, right: window.innerWidth, bottom: window.innerHeight,
  });
  // Never paint across scroll containers into the surrounding Obsidian interface.
  for (let parent = root.parentElement; parent && bounds; parent = parent.parentElement) {
    const style = window.getComputedStyle(parent);
    const clipX = /(auto|scroll|hidden|clip)/u.test(style.overflowX || style.overflow);
    const clipY = /(auto|scroll|hidden|clip)/u.test(style.overflowY || style.overflow);
    if (clipX || clipY) {
      const rect = parent.getBoundingClientRect();
      bounds = intersects(bounds, {
        left: clipX ? rect.left : bounds.left, right: clipX ? rect.right : bounds.right,
        top: clipY ? rect.top : bounds.top, bottom: clipY ? rect.bottom : bounds.bottom,
      });
    }
  }
  return bounds;
}

export function rects(range: Range): DOMRect[] {
  return typeof range.getClientRects === 'function' ? Array.from(range.getClientRects()) : [];
}

function afterSubtree(node: Node, boundary: Node): Node | null {
  for (let current: Node | null = node; current && current !== boundary; current = current.parentNode) {
    if (current.nextSibling) return current.nextSibling;
  }
  return null;
}

function overflowBounds(element: HTMLElement, window: Window): Bounds | null {
  const style = window.getComputedStyle(element);
  // Overflow does not clip non-replaced inline boxes; contents has no box at all.
  if (style.display === 'inline' || style.display === 'contents') return null;
  const clipX = /(auto|scroll|hidden|clip)/u.test(style.overflowX || style.overflow);
  const clipY = /(auto|scroll|hidden|clip)/u.test(style.overflowY || style.overflow);
  if (!clipX && !clipY) return null;
  const rect = element.getBoundingClientRect();
  const scaleX = element.offsetWidth ? rect.width / element.offsetWidth : 1;
  const scaleY = element.offsetHeight ? rect.height / element.offsetHeight : 1;
  const left = rect.left + element.clientLeft * scaleX;
  const top = rect.top + element.clientTop * scaleY;
  return {
    left: clipX ? left : -Infinity,
    right: clipX ? (element.offsetWidth ? left + element.clientWidth * scaleX : rect.right) : Infinity,
    top: clipY ? top : -Infinity,
    bottom: clipY ? (element.offsetHeight ? top + element.clientHeight * scaleY : rect.bottom) : Infinity,
  };
}

/** Shared bounded traversal for overlay geometry and background/native routing. */
export function textRangeFragments(range: Range): Range[] {
  if (range.collapsed) return [];
  const document = range.startContainer.ownerDocument;
  if (!document) return [];
  const common = range.commonAncestorContainer;
  if (common.nodeType === 3) return [range];
  const startContainer = range.startContainer;
  const first = startContainer.nodeType === 3 ? startContainer
    : startContainer.childNodes[range.startOffset] ?? afterSubtree(startContainer, common);
  if (!first) return [];
  const walker = document.createTreeWalker(common, 4 /* SHOW_TEXT */);
  walker.currentNode = first;
  let node = (first.nodeType === 3 ? first : walker.nextNode()) as Text | null;
  const result: Range[] = [];
  for (; node; node = walker.nextNode() as Text | null) {
    if (range.comparePoint(node, 0) > 0) break;
    const start = node === startContainer ? range.startOffset : 0;
    const end = node === range.endContainer ? range.endOffset : node.length;
    if (end <= start) continue;
    const fragment = document.createRange();
    fragment.setStart(node, start);
    fragment.setEnd(node, end);
    result.push(fragment);
  }
  return result;
}

/** Text-only geometry, optionally clipped by inner overflow containers. */
export function textRangeRects(range: Range, clipRoot?: HTMLElement): Bounds[] {
  const result: Bounds[] = [];
  const seen = new Set<string>();
  const clips = new Map<HTMLElement, Bounds | null>();
  const window = range.startContainer.ownerDocument?.defaultView;
  for (const fragment of textRangeFragments(range)) {
    for (const rect of rects(fragment)) {
      const edges = [rect.left, rect.right, rect.top, rect.bottom];
      if (!edges.every(Number.isFinite) || rect.right <= rect.left || rect.bottom <= rect.top) continue;
      let clipped: Bounds | null = rect;
      if (clipRoot && window) {
        for (let parent = fragment.startContainer.parentElement; parent && parent !== clipRoot && clipped; parent = parent.parentElement) {
          if (!clips.has(parent)) clips.set(parent, overflowBounds(parent, window));
          const clip = clips.get(parent);
          if (clip) clipped = intersects(clipped, clip);
        }
      }
      if (!clipped) continue;
      const key = [clipped.left, clipped.right, clipped.top, clipped.bottom].join(',');
      if (seen.has(key)) continue;
      seen.add(key);
      result.push(clipped);
    }
  }
  return result;
}
