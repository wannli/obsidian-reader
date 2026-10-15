import { webUrl } from '../core/model';
import { fragment, plainText, toMarkdown } from './html';
import { parseHtml } from './bounds';
import { restoreStreamedContent } from './stream';

export interface Response {
  text: string;
  status: number;
  headers: Record<string, string>;
}
type Get = (url: string, accept: string) => Promise<Response>;
export async function extract(url: string, get: Get): Promise<{ title: string; markdown: string }> {
  url = webUrl(url);
  const response = await get(url, 'text/html, application/xhtml+xml');
  if (response.status < 200 || response.status >= 300)
    throw new Error(`Article returned HTTP ${response.status}.`);
  const type = Object.entries(response.headers)
    .find(([key]) => key.toLowerCase() === 'content-type')?.[1]
    .split(';')[0]
    .trim();
  if (!['text/html', 'application/xhtml+xml'].includes(type ?? ''))
    throw new Error('The URL did not return an HTML article.');
  const template = parseHtml(response.text);
  const title =
    plainText(template.content.querySelector('title')?.textContent ?? '') || new URL(url).hostname;
  restoreStreamedContent(template.content);
  const safe = fragment(template.innerHTML, url);
  const doc = document.implementation.createHTMLDocument(title);
  doc.body.append(safe);
  const { default: Defuddle } = await import('defuddle/full');
  const result = new Defuddle(doc, {
    url,
    useAsync: false,
    markdown: false,
    removeSmallImages: false,
    fetch: async () => {
      throw new Error('Extractor background requests are disabled.');
    },
  }).parse();
  const extracted = fragment(result.content, url);
  const readable = extracted.textContent?.replace(/\s+/g, ' ').trim() ?? '';
  const normalized = (value: string): string =>
    value
      .toLowerCase()
      .replace(/[^\p{L}\p{N}]+/gu, ' ')
      .trim();
  const text = normalized(readable);
  const titleOnly = [title, result.title].some((candidate) => {
    const heading = normalized(candidate || '');
    return heading && text && text.split(heading).every((part) => !part.trim());
  });
  if (titleOnly)
    throw new Error('Only the page title was found, not the article. Please retry extraction.');
  if (readable.length < 40 || (readable.match(/\p{L}/gu)?.length ?? 0) < 20)
    throw new Error('No readable article found. The page may be blocked or require JavaScript.');
  if (
    /captcha|verify (?:that )?you are human|access denied|subscribe to (?:continue|read)/i.test(
      readable.slice(0, 1000),
    )
  ) {
    throw new Error('The page appears restricted. Reader does not bypass access controls.');
  }
  const container = document.createElement('template');
  container.content.append(extracted);
  const markdown = await toMarkdown(container.innerHTML, url);
  if (!markdown) throw new Error('No readable article found.');
  return { title: plainText(result.title || title), markdown };
}
