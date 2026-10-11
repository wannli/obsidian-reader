import { describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { buildCanonicalTextIndex } from '../src/highlights/text-index';
import { addInlineHighlight, addInlineLink, InlineMarkdownError, inlineRevision, parseInlineMarkdown,
  removeInlineHighlight, removeInlineLink, setInlineHighlightLink, setInlineLink } from '../src/inline';
import type { InlineParseOptions } from '../src/inline';

function selection(markdown: string, quote: string, occurrence = 0, options?: InlineParseOptions) {
  const parsed = parseInlineMarkdown(markdown, options);
  let offset = -1;
  for (let i = 0; i <= occurrence; i++) offset = parsed.canonicalText.indexOf(quote, offset + 1);
  expect(offset).toBeGreaterThanOrEqual(0);
  const start = Array.from(parsed.canonicalText.slice(0, offset)).length;
  return { quote, anchor: { start, end: start + Array.from(quote).length, prefix: '', suffix: '', version: parsed.revision } };
}
function mark(markdown: string, quote: string, occurrence = 0, options?: InlineParseOptions) {
  return addInlineHighlight(markdown, selection(markdown, quote, occurrence, options), options);
}
function expectError(fn: () => unknown, code: string) {
  try { fn(); throw new Error('Did not reject'); } catch (error) {
    expect(error).toBeInstanceOf(InlineMarkdownError); expect((error as InlineMarkdownError).code).toBe(code);
  }
}

describe('source-aware inline Markdown', () => {
  it('hashes a lossless representation of every original UTF-16 code unit with shared SHA-256', () => {
    for (const value of ['', 'a😀\ud800', 'a\ud801', 'a\r\nb']) {
      expect(inlineRevision(value)).toBe('inline-v1-' + createHash('sha256').update(JSON.stringify(value)).digest('hex'));
    }
    expect(inlineRevision('\ud800')).not.toBe(inlineRevision('\ud801'));
    expect(inlineRevision('\ud800')).not.toBe(inlineRevision('\ufffd'));
    expect(inlineRevision('\ud800')).not.toBe(inlineRevision('\\ud800'));
  });
  it('renders highlights, wiki and external/relative links without counting links as highlights', () => {
    const parsed = parseInlineMarkdown('A ==bright== [[Note|word]] [site](https://example.com) [local](folder/note.md).');
    expect(parsed.canonicalText).toBe('A bright word site local.');
    expect(parsed.highlights).toHaveLength(1); expect(parsed.links).toHaveLength(3);
    expect(parsed.root.querySelector('mark')?.textContent).toBe('bright');
    expect(parsed.root.querySelector('.internal-link')?.getAttribute('href')).toBe('Note');
    expect(parsed.highlights[0]).toMatchObject({ quote: 'bright' });
    expect(buildCanonicalTextIndex(parsed.root).text).toBe(parsed.canonicalText);
  });
  it('selects the second repeated phrase without changing the first or unrelated bytes', () => {
    const source = '---\r\ntitle: Test\r\ncustom: x\r\n---\r\n\r\nSame phrase. Same phrase.\r\n\r\nTail\r\n';
    const result = mark(source, 'Same phrase', 1);
    expect(result).toBe(source.replace('phrase. Same phrase.', 'phrase. ==Same phrase==.'));
    const parsed = parseInlineMarkdown(result);
    expect(removeInlineHighlight(result, parsed.highlights[0].id)).toBe(source);
  });
  it('requires a revision and refuses ambiguous quote-only matching', () => {
    const source = 'same same';
    expectError(() => addInlineHighlight(source, { quote: 'same' }), 'stale');
    expectError(() => addInlineHighlight(source, { quote: 'same', revision: inlineRevision(source) }), 'ambiguous');
    expect(addInlineHighlight('unique', { quote: 'unique', revision: inlineRevision('unique') })).toBe('==unique==');
  });
  it('rejects stale source even when the quote and range still match', () => {
    const source = 'same\n\nold';
    expectError(() => addInlineHighlight('same\n\nnew', selection(source, 'same')), 'stale');
    const marked = mark(source, 'same'), id = parseInlineMarkdown(marked).highlights[0].id;
    expectError(() => removeInlineHighlight(marked + '!', id), 'stale');
    expectError(() => setInlineHighlightLink(marked + '!', id, 'Note'), 'stale');
  });
  it.each([
    ['😀 a e\u0301 אבג', 'e\u0301', '😀 a ==e\u0301== אבג'],
    ['A &amp; B &amp; C', '& B', 'A ==&amp; B== &amp; C'],
    ['A \\*word\\* B', '*word*', 'A ==\\*word\\*== B'],
    ['A\u2003\u202fB', 'A B', '==A\u2003\u202fB=='],
    ['A &#x1f600; B', '😀', 'A ==&#x1f600;== B'],
    ['A **bold words** tail', 'bold words', 'A ==**bold words**== tail'],
    ['A **bold words** tail', 'words', 'A **bold ==words==** tail'],
    ['A **bold** tail', 'A bold', '==A **bold**== tail'],
    ['A *bold* tail', 'bold tail', 'A ==*bold* tail=='],
    ['## Heading **bold**\n', 'Heading bold', '## ==Heading **bold**==\n'],
  ])('preserves raw syntax in %s', (source, quote, expected) => {
    const result = mark(source, quote); expect(result).toBe(expected);
    expect(parseInlineMarkdown(result).canonicalText).toBe(parseInlineMarkdown(source).canonicalText);
    expect(removeInlineHighlight(result, parseInlineMarkdown(result).highlights[0].id)).toBe(source);
  });
  it('never splits a multi-codepoint entity', () => {
    const source = 'A &NotEqualTilde; B', parsed = parseInlineMarkdown(source);
    expect(parsed.canonicalText).toBe('A ≂̸ B');
    expectError(() => mark(source, '≂'), 'unsupported');
    expect(mark(source, '≂̸')).toBe('A ==&NotEqualTilde;== B');
  });
  it.each([
    ['A **bold words** tail', 'A bold'],
    ['one\n\ntwo', 'one two'],
    ['A `code` B', 'code'],
    ['A `code` B', 'A code B'],
    ['A $x$ B', 'A'],
    ['A <em>HTML</em> B', 'HTML'],
    ['```txt\ncode\n```', 'code'],
    ['- item', 'item'],
    ['A ![image](https://example.com/x.png) B', 'A B'],
  ])('rejects unsupported ranges visibly: %s', (source, quote) => {
    expectError(() => mark(source, quote), 'unsupported');
  });
  it('rejects overlapping highlights and links', () => {
    expectError(() => mark('A ==mark== B', 'mark'), 'overlap');
    expectError(() => mark('A [[Note|word]] B', 'word'), 'overlap');
    expectError(() => mark('A [word](https://example.com) B', 'A word'), 'overlap');
  });
  it('replaces highlights with ordinary links and never remembers highlight provenance', () => {
    const original = 'A bright word B', highlighted = mark(original, 'bright word');
    const linked = setInlineHighlightLink(highlighted, parseInlineMarkdown(highlighted).highlights[0].id, 'Topic');
    expect(linked).toBe('A [[Topic|bright word]] B');
    expect(parseInlineMarkdown(linked).highlights).toHaveLength(0);
    const changed = setInlineLink(linked, parseInlineMarkdown(linked).links[0].id, 'https://example.com/a(b)');
    expect(changed).toBe('A [bright word](<https://example.com/a(b)>) B');
    expect(removeInlineLink(changed, parseInlineMarkdown(changed).links[0].id)).toBe(original);
  });
  it('uses plain wikilinks for identical internal labels, formatting-preserving Markdown links otherwise', () => {
    expect(addInlineLink('Topic', selection('Topic', 'Topic'), 'Topic')).toBe('[[Topic]]');
    const source = 'A ==**bold** &amp; word== B';
    const linked = setInlineHighlightLink(source, parseInlineMarkdown(source).highlights[0].id, 'folder/Topic');
    expect(linked).toBe('A [**bold** &amp; word](folder/Topic) B');
    expect(removeInlineLink(linked, parseInlineMarkdown(linked).links[0].id)).toBe('A **bold** &amp; word B');
  });
  it.each(['javascript:alert(1)', 'data:text/html,evil', '//evil.test', '../secret', '%6aavascript:evil', 'foo%0abar', 'bad|alias'])('rejects unsafe target %s', target => {
    expectError(() => addInlineLink('word', selection('word', 'word'), target), 'unsafe-target');
  });
  it('sanitizes scripts, source-map spoofing attributes, and unsafe link protocols', () => {
    const parsed = parseInlineMarkdown('<p data-inline-highlight-id="fake" data-inline-link-id="fake" onclick="evil()">word<script>evil()</script></p>\n\n[bad](javascript:evil) [[javascript:evil|bad]]');
    expect(parsed.root.querySelector('[data-inline-highlight-id="fake"],[data-inline-link-id="fake"],script,[onclick],[href^="javascript:"]')).toBeNull();
    expect(parsed.highlights).toHaveLength(0);
    expectError(() => mark('<p data-inline-highlight-id="fake">word</p>', 'word'), 'unsupported');
  });
  it('optionally removes a matching leading H1 consistently without editing it', () => {
    const source = '# Same\n\nSame body\n', options = { stripTitle: 'Same' };
    expect(parseInlineMarkdown(source, options).canonicalText).toBe('Same body');
    expect(mark(source, 'Same', 0, options)).toBe('# Same\n\n==Same== body\n');
    expectError(() => addInlineHighlight(source, selection(source, 'Same', 0, options)), 'stale');
    expect(parseInlineMarkdown(source, { stripTitle: 'Other' }).canonicalText).toBe('Same Same body');
  });
  it('keeps reference links readable but refuses to edit their definitions implicitly', () => {
    const source = '[label][ref]\n\n[ref]: https://example.com';
    const parsed = parseInlineMarkdown(source);
    expect(parsed.canonicalText).toBe('label'); expect(parsed.links).toHaveLength(1);
    expectError(() => removeInlineLink(source, parsed.links[0].id), 'unsupported');
  });
});
