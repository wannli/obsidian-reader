import { describe, expect, it } from 'vitest';
import {
  hasNodeClass,
  nodeChoiceMatch,
  nodeChoiceSeed,
  nodeChoices,
} from '../src/core/node-choices';

const types = [
  { type: 'concept', label: 'Concept' },
  { type: 'topic', label: 'Topic' },
];
const node = (title: string, classes = ['concept'], aliases: string[] = []) => ({
  path: `Notes/${title}.md`,
  title,
  type: classes.at(-1) ?? '',
  classes,
  aliases,
});

describe('typed note choices', () => {
  it('All types means registered Fileclasses, not all files or primary YAML types', () => {
    const typed = node('Typed');
    const multiClass = node('Multi', ['concept', 'topic']);
    const untyped = { ...node('Untyped', []), type: 'topic' };
    const unknown = node('Unknown', ['not-a-fileclass']);
    const canvas = { ...node('Canvas'), path: 'Notes/Canvas.canvas' };
    const found = nodeChoices([typed, multiClass, untyped, unknown, canvas], types);
    expect(found).toEqual([multiClass, typed]);
    expect(nodeChoices([typed, multiClass], [])).toEqual([]);
  });

  it('filters membership with classes.includes even when the last/primary type differs', () => {
    const multiClass = node('Multi', ['topic', 'concept']);
    expect(multiClass.type).toBe('concept');
    expect(hasNodeClass(multiClass, types, 'topic')).toBe(true);
    expect(nodeChoices([node('Other'), multiClass], types, { type: 'topic' })).toEqual([
      multiClass,
    ]);
    expect(hasNodeClass(multiClass, types, 'missing')).toBe(false);
    expect(hasNodeClass(multiClass, [{ type: 'concept', label: 'Concept' }], 'topic')).toBe(false);
  });

  it('keeps fuzzy provider candidates, ranks exact title then alias, and never selects', () => {
    const fuzzy = node('Spaced repetition');
    const exact = node('Memory');
    const alias = node('Recall', ['topic'], ['  MEMORY  ']);
    const preferred = node('Learning');
    expect(
      nodeChoices([fuzzy, preferred, alias, exact], types, {
        query: ' memory ',
        preferredPaths: [preferred.path],
      }),
    ).toEqual([exact, alias, preferred, fuzzy]);
    expect(nodeChoiceMatch(exact, '  MEMORY ')).toBe('Exact title');
    expect(nodeChoiceMatch(alias, 'Memory')).toBe('Exact alias');
    expect(nodeChoiceMatch(fuzzy, 'Memory')).toBe('Related match');
    expect(nodeChoiceMatch(exact, '  ')).toBeUndefined();
  });

  it('preserves public search relevance order within each non-exact tier', () => {
    const best = node('Zebra', ['topic']);
    const weaker = node('Alphabet', ['concept']);
    expect(nodeChoices([best, weaker], types, { query: 'zbr' })).toEqual([best, weaker]);
  });

  it('deduplicates by path, preserves the first current result, and does not mutate inputs', () => {
    const fresh = node('Current');
    const stale = { ...fresh, title: 'Stale' };
    const input = [fresh, stale, node('Alpha')];
    const before = [...input];
    expect(nodeChoices(input, types)).toEqual([input[2], fresh]);
    expect(input).toEqual(before);
    expect(nodeChoices(input, types)[1]).toBe(fresh);
  });

  it('orders blank-query suggestions by preferred path before alphabetical alternatives', () => {
    const a = node('A');
    const b = node('B');
    const c = node('C');
    expect(nodeChoices([a, b, c], types, { preferredPaths: [c.path, b.path] })).toEqual([c, b, a]);
  });
});

describe('highlight query/title suggestions', () => {
  it('normalizes visible whitespace without adding a meaningless ellipsis', () => {
    expect(nodeChoiceSeed(' \n A\tuseful\u00a0 phrase  ')).toBe('A useful phrase');
    expect(nodeChoiceSeed(undefined)).toBe('');
    expect(nodeChoiceSeed('one two three four five six', 18)).toBe('one two three');
  });

  it('bounds long quote seeds and leaves the input unchanged', () => {
    const quote = 'A long selected quotation with many visible words. '.repeat(20);
    const seed = nodeChoiceSeed(quote);
    expect(Array.from(seed).length).toBeLessThanOrEqual(80);
    expect(quote.startsWith(seed)).toBe(true);
    expect(seed).not.toContain('…');
    expect(quote.length).toBeGreaterThan(500);
  });

  it('does not split surrogate pairs, including a single overlong word', () => {
    expect(nodeChoiceSeed('🦉'.repeat(100), 3)).toBe('🦉🦉🦉');
    expect(nodeChoiceSeed('unbrokenword', 5)).toBe('unbro');
    expect(nodeChoiceSeed('text', 0)).toBe('');
  });
});
