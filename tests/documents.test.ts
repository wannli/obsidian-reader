// @vitest-environment node
import { describe, expect, it } from 'vitest';
import {
  acquireBody,
  ChangedNote,
  createDocument,
  patchProperties,
  readDocument,
  replaceBody,
  savePosition,
} from '../src/core/document';
import { folderPath } from '../src/core/folders';
import {
  articleInfo,
  filename,
  filenameDay,
  monthCutoff,
  queueAt,
  timestamp,
  webUrl,
} from '../src/core/model';
import {
  addHighlight,
  changePassage,
  hasAnnotations,
  locateSelection,
  passages,
} from '../src/core/annotations';

const raw =
  '---\ntype: article\nurl: "https://example.com/one"\ncustom: retained # authored comment\n---\n\nRead this short passage.\n\n## Comments\n\nMy own words.\n';

describe('one authoritative Markdown document', () => {
  it('reads properties and leaves the complete body intact', () => {
    expect(readDocument(raw).body).toBe(
      '\nRead this short passage.\n\n## Comments\n\nMy own words.\n',
    );
    expect(readDocument(raw).properties.custom).toBe('retained');
  });
  it('patches a field without losing unknown properties, comments or body', () => {
    const next = patchProperties(raw, { topics: ['[[Topics/Research.md]]'] });
    expect(next).toContain('# authored comment');
    expect(readDocument(next).body).toBe(readDocument(raw).body);
    expect(readDocument(next).properties.custom).toBe('retained');
    expect(readDocument(next).properties.topics).toEqual(['[[Topics/Research.md]]']);
  });
  it('keeps comments attached to changed properties and surviving topic items', () => {
    const input =
      '---\ntype: article\nreading_position: old # my bookmark\ntopics:\n  - "[[One.md]]" # why one\n  - "[[Two.md]]" # why two\n---\nBody';
    const next = patchProperties(input, {
      reading_position: 'new',
      topics: ['[[Two.md]]', '[[Three.md]]'],
    });
    expect(next).toContain('# my bookmark');
    expect(next).toContain('# why two');
    expect(readDocument(next).properties.topics).toEqual(['[[Two.md]]', '[[Three.md]]']);
  });
  it('no-op mutations are byte-for-byte no-ops', () =>
    expect(patchProperties(raw, { type: 'article' })).toBe(raw));
  it('preserves CRLF and a BOM', () => {
    const input = '\uFEFF' + raw.replace(/\n/g, '\r\n');
    const next = patchProperties(input, { title: 'new' });
    expect(next.startsWith('\uFEFF---\r\n')).toBe(true);
    expect(readDocument(next).body).toBe(readDocument(input).body);
  });
  it.each(['plain note', '---\ntype: article\ntype: feed\n---\n', '---\n- article\n---\n'])(
    'refuses unsupported frontmatter',
    (input) => {
      expect(() => readDocument(input)).toThrow();
    },
  );
  it('refuses removing an anchor required by unknown data', () => {
    expect(() =>
      patchProperties('---\ntype: article\ntitle: &a Keep\ncustom: *a\n---\nBody', {
        title: 'New',
      }),
    ).toThrow();
  });
  it('only touches the requested body range', () => {
    const doc = readDocument(raw);
    const next = replaceBody(raw, doc.body, doc.body.replace('short', '==short=='));
    expect(next.slice(0, doc.headerEnd)).toBe(raw.slice(0, doc.headerEnd));
    expect(() => replaceBody(raw, 'stale', 'replacement')).toThrow(ChangedNote);
  });
  it('stores position without modifying the body and protects malformed position data', () => {
    const next = savePosition(raw, 'Read this short passage.');
    expect(readDocument(next).body).toBe(readDocument(raw).body);
    expect(readDocument(next).properties.reading_position).toBe('Read this short passage.');
    expect(() =>
      savePosition(patchProperties(raw, { reading_position: { old: 'unknown' } }), 'new'),
    ).toThrow();
  });
  it('fills an empty offline capture, preserving an explicit title', () => {
    const pending = createDocument({
      type: 'article',
      url: 'https://example.com',
      title: 'Mine',
      error: 'offline',
    });
    const result = acquireBody(pending, pending, 'Article text', 'Publisher');
    expect(readDocument(result).properties).toEqual({
      type: 'article',
      url: 'https://example.com',
      title: 'Mine',
    });
    expect(readDocument(result).body).toBe('\nArticle text\n');
  });
  it('does not strip unknown historical keys or replace deliberately empty titles', () => {
    const pending = createDocument({
      type: 'article',
      title: '',
      retryAfter: 'authored value',
      custom: true,
    });
    const next = readDocument(acquireBody(pending, pending, 'Text', 'Publisher title'));
    expect(next.properties).toMatchObject({
      title: '',
      retryAfter: 'authored value',
      custom: true,
    });
  });
  it('only replaces an exact independently proven excerpt', () => {
    expect(() => acquireBody(raw, raw, 'new text', 'Title')).toThrow(/protected/);
    expect(() => acquireBody(raw, raw, 'new text', 'Title', 'different')).toThrow(/protected/);
    expect(() =>
      acquireBody(raw, raw + 'typing', 'new text', 'Title', readDocument(raw).body),
    ).toThrow(ChangedNote);
    expect(
      readDocument(acquireBody(raw, raw, 'new text', 'Title', readDocument(raw).body)).body,
    ).toBe('\nnew text\n');
  });
});

describe('explicit identity, paths, dates and URLs', () => {
  it('never infers article identity from a URL or queue location', () => {
    expect(articleInfo('Reading/Inbox/file.md', { url: 'https://example.com' })).toBeUndefined();
    expect(
      articleInfo('Elsewhere/Article.md', { type: 'article', status: 'feed' })?.queue,
    ).toBeUndefined();
    expect(queueAt('Other/Reading/Inbox/file.md')).toBeUndefined();
  });
  it.each(['../private', '/absolute', 'A/../B', 'A//B', 'A\\B'])('rejects unsafe folders', (path) =>
    expect(() => folderPath(path)).toThrow(),
  );
  it('retains query semantics but removes fragments and normalizes hosts', () => {
    expect(webUrl('HTTPS://EXAMPLE.COM:443/a?q=1#fragment')).toBe('https://example.com/a?q=1');
    expect(() => webUrl('javascript:alert(1)')).toThrow();
    expect(() => webUrl('https://user:password@example.com')).toThrow();
  });
  it('rejects rolled dates and unknown values', () => {
    expect(timestamp('2026-02-30')).toBeUndefined();
    expect(timestamp('not a date')).toBeUndefined();
    expect(timestamp('2024-02-29')).toBe(Date.UTC(2024, 1, 29));
  });
  it.each([
    ['2026-03-31T12:00:00.000Z', '2026-02-28T12:00:00.000Z'],
    ['2024-03-31T12:00:00.000Z', '2024-02-29T12:00:00.000Z'],
    ['2026-01-01T00:00:00.000Z', '2025-12-01T00:00:00.000Z'],
  ])('uses clamped UTC calendar months, not 30-day arithmetic', (now, cutoff) => {
    expect(monthCutoff(new Date(now))).toBe(Date.parse(cutoff));
  });
  it.each(['😀'.repeat(140), '界'.repeat(200), 'é'.repeat(200)])(
    'keeps Unicode names inside portable byte limits',
    (title) => {
      const name = filename(title, new Date('2026-10-13T12:00:00Z'), '界'.repeat(100), true);
      expect(new TextEncoder().encode(name).length).toBeLessThanOrEqual(230);
      expect(name).toMatch(/^261013 .+ - .+\.md$/);
      expect(name).not.toContain('\ufffd');
    },
  );
  it('generates safe filenames and reads only a valid leading date', () => {
    expect(
      filename('A / title: with? brackets []', new Date('2026-10-13T12:00:00Z'), 'Feed', true),
    ).toBe('261013 Feed - A title with brackets.md');
    expect(filenameDay('Reading/Stream/260230 wrong.md')).toBeUndefined();
    expect(filenameDay('Reading/Stream/261013 Title.md')).toBe(Date.UTC(2026, 9, 13));
  });
});

describe('localized inline annotations', () => {
  it('highlights a distinct passage without rewriting surrounding text', () => {
    const body = 'Some small words are worth keeping.';
    const range = locateSelection(body, 'small words');
    expect(addHighlight(body, range.from, range.to)).toBe(
      'Some ==small words== are worth keeping.',
    );
  });
  it.each([
    [
      'Before **important words** after.',
      'important words after.',
      'Before ==**important words** after.==',
    ],
    [
      'Before **important words** after.',
      'Before important words',
      '==Before **important words**== after.',
    ],
    [
      'Bread &amp; butter, caf&eacute; and tea.',
      'Bread & butter, café',
      '==Bread &amp; butter, caf&eacute;== and tea.',
    ],
    ['A \\*literal star.', '*literal', 'A ==\\*literal== star.'],
  ])(
    'maps emphasis, entities and escapes without changing the visible words',
    (body, quote, expected) => {
      const range = locateSelection(body, quote);
      expect(addHighlight(body, range.from, range.to)).toBe(expected);
    },
  );
  it('rejects selections crossing only part of an emphasis span', () => {
    expect(() =>
      locateSelection('Before **important words** after.', 'Before important'),
    ).toThrow();
  });
  it('rejects ambiguous repeated quotations without usable context', () => {
    expect(() => locateSelection('same words here; same words there', 'same words')).toThrow(
      /safely/,
    );
    expect(
      locateSelection(
        'First same words here; second same words there',
        'same words',
        'second',
        'there',
      ).from,
    ).toBe(30);
  });
  it.each([
    '`literal text`',
    '```md\nliteral text\n```',
    '    literal text',
    '<!-- literal text -->',
    '[literal text](https://example.com)',
    '==literal text==',
  ])('does not edit code, comments, existing links or highlights', (body) => {
    expect(() => locateSelection(body, 'literal text')).toThrow();
  });
  it('links, changes, unlinks and removes a highlight without losing words', () => {
    let body = 'An ==important passage== remains.';
    body = changePassage(body, passages(body)[0], 'link', 'Nodes/Example.md');
    expect(body).toBe('An ==[[Nodes/Example.md|important passage]]== remains.');
    body = changePassage(body, passages(body)[0], 'link', 'Nodes/Other.md');
    expect(body).toContain('Nodes/Other.md');
    body = changePassage(body, passages(body)[0], 'unlink');
    expect(body).toBe('An ==important passage== remains.');
    expect(changePassage(body, passages(body)[0], 'remove')).toBe('An important passage remains.');
  });
  it.each(['**important words** after.', 'Bread &amp; butter', 'A \\*literal star'])(
    'keeps formatting and original source when linking and unlinking %s',
    (text) => {
      const body = `Before ==${text}== after.`;
      const linked = changePassage(body, passages(body)[0], 'link', 'Nodes/Some Note.md');
      expect(linked).toContain('](/Nodes/Some%20Note.md)');
      expect(passages(linked)[0]).toMatchObject({ text, target: 'Nodes/Some Note.md' });
      expect(changePassage(linked, passages(linked)[0], 'unlink')).toBe(body);
      expect(changePassage(linked, passages(linked)[0], 'remove')).toBe(`Before ${text} after.`);
    },
  );
  it('refuses nested links and treats authored local Markdown links as annotations', () => {
    const body = '[==highlight==](https://example.com)';
    expect(() => changePassage(body, passages(body)[0], 'link', 'Notes/Other.md')).toThrow(
      /another link/,
    );
    expect(hasAnnotations('[Note](/Notes/Local.md)', { topics: [] })).toBe(true);
    expect(
      hasAnnotations('[Web](https://example.com) and [section](#chapter)', { topics: [] }),
    ).toBe(false);
    expect(passages(String.raw`\==literal==`)).toEqual([]);
  });
  it('rejects stale annotation ranges', () => {
    const passage = passages('==old words==')[0];
    expect(() => changePassage('==new words==', passage, 'remove')).toThrow(ChangedNote);
  });
  it('does not confuse publisher web links with authored vault links', () => {
    expect(hasAnnotations('[Publisher](https://example.com)', { topics: [] })).toBe(false);
    expect(hasAnnotations('[[Topics/Research.md]]', { topics: [] })).toBe(true);
    expect(hasAnnotations('No body annotation', { topics: ['[[Topics/Research.md]]'] })).toBe(true);
    expect(hasAnnotations('`==example==`', { topics: [] })).toBe(false);
  });
});
