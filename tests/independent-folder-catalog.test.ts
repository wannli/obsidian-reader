import { describe, expect, it } from 'vitest';
import { Catalog } from '../src/core/catalog';
import { articleInfo, queueStatus, queues } from '../src/core/model';
import type { ReaderFolders } from '../src/core/folders';
import { defaultStatusFolders } from '../src/core/status-folders';

const folders: ReaderFolders = { articles: 'Capture', feeds: 'Subscriptions' };

describe('folder-authoritative catalog independent of capture destinations', () => {
  it('classifies articles by queue folder, regardless of conflicting YAML status', () => {
    const catalog = new Catalog(folders);
    for (const queue of queues) {
      const path = `${defaultStatusFolders[queueStatus(queue)]}/a.md`;
      catalog.update(path, { type: 'article', status: 'feed' });
      expect(catalog.article(path)?.queue).toBe(queue);
      expect(catalog.list(queue).some((article) => article.path === path)).toBe(true);
    }
    catalog.update('Notes/a.md', { type: 'article', status: 'inbox' });
    expect(catalog.article('Notes/a.md')?.queue).toBeUndefined();
    expect(articleInfo('Capture/normal.md', { type: 'note', status: 'inbox' })).toBeUndefined();
  });

  it('excludes Templates and .trash from articles and subscriptions even inside queue folders', () => {
    const catalog = new Catalog(folders);
    for (const path of [
      'Templates/Reading/Inbox/draft.md',
      '.trash/Reading/Stream/old.md',
      'Reading/Later/Templates/draft.md',
      'Reading/Treasury/.trash/old.md',
    ]) {
      catalog.update(path, { type: 'article', status: 'later' });
      expect(catalog.article(path)).toBeUndefined();
      catalog.update(path, { type: 'feed', url: 'https://example.com/feed' });
      expect(catalog.feed(path)).toBeUndefined();
    }
    expect(catalog.list('Later')).toEqual([]);
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
    expect(catalog.article('Subscriptions/article.md')?.queue).toBeUndefined();
  });

  it('keeps URL dedupe and folder queue membership unchanged after capture destination changes', () => {
    const previous = new Catalog();
    const next = new Catalog(folders);
    for (const [i, queue] of queues.entries()) {
      const path = `${defaultStatusFolders[queueStatus(queue)]}/${i}.md`;
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
