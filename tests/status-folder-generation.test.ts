import { expect, it, vi } from 'vitest';
import { ArticleStore, PartialCollectionError, type NoteFile } from '../src/core/store';
import { createDocument, readDocument } from '../src/core/document';
import { MemoryVault, gate } from './helpers/memory-vault';

async function fixture(status = 'feed', folder = 'Reading/Stream') {
  const vault = new MemoryVault(),
    store = new ArticleStore(vault);
  const file = await vault.create(
    `${folder}/Article.md`,
    createDocument(
      {
        type: 'article',
        status,
        published: '2020-01-01',
        feed: '[[Subscription]]',
        url: 'https://example.com/a',
      },
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
  'freezes settings before the file lane for queued %s',
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

it('freezes generation before the collection lane, while letting a dispatched target write settle', async () => {
  const f = await fixture('inbox', 'Reading/Inbox');
  const entered = gate(),
    release = gate(),
    process = f.vault.process.bind(f.vault);
  vi.spyOn(f.vault, 'process').mockImplementation(async (file, update) => {
    const raw = await process(file, update);
    if (file === f.target) {
      entered.resolve();
      await release.promise;
    }
    return raw;
  });
  const first = f.store.collectHighlight(f.snapshot, edit, f.target.path, { guard: () => {} });
  await entered.promise;
  const second = f.store.collectHighlight(await f.store.read(f.file.path), edit, f.target.path, {
    guard: () => {},
  });
  const rejected = expect(second).rejects.toThrow(/folders changed/);
  remap(f.store);
  release.resolve();
  const saved = await first;
  expect(saved).not.toBeInstanceOf(Error);
  expect(saved.raw).toBe(await f.vault.read(f.file));
  await rejected;
  expect(await f.vault.read(f.target)).toContain('> Words');
});

it('records a completed target and stops before dispatching the next target after settings change', async () => {
  const f = await fixture('inbox', 'Reading/Inbox');
  const other = await f.vault.create(
    'Other.md',
    '---\nfileClass: Concept\n---\nOther authored text.\n',
  );
  const original = await f.vault.read(other);
  const process = f.vault.process.bind(f.vault);
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

it('rechecks generation inside the native status process callback', async () => {
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
  'records retention before rejecting settings changed after %s status save',
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
      expect(error.snapshot.raw).toBe(await f.vault.read(f.file));
    } else expect(error.message).toMatch(/Status saved as later/);
    const saved = await f.store.read(f.file.path);
    expect(saved.properties.status).toBe('later');
    expect(saved.body).toBe(f.snapshot.body);
    expect(saved.path).toBe(f.snapshot.path);
  },
);

it.each(['annotation', 'collection'] as const)(
  'preserves %s saved before settings change prevents relocation',
  async (kind) => {
    const f = await fixture(),
      process = f.vault.process.bind(f.vault);
    let calls = 0;
    vi.spyOn(f.vault, 'process').mockImplementation(async (...args) => {
      const raw = await process(...args);
      if (++calls === 2) remap(f.store);
      return raw;
    });
    const request =
      kind === 'annotation'
        ? f.store.annotate(f.snapshot, (raw) => raw.replace('Words', '==Words=='))
        : f.store.collectHighlight(f.snapshot, edit, f.target.path, { guard: () => {} });
    const error = await request.catch((error) => error);
    expect(error).toBeInstanceOf(Error);
    if (kind === 'collection') {
      expect(error).toBeInstanceOf(PartialCollectionError);
      expect(error.annotationSaved).toBe(true);
      expect(error.snapshot.raw).toBe(await f.vault.read(f.file));
    }
    expect((await f.store.read(f.file.path)).body).toContain('==Words==');
    expect(f.file.path).toBe(f.snapshot.path);
  },
);

it('checks settings at the final native move guard, retaining saved status', async () => {
  const f = await fixture();
  f.vault.beforeMove = async () => {
    remap(f.store);
  };
  await expect(f.store.move(f.snapshot, 'Later')).rejects.toThrow(/Status saved as later/);
  expect(readDocument(await f.vault.read(f.file)).properties.status).toBe('later');
  expect(f.file.path).toBe(f.snapshot.path);
});

it('does not falsely cancel a completed final rename; reconciles native bytes and actual catalog path', async () => {
  const f = await fixture(),
    move = f.vault.move.bind(f.vault);
  vi.spyOn(f.vault, 'move').mockImplementation(async (...args) => {
    await move(...args);
    f.vault.bytes.set(f.file, (await f.vault.read(f.file)).replace('./other.md', '../other.md'));
    remap(f.store);
  });
  const saved = await f.store.move(f.snapshot, 'Later');
  expect(saved.path).toBe('Reading/Later/Article.md');
  expect(saved.raw).toBe(await f.vault.read(f.file));
  expect(saved.body).toContain('../other.md');
  expect(f.store.catalog.article(saved.path)?.status).toBe('later');
  expect(f.store.catalog.article(f.snapshot.path)).toBeUndefined();
});

it.each(['move', 'annotation', 'related'] as const)(
  'rechecks settings after awaited no-op %s validation',
  async (kind) => {
    const f = await fixture('later', 'Reading/Later'),
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

it('fresh requests use the new mapping and invalid settings do not advance generation', async () => {
  const f = await fixture();
  const generation = f.store.statusFolderGeneration;
  expect(() => f.store.setStatusFolders({ later: 'Reading/Stream' })).toThrow();
  expect(f.store.statusFolderGeneration).toBe(generation);
  const saved = await f.store.move(f.snapshot, 'Later');
  remap(f.store);
  expect((await f.store.move(saved, 'Later')).path).toBe('New/Later/Article.md');
});

it('protected expiry delegates to a guarded move and never falls through to trash', async () => {
  const f = await fixture();
  f.vault.bytes.set(f.file, f.snapshot.raw.replace('Words', '==Words=='));
  f.vault.beforeMove = async () => {
    remap(f.store);
  };
  expect(await f.store.expire(new Date('2026-10-24'))).toEqual({
    deleted: 0,
    retained: 1,
    promoted: 0,
  });
  expect(f.vault.trashed).toEqual([]);
  expect(readDocument(await f.vault.read(f.file)).properties.status).toBe('archive');
});

it('reports actual postrename source bytes and destination phase when settings change during collection relocation', async () => {
  const f = await fixture(),
    move = f.vault.move.bind(f.vault),
    phases: string[] = [];
  vi.spyOn(f.vault, 'move').mockImplementation(async (...args) => {
    await move(...args);
    f.vault.bytes.set(
      f.file,
      (await f.vault.read(f.file)).replaceAll('[[Concept]]', '[[Concept|Native]]'),
    );
    remap(f.store);
  });
  const error = await f.store
    .collectHighlight(f.snapshot, edit, f.target.path, {
      guard: (phase) => {
        phases.push(phase);
      },
    })
    .catch((error) => error as PartialCollectionError<NoteFile>);
  expect(error).toBeInstanceOf(PartialCollectionError);
  const partial = error as PartialCollectionError<NoteFile>;
  expect(partial.annotationSaved).toBe(true);
  expect(partial.snapshot.path).toBe('Reading/Later/Article.md');
  expect(partial.snapshot.raw).toBe(await f.vault.read(f.file));
  expect(partial.snapshot.body).toContain('[[Concept|Native]]');
  expect(partial.completedDestinationPaths).toEqual([]);
  expect(phases.at(-1)).toBe('destination');
  expect(await f.vault.read(f.target)).not.toContain('## Highlights');
});

it('reports collision-resolution failure truthfully after saving status', async () => {
  const f = await fixture();
  Object.assign(f.vault, { exists: () => true });
  await expect(f.store.move(f.snapshot, 'Later')).rejects.toThrow(
    /Status saved as later.*Too many/,
  );
  expect(readDocument(await f.vault.read(f.file)).properties.status).toBe('later');
  expect(f.file.path).toBe(f.snapshot.path);
});

it('does not retarget protected expiry when folders change during its initial read', async () => {
  const f = await fixture(),
    read = f.vault.read.bind(f.vault);
  f.vault.bytes.set(f.file, f.snapshot.raw.replace('Words', '==Words=='));
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
  expect(f.file.path).toBe(f.snapshot.path);
  expect(readDocument(await f.vault.read(f.file)).properties.status).toBe('feed');
  expect(f.vault.trashed).toEqual([]);
});
