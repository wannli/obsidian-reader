import { expect, it } from 'vitest';
import { ArticleStore } from '../src/core/store';
import { createDocument, readDocument } from '../src/core/document';
import { queueFolder, queues } from '../src/core/model';
import { MemoryVault, gate } from './helpers/memory-vault';

const folders = {
  inbox: 'Capture',
  stream: 'Disposable',
  later: 'Plans',
  treasury: 'Kept',
  feeds: 'Subscriptions',
};

it('captures and explicitly moves between independent queues without rewriting authored bytes', async () => {
  const vault = new MemoryVault(),
    store = new ArticleStore(vault, folders);
  const file = await store.capture({
    url: 'https://example.com/new',
    title: 'New',
    body: 'Authored body.',
  });
  expect(file.path.startsWith('Capture/')).toBe(true);
  const raw = createDocument(
    { ...readDocument(await vault.read(file)).properties, custom: ['keep'], read: true },
    'Authored ==words==.\n',
  );
  vault.bytes.set(file, raw);
  for (const queue of queues) {
    await store.move(await store.read(file.path), queue);
    expect(file.path.startsWith(`${queueFolder(queue, folders)}/`)).toBe(true);
    expect(store.catalog.article(file.path)?.queue).toBe(queue);
    expect(await vault.read(file)).toBe(raw);
    expect(await store.capture({ url: 'https://example.com/new' })).toBe(file);
  }
});

it('promotes before annotation and expires only the configured Stream', async () => {
  const vault = new MemoryVault(),
    store = new ArticleStore(vault, folders);
  const annotated = await store.capture({
    url: 'https://example.com/kept',
    title: 'Kept',
    queue: 'Stream',
    body: 'Keep words',
    published: '2026-01-01',
  });
  await store.annotate(await store.read(annotated.path), (raw) =>
    raw.replace('Keep words', '==Keep words=='),
  );
  expect(annotated.path.startsWith('Capture/')).toBe(true);
  const expired = await store.capture({
    url: 'https://example.com/disposable',
    title: 'Old',
    queue: 'Stream',
    body: 'Publisher body.',
    published: '2026-01-01',
  });
  const oldPath = 'Reading/Stream/260101 Old location.md';
  const old = await vault.create(
    oldPath,
    createDocument({ type: 'article', published: '2026-01-01' }, 'Leave this alone.'),
  );
  store.catalog.update(old.path, readDocument(await vault.read(old)).properties);
  await store.expire(new Date('2026-10-14T00:00:00Z'), () => false);
  expect(vault.trashed).toEqual([expired.path]);
  expect(vault.file(oldPath)).toBe(old);
  expect(await vault.read(annotated)).toContain('==Keep words==');
});

it('cancels a pending old capture at its final guarded creation boundary', async () => {
  const vault = new MemoryVault(),
    store = new ArticleStore(vault, folders),
    entered = gate(),
    release = gate();
  const create = vault.create.bind(vault);
  // MemoryVault deliberately has no host guard; this deferred adapter models that boundary explicitly.
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
