import { describe, expect, it } from 'vitest';
import { marked } from 'marked';
import { articleMarkdown } from '../src/ingest/markdown';
import { safeContent } from '../src/ingest/sanitize';

const base = 'https://news.example/story';
const convert = (html: string): string => articleMarkdown(safeContent(html, base), base);
const render = (markdown: string): Document => new DOMParser().parseFromString(marked.parse(markdown, { async: false }), 'text/html');

function assertPassive(doc: Document): void {
  expect(doc.querySelector('script,iframe,object,embed,form,style,svg,math,input,meta,link,template')).toBeNull();
  for (const node of doc.querySelectorAll('*')) {
    for (const attr of node.attributes) {
      expect(attr.name).not.toMatch(/^on|^(?:style|srcdoc|srcset)$/i);
      if (['src', 'href'].includes(attr.name)) {
        const url = new URL(attr.value);
        expect(['http:', 'https:']).toContain(url.protocol);
        expect(url.username + url.password).toBe('');
      }
    }
  }
}

describe('HTML-to-Markdown security fixtures', () => {
  it.each([
    '<p>Normal text</p><svg><foreignObject><iframe srcdoc="<script>alert(1)</script>"></iframe></foreignObject></svg>',
    '<math><mtext><table><mglyph><style><!--</style><img title="--><img src=1 onerror=alert(1)>">',
    '<svg><style><img src=x onerror=alert(1)></style></svg><p>Text</p>',
    '<noscript><p title="</noscript><img src=x onerror=alert(1)>">hello</p></noscript>',
    '<p>&lt;script&gt;alert(1)&lt;/script&gt; &lt;!-- generated marker --&gt;</p>',
    '<p>&amp;lt;img src=x onerror=alert(1)&amp;gt; &lt;https://user:pass@example.com&gt;</p>',
    '<p>https://user:pass@example.com http://user@example.com www.example.com ftp://example.com mail@example.com</p>',
    '<p><a href="&#x6a;avascript:alert(1)">Bad</a><a href="java&#x09;script:alert(1)">Bad</a><a href="vbscript:msgbox(1)">Bad</a></p>',
    '<p><img src="data:image/svg+xml,%3Csvg onload=alert(1)%3E"><img src="file:///etc/passwd"><img src="//user:password@evil.example/a"></p>',
    '<div onclick="bad()" style="background:url(javascript:bad())"><p onmouseover="bad()">Text</p></div>',
    '<img src="/a.png" alt="](&#106;avascript:alert(1)) ![attack"><a href="/safe_(x)?a=1&amp;b=2">A ](javascript:alert(1)) link</a>',
    '<pre><code data-language="x&#10;```&#10;&lt;script&gt;">safe code</code></pre>',
    '<p><a href="/safe&quot;onmouseover=&quot;bad()">Quotes</a><img src="/image(1).png" alt="&lt;iframe&gt; [x] ![](javascript:x)"></p>',
  ])('never emits active HTML or unsafe Markdown destinations', html => {
    const doc = render(convert(html));
    assertPassive(doc);
    const comments = doc.createTreeWalker(doc.body, 128);
    expect(comments.nextNode()).toBeNull();
  });
  it('keeps code comments, literal raw tags, fence delimiters, lists and safe images', () => {
    const markdown = convert(`<p>Ordinary prose &lt;!-- not a generated marker --&gt; with <code>&lt;!-- inline --&gt;</code>.</p>
      <!-- actual source comment should disappear -->
      <pre><code class="language-html">&lt;!-- literal code --&gt;\n&lt;script&gt;safeExample()&lt;/script&gt;\n\x60\x60\x60\n&lt;iframe&gt;</code></pre>
      <pre>Another plain pre block &lt;!-- preserved --&gt;</pre>
      <ol start="3"><li>Three</li><li>Four<ul><li>Nested</li></ul></li></ol>
      <p><a href="/guide_(one)#part">Guide</a> <img src="/picture(1).png" alt="[A picture]"></p>`);
    const doc = render(markdown);
    assertPassive(doc);
    expect(markdown).not.toContain('actual source comment');
    expect(doc.querySelector('pre code')?.textContent).toContain('<!-- literal code -->\n<script>safeExample()</script>\n```\n<iframe>');
    expect(doc.querySelectorAll('pre code')[1]?.textContent).toContain('<!-- preserved -->');
    expect(doc.querySelector('p code')?.textContent).toBe('<!-- inline -->');
    expect(doc.querySelector('ol')?.getAttribute('start')).toBe('3');
    expect(doc.querySelectorAll('li')).toHaveLength(3);
    expect(doc.querySelector('a')?.getAttribute('href')).toBe('https://news.example/guide_%28one%29#part');
    expect(doc.querySelector('img')?.getAttribute('alt')).toBe('[A picture]');
    expect(doc.querySelector('img')?.getAttribute('src')).toBe('https://news.example/picture%281%29.png');
  });
  it('keeps plugin-executable code labels inert and never recovers hidden source text', () => {
    const markdown = convert('<pre><code class="language-dataviewjs">globalThis.attack = true;</code></pre><p hidden>Secret hidden text</p><p style="display: none">Hidden CSS text</p><p aria-hidden="true">Hidden ARIA text</p>');
    expect(markdown).toContain('globalThis.attack = true;');
    expect(markdown).not.toMatch(/dataviewjs|Secret hidden|Hidden CSS|Hidden ARIA/);
    expect(render(markdown).querySelector('pre code')?.className).toBe('');
  });
  it('flattens formatting that would otherwise cause raw HTML output', () => {
    const markdown = convert('<p>A<sup>2</sup> B<sub>3</sub></p><table><tr><th colspan="2">Header</th></tr><tr><td>A</td><td>B</td></tr></table>');
    expect(markdown).not.toMatch(/<(?:sup|sub|table|td|th)\b/);
    expect(render(markdown).body.textContent).toContain('A2 B3');
  });
});
