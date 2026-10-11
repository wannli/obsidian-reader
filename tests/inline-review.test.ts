import { afterEach, expect, it, vi } from 'vitest';
import { addInlineHighlight, addInlineLink, parseInlineMarkdown, removeInlineHighlight, removeInlineLink, setInlineLink } from '../src/inline';
import { mountReader } from '../src/ui/reader';
import { buildCanonicalTextIndex, rangeFromPosition } from '../src/highlights/text-index';
import type { Article, CompactAnchor } from '../src/types';
import type { ReaderController } from '../src/controller';

const stops: (() => void)[] = [];
afterEach(() => { stops.splice(0).forEach(stop => stop()); document.getSelection()?.removeAllRanges(); document.body.replaceChildren(); vi.restoreAllMocks(); vi.useRealTimers(); });

it.each(['https://example.com/?q=&copy;', 'https://example.com/?q=&#65;'])('preserves the requested destination literally: %s', target => {
  const source = '**word**', parsed = parseInlineMarkdown(source);
  const next = addInlineLink(source, { quote: 'word', revision: parsed.revision }, target);
  expect(parseInlineMarkdown(next).links[0].target).toBe(target);
  // Ordinary Markdown must mean the same destination outside the mapped paragraph renderer.
  expect(parseInlineMarkdown('- ' + next).root.querySelector('a')!.getAttribute('href')).toBe(target);
  const old = '[word](https://old.example "title") [neighbor](https://neighbor.example)';
  const retargeted = setInlineLink(old, parseInlineMarkdown(old).links[0].id, target);
  expect(parseInlineMarkdown(retargeted).links.map(link => link.target)).toEqual([target, 'https://neighbor.example']);
});

it.each(['https://example.com/?a=1&amp;b=2', 'https://example.com/&#65;'])('renders authored Markdown destination entities consistently in supported and passive blocks: %s', target => {
  const paragraph = parseInlineMarkdown(`[site](${target})`);
  const list = parseInlineMarkdown(`- [site](${target})`);
  expect(paragraph.root.querySelector('a')!.getAttribute('href')).toBe(list.root.querySelector('a')!.getAttribute('href'));
});

it('does not rebind a pending selection to an external same-text formatting revision', async () => {
  vi.useFakeTimers();
  let article: Article = { path: 'Reading/Inbox/Test.md', id: 'test', title: 'Test', body: 'one two', highlights: [], url: '', status: 'inbox', content: 'ready', extractor: 'manual' };
  const options = { stripTitle: article.title };
  const highlight = vi.fn(async (_path: string, quote: string, anchor: CompactAnchor) => {
    article = { ...article, body: addInlineHighlight(article.body, { quote, anchor }, options) };
    return article;
  });
  const controller = { repository: { articleGeneration: () => 0, getArticle: async () => article }, highlight } as unknown as ReaderController;
  const target = document.createElement('div'); document.body.append(target);
  const mount = mountReader(target, article, controller, { openNote: vi.fn() }, () => {}); stops.push(mount);
  const body = target.querySelector<HTMLElement>('.r2-article-body')!;
  const range = rangeFromPosition(buildCanonicalTextIndex(body), { start: 0, end: 3 });
  document.getSelection()!.addRange(range); document.dispatchEvent(new Event('selectionchange'));
  article = { ...article, body: '**one** two' };
  mount.update!(article);
  await vi.advanceTimersByTimeAsync(1000);
  expect(highlight).not.toHaveBeenCalled();
  expect(article.body).toBe('**one** two');
});

it.each([
  ['😀 **e\u0301** &amp; tail\r\n', 'e\u0301', '😀 ==**e\u0301**== &amp; tail\r\n'],
  ['same &amp; same\r\n\r\nend', 'same', 'same &amp; ==same==\r\n\r\nend'],
])('keeps supported source mapping and removal local: %s', (source, quote, expected) => {
  const parsed = parseInlineMarkdown(source), offset = parsed.canonicalText.lastIndexOf(quote);
  const start = Array.from(parsed.canonicalText.slice(0, offset)).length;
  const next = addInlineHighlight(source, { quote, anchor: { start, end: start + Array.from(quote).length, prefix: '', suffix: '', version: parsed.revision } });
  expect(next).toBe(expected);
  expect(removeInlineHighlight(next, parseInlineMarkdown(next).highlights[0].id)).toBe(source);
});

it('unlinks the entire formatted label without touching neighboring destinations', () => {
  const source = '[**😀 words**](https://one.example "title") [neighbor](https://two.example/a(b))';
  expect(removeInlineLink(source, parseInlineMarkdown(source).links[0].id)).toBe('**😀 words** [neighbor](https://two.example/a(b))');
});
