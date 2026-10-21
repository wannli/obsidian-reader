import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { changePassage, passages } from '../src/core/annotations';
import { readDocument } from '../src/core/document';
import {
  convertPassage,
  hostPassage,
  hostSelection,
  passageHosts,
} from '../src/core/hosted-highlights';
import { appendQuotation, originLink, rememberOrigin } from '../src/core/quotation';

const node = '---\nfileClass: Concept\ncustom: untouched # keep\n---\n\nAuthored explanation.\n';
const articlePath = 'Reading/Later/Decision rules.md';
const collectedOn = new Date(2026, 9, 20, 12);
// These golden tests call appendQuotation directly, so pin its default local
// collection day without changing the source snapshots or their native IDs.
beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(collectedOn);
});
afterEach(() => {
  vi.useRealTimers();
});
const normalizePath = (path: string) => path.replace(/\.md$/iu, '');

describe('agreed hosted-highlight Markdown across source and destination', () => {
  it('collects the chosen rich-Markdown example with a paragraph citation', () => {
    const original = 'Clear **rules** build [trust](https://example.com/report). ^reader-k7m2\n';
    const hosted = hostSelection(original, { quote: 'Clear rules build trust.' }, [
      'Governance.md',
    ]);
    expect(hosted.blockId).toBe('reader-k7m2');
    expect(hosted.quoteMarkdown).toBe('Clear **rules** build [trust](https://example.com/report).');
    expect(hosted.body).toContain('==Clear **rules** build [trust](https://example.com/report).==');
    expect(hosted.body).toContain('(※ [[');
    expect(hosted.body.match(/\^reader-k7m2/gu)).toHaveLength(1);
    expect(passageHosts(hosted.body, hosted.passage).map(normalizePath)).toEqual(['Governance']);

    const source = originLink(articlePath, hosted.blockId, 'Decision rules');
    const collected = appendQuotation(node, hosted.quoteMarkdown, source).raw;
    expect(collected).toContain(
      '## Highlights\n\n### [[Reading/Later/Decision rules|Decision rules]]\n\n> Clear **rules** build [trust](https://example.com/report). (※ [[Reading/Later/Decision rules#^reader-k7m2|Decision rules]] [[2026-10-20]])',
    );
    expect(collected.startsWith(node)).toBe(true);
    expect(collected).not.toMatch(/created-by|annotation_ids|excerpt_id|reader-recovery/u);
  });

  it.each([
    {
      body: 'The [clear meaningful report](https://example.com/report?q=rules&lang=en#part) remains linked. ^reader-rich\n',
      words: 'meaningful',
      quote: '[meaningful](https://example.com/report?q=rules&lang=en#part)',
      url: 'https://example.com/report?q=rules&lang=en#part',
    },
    {
      body: 'These **clear rules** build trust. ^reader-rich\n',
      words: 'These clear',
      quote: 'These **clear**',
      url: undefined,
    },
    {
      body: 'The [clear **report**](https://example.com/report) supports **open decisions**. ^reader-rich\n',
      words: 'report supports open',
      quote: '[**report**](https://example.com/report) supports **open**',
      url: 'https://example.com/report',
    },
  ])('collects a self-contained exact partial selection: $words', ({ body, words, quote, url }) => {
    const hosted = hostSelection(body, { quote: words }, ['Concepts/Trust.md']);
    expect(hosted.quoteMarkdown).toBe(quote);
    if (url) expect(hosted.body).toContain(url);
    expect(hosted.blockId).toBe('reader-rich');
    const citation = originLink(articlePath, hosted.blockId);
    expect(appendQuotation(node, hosted.quoteMarkdown, citation).raw).toContain(
      `## Highlights\n\n### [[Reading/Later/Decision rules]]\n\n> ${quote} (※ ${citation} [[2026-10-20]])`,
    );
    expect(passageHosts(hosted.body, hosted.passage).map(normalizePath)).toEqual([
      'Concepts/Trust',
    ]);
  });

  it('adds another host without changing the quote or duplicating it on retry', () => {
    const first = hostSelection('A useful claim. ^source-paragraph\n', { quote: 'useful claim' }, [
      'Concepts/One.md',
    ]);
    const second = hostPassage(first.body, first.passage, ['Concepts/Two.md']);
    expect(second.quoteMarkdown).toBe('useful claim');
    expect(second.blockId).toBe(first.blockId);
    expect(passageHosts(second.body, second.passage).map(normalizePath)).toEqual([
      'Concepts/One',
      'Concepts/Two',
    ]);
    const citation = originLink(articlePath, second.blockId, 'Decision rules');
    const target = appendQuotation(node, second.quoteMarkdown, citation).raw;
    expect(appendQuotation(target, second.quoteMarkdown, citation)).toEqual({
      raw: target,
      added: false,
    });
    const legacyFlat = `${node}\n## Highlights\n\n> ${second.quoteMarkdown} (※ ${citation})\n`;
    expect(appendQuotation(legacyFlat, second.quoteMarkdown, citation)).toEqual({
      raw: legacyFlat,
      added: false,
    });
    expect(hostPassage(second.body, second.passage, ['Concepts/Two.md']).body).toBe(second.body);
  });

  it('keeps two logical excerpts and their own associations in one source paragraph', () => {
    const first = hostSelection(
      'Clear rules make decisions contestable. Other context connects this to a process people can understand. ^reader-t9b3\n',
      { quote: 'Clear rules make decisions contestable.' },
      ['Governance.md'],
    );
    const second = hostSelection(first.body, { quote: 'a process people can understand.' }, [
      'Institutional trust.md',
    ]);
    const actual = passages(second.body);
    expect(actual).toHaveLength(2);
    expect(passageHosts(second.body, actual[0]).map(normalizePath)).toEqual(['Governance']);
    expect(passageHosts(second.body, actual[1]).map(normalizePath)).toEqual([
      'Institutional trust',
    ]);
    expect(second.blockId).toBe(first.blockId);
    expect(second.body.match(/\^reader-t9b3/gu)).toHaveLength(1);
    const citation = originLink(articlePath, second.blockId, 'Decision rules');
    const firstTarget = appendQuotation(node, first.quoteMarkdown, citation).raw;
    const both = appendQuotation(firstTarget, second.quoteMarkdown, citation).raw;
    expect(both).toContain(
      `## Highlights\n\n### [[Reading/Later/Decision rules|Decision rules]]\n\n> ${first.quoteMarkdown} (※ ${citation} [[2026-10-20]])`,
    );
    expect(both).toContain(`> ${second.quoteMarkdown} (※ ${citation} [[2026-10-20]])`);
    expect((both.match(/^> /gmu) ?? []).length).toBe(2);
  });

  it('keeps separate hosts for two selections inside one publisher link', () => {
    const original = 'Read [the clear report](https://example.com/report) today. ^reader-link\n';
    const first = hostSelection(original, { quote: 'the' }, ['Concepts/One.md']);
    const second = hostSelection(first.body, { quote: 'report' }, ['Concepts/Two.md']);
    const actual = passages(second.body);
    expect(actual).toHaveLength(2);
    expect(passageHosts(second.body, actual[0]).map(normalizePath)).toEqual(['Concepts/One']);
    expect(passageHosts(second.body, actual[1]).map(normalizePath)).toEqual(['Concepts/Two']);
    expect(second.quoteMarkdown).toBe('[report](https://example.com/report)');
    expect(second.body.match(/\^reader-link/gu)).toHaveLength(1);
  });

  it('converts a node-only mention without a quote of its own name', () => {
    const hosted = hostSelection(
      'Institutions build institutional trust. ^reader-n8c4\n',
      { quote: 'institutional trust' },
      ['Concepts/Institutional trust.md'],
    );
    const converted = convertPassage(
      hosted.body,
      hosted.passage,
      'Concepts/Institutional trust.md',
    );
    expect(converted.body).toContain('Institutions build [[');
    expect(converted.body).toContain('|institutional trust]]. ^reader-n8c4');
    expect(converted.body).not.toMatch(/==|\(※/u);
    const created = rememberOrigin(node, originLink(articlePath, converted.blockId));
    expect(readDocument(created).properties.origin).toBe(
      '[[Reading/Later/Decision rules#^reader-n8c4]]',
    );
    expect(readDocument(created).body).toBe(readDocument(node).body);
    expect(created).not.toContain('## Highlights');
  });

  it('keeps an existing destination snapshot after a source-local removal', () => {
    const hosted = hostSelection(
      'A retained source quotation. ^reader-owned\n',
      { quote: 'retained source quotation' },
      ['Concepts/One.md'],
    );
    const citation = originLink(articlePath, hosted.blockId);
    const target = appendQuotation(node, hosted.quoteMarkdown, citation).raw;
    const sourceEdited = changePassage(hosted.body, hosted.passage, 'remove');
    expect(sourceEdited).not.toMatch(/==|\(※/u);
    expect(sourceEdited).toContain('^reader-owned');
    expect(target).toContain(
      `## Highlights\n\n### [[Reading/Later/Decision rules]]\n\n> retained source quotation (※ ${citation} [[2026-10-20]])`,
    );
    expect(readDocument(target).properties.custom).toBe('untouched');
  });
});
