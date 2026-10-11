import type { Article } from '../types';
import { resolveAnchor } from '../highlights/index';
/** Scroll to a native saved-highlight block without altering text or selection. */
export function focusReaderTarget(pane: HTMLElement, article: Article, subpath: string, focus: boolean, reveal?: (range: Range) => boolean): boolean {
  const body = pane.querySelector<HTMLElement>('.r2-article-body'), scroll = pane.querySelector<HTMLElement>('.r2-reader-scroll');
  if (!body || !scroll) return false;
  let target = subpath; try { target = decodeURIComponent(target); } catch { /* Keep raw native subpath. */ }
  const item = article.highlights.find(item => target === '#^' + item.id || target === '^' + item.id);
  if (!item?.anchor) return false;
  const result = resolveAnchor(body, { articleVersion: item.anchor.version ?? 'unknown', normalisationVersion: 1,
    quote: { exact: item.quote, prefix: item.anchor.prefix, suffix: item.anchor.suffix }, position: { start: item.anchor.start, end: item.anchor.end } }, body.dataset.articleVersion ?? 'unknown');
  if (result.state !== 'resolved') return false;
  if (!reveal?.(result.range)) {
    const rect = result.range.getBoundingClientRect(), bounds = scroll.getBoundingClientRect();
    scroll.scrollTop += rect.top - bounds.top - bounds.height / 3;
  }
  if (focus) { body.tabIndex = -1; body.focus({ preventScroll: true }); }
  return true;
}
