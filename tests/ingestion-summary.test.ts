import { afterEach, describe, expect, it, vi } from 'vitest';
import { parseFeed } from '../src/ingest/feed';
import { MAX_SUMMARY_LENGTH } from '../src/ingest/summary';

const source = 'https://news.example/feed.xml';
const rss = (fields: string) => `<rss xmlns:content="http://purl.org/rss/1.0/modules/content/"><channel><title>Feed</title><item><guid>one</guid><link>/article</link>${fields}</item></channel></rss>`;
const atom = (fields: string) => `<feed xmlns="http://www.w3.org/2005/Atom"><title>Feed</title><entry><id>one</id><link href="/article"/>${fields}</entry></feed>`;
const summary = (xml: string) => parseFeed(xml, source).entries[0].summary;
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe('feed summaries are bounded plain metadata, never extracted bodies', () => {
  it('prefers the RSS description and flattens passive markup with readable block boundaries', () => {
    const value = summary(rss('<description><![CDATA[<p>A <strong>useful</strong> idea &amp; a question.</p><p>Another line<br>with details.</p><ul><li>One</li><li>Two</li></ul>]]></description><content:encoded>Do not choose this full content.</content:encoded>'));
    expect(value).toBe('A useful idea & a question. Another line with details. One Two');
    expect(value).not.toMatch(/<|>/);
  });
  it('falls back to the namespaced content:encoded field if the description has no usable text', () => {
    expect(summary(rss('<content:encoded><![CDATA[<p>Content excerpt.</p>]]></content:encoded>'))).toBe('Content excerpt.');
    expect(summary(rss('<description><![CDATA[<script>bad()</script>]]></description><content:encoded><![CDATA[<p>Safe fallback.</p>]]></content:encoded>'))).toBe('Safe fallback.');
    expect(summary(rss('<description>  </description><other:encoded xmlns:other="http://purl.org/rss/1.0/modules/content/">Another prefix.</other:encoded>'))).toBe('Another prefix.');
    expect(summary(rss('<encoded>Wrong namespace</encoded><x:encoded xmlns:x="urn:evil">Wrong extension</x:encoded>'))).toBeUndefined();
  });
  it('removes active subtrees, comments, events, images and URL attributes without executing or fetching', () => {
    const fetch = vi.fn(async () => { throw new Error('Feed summaries must not fetch'); });
    vi.stubGlobal('fetch', fetch);
    const value = summary(rss(`<description><![CDATA[<p onclick="bad()" style="color:red">Kept prose <a href="javascript:bad()">link text</a>.</p>
      <script>globalThis.feedSummaryAttack = true</script><style>bad CSS</style><iframe src="https://evil.example/">Frame text</iframe>
      <svg onload="bad()"><text>SVG text</text></svg><form>Password form</form><object>Object text</object>
      <img src="https://evil.example/image.png" onerror="bad()" alt="Image"><!-- tracking comment -->
      <p hidden>Hidden text</p><p style="display: none">Hidden style</p><p aria-hidden="true">Hidden ARIA</p>]]></description>`));
    expect(value).toBe('Kept prose link text.');
    expect(fetch).not.toHaveBeenCalled();
    expect((globalThis as Record<string, unknown>).feedSummaryAttack).toBeUndefined();
  });
  it('understands Atom HTML, plain text and prefixed XHTML summaries', () => {
    expect(summary(atom('<summary type="html">&lt;p&gt;A &lt;b&gt;clear&lt;/b&gt; summary.&lt;/p&gt;</summary>'))).toBe('A clear summary.');
    expect(summary(atom('<summary>3 &lt; 5 &amp; 8 &gt; 2.</summary>'))).toBe('3 < 5 & 8 > 2.');
    expect(summary(atom(`<summary type="xhtml"><x:div xmlns:x="http://www.w3.org/1999/xhtml"><x:p>First <x:b>idea</x:b>.</x:p>
      <x:script>bad script</x:script><x:iframe src="https://evil.example">Bad frame</x:iframe><x:p>Second idea.</x:p></x:div></summary>`))).toBe('First idea. Second idea.');
  });
  it('supports actual XML children in RSS descriptions without leaking script text', () => {
    expect(summary(rss('<description><p>First paragraph.</p><script>Do not include</script><p>Second paragraph.</p></description>'))).toBe('First paragraph. Second paragraph.');
  });
  it('keeps literal Atom text literal; summaries must be rendered as text, never interpolated HTML', () => {
    const value = summary(atom('<summary type="text">Example &lt;script&gt;literal code&lt;/script&gt; &amp; normal text.</summary>'))!;
    expect(value).toBe('Example <script>literal code</script> & normal text.');
    const target = document.createElement('p'); target.textContent = value;
    expect(target.querySelector('script')).toBeNull();
    expect(target.textContent).toBe(value);
  });
  it('bounds full-content fallbacks and long text summaries without splitting Unicode surrogates', () => {
    const value = summary(rss(`<content:encoded><![CDATA[<p>${'Readable article paragraph. '.repeat(1000)}</p>]]></content:encoded>`))!;
    expect(value.length).toBeLessThanOrEqual(MAX_SUMMARY_LENGTH);
    expect(value.endsWith('…')).toBe(true);
    const unicode = summary(atom(`<summary type="text">${'😀'.repeat(2000)}</summary>`))!;
    expect(unicode.length).toBeLessThanOrEqual(MAX_SUMMARY_LENGTH);
    expect(unicode).not.toMatch(/[\uD800-\uDBFF]…$/u);
    expect(unicode.endsWith('…')).toBe(true);
  });
  it('omits empty or unsupported previews without dropping usable entries', () => {
    for (const xml of [rss('<description> </description>'), rss('<description><![CDATA[<script>bad()</script><iframe>bad</iframe>]]></description>'),
      atom('<summary type="application/octet-stream">Binary data</summary>'), atom('<content type="html">Not a summary</content>')]) {
      const [entry] = parseFeed(xml, source).entries;
      expect(entry.url).toBe('https://news.example/article');
      expect(entry).not.toHaveProperty('summary');
      expect(entry).not.toHaveProperty('body');
      expect(entry).not.toHaveProperty('content');
      expect(entry).not.toHaveProperty('extractor');
    }
  });
  it('keeps first-entry deduplication semantics for preview and supplied Markdown', () => {
    const xml = '<rss><channel><item><guid>same</guid><link>/one</link><description>First summary</description></item><item><guid>same</guid><link>/two</link><description>Second summary</description></item></channel></rss>';
    const entries = parseFeed(xml, source).entries;
    expect(entries).toEqual([{ id: 'same', url: 'https://news.example/one', title: 'news.example', summary: 'First summary', feedText: { markdown: 'First summary', isExcerpt: true } }]);
  });
});
