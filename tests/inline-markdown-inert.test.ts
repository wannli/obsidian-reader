import { afterEach, expect, it, vi } from 'vitest';
import { parseInlineMarkdown } from '../src/inline/parser';

const image = '![alt](https://example.com/image.png "Title")';
const cases = [
  ['inline image', `Before ${image} ==highlight== after`],
  ['highlight image', `==before ${image} after==`],
  ['list fallback', `- ${image} ==highlight==`],
  ['quote fallback', `> ${image} ==highlight==`],
  ['table fallback', `| Image |\n| --- |\n| ${image} ==highlight== |`],
  ['HTML fallback', `<div><img src="https://example.com/image.png"><mark>highlight</mark></div>`],
  ['unsafe paragraph fallback', `${image} $math$ ==highlight==`],
  ['reference link label', `[${image}][ref]\n\n[ref]: https://example.com`],
  ['reference image', `==highlight== ![alt][ref]\n\n[ref]: https://example.com/image.png`],
  ['duplicate definition fallback', `==highlight== ${image}\n\n[ref]: one\n\n[ref]: two`],
  ['ordinary nodes', '# Heading\n\n==highlight &amp; text== **bold** _em_ ~~del~~ `code`  \n[[Note]] [link](Note)'],
] as const;

afterEach(() => vi.restoreAllMocks());

it.each(cases)('materializes %s only in documents without a browsing context', (_name, source) => {
  const create = vi.spyOn(document, 'createElement');
  const text = vi.spyOn(document, 'createTextNode');
  const setHTML = Object.getOwnPropertyDescriptor(Element.prototype, 'innerHTML')!.set!;
  const owners: Document[] = [];
  vi.spyOn(Element.prototype, 'innerHTML', 'set').mockImplementation(function (this: Element, value: string) {
    // Destination decoding uses a template whose contents are already inert.
    if (this.tagName !== 'TEMPLATE') owners.push(this.ownerDocument);
    setHTML.call(this, value);
  });
  const parsed = parseInlineMarkdown(source);
  expect(parsed.root.ownerDocument).not.toBe(document);
  expect(parsed.root.ownerDocument.defaultView).toBeNull();
  expect(create.mock.calls.every(([tag]) => tag === 'template')).toBe(true);
  expect(text).not.toHaveBeenCalled();
  expect(owners.every(owner => owner.defaultView === null)).toBe(true);
  for (const node of parsed.root.querySelectorAll('*')) {
    expect(node.ownerDocument).toBe(parsed.root.ownerDocument);
  }
  if (source.includes('image.png')) {
    expect(parsed.root.querySelector('img')?.getAttribute('src')).toBe('https://example.com/image.png');
    expect(parsed.html).toContain('src="https://example.com/image.png"');
  }
});

it('preserves mapped highlights, source offsets, entities and image display attributes', () => {
  const source = `${image} ==A &amp; **bold**==`;
  const parsed = parseInlineMarkdown(source);
  expect(parsed.canonicalText).toBe('A & bold');
  expect(parsed.highlights).toHaveLength(1);
  expect(parsed.highlights[0].quote).toBe('A & bold');
  const { start, end } = parsed.highlights[0].source;
  expect(source.slice(start, end)).toBe('==A &amp; **bold**==');
  expect(parsed.root.querySelector('img')?.getAttribute('alt')).toBe('alt');
  expect(parsed.root.querySelector('img')?.getAttribute('title')).toBe('Title');
  expect(parsed.root.querySelector('mark strong')?.textContent).toBe('bold');
});
