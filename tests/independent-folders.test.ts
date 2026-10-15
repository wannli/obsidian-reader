import { describe, expect, it } from 'vitest';
import {
  defaultFolders,
  folderKeys,
  folderPath,
  isWithinFolder,
  validateFolders,
  type ReaderFolders,
} from '../src/core/folders';

import { loadFolders, saveFolderSettings } from '../src/host/folder-settings';

export const separateFolders: ReaderFolders = {
  articles: 'Capture',
  feeds: 'Subscriptions',
};

describe('fresh folder settings only', () => {
  it('ignores legacy flat keys and root without importing them', () => {
    const legacy = { root: 'Old', feedsFolder: 'Old/Feeds', pollMinutes: 1, maxFeedItems: 999 };
    expect(loadFolders(legacy)).toEqual(defaultFolders);
    expect(saveFolderSettings(legacy, separateFolders)).toEqual({
      ...legacy,
      captureFolders: separateFolders,
    });
    expect(legacy).not.toHaveProperty('captureFolders');
  });

  it('preserves unknown settings both outside and inside the fresh group', () => {
    const previous = {
      future: { enabled: true },
      captureFolders: { ...defaultFolders, extra: ['unchanged'] },
    };
    const next = saveFolderSettings(previous, separateFolders);
    expect(next).toEqual({
      future: previous.future,
      captureFolders: { ...separateFolders, extra: ['unchanged'] },
    });
    expect(loadFolders(next)).toEqual(separateFolders);
    expect(previous.captureFolders.articles).toBe('Reading/Articles');
  });

  it('rejects malformed groups atomically instead of silently applying partial defaults', () => {
    const previous = { captureFolders: { ...defaultFolders } };
    expect(() =>
      saveFolderSettings(previous, { ...separateFolders, feeds: '../unsafe' }),
    ).toThrow();
    expect(previous).toEqual({ captureFolders: defaultFolders });
    for (const folders of [
      null,
      {},
      { articles: 'Capture' },
      { ...separateFolders, articles: null },
    ])
      expect(() => loadFolders({ captureFolders: folders })).toThrow();
    for (const data of [null, undefined, {}, []]) expect(loadFolders(data)).toEqual(defaultFolders);
  });
});

describe('independent Reader folders', () => {
  it('keeps the two creation destinations without requiring a common parent', () => {
    expect(validateFolders(defaultFolders)).toEqual({
      articles: 'Reading/Articles',
      feeds: 'Reading/Feeds',
    });
    expect(validateFolders(separateFolders)).toEqual(separateFolders);
    expect(validateFolders({ ...separateFolders, articles: '収集/Été' }).articles).toBe('収集/Été');
  });

  it.each([
    '/',
    '/Absolute',
    '../Outside',
    'A/../B',
    'A/./B',
    'A//B',
    'A/',
    'C:\\Reader',
    'C:/Reader',
    'A\\B',
    ' A',
    'A ',
    'A/ B',
    'A/B ',
    'A/B.',
    'A/*',
    'A/?',
    'A/"',
    'A/<',
    'A/>',
    'A/|',
    'A/#tag',
    'A/^block',
    'A/[link]',
    'A/\nB',
    'A/\tB',
    'A/\0B',
    'A/\x7fB',
    'CON',
    'con.txt',
    'PRN',
    'A/AUX',
    'NUL',
    'COM1',
    'LPT9.txt',
    'COM¹',
    '.obsidian',
    '.trash/Reader',
    `A/${'é'.repeat(128)}`,
  ])('rejects unsafe or nonportable destination %j', (path) => {
    expect(() => folderPath(path)).toThrow();
  });

  it('validates every field before producing a new immutable group', () => {
    const draft = { ...separateFolders };
    const accepted = validateFolders(draft);
    draft.articles = 'Changed';
    expect(accepted.articles).toBe('Capture');
    expect(Object.isFrozen(accepted)).toBe(true);
    expect(() => validateFolders({ ...separateFolders, feeds: '../unsafe' })).toThrow();
    expect(accepted).toEqual(separateFolders);
    for (const bad of [null, undefined, [], 'Reading', {}, { ...separateFolders, articles: 4 }])
      expect(() => validateFolders(bad)).toThrow();
  });

  for (let i = 0; i < folderKeys.length; i++) {
    for (let j = i + 1; j < folderKeys.length; j++) {
      const a = folderKeys[i],
        b = folderKeys[j];
      it(`accepts duplicate and ancestor overlap between ${a} and ${b}`, () => {
        for (const [left, right] of [
          ['Same', 'Same'],
          ['Parent', 'Parent/Child'],
          ['Parent/Child', 'Parent'],
          ['SAME', 'same'],
          ['Parent', 'parent/Child'],
          ['Café', 'Cafe\u0301/Child'],
        ]) {
          expect(validateFolders({ ...separateFolders, [a]: left, [b]: right })).toMatchObject({
            [a]: left,
            [b]: right,
          });
        }
      });
    }
  }

  it('uses a segment boundary, allowing siblings with shared prefixes', () => {
    expect(validateFolders({ ...separateFolders, articles: 'Capture later' }).articles).toBe(
      'Capture later',
    );
    expect(isWithinFolder('Capture/a.md', 'Capture')).toBe(true);
    expect(isWithinFolder('Capture/nested/a.md', 'Capture')).toBe(true);
    expect(isWithinFolder('Capture later/a.md', 'Capture')).toBe(false);
    expect(isWithinFolder('Capture.md', 'Capture')).toBe(false);
  });
});
