import { parseInlineMarkdown } from '../inline/parser';
import { prepareArticleImages } from './image-cooldown';
import type { InlineParseOptions, ParsedInlineMarkdown } from '../inline/types';
/** Title removal is part of the source map, never a subsequent DOM-only edit. */
export function renderArticle(markdown: string, target: HTMLElement, options: InlineParseOptions = {}): ParsedInlineMarkdown {
  const parsed = parseInlineMarkdown(markdown, options);
  prepareArticleImages(parsed.root);
  for (const a of parsed.root.querySelectorAll('a')) {
    if (/^https?:\/\//i.test(a.getAttribute('href') ?? '')) { a.target = '_blank'; a.rel = 'noopener noreferrer'; }
  }
  target.replaceChildren(...parsed.root.childNodes);
  return parsed;
}
