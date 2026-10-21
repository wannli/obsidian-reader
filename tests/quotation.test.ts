import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  appendQuotation,
  localCollectionDate,
  originLink,
  QuotationRemovalError,
  rememberOrigin,
  removeQuotation,
} from '../src/core/quotation';
import { readDocument } from '../src/core/document';

const header = '---\nfileClass: Concept\ncustom: untouched # preserve\n---\n';
const source = '[[Reading/Decision rules#^reader-k7m2|Decision rules]]';
const quote = 'Clear **rules** build [trust](https://example.com/report).';
const day = '2026-10-20';
const group = '### [[Reading/Decision rules|Decision rules]]';
const entry = `> ${quote} (※ ${source} [[${day}]])`;
beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date(2026, 9, 20, 12));
});
afterEach(() => vi.useRealTimers());

describe('ordinary quotation snapshots', () => {
  it('creates the agreed Highlights section without rewriting existing content', () => {
    const raw = `${header}\n# A concept\n\nUser-owned explanation.\n`;
    expect(appendQuotation(raw, quote, source)).toEqual({
      added: true,
      raw: `${raw}\n## Highlights\n\n${group}\n\n${entry}\n`,
    });
  });

  it.each(['', '\n', '\n\n', '\n\n\n'])(
    'separates an end with %j from the new section',
    (ending) => {
      const raw = `${header}Authored text${ending}`;
      const next = appendQuotation(raw, quote, source).raw;
      expect(next).toContain(`Authored text${ending || '\n\n'}`);
      expect(next).toContain(`\n\n## Highlights\n\n${group}\n\n${entry}\n`);
    },
  );

  it('appends to an existing section and preserves the next section', () => {
    const raw = `${header}\n## Highlights\n\n> An older excerpt.\n\n## Notes\n\nDo not touch me.\n`;
    const next = appendQuotation(raw, quote, source).raw;
    expect(next).toBe(
      `${header}\n## Highlights\n\n> An older excerpt.\n\n${group}\n\n${entry}\n\n## Notes\n\nDo not touch me.\n`,
    );
  });

  it('keeps new entries before an authored subsection rather than inside it', () => {
    const raw = `${header}\n## Highlights\n\n### My analysis\n\nAuthored.\n`;
    expect(appendQuotation(raw, quote, source).raw).toBe(
      `${header}\n## Highlights\n\n${group}\n\n${entry}\n\n### My analysis\n\nAuthored.\n`,
    );
  });

  it('accepts a parser-proven Setext Highlights heading', () => {
    const raw = `${header}\nHighlights\n----------\n\n## Notes\nKeep.\n`;
    expect(appendQuotation(raw, quote, source).raw).toContain(
      `Highlights\n----------\n\n${group}\n\n${entry}\n\n## Notes\nKeep.\n`,
    );
  });

  it('does not confuse a fenced heading or nested quote with the section', () => {
    const raw = `${header}\n\`\`\`md\n## Highlights\n\`\`\`\n\n> ## Highlights\n`;
    expect(appendQuotation(raw, quote, source).raw).toBe(
      `${raw}\n## Highlights\n\n${group}\n\n${entry}\n`,
    );
  });

  it('refuses ambiguous duplicate sections without choosing one silently', () => {
    const raw = `${header}\n## Highlights\n\nFirst.\n\n## Highlights\nSecond.\n`;
    expect(() => appendQuotation(raw, quote, source)).toThrow('more than one');
  });

  it('deduplicates an unchanged retry using both words and paragraph citation', () => {
    const first = appendQuotation(header, quote, source).raw;
    expect(appendQuotation(first, quote, source)).toEqual({ raw: first, added: false });
  });

  it('retains distinct quotations from the same paragraph', () => {
    const first = appendQuotation(header, quote, source).raw;
    const second = appendQuotation(first, 'Another selected sentence.', source);
    expect(second.added).toBe(true);
    expect(second.raw).toContain(entry);
    expect(second.raw).toContain(`> Another selected sentence. (※ ${source} [[${day}]])`);
  });

  it('retains the same words from a different source paragraph', () => {
    const first = appendQuotation(header, quote, source).raw;
    expect(appendQuotation(first, quote, source.replace('k7m2', 't9b3')).added).toBe(true);
  });

  it('does not deduplicate a code example that only looks like a quotation', () => {
    const raw = `${header}\n\`\`\`md\n${entry}\n\`\`\`\n`;
    expect(appendQuotation(raw, quote, source).added).toBe(true);
  });

  it('preserves CRLF bytes and does not add a second section on a retry', () => {
    const raw = `${header}\n## Highlights\n\n> Old.\n\n## Notes\nKeep.\n`.replace(/\n/gu, '\r\n');
    const next = appendQuotation(raw, quote, source).raw;
    expect(next).toContain(`${entry}\r\n\r\n## Notes\r\nKeep.\r\n`);
    expect(next.replace(/\r\n/gu, '')).not.toContain('\n');
    expect(appendQuotation(next, quote, source)).toEqual({ raw: next, added: false });
    expect(next.startsWith(header.replace(/\n/gu, '\r\n'))).toBe(true);
  });

  it('retains soft line breaks and quotes each source line', () => {
    expect(
      appendQuotation(header, 'First **line**\nsecond [line](https://example.com).', source).raw,
    ).toContain(`> First **line**\n> second [line](https://example.com). (※ ${source} [[${day}]])`);
  });

  it.each(['', '  \n'])('refuses an empty quotation %j', (text) => {
    expect(() => appendQuotation(header, text, source)).toThrow('no passage');
  });

  it('refuses an invalid target document or citation before producing a write', () => {
    expect(() => appendQuotation('No properties.', quote, source)).toThrow('frontmatter');
    expect(() => appendQuotation('---\na: [\n---\nText.', quote, source)).toThrow('frontmatter');
    expect(() => appendQuotation(header, quote, 'not a source link')).toThrow('source');
  });
});

describe('source-grouped dated quotations', () => {
  it('reuses one native source heading across paragraphs, titles and collection days', () => {
    const first = appendQuotation(header, quote, source).raw;
    const secondSource = source
      .replace('reader-k7m2', 'reader-t9b3')
      .replace('|Decision rules', '|New title');
    const second = appendQuotation(first, 'A second passage.', secondSource, {
      path: 'Reading/Decision rules.md',
      title: 'New title',
      collectedOn: '2026-10-21',
    }).raw;
    expect(second.match(/^### /gm)).toHaveLength(1);
    expect(second).toContain(group);
    expect(second).toContain(entry);
    expect(second).toContain(`> A second passage. (※ ${secondSource} [[2026-10-21]])`);
    expect(appendQuotation(second, quote, source, { collectedOn: '2026-10-22' })).toEqual({
      raw: second,
      added: false,
    });
  });

  it('never conflates two distinct source paths sharing the same displayed title', () => {
    const other = source.replace('Reading/Decision rules#', 'Archive/Decision rules#');
    const first = appendQuotation(header, quote, source).raw;
    const second = appendQuotation(first, quote, other).raw;
    expect(second).toContain(group);
    expect(second).toContain('### [[Archive/Decision rules|Decision rules]]');
    expect(second.match(/^### /gm)).toHaveLength(2);
    expect(second).toContain(`(※ ${other} [[${day}]])`);
  });

  it('appends inside the matching source group without changing another group or authored section', () => {
    const older = `> Earlier. (※ ${source})`;
    const other =
      '### [[Reading/Other|Other]]\n\n> Other quote.\n\n### Authored analysis\n\nKeep.\n\n## Notes\n\nUntouched.\n';
    const raw = `${header}\n## Highlights\n\n${group}\n\n${older}\n\n${other}`;
    expect(appendQuotation(raw, quote, source).raw).toBe(
      raw.replace(`${older}\n\n`, `${older}\n\n${entry}\n\n`),
    );
  });

  it('preserves legacy flat quotations rather than migrating them into the new source group', () => {
    const legacy = `> Older passage. (※ ${source})`;
    const raw = `${header}\n## Highlights\n\n${legacy}\n\n### Authored analysis\n\nKeep.\n`;
    const next = appendQuotation(raw, quote, source).raw;
    expect(next).toBe(
      raw.replace('### Authored analysis', `${group}\n\n${entry}\n\n### Authored analysis`),
    );
    expect(next).toContain(legacy);
  });

  it('declines duplicate matching source headings, even for an already filed retry', () => {
    const raw = `${header}\n## Highlights\n\n${group}\n\n${entry}\n\n### [[Reading/Decision rules.md|Another label]]\n\nKeep.\n`;
    expect(() => appendQuotation(raw, quote, source)).toThrow(
      'more than one matching source heading',
    );
  });

  it('does not reuse a same-source heading outside Highlights', () => {
    const raw = `${header}\n## Notes\n\n${group}\n\nAuthored.\n`;
    const next = appendQuotation(raw, quote, source).raw;
    expect(next.startsWith(raw)).toBe(true);
    expect(next).toContain(`## Highlights\n\n${group}\n\n${entry}`);
  });

  it('keeps an unchanged legacy undated retry byte-identical without adding a heading or date', () => {
    const raw = `${header}\n## Highlights\n\n> ${quote} (※ ${source})\n`;
    expect(appendQuotation(raw, quote, source, { collectedOn: '2026-10-21' })).toEqual({
      raw,
      added: false,
    });
  });

  it('preserves the original date on an unchanged retry on a later day', () => {
    const first = appendQuotation(header, quote, source).raw;
    vi.setSystemTime(new Date(2026, 9, 21, 12));
    expect(appendQuotation(first, quote, source)).toEqual({ raw: first, added: false });
    expect(first).toContain('[[2026-10-20]]');
    expect(first).not.toContain('[[2026-10-21]]');
  });

  it.each(['2026-02-30', '2026-13-01', '2026-2-03', 'not a date'])(
    'rejects an invalid calendar date %s before producing an append',
    (collectedOn) => {
      expect(() => appendQuotation(header, quote, source, { collectedOn })).toThrow(
        'Invalid local collection date',
      );
    },
  );

  it('uses local calendar fields instead of the UTC date at a timezone boundary', () => {
    const date = new Date('2026-10-21T02:30:00.000Z');
    vi.spyOn(date, 'getFullYear').mockReturnValue(2026);
    vi.spyOn(date, 'getMonth').mockReturnValue(9);
    vi.spyOn(date, 'getDate').mockReturnValue(20);
    expect(date.toISOString().slice(0, 10)).toBe('2026-10-21');
    expect(localCollectionDate(date)).toBe('2026-10-20');
  });

  it('changes the local collection day at local midnight and validates invalid clocks', () => {
    const before = new Date(2026, 9, 20, 23, 59, 59, 999);
    expect(localCollectionDate(before)).toBe('2026-10-20');
    expect(localCollectionDate(new Date(before.getTime() + 1))).toBe('2026-10-21');
    expect(() => localCollectionDate(new Date(NaN))).toThrow('Invalid local collection date');
  });
});

describe('explicit exact quotation removal', () => {
  it.each([undefined, '2026-10-20', '2026-10-21'])(
    'removes one exact legacy/dated snapshot (%s), never headings, origin or other content',
    (date) => {
      const target = header.replace('custom:', `origin: "[[Original#^paragraph]]"\ncustom:`);
      const exact = `> ${quote} (※ ${source}${date ? ` [[${date}]]` : ''})`;
      const raw = `${target}\n## Highlights\n\n${group}\n\n${exact}\n\n## Notes\n\nAuthored.\n`;
      expect(removeQuotation(raw, quote, source)).toEqual({
        raw: raw.replace(exact, ''),
        removed: true,
      });
      expect(readDocument(removeQuotation(raw, quote, source).raw).properties.origin).toBe(
        '[[Original#^paragraph]]',
      );
    },
  );

  it('preserves distinct snapshots from the same paragraph and the same words from another paragraph', () => {
    const first = appendQuotation(header, quote, source).raw;
    const second = appendQuotation(first, 'Another passage.', source).raw;
    const otherSource = source.replace('k7m2', 't9b3');
    const all = appendQuotation(second, quote, otherSource).raw;
    const removed = removeQuotation(all, quote, source).raw;
    expect(removed).toBe(all.replace(entry, ''));
    expect(removed).toContain(`> Another passage. (※ ${source} [[${day}]])`);
    expect(removed).toContain(`> ${quote} (※ ${otherSource} [[${day}]])`);
  });

  it.each(['\n', '\r\n'])(
    'removes a multiline snapshot without changing %j bytes outside its exact range',
    (newline) => {
      const multiline = 'First **paragraph**.\n\nSecond [line](https://example.com).';
      const raw = appendQuotation(
        `${header}\nAuthored.\n`.replace(/\n/gu, newline),
        multiline,
        source,
      ).raw;
      const exact =
        `> First **paragraph**.\n>\n> Second [line](https://example.com). (※ ${source} [[${day}]])`.replace(
          /\n/gu,
          newline,
        );
      expect(removeQuotation(raw, multiline, source).raw).toBe(raw.replace(exact, ''));
    },
  );

  it.each([
    { title: 'edited words', value: entry.replace('Clear', 'Changed') },
    { title: 'edited formatting', value: entry.replace('**rules**', 'rules') },
    { title: 'changed paragraph', value: entry.replace('k7m2', 't9b3') },
    { title: 'changed citation alias', value: entry.replace('|Decision rules', '|A new title') },
    { title: 'extra authored suffix', value: entry + ' Keep this extra text.' },
    { title: 'changed quote indentation', value: ' ' + entry },
    { title: 'invalid stored date', value: entry.replace('2026-10-20', '2026-02-30') },
    { title: 'a fenced example', value: '```md\n' + entry + '\n```' },
    { title: 'a nested example', value: '> ' + entry },
  ])('declines $title instead of deleting authored content', ({ value }) => {
    const raw = `${header}\n## Highlights\n\n${group}\n\n${value}\n`;
    try {
      removeQuotation(raw, quote, source);
      throw new Error('Expected conservative removal to fail.');
    } catch (error) {
      expect(error).toBeInstanceOf(QuotationRemovalError);
      expect((error as QuotationRemovalError).reason).toBe('missing');
      expect((error as Error).message).toMatch(/missing or was edited/);
    }
  });

  it('declines duplicate dated/undated exact snapshots rather than selecting one', () => {
    const raw = `${header}\n## Highlights\n\n${group}\n\n${entry}\n\n> ${quote} (※ ${source})\n`;
    expect(() => removeQuotation(raw, quote, source)).toThrow(QuotationRemovalError);
    try {
      removeQuotation(raw, quote, source);
    } catch (error) {
      expect((error as QuotationRemovalError).reason).toBe('ambiguous');
    }
  });
});

describe('native comments never authorize quotation writes', () => {
  it.each(['\n', '\r\n'])(
    'never removes an exact dated or legacy quotation inside an Obsidian comment (%j)',
    (newline) => {
      for (const exact of [entry, `> ${quote} (※ ${source})`]) {
        const commented = `%%\n\n${exact}\n\n%%\n`.replace(/\n/gu, newline);
        const raw = header.replace(/\n/gu, newline) + newline + commented;
        expect(() => removeQuotation(raw, quote, source)).toThrow(QuotationRemovalError);
        try {
          removeQuotation(raw, quote, source);
        } catch (error) {
          expect((error as QuotationRemovalError).reason).toBe('missing');
        }
        expect(raw).toBe(header.replace(/\n/gu, newline) + newline + commented);
      }
    },
  );

  it.each(['\n', '\r\n'])(
    'removes only the active exact match, not its commented example (%j)',
    (newline) => {
      const commented = `%%\n\n${entry}\n\n%%\n`.replace(/\n/gu, newline);
      const exact = entry.replace(/\n/gu, newline);
      const raw =
        header.replace(/\n/gu, newline) +
        newline +
        commented +
        newline +
        group +
        newline +
        newline +
        exact +
        newline;
      const at = raw.lastIndexOf(exact);
      const removed = removeQuotation(raw, quote, source);
      expect(removed).toEqual({
        raw: raw.slice(0, at) + raw.slice(at + exact.length),
        removed: true,
      });
      expect(removed.raw).toContain(commented);
    },
  );

  it.each(['\n', '\r\n'])(
    'does not deduplicate against commented evidence or reuse its hidden section/group (%j)',
    (newline) => {
      const commented =
        `%%\n\n## Highlights\n\n${group}\n\n${entry}\n\n## Highlights\n\n${group}\n\n%%\n`.replace(
          /\n/gu,
          newline,
        );
      const raw = header.replace(/\n/gu, newline) + newline + commented;
      const appended = appendQuotation(raw, quote, source);
      expect(appended).toEqual({
        added: true,
        raw: raw + newline + `## Highlights\n\n${group}\n\n${entry}\n`.replace(/\n/gu, newline),
      });
      expect(appendQuotation(appended.raw, quote, source)).toEqual({
        raw: appended.raw,
        added: false,
      });
      expect(removeQuotation(appended.raw, quote, source).raw).toContain(commented);
    },
  );

  it.each(['\n', '\r\n'])(
    'ignores commented duplicate source headings while appending to the active source group (%j)',
    (newline) => {
      const commented = `%%\n\n${group}\n\n${entry}\n\n%%\n`;
      const older = `> Earlier active words. (※ ${source})`;
      const raw =
        `${header}\n## Highlights\n\n${commented}\n${group}\n\n${older}\n\n## Notes\n\nAuthored.\n`.replace(
          /\n/gu,
          newline,
        );
      const appended = appendQuotation(raw, quote, source);
      expect(appended).toEqual({
        added: true,
        raw: raw.replace(
          `${older}\n\n`.replace(/\n/gu, newline),
          `${older}\n\n${entry}\n\n`.replace(/\n/gu, newline),
        ),
      });
      expect(appended.raw).toContain(commented.replace(/\n/gu, newline));
    },
  );

  it.each(['\n', '\r\n'])(
    'does not classify literal comment delimiters in fenced/inline code as native comments (%j)',
    (newline) => {
      for (const literal of ['```md\n%%\n```', 'An inline `%%` example.']) {
        const raw = `${header}\n${literal}\n\n## Highlights\n\n${group}\n\n${entry}\n`.replace(
          /\n/gu,
          newline,
        );
        expect(appendQuotation(raw, quote, source)).toEqual({ raw, added: false });
        expect(removeQuotation(raw, quote, source).raw).toBe(
          raw.replace(entry.replace(/\n/gu, newline), ''),
        );
      }
    },
  );

  it.each(['\n', '\r\n'])(
    'does not append hidden quotation authority into an unterminated native comment (%j)',
    (newline) => {
      const raw = `${header}\n%%\n\n## Highlights\n\n${group}\n`.replace(/\n/gu, newline);
      expect(() => appendQuotation(raw, quote, source)).toThrow(/unclosed.*comment/i);
    },
  );
});

describe('node creation origin', () => {
  it('uses a native paragraph wikilink without a hidden excerpt identity', () => {
    expect(originLink('Reading/Decision rules.md', 'reader-k7m2')).toBe(
      '[[Reading/Decision rules#^reader-k7m2]]',
    );
    expect(originLink('Reading/Decision rules.md', 'reader-k7m2', 'Decision rules')).toBe(source);
  });

  it.each(['Bad|path.md', 'Bad#path.md', 'Bad[path.md', 'Bad\npath.md'])(
    'rejects unrepresentable source %j',
    (path) => {
      expect(() => originLink(path, 'reader-k7m2')).toThrow('safely');
    },
  );

  it('sets origin without altering body, unknown properties or comments', () => {
    const raw = `${header}\nAuthored **body**.\n`;
    const next = rememberOrigin(raw, originLink('Reading/Decision rules.md', 'reader-k7m2'));
    expect(readDocument(next).properties.origin).toBe('[[Reading/Decision rules#^reader-k7m2]]');
    expect(readDocument(next).body).toBe(readDocument(raw).body);
    expect(next).toContain('custom: untouched # preserve');
    expect(next).not.toContain('created-by');
  });

  it.each(['null', '""', '"[[An earlier source]]"', '["[[One]]", "[[Two]]"]'])(
    'never overwrites an existing origin: %s',
    (value) => {
      const raw = header.replace('custom:', `origin: ${value}\ncustom:`);
      expect(rememberOrigin(raw, '[[Different#^paragraph]]')).toBe(raw);
    },
  );
});
