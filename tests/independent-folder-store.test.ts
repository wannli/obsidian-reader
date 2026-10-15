import { expect, it, vi } from 'vitest';
import { ArticleStore } from '../src/core/store';
import { createDocument, readDocument } from '../src/core/document';
import { queueStatus, queues } from '../src/core/model';
import { MemoryVault, gate } from './helpers/memory-vault';

const folders = { articles: 'Capture', feeds: 'Subscriptions' };

it('captures into one destination and changes queues without moving files or losing authored data', async () => {
  const vault = new MemoryVault(),
    store = new ArticleStore(vault, folders);
  const file = await store.capture({
    url: 'https://example.com/new',
    title: 'New',
    body: 'Authored body.',
  });
  const path = file.path;
  expect(path.startsWith('Capture/')).toBe(true);
  const properties = {
    ...readDocument(await vault.read(file)).properties,
    custom: ['keep'],
    read: true,
  };
  vault.bytes.set(file, createDocument(properties, 'Authored ==words==.\n'));
  const move = vi.spyOn(vault, 'move');
  for (const queue of queues) {
    const saved = await store.move(await store.read(path), queue);
    expect(file.path).toBe(path);
    expect(saved.body).toBe('Authored ==words==.\n');
    expect(saved.properties).toEqual({ ...properties, status: queueStatus(queue) });
    expect(store.catalog.article(path)?.queue).toBe(queue);
    expect(await store.capture({ url: 'https://example.com/new' })).toBe(file);
  }
  expect(move).not.toHaveBeenCalled();
});

it('promotes before annotation and expires only explicit feed, regardless of location', async () => {
  const vault = new MemoryVault(),
    store = new ArticleStore(vault, folders);
  const annotated = await store.capture({
    url: 'https://example.com/kept',
    queue: 'Feed',
    body: 'Keep words',
    published: '2026-01-01',
  });
  const path = annotated.path;
  const saved = await store.annotate(await store.read(path), (raw) =>
    raw.replace('Keep words', '==Keep words=='),
  );
  expect(annotated.path).toBe(path);
  expect(saved.properties.status).toBe('later');
  const expired = await store.capture({
    url: 'https://example.com/disposable',
    queue: 'Feed',
    body: 'Publisher body.',
    published: '2026-01-01',
  });
  const old = await vault.create(
    'Reading/Stream/260101 Old location.md',
    createDocument({ type: 'article', published: '2026-01-01' }, 'Leave this alone.'),
  );
  store.catalog.update(old.path, readDocument(await vault.read(old)).properties);
  await store.expire(new Date('2026-10-14T00:00:00Z'));
  expect(vault.trashed).toEqual([expired.path]);
  expect(vault.file(old.path)).toBe(old);
});

it('creates and retitles safely at the vault root', async () => {
  const vault = new MemoryVault(),
    store = new ArticleStore(vault, { articles: '', feeds: '' });
  const file = await store.capture(
    { url: 'https://example.com/root' },
    new Date('2026-10-14T12:00:00Z'),
  );
  expect(file.path).not.toContain('/');
  const saved = await store.acquire(await store.read(file.path), 'Article text', 'Root title');
  expect(saved.path).toMatch(/^261014 Root title.md$/);
  expect(saved.properties.status).toBe('inbox');
});

it('cancels a pending old capture at its final guarded creation boundary', async () => {
  const vault = new MemoryVault(),
    store = new ArticleStore(vault, folders),
    entered = gate(),
    release = gate();
  const create = vault.create.bind(vault);
  Object.assign(vault, {
    create: async (path: string, raw: string, guard?: () => void | Promise<void>) => {
      entered.resolve();
      await release.promise;
      await guard?.();
      return create(path, raw);
    },
  });
  const lifetime = new AbortController();
  const pending = store.capture({ url: 'https://example.com/cancelled' }, new Date(), () => {
    if (lifetime.signal.aborted) throw new Error('Cancelled');
  });
  await entered.promise;
  lifetime.abort();
  store.dispose();
  release.resolve();
  await expect(pending).rejects.toThrow('Cancelled');
  expect(vault.files.size).toBe(0);
});
