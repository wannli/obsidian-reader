import { expect, it } from 'vitest';
import { addInlineLink, parseInlineMarkdown, removeInlineHighlight, removeInlineLink, setInlineHighlightLink, setInlineLink } from '../src/inline';

it.each([
  'https://example.com/?a=1&b=2',
  'https://example.com/?q=&copy;',
  'https://example.com/?q=&#65;',
  'https://example.com/?q=&amp;',
  'https://example.com/?q=&quot;',
  'https://example.com/?q=&notit',
  'https://example.com/a(b)?q=&copy;',
])('round-trips requested literal destination through mapped and passive Markdown: %s', target => {
  const source = '**word**', parsed = parseInlineMarkdown(source);
  const added = addInlineLink(source, { quote: 'word', revision: parsed.revision }, target);
  const old = '[**word**](https://old.example "Keep this title")';
  const retargeted = setInlineLink(old, parseInlineMarkdown(old).links[0].id, target);
  for (const next of [added, retargeted]) {
    const mapped = parseInlineMarkdown(next);
    expect(mapped.links[0].target).toBe(target);
    expect(mapped.root.querySelector('a')?.getAttribute('href')).toBe(target);
    expect(parseInlineMarkdown('- ' + next).root.querySelector('a')?.getAttribute('href')).toBe(target);
  }
  expect(retargeted).toContain(' "Keep this title")');
});

it.each([
  ['https://example.com/?a=1&amp;b=2', 'https://example.com/?a=1&b=2'],
  ['https://example.com/&#65;', 'https://example.com/A'],
  ['https://example.com/?q=&amp;copy;', 'https://example.com/?q=&copy;'],
  ['https://example.com/?q=&notit', 'https://example.com/?q=&notit'],
])('decodes authored destination entities exactly once with attribute rules: %s', (raw, expected) => {
  const source = `[site](${raw})`;
  expect(parseInlineMarkdown(source).links[0].target).toBe(expected);
  expect(parseInlineMarkdown(source).root.querySelector('a')?.getAttribute('href')).toBe(expected);
  expect(parseInlineMarkdown('- ' + source).root.querySelector('a')?.getAttribute('href')).toBe(expected);
});

it.each([
  'javascript&colon;alert(1)',
  'javascript&#58;alert(1)',
  'java&#115;cript:alert(1)',
  'https://user&colon;password&commat;example.com/',
  'https://user:password@example.com/',
  'https://user@example.com/',
  'https://:password@example.com/',
  'https://%75ser:password@example.com/',
])('validates decoded schemes and credentials in mapped and passive authored links: %s', raw => {
  for (const source of [`[site](${raw})`, `- [site](${raw})`]) {
    expect(parseInlineMarkdown(source).root.querySelector('a[href]')).toBeNull();
  }
});

it.each(['https://user:password@example.com/', 'https://user@example.com/', 'https://:password@example.com/'])('rejects newly requested credentials-bearing destinations: %s', target => {
  const source = 'word', parsed = parseInlineMarkdown(source);
  expect(() => addInlineLink(source, { quote: source, revision: parsed.revision }, target)).toThrow(/unsafe/);
  const old = '[word](https://old.example)', id = parseInlineMarkdown(old).links[0].id;
  expect(() => setInlineLink(old, id, target)).toThrow(/unsafe/);
});

it.each([
  ['Before ==[label](https://example.com "title")== after.', 'Before [label](https://example.com "title") after.'],
  ['==[**label**](https://example.com/?a=1&amp;b=2)==', '[**label**](https://example.com/?a=1&amp;b=2)'],
  ['==[[Topic|label]]==', '[[Topic|label]]'],
  ['==[one](https://one.example) and [two](https://two.example)==', '[one](https://one.example) and [two](https://two.example)'],
])('unhighlights an outer wrapper while preserving contained links byte-for-byte: %s', (source, expected) => {
  const parsed = parseInlineMarkdown(source);
  const result = removeInlineHighlight(source, parsed.highlights[0].id);
  expect(result).toBe(expected);
  const after = parseInlineMarkdown(result);
  expect(after.canonicalText).toBe(parsed.canonicalText);
  expect(after.highlights).toHaveLength(0);
  expect(after.links.map(link => link.target)).toEqual(parsed.links.map(link => link.target));
  expect(() => removeInlineHighlight(result, parsed.highlights[0].id)).toThrow(/changed/);
});

it('keeps overlapping relink/unlink and code restrictions fail-closed', () => {
  const source = '==[label](https://example.com)==', parsed = parseInlineMarkdown(source);
  expect(() => setInlineHighlightLink(source, parsed.highlights[0].id, 'Topic')).toThrow(/Nested/);
  expect(() => removeInlineLink(source, parsed.links[0].id)).toThrow(/Nested/);
  const withCode = '==[label](https://example.com) `code`==';
  expect(() => removeInlineHighlight(withCode, parseInlineMarkdown(withCode).highlights[0].id)).toThrow(/unsupported/);
});
