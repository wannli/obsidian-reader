// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { parseFeed, feedMarkdown } from '../src/content/feed';
import { fragment, toMarkdown } from '../src/content/html';
import { bounded } from '../src/content/bounds';
import { extract } from '../src/content/extract';
import { importedMarkdown, hasAnnotations } from '../src/core/annotations';
import { marked } from 'marked';

const source = 'https://example.com/feed.xml';
const rss = `<rss version="2.0" xmlns:content="http://purl.org/rss/1.0/modules/content/"><channel><title>Example &amp; research</title>
<item><title>First article</title><link>/one#section</link><pubDate>Mon, 12 Oct 2026 10:00:00 GMT</pubDate><description><![CDATA[<p>A brief <b>summary</b>.</p>]]></description></item>
<item><title>Duplicate</title><link>https://example.com/one</link></item>
<item><title>Complete</title><link>/two</link><content:encoded><![CDATA[<p>Full article text.</p>]]></content:encoded></item>
<item><title>Unsafe</title><link>javascript:alert(1)</link></item></channel></rss>`;

describe('feed ingestion without network', () => {
  it('parses RSS, resolves URLs, preserves occurrences, and distinguishes excerpts', async () => {
    const feed = parseFeed(rss, source);
    expect(feed.title).toBe('Example & research');
    expect(feed.items).toHaveLength(3);
    expect(feed.items[0]).toMatchObject({
      url: 'https://example.com/one',
      excerpt: true,
      published: '2026-10-12T10:00:00.000Z',
    });
    expect(feed.items[1]).toMatchObject({ url: feed.items[0].url, title: 'Duplicate' });
    expect(feed.items[2].excerpt).toBe(false);
    expect(await feedMarkdown(feed.items[0])).toBe('\nA brief **summary**.\n');
  });
  it('parses Atom and preserves unknown publication dates', () => {
    const feed = parseFeed(
      '<feed xmlns="http://www.w3.org/2005/Atom"><title>Atom</title><entry><title>One</title><link href="/one"/><summary type="text">Less &lt; more</summary></entry></feed>',
      source,
    );
    expect(feed.items[0].published).toBeUndefined();
    expect(feed.items[0].html).toBe('<p>Less &lt; more</p>');
  });
  it.each([
    '<html/>',
    '<rss><channel>',
    '<!DOCTYPE rss><rss><channel/></rss>',
    '<!ENTITY dangerous "value"><rss/>',
  ])('rejects unsupported or unsafe XML', (xml) => {
    expect(() => parseFeed(xml, source)).toThrow();
  });
  it('limits the number of entries processed in a single response', () => {
    const entries = Array.from(
      { length: 510 },
      (_, i) => `<item><link>/article-${i}</link></item>`,
    ).join('');
    expect(parseFeed(`<rss><channel>${entries}</channel></rss>`, source).items).toHaveLength(500);
  });
});

describe('safe offline content preparation', () => {
  it('removes executable content and unsafe destinations', () => {
    const safe = fragment(
      '<script>alert(1)</script><iframe src="https://example.com"></iframe><p onclick="alert(1)">Text</p><a href="javascript:alert(1)">Unsafe</a>',
      source,
    );
    expect(safe.querySelector('script,iframe,[onclick]')).toBeNull();
    expect(safe.querySelector('a')?.hasAttribute('href')).toBe(false);
    expect(safe.textContent).toBe('TextUnsafe');
  });
  it('does not attach image source URLs to the reading fragment', () => {
    const image = fragment(
      '<img src="/image.png" srcset="/big.png 2x" onerror="alert(1)">',
      source,
    ).querySelector('img')!;
    expect(image.hasAttribute('src')).toBe(false);
    expect(image.hasAttribute('srcset')).toBe(false);
    expect(image.dataset.readerSrc).toBe('https://example.com/image.png');
  });
  it('keeps image URLs through sanitized conversion, without requiring a download', async () => {
    const first = fragment('<p>Words</p><img src="/image.png" alt="A picture">', source);
    const template = document.createElement('template');
    template.content.append(first);
    const md = await toMarkdown(template.innerHTML, source);
    expect(md).toContain('![A picture](https://example.com/image.png)');
  });
  it('preserves formatting, section links and safe images with repeatable excerpt bytes', async () => {
    const html =
      '<h2>Heading</h2><p><em>Emphasis</em> and <strong>bold</strong>.</p><blockquote><p>Quote</p></blockquote>' +
      '<ol start="3"><li>Three</li><li>Four<ul><li>Nested</li></ul></li></ol>' +
      '<p><a href="/guide_(one)#part">Guide</a> <img src="/picture(1).png" alt="[A picture]"></p>';
    const item = { url: source, title: 'Article', html, excerpt: true };
    const markdown = await feedMarkdown(item);
    expect(await feedMarkdown({ ...item })).toBe(markdown);
    const doc = new DOMParser().parseFromString(
      marked.parse(markdown, { async: false }),
      'text/html',
    );
    expect(doc.querySelector('h2')?.textContent).toBe('Heading');
    expect(doc.querySelector('em')?.textContent).toBe('Emphasis');
    expect(doc.querySelector('strong')?.textContent).toBe('bold');
    expect(doc.querySelector('blockquote')?.textContent?.trim()).toBe('Quote');
    expect(doc.querySelector('ol')?.getAttribute('start')).toBe('3');
    expect(doc.querySelectorAll('li')).toHaveLength(3);
    expect(doc.querySelector('a')?.getAttribute('href')).toBe(
      'https://example.com/guide_%28one%29#part',
    );
    expect(doc.querySelector('img')?.getAttribute('alt')).toBe('[A picture]');
    expect(doc.querySelector('img')?.getAttribute('src')).toBe(
      'https://example.com/picture%281%29.png',
    );
    const image = fragment(doc.body.innerHTML, source).querySelector('img')!;
    expect(image.hasAttribute('src')).toBe(false);
    expect(image.dataset.readerSrc).toBe('https://example.com/picture%281%29.png');
    expect(image.loading).toBe('lazy');
    expect(image.referrerPolicy).toBe('no-referrer');
  });
  it('does not treat publisher prose as authored highlights or vault links', () => {
    const md = importedMarkdown('A ==literal example== and [[literal brackets]].\n\n`==code==`\n');
    expect(md).toContain('\\=\\=literal example\\=\\=');
    expect(md).toContain('\\[\\[literal brackets]]');
    expect(md).toContain('`==code==`');
    expect(hasAnnotations(md, { topics: [] })).toBe(false);
  });
  it('bounds payloads before parsing', () =>
    expect(() => bounded('x'.repeat(21), 20)).toThrow(/large/));
  it('fails visibly on non-HTML and HTTP failures, without attempting a bypass', async () => {
    await expect(
      extract(source, async () => ({ status: 403, headers: {}, text: '' })),
    ).rejects.toThrow('HTTP 403');
    await expect(
      extract(source, async () => ({
        status: 200,
        headers: { 'content-type': 'application/pdf' },
        text: '',
      })),
    ).rejects.toThrow(/HTML/);
  });
});
