import { describe, expect, it, vi } from 'vitest';
import Defuddle from 'defuddle/full';
import { marked } from 'marked';
import type { HttpGet, HttpResponse } from '../src/types';
import { extractArticle } from '../src/ingest/extract';

const source = 'https://news.example/blog/story';
const prose = Array.from({ length: 8 }, (_, index) => `<p>Section ${index + 1}. A public library preserves knowledge through careful engineering. This substantial paragraph describes resilient offline reading, reliable source material, and thoughtful testing for mobile readers.</p>`).join('');
const page = (extra = '', head = '<title>Resilient reading</title>') => `<!doctype html><html><head>${head}</head><body><nav>Menu</nav><article><h1>Resilient reading</h1>${prose}${extra}</article></body></html>`;
const response = (text: string, extra: Partial<HttpResponse> = {}): HttpResponse => ({ status: 200, headers: { 'content-type': 'text/html; charset=utf-8' }, text, ...extra });
const getPage = (text: string): HttpGet => async () => response(text);

function rendered(markdown: string): Document {
  return new DOMParser().parseFromString(marked.parse(markdown, { async: false }), 'text/html');
}

describe('browser Defuddle article ingestion', () => {
  it('extracts full offline text, headings, lists, code, international text, online images and safe links', async () => {
    const code = 'const sample = "<!-- keep this literal comment -->";\nconsole.log(sample);';
    const get = vi.fn(getPage(page(`<h2>Details</h2><ul><li>First useful item</li><li>Second useful item</li></ul>
      <pre><code class="language-js">${code.replace(/</g, '&lt;').replace(/>/g, '&gt;')}</code></pre>
      <p>日本語の文章。مرحبا بالعالم. <a href="../guide#section">Read the guide</a></p>
      <figure><img src="/images/library.png" alt="A library"><figcaption>The library</figcaption></figure>`)));
    const result = await extractArticle(source + '#top', get, 'defuddle');
    expect(result.status).toBe('ready');
    expect(result.extractor).toBe('defuddle');
    expect(result).not.toHaveProperty('provenance');
    expect(result.warning).toBeUndefined();
    expect(result.title).toBe('Resilient reading');
    expect(result.markdown).toContain('Section 8');
    expect(result.markdown).toContain('## Details');
    expect(result.markdown).toMatch(/- +First useful item/);
    expect(result.markdown).toContain(code);
    expect(result.markdown).toContain('日本語の文章。مرحبا بالعالم.');
    expect(result.markdown).toContain('https://news.example/guide#section');
    expect(result.markdown).toContain('![A library](https://news.example/images/library.png)');
    expect(get).toHaveBeenCalledTimes(1); // No image downloads or secondary extractor fetches.
    expect(get.mock.calls[0][0]).toBe(source);
  });
  it('performs live extraction only when Defuddle mode is explicit', async () => {
    const get = vi.fn(getPage(page()));
    const parse = vi.spyOn(Defuddle.prototype, 'parse');
    try {
      const result = await extractArticle(source, get, 'defuddle');
      expect(result.extractor).toBe('defuddle');
      expect(result.markdown).not.toContain('Dummy article');
      expect(result.markdown).toContain('Section 8');
      expect(get).toHaveBeenCalledTimes(1); expect(parse).toHaveBeenCalledTimes(1);
    } finally { parse.mockRestore(); }
  });
  it('uses validated final response/base URLs, ignores unsafe bases and publisher canonical claims', async () => {
    const html = page('<p><a href="guide#read">Guide</a><img data-src="pic.png" alt="Lazy image"></p>',
      '<base href="../assets/"><title>Redirected</title><link rel="canonical" href="https://evil.example/wrong">');
    const result = await extractArticle(source, async () => response(html, { url: 'https://redirect.example/path/post', headers: { 'Content-Type': 'TEXT/HTML' } }), 'defuddle');
    expect(result.markdown).toContain('https://redirect.example/assets/guide#read');
    expect(result.markdown).toContain('https://redirect.example/assets/pic.png');
    expect(result.markdown).not.toContain('evil.example');
    const unsafe = await extractArticle(source, getPage(page('<a href="guide">Guide</a>', '<base href="javascript:alert(1)"><title>Safe</title>')), 'defuddle');
    expect(unsafe.markdown).toContain('https://news.example/blog/guide');
  });
  it('removes active HTML, events, dangerous URLs, comments and tracking CSS before Markdown', async () => {
    const result = await extractArticle(source, getPage(page(`<!-- generated tracking marker -->
      <script>globalThis.__readerAttack = true</script><iframe src="https://evil.example/embed">iframe text</iframe>
      <object data="https://evil.example/o">Object text</object><form><input name="password">Password form</form>
      <svg onload="attack()"><text>svg text</text></svg><math><mtext>math text</mtext></math>
      <p onclick="attack()" style="background:url(https://evil.example/css)">Kept prose
        <a href="jav&#x61;script:attack()">unsafe link</a><a href="data:text/html,attack">data link</a>
        <a href="https://user:pass@evil.example/x">credential link</a></p>
      <img src="javascript:attack()" onerror="attack()" alt="Unsafe image">
      <img src="/safe.png" onerror="attack()" srcset="https://evil.example/x 2x" alt="Safe image">`)), 'defuddle');
    const doc = rendered(result.markdown);
    expect(doc.querySelector('script,iframe,object,form,svg,math')).toBeNull();
    for (const el of doc.querySelectorAll('*')) {
      expect([...el.attributes].some(attr => /^on/i.test(attr.name) || attr.name === 'style')).toBe(false);
    }
    expect(result.markdown).not.toMatch(/generated tracking|readerAttack|evil\.example|javascript:|data:text|onerror|onclick|iframe text|Password form/);
    expect(result.markdown).toContain('unsafe link');
    expect(result.markdown).toContain('https://news.example/safe.png');
    expect((globalThis as Record<string, unknown>).__readerAttack).toBeUndefined();
  });
  it('preserves escaped comment/tag syntax in code without introducing comments or HTML from prose', async () => {
    const result = await extractArticle(source, getPage(page(`<p>Literal &lt;!-- prose comment --&gt; and &lt;img src=x onerror=attack()&gt;.</p>
      <p>Inline <code>&lt;!-- inline code --&gt;</code> sample.</p>
      <pre><code class="language-html">&lt;!-- code comment --&gt;\n&lt;iframe src="example"&gt;&lt;/iframe&gt;\n\x60\x60\x60\nlast line</code></pre>`)), 'defuddle');
    const doc = rendered(result.markdown);
    expect(doc.querySelector('iframe,img')).toBeNull();
    expect(doc.querySelector('pre code')?.textContent).toContain('<!-- code comment -->');
    expect(doc.querySelector('pre code')?.textContent).toContain('```\nlast line');
    expect(doc.querySelector('p code')?.textContent).toBe('<!-- inline code -->');
    expect(doc.body.textContent).toContain('<!-- prose comment -->');
    const walker = doc.createTreeWalker(doc.body, 128 /* SHOW_COMMENT */);
    expect(walker.nextNode()).toBeNull();
  });
  it('makes a primary failure visible and limits fallback to article/main content', async () => {
    const parse = vi.spyOn(Defuddle.prototype, 'parse').mockImplementation(() => { throw new Error('Fixture extractor failure'); });
    try {
      const result = await extractArticle(source, getPage(page()), 'defuddle');
      expect(result.status).toBe('partial');
      expect(result.warning).toMatch(/primary extractor failed/);
      expect(result.markdown).toContain('Section 8');
      await expect(extractArticle(source, getPage(`<body>${prose}</body>`), 'defuddle')).rejects.toThrow(/No usable article/);
    } finally { parse.mockRestore(); }
  });
  it('marks short/restricted text partial, and refuses empty/dynamic-only/non-article sources', async () => {
    const short = await extractArticle(source, getPage('<title>A short story</title><article><p>This short but meaningful story might be only a fragment of the original published article.</p></article>'), 'defuddle');
    expect(short.status).toBe('partial'); expect(short.warning).toMatch(/short|incomplete/);
    const restricted = await extractArticle(source, getPage(page('<p>Subscribe to continue reading.</p>')), 'defuddle');
    expect(restricted.status).toBe('partial'); expect(restricted.warning).toContain('restricted');
    await expect(extractArticle(source, getPage('<title>App</title><script>renderEverything()</script><main></main>'), 'defuddle')).rejects.toThrow(/No usable article/);
    await expect(extractArticle(source, getPage('<p>1234567890'.repeat(70) + '</p>'), 'defuddle')).rejects.toThrow(/No usable article/);
    const links = Array.from({ length: 20 }, (_, i) => `<p><a href="/item/${i}">Navigation link to an unrelated story number ${i}</a></p>`).join('');
    await expect(extractArticle(source, getPage(`<main>${links}</main>`), 'defuddle')).rejects.toThrow(/navigation/);
  });
});
