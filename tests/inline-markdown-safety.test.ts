import { expect, it } from 'vitest';
import { buildCanonicalTextIndex } from '../src/highlights/text-index';
import { addInlineHighlight, parseInlineMarkdown, removeInlineHighlight, removeInlineLink, setInlineLink } from '../src/inline';

it.each([
  '- ==list highlight==',
  '> ==quote highlight==',
  '| Header |\n| --- |\n| ==table highlight== |',
  '==math $x$ highlight==',
  '==raw <b>HTML</b> highlight==',
])('reports authored highlights outside editable scope and protects their source: %s', source => {
  const parsed = parseInlineMarkdown(source);
  expect(parsed.hasUnsupportedHighlights).toBe(true);
  expect(parsed.warnings.length).toBeGreaterThan(0);
  expect(parsed.highlights).toHaveLength(0);
  expect(parsed.root.querySelector('mark')).not.toBeNull();
});

it.each(['`==not a highlight==`', '```\n==not a highlight==\n```', '- [publisher](https://example.com)'])('does not protect publisher links or literal code: %s', source => {
  const parsed = parseInlineMarkdown(source);
  expect(parsed.highlights).toHaveLength(0);
  expect(parsed.hasUnsupportedHighlights).toBe(false);
});

it.each([
  ['[**word**](old.md "User title")', '[**word**](new.md "User title")'],
  ['[word](https://example.com/a(b) \'A title\')', '[word](new.md \'A title\')'],
  ['[word](<folder/old note.md>  "Title")', '[word](new.md  "Title")'],
])('retargets only destination bytes and retains authored titles: %s', (source, expected) => {
  expect(setInlineLink(source, parseInlineMarkdown(source).links[0].id, 'new.md')).toBe(expected);
});

it.each([
  'A &lt;tag&gt; &amp; &#128512; **bold** ==marked== [[Note|label]]',
  '<p data-article-version="evil" data-inline-link-id="evil">HTML</p>',
  'www.example.com and <a@example.com>',
  '[**label**][ref]\n\n[ref]: https://example.com "title"',
  'A\0 B',
  '- ==list==\n\n> [[Note]]',
])('serialized HTML has the identical canonical index: %s', source => {
  const parsed = parseInlineMarkdown(source), root = document.createElement('article');
  root.innerHTML = parsed.html;
  expect(buildCanonicalTextIndex(root).text).toBe(parsed.canonicalText);
});

it('validates relative/protocol destinations even in unsupported blocks and source HTML', () => {
  const parsed = parseInlineMarkdown('- [bad](../secret) [bad](//evil.example)\n\n<a href="%6aavascript:evil" data-reader-ignore="true">bad</a>');
  expect(parsed.root.querySelector('a[href]')).toBeNull();
  expect(parsed.root.querySelector('[data-reader-ignore]')).toBeNull();
});

it('cannot forge source-mapped IDs by copying generated HTML back into Markdown', () => {
  const original = parseInlineMarkdown('==highlight== [[Note|word]]');
  const forged = parseInlineMarkdown(original.html);
  expect(forged.highlights).toHaveLength(0); expect(forged.links).toHaveLength(0);
  expect(forged.root.querySelector('[data-inline-highlight-id],[data-inline-link-id]')).toBeNull();
  expect(() => removeInlineHighlight(original.html, original.highlights[0].id)).toThrow(/changed/);
});

it('rejects invalid context and codepoint offsets without relocation', () => {
  const source = '😀 word word', parsed = parseInlineMarkdown(source);
  const anchor = { start: 7, end: 11, prefix: 'wrong', suffix: '', version: parsed.revision };
  expect(() => addInlineHighlight(source, { quote: 'word', anchor })).toThrow(/context/);
  expect(() => addInlineHighlight(source, { quote: 'word', anchor: { ...anchor, start: 8, end: 12, prefix: '' } })).toThrow(/selection/);
});

it('does not merge neighboring highlight delimiters or alter emphasis during removal', () => {
  const source = '==a== ==b==';
  expect(removeInlineHighlight(source, parseInlineMarkdown(source).highlights[0].id)).toBe('a ==b==');
  const formatted = '**==word==**';
  expect(removeInlineHighlight(formatted, parseInlineMarkdown(formatted).highlights[0].id)).toBe('**word**');
});

it('fails closed when the lexer omits duplicate definitions instead of mapping a later lookalike', () => {
  const source = '[ref]: https://one.example\n\n[ref]: https://two.example\n\n[ref]\n\n==marked==';
  const parsed = parseInlineMarkdown(source);
  expect(parsed.warnings.length).toBeGreaterThan(0);
  expect(parsed.hasUnsupportedHighlights).toBe(true);
  expect(() => addInlineHighlight(source, { quote: 'marked', revision: parsed.revision })).toThrow(/supported paragraph/);
});

it('accepts empty YAML frontmatter without including it in the canonical index', () => {
  const source = '---\n---\n\n# Title\n\nword';
  const parsed = parseInlineMarkdown(source, { stripTitle: 'Title' });
  expect(parsed.canonicalText).toBe('word');
});

it('renders unsupported embeds literally without mistaking them for editable links', () => {
  const source = 'A ![[Picture|caption]] B', parsed = parseInlineMarkdown(source);
  expect(parsed.links).toHaveLength(0);
  expect(parsed.canonicalText).toBe(source);
  expect(() => addInlineHighlight(source, { quote: source, revision: parsed.revision })).toThrow(/supported paragraph/);
});

it('rejects stale ordinary-link edits after even an unrelated source change', () => {
  const source = '[[Topic|word]]', id = parseInlineMarkdown(source).links[0].id;
  expect(() => setInlineLink(source + '\n', id, 'Other')).toThrow(/changed/);
  expect(() => removeInlineLink(source + '\n', id)).toThrow(/changed/);
});

it('removing authored wikilinks rejects labels whose bare syntax would change formatting', () => {
  const source = '[[Note|*word*]]', parsed = parseInlineMarkdown(source);
  expect(parsed.canonicalText).toBe('*word*');
  expect(() => removeInlineLink(source, parsed.links[0].id)).toThrow(/displayed text/);
});
