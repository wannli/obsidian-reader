import { beforeEach, expect, it, vi } from 'vitest';
import { passages } from '../src/core/annotations';
import { ArticleAnalysis } from '../src/reader/article-analysis';

vi.mock('../src/core/annotations', async (original) => {
  const actual = await original<typeof import('../src/core/annotations')>();
  return { ...actual, passages: vi.fn(actual.passages) };
});
beforeEach(() => {
  vi.mocked(passages).mockClear();
});
it('reuses exact body analysis but returns independent nested UI intents', () => {
  const analysis = new ArticleAnalysis(),
    body = '==one==**==two==** (※ [[Notes/Host]])';
  const first = analysis.passages(body),
    expected = analysis.passages(body);
  expect(passages).toHaveBeenCalledOnce();
  expect(first[0].fragments).toHaveLength(2);
  expect(first[0].hosts).toEqual(['Notes/Host']);
  expect(first[0].citation).toBeDefined();
  first[0].from = -1;
  first[0].fragments![0].from = -2;
  (first[0].hosts as string[]).push('Unrelated');
  first[0].citation!.to = -3;
  first.pop();
  expect(analysis.passages(body)).toEqual(expected);
  expect(passages).toHaveBeenCalledOnce();
});
it('rejects same-length stale evidence without relying on stats or file names', () => {
  const analysis = new ArticleAnalysis();
  expect(analysis.passages('==alpha==')[0].text).toBe('alpha');
  expect(analysis.passages('==bravo==')[0].text).toBe('bravo');
  expect(passages).toHaveBeenCalledTimes(2);
});
it('retains only one revision and releases it on article disposal', () => {
  const analysis = new ArticleAnalysis();
  analysis.passages('==one==');
  analysis.passages('==two==');
  analysis.passages('==one==');
  expect(passages).toHaveBeenCalledTimes(3);
  analysis.clear();
  analysis.clear();
  analysis.passages('==one==');
  expect(passages).toHaveBeenCalledTimes(4);
});
it('does not publish a failed parse under a new body key', () => {
  const analysis = new ArticleAnalysis(),
    original = analysis.passages('==one==');
  vi.mocked(passages).mockImplementationOnce(() => {
    throw new Error('Invalid body');
  });
  expect(() => analysis.passages('==two==')).toThrow('Invalid body');
  expect(analysis.passages('==one==')).toEqual(original);
  expect(passages).toHaveBeenCalledTimes(2);
  expect(analysis.passages('==two==')[0].text).toBe('two');
  expect(passages).toHaveBeenCalledTimes(3);
});
it('also reuses a proven empty result', () => {
  const analysis = new ArticleAnalysis();
  expect(analysis.passages('Plain paragraph.')).toEqual([]);
  expect(analysis.passages('Plain paragraph.')).toEqual([]);
  expect(passages).toHaveBeenCalledOnce();
});
