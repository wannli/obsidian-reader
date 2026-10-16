import { describe, expect, it, vi } from 'vitest';
import { type ArticleInfo } from '../src/core/model';
import { matchesTopicArticle, matchesTopicText, type TopicFilter } from '../src/core/topic-filter';

const article: ArticleInfo = {
  path: 'Articles/Example.md',
  title: 'An unrelated article',
  url: 'https://climate.example',
  topics: [],
  date: 0,
  queue: 'Later',
  dogEar: false,
};
const filter: TopicFilter = {
  label: 'Climate change',
  path: 'Topics/Climate.md',
  terms: ['climate change', 'global warming'],
};
const match = (body: string, terms: readonly string[] = filter.terms) =>
  matchesTopicArticle(article, body, { ...filter, terms }, () => undefined);

describe('matchesTopicText', () => {
  it.each([
    ['art', 'art', true],
    ['cartography', 'art', false],
    ['arts', 'art', false],
    ['(ART)!', 'art', true],
    ['art_works', 'art', false],
    ['art2', 'art', false],
    ['éart', 'art', false],
    ['art\u0301', 'art', false],
    ['earth—art', 'art', true],
    ['CLIMATE\n CHANGE', 'climate change', true],
    ['climate changes', 'climate change', false],
    ['CAFÉ society', 'cafe\u0301', true],
    ['ΚΌΣΜΟΣ', 'κόσμος', true],
    ['МОСКВА', 'москва', true],
    ['東京', '東京', true],
    ['東京都', '東京', false],
    ['C++ guide', 'C++', true],
    ['anything', '.*', false],
    ['anything', '  ', false],
  ])('%s / %s → %s', (text, term, expected) => {
    expect(matchesTopicText(text, [term])).toBe(expected);
  });
  it('uses any supplied alias, but never treats empty terms as a wildcard', () => {
    expect(matchesTopicText('GLOBAL WARMING', filter.terms)).toBe(true);
    expect(matchesTopicText('anything', [])).toBe(false);
  });
});

describe('matchesTopicArticle', () => {
  it('matches title without a body or resolver call', () => {
    const resolve = vi.fn();
    expect(
      matchesTopicArticle({ ...article, title: 'Climate change today' }, '', filter, resolve),
    ).toBe(true);
    expect(resolve).not.toHaveBeenCalled();
  });
  it('matches a resolved mapping without matching terms, using source-relative identity', () => {
    const resolve = vi.fn(() => filter.path);
    expect(
      matchesTopicArticle(
        { ...article, topics: ['[[../Topics/Climate|Other label]]'] },
        '',
        { ...filter, terms: [] },
        resolve,
      ),
    ).toBe(true);
    expect(resolve).toHaveBeenCalledWith('../Topics/Climate', article.path);
  });
  it('never substitutes alias labels or unresolved path text for selected identity', () => {
    const mapped = { ...article, topics: ['[[Elsewhere|Climate change]]', 'climate change'] };
    expect(matchesTopicArticle(mapped, '', filter, () => 'Elsewhere.md')).toBe(false);
    expect(
      matchesTopicArticle(
        { ...article, topics: ['[[Topics/Climate]]'] },
        '',
        filter,
        () => undefined,
      ),
    ).toBe(false);
  });
  it('supports free text without an existing topic note', () => {
    const resolve = vi.fn();
    expect(
      matchesTopicArticle(
        article,
        'A newly invented subject.',
        { label: 'invented subject', terms: ['invented subject'] },
        resolve,
      ),
    ).toBe(true);
    expect(
      matchesTopicArticle(
        article,
        'Nothing relevant.',
        { label: 'nonexistent', terms: ['nonexistent'] },
        resolve,
      ),
    ).toBe(false);
    expect(resolve).not.toHaveBeenCalled();
  });
  it.each([
    'Climate **change** matters.',
    'Climate %%aside%% change',
    '<!-- Climate change -->',
    '<div>Climate change</div>',
    'Before <span hidden>Climate change</span> after',
    'Before <script>Climate change</script> after',
    'Before <span>unfinished\n\nClimate change',
    '*Climate* [change](https://example.com) matters.',
    'Climate ==change== matters.',
    '[Climate change][ref]\n\n[ref]: https://example.com',
    'Climate\nchange',
    '> Climate **change**',
    '- Climate change',
    '---\nClimate change\n---\n',
    'Climate&nbsp;change',
    'Climate &#99;hange',
    'Climate `change`',
    '| Subject |\n| --- |\n| Climate change |',
    '[[Secret/Target|Climate change]]',
    '[[Secret/Climate change.md]]',
  ])('matches visible Markdown: %s', (body) => expect(match(body)).toBe(true));
  it.each([
    '[Read more](https://example.com/climate-change "Climate change")',
    '[ref]: https://example.com "Climate change"',
    '<https://example.com/climate-change>',
    'https://example.com/climate-change',
    '%% Climate change %%',
    '![Climate change](https://example.com/image.png)',
    '[[Climate change|Unrelated label]]',
    '[[Climate change/Other.md]]',
    'Climate\n\nchange',
    '# Climate\n\nchange',
    'Climate\n\n- change',
  ])('ignores non-prose/hidden text and block-crossing phrases: %s', (body) =>
    expect(match(body)).toBe(false),
  );
  it('ignores URL and unrelated metadata, including mapping labels', () => {
    expect(match('', ['climate'])).toBe(false);
    expect(match('[neutral](https://climate.example)', ['climate'])).toBe(false);
    expect(match('[ref]: https://climate.example', ['climate'])).toBe(false);
  });
  it('removes Reader comments without inventing word boundaries', () => {
    expect(match('cart%%aside%%ography', ['cart'])).toBe(false);
    expect(match('cart%%aside%%ography', ['cartography'])).toBe(true);
    expect(match('Climate %%aside%% change')).toBe(true);
  });
  it.each([
    'www.climate.org',
    'climate@example.org',
    '<climate@example.org>',
    '<https://climate.org>',
  ])('excludes parser-proven autolinks: %s', (body) =>
    expect(match(body, ['climate'])).toBe(false),
  );
  it('keeps escaped HTML literal rather than interpreting tags or entities', () => {
    expect(match('<div>Climate &amp; change</div>', ['climate & change'])).toBe(false);
    expect(match('<div>Climate &amp; change</div>', ['climate &amp; change'])).toBe(true);
    expect(match('Climate <b>change</b>')).toBe(false);
  });
  it('decodes entities once and keeps literal regex syntax', () => {
    expect(match('Research &amp; development', ['research & development'])).toBe(true);
    expect(match('C++ basics', ['c++'])).toBe(true);
    expect(match('&amp;copy;', ['©'])).toBe(false);
  });
  it('does not mutate inputs or retain results across calls', () => {
    const frozen = Object.freeze({
      ...article,
      topics: Object.freeze([]),
    }) as unknown as ArticleInfo;
    const selection = Object.freeze({ ...filter, terms: Object.freeze([...filter.terms]) });
    expect(matchesTopicArticle(frozen, 'Climate change', selection, () => undefined)).toBe(true);
    expect(matchesTopicArticle(frozen, 'Unrelated', selection, () => undefined)).toBe(false);
  });
});
