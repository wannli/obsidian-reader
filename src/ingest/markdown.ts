import { createMarkdownContent } from 'defuddle/full';
import { boundText, MAX_ARTICLE_BYTES } from './bounds';

const entities = (text: string): string => text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const destination = (url: string): string => url.replace(/[\s<>"'`()[\]\\]/gu, char => encodeURIComponent(char).replace(/[!'()*]/g, c => '%' + c.charCodeAt(0).toString(16).toUpperCase()));
// GFM/Obsidian can autolink prose independently of source <a> elements. Do not let that
// recreate unvalidated credential URLs or mailto links; entities keep the displayed text.
const prose = (text: string): string => entities(text).replace(/\b([a-z][a-z\d+.-]*):\/\//gi, '$1&#58;//')
  .replace(/\b(www)\./gi, '$1&#46;').replace(/@/g, '&#64;');

/** Input must already pass safeContent. Never strip comments with a Markdown-wide regex: code is literal. */
export function articleMarkdown(body: HTMLElement, base: string): string {
  for (const pre of body.querySelectorAll('pre')) {
    if (!pre.querySelector('code')) {
      const code = body.ownerDocument.createElement('code');
      code.textContent = pre.textContent;
      pre.replaceChildren(code);
    }
  }
  // Entity-escape prose before conversion so encoded source text cannot turn back into active
  // Markdown HTML/comments/autolinks. Code nodes are intentionally untouched.
  const walker = body.ownerDocument.createTreeWalker(body, 4 /* SHOW_TEXT */);
  let node: Node | null;
  while ((node = walker.nextNode())) {
    if (!node.parentElement?.closest('pre,code')) node.textContent = prose(node.textContent ?? '');
  }
  for (const link of body.querySelectorAll('a[href]')) link.setAttribute('href', destination(link.getAttribute('href')!));
  for (const image of body.querySelectorAll('img[src]')) {
    image.setAttribute('src', destination(image.getAttribute('src')!));
    image.setAttribute('alt', entities(image.getAttribute('alt') ?? '').replace(/\s+/gu, ' ').replace(/[\\[\]`*_!]/g, '\\$&'));
  }
  const markdown = createMarkdownContent(body.innerHTML, base).trim();
  boundText(markdown, MAX_ARTICLE_BYTES, 'Extracted Markdown');
  return markdown;
}
