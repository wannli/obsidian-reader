import { expect, it, vi } from 'vitest';
import { ArticleStore, PartialCollectionError, type NoteFile } from '../src/core/store';
import { createDocument } from '../src/core/document';
import { MemoryVault, gate } from './helpers/memory-vault';

async function fixture(status = 'feed') {
  const vault = new MemoryVault(),
    store = new ArticleStore(vault);
  const file = await vault.create(
    'Elsewhere/Article.md',
    createDocument(
      { type: 'article', status, published: '2020-01-01' },
      'Words and [local](./other.md).',
    ),
  );
  const target = await vault.create('Concept.md', '---\nfileClass: Concept\n---\nAuthored.\n');
  const snapshot = await store.read(file.path);
  store.catalog.update(file.path, snapshot.properties);
  return { vault, store, file, target, snapshot };
}
const edit = {
  body: '==Words== (※ [[Concept]]) ^reader-a1',
  quoteMarkdown: 'Words',
  blockId: 'reader-a1',
};
const remap = (store: ArticleStore<NoteFile>) =>
  store.setStatusFolders({ later: 'New/Later', archive: 'New/Archive' });

it.each(['move', 'annotation', 'related', 'collection', 'protected delete'] as const)(
  'freezes capture settings before the file lane for queued %s',
  async (kind) => {
    const f = await fixture();
    const entered = gate(),
      release = gate(),
      process = f.vault.process.bind(f.vault);
    vi.spyOn(f.vault, 'process').mockImplementationOnce(async (...args) => {
      entered.resolve();
      await release.promise;
      return process(...args);
    });
    const blocking = f.store.error(f.snapshot, 'Hold');
    await entered.promise;
    const request =
      kind === 'move'
        ? f.store.move(f.snapshot, 'Later')
        : kind === 'annotation'
          ? f.store.annotate(f.snapshot, (raw) => raw.replace('Words', '==Words=='))
          : kind === 'related'
            ? f.store.setRelatedNodes(f.snapshot, [f.target.path], [], () => {})
            : kind === 'collection'
              ? f.store.collectHighlight(f.snapshot, edit, f.target.path, { guard: () => {} })
              : f.store.trash({ ...f.snapshot, body: '==Protected==' });
    const rejected = expect(request).rejects.toThrow(/folders changed/);
    remap(f.store);
    release.resolve();
    const saved = await blocking;
    await rejected;
    expect(await f.vault.read(f.file)).toBe(saved.raw);
    expect(f.file.path).toBe(f.snapshot.path);
    expect(f.vault.trashed).toEqual([]);
    expect(await f.vault.read(f.target)).not.toContain('## Highlights');
  },
);
it('checks settings inside the native status process callback', async () => {
  const f = await fixture(),
    process = f.vault.process.bind(f.vault);
  vi.spyOn(f.vault, 'process').mockImplementation(async (...args) => {
    remap(f.store);
    return process(...args);
  });
  await expect(f.store.move(f.snapshot, 'Later')).rejects.toThrow(/folders changed/);
  expect(await f.vault.read(f.file)).toBe(f.snapshot.raw);
});
it.each(['move', 'annotation', 'collection'] as const)(
  'reports saved retention when settings change after %s status save',
  async (kind) => {
    const f = await fixture(),
      process = f.vault.process.bind(f.vault);
    vi.spyOn(f.vault, 'process').mockImplementation(async (...args) => {
      const raw = await process(...args);
      remap(f.store);
      return raw;
    });
    const request =
      kind === 'move'
        ? f.store.move(f.snapshot, 'Later')
        : kind === 'annotation'
          ? f.store.annotate(f.snapshot, (raw) => raw.replace('Words', '==Words=='))
          : f.store.collectHighlight(f.snapshot, edit, f.target.path, { guard: () => {} });
    const error = await request.catch((error) => error);
    if (kind === 'collection') {
      expect(error).toBeInstanceOf(PartialCollectionError);
      expect(error.annotationSaved).toBe(false);
      expect(error.completedDestinationPaths).toEqual([]);
    } else expect(error.message).toMatch(/Status saved as later/);
    const saved = await f.store.read(f.file.path);
    expect(saved.properties.status).toBe('later');
    expect(saved.body).toBe(f.snapshot.body);
    expect(saved.path).toBe(f.snapshot.path);
  },
);
it.each(['move', 'annotation', 'related'] as const)(
  'rechecks settings after awaited no-op %s validation',
  async (kind) => {
    const f = await fixture('later'),
      read = f.vault.read.bind(f.vault);
    vi.spyOn(f.vault, 'read').mockImplementationOnce(async (file) => {
      const raw = await read(file);
      remap(f.store);
      return raw;
    });
    const request =
      kind === 'move'
        ? f.store.move(f.snapshot, 'Later')
        : kind === 'annotation'
          ? f.store.annotate(f.snapshot, (raw) => raw)
          : f.store.setRelatedNodes(f.snapshot, [], [], () => {});
    await expect(request).rejects.toThrow(/folders changed/);
    expect(await f.vault.read(f.file)).toBe(f.snapshot.raw);
  },
);
it('records completed destinations and stops before dispatching the next after settings change', async () => {
  const f = await fixture('inbox');
  const other = await f.vault.create(
    'Other.md',
    '---\nfileClass: Concept\n---\nOther authored text.\n',
  );
  const original = await f.vault.read(other),
    process = f.vault.process.bind(f.vault);
  vi.spyOn(f.vault, 'process').mockImplementation(async (file, update) => {
    const raw = await process(file, update);
    if (file === f.target) remap(f.store);
    return raw;
  });
  const error = await f.store
    .collectHighlightMany(
      f.snapshot,
      { ...edit, body: '==Words== (※ [[Concept]], [[Other]]) ^reader-a1' },
      [f.target.path, other.path],
      { guard: () => {} },
    )
    .catch((error) => error as PartialCollectionError<NoteFile>);
  expect(error).toBeInstanceOf(PartialCollectionError);
  const partial = error as PartialCollectionError<NoteFile>;
  expect(partial.completedDestinationPaths).toEqual([f.target.path]);
  expect(partial.destinationPath).toBe(other.path);
  expect(partial.annotationSaved).toBe(true);
  expect(await f.vault.read(f.target)).toContain('> Words');
  expect(await f.vault.read(other)).toBe(original);
});
it('does not dispatch any native move during protected expiry or status transitions', async () => {
  const f = await fixture();
  f.vault.bytes.set(f.file, f.snapshot.raw.replace('Words', '==Words=='));
  const move = vi.spyOn(f.vault, 'move').mockRejectedValue(new Error('Must not run'));
  expect(await f.store.expire(new Date('2026-10-24'))).toEqual({
    deleted: 0,
    retained: 0,
    promoted: 1,
  });
  expect((await f.store.read(f.file.path)).properties.status).toBe('archive');
  expect(f.file.path).toBe(f.snapshot.path);
  expect(move).not.toHaveBeenCalled();
  expect(f.vault.trashed).toEqual([]);
});
it('blocks expiry if capture settings change while its initial read is pending', async () => {
  const f = await fixture(),
    read = f.vault.read.bind(f.vault);
  vi.spyOn(f.vault, 'read').mockImplementationOnce(async (file) => {
    const raw = await read(file);
    remap(f.store);
    return raw;
  });
  expect(await f.store.expire(new Date('2026-10-24'))).toEqual({
    deleted: 0,
    retained: 1,
    promoted: 0,
  });
  expect(f.vault.trashed).toEqual([]);
});
