import { describe, expect, it } from 'vitest';
import { defaultHighlightTarget } from '../src/ui/default-highlight-target';
import { linkTarget } from '../src/storage/links';

describe('defaultHighlightTarget: primary Link decision (no picker or persistence)', () => {
  it.each([
    'Selected text', 'Chosen note', 'Two  spaces', 'A useful sentence',
    'café', 'Cafe\u0301', '日本語のノート', 'Reading 🙂', 'Research & development',
    "Reader's note", 'version 1.8', '100% complete', 'under_score',
  ])('returns the complete literal target for %j, allowing direct Link without a prompt', quote => {
    expect(defaultHighlightTarget(quote)).toEqual({ target: quote });
    expect(linkTarget(quote)).toBe(quote);
  });

  it.each([
    '', ' ', '\t', ' leading', 'trailing ', '\u00a0padded\u00a0',
    'first\nsecond', 'first\r\nsecond', 'first\rsecond',
    'first\u0085second', 'first\u2028second', 'first\u2029second',
    '[[Note]]', '[[Note|alias]]', 'Note|alias', '[label]', 'Note]]',
    'note/name', 'note\\name', 'Note#Heading', 'Note^block',
    'bad:name', 'bad*name', 'bad?name', 'bad"name', '<note>', '`note`',
    'bad\u0000name', 'bad\u0001name', 'bad\u007fname',
    '.', '..', '../Other', '/Absolute', '//host', 'Folder/%2e%2e/Other',
    '%2e%2e', '%2f', '%5c', 'trailing.', 'CON', 'nul.md', 'COM1', 'LPT9.txt',
    '\ud800', '\udfff', 'prefix\ud800suffix',
    'https://example.com/Selected%20text', 'HTTP://EXAMPLE.COM',
    'https://user:password@example.com/', 'javascript:alert(1)', 'ftp://example.com/',
    'data:text/plain,hello', 'file:///note', 'obsidian://open?vault=test',
  ])('requires an explicit chooser with a reason for %j, without a replacement target', quote => {
    const original = quote;
    const result = defaultHighlightTarget(quote);
    expect(result).toMatchObject({ needsChooser: true, reason: expect.any(String) });
    expect('target' in result).toBe(false);
    if ('reason' in result) expect(result.reason.length).toBeGreaterThan(15);
    expect(quote).toBe(original);
  });

  it('does not silently convert a selected URL, even when the explicit target validator allows it', () => {
    const quote = 'HTTPS://EXAMPLE.COM';
    expect(linkTarget(quote)).toBe('https://example.com/');
    expect(defaultHighlightTarget(quote)).toEqual({
      needsChooser: true,
      reason: expect.stringContaining('explicitly confirm an HTTP(S) link'),
    });
  });

  it('explains multiline and surrounding-whitespace fallback without collapsing either', () => {
    expect(defaultHighlightTarget('first\nsecond')).toMatchObject({ reason: expect.stringContaining('multiple lines') });
    expect(defaultHighlightTarget(' Selected text ')).toMatchObject({ reason: expect.stringContaining('without trimming') });
  });

  it('keeps a portable 252-byte name intact, reserving three bytes for .md', () => {
    const quote = 'a'.repeat(252);
    expect(defaultHighlightTarget(quote)).toEqual({ target: quote });
    expect(defaultHighlightTarget(quote + 'a')).toMatchObject({ needsChooser: true, reason: expect.stringContaining('too long') });
  });

  it.each([
    ['é', 126], ['語', 84], ['🙂', 63],
  ] as const)('counts UTF-8 bytes rather than truncating a long Unicode selection (%s)', (character, count) => {
    const quote = character.repeat(count);
    expect(defaultHighlightTarget(quote)).toEqual({ target: quote });
    expect(defaultHighlightTarget(quote + character)).toMatchObject({ needsChooser: true, reason: expect.stringContaining('too long') });
  });

  it('does not impose the existing note-creation sanitizer’s 90-character truncation', () => {
    const quote = 'a'.repeat(150);
    expect(defaultHighlightTarget(quote)).toEqual({ target: quote });
  });

  it('never selects a basename or alias from a path-like quote', () => {
    for (const quote of ['First/Chosen note', 'Second/Chosen note', 'Chosen note|Selected text']) {
      expect(defaultHighlightTarget(quote)).toMatchObject({ needsChooser: true });
      expect(defaultHighlightTarget(quote)).not.toHaveProperty('target');
    }
  });

  it('is deterministic and has no callback, vault, existing-link or note-creation dependency', () => {
    expect(defaultHighlightTarget('Unresolved note')).toEqual({ target: 'Unresolved note' });
    expect(defaultHighlightTarget('Unresolved note')).toEqual({ target: 'Unresolved note' });
    expect(defaultHighlightTarget('Unresolved\nnote')).not.toHaveProperty('target');
  });
});
