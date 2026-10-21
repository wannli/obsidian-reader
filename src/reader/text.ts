/** Reader-owned references/anchors are controls, not article or bookmark text. */
export const READER_DECORATION = '[data-reader-decoration]';
export function readerDecoration(node: Node): boolean {
  const element = node.nodeType === Node.ELEMENT_NODE ? (node as Element) : node.parentElement;
  return !!element?.closest(READER_DECORATION);
}

/** Preserve Range text semantics while omitting Reader-owned reference controls. */
export function readerRangeText(range: Range): string {
  const container = range.commonAncestorContainer;
  const root =
    container.nodeType === Node.ELEMENT_NODE ? (container as Element) : container.parentElement;
  if (
    !root ||
    ![...root.querySelectorAll(READER_DECORATION)].some((node) => range.intersectsNode(node))
  )
    return range.toString();
  const fragment = range.cloneContents();
  for (const node of fragment.querySelectorAll(READER_DECORATION)) node.remove();
  return fragment.textContent ?? '';
}

interface Segment {
  node: Text;
  start: number;
  end: number;
}

/** Snapshot of one rendered body's normalized text, including cross-inline-node bookmarks. */
export class VisibleText {
  readonly text: string;
  private readonly offsets: number[] = [];
  private readonly segments: Segment[] = [];
  private readonly byNode = new WeakMap<Node, Segment>();

  constructor(readonly root: HTMLElement) {
    const walker = root.ownerDocument.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    const parts: string[] = [];
    let node: Node | null,
      length = 0;
    while ((node = walker.nextNode())) {
      const value = node.textContent ?? '';
      if (!value || readerDecoration(node)) continue;
      const segment = { node: node as Text, start: length, end: length + value.length };
      this.segments.push(segment);
      this.byNode.set(node, segment);
      parts.push(value);
      length += value.length;
    }
    const raw = parts.join(''),
      normalized: string[] = [];
    let space = false;
    for (let i = 0; i < raw.length; i++) {
      const whitespace = /\s/u.test(raw[i]);
      if (whitespace && space) continue;
      normalized.push(whitespace ? ' ' : raw[i]);
      this.offsets.push(i);
      space = whitespace;
    }
    this.text = normalized.join('');
  }

  private boundary(offset: number): { node: Text; offset: number } | undefined {
    let low = 0,
      high = this.segments.length;
    while (low < high) {
      const middle = (low + high) >>> 1;
      if (this.segments[middle].end <= offset) low = middle + 1;
      else high = middle;
    }
    const segment = this.segments[low];
    return segment ? { node: segment.node, offset: offset - segment.start } : undefined;
  }

  range(marker: string): Range | undefined {
    const wanted = marker.replace(/\s+/gu, ' ').trim();
    const at = this.text.indexOf(wanted);
    if (at < 0 || !wanted) return;
    const start = this.boundary(this.offsets[at]),
      last = this.boundary(this.offsets[at + wanted.length - 1]);
    if (!start || !last) return;
    const range = this.root.ownerDocument.createRange();
    range.setStart(start.node, start.offset);
    range.setEnd(last.node, last.offset + 1);
    return range;
  }

  marker(node: Node, offset: number): string {
    const segment = this.byNode.get(node);
    if (!segment || !Number.isInteger(offset) || offset < 0 || offset > segment.end - segment.start)
      return '';
    const raw = segment.start + offset;
    let low = 0,
      high = this.offsets.length;
    while (low < high) {
      const middle = (low + high) >>> 1;
      if (this.offsets[middle] < raw) low = middle + 1;
      else high = middle;
    }
    if (low === this.text.length) return '';
    if (low > 0 && this.text[low - 1] !== ' ' && this.text[low] !== ' ') {
      // Start at the next whole word, or the current whole word at the document's end.
      const next = this.text.indexOf(' ', low);
      low =
        next >= 0 && next + 1 < this.text.length
          ? next + 1
          : this.text.lastIndexOf(' ', low - 1) + 1;
    }
    if (this.text[low] === ' ') low++;
    let marker = '',
      cursor = low;
    for (let count = 0; count < 40 && cursor < this.text.length; count++) {
      const space = this.text.indexOf(' ', cursor),
        end = space < 0 ? this.text.length : space;
      if (end - low > 256) break;
      marker = this.text.slice(low, end);
      cursor = end + 1;
      if (count >= 4 && this.text.indexOf(marker) === this.text.lastIndexOf(marker)) break;
    }
    // Unbroken text (e.g. a long URL or CJK passage) still supplies a bounded anchor.
    return (
      marker ||
      this.text
        .slice(low, low + 256)
        .trim()
        .replace(/[\uD800-\uDBFF]$/u, '')
    );
  }
}
