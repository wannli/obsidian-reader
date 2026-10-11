import { validReadingPosition } from '../reading-position';
import type { EinkAnchor, EinkGeometry, ReadingPosition } from './eink-types';
export type { ReadingPosition } from './eink-types';

const EXCLUDED = '[data-reader-ui], [data-reader-ignore], [hidden], [aria-hidden="true"], script, style, button, input, textarea, select';
interface Entry { node: Text; offset: number }
function index(body: HTMLElement) {
  const entries: Entry[] = [], parts: string[] = [];
  const walker = body.ownerDocument.createTreeWalker(body, 4 /* SHOW_TEXT */);
  let length = 0;
  for (let node = walker.nextNode() as Text | null; node; node = walker.nextNode() as Text | null) {
    const excluded = node.parentElement?.closest(EXCLUDED);
    if (excluded && body.contains(excluded)) continue;
    // Do not exclude a hidden VIEW: its saved offsets must remain usable on reveal.
    let hidden = false;
    for (let el = node.parentElement; el && el !== body; el = el.parentElement) {
      if (body.ownerDocument.defaultView?.getComputedStyle(el).display === 'none') { hidden = true; break; }
    }
    if (hidden) continue;
    entries.push({ node, offset: length }); parts.push(node.data); length += node.length;
  }
  return { entries, text: parts.join('') };
}
function character(node: Text, offset: number): Range {
  const range = node.ownerDocument.createRange();
  const start = Math.min(Math.max(0, offset), Math.max(0, node.length - 1));
  range.setStart(node, start); range.setEnd(node, Math.min(node.length, start + 1));
  return range;
}
function rects(range: Range): DOMRect[] {
  return typeof range.getClientRects === 'function' ? [...range.getClientRects()] : [];
}
function bounds(range: Range): DOMRect {
  return typeof range.getBoundingClientRect === 'function' ? range.getBoundingClientRect()
    : rects(range)[0] ?? { left: 0, right: 0, top: 0, bottom: 0, width: 0, height: 0 } as DOMRect;
}
function describe(_body: HTMLElement, text: string, offset: number, start = false): ReadingPosition {
  if (start || offset <= 0) return { marker: '' };
  const words: string[] = [], matcher = /\S+/gu;
  let beginning = Math.max(0, offset);
  while (beginning > 0 && /\S/u.test(text[beginning - 1])) beginning--;
  matcher.lastIndex = beginning;
  for (let match; words.length < 5 && (match = matcher.exec(text));) words.push(match[0]);
  const marker = words.join(' ');
  return { marker: marker.length <= 256 ? marker : '' };
}

/** Resolve the first occurrence of five words; a missing marker means start. */
export function rangeForReadingPosition(body: HTMLElement, position: ReadingPosition): Range | null {
  const valid = validReadingPosition(position);
  if (!valid?.marker) return null;
  const { entries, text } = index(body);
  const words = valid.marker.split(/\s+/u);
  const pattern = words.map(word => word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('\\s+');
  const match = new RegExp(`(^|\\s)(${pattern})`, 'u').exec(text);
  if (!match) return null;
  const offset = match.index + match[1].length;
  const entry = entries.find(({ node, offset: start }) => start + node.length > offset);
  return entry ? character(entry.node, offset - entry.offset) : null;
}

/** Capture the first visible body character in the ordinary scrolling Reader. */
export function captureReadingPosition(viewport: HTMLElement, body: HTMLElement): ReadingPosition {
  const { entries, text } = index(body);
  if (viewport.scrollTop <= 0 || !viewport.clientWidth || !viewport.clientHeight ||
      typeof body.ownerDocument.createRange().getClientRects !== 'function') return describe(body, text, 0, true);
  const viewportBounds = viewport.getBoundingClientRect();
  for (const { node, offset } of entries) {
    if (!node.data.trim()) continue;
    const range = node.ownerDocument.createRange(); range.selectNodeContents(node);
    const fragments = rects(range).filter(r => r.width > 0 && r.height > 0);
    // A viewport containing only title/media should not jump to the article's end.
    if (fragments.length && fragments.every(r => r.top >= viewportBounds.bottom)) return describe(body, text, offset, offset === 0);
    if (!fragments.some(r => r.bottom > viewportBounds.top && r.top < viewportBounds.bottom)) continue;
    let lo = 0, hi = node.length;
    while (lo < hi) {
      const mid = (lo + hi) >>> 1;
      if (bounds(character(node, mid)).bottom <= viewportBounds.top) lo = mid + 1; else hi = mid;
    }
    return describe(body, text, offset + lo);
  }
  return describe(body, text, Math.max(0, text.length - 1));
}

export function createEinkAnchors(viewport: HTMLElement, page: HTMLElement, body: HTMLElement) {
  function column(rect: DOMRect, geometry: EinkGeometry, displayed: number): number {
    const bounds = viewport.getBoundingClientRect();
    const scale = viewport.offsetWidth ? bounds.width / viewport.offsetWidth : 1;
    const contentLeft = bounds.left + viewport.clientLeft * (scale || 1);
    const contentRight = contentLeft + viewport.clientWidth * (scale || 1);
    const x = (geometry.flow === -1 ? contentRight - rect.right : rect.left - contentLeft)
      / (scale || 1) - geometry.gutter;
    return Math.max(0, Math.floor((x + displayed * geometry.stride + 0.5) / geometry.stride));
  }
  function rangePage(range: Range, geometry: EinkGeometry, displayed: number): number | null {
    if (!body.contains(range.startContainer) || !body.contains(range.endContainer)) return null;
    // Element-range rectangles can be the union of several columns: use text fragments.
    for (const { node } of index(body).entries) {
      if (!node.length || range.comparePoint(node, node.length) < 0) continue;
      if (range.comparePoint(node, 0) > 0) break;
      const start = node === range.startContainer ? range.startOffset : 0;
      const end = node === range.endContainer ? range.endOffset : node.length;
      if (end <= start && !range.collapsed) continue;
      const part = node.ownerDocument.createRange();
      part.setStart(node, start); part.setEnd(node, Math.max(start, end));
      const rect = rects(part).find(r => r.height > 0 && (r.width > 0 || range.collapsed));
      if (rect) return column(rect, geometry, displayed);
    }
    return null;
  }
  function capture(geometry: EinkGeometry, displayed: number): EinkAnchor {
    const { entries, text } = index(body);
    if (!displayed) return { position: { marker: '' } };
    let following = text.length;
    for (const { node, offset } of entries) {
      if (!node.data.trim()) continue;
      const range = node.ownerDocument.createRange(); range.selectNodeContents(node);
      const fragments = rects(range).filter(r => r.width > 0 && r.height > 0);
      if (fragments.some(r => column(r, geometry, displayed) > displayed)) following = Math.min(following, offset);
      if (!fragments.some(r => column(r, geometry, displayed) === displayed)) continue;
      let lo = 0, hi = node.length;
      while (lo < hi) {
        const mid = (lo + hi) >>> 1;
        if (column(bounds(character(node, mid)), geometry, displayed) < displayed) lo = mid + 1; else hi = mid;
      }
      if (lo < node.length) return { position: describe(body, text, offset + lo) };
    }
    const element = [...body.querySelectorAll('img, video, hr, table')].find(el =>
      !el.closest(EXCLUDED) && [...el.getClientRects()].some(r => column(r, geometry, displayed) === displayed));
    return { position: describe(body, text, Math.min(following, Math.max(0, text.length - 1))), element };
  }
  return {
    capture, rangePage,
    positionForRange(range: Range): ReadingPosition | null {
      if (!body.contains(range.startContainer) || !body.contains(range.endContainer)) return null;
      const { entries, text } = index(body);
      for (const { node, offset } of entries) {
        if (!node.length || range.comparePoint(node, node.length) < 0) continue;
        if (range.comparePoint(node, 0) > 0) break;
        const start = node === range.startContainer ? range.startOffset : 0;
        if (start < node.length) return describe(body, text, offset + start);
      }
      return null;
    },
    pageFor(anchor: EinkAnchor, geometry: EinkGeometry, displayed: number): number {
      if (!anchor.position.marker) return 0;
      if (anchor.element && body.contains(anchor.element)) return column(anchor.element.getBoundingClientRect(), geometry, displayed);
      const range = rangeForReadingPosition(body, anchor.position);
      if (!range) { anchor.position = { marker: '' }; return 0; }
      return rangePage(range, geometry, displayed) ?? 0;
    },
    count(geometry: EinkGeometry): number {
      // A stale fallback highlight overlay may extend beyond the new last column.
      // Fragment boxes of canonical page children count columns without that UI.
      let total = 1;
      for (const child of page.children) {
        if (child.matches(EXCLUDED)) continue;
        for (const rect of child.getClientRects()) {
          if (rect.width <= 0 || rect.height <= 0) continue;
          const edge = { left: rect.right - 1, right: rect.left + 1 } as DOMRect;
          total = Math.max(total, column(edge, geometry, 0) + 1);
        }
      }
      return total;
    },
  };
}
