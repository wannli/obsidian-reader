import { afterEach, describe, expect, it, vi } from 'vitest';
import Defuddle from 'defuddle/full';
import { marked } from 'marked';
import { parseFeed } from '../src/ingest/feed';
import { MAX_FEED_BYTES } from '../src/ingest/bounds';

vi.mock('defuddle/full', async importOriginal => {
  const actual = await importOriginal<typeof import('defuddle/full')>();
  const browserExport = actual.default as typeof actual.default & { createMarkdownContent: typeof actual.createMarkdownContent };
  return { ...actual, createMarkdownContent: actual.createMarkdownContent ?? browserExport.createMarkdownContent,
    default: vi.fn(function () { throw new Error('Feed text must not invoke Defuddle extraction'); }) };
});
const source = 'https://news.example/feeds/latest.xml';
const atom = (fields: string) => `<feed xmlns="http://www.w3.org/2005/Atom"><entry><id>one</id><link href="/article"/>${fields}</entry></feed>`;
const rss = (fields: string) => `<rss xmlns:c="http://purl.org/rss/1.0/modules/content/"><channel><item><guid>one</guid><link>/article</link>${fields}</item></channel></rss>`;
const convert = (xml: string) => parseFeed(xml, source).entries[0].feedText;
const render = (markdown: string) => new DOMParser().parseFromString(marked.parse(markdown, { async: false }), 'text/html');
afterEach(() => { expect(Defuddle).not.toHaveBeenCalled(); vi.clearAllMocks(); vi.unstubAllGlobals(); });

describe('parseFeed supplied text (not article-page extraction)', () => {
  it('retains WIRED-shaped plain RSS descriptions as genuine excerpts', () => {
    const result = convert(rss('<description>A genuine publisher excerpt, supplied by the feed.</description>'))!;
    expect(result).toEqual({ markdown: 'A genuine publisher excerpt, supplied by the feed.', isExcerpt: true });
    expect(result.markdown).not.toMatch(/Dummy article|extraction is disabled/);
  });
  it('preserves an entire Simon-shaped rich Atom summary without declaring it full content', () => {
    const prose = '<p>A substantial paragraph about reading and testing preserves useful context.</p>'.repeat(70);
    const result = convert(atom(`<summary type="html"><![CDATA[<blockquote>Publisher quotation.</blockquote>${prose}
      <h2>Details</h2><ul><li>First</li><li>Second</li></ul><pre><code class="language-js">const x = 1;</code></pre>
      <p><a href="/related#section">Related article</a></p><p>Tail preserved.</p>]]></summary>`))!;
    expect(result.isExcerpt).toBe(true); // Field semantics, not length or apparent completeness.
    expect(result.markdown.length).toBeGreaterThan(4000);
    expect(result.markdown).toContain('> Publisher quotation.');
    expect(result.markdown).toContain('## Details');
    expect(result.markdown).toMatch(/- +First/);
    expect(result.markdown).toContain('const x = 1;');
    expect(result.markdown).toContain('https://news.example/related#section');
    expect(result.markdown.endsWith('Tail preserved.')).toBe(true);
  });
  it('prefers explicit RSS content:encoded over its short description, regardless of prefix', () => {
    const result = convert(rss('<description>Short preview.</description><c:encoded><![CDATA[<p>Full supplied field.</p><p>Its final paragraph.</p>]]></c:encoded>'))!;
    expect(result.isExcerpt).toBe(false);
    expect(result.markdown).toContain('Full supplied field.');
    expect(result.markdown).toContain('Its final paragraph.');
    expect(result.markdown).not.toContain('Short preview.');
  });
  it('distinguishes inline Atom content from summaries without relying on character thresholds', () => {
    const explicit = convert(atom('<summary>Preview.</summary><content type="html">&lt;p&gt;Small but explicitly supplied content.&lt;/p&gt;</content>'))!;
    expect(explicit).toEqual({ markdown: 'Small but explicitly supplied content.', isExcerpt: false });
    const fallback = convert(atom('<content type="html">&lt;script&gt;bad()&lt;/script&gt;</content><summary>Safe excerpt.</summary>'))!;
    expect(fallback).toEqual({ markdown: 'Safe excerpt.', isExcerpt: true });
  });
  it('resolves inherited and nested xml:base and normalizes prefixed XHTML safely', () => {
    const xml = `<feed xmlns="http://www.w3.org/2005/Atom" xml:base="https://site.example/root/">
      <entry xml:base="entries/"><id>one</id><link href="/article"/><summary type="xhtml" xml:base="../text/">
        <x:div xmlns:x="http://www.w3.org/1999/xhtml" xml:base="docs/"><x:p>Useful <x:b>text</x:b>.</x:p>
          <x:a href="guide#one">Guide</x:a><x:img src="../image.png" alt="Image" onerror="bad()"/>
          <x:script>bad script</x:script><x:iframe src="https://evil.example">bad frame</x:iframe>
        </x:div></summary></entry></feed>`;
    const result = convert(xml)!;
    expect(result.isExcerpt).toBe(true);
    expect(result.markdown).toContain('Useful **text**.');
    expect(result.markdown).toContain('https://site.example/root/text/docs/guide#one');
    expect(result.markdown).toContain('![Image](https://site.example/root/text/image.png)');
    expect(result.markdown).not.toMatch(/bad script|bad frame|onerror|evil\.example/);
  });
  it('preserves literal Atom text and paragraphs without activating Markdown or HTML syntax', () => {
    const result = convert(atom('<summary type="text">First paragraph &lt;script&gt;literal&lt;/script&gt;.\n\nSecond [not a link](javascript:bad()).</summary>'))!;
    const doc = render(result.markdown);
    expect(doc.querySelectorAll('p')).toHaveLength(2);
    expect(doc.querySelector('script,a')).toBeNull();
    expect(doc.body.textContent).toContain('<script>literal</script>');
    expect(doc.body.textContent).toContain('[not a link](javascript:bad())');
  });
  it('removes active HTML but preserves safe code examples, images, lists and links', () => {
    const result = convert(rss(`<c:encoded><![CDATA[<p onclick="bad()">Safe text <a href="javascript:bad()">unsafe link</a>.</p>
      <script>bad script</script><iframe src="https://evil.example">bad frame</iframe><svg onload="bad()"></svg>
      <img src="https://user:pass@evil.example/image" onerror="bad()"><img src="/image.png" alt="Safe image">
      <pre><code class="language-html">&lt;!-- literal code comment --&gt;</code></pre><!-- source comment -->]]></c:encoded>`))!;
    expect(result.markdown).toContain('https://news.example/image.png');
    expect(result.markdown).toContain('<!-- literal code comment -->');
    expect(result.markdown).not.toMatch(/source comment|bad script|bad frame|evil\.example|onerror|onclick/);
    const doc = render(result.markdown);
    expect(doc.querySelector('script,iframe,svg')).toBeNull();
    expect(doc.querySelector('pre code')?.textContent).toContain('<!-- literal code comment -->');
    expect(doc.createTreeWalker(doc.body, 128).nextNode()).toBeNull();
  });
  it('does not mistake media:content for article content or fetch out-of-line Atom content', () => {
    const fetch = vi.fn(async () => { throw new Error('No network in feed conversion'); });
    vi.stubGlobal('fetch', fetch);
    expect(convert(rss('<media:content xmlns:media="http://search.yahoo.com/mrss/" url="https://evil.example/image"/><description>Actual excerpt.</description>')))
      .toEqual({ markdown: 'Actual excerpt.', isExcerpt: true });
    expect(convert(atom('<content type="html" src="https://evil.example/article"/><summary>Inline excerpt.</summary>')))
      .toEqual({ markdown: 'Inline excerpt.', isExcerpt: true });
    expect(convert(atom('<content type="application/octet-stream">Binary</content>'))).toBeUndefined();
    expect(fetch).not.toHaveBeenCalled(); expect(Defuddle).not.toHaveBeenCalled();
  });
  it('keeps independent preview and full-field limits, preserving text beyond 16,384 characters', () => {
    const text = 'A complete feed paragraph with meaningful details. '.repeat(800) + 'Final supplied sentence.';
    const [entry] = parseFeed(rss(`<description>Brief preview.</description><c:encoded><![CDATA[<p>${text}</p>]]></c:encoded>`), source).entries;
    expect(entry.summary).toBe('Brief preview.');
    expect(entry.feedText).toEqual({ markdown: text, isExcerpt: false });
    const [longSummary] = parseFeed(atom(`<summary type="html"><![CDATA[<p>${text}</p>]]></summary>`), source).entries;
    expect(longSummary.summary!.length).toBeLessThanOrEqual(2000);
    expect(longSummary.summary!.endsWith('…')).toBe(true);
    expect(longSummary.feedText).toEqual({ markdown: text, isExcerpt: true });
  });
  it('preserves publisher identity and emits no extraction-completion fields for the screenshot entry shape', () => {
    // Actual inspected identity/format, deliberately synthetic quotation text (not a publisher fixture).
    const xml = `<feed xmlns="http://www.w3.org/2005/Atom"><entry><id>https://simonwillison.net/2026/Sep/28/joedaroo/</id>
      <title>Quoting @joedaroo</title><link href="https://simonwillison.net/2026/Sep/28/joedaroo/"/>
      <published>2026-09-28T19:11:42Z</published><summary type="html">&lt;blockquote&gt;Supplied quotation.&lt;/blockquote&gt;</summary></entry></feed>`;
    const [entry] = parseFeed(xml, 'https://simonwillison.net/atom/everything/').entries;
    expect(entry.title).toBe('Quoting @joedaroo');
    expect(entry.published).toBe('2026-09-28T19:11:42.000Z');
    expect(entry.feedText).toEqual({ markdown: '> Supplied quotation.', isExcerpt: true });
    expect(entry).not.toHaveProperty('extractor'); expect(entry).not.toHaveProperty('content');
  });
  it('fails visibly on payload/depth limits rather than silently clipping supplied text', () => {
    expect(() => convert(rss(`<description>${'x'.repeat(MAX_FEED_BYTES + 1)}</description>`))).toThrow(/payload limit/);
    expect(() => convert(atom(`<summary type="html"><![CDATA[${'<div>'.repeat(80)}Text${'</div>'.repeat(80)}]]></summary>`))).toThrow(/depth limit/);
    expect(() => convert(atom('<summary type="html" xml:base="https://user:pass@evil.example/">Text</summary>'))).toThrow(/credentials/);
  });
});
