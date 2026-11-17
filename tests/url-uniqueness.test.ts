// @vitest-environment node
import { expect, it } from 'vitest';
import { createDocument, patchProperties } from '../src/core/document';
import { ArticleStore } from '../src/core/store';
import { gate, MemoryVault } from './helpers/memory-vault';

it('refuses ambiguous normalized URLs without choosing or changing either authored article', async () => {
  const vault = new MemoryVault(),
    store = new ArticleStore(vault);
  const first = await store.capture({
    url: 'https://EXAMPLE.com:443/report#one',
    body: 'First authored body.',
  });
  const second = await vault.create(
    'Native/Other.md',
    createDocument(
      { type: 'article', url: 'https://example.com/report#two', custom: 'keep' },
      '\nSecond authored body.\n',
    ),
  );
  store.catalog.update(second.path, { type: 'article', url: 'https://example.com/report#two' });
  const before = [await vault.read(first), await vault.read(second)];
  await expect(store.capture({ url: 'https://example.com/report#capture' })).rejects.toMatchObject({
    name: 'DuplicateArticleUrlError',
    url: 'https://example.com/report',
    paths: [first.path, second.path].sort(),
  });
  expect(() => store.catalog.findUrl('https://example.com/report')).toThrow('Multiple articles');
  expect([await vault.read(first), await vault.read(second)]).toEqual(before);
  expect(vault.files.size).toBe(2);
  store.catalog.remove(second.path);
  expect(store.catalog.findUrl('https://EXAMPLE.com:443/report#ignored')?.path).toBe(first.path);
});

it('refuses a native duplicate observed while a reuse guard awaits', async () => {
  const vault = new MemoryVault(),
    store = new ArticleStore(vault);
  const first = await store.capture({
    url: 'https://example.com/race',
    body: 'Original authored body.',
  });
  let checks = 0;
  await expect(
    store.capture({ url: 'https://example.com/race' }, new Date(), async () => {
      if (++checks !== 2) return;
      const file = await vault.create(
        'Native/Concurrent.md',
        createDocument(
          { type: 'article', url: 'https://example.com/race#native' },
          '\nNative authored body.\n',
        ),
      );
      store.catalog.update(file.path, { type: 'article', url: 'https://example.com/race#native' });
    }),
  ).rejects.toMatchObject({
    name: 'DuplicateArticleUrlError',
    paths: ['Native/Concurrent.md', first.path],
  });
  expect((await store.read(first.path)).body).toBe('\nOriginal authored body.\n');
});

it('joins concurrent capture and RSS requests without changing the winning body or queue', async () => {
  const vault = new MemoryVault(),
    store = new ArticleStore(vault);
  const feed = await vault.create(
    'Reading/Feeds/Feed.md',
    createDocument({ type: 'feed', url: 'https://example.com/rss' }),
  );
  const create = vault.create.bind(vault),
    entered = gate(),
    release = gate();
  vault.create = async (path, raw) => {
    entered.resolve();
    await release.promise;
    return create(path, raw);
  };
  const manual = store.capture({
    url: 'https://EXAMPLE.com:443/report?edition=one#manual',
    body: 'Manual authored body.',
    queue: 'Inbox',
  });
  await entered.promise;
  const bulk = store.capture({ url: 'https://example.com/report?edition=one#bulk' });
  const link = store.capture({
    url: 'https://example.com/report?edition=one#link',
    queue: 'Inbox',
  });
  const rss = store.importFeed({
    url: 'https://example.com/report?edition=one#rss',
    body: 'RSS excerpt.',
    feed: `[[${feed.path}]]`,
  });
  release.resolve();
  const files = await Promise.all([manual, bulk, link, rss]);
  expect(files.every((file) => file === files[0])).toBe(true);
  expect(vault.files.size).toBe(2);
  const saved = await store.read(files[0]!.path);
  expect(saved.properties).toMatchObject({
    url: 'https://example.com/report?edition=one',
    status: 'inbox',
  });
  expect(saved.body).toBe('\nManual authored body.\n');
  expect(await store.capture({ url: 'https://example.com/report?edition=two' })).not.toBe(files[0]);
});

it('refreshes stale candidates and fails closed on unreadable bytes', async () => {
  const vault = new MemoryVault(),
    store = new ArticleStore(vault);
  const first = await store.capture({ url: 'https://example.com/stale' });
  const second = await vault.create(
    'Native/Other.md',
    createDocument(
      { type: 'article', url: 'https://example.com/stale' },
      '\nPreserved native body.\n',
    ),
  );
  store.catalog.update(second.path, { type: 'article', url: 'https://example.com/stale' });
  vault.bytes.set(
    first,
    patchProperties(await vault.read(first), { url: 'https://example.com/changed' }),
  );
  expect(await store.capture({ url: 'https://example.com/stale' })).toBe(second);
  vault.bytes.set(second, '---\ntype: article\nurl: [invalid\n---\nProtected body.');
  await expect(store.capture({ url: 'https://example.com/stale' })).rejects.toThrow('frontmatter');
  expect(vault.files.size).toBe(2);
});

it('checks fresh reuse bytes after asynchronous native edits', async () => {
  const vault = new MemoryVault(),
    store = new ArticleStore(vault);
  const file = await store.capture({ url: 'https://example.com/edit' });
  const read = vault.read.bind(vault);
  let reads = 0;
  vault.read = async (target) => {
    if (++reads === 2)
      vault.bytes.set(
        file,
        patchProperties(await read(file), { url: 'https://example.com/new-source' }),
      );
    return read(target);
  };
  await expect(store.capture({ url: 'https://example.com/edit' })).rejects.toThrow('note changed');
  expect((await store.read(file.path)).properties.url).toBe('https://example.com/new-source');
  expect(vault.files.size).toBe(1);
});
