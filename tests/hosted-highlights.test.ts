import { describe, expect, it } from 'vitest';
import {
  addHighlight,
  changePassage,
  locateSelection,
  passageFragments,
  passages,
  importedMarkdown,
} from '../src/core/annotations';
import {
  convertPassage,
  hostPassage,
  hostSelection,
  paragraphAnchors,
  paragraphPassages,
  passageHosts,
  passageQuote,
  replacePassageHosts,
} from '../src/core/hosted-highlights';
import { inlineProjection, selectionPlan } from '../src/core/projection';

const host = 'Concepts/Trust.md';
const withoutAnchor = (body: string) => body.replace(/ \^[a-zA-Z0-9-]+(?=\s*$)/, '');

describe('native hosted highlights', () => {
  it('keeps an ordinary mark, native hosts and one shared paragraph anchor', () => {
    const original = 'Clear rules build trust.';
    const saved = hostSelection(original, { quote: 'rules build trust' }, [host]);
    expect(saved.body).toBe(
      `Clear ==rules build trust== (※ [[Concepts/Trust]]). ^${saved.blockId}`,
    );
    expect(saved.blockId).toMatch(/^reader-[a-zA-Z0-9-]+$/);
    expect(saved.quoteMarkdown).toBe('rules build trust');
    expect(passageHosts(saved.body, saved.passage)).toEqual(['Concepts/Trust']);
    expect(paragraphPassages(saved.body, saved.blockId)).toEqual([saved.passage]);
    expect(withoutAnchor(changePassage(saved.body, saved.passage, 'remove'))).toBe(original);
  });

  it.each(['Before important', 'words after.'])(
    'splits crossing partial emphasis without changing original source tokens: %s',
    (quote) => {
      const original = 'Before **important words** after.';
      const saved = hostSelection(original, { quote }, [host]);
      expect(passageFragments(saved.passage)).toHaveLength(2);
      expect(inlineProjection(saved.quoteMarkdown).text).toBe(quote);
      expect(saved.quoteMarkdown).toContain('**');
      expect(withoutAnchor(changePassage(saved.body, saved.passage, 'remove'))).toBe(original);
      expect(passages(saved.body)).toHaveLength(1);
    },
  );

  it('keeps inter-container whitespace without emitting an unsupported whitespace-only mark', () => {
    const original = '**alpha beta** *gamma delta*';
    const saved = hostSelection(original, { quote: 'beta gamma' }, [host]);
    expect(saved.body).toContain('**alpha ==beta==** *==gamma==');
    expect(saved.body).not.toContain('== ==');
    expect(saved.quoteMarkdown).toBe('**beta** *gamma*');
    expect(passageFragments(saved.passage)).toHaveLength(2);
    expect(withoutAnchor(changePassage(saved.body, saved.passage, 'remove'))).toBe(original);
  });

  it('keeps a partial publisher label and its title intact with the host outside the URL', () => {
    const original = 'See [publisher link here](https://example.test/path "Article") now.';
    const saved = hostSelection(original, { quote: 'link' }, [host]);
    expect(saved.body).toContain(
      '[publisher ==link== here](https://example.test/path "Article") (※ [[Concepts/Trust]]) now.',
    );
    expect(saved.quoteMarkdown).toBe('[link](https://example.test/path "Article")');
    expect(withoutAnchor(changePassage(saved.body, saved.passage, 'remove'))).toBe(original);
  });

  it('quotes a complete URL-containing range as self-contained Markdown', () => {
    const original = 'First [publisher words](https://example.test) after.';
    const saved = hostSelection(original, { quote: 'First publisher words after.' }, [host]);
    expect(saved.body).toContain(`==${original}== (※ [[Concepts/Trust]])`);
    expect(saved.quoteMarkdown).toBe(original);
    expect(passageFragments(saved.passage)).toHaveLength(1);
  });

  it('groups a partial URL label and following prose without changing its link', () => {
    const original = 'See [publisher link here](https://example.test) now.';
    const saved = hostSelection(original, { quote: 'link here now.' }, [host]);
    expect(passageFragments(saved.passage)).toHaveLength(2);
    expect(saved.quoteMarkdown).toBe('[link here](https://example.test) now.');
    expect(withoutAnchor(changePassage(saved.body, saved.passage, 'remove'))).toBe(original);
  });

  it.each([
    ['the', 'report'],
    ['report', 'the'],
  ])(
    'preserves separate source-ordered hosts inside one publisher link: %s then %s',
    (firstQuote, secondQuote) => {
      const original = 'Read [the clear report](https://example.test/report) today. ^shared';
      const first = hostSelection(original, { quote: firstQuote }, ['Hosts/First']);
      const second = hostSelection(first.body, { quote: secondQuote }, ['Hosts/Second']);
      const actual = passages(second.body);
      expect(actual).toHaveLength(2);
      const firstPassage = actual.find((item) => item.text === firstQuote)!;
      const secondPassage = actual.find((item) => item.text === secondQuote)!;
      expect(passageHosts(second.body, firstPassage)).toEqual(['Hosts/First']);
      expect(passageHosts(second.body, secondPassage)).toEqual(['Hosts/Second']);
      const removed = changePassage(second.body, firstPassage, 'remove');
      expect(passageHosts(removed, passages(removed)[0])).toEqual(['Hosts/Second']);
      expect(() => convertPassage(second.body, firstPassage, 'Nodes/Mention')).toThrow(
        /publisher link/i,
      );
      expect(passageHosts(second.body, firstPassage)).toEqual(['Hosts/First']);
      expect(passageHosts(second.body, secondPassage)).toEqual(['Hosts/Second']);
    },
  );

  it('does not guess mismatched citations after a native publisher-label edit', () => {
    const body = '[==one== and ==two==](https://example.test) (※ [[Hosts/One]])';
    const actual = passages(body);
    expect(actual.every((item) => !item.citation)).toBe(true);
    expect(() => hostPassage(body, actual[0], ['Hosts/Other'])).toThrow(/ambiguous/i);
    expect(() => hostSelection(body, { quote: 'and' }, ['Hosts/Other'])).toThrow();
  });

  it('expands reference destinations only in the independent quotation', () => {
    const original =
      'Read [publisher words][article].\n\n[article]: https://example.test "A title"\n';
    const saved = hostSelection(original, { quote: 'publisher' }, [host]);
    expect(saved.body).toContain('[==publisher== words][article] (※ [[Concepts/Trust]])');
    expect(saved.body).toContain('[article]: https://example.test "A title"');
    expect(saved.quoteMarkdown).toBe('[publisher](https://example.test "A title")');
  });

  it('reuses an authored paragraph anchor for several highlights and does not touch other paragraphs', () => {
    const original = 'Alpha first words and second words. ^authored\n\nUnrelated **bytes**.\n';
    const first = hostSelection(original, { quote: 'first words' }, [host]);
    const second = hostSelection(first.body, { quote: 'second words' }, ['Concepts/Other.md']);
    expect(first.blockId).toBe('authored');
    expect(second.blockId).toBe('authored');
    expect(paragraphAnchors(second.body)).toHaveLength(1);
    expect(paragraphPassages(second.body, 'authored')).toHaveLength(2);
    expect(second.body.endsWith('\n\nUnrelated **bytes**.\n')).toBe(true);
    expect(passageQuote(second.body, passages(second.body)[0])).toBe('first words');
  });

  it('requires distinct quote context and keeps repeated text bound to its selected paragraph', () => {
    const original = 'Alpha same words omega.\n\nBeta same words delta.';
    expect(() => hostSelection(original, { quote: 'same words' }, [host])).toThrow();
    const saved = hostSelection(
      original,
      { quote: 'same words', before: 'Beta ', after: ' delta.' },
      [host],
    );
    expect(saved.body).toMatch(/^Alpha same words omega\.\n\nBeta ==same words==/);
  });

  it('adds/deduplicates hosts and supports changing/removing the native citation', () => {
    const first = hostSelection('Useful words remain.', { quote: 'Useful words' }, [host, host]);
    const second = hostPassage(first.body, first.passage, ['Concepts/Trust', 'Concepts/Other.md']);
    expect(passageHosts(second.body, second.passage)).toEqual(['Concepts/Trust', 'Concepts/Other']);
    expect(second.body.match(/\(※/g)).toHaveLength(1);
    const changed = changePassage(second.body, second.passage, 'link', 'Concepts/New.md');
    expect(passageHosts(changed, passages(changed)[0])).toEqual(['Concepts/New']);
    const unlinked = changePassage(changed, passages(changed)[0], 'unlink');
    expect(unlinked).toContain('==Useful words== remain.');
    expect(unlinked).not.toContain('※');
    expect(paragraphAnchors(unlinked)[0].blockId).toBe(first.blockId);
  });

  it('preserves authored host aliases/spelling when adding a destination and rejects stale citations', () => {
    const body = '==Useful words== (※ [[Concepts/Trust.md|My alias]]) remain. ^authored';
    const passage = passages(body)[0];
    expect(hostPassage(body, passage, [host]).body).toBe(body);
    const saved = hostPassage(body, passage, ['Concepts/Other']);
    expect(saved.body).toContain('(※ [[Concepts/Trust.md|My alias]], [[Concepts/Other]])');
    expect(() => changePassage(body.replace('My alias', 'New alias'), passage, 'remove')).toThrow();
    expect(() => hostPassage(body.replace('My alias', 'New alias'), passage, [host])).toThrow();
  });

  it.each(['> first\r\n> second', '> - first\n>   second'])(
    'quotes nested/wrapped paragraphs without copying their container syntax: %s',
    (body) => {
      const saved = hostSelection(body, { quote: 'first second' }, [host]);
      expect(saved.quoteMarkdown).toBe('first\nsecond');
      expect(withoutAnchor(changePassage(saved.body, saved.passage, 'remove'))).toBe(body);
      expect(paragraphPassages(saved.body, saved.blockId)).toHaveLength(1);
    },
  );

  it('converts a fragmented hosted range to a separate native node reference without dropping words', () => {
    const original = 'Before **important words** after.';
    const saved = hostSelection(original, { quote: 'Before important' }, [host, 'Concepts/Other']);
    const converted = convertPassage(saved.body, saved.passage, 'Nodes/Meaning.md');
    expect(converted.blockId).toBe(saved.blockId);
    expect(converted.body).not.toContain('==');
    expect(converted.body).not.toContain('Concepts/');
    expect(converted.body).toContain(
      '[[Nodes/Meaning|Before ]]**[[Nodes/Meaning|important]] words** after.',
    );
    expect(converted.body).not.toContain('※');
    expect(inlineProjection(withoutAnchor(converted.body)).text).toBe(
      inlineProjection(original).text,
    );
  });

  it('refuses destructive publisher-link conversion and preserves the hosted excerpt', () => {
    const original = 'See [publisher link here](https://example.test) now.';
    const saved = hostSelection(original, { quote: 'link' }, [host]);
    expect(() => convertPassage(saved.body, saved.passage, 'Nodes/Meaning')).toThrow(
      /publisher link.*excerpt/i,
    );
    expect(saved.body).toContain('[publisher ==link== here](https://example.test)');
    expect(passageHosts(saved.body, saved.passage)).toEqual(['Concepts/Trust']);
    expect(saved.quoteMarkdown).toBe('[link](https://example.test)');
  });

  it.each(['[publisher words]', '[publisher words][]'])(
    'retains the original reference key for partial implicit labels: %s',
    (reference) => {
      const original = `${reference}\n\n[publisher words]: https://example.test`;
      const saved = hostSelection(original, { quote: 'publisher' }, [host]);
      expect(saved.body).toContain('[==publisher== words][publisher words]');
      expect(saved.quoteMarkdown).toBe('[publisher](https://example.test)');
      expect(saved.body).toContain('[publisher words]: https://example.test');
    },
  );

  it('converts a plain or legacy linked highlight into only an ordinary wikilink', () => {
    for (const body of [
      'An ==important passage== remains.',
      'An ==[[Old|important passage]]== remains.',
    ]) {
      const converted = convertPassage(body, passages(body)[0], 'Nodes/New');
      expect(withoutAnchor(converted.body)).toBe('An [[Nodes/New|important passage]] remains.');
      expect(converted.body).not.toContain('※');
      expect(converted.body).not.toContain('==');
    }
  });

  it.each(['https://example.test/path', 'example.test/path', 'path'])(
    'keeps a publisher autolink usable for an exact partial label: %s',
    (quote) => {
      const original = 'Read https://example.test/path now.';
      const saved = hostSelection(original, { quote }, [host]);
      expect(saved.quoteMarkdown).toBe(`[${quote}](https://example.test/path)`);
      expect(saved.body).toContain('https://example.test/path');
      expect(passageHosts(saved.body, saved.passage)).toEqual(['Concepts/Trust']);
    },
  );

  it.each(['https://example.test/path', 'example.test/path', 'path'])(
    'keeps exact angle-autolink selections linked to their publisher: %s',
    (quote) => {
      const original = 'Read <https://example.test/path> now.';
      const saved = hostSelection(original, { quote }, [host]);
      expect(saved.quoteMarkdown).toBe(`[${quote}](https://example.test/path)`);
      expect(saved.body).toContain('https://example.test/path');
      if (quote.startsWith('https:'))
        expect(saved.body).toContain('==<https://example.test/path>==');
    },
  );

  it('retains code/comment literals and unrelated authored citations', () => {
    const original =
      'Useful words (※ [[Authored]]).\n\n`(※ [[Code]]) ^code`\n\n%%hidden\n\n(※ [[Comment]]) ^comment\n%%';
    const saved = hostSelection(original, { quote: 'Useful' }, [host]);
    expect(saved.body).toContain('(※ [[Authored]])');
    expect(saved.body).toContain('`(※ [[Code]]) ^code`');
    expect(paragraphAnchors(saved.body).map((anchor) => anchor.blockId)).toEqual([saved.blockId]);
    expect(passages(saved.body)[0].hosts).toEqual(['Concepts/Trust']);
  });

  it('supports old no-host and wrapped-target passages without a migration', () => {
    const range = locateSelection('Old meaningful words.', 'meaningful words');
    const plain = addHighlight('Old meaningful words.', range.from, range.to);
    expect(passageHosts(plain, passages(plain)[0])).toEqual([]);
    const wrapped = 'Old ==[[Nodes/Old.md|meaningful words]]==.';
    expect(changePassage(wrapped, passages(wrapped)[0], 'link', 'Nodes/New.md')).toBe(
      'Old ==[[Nodes/New.md|meaningful words]]==.',
    );
    expect(changePassage(wrapped, passages(wrapped)[0], 'remove')).toBe('Old meaningful words.');
  });

  it('fails closed for missing hosts, stale passage references and duplicate native paragraph IDs', () => {
    expect(() => hostSelection('Useful words.', { quote: 'Useful' }, [])).toThrow(/host/i);
    const saved = hostSelection('Useful words.', { quote: 'Useful' }, [host]);
    expect(() =>
      hostPassage(saved.body.replace('Useful', 'Changed'), saved.passage, [host]),
    ).toThrow();
    expect(() =>
      hostSelection('Useful words. ^same\n\nOther words. ^same', { quote: 'Useful' }, [host]),
    ).toThrow(/duplicat/i);
    expect(() => paragraphPassages('==one== ^same\n\n==two== ^same', 'same')).toThrow(/ambigu/i);
  });

  it('does not promote publisher-authored citation-looking text into native links', () => {
    expect(importedMarkdown('Publisher (※ [[Not a host]]) and ==literal==.')).toBe(
      'Publisher (※ \\[\\[Not a host]]) and \\=\\=literal\\=\\=.',
    );
  });
});

describe('exact native host replacement', () => {
  it('replaces one host with many and many with one, preserving retained aliases and the quote', () => {
    const body = 'A ==useful claim== (※ [[Hosts/One.md|Authored alias]]) stays. ^shared';
    const many = replacePassageHosts(body, passages(body)[0], [
      'Hosts/Two.md',
      'Hosts/One',
      'Hosts/Two',
    ]);
    expect(many.removed).toBe(false);
    if (many.removed) throw new Error('Expected a hosted passage');
    expect(passageHosts(many.body, many.passage)).toEqual(['Hosts/Two', 'Hosts/One']);
    expect(many.body).toContain('(※ [[Hosts/Two]], [[Hosts/One.md|Authored alias]])');
    expect(many.quoteMarkdown).toBe('useful claim');
    expect(many.blockId).toBe('shared');
    expect(passageQuote(many.body, many.passage)).toBe(many.quoteMarkdown);
    const one = replacePassageHosts(many.body, many.passage, ['Hosts/Two']);
    expect(one.body).toBe('A ==useful claim== (※ [[Hosts/Two]]) stays. ^shared');
    expect(one.quoteMarkdown).toBe(many.quoteMarkdown);
    expect(one.blockId).toBe(many.blockId);
  });

  it('preserves a no-op citation byte-for-byte and retains its own whitespace on removal of one host', () => {
    const body =
      'A ==useful claim==(※\t[[Hosts/One.md|My alias]],\t[[Hosts/Two]]  ) stays. ^authored';
    const same = replacePassageHosts(body, passages(body)[0], ['Hosts/One', 'Hosts/Two.md']);
    expect(same.body).toBe(body);
    const one = replacePassageHosts(body, passages(body)[0], ['Hosts/One']);
    expect(one.body).toBe('A ==useful claim==(※\t[[Hosts/One.md|My alias]]  ) stays. ^authored');
  });

  it('clears only the logical fragmented highlight and returns the pre-removal quote and native origin', () => {
    const original = '**alpha beta** *gamma delta* ^existing';
    const hosted = hostSelection(original, { quote: 'beta gamma' }, ['Hosts/One', 'Hosts/Two']);
    expect(passageFragments(hosted.passage)).toHaveLength(2);
    const cleared = replacePassageHosts(hosted.body, hosted.passage, []);
    expect(cleared.removed).toBe(true);
    expect(cleared).not.toHaveProperty('passage');
    expect(cleared.body).toBe(original);
    expect(cleared.quoteMarkdown).toBe('**beta** *gamma*');
    expect(cleared.blockId).toBe('existing');
    expect(passages(cleared.body)).toEqual([]);
  });

  it.each(['\n', '\r\n'])(
    'keeps publisher links, emphasis, native anchors and %j line endings when clearing a rich highlight',
    (newline) => {
      const original =
        'First **words** [publisher report](https://example.test/report "Title") after. ^source' +
        newline;
      const hosted = hostSelection(original, { quote: 'First words publisher report after.' }, [
        host,
      ]);
      const cleared = replacePassageHosts(hosted.body, hosted.passage, []);
      expect(cleared.body).toBe(original);
      expect(cleared.quoteMarkdown).toBe(
        'First **words** [publisher report](https://example.test/report "Title") after.',
      );
      expect(cleared.blockId).toBe('source');
    },
  );

  it.each([
    ['the', 'report'],
    ['report', 'the'],
  ])(
    'changes and clears one shared publisher-link association without reassigning its sibling: %s then %s',
    (firstQuote, secondQuote) => {
      const original =
        'Read [the clear report](https://example.test/report "Title") today. ^shared';
      const first = hostSelection(original, { quote: firstQuote }, ['Hosts/First']);
      const second = hostSelection(first.body, { quote: secondQuote }, ['Hosts/Second']);
      const chosen = passages(second.body).find((item) => item.text === firstQuote)!;
      const replaced = replacePassageHosts(second.body, chosen, ['Hosts/New', 'Hosts/Extra']);
      if (replaced.removed) throw new Error('Expected a hosted passage');
      expect(passageHosts(replaced.body, replaced.passage)).toEqual(['Hosts/New', 'Hosts/Extra']);
      const sibling = passages(replaced.body).find((item) => item.text === secondQuote)!;
      expect(passageHosts(replaced.body, sibling)).toEqual(['Hosts/Second']);
      expect(passageQuote(replaced.body, sibling)).toBe(second.quoteMarkdown);
      expect(replaced.quoteMarkdown).toBe(first.quoteMarkdown);
      const cleared = replacePassageHosts(replaced.body, replaced.passage, []);
      const remaining = passages(cleared.body);
      expect(remaining).toHaveLength(1);
      expect(passageHosts(cleared.body, remaining[0])).toEqual(['Hosts/Second']);
      expect(passageQuote(cleared.body, remaining[0])).toBe(second.quoteMarkdown);
      expect(cleared.quoteMarkdown).toBe(first.quoteMarkdown);
      expect(cleared.body).toBe(
        `Read [${secondQuote === 'the' ? '==the== clear report' : 'the clear ==report=='}](https://example.test/report "Title") (※ [[Hosts/Second]]) today. ^shared`,
      );
      expect(paragraphAnchors(cleared.body).map((item) => item.blockId)).toEqual(['shared']);
    },
  );

  it('does not replace repeated text in another paragraph or touch sibling/native-authored citations', () => {
    const first = '==same words== (※ [[Hosts/First]]) then ==other== (※ [[Hosts/Sibling]]). ^one';
    const second = '==same words== (※ [[Hosts/Second]]) then ==third== (※ [[Hosts/Third]]). ^two';
    const suffix = '\n\nAuthored (※ [[Hosts/Unrelated|Keep alias]]).\n\n`(※ [[Code]])`';
    const body = `${first}\n\n${second}${suffix}`;
    const selected = passages(body)[2];
    const replaced = replacePassageHosts(body, selected, ['Hosts/New', 'Hosts/Extra']);
    if (replaced.removed) throw new Error('Expected a hosted passage');
    expect(replaced.body.startsWith(first + '\n\n')).toBe(true);
    expect(replaced.body.endsWith(suffix)).toBe(true);
    expect(replaced.blockId).toBe('two');
    expect(
      paragraphPassages(replaced.body, 'one').map((item) => passageHosts(replaced.body, item)),
    ).toEqual([['Hosts/First'], ['Hosts/Sibling']]);
    const cleared = replacePassageHosts(replaced.body, replaced.passage, []);
    expect(cleared.body).toBe(
      `${first}\n\nsame words then ==third== (※ [[Hosts/Third]]). ^two${suffix}`,
    );
    expect(cleared.quoteMarkdown).toBe('same words');
    expect(
      paragraphPassages(cleared.body, 'two').map((item) => passageHosts(cleared.body, item)),
    ).toEqual([['Hosts/Third']]);
  });

  it('keeps reference destinations self-contained in the receipt and preserves their source definitions', () => {
    const original =
      'See [publisher words][] now. ^reference\n\n[publisher words]: https://example.test/report "Publisher title"\n';
    const hosted = hostSelection(original, { quote: 'publisher' }, [host]);
    const replaced = replacePassageHosts(hosted.body, hosted.passage, ['Hosts/New', 'Hosts/Other']);
    if (replaced.removed) throw new Error('Expected a hosted passage');
    expect(replaced.quoteMarkdown).toBe(
      '[publisher](https://example.test/report "Publisher title")',
    );
    expect(passageQuote(replaced.body, replaced.passage)).toBe(replaced.quoteMarkdown);
    const cleared = replacePassageHosts(replaced.body, replaced.passage, []);
    expect(cleared.body).toBe(
      'See [publisher words][publisher words] now. ^reference\n\n[publisher words]: https://example.test/report "Publisher title"\n',
    );
    expect(cleared.quoteMarkdown).toBe(replaced.quoteMarkdown);
    expect(cleared.blockId).toBe('reference');
  });

  it.each([
    ['[[Nodes/Original.md|plain words]]', 'plain words'],
    ['[**plain** words](/Nodes/Original.md)', '**plain** words'],
  ])(
    'hosts a legacy wrapped passage without turning its original target into another explicit host: %s',
    (link, quote) => {
      const body = `Original ==${link}== stays. ^legacy`;
      const old = passages(body)[0];
      expect(old.target).toBe('Nodes/Original.md');
      const clearedLegacy = replacePassageHosts(body, old, []);
      expect(clearedLegacy.body).toBe(`Original ${link} stays. ^legacy`);
      expect(clearedLegacy.quoteMarkdown).toBe(quote);
      const replaced = replacePassageHosts(body, old, ['Hosts/Chosen']);
      if (replaced.removed) throw new Error('Expected a hosted passage');
      expect(replaced.body).toBe(`Original ==${link}== (※ [[Hosts/Chosen]]) stays. ^legacy`);
      expect(replaced.passage.target).toBe(old.target);
      expect(passageHosts(replaced.body, replaced.passage)).toEqual(['Hosts/Chosen']);
      expect(replaced.quoteMarkdown).toBe(quote);
      const cleared = replacePassageHosts(replaced.body, replaced.passage, []);
      expect(cleared.body).toBe(`Original ${link} stays. ^legacy`);
      expect(cleared.quoteMarkdown).toBe(quote);
      expect(cleared.blockId).toBe('legacy');
    },
  );

  it('does not union an authored wiki target with an existing explicit native host group', () => {
    const body = '==[[Nodes/Authored|quoted words]]== (※ [[Hosts/Explicit]]) stays. ^native';
    const replaced = replacePassageHosts(body, passages(body)[0], ['Hosts/Chosen']);
    expect(replaced.body).toBe(
      '==[[Nodes/Authored|quoted words]]== (※ [[Hosts/Chosen]]) stays. ^native',
    );
    expect(replaced.quoteMarkdown).toBe('quoted words');
    if (replaced.removed) throw new Error('Expected a hosted passage');
    const cleared = replacePassageHosts(replaced.body, replaced.passage, []);
    expect(cleared.body).toBe('[[Nodes/Authored|quoted words]] stays. ^native');
  });

  it('hosts an old plain no-host mark or clears it safely while retaining a usable native origin', () => {
    const body = 'Before ==old excerpt== after.';
    const hosted = replacePassageHosts(body, passages(body)[0], ['Hosts/Chosen']);
    if (hosted.removed) throw new Error('Expected a hosted passage');
    expect(passageHosts(hosted.body, hosted.passage)).toEqual(['Hosts/Chosen']);
    const cleared = replacePassageHosts(body, passages(body)[0], []);
    expect(cleared.removed).toBe(true);
    expect(cleared.body).toBe(`Before old excerpt after. ^${cleared.blockId}`);
    expect(cleared.quoteMarkdown).toBe('old excerpt');
    expect(paragraphAnchors(cleared.body)).toHaveLength(1);
  });

  it('can clear one bare legacy publisher-label mark without guessing a host for its sibling', () => {
    const body = '[==one== and ==two==](https://example.test) ^unhosted';
    const selected = passages(body)[0];
    expect(() => replacePassageHosts(body, selected, ['Hosts/New'])).toThrow();
    const cleared = replacePassageHosts(body, selected, []);
    expect(cleared.body).toBe('[one and ==two==](https://example.test) ^unhosted');
    expect(cleared.quoteMarkdown).toBe('[one](https://example.test)');
    expect(passageHosts(cleared.body, passages(cleared.body)[0])).toEqual([]);
  });

  it.each([{ targets: [] }, { targets: ['Hosts/New'] }])(
    'declines ambiguous shared-link associations for desired hosts $targets',
    ({ targets }) => {
      const body = '[==one== and ==two==](https://example.test) (※ [[Hosts/One]]) ^ambiguous';
      const selected = passages(body)[0];
      expect(() => replacePassageHosts(body, selected, targets)).toThrow(/ambiguous/i);
    },
  );

  it.each([{ targets: [] }, { targets: ['Hosts/New'] }])(
    'declines stale references and duplicate native origins for desired hosts $targets',
    ({ targets }) => {
      const body = '==claim== (※ [[Hosts/One]]) ^existing';
      const selected = passages(body)[0];
      expect(() =>
        replacePassageHosts(body.replace('Hosts/One', 'Hosts/Two'), selected, targets),
      ).toThrow();
      const duplicated = body + '\n\nOther text. ^existing';
      expect(() => replacePassageHosts(duplicated, passages(duplicated)[0], targets)).toThrow(
        /duplicat/i,
      );
    },
  );

  it.each(['javascript:bad', '../bad', '/bad', 'Hosts/Bad#fragment', 'Hosts/Bad|alias'])(
    'rejects an unsafe replacement target: %s',
    (target) => {
      const body = '==claim== (※ [[Hosts/One]]) ^existing';
      expect(() => replacePassageHosts(body, passages(body)[0], [target])).toThrow();
    },
  );

  it('leaves hostPassage additive while exact replacement removes unchecked hosts', () => {
    const first = hostSelection('A useful claim.', { quote: 'useful claim' }, ['Hosts/One']);
    const additive = hostPassage(first.body, first.passage, ['Hosts/Two']);
    expect(passageHosts(additive.body, additive.passage)).toEqual(['Hosts/One', 'Hosts/Two']);
    const replacement = replacePassageHosts(additive.body, additive.passage, ['Hosts/Two']);
    if (replacement.removed) throw new Error('Expected a hosted passage');
    const again = hostPassage(replacement.body, replacement.passage, ['Hosts/One']);
    expect(passageHosts(again.body, again.passage)).toEqual(['Hosts/Two', 'Hosts/One']);
    expect(again.quoteMarkdown).toBe(first.quoteMarkdown);
    expect(again.blockId).toBe(first.blockId);
  });
});

describe('quote-only saved note-link passages', () => {
  it.each(['\n', '\r\n'])(
    'quotes a verified a > mark without flattening its note URL, retaining %j bytes',
    (newline) => {
      const body =
        '[==First excerpt.==](Nodes/Concept.md) (※ [[Nodes/Concept]]) ^native-first' + newline;
      const saved = passages(body)[0];
      expect(passageQuote(body, saved)).toBe('[First excerpt.](Nodes/Concept.md)');
      const hosted = hostPassage(body, saved, ['Nodes/Other']);
      expect(hosted.quoteMarkdown).toBe('[First excerpt.](Nodes/Concept.md)');
      expect(hosted.body).toBe(
        '[==First excerpt.==](Nodes/Concept.md) (※ [[Nodes/Concept]], [[Nodes/Other]]) ^native-first' +
          newline,
      );
      expect(hosted.blockId).toBe('native-first');
      expect(paragraphAnchors(hosted.body).map((item) => item.blockId)).toEqual(['native-first']);
      const replaced = replacePassageHosts(hosted.body, hosted.passage, ['Nodes/Chosen']);
      expect(replaced.quoteMarkdown).toBe(hosted.quoteMarkdown);
      expect(replaced.body).toBe(
        '[==First excerpt.==](Nodes/Concept.md) (※ [[Nodes/Chosen]]) ^native-first' + newline,
      );
    },
  );

  it('hosts an existing partial note label with the citation outside its original complete link', () => {
    const body = '[==word== rest](Nodes/X.md) ^native';
    const saved = passages(body)[0];
    expect(() => selectionPlan(body, saved.from, saved.to)).toThrow(/vault link/i);
    const quote = selectionPlan(body, saved.from, saved.to, 'quote');
    expect(quote.quoteMarkdown).toBe('[word](Nodes/X.md)');
    expect(quote.fragments).toEqual([]);
    expect(quote.insertions).toEqual([]);
    expect(quote.replacements).toEqual([]);
    expect(quote.citationAt).toBe(body.indexOf(')') + 1);
    const hosted = hostPassage(body, saved, ['Nodes/Host']);
    expect(hosted.body).toBe('[==word== rest](Nodes/X.md) (※ [[Nodes/Host]]) ^native');
    expect(hosted.quoteMarkdown).toBe('[word](Nodes/X.md)');
  });

  it.each(['Nodes/My%20Concept.md#Heading', '<Nodes/My Concept (v2).md#Heading>'])(
    'quotes a fragmented rich label with its exact original note destination/title syntax: %s',
    (destination) => {
      const body = `[Before **==rich==** ==words== rest](${destination} 'Authored title') (※ [[Hosts/Old]]) ^rich`;
      const saved = passages(body)[0];
      expect(passageFragments(saved)).toHaveLength(2);
      const quote = `[**rich** words](${destination} 'Authored title')`;
      const plan = selectionPlan(body, saved.from, saved.to, 'quote');
      expect(plan.fragments).toEqual([]);
      expect(plan.insertions).toEqual([]);
      expect(plan.replacements).toEqual([]);
      expect(passageQuote(body, saved)).toBe(quote);
      const hosted = hostPassage(body, saved, ['Hosts/Other']);
      expect(hosted.quoteMarkdown).toBe(quote);
      expect(hosted.body).toContain(
        `[Before **==rich==** ==words== rest](${destination} 'Authored title')`,
      );
      const cleared = replacePassageHosts(hosted.body, hosted.passage, []);
      expect(cleared.body).toBe(
        `[Before **rich** words rest](${destination} 'Authored title') ^rich`,
      );
      expect(cleared.quoteMarkdown).toBe(quote);
      expect(cleared.blockId).toBe('rich');
    },
  );

  it('preserves separate sibling associations inside the same saved note link', () => {
    const body =
      '[==First== and ==Second==](Nodes/X.md) (※ [[Hosts/First]]) (※ [[Hosts/Second]]) ^shared';
    const saved = passages(body);
    const hosted = hostPassage(body, saved[0], ['Hosts/Added']);
    expect(hosted.quoteMarkdown).toBe('[First](Nodes/X.md)');
    const siblings = passages(hosted.body);
    expect(siblings).toHaveLength(2);
    expect(passageHosts(hosted.body, siblings[0])).toEqual(['Hosts/First', 'Hosts/Added']);
    expect(passageHosts(hosted.body, siblings[1])).toEqual(['Hosts/Second']);
    expect(passageQuote(hosted.body, siblings[1])).toBe('[Second](Nodes/X.md)');
    const cleared = replacePassageHosts(hosted.body, siblings[0], []);
    expect(cleared.body).toBe('[First and ==Second==](Nodes/X.md) (※ [[Hosts/Second]]) ^shared');
    expect(passageHosts(cleared.body, passages(cleared.body)[0])).toEqual(['Hosts/Second']);
  });

  it('expands a saved reference label into a self-contained note link without changing source definitions', () => {
    const body = '[==word== rest][note] ^reference\n\n[note]: Nodes/X.md "Note title"\n';
    const saved = passages(body)[0];
    const hosted = hostPassage(body, saved, ['Hosts/Chosen']);
    expect(hosted.quoteMarkdown).toBe('[word](Nodes/X.md "Note title")');
    expect(hosted.body).toBe(
      '[==word== rest][note] (※ [[Hosts/Chosen]]) ^reference\n\n[note]: Nodes/X.md "Note title"\n',
    );
  });

  it('retains the legacy mark > a target semantics and original link source', () => {
    const body = '==[**First** excerpt.](Nodes/Concept.md)== (※ [[Hosts/One]]) ^legacy';
    const saved = passages(body)[0];
    expect(saved.target).toBe('Nodes/Concept.md');
    const hosted = hostPassage(body, saved, ['Hosts/Two']);
    expect(hosted.quoteMarkdown).toBe('**First** excerpt.');
    expect(hosted.body).toBe(
      '==[**First** excerpt.](Nodes/Concept.md)== (※ [[Hosts/One]], [[Hosts/Two]]) ^legacy',
    );
  });

  it('does not grant quotation privilege to a stale or forged unhighlighted passage', () => {
    const body = '[==saved words== rest](Nodes/X.md) (※ [[Hosts/One]]) ^native';
    const saved = passages(body)[0];
    expect(() => passageQuote(body.replace('saved words', 'other words'), saved)).toThrow();
    expect(() =>
      hostPassage(body.replace('saved words', 'other words'), saved, ['Hosts/New']),
    ).toThrow();
    const plain = '[saved words rest](Nodes/X.md) ^native';
    const forged = { from: 1, to: 12, text: 'saved words' };
    expect(() => passageQuote(plain, forged)).toThrow();
    expect(() => hostPassage(plain, forged, ['Hosts/New'])).toThrow();
    expect(() => replacePassageHosts(plain, forged, [])).toThrow();
  });

  it.each([
    'Before [unhighlighted words](Nodes/X.md) after.',
    'Before [unhighlighted **words**](<Nodes/My Concept.md>) after.',
    'Before [[Nodes/X|unhighlighted words]] after.',
  ])('still rejects a NEW selection inside an unhighlighted vault link: %s', (body) => {
    expect(() => locateSelection(body, 'unhighlighted words')).toThrow();
    expect(() => hostSelection(body, { quote: 'unhighlighted words' }, ['Hosts/Chosen'])).toThrow();
    const from = body.indexOf('unhighlighted'),
      to = body.indexOf('words', from) + 'words'.length;
    expect(() => selectionPlan(body, from, to)).toThrow(/vault link/i);
    expect(() => selectionPlan(body, from, to, 'mention')).toThrow(/vault link/i);
  });
});
