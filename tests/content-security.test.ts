// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { marked } from 'marked';
import DOMPurify from 'dompurify';
import Defuddle from 'defuddle/full';
import { MAX_DOM_DEPTH, MAX_DOM_NODES, MAX_HTML_BYTES, boundDom } from '../src/content/bounds';
import { extract } from '../src/content/extract';
import { feedMarkdown, parseFeed } from '../src/content/feed';
import { fragment, plainText, toMarkdown } from '../src/content/html';
import { assertSafeExternalText } from '../src/content/security';

const base = 'https://news.example/story';
const response = (text: string) => ({
  status: 200,
  text,
  headers: { 'content-type': 'text/html' },
});
const rss = (items: string) => `<rss><channel><title>Feed</title>${items}</channel></rss>`;
const render = (markdown: string): Document =>
  new DOMParser().parseFromString(marked.parse(markdown, { async: false }), 'text/html');
afterEach(() => vi.restoreAllMocks());

function assertPassive(doc: Document): void {
  expect(
    doc.querySelector('script,iframe,object,embed,form,style,svg,math,input,meta,link,template'),
  ).toBeNull();
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
  expect(doc.querySelector('pre code[class]')).toBeNull();
}

describe('publisher content is passive in persisted Markdown', () => {
  it.each([
    'dataviewjs',
    'dataview',
    'templater',
    'javascript',
    'text',
    'unknown-native-processor',
  ])('drops every fence label, including %s', async (language) => {
    const literal =
      'globalThis.attack = true;\n==literal== [[literal]]\n```dataviewjs\n~~~templater\n<script>literal</script>';
    const html = literal.replace(/</g, '&lt;').replace(/>/g, '&gt;');
    const markdown = await toMarkdown(
      `<blockquote><pre data-language="${language}"><code class="language-${language}" data-lang="${language}">${html}</code></pre></blockquote>
      <ul><li><pre class="language-${language}"><code class="language-${language}">second block</code></pre></li></ul>`,
      base,
    );
    const doc = render(markdown);
    assertPassive(doc);
    expect(doc.querySelector('pre code')?.textContent).toBe(literal + '\n');
    expect(doc.querySelectorAll('pre code')).toHaveLength(2);
    expect(doc.querySelectorAll('pre code')[1].textContent).toBe('second block\n');
  });
  it.each(['<% tp.file.title %>', '<%* globalThis.attack = true; %>', '<%+ tp.date.now() %>'])(
    'fails capture on Templater delimiters, even in code or titles: %s',
    async (literal) => {
      const encoded = literal.replace(/</g, '&lt;').replace(/>/g, '&gt;');
      for (const html of [
        `<p>${encoded}</p>`,
        `<code>${encoded}</code>`,
        `<pre><code>${encoded}</code></pre>`,
      ]) {
        await expect(toMarkdown(html, base)).rejects.toThrow(/Cannot capture.*Templater/);
      }
      expect(() => plainText(encoded)).toThrow(/Templater/);
      expect(() => assertSafeExternalText(literal)).toThrow(/Templater/);
      expect(() =>
        parseFeed(`<rss><channel><title>${encoded}</title></channel></rss>`, base),
      ).toThrow(/Templater/);
      expect(() =>
        parseFeed(rss(`<item><link>/one</link><title>${encoded}</title></item>`), base),
      ).toThrow(/Templater/);
      await expect(
        extract(base, async () => response(`<title>${encoded}</title><article>Words</article>`)),
      ).rejects.toThrow(/Templater/);
    },
  );
  it.each(['= this.file.name', '$= dv.current().file.name', '  $= globalThis.attack = true'])(
    'fails capture on default Dataview inline expressions: %s',
    async (literal) => {
      await expect(
        toMarkdown(`<blockquote><p>Unsafe <code>${literal}</code></p></blockquote>`, base),
      ).rejects.toThrow(/Cannot capture.*Dataview inline/);
      expect(() => assertSafeExternalText(`Title with \`${literal}\``)).toThrow(/Dataview inline/);
      expect(() => plainText(`Title with \`${literal}\``)).toThrow(/Dataview inline/);
      const markdown = await toMarkdown(`<pre><code>${literal}</code></pre>`, base);
      expect(render(markdown).querySelector('pre code')?.textContent).toBe(literal + '\n');
    },
  );
  it('keeps ordinary inline and whitespace-sensitive fenced code unchanged', async () => {
    const literal = '\n  const value = "==literal== [[literal]]";\n\treturn value;  \n\n';
    const markdown = await toMarkdown(
      `<p>Normal <code>a = b</code> and <code>$value</code>.</p><ol start="3"><li><p>Code</p><pre class="language-js"><code>${literal}</code></pre></li></ol>`,
      base,
    );
    const doc = render(markdown);
    expect([...doc.querySelectorAll('p code')].map((code) => code.textContent)).toEqual([
      'a = b',
      '$value',
    ]);
    expect(markdown).toContain('\treturn value;  \n    \n    ```'); // Literal tabs/trailing blank line survive in source.
    // Marked's list renderer expands tabs and trims one trailing blank line; the stored code does not.
    expect(doc.querySelector('pre code')?.textContent).toBe(
      literal.replace(/\t/g, '    ').replace(/\n$/, ''),
    );
    expect(doc.querySelector('pre code')?.className).toBe('');
  });
  it('fails closed when a converter layout cannot preserve a literal code block', async () => {
    await expect(
      toMarkdown('<ol start="123"><li><p>Intro</p><pre>literal</pre></li></ol>', base),
    ).rejects.toThrow(/Cannot capture.*code/);
  });
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
    '<pre><code class="language-dataviewjs" data-language="x&#10;```&#10;&lt;script&gt;">safe code</code></pre>',
    '<p><a href="/safe&quot;onmouseover=&quot;bad()">Quotes</a><img src="/image(1).png" alt="&lt;iframe&gt; [x] ![](javascript:x)"></p>',
  ])('does not recreate active HTML or unsafe destinations during conversion', async (html) => {
    const doc = render(await toMarkdown(html, base));
    assertPassive(doc);
    expect(doc.createTreeWalker(doc.body, NodeFilter.SHOW_COMMENT).nextNode()).toBeNull();
  });
  it('removes genuinely hidden subtrees before dropping styles, not merely styled prose', async () => {
    const hidden = [
      'hidden',
      'hidden="until-found"',
      'aria-hidden="true"',
      'aria-hidden="TRUE"',
      'style="display: none !important"',
      'style="DISPLAY: NONE"',
      'style="visibility: hidden"',
      'style="visibility: collapse"',
      'style="content-visibility: hidden"',
    ];
    const html =
      hidden.map((attr) => `<div ${attr}><p>Secret text</p></div>`).join('') +
      '<template><p>Secret template</p></template><p style="color: red" aria-hidden="false">Visible <em>prose</em>.</p>';
    const safe = fragment(html, base);
    expect(safe.textContent).toBe('Visible prose.');
    expect(safe.querySelector('[style]')).toBeNull();
    expect(await toMarkdown(html, base)).toBe('Visible *prose*.');
  });
  it('preserves literal comments, tags, delimiter runs and plain preformatted blocks', async () => {
    const markdown = await toMarkdown(
      '<p>Prose &lt;!-- literal --&gt; <code>&lt;!-- inline --&gt;</code>.</p><!-- remove me -->' +
        '<pre><code class="language-html">&lt;!-- code --&gt;\n&lt;script&gt;literal&lt;/script&gt;\n```\n&lt;iframe&gt;</code></pre>' +
        '<pre>Plain pre &lt;!-- preserved --&gt;</pre>',
      base,
    );
    const doc = render(markdown);
    assertPassive(doc);
    expect(markdown).not.toContain('remove me');
    expect(doc.body.textContent).toContain('Prose <!-- literal -->');
    expect(doc.querySelector('p code')?.textContent).toBe('<!-- inline -->');
    expect(doc.querySelector('pre code')?.textContent).toBe(
      '<!-- code -->\n<script>literal</script>\n```\n<iframe>\n',
    );
    expect(doc.querySelectorAll('pre code')[1].textContent).toBe('Plain pre <!-- preserved -->\n');
  });
  it('uses the same passive conversion for RSS, Atom and article extraction without background requests', async () => {
    const fetch = vi
      .spyOn(globalThis, 'fetch')
      .mockRejectedValue(new Error('Unexpected network request'));
    const html =
      '<p>' +
      'A readable article has enough ordinary words to survive extraction. '.repeat(15) +
      '</p><pre><code class="language-dataviewjs">globalThis.attack = true;</code></pre><p hidden>Secret text</p>';
    const feeds = [
      rss(`<item><link>/one</link><description><![CDATA[${html}]]></description></item>`),
      `<feed xmlns="http://www.w3.org/2005/Atom"><entry><link href="/one"/><content type="xhtml"><div xmlns="http://www.w3.org/1999/xhtml">${html.replace(' hidden>', ' hidden="hidden">')}</div></content></entry></feed>`,
    ];
    for (const xml of feeds) {
      const item = parseFeed(xml, base).items[0];
      const markdown = await feedMarkdown(item);
      assertPassive(render(markdown));
      expect(markdown).not.toMatch(/dataviewjs|Secret text/);
      expect(markdown).toContain('globalThis.attack = true;');
      expect(await feedMarkdown(parseFeed(xml, base).items[0])).toBe(markdown);
    }
    const get = vi.fn(async () => response(`<title>Article</title><article>${html}</article>`));
    const article = await extract(base, get);
    assertPassive(render(article.markdown));
    expect(article.markdown).not.toMatch(/dataviewjs|Secret text/);
    expect(article.markdown).toContain('globalThis.attack = true;');
    expect(get).toHaveBeenCalledOnce();
    expect(fetch).not.toHaveBeenCalled();
  });
});

describe('HTML/XML complexity budgets precede extraction and conversion', () => {
  it('rejects oversized decoded UTF-8 payloads', async () => {
    const payload = '文'.repeat(Math.ceil(MAX_HTML_BYTES / 3));
    expect(() => parseFeed(rss(payload), base)).toThrow(/large/);
    await expect(extract(base, async () => response(payload))).rejects.toThrow(/large/);
    await expect(toMarkdown(payload, base)).rejects.toThrow(/large/);
  });
  it('bounds XML nodes and depth, not only feed entries', () => {
    expect(() => parseFeed(rss('<x/>'.repeat(MAX_DOM_NODES)), base)).toThrow(/node limit/);
    expect(() =>
      parseFeed(rss('<x>'.repeat(MAX_DOM_DEPTH) + '</x>'.repeat(MAX_DOM_DEPTH)), base),
    ).toThrow(/depth limit/);
    expect(() => parseFeed(rss('text<!--comment-->'.repeat(MAX_DOM_NODES / 2)), base)).toThrow(
      /node limit/,
    );
  });
  it.each([
    ['node', '<article>' + '<br>'.repeat(MAX_DOM_NODES) + '</article>'],
    ['node', 'text<!--comment-->'.repeat(MAX_DOM_NODES / 2)],
    ['depth', '<div>'.repeat(MAX_DOM_DEPTH + 1) + 'deep' + '</div>'.repeat(MAX_DOM_DEPTH + 1)],
    ['depth', '<template>'.repeat(MAX_DOM_DEPTH) + '</template>'.repeat(MAX_DOM_DEPTH)],
    ['node', '<template>' + '<br>'.repeat(MAX_DOM_NODES) + '</template>'],
  ])('rejects HTML over its %s limit before sanitization or Defuddle', async (limit, html) => {
    const sanitize = vi.spyOn(DOMPurify, 'sanitize');
    const parse = vi.spyOn(Defuddle.prototype, 'parse');
    const error = new RegExp(`${limit} limit`);
    expect(() => fragment(html, base)).toThrow(error);
    await expect(toMarkdown(html, base)).rejects.toThrow(error);
    await expect(extract(base, async () => response(html))).rejects.toThrow(error);
    expect(sanitize).not.toHaveBeenCalled();
    expect(parse).not.toHaveBeenCalled();
  });
  it('allows ordinary nesting and counts template contents at the budget boundary', () => {
    const root = document.createDocumentFragment();
    let node: Node = root;
    for (let i = 0; i < MAX_DOM_DEPTH; i++) node = node.appendChild(document.createElement('div'));
    expect(() => boundDom(root)).not.toThrow();
    node.appendChild(document.createTextNode('one deeper'));
    expect(() => boundDom(root)).toThrow(/depth limit/);
    expect(() =>
      fragment('<section><template><div>inert</div></template><p>visible</p></section>', base),
    ).not.toThrow();
  });
});
