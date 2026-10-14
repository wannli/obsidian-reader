import { webUrl } from '../core/model';
import { plainText, toMarkdown } from './html';
import { boundDom, boundMarkup } from './bounds';
import { UnsafePublisherContent } from './security';

export interface FeedItem {
  url: string;
  title: string;
  published?: string;
  html: string;
  excerpt: boolean;
}
export interface ParsedFeed {
  title: string;
  items: FeedItem[];
}
const child = (node: Element, name: string): Element | undefined =>
  [...node.children].find((item) => item.localName === name);
const value = (node: Element, name: string): string => child(node, name)?.textContent?.trim() ?? '';
function publication(value: string): string | undefined {
  const time = Date.parse(value);
  return Number.isFinite(time) ? new Date(time).toISOString() : undefined;
}
export function parseFeed(xml: string, source: string): ParsedFeed {
  boundMarkup(xml);
  if (/<!DOCTYPE|<!ENTITY/i.test(xml))
    throw new Error('Feeds containing DTDs or entities are not supported.');
  const doc = new DOMParser().parseFromString(xml, 'application/xml');
  boundDom(doc);
  if (doc.querySelector('parsererror')) throw new Error('Invalid XML feed.');
  const root = doc.documentElement;
  const atom = root.localName === 'feed';
  const channel = atom ? root : child(root, 'channel');
  if (!channel || (!atom && root.localName !== 'rss')) throw new Error('Expected RSS or Atom.');
  const items: FeedItem[] = [],
    seen = new Set<string>();
  for (const entry of [...channel.children]
    .filter((node) => node.localName === (atom ? 'entry' : 'item'))
    .slice(0, 500)) {
    try {
      const link = atom
        ? [...entry.children]
            .find(
              (node) =>
                node.localName === 'link' &&
                ['alternate', ''].includes(node.getAttribute('rel') ?? ''),
            )
            ?.getAttribute('href')
        : value(entry, 'link');
      if (!link) continue;
      const url = webUrl(link, source);
      if (seen.has(url)) continue;
      const full = atom ? child(entry, 'content') : child(entry, 'encoded');
      const summary = child(entry, atom ? 'summary' : 'description');
      const content = full ?? summary;
      let html = content?.textContent ?? '';
      if (atom && content?.getAttribute('type') === 'xhtml') html = content.innerHTML;
      if (atom && content && !['html', 'xhtml'].includes(content.getAttribute('type') ?? 'text')) {
        const p = document.createElement('p');
        p.textContent = html;
        html = p.outerHTML;
      }
      items.push({
        url,
        title: plainText(value(entry, 'title')) || new URL(url).hostname,
        published: publication(
          value(entry, atom ? 'published' : 'pubDate') || value(entry, 'updated'),
        ),
        html,
        excerpt: !full,
      });
      seen.add(url);
    } catch (error) {
      if (error instanceof UnsafePublisherContent) throw error;
      /* Malformed entries do not prevent reading the rest of the subscription. */
    }
  }
  return { title: plainText(value(channel, 'title')) || new URL(source).hostname, items };
}
export async function feedMarkdown(item: FeedItem): Promise<string> {
  const markdown = item.html ? await toMarkdown(item.html, item.url) : '';
  return markdown ? `\n${markdown}\n` : '';
}
