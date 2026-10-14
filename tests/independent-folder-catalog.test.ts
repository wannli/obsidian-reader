import { describe, expect, it } from 'vitest';
import { Catalog } from '../src/core/catalog';
import { articleInfo, queueAt, queueFolder, queues } from '../src/core/model';
import type { ReaderFolders } from '../src/core/folders';

const folders: ReaderFolders = {
  inbox: 'Capture',
  stream: 'Disposable/Articles',
  later: 'Reading plans/Someday',
  treasury: 'Knowledge/Kept',
  feeds: 'Subscriptions',
};

describe('metadata catalog with independent folders', () => {
  it('classifies only by folder and keeps normal articles outside queues readable', () => {
    for (const queue of queues) {
      const path = `${queueFolder(queue, folders)}/Nested/261014 Article.md`;
      expect(queueAt(path, folders)).toBe(queue);
      expect(
        articleInfo(path, { type: 'article', queue: 'ignored', read: true }, folders)?.queue,
      ).toBe(queue);
    }
    for (const path of [
      'Reading/Inbox/old.md',
      'Capture extra/a.md',
      'Notes/article.md',
      'Subscriptions/article.md',
    ]) {
      const article = articleInfo(path, { type: 'article', title: 'Still readable' }, folders);
      expect(article?.title).toBe('Still readable');
      expect(article?.queue).toBeUndefined();
    }
    expect(articleInfo('Capture/normal.md', { type: 'note' }, folders)).toBeUndefined();
  });

  it('discovers feed subscriptions only inside the configured subscription folder', () => {
    const catalog = new Catalog(folders);
    for (const path of [
      'Subscriptions/feed.md',
      'Subscriptions/nested/feed.md',
      'Subscriptions extra/other.md',
      'Reading/Wires/old.md',
      'Capture/wrong.md',
    ])
      catalog.update(path, {
        type: 'feed',
        url: `https://example.com/${encodeURIComponent(path)}`,
      });
    catalog.update('Subscriptions/article.md', {
      type: 'article',
      url: 'https://example.com/article',
    });
    expect(catalog.feeds().map((feed) => feed.path)).toEqual([
      'Subscriptions/feed.md',
      'Subscriptions/nested/feed.md',
    ]);
    expect(catalog.article('Subscriptions/article.md')?.queue).toBeUndefined();
  });

  it('deduplicates URLs across every queue and outside queues after a settings change', () => {
    const previous = new Catalog();
    const next = new Catalog(folders);
    const paths = [
      ...queues.map((queue) => `${queueFolder(queue, folders)}/a.md`),
      'Notes/article.md',
      'Reading/Inbox/old.md',
    ];
    for (const [i, path] of paths.entries()) {
      const properties = { type: 'article', url: `https://example.com/${i}`, title: `${i}` };
      previous.update(path, properties);
      next.update(path, properties);
      expect(next.findUrl(properties.url)?.path).toBe(path);
    }
    for (const queue of queues) expect(next.list(queue)).toHaveLength(1);
    expect(previous.article('Reading/Inbox/old.md')?.queue).toBe('Inbox');
    expect(next.article('Reading/Inbox/old.md')?.queue).toBeUndefined();
    expect(next.list(undefined)).toHaveLength(2);
  });

  it('never accepts piecemeal mutation of a live folder map', () => {
    const candidate = { ...folders };
    const catalog = new Catalog(candidate);
    candidate.inbox = 'Changed';
    expect(catalog.folders.inbox).toBe('Capture');
    expect(Object.isFrozen(catalog.folders)).toBe(true);
    expect(() => new Catalog({ ...folders, feeds: folders.inbox })).toThrow();
  });
});
