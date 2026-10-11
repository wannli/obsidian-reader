import { describe, expect, it } from 'vitest';
import { parseFeed } from '../src/ingest/feed';

const source = 'https://news.example/feeds/rss.xml';
const rss = (items: string, title = 'News &amp; more') => `<rss version="2.0"><channel><title>${title}</title>${items}</channel></rss>`;
const item = (guid: string, link: string, title = 'Story') => `<item><guid isPermaLink="false">${guid}</guid><link>${link}</link><title>${title}</title></item>`;

describe('RSS and Atom metadata and supplied text', () => {
  it('normalizes RSS metadata, includes safe supplied text, and omits invalid dates', () => {
    const result = parseFeed(rss(`<item><guid>story:1</guid><link>../stories/one#section</link>
      <title><![CDATA[<b>Hello</b> &amp; <script>bad()</script>world]]></title>
      <pubDate>Tue, 06 Oct 2026 10:00:00 GMT</pubDate><description>A short metadata summary</description>
      <content:encoded xmlns:content="http://purl.org/rss/1.0/modules/content/"><![CDATA[<iframe src="https://evil.example"></iframe>]]></content:encoded></item>
      <item><link>https://news.example/two</link><pubDate>2026-02-30</pubDate></item>`), source);
    expect(result.title).toBe('News & more');
    expect(result.entries).toEqual([
      { id: 'story:1', title: 'Hello & world', url: 'https://news.example/stories/one', published: '2026-10-06T10:00:00.000Z', summary: 'A short metadata summary', feedText: { markdown: 'A short metadata summary', isExcerpt: true } },
      { id: 'https://news.example/two', title: 'news.example', url: 'https://news.example/two' },
    ]);
    expect(JSON.stringify(result)).not.toMatch(/iframe|bad\(\)|description|content:encoded/);
    expect(result.entries[0]).not.toHaveProperty('body');
  });
  it('deduplicates both opaque GUIDs and normalized URLs, including skipped duplicate aliases', () => {
    const result = parseFeed(rss(item('a', '/one#first') + item('a', '/two') + item('b', '/two#second') +
      item('c', 'https://NEWS.example:443/one') + item('d', '/four')), source);
    expect(result.entries.map(entry => entry.url)).toEqual(['https://news.example/one', 'https://news.example/four']);
  });
  it('accepts URL GUID fallbacks, but not explicitly opaque GUIDs without a link', () => {
    const result = parseFeed(rss('<item><guid>https://news.example/permalink#top</guid></item><item><guid isPermaLink="false">opaque</guid></item><item><guid>not-a-url</guid></item>'), source);
    expect(result.entries).toHaveLength(1);
    expect(result.entries[0].url).toBe('https://news.example/permalink');
  });
  it('supports prefixed Atom, bases, links and XHTML without treating updated as publication', () => {
    const xml = `<a:feed xmlns:a="http://www.w3.org/2005/Atom" xml:base="https://site.example/root/">
      <a:title type="html">Atom &amp; things</a:title><a:entry xml:base="posts/">
        <a:id>tag:site.example,2026:one</a:id><a:title type="xhtml"><div xmlns="http://www.w3.org/1999/xhtml">An <b>Atom</b> story</div></a:title>
        <a:link rel="self" href="/api/1"/><a:link rel="enclosure" href="/audio.mp3"/>
        <a:link rel="alternate" type="text/html" xml:base="../articles/" href="one#read"/>
        <a:published>invalid</a:published><a:updated>2026-10-07T14:15:00+02:00</a:updated>
        <a:content type="html">Supplied Atom body.</a:content></a:entry>
      <a:entry><a:id>two</a:id><a:link href="/safe"/><a:title> </a:title></a:entry></a:feed>`;
    const result = parseFeed(xml, source);
    expect(result.entries).toEqual([
      { id: 'tag:site.example,2026:one', title: 'An Atom story', url: 'https://site.example/root/articles/one', feedText: { markdown: 'Supplied Atom body.', isExcerpt: false } },
      { id: 'two', title: 'site.example', url: 'https://site.example/safe' },
    ]);
    expect(result.title).toBe('Atom & things');
  });
  it('deduplicates Atom IDs and URLs independently and ignores foreign namespace fields', () => {
    const xml = `<feed xmlns="http://www.w3.org/2005/Atom" xmlns:x="urn:evil"><title>Atom</title>
      <entry><id>1</id><x:link href="https://evil.example"/><link href="/one"/><title>First</title></entry>
      <entry><id>1</id><link href="/two"/></entry><entry><id>2</id><link href="/two"/></entry>
      <entry><id>3</id><link href="/one#x"/></entry></feed>`;
    expect(parseFeed(xml, source).entries).toEqual([{ id: '1', url: 'https://news.example/one', title: 'First' }]);
  });
  it('handles RSS 1.0 RDF and Dublin Core dates', () => {
    const xml = `<rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#" xmlns="http://purl.org/rss/1.0/" xmlns:dc="http://purl.org/dc/elements/1.1/">
      <channel rdf:about="${source}"><title>RDF feed</title></channel><item><title>RDF story</title>
      <link>https://news.example/rdf</link><dc:date>2026-10-08</dc:date></item></rdf:RDF>`;
    expect(parseFeed(xml, source).entries[0].published).toBe('2026-10-08T00:00:00.000Z');
  });
  it('skips malicious entries without hiding later valid alternates or valid entries', () => {
    const result = parseFeed(rss(item('bad', 'javascript:alert(1)') + item('creds', 'https://user:pass@news.example/a') + item('good', '/good')), source);
    expect(result.entries.map(entry => entry.id)).toEqual(['good']);
    expect(parseFeed('<feed xmlns="http://www.w3.org/2005/Atom"><entry><link href="data:text/html,x"/><link href="/safe"/></entry></feed>', source).entries[0].url).toBe('https://news.example/safe');
  });
  it.each([
    '<!DOCTYPE rss [<!ENTITY x SYSTEM "file:///etc/passwd">]><rss><channel><title>&x;</title></channel></rss>',
    '<!DOCTYPE rss [<!ENTITY x "xxxxxxxx"><!ENTITY y "&x;&x;&x;">]><rss><channel/></rss>',
    '<rss><channel><title>Broken</channel></rss>', '<html><body>not a feed</body></html>', '<rss/>', '',
    '<feed xmlns="urn:not-atom"/>', rss(item('x', 'javascript:alert(1)')),
    '<feed xmlns="http://www.w3.org/2005/Atom" xml:base="file:///tmp/"><entry><link href="/bad"/></entry></feed>',
  ])('rejects malformed, hostile, or unusable sources', xml => { expect(() => parseFeed(xml, source)).toThrow(); });
  it.each(['2026-02-30', 'Mon, 30 Feb 2026 00:00:00 GMT', '2026', '42', 'garbage', '2026-15-01'])('omits invalid calendar dates rather than inventing a timestamp', value => {
    const xml = rss(`<item><link>https://news.example/story</link><pubDate>${value}</pubDate></item>`);
    expect(parseFeed(xml, source).entries[0].published).toBeUndefined();
  });
  it('accepts a legitimate empty feed and rejects unsafe source URLs', () => {
    expect(parseFeed(rss(''), source).entries).toEqual([]);
    expect(() => parseFeed(rss(''), 'https://user:pass@news.example/feed')).toThrow();
  });
});
