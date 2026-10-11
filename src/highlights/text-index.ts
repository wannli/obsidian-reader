import { isWhitespace, NORMALISATION_VERSION } from './text-normalisation';
import type { IndexedCodePoint, TextIndex, TextPositionSelector } from './types';

const BLOCKS = new Set([
  'ADDRESS', 'ARTICLE', 'ASIDE', 'BLOCKQUOTE', 'CAPTION', 'DD', 'DIV', 'DL', 'DT',
  'FIGCAPTION', 'FIGURE', 'FOOTER', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'HEADER',
  'HR', 'LI', 'MAIN', 'NAV', 'OL', 'P', 'PRE', 'SECTION', 'TABLE', 'TD', 'TH', 'TR', 'UL',
]);
const EXCLUDED = new Set([
  'SCRIPT', 'STYLE', 'NOSCRIPT', 'TEMPLATE', 'SVG', 'MATH', 'IFRAME', 'OBJECT',
  'CANVAS', 'INPUT', 'TEXTAREA', 'SELECT', 'BUTTON', 'AUDIO', 'VIDEO',
]);

function isExcluded(element: Element): boolean {
  if (EXCLUDED.has(element.tagName) || element.hasAttribute('hidden') ||
      element.hasAttribute('inert') || element.hasAttribute('data-reader-ui') ||
      element.hasAttribute('data-reader-ignore') ||
      element.getAttribute('aria-hidden')?.toLowerCase() === 'true') return true;
  const style = element.ownerDocument.defaultView?.getComputedStyle(element);
  return style?.display === 'none' || style?.visibility === 'hidden' ||
    style?.visibility === 'collapse' || style?.contentVisibility === 'hidden';
}

/** UI overlays must use data-reader-ui, or live outside the article root. */
export function buildCanonicalTextIndex(root: HTMLElement): TextIndex {
  const units: IndexedCodePoint[] = [];
  let gap = false;
  function visit(node: Node): void {
    if (node.nodeType === 3) {
      const text = node as Text;
      let offset = 0;
      for (const value of text.data) {
        const start = { node: text, offset };
        offset += value.length; // Native DOM offsets count UTF-16 code units.
        const end = { node: text, offset };
        if (isWhitespace(value)) { gap = true; continue; }
        if (gap && units.length) {
          units.push({ value: ' ', start: units[units.length - 1]!.end, end: start });
        }
        units.push({ value, start, end });
        gap = false;
      }
      return;
    }
    if (node.nodeType !== 1) return;
    const element = node as Element;
    if (isExcluded(element)) return;
    const boundary = BLOCKS.has(element.tagName) || element.tagName === 'BR';
    if (boundary) gap = true;
    for (const child of element.childNodes) visit(child);
    if (boundary) gap = true;
  }
  visit(root);
  const codePoints = units.map((unit) => unit.value);
  return { root, normalisationVersion: NORMALISATION_VERSION, text: codePoints.join(''), codePoints, units };
}

export function rangeIsInside(root: HTMLElement, range: Range): boolean {
  return root.contains(range.startContainer) && root.contains(range.endContainer);
}

export function rangeFromPosition(index: TextIndex, position: TextPositionSelector): Range {
  const { start, end } = position;
  if (!Number.isInteger(start) || !Number.isInteger(end) || start < 0 || end <= start || end > index.units.length) {
    throw new Error('Text position is outside the canonical article.');
  }
  const first = index.units[start]!;
  const last = index.units[end - 1]!;
  const range = index.root.ownerDocument.createRange();
  range.setStart(first.start.node, first.start.offset);
  range.setEnd(last.end.node, last.end.offset);
  return range;
}

/** Snap partial surrogate selections to whole code points and trim edge whitespace. */
export function positionFromRange(index: TextIndex, range: Range): TextPositionSelector {
  if (range.collapsed || !rangeIsInside(index.root, range)) {
    throw new Error('Select non-empty text entirely within the article.');
  }
  const firstBoundary = range.cloneRange();
  const lastBoundary = range.cloneRange();
  firstBoundary.collapse(true);
  lastBoundary.collapse(false);
  let start = -1;
  let end = -1;
  for (let i = 0; i < index.units.length; i++) {
    const unit = index.units[i]!;
    if (firstBoundary.comparePoint(unit.end.node, unit.end.offset) > 0 &&
        lastBoundary.comparePoint(unit.start.node, unit.start.offset) < 0) {
      if (start === -1) start = i;
      end = i + 1;
    }
  }
  while (start >= 0 && start < end && index.codePoints[start] === ' ') start++;
  while (end > start && index.codePoints[end - 1] === ' ') end--;
  if (start < 0 || start === end) throw new Error('The selection contains no readable article text.');
  return { start, end };
}
