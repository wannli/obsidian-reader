import { buildCanonicalTextIndex, positionFromRange, rangeFromPosition, rangeIsInside } from './text-index';
import { NORMALISATION_VERSION } from './text-normalisation';
import type { ArticleAnchor, DomRangeSelector } from './types';

function pathTo(root: HTMLElement, node: Node): number[] {
  const path: number[] = [];
  let current = node;
  while (current !== root) {
    const parent = current.parentNode;
    if (!parent) throw new Error('Range is outside the article.');
    path.unshift(Array.prototype.indexOf.call(parent.childNodes, current));
    current = parent;
  }
  return path;
}

export function createDomRangeSelector(root: HTMLElement, range: Range): DomRangeSelector {
  if (!rangeIsInside(root, range)) throw new Error('Range is outside the article.');
  return {
    start: { path: pathTo(root, range.startContainer), offset: range.startOffset },
    end: { path: pathTo(root, range.endContainer), offset: range.endOffset },
  };
}

export function rangeFromDomSelector(root: HTMLElement, selector: DomRangeSelector): Range {
  function resolve(point: DomRangeSelector['start']): Node {
    let node: Node = root;
    if (!Array.isArray(point.path) || !Number.isInteger(point.offset) || point.offset < 0) {
      throw new Error('Invalid structural selector.');
    }
    for (const index of point.path) {
      if (!Number.isInteger(index) || index < 0 || index >= node.childNodes.length) {
        throw new Error('Structural selector no longer exists.');
      }
      node = node.childNodes[index]!;
    }
    return node;
  }
  const range = root.ownerDocument.createRange();
  range.setStart(resolve(selector.start), selector.start.offset);
  range.setEnd(resolve(selector.end), selector.end.offset);
  if (range.collapsed) throw new Error('Structural selector is empty.');
  return range;
}

export function createAnchor(root: HTMLElement, range: Range, articleVersion: string): ArticleAnchor {
  if (!articleVersion) throw new Error('An article version is required.');
  const index = buildCanonicalTextIndex(root);
  const position = positionFromRange(index, range);
  const { start, end } = position;
  return {
    articleVersion,
    normalisationVersion: NORMALISATION_VERSION,
    quote: {
      exact: index.codePoints.slice(start, end).join(''),
      prefix: index.codePoints.slice(Math.max(0, start - 32), start).join(''),
      suffix: index.codePoints.slice(end, end + 32).join(''),
    },
    position,
    structural: createDomRangeSelector(root, rangeFromPosition(index, position)),
  };
}
