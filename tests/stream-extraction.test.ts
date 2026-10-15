// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';
import { extract } from '../src/content/extract';
import { fragment, toMarkdown } from '../src/content/html';
import { parseHtml } from '../src/content/bounds';
import { restoreStreamedContent } from '../src/content/stream';

const url = 'https://example.com/article';
const title = 'How to Talk About International Law So the Public Will Listen | Example Research';
const prose =
  'International law is often seen as remote, yet it helps people cooperate and protect shared values. ';
const article = `<article><h1>${title}</h1><p>${prose.repeat(8)}</p><p>Final distinctive paragraph.</p></article>`;
const boundary = '<!--$?--><template id="B:0"></template><!--/$-->';
const segment = (content = article) => `<div hidden id="S:0">${content}</div>`;
const page = (content: string) =>
  `<html><head><title>${title}</title></head><body>${content}</body></html>`;
const get = (html: string) =>
  vi.fn(async () => ({
    status: 200,
    headers: { 'content-type': 'text/html' },
    text: page(html),
  }));
const restore = (html: string) => {
  const template = parseHtml(html);
  restoreStreamedContent(template.content);
  return template;
};

describe('inert streamed article extraction', () => {
  it('extracts a Carnegie-shaped streamed article once, without executing or fetching scripts', async () => {
    const fetch = vi.fn();
    vi.stubGlobal('fetch', fetch);
    try {
      const network = get(
        `${boundary}${segment()}<script>globalThis.streamAttack = true; $RC("B:0","S:0")</script>`,
      );
      const result = await extract(url, network);
      expect(result.markdown).toContain(prose.trim());
      expect(result.markdown.match(/Final distinctive paragraph/g)).toHaveLength(1);
      expect(result.markdown).not.toContain('streamAttack');
      expect((globalThis as any).streamAttack).toBeUndefined();
      expect(fetch).not.toHaveBeenCalled();
      expect(network).toHaveBeenCalledOnce();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('still sanitizes restored content and removes hidden descendants', async () => {
    const content = `${article}<p hidden>Hidden secret</p><p aria-hidden="true">Aria secret</p><p style="display:none">Style secret</p><a href="javascript:alert(1)" onclick="attack()">Unsafe link</a><script>attack()</script>`;
    const template = restore(`${boundary}${segment(content)}`);
    const safe = fragment(template.innerHTML, url);
    expect(safe.textContent).toContain(prose.trim());
    expect(safe.textContent).not.toMatch(/Hidden secret|Aria secret|Style secret|attack\(\)/);
    expect(safe.querySelector('script,[onclick],a[href]')).toBeNull();
  });

  it.each([
    segment(),
    `${boundary.replace('id="B:0"', 'id="B:0" hidden')}${segment()}`,
    `${boundary.replace('id="B:0"', 'id="B:0" aria-hidden="true"')}${segment()}`,
    `${boundary}${segment()}<div id="S:0"></div>`,
    `${boundary}<div id="B:0"></div>${segment()}`,
    `${boundary.replace('B:0', 'B:1')}${segment()}`,
    `${boundary.replace('<!--$?-->', '<!--$-->')}${segment()}`,
    `${boundary.replace('<!--/$-->', '<!--missing-->')}${segment()}`,
    `${boundary.replace('</template>', '<p>inert fallback</p></template>')}${segment()}`,
    `${boundary.replace('<!--/$-->', '<p>Visible fallback</p><!--/$-->')}${segment()}`,
    `${boundary}<section hidden>${segment()}</section>`,
    `<section hidden>${boundary}</section>${segment()}`,
    `${boundary}${segment().replace('hidden id', 'hidden aria-hidden="true" id')}`,
    `${boundary}${segment().replace('hidden id', 'hidden style="display:none" id')}`,
    `${boundary}${segment().replace('hidden id', 'hidden="until-found" id')}`,
    `${boundary}${segment().replace('div', 'section')}`,
    `${boundary}${segment().replace('S:0', 'S:bad')}`,
    `<script>"$RC(\\"B:0\\",\\"S:0\\")"</script>${segment()}`,
  ])('leaves unsupported or ambiguous structures unchanged: %s', (html) => {
    const original = parseHtml(html).innerHTML;
    expect(restore(html).innerHTML).toBe(original);
  });

  it('does not change normal hidden-content handling in render or feed conversion', async () => {
    const html = `${boundary}${segment()}<p>Visible words</p>`;
    expect(fragment(html, url).textContent).not.toContain(prose.trim());
    expect(await toMarkdown(html, url)).not.toContain(prose.trim());
  });

  it('continues enforcing DOM depth limits before restoration', async () => {
    const nested = '<div>'.repeat(70) + article + '</div>'.repeat(70);
    await expect(extract(url, get(`${boundary}${segment(nested)}`))).rejects.toThrow(/depth/);
  });
});

describe('title-only extraction is a visible failure', () => {
  it.each([title, `<h1>${title}</h1>`, `<h1>${title}</h1><h2>${title}</h2>`])(
    'rejects a long title without article prose: %s',
    async (body) => {
      await expect(extract(url, get(body))).rejects.toThrow(/Only the page title/);
    },
  );
  it('accepts the same title with real article prose', async () => {
    expect((await extract(url, get(article))).markdown).toContain(prose.trim());
  });
});
