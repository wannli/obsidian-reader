import { describe, expect, it, vi } from 'vitest';
import { ArticleFragmentIntents } from '../src/core/article-fragment';

function fixture() {
  let now = 1_000;
  const file = { path: 'Reading/Later/Decision rules.md' };
  const other = { path: 'Reading/Later/Other.md' };
  const resolve = vi.fn((path: string) =>
    path === 'Reading/Later/Decision rules' || path === file.path
      ? file
      : path === 'Other'
        ? other
        : undefined,
  );
  const intents = new ArticleFragmentIntents<{ path: string }>(() => now);
  return {
    file,
    other,
    resolve,
    intents,
    clock: (value: number) => {
      now = value;
    },
  };
}

describe('transient native paragraph navigation intent', () => {
  it('remembers an explicit existing paragraph target without inferring a cursor', () => {
    const { intents, file, resolve } = fixture();
    intents.observe('Reading/Later/Decision rules#^reader-k7m2', 'Concepts/Trust.md', resolve);
    expect(resolve).toHaveBeenCalledWith('Reading/Later/Decision rules', 'Concepts/Trust.md');
    expect(intents.peek(file)).toEqual({
      file,
      path: file.path,
      subpath: '#^reader-k7m2',
      expires: 11_000,
    });
  });

  it('preserves the same hint across repeated passive routing checks until successful dispatch', () => {
    const { intents, file, resolve } = fixture();
    intents.observe('Reading/Later/Decision rules#^paragraph', 'Concepts/Trust.md', resolve);
    const hint = intents.peek(file)!;
    expect(intents.peek(file)).toBe(hint);
    expect(intents.current(hint)).toBe(true);
    intents.finish(hint);
    expect(intents.peek(file)).toBeUndefined();
    expect(intents.current(hint)).toBe(false);
  });

  it('does not apply the hint to a replacement file at the same path or a different file', () => {
    const { intents, file, other, resolve } = fixture();
    intents.observe('Reading/Later/Decision rules#^paragraph', 'Concepts/Trust.md', resolve);
    expect(intents.peek(other)).toBeUndefined();
    expect(intents.peek({ path: file.path })).toBeUndefined();
    expect(intents.peek(file)).toBeDefined();
  });

  it('expires rather than replaying an old click during a later normal article open', () => {
    const { intents, file, resolve, clock } = fixture();
    intents.observe('Reading/Later/Decision rules#^paragraph', '', resolve);
    clock(11_000);
    expect(intents.peek(file)).toBeUndefined();
  });

  it('declines a renamed file rather than guessing that its new path has the same intent', () => {
    const { intents, file, resolve } = fixture();
    intents.observe('Reading/Later/Decision rules#^paragraph', '', resolve);
    file.path = 'Reading/Treasury/Renamed.md';
    expect(intents.peek(file)).toBeUndefined();
  });

  it('a newer click supersedes the old hint and an old completion cannot clear it', () => {
    const { intents, file, other, resolve } = fixture();
    intents.observe('Reading/Later/Decision rules#^first', '', resolve);
    const old = intents.peek(file)!;
    intents.observe('Other#^second', '', resolve);
    expect(intents.current(old)).toBe(false);
    intents.finish(old);
    expect(intents.peek(other)?.subpath).toBe('#^second');
  });

  it('uses the actual source for a same-note native paragraph link', () => {
    const { intents, file, resolve } = fixture();
    intents.observe('#^an-authored-id', file.path, resolve);
    expect(resolve).toHaveBeenCalledWith(file.path, file.path);
    expect(intents.peek(file)?.subpath).toBe('#^an-authored-id');
  });

  it('accepts an encoded caret and one safe path decode only when raw resolution fails', () => {
    const { intents, file, resolve } = fixture();
    intents.observe('Reading/Later/Decision%20rules#%5Ereader-k7m2', '', resolve);
    expect(resolve.mock.calls.map(([path]) => path)).toEqual([
      'Reading/Later/Decision%20rules',
      'Reading/Later/Decision rules',
    ]);
    expect(intents.peek(file)?.subpath).toBe('#^reader-k7m2');
  });

  it('does not decode a literal percent-containing filename that resolves natively', () => {
    const intents = new ArticleFragmentIntents<{ path: string }>();
    const file = { path: 'Literal%20title.md' };
    const resolve = vi.fn(() => file);
    intents.observe('Literal%20title#^paragraph', '', resolve);
    expect(resolve).toHaveBeenCalledTimes(1);
    expect(intents.peek(file)?.subpath).toBe('#^paragraph');
  });

  it.each([
    'https://example.com/#^paragraph',
    'obsidian://open#^paragraph',
    '//server/note#^paragraph',
    'Reading/Later/Decision rules',
    'Reading/Later/Decision rules#Heading',
    'Reading/Later/Decision rules#^bad id',
    'Reading/Later/Decision rules#^bad|alias',
    'Reading/Later/Decision rules#%ZZ',
    'Reading\\Other#^paragraph',
    'Reading\nOther#^paragraph',
  ])('rejects unsafe/nonparagraph intent %j and clears an earlier hint', (href) => {
    const { intents, file, resolve } = fixture();
    intents.observe('Reading/Later/Decision rules#^valid', '', resolve);
    resolve.mockClear();
    intents.observe(href, '', resolve);
    expect(intents.peek(file)).toBeUndefined();
    expect(resolve).not.toHaveBeenCalled();
  });

  it('declines unavailable metadata without breaking native link behavior', () => {
    const { intents, file } = fixture();
    expect(() =>
      intents.observe('Reading/Later/Decision rules#^paragraph', '', () => {
        throw new Error('Metadata closed');
      }),
    ).not.toThrow();
    expect(intents.peek(file)).toBeUndefined();
  });

  it('never manufactures a target when link resolution fails', () => {
    const { intents, file, resolve } = fixture();
    intents.observe('Missing#^paragraph', '', resolve);
    expect(intents.peek(file)).toBeUndefined();
  });
});
