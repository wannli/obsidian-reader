import { expect, it } from 'vitest';
import { addInlineHighlight, addInlineLink, parseInlineMarkdown, removeInlineHighlight, removeInlineLink, setInlineLink } from '../src/inline';
import { buildCanonicalTextIndex } from '../src/highlights/text-index';

function passiveForms(wiki: string): string[] {
  return [wiki, '- ' + wiki, '> ' + wiki, `| Link |\n| --- |\n| ${wiki.replace('|', '\\|')} |`];
}

it.each(['A &amp; B', '&#65; &copy;', '&amp;copy;', '**bold**', '_emphasis_', '<em>literal</em>', '😀 e\u0301'])('uses literal wiki alias text in mapped and passive blocks: %s', label => {
  const wiki = `[[Folder/Note|${label}]]`;
  for (const source of passiveForms(wiki)) {
    const parsed = parseInlineMarkdown(source), link = parsed.root.querySelector('a')!;
    expect(link.textContent).toBe(label);
    expect(link.getAttribute('href')).toBe('Folder/Note');
    expect(link.querySelector('em,strong')).toBeNull();
    const copy = document.createElement('article'); copy.innerHTML = parsed.html;
    expect(buildCanonicalTextIndex(copy).text).toBe(parsed.canonicalText);
  }
  expect(parseInlineMarkdown(wiki).links[0].quote).toBe(label);
});

it('does not decode entity-looking wiki targets or unaliased labels', () => {
  const target = 'Folder/A&amp;B';
  for (const source of passiveForms(`[[${target}]]`)) {
    const link = parseInlineMarkdown(source).root.querySelector('a')!;
    expect(link.getAttribute('href')).toBe(target); expect(link.textContent).toBe(target);
  }
});

it('refuses retargeting if the existing serializer would reinterpret a literal entity alias', () => {
  const source = '[[Old|A &amp; B]]', parsed = parseInlineMarkdown(source);
  expect(() => setInlineLink(source, parsed.links[0].id, 'New')).toThrow(/displayed text/);
});

it('refuses unlinking when bare Markdown would reinterpret a literal alias entity', () => {
  const source = '[[Note|A &amp; B]]', parsed = parseInlineMarkdown(source);
  expect(() => removeInlineLink(source, parsed.links[0].id)).toThrow(/displayed text/);
});

it('preserves existing ordinary-Markdown fallback for formatted internal links', () => {
  const source = '**bold**', parsed = parseInlineMarkdown(source);
  expect(addInlineLink(source, { quote: 'bold', revision: parsed.revision }, 'Topic')).toBe('[**bold**](Topic)');
});

it.each(['![alt][ref]', '![ref][]', '![ref]'])('renders resolved reference-image tokens in paragraphs and passive blocks: %s', image => {
  const definition = '\n\n[ref]: https://example.com/a.png?x=1&amp;y=2 "Image title"';
  const paragraph = parseInlineMarkdown(image + definition);
  const list = parseInlineMarkdown('- ' + image + definition);
  const quote = parseInlineMarkdown('> ' + image + definition);
  const expectedAlt = image === '![alt][ref]' ? 'alt' : 'ref';
  for (const parsed of [paragraph, list, quote]) {
    const img = parsed.root.querySelector('img')!;
    expect(img).not.toBeNull();
    expect(img.getAttribute('src')).toBe('https://example.com/a.png?x=1&y=2');
    expect(img.getAttribute('alt')).toBe(expectedAlt);
    expect(img.getAttribute('title')).toBe('Image title');
    expect(parsed.links).toHaveLength(0);
    expect(parsed.canonicalText).not.toContain(image);
  }
});

it('keeps source offsets after reference images and leaves definitions byte-for-byte intact', () => {
  const source = 'Before ![alt][ref] after.\r\n\r\n[ref]: https://example.com/a.png "Title"\r\n';
  const parsed = parseInlineMarkdown(source);
  const next = addInlineHighlight(source, { quote: 'after', revision: parsed.revision });
  expect(next).toBe('Before ![alt][ref] ==after==.\r\n\r\n[ref]: https://example.com/a.png "Title"\r\n');
  expect(removeInlineHighlight(next, parseInlineMarkdown(next).highlights[0].id)).toBe(source);
  expect(() => addInlineHighlight(source, { quote: 'Before after.', revision: parsed.revision })).toThrow(/unsupported/);
});

it('retains reference-image sanitization and does not broaden reference-link editing', () => {
  const unsafe = '![alt][img]\n\n[img]: javascript:alert(1)';
  expect(parseInlineMarkdown(unsafe).root.querySelector('img[src]')).toBeNull();
  const source = '[label][ref]\n\n[ref]: https://example.com';
  const parsed = parseInlineMarkdown(source);
  expect(() => setInlineLink(source, parsed.links[0].id, 'Topic')).toThrow(/unsupported/);
  expect(() => removeInlineLink(source, parsed.links[0].id)).toThrow(/unsupported/);
});
