const blocks =
  'p,li,dt,dd,h1,h2,h3,h4,h5,h6,blockquote,figcaption,td,th,div,section,article,' +
  'address,aside,details,summary,footer,header,hr,main,nav,ol,ul,dl,table,thead,tbody,tfoot,tr,figure';
const excluded =
  'button,input,textarea,select,option,form,img,picture,svg,canvas,audio,video,iframe,object,embed,' +
  'pre,code,script,style,template,noscript,[hidden],[aria-hidden="true"],[contenteditable]:not([contenteditable="false"])';
const maximumNodes = 4096,
  maximumText = 100_000;
interface Span {
  start: number;
  end: number;
}
interface Segment extends Span {
  node: Text;
}
interface Index {
  block: HTMLElement;
  text: string;
  segments: Segment[];
  byNode: Map<Node, Segment>;
}
type CaretDocument = Document & {
  caretPositionFromPoint?: (x: number, y: number) => { offsetNode: Node; offset: number } | null;
  caretRangeFromPoint?: (x: number, y: number) => Range | null;
};
const inside = (rect: DOMRect, x: number, y: number): boolean =>
  rect.right > rect.left &&
  rect.bottom > rect.top &&
  x >= rect.left &&
  x < rect.right &&
  y >= rect.top &&
  y < rect.bottom;
const hit = (range: Range, x: number, y: number): boolean =>
  Array.from(range.getClientRects()).some((rect) => inside(rect, x, y));
const trim = (text: string, start: number, end: number): Span => ({
  start: start + (text.slice(start, end).match(/^\s*/u)?.[0].length ?? 0),
  end: end - (text.slice(start, end).match(/\s*$/u)?.[0].length ?? 0),
});

/** Read-only, block-local tap ranges. Never changes the DOM or the user's Selection. */
export class TapText {
  private readonly words?: Intl.Segmenter;
  private readonly sentences?: Intl.Segmenter;

  constructor(readonly root: HTMLElement) {
    if (typeof Intl.Segmenter === 'function') {
      const locale = root.closest('[lang]')?.getAttribute('lang') || undefined;
      try {
        this.words = new Intl.Segmenter(locale, { granularity: 'word' });
        this.sentences = new Intl.Segmenter(locale, { granularity: 'sentence' });
      } catch {
        this.words = new Intl.Segmenter(undefined, { granularity: 'word' });
        this.sentences = new Intl.Segmenter(undefined, { granularity: 'sentence' });
      }
    }
  }

  private block(node: Node): HTMLElement | undefined {
    if (!this.root.contains(node)) return;
    let element = node.nodeType === 1 ? (node as Element) : node.parentElement;
    let block: HTMLElement | undefined;
    while (element) {
      if (element.matches(excluded)) return;
      if (!block && (element === this.root || element.matches(blocks)))
        block = element as HTMLElement;
      if (element === this.root) return block;
      element = element.parentElement;
    }
  }

  private index(block: HTMLElement): Index | undefined {
    const segments: Segment[] = [],
      byNode = new Map<Node, Segment>(),
      parts: string[] = [];
    let node: Node | null = block.firstChild,
      length = 0,
      count = 0;
    // Skip nested blocks/protected subtrees, including their text. A barrier prevents
    // adjoining inline fragments on either side from becoming a fabricated word.
    while (node) {
      if (++count > maximumNodes) return;
      if (node.nodeType === 3) {
        const value = node.nodeValue ?? '';
        if (length + value.length > maximumText) return;
        if (value) {
          const segment = { node: node as Text, start: length, end: length + value.length };
          segments.push(segment);
          byNode.set(node, segment);
          parts.push(value);
          length += value.length;
        }
      } else if (node.nodeType === 1) {
        const element = node as Element;
        if (element.matches(excluded) || element.matches(blocks) || element.tagName === 'BR') {
          parts.push('\0');
          length++;
        } else if (node.firstChild) {
          node = node.firstChild;
          continue;
        }
      }
      while (node && node !== block && !node.nextSibling) node = node.parentNode;
      node = node && node !== block ? node.nextSibling : null;
    }
    return { block, text: parts.join(''), segments, byNode };
  }

  private offset(index: Index, node: Node, offset: number): number | undefined {
    const segment = index.byNode.get(node);
    if (segment && Number.isInteger(offset) && offset >= 0 && offset <= segment.end - segment.start)
      return segment.start + offset;
  }

  private range(index: Index, span: Span): Range | undefined {
    if (span.end <= span.start || index.text.slice(span.start, span.end).includes('\0')) return;
    const boundary = (at: number): Segment | undefined => {
      let low = 0,
        high = index.segments.length;
      while (low < high) {
        const middle = (low + high) >>> 1;
        if (index.segments[middle].end <= at) low = middle + 1;
        else high = middle;
      }
      const segment = index.segments[low];
      return segment && segment.start <= at ? segment : undefined;
    };
    const start = boundary(span.start),
      end = boundary(span.end - 1);
    if (!start || !end) return;
    const range = this.root.ownerDocument.createRange();
    range.setStart(start.node, span.start - start.start);
    range.setEnd(end.node, span.end - end.start);
    return range;
  }

  private wordSpans(text: string): Span[] {
    const result: Span[] = [];
    for (const token of text.matchAll(/[^\s\0]+/gu)) {
      const base = token.index!,
        value = token[0];
      const words = this.words
        ? Array.from(this.words.segment(value))
            .filter((part) => part.isWordLike || /\p{S}/u.test(part.segment))
            .map((part) => ({
              start: base + part.index,
              end: base + part.index + part.segment.length,
            }))
        : [{ start: base, end: base + value.length }];
      if (!words.length) continue;
      words[0].start = base;
      for (let i = 0; i < words.length; i++) {
        const next = words[i + 1],
          end = next?.start ?? base + value.length;
        // Closing punctuation belongs to the last word; an opening bracket belongs
        // to the following word, even in scripts that do not use spaces.
        const opening = next ? text.slice(words[i].end, end).match(/[\p{Ps}\p{Pi}]+$/u)?.[0] : '';
        words[i].end = end - (opening?.length ?? 0);
        if (next) next.start = words[i].end;
      }
      for (const word of words) result.push(word);
    }
    return result;
  }

  private wordRange(index: Index, at: number): Range | undefined {
    if (at < 0 || at > index.text.length || !index.text.length) return;
    const separator = (position: number) => /[\s\0]/u.test(index.text[position]);
    const position = at === index.text.length || separator(at) ? at - 1 : at;
    if (position < 0 || separator(position)) return;
    let start = position,
      end = position + 1;
    while (start > 0 && !separator(start - 1)) start--;
    while (end < index.text.length && !separator(end)) end++;
    // Only segment the touched whitespace token, not every word in a long block.
    const spans = this.wordSpans(index.text.slice(start, end)),
      local = at - start;
    const span =
      spans.find((span) => local >= span.start && local < span.end) ??
      spans.find((span) => local === span.end);
    return span && this.range(index, { start: start + span.start, end: start + span.end });
  }

  private wordHit(index: Index, word: Range, x: number, y: number): boolean {
    const start = this.offset(index, word.startContainer, word.startOffset)!,
      end = this.offset(index, word.endContainer, word.endOffset)!,
      probe = this.root.ownerDocument.createRange();
    // A cross-element Range also reports fully selected inline element boxes,
    // including their padding. Text-only subranges verify the glyphs instead.
    for (const segment of index.segments) {
      const from = Math.max(start, segment.start),
        to = Math.min(end, segment.end);
      if (to <= from) continue;
      probe.setStart(segment.node, from - segment.start);
      probe.setEnd(segment.node, to - segment.start);
      if (hit(probe, x, y)) return true;
    }
    return false;
  }

  /** Pure DOM counterpart of wordAt. Offsets use the DOM's UTF-16 text-node units. */
  word(node: Node, offset: number): Range | undefined {
    const block = this.block(node),
      index = block && this.index(block),
      at = index && this.offset(index, node, offset);
    return index && at !== undefined ? this.wordRange(index, at) : undefined;
  }

  wordAt(x: number, y: number): Range | undefined {
    if (
      !Number.isFinite(x) ||
      !Number.isFinite(y) ||
      !inside(this.root.getBoundingClientRect(), x, y)
    )
      return;
    const doc = this.root.ownerDocument as CaretDocument;
    const target =
      typeof doc.elementFromPoint === 'function' ? doc.elementFromPoint(x, y) : undefined;
    if (target === null || (target && !this.block(target))) return;
    const fromCaret = (node: Node, offset: number): Range | undefined => {
      const block = this.block(node),
        index = block && this.index(block),
        at = index && this.offset(index, node, offset);
      if (!index || at === undefined) return;
      // A caret is a boundary: the glyph can be on either side (also in bidi text).
      for (const position of [at, at - 1]) {
        const range = this.wordRange(index, position);
        if (range && this.wordHit(index, range, x, y)) return range;
      }
    };
    const position = doc.caretPositionFromPoint?.(x, y);
    if (position) {
      const range = fromCaret(position.offsetNode, position.offset);
      if (range) return range;
    }
    const caret = doc.caretRangeFromPoint?.(x, y);
    if (caret) {
      const range = fromCaret(caret.startContainer, caret.startOffset);
      if (range) return range;
    }
    // Older hosts can omit both caret APIs. Probe only the hit block's text-node
    // rects, then bisect a hit node, never the whole article or its bounding box.
    const block = target && this.block(target),
      index = block && this.index(block);
    if (!index) return;
    for (const segment of index.segments) {
      const probe = doc.createRange();
      const find = (start: number, end: number): number | undefined => {
        probe.setStart(segment.node, start);
        probe.setEnd(segment.node, end);
        if (!hit(probe, x, y)) return;
        if (end - start <= 1) return start;
        const middle = (start + end) >>> 1;
        return find(start, middle) ?? find(middle, end);
      };
      const offset = find(0, segment.end - segment.start);
      if (offset === undefined) continue;
      const range = this.wordRange(index, segment.start + offset);
      if (range && this.wordHit(index, range, x, y)) return range;
    }
  }

  private selected(word: Range): { index: Index; span: Span } | undefined {
    const block = this.block(word.startContainer);
    if (!block || this.block(word.endContainer) !== block) return;
    const index = this.index(block);
    if (!index) return;
    const start = this.offset(index, word.startContainer, word.startOffset),
      end = this.offset(index, word.endContainer, word.endOffset);
    if (start === undefined || end === undefined || end <= start) return;
    if (index.text.slice(start, end).includes('\0')) return;
    return { index, span: { start, end } };
  }

  sentence(word: Range): Range | undefined {
    const selected = this.selected(word);
    if (!selected) return;
    const { index, span } = selected;
    const start = index.text.lastIndexOf('\0', span.start - 1) + 1,
      barrier = index.text.indexOf('\0', span.end),
      end = barrier < 0 ? index.text.length : barrier,
      // Markdown soft line breaks render as spaces. Keep UTF-16 offsets intact
      // while preventing Intl from treating source newlines as sentence breaks.
      text = index.text.slice(start, end).replace(/\s/gu, ' ');
    const sentences = this.sentences
      ? Array.from(this.sentences.segment(text), (part) => ({
          start: start + part.index,
          end: start + part.index + part.segment.length,
        }))
      : Array.from(
          text.matchAll(/[^.!?。！？]+(?:[.!?。！？]+[\p{Pe}\p{Pf}"']*|$)\s*/gu),
          (part) => ({
            start: start + part.index!,
            end: start + part.index! + part[0].length,
          }),
        );
    const sentence = sentences.find((part) => part.start <= span.start && part.end >= span.end);
    return sentence && this.range(index, trim(index.text, sentence.start, sentence.end));
  }

  paragraph(word: Range): Range | undefined {
    const selected = this.selected(word);
    return (
      selected &&
      this.range(selected.index, trim(selected.index.text, 0, selected.index.text.length))
    );
  }

  /** Inclusive and order-independent, but deliberately restricted to one source block. */
  between(first: Range, last: Range): Range | undefined {
    const selected = this.selected(first);
    if (!selected || this.block(last.startContainer) !== selected.index.block) return;
    const { index, span } = selected;
    if (this.block(last.endContainer) !== index.block) return;
    const start = this.offset(index, last.startContainer, last.startOffset),
      end = this.offset(index, last.endContainer, last.endOffset);
    if (start === undefined || end === undefined || end <= start) return;
    return this.range(index, { start: Math.min(span.start, start), end: Math.max(span.end, end) });
  }
}
