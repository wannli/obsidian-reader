import { describe, expect, it } from 'vitest';
import { thinkingSelectionOffsets } from '../src/reader/thinking-selection';

describe('Reader thinking selection source authority', () => {
  it('maps rich source text instead of saving rendered text as a source range', () => {
    const body = '前文 **kept** [link](https://example.org) and `code` 後文.';
    const range = thinkingSelectionOffsets(body, {
      quote: 'kept link and code',
      before: '前文 ',
      after: ' 後文.',
    });
    expect(body.slice(range.from, range.to)).toBe(
      '**kept** [link](https://example.org) and `code`',
    );
  });
  it('includes the complete parser-proven nested inline code span', () => {
    const body = '**before `code` after**';
    const range = thinkingSelectionOffsets(body, {
      quote: 'code',
      before: 'before ',
      after: ' after',
    });
    expect(body.slice(range.from, range.to)).toBe('`code`');
  });
  it('rejects partial inline code instead of expanding the user selection', () => {
    expect(() =>
      thinkingSelectionOffsets('before `code` after', {
        quote: 'cod',
        before: 'before ',
        after: 'e after',
      }),
    ).toThrow(/complete inline code/);
  });
  it('rejects indistinguishable occurrences instead of choosing the first', () => {
    expect(() =>
      thinkingSelectionOffsets('Same words.\n\nSame words.', {
        quote: 'Same words.',
        before: '',
        after: '',
      }),
    ).toThrow(/ambiguous/i);
  });
});
