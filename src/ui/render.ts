import { parseInlineMarkdown } from '../inline/parser';
import type { InlineParseOptions, ParsedInlineMarkdown } from '../inline/types';
/** Title removal is part of the source map, never a subsequent DOM-only edit. */
export function renderArticle(markdown: string, target: HTMLElement, options: InlineParseOptions = {}): ParsedInlineMarkdown {
  const parsed = parseInlineMarkdown(markdown, options);
  target.replaceChildren(...parsed.root.childNodes);
  for (const a of target.querySelectorAll('a')) {
    if (/^https?:\/\//i.test(a.getAttribute('href') ?? '')) { a.target = '_blank'; a.rel = 'noopener noreferrer'; }
  }
  for (const img of target.querySelectorAll('img')) {
    const src = img.getAttribute('src') ?? '';
    if (!/^https?:\/\//i.test(src)) { img.remove(); continue; }
    img.loading = 'lazy'; img.referrerPolicy = 'no-referrer';
  }
  return parsed;
}
