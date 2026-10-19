import { expect, it } from 'vitest';
import { Catalog } from '../src/core/catalog';
import { validateFolders } from '../src/core/folders';
import { ArticleStore } from '../src/core/store';
import { createDocument, readDocument } from '../src/core/document';
import {
  defaultStatusFolders,
  queueForPath,
  validateStatusFolders,
} from '../src/core/status-folders';
import { MemoryVault } from './helpers/memory-vault';

it('classifies by folder, not YAML, and never indexes Templates or trash', () => {
  const catalog = new Catalog();
  for (const [path, status, queue] of [
    ['Reading/Inbox/One.md', 'archive', 'Inbox'],
    ['Reading/Stream/Two.md', 'later', 'Feed'],
    ['Reading/Later/Three.md', 'feed', 'Later'],
    ['Reading/Treasury/Four.md', 'inbox', 'Archive'],
    ['Elsewhere/Five.md', 'feed', undefined],
  ] as const) {
    catalog.update(path, { type: 'article', status });
    expect(catalog.article(path)?.queue).toBe(queue);
    expect(catalog.article(path)?.status).toBe(status);
  }
  for (const path of ['Templates/Article.md', 'Other/Templates/Article.md', '.trash/Article.md']) {
    catalog.update(path, { type: 'article', status: 'inbox' });
    catalog.update(path.replace('Article', 'Feed'), { type: 'feed', url: 'https://example.com' });
    expect(catalog.article(path)).toBeUndefined();
    expect(catalog.feed(path.replace('Article', 'Feed'))).toBeUndefined();
  }
  expect(catalog.size).toBe(5);
  expect(catalog.paths('Feed')).toEqual(['Reading/Stream/Two.md']);
  catalog.rename('Reading/Stream/Two.md', 'Reading/Treasury/Two.md', {
    type: 'article',
    status: 'later',
  });
  expect(catalog.paths('Feed')).toEqual([]);
  expect(catalog.paths('Archive')).toContain('Reading/Treasury/Two.md');
  catalog.rename('Reading/Treasury/Two.md', 'Templates/Two.md', {
    type: 'article',
    status: 'later',
  });
  expect(catalog.article('Templates/Two.md')).toBeUndefined();
});

it('has four default destinations including Later, with no overlap or template destinations', () => {
  expect(defaultStatusFolders.later).toBe('Reading/Later');
  expect(queueForPath('Reading/Later/A.md', defaultStatusFolders)).toBe('Later');
  expect(validateStatusFolders({ inbox: 'Custom/Inbox' }).later).toBe('Reading/Later');
  expect(() => validateStatusFolders({ later: 'Templates/Later' })).toThrow();
  expect(() => validateStatusFolders({ later: 'Reading/Inbox/Sub' })).toThrow();
  expect(() =>
    validateFolders({ articles: 'Reading/Articles', feeds: 'Templates/Feeds' }),
  ).toThrow();
});

it('reclassifies the index after changing queue-folder settings without touching note bytes', () => {
  const catalog = new Catalog();
  catalog.update('Custom/Inbox/Article.md', { type: 'article', status: 'archive' });
  expect(catalog.article('Custom/Inbox/Article.md')?.queue).toBeUndefined();
  catalog.setStatusFolders({ inbox: 'Custom/Inbox' });
  expect(catalog.paths('Inbox')).toEqual(['Custom/Inbox/Article.md']);
  catalog.setStatusFolders({});
  expect(catalog.paths('Inbox')).toEqual([]);
});

it('captures manual and feed articles into their respective queue folders', async () => {
  const store = new ArticleStore(new MemoryVault());
  const inbox = await store.capture({ url: 'https://example.com/manual' });
  const feed = await store.capture({ url: 'https://example.com/feed', queue: 'Feed' });
  expect(inbox.path).toMatch(/^Reading\/Inbox\//);
  expect(feed.path).toMatch(/^Reading\/Stream\//);
});

it('explicit status selection repairs placement even when YAML already agrees', async () => {
  const vault = new MemoryVault();
  const store = new ArticleStore(vault);
  const file = await vault.create(
    'Reading/Inbox/Story.md',
    createDocument({ type: 'article', status: 'archive' }, 'Own text'),
  );
  const snapshot = await store.read(file.path);
  const saved = await store.move(snapshot, 'Archive');
  expect(saved.path).toBe('Reading/Treasury/Story.md');
  expect(saved.raw).toBe(snapshot.raw);
});

it('protected articles archive on Delete, without trashing or recording a deleted URL', async () => {
  const vault = new MemoryVault();
  const store = new ArticleStore(vault);
  for (const [name, properties, body] of [
    ['Topic', { type: 'article', status: 'feed', topics: ['[[Topics/One]]'] }, 'Text'],
    ['Highlight', { type: 'article', status: 'feed' }, '==Text=='],
    ['Legacy topic', { type: 'article', status: 'feed', topics: '[[Topics/One]]' }, 'Text'],
  ] as const) {
    const file = await vault.create(`Reading/Stream/${name}.md`, createDocument(properties, body));
    await store.trash(await store.read(file.path));
    expect(file.path).toBe(`Reading/Treasury/${name}.md`);
    expect(readDocument(await vault.read(file)).properties.status).toBe('archive');
  }
  expect(vault.trashed).toEqual([]);
});

it('never expires a YAML-only Feed article or a Feed-folder article with conflicting YAML', async () => {
  const vault = new MemoryVault();
  const store = new ArticleStore(vault);
  for (const [path, status] of [
    ['Reading/Inbox/Wrong folder.md', 'feed'],
    ['Reading/Stream/Wrong status.md', 'archive'],
    ['Reading/Stream/Missing status.md', undefined],
  ] as const) {
    const properties = { type: 'article', ...(status ? { status } : {}), published: '2025-01-01' };
    const file = await vault.create(path, createDocument(properties, 'Body'));
    store.catalog.update(file.path, properties);
  }
  expect(await store.expire(new Date('2026-10-19'))).toEqual({
    deleted: 0,
    retained: 0,
    promoted: 0,
  });
  expect(vault.trashed).toEqual([]);
});

it('archives old Feed articles with topics or highlights rather than expiring them', async () => {
  const vault = new MemoryVault();
  const store = new ArticleStore(vault);
  for (const [name, properties, body] of [
    [
      'Topic',
      { type: 'article', status: 'feed', topics: ['[[Topics/One]]'], published: '2025-01-01' },
      'Text',
    ],
    ['Highlight', { type: 'article', status: 'feed', published: '2025-01-01' }, '==Text=='],
  ] as const) {
    const file = await vault.create(`Reading/Stream/${name}.md`, createDocument(properties, body));
    store.catalog.update(file.path, properties);
  }
  expect(await store.expire(new Date('2026-10-19'))).toEqual({
    deleted: 0,
    retained: 0,
    promoted: 2,
  });
  expect(vault.trashed).toEqual([]);
  expect(store.catalog.paths('Archive')).toHaveLength(2);
});

it('never reads or publishes a template article as a Reader note', async () => {
  const vault = new MemoryVault();
  const store = new ArticleStore(vault);
  const file = await vault.create(
    'Templates/Article.md',
    createDocument({ type: 'article', status: 'inbox' }, 'Template'),
  );
  await expect(store.read(file.path)).rejects.toThrow();
  expect(await store.publishNew(file, '2026-10-19T09:00')).toBe(false);
  expect(await vault.read(file)).not.toContain('published:');
});
