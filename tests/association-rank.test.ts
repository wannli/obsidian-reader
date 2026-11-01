import { describe, expect, it, vi } from 'vitest';
import type { App } from 'obsidian';
import { associationRanks } from '../src/host/association-rank';
import { compareAssociations } from '../src/core/association-rank';

vi.mock('obsidian', () => ({
  TFile: class TFile {
    constructor(
      public path: string,
      public stat: { mtime: number },
    ) {}
  },
  parseLinktext: (value: string) => ({ path: value.split('#')[0] }),
}));

const link = (path: string, key?: string) => ({
  link: path,
  original: `[[${path}]]`,
  ...(key ? { key } : {}),
});

describe('read-only article association hints', () => {
  it('counts each article once, excludes Reader source state and missing/stale caches', async () => {
    const { TFile } = await import('obsidian');
    const file = (path: string, mtime = 0) => Object.assign(new TFile(), { path, stat: { mtime } });
    const first = file('Reading/Inbox/First.md', 50);
    const second = file('Reading/Later/Second.md', 100);
    const topic = file('Topics/Alpha.md');
    const note = file('Notes/Other.md');
    const source = file('Reading/Feeds/Feed.md');
    const files = new Map([first, second, topic, note, source].map((file) => [file.path, file]));
    const caches = new Map([
      [
        first.path,
        {
          frontmatter: {
            type: 'article',
            topics: ['[[Topics/Alpha.md]]'],
            feed: '[[Reading/Feeds/Feed.md]]',
          },
          links: [link('Notes/Other.md'), link('Notes/Other.md'), link('https://example.com')],
          frontmatterLinks: [
            link('Topics/Alpha.md', 'topics.0'),
            link('Reading/Feeds/Feed.md', 'feed'),
          ],
        },
      ],
      [
        second.path,
        {
          frontmatter: { type: 'article' },
          links: [link('Notes/Other.md')],
          frontmatterLinks: [],
        },
      ],
    ]);
    const app = {
      vault: { getAbstractFileByPath: (path: string) => files.get(path) },
      metadataCache: {
        getFileCache: (file: typeof first) => caches.get(file.path),
        getFirstLinkpathDest: (path: string) => files.get(path),
      },
    } as unknown as App;
    const ranks = associationRanks(app, [
      { path: first.path },
      { path: second.path },
      { path: 'Templates/Ignore.md' },
      { path: 'Reading/Inbox/Gone.md' },
    ]);
    expect(ranks.get(topic.path)).toEqual({ count: 1, edited: 50 });
    expect(ranks.get(note.path)).toEqual({ count: 2, edited: 100 });
    expect(ranks.has(source.path)).toBe(false);
    expect(compareAssociations(note.path, topic.path, ranks)).toBeLessThan(0);
  });

  it('uses linked article edit time only to break equal frequency, never target note mtime', () => {
    const ranks = new Map([
      ['A', { count: 1, edited: 10 }],
      ['B', { count: 1, edited: 20 }],
    ]);
    expect(compareAssociations('B', 'A', ranks)).toBeLessThan(0);
    expect(compareAssociations('unknown', 'other', ranks)).toBe(0);
  });
});
