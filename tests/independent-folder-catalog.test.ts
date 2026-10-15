import { describe, expect, it } from 'vitest';
import { Catalog } from '../src/core/catalog';
import { articleInfo, queueAt, queueStatus, queues } from '../src/core/model';
import type { ReaderFolders } from '../src/core/folders';

const folders: ReaderFolders = { articles: 'Capture', feeds: 'Subscriptions' };

describe('metadata catalog independent of capture folders', () => {
  it('classifies by explicit status anywhere, never by path', () => {
    for (const queue of queues) {
      const properties = { type: 'article', status: queueStatus(queue) };
      expect(queueAt(properties)).toBe(queue);
      for (const path of ['Notes/a.md', 'Reading/Inbox/a.md', 'Subscriptions/a.md'])
        expect(articleInfo(path, properties)?.queue).toBe(queue);
    }
    expect(articleInfo('Capture/normal.md', { type: 'note', status: 'inbox' })).toBeUndefined();
  });

  it('discovers subscriptions everywhere by type', () => {
    const catalog = new Catalog(folders);
    const paths = [
      'Subscriptions/feed.md',
      'Other/feed.md',
      'Reading/Wires/old.md',
      'Capture/wrong.md',
    ];
    for (const path of paths)
      catalog.update(path, { type: 'feed', url: 'https://example.com/feed' });
    catalog.update('Subscriptions/article.md', { type: 'article' });
    expect(catalog.feeds().map((feed) => feed.path)).toEqual(paths);
    expect(catalog.article('Subscriptions/article.md')?.queue).toBe('Feed');
  });

  it('keeps URL dedupe and queue membership unchanged after capture destination changes', () => {
    const previous = new Catalog();
    const next = new Catalog(folders);
    for (const [i, queue] of queues.entries()) {
      const path = `Notes/${i}.md`;
      const properties = {
        type: 'article',
        status: queueStatus(queue),
        url: `https://example.com/${i}`,
      };
      previous.update(path, properties);
      next.update(path, properties);
      expect(next.findUrl(properties.url)?.path).toBe(path);
      expect(next.list(queue)).toEqual(previous.list(queue));
    }
  });

  it('copies a capture folder map, accepting shared destinations', () => {
    const candidate = { ...folders };
    const catalog = new Catalog(candidate);
    candidate.articles = 'Changed';
    expect(catalog.folders.articles).toBe('Capture');
    expect(Object.isFrozen(catalog.folders)).toBe(true);
    expect(new Catalog({ articles: '', feeds: '' }).folders).toEqual({ articles: '', feeds: '' });
  });
});
