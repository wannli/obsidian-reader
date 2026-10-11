import { safeContent } from './sanitize';

export const MAX_SUMMARY_LENGTH = 2000;
const MAX_SUMMARY_INPUT = 16_384;
const BLOCKS = 'address article blockquote br dd div dl dt figcaption figure h1 h2 h3 h4 h5 h6 hr li main ol p pre section table tbody td th thead tr ul'.split(' ');
const DROP = new Set('script style iframe frame frameset object embed applet svg math form input button textarea select option template noscript canvas audio video source track link meta base title nav footer aside'.split(' '));

/** Handle actual XML/XHTML children by local name, including prefixed XHTML script elements. */
function cleanXml(node: Element): Element {
  const clone = node.cloneNode(true) as Element;
  for (const child of [...clone.getElementsByTagName('*')]) {
    if (!clone.contains(child)) continue;
    const name = child.localName.toLowerCase();
    if (DROP.has(name) || child.hasAttribute('hidden') || child.getAttribute('aria-hidden') === 'true' ||
      /(?:display\s*:\s*none|visibility\s*:\s*hidden)/i.test(child.getAttribute('style') ?? '')) {
      child.remove(); continue;
    }
    if (BLOCKS.includes(name)) { child.before(' '); child.after(' '); }
  }
  return clone;
}

/** Plain display text, not HTML or Markdown. Callers must use textContent, never HTML interpolation. */
export function feedSummary(node: Element | undefined, base: string, format = 'html'): string | undefined {
  if (!node || !['text', 'html', 'xhtml'].includes(format)) return undefined;
  const clean = cleanXml(node);
  const raw = format === 'html' && clean.children.length ? clean.innerHTML : clean.textContent ?? '';
  const clipped = raw.length > MAX_SUMMARY_INPUT;
  let value = raw.slice(0, MAX_SUMMARY_INPUT);
  if (format === 'html') {
    try {
      const body = safeContent(value, base);
      for (const block of body.querySelectorAll(BLOCKS.join(','))) { block.before(' '); block.after(' '); }
      value = body.textContent ?? '';
    } catch { return undefined; } // An unusable optional summary must not hide a usable feed entry.
  }
  value = value.replace(/[\u0000-\u001f\u007f]/gu, ' ').replace(/\s+/gu, ' ').trim();
  if (!value) return undefined;
  if (clipped || value.length > MAX_SUMMARY_LENGTH) {
    // Do not leave a split UTF-16 surrogate pair at the truncation boundary.
    value = value.slice(0, MAX_SUMMARY_LENGTH - 1).replace(/[\uD800-\uDBFF]$/u, '').trimEnd() + '…';
  }
  return value;
}
