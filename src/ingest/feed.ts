import type { FeedEntry, ParsedFeed } from '../types';
import { boundDom, boundMarkup, boundText, MAX_FEED_BYTES, MAX_FEED_ENTRIES } from './bounds';
import { plainTitle } from './sanitize';
import { feedSummary } from './summary';
import { readFeedText } from './feed-text';
import { normalizeUrl, resolveWebUrl } from './url';

const ATOM = 'http://www.w3.org/2005/Atom';
const RDF = 'http://www.w3.org/1999/02/22-rdf-syntax-ns#';
const RSS1 = 'http://purl.org/rss/1.0/';
const DC = 'http://purl.org/dc/elements/1.1/';
const CONTENT = 'http://purl.org/rss/1.0/modules/content/';
const XML = 'http://www.w3.org/XML/1998/namespace';
const children = (node: Element, name: string, ns = node.namespaceURI): Element[] =>
  [...node.children].filter(child => child.localName === name && child.namespaceURI === ns);
const first = (node: Element, name: string): Element | undefined => children(node, name)[0];
const text = (node?: Element): string => node?.textContent?.trim() ?? '';

function baseOf(node: Element, source: string): string {
  const chain: Element[] = [];
  for (let parent: Element | null = node; parent; parent = parent.parentElement) chain.unshift(parent);
  let base = source;
  for (const parent of chain) {
    const value = parent.getAttributeNS(XML, 'base');
    if (value) base = resolveWebUrl(value, base);
  }
  return base;
}

function entryUrl(item: Element, source: string, atom: boolean): string | undefined {
  const links = children(item, 'link').filter(link => !atom ||
    ((!link.getAttribute('rel') || link.getAttribute('rel') === 'alternate') &&
      (!link.getAttribute('type') || /^(text\/html|application\/xhtml\+xml)$/i.test(link.getAttribute('type')!))));
  for (const link of links) {
    try { return normalizeUrl(resolveWebUrl(atom ? link.getAttribute('href') ?? '' : text(link), baseOf(link, source))); }
    catch { /* An invalid alternate must not hide a later usable link. */ }
  }
  if (!atom) {
    const guid = first(item, 'guid');
    if (guid && guid.getAttribute('isPermaLink')?.toLowerCase() !== 'false' && /^https?:\/\//i.test(text(guid))) {
      try { return normalizeUrl(text(guid)); } catch { /* A permalink GUID must itself be an absolute URL. */ }
    }
  }
  return undefined;
}

function date(value: string): string | undefined {
  if (value.length > 128) return undefined;
  const iso = value.match(/^(\d{4})-(\d{2})-(\d{2})(?:T|\s|$)/);
  const rfc = value.match(/\b(\d{1,2})[ -](Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[ -](\d{4})\b/i);
  if (!iso && !rfc) return undefined;
  if (rfc) {
    const month = 'jan feb mar apr may jun jul aug sep oct nov dec'.split(' ').indexOf(rfc[2].toLowerCase());
    if (+rfc[1] < 1 || +rfc[1] > new Date(Date.UTC(+rfc[3], month + 1, 0)).getUTCDate()) return undefined;
  }
  if (iso) {
    const [, y, m, d] = iso;
    const check = new Date(`${y}-${m}-${d}T00:00:00Z`);
    if (!Number.isFinite(check.getTime()) || check.toISOString().slice(0, 10) !== `${y}-${m}-${d}`) return undefined;
  }
  const time = Date.parse(value);
  return Number.isFinite(time) ? new Date(time).toISOString() : undefined;
}

/** Bounded RSS 2/1 and Atom metadata plus supplied Markdown; summaries remain explicitly excerpts. */
export function parseFeed(xml: string, url: string): ParsedFeed {
  const source = normalizeUrl(url);
  boundText(xml, MAX_FEED_BYTES, 'Feed');
  if (/<!\s*(?:DOCTYPE|ENTITY)\b/i.test(xml)) throw new Error('Feed DTDs and entity declarations are not allowed.');
  boundMarkup(xml);
  const doc = new DOMParser().parseFromString(xml, 'application/xml');
  if (doc.getElementsByTagNameNS('*', 'parsererror').length) throw new Error('Malformed feed XML.');
  boundDom(doc);
  const root = doc.documentElement;
  const atom = root.localName === 'feed' && (!root.namespaceURI || root.namespaceURI === ATOM);
  const rss = root.localName === 'rss' && !root.namespaceURI;
  const rdf = root.localName === 'RDF' && root.namespaceURI === RDF;
  if (!atom && !rss && !rdf) throw new Error('Source is not an RSS or Atom feed.');
  const channel = atom ? root : children(root, 'channel', rdf ? RSS1 : null)[0];
  if (!channel) throw new Error('RSS feed has no channel.');
  // Validate root/channel bases even for an empty feed; invalid source configuration is visible.
  baseOf(channel, source);
  const items = atom ? children(root, 'entry') : children(rdf ? root : channel, 'item', rdf ? RSS1 : null);
  if (items.length > MAX_FEED_ENTRIES) throw new Error('Feed exceeds the entry limit.');
  const entries: FeedEntry[] = [];
  const ids = new Set<string>(); const urls = new Set<string>();
  for (const item of items) {
    const link = entryUrl(item, source, atom);
    if (!link) continue;
    const identity = text(first(item, atom ? 'id' : 'guid'));
    const id = identity && identity.length <= 4096 ? identity : link;
    const duplicate = ids.has(id) || urls.has(link);
    // Record both aliases even for duplicates, preventing a later duplicate URL reappearing.
    ids.add(id); urls.add(link);
    if (duplicate) continue;
    const dates = atom ? [first(item, 'published')] :
      [first(item, 'pubDate'), children(item, 'date', DC)[0]];
    const published = dates.map(node => date(text(node))).find(Boolean);
    const title = plainTitle(text(first(item, 'title')), new URL(link).hostname);
    const atomSummary = first(item, 'summary');
    const summary = atom ? feedSummary(atomSummary, link, (atomSummary?.getAttribute('type') || 'text').trim().toLowerCase()) :
      feedSummary(first(item, 'description'), link) ?? feedSummary(children(item, 'encoded', CONTENT)[0], link);
    const feedText = readFeedText(item, source, atom);
    entries.push({ id, title, url: link, ...(published ? { published } : {}), ...(summary ? { summary } : {}),
      ...(feedText ? { feedText } : {}) });
  }
  if (items.length && !entries.length) throw new Error('Feed has no entries with usable HTTP(S) URLs.');
  return { title: plainTitle(text(first(channel, 'title')), new URL(source).hostname), entries };
}
