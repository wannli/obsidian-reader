import type { ArticleClipping } from '../core/clipping-store';
import { VisibleText, readerDecoration } from './text';

export function clippingOverlaps(
  item: ArticleClipping,
  items: readonly ArticleClipping[],
): boolean {
  return (
    !!item.location &&
    items.some(
      (other) =>
        other !== item &&
        other.location &&
        item.location!.from < other.location.to &&
        other.location.from < item.location!.to,
    )
  );
}

/** Render-only marks. They never enter article Markdown or the source projection. */
export function clippingMarks(root: HTMLElement, items: readonly ArticleClipping[]): void {
  for (const mark of [
    ...root.querySelectorAll<HTMLElement>('mark[data-reader-clipping]'),
  ].reverse())
    mark.replaceWith(...mark.childNodes);
  root.normalize();
  for (const item of items) {
    if (!item.location || clippingOverlaps(item, items)) continue;
    const block = [...root.querySelectorAll<HTMLElement>('[data-reader-paragraph]')].find(
      (node) => node.dataset.readerParagraph === item.location!.blockId,
    );
    if (!block) continue;
    const range = new VisibleText(block).range(item.quote);
    if (!range) continue;
    const walker = root.ownerDocument.createTreeWalker(block, NodeFilter.SHOW_TEXT),
      segments: { node: Text; from: number; to: number }[] = [];
    let node: Node | null;
    while ((node = walker.nextNode())) {
      // Never steal publisher/typed links or existing hosted-highlight controls.
      if (
        readerDecoration(node) ||
        node.parentElement?.closest('a,mark:not([data-reader-clipping])') ||
        !range.intersectsNode(node)
      )
        continue;
      const from = node === range.startContainer ? range.startOffset : 0;
      const to = node === range.endContainer ? range.endOffset : (node.textContent?.length ?? 0);
      if (to > from) segments.push({ node: node as Text, from, to });
    }
    for (const { node, from, to } of segments.reverse()) {
      const selected = node.splitText(from);
      selected.splitText(to - from);
      const mark = root.ownerDocument.createElement('mark');
      mark.dataset.readerClipping = item.path;
      mark.title = 'Open clipping';
      mark.tabIndex = 0;
      mark.setAttribute('role', 'link');
      selected.replaceWith(mark);
      mark.append(selected);
    }
  }
}
