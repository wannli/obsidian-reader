import type { FeedEntry } from '../types';
import { boundDom, boundText, MAX_FEED_BYTES, parseHtml } from './bounds';
import { articleMarkdown } from './markdown';
import { sanitizeBody } from './sanitize';
import { normalizeUrl, resolveWebUrl } from './url';

const XML = 'http://www.w3.org/XML/1998/namespace';
const XHTML = 'http://www.w3.org/1999/xhtml';
const CONTENT = 'http://purl.org/rss/1.0/modules/content/';
const DROP = new Set('script style iframe frame frameset object embed applet svg math form input button textarea select option template noscript canvas audio video source track link meta base'.split(' '));
const ATTRS = new Set(['href', 'src', 'alt', 'class', 'start', 'hidden', 'aria-hidden', 'style', 'data-src', 'data-original', 'data-lang', 'data-language']);
const URL_ATTRS = new Set(['href', 'src', 'data-src', 'data-original']);
const escaped = (value: string): string => value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

function fieldBase(node: Element, source: string): string {
  const chain: Element[] = [];
  for (let parent: Element | null = node; parent; parent = parent.parentElement) chain.unshift(parent);
  let base = normalizeUrl(source);
  for (const element of chain) {
    const declared = element.getAttributeNS(XML, 'base');
    if (declared) base = resolveWebUrl(declared, base);
  }
  return base;
}

/** Normalize prefixed XHTML to inert HTML nodes; retain literal text and strip active/foreign subtrees. */
function copyXml(node: Node, target: Node, base: string, fieldNamespace: string | null): void {
  const doc = target.ownerDocument!;
  if (node.nodeType === 3 || node.nodeType === 4) { target.appendChild(doc.createTextNode(node.textContent ?? '')); return; }
  if (node.nodeType !== 1) return; // Comments and processing instructions are not content.
  const source = node as Element, tag = source.localName.toLowerCase();
  if (DROP.has(tag) || (source.namespaceURI && source.namespaceURI !== XHTML && source.namespaceURI !== fieldNamespace)) return;
  const declared = source.getAttributeNS(XML, 'base');
  if (declared) base = resolveWebUrl(declared, base);
  const element = doc.createElement(tag);
  for (const attr of source.attributes) {
    if (!ATTRS.has(attr.name)) continue;
    if (URL_ATTRS.has(attr.name)) {
      try { element.setAttribute(attr.name, resolveWebUrl(attr.value, base)); } catch { /* Keep text, not an unsafe destination. */ }
    } else element.setAttribute(attr.name, attr.value);
  }
  for (const child of source.childNodes) copyXml(child, element, base, fieldNamespace);
  target.appendChild(element);
}

/** Convert exactly the supplied field, without the preview's truncation or any article extraction. */
function fieldMarkdown(node: Element, source: string, format: string): string | undefined {
  if (!['text', 'html', 'xhtml'].includes(format) || node.hasAttribute('src')) return undefined;
  const base = fieldBase(node, source);
  const raw = node.textContent ?? '';
  boundText(node.children.length ? node.innerHTML : raw, MAX_FEED_BYTES, 'Feed text');
  boundDom(node);
  let doc: Document;
  if (format === 'text') {
    doc = parseHtml('<p>' + escaped(raw).replace(/\r\n?/g, '\n').replace(/\n[ \t]*\n+/g, '</p><p>') + '</p>');
  } else if (node.children.length) {
    doc = parseHtml('');
    for (const child of node.childNodes) copyXml(child, doc.body, base, node.namespaceURI);
    boundDom(doc.body);
  } else if (format === 'xhtml') {
    return undefined; // XHTML text constructs must contain actual XML children.
  } else {
    doc = parseHtml(raw);
  }
  const body = sanitizeBody(doc, base);
  const markdown = articleMarkdown(body, base);
  return markdown || undefined;
}

/** Complete selected inline field, with field-based excerpt classification. Never fetches or runs Defuddle.parse. */
export function readFeedText(item: Element, source: string, atom: boolean): FeedEntry['feedText'] {
  const child = (name: string, ns = item.namespaceURI): Element | undefined =>
    [...item.children].find(node => node.localName === name && node.namespaceURI === ns);
  const fields = atom ? [child('content'), child('summary')] : [child('encoded', CONTENT), child('description')];
  for (let index = 0; index < fields.length; index++) {
    const node = fields[index];
    if (!node) continue;
    let format = atom ? (node.getAttribute('type') || 'text').trim().toLowerCase() : 'html';
    if (atom && index === 0) {
      if (format === 'text/plain') format = 'text';
      if (format === 'text/html') format = 'html';
      if (format === 'application/xhtml+xml') format = 'xhtml';
    }
    const markdown = fieldMarkdown(node, source, format);
    if (markdown) return { markdown, isExcerpt: index === 1 };
  }
  return undefined;
}
