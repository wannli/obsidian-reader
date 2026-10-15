import { expect, it, vi } from 'vitest';
import { ArticleStore } from '../src/core/store';
import { createDocument, patchProperties, readDocument } from '../src/core/document';
import {
  loadStatusFolders,
  saveStatusFolderSettings,
  validateStatusFolders,
} from '../src/core/status-folders';
import { MemoryVault } from './helpers/memory-vault';

async function fixture(status: string | undefined = 'feed') {
  const vault = new MemoryVault(),
    store = new ArticleStore(vault);
  const file = await vault.create(
    'Source/Article.md',
    createDocument(
      { type: 'article', ...(status ? { status } : {}), bookmark: 'Words', custom: { keep: true } },
      'Words and [local](./other.md).',
    ),
  );
  const snapshot = await store.read(file.path);
  store.catalog.update(file.path, snapshot.properties);
  return { vault, store, file, snapshot };
}

it('distinguishes absent mappings from vault root and preserves unknown settings inert', () => {
  expect(loadStatusFolders({ folders: { later: 'Legacy' } })).toEqual({});
  expect(validateStatusFolders({ later: '', feed: 'Shared/Nested', archive: 'Shared' })).toEqual({
    later: '',
    feed: 'Shared/Nested',
    archive: 'Shared',
  });
  expect(
    saveStatusFolderSettings(
      { other: 1, statusFolders: { later: 'Old', future: 'Keep' } },
      { inbox: 'New' },
    ),
  ).toEqual({ other: 1, statusFolders: { future: 'Keep', inbox: 'New' } });
});
it.each(['../x', '/absolute', 'A//B', '.obsidian', 'Bad\\Path', null])(
  'rejects unsafe mapping %j',
  (path) => {
    expect(() => validateStatusFolders({ later: path })).toThrow();
  },
);
it.each(['Inbox', 'Feed', 'Later', 'Archive'] as const)(
  'maps Reader transition to %s without rewriting content',
  async (queue) => {
    const f = await fixture('unknown');
    f.store.setStatusFolders({ inbox: 'Inbox', feed: 'Feed', later: 'Later', archive: 'Archive' });
    const saved = await f.store.move(f.snapshot, queue);
    expect(saved.path).toBe(`${queue}/Article.md`);
    expect(saved.body).toBe(f.snapshot.body);
    expect(saved.properties).toEqual({ ...f.snapshot.properties, status: queue.toLowerCase() });
    expect(f.store.catalog.article(f.snapshot.path)).toBeUndefined();
    expect(f.store.catalog.article(saved.path)?.status).toBe(queue.toLowerCase());
  },
);
it('leaves unmapped and unchanged statuses in place; settings do not write', async () => {
  const f = await fixture('later');
  const process = vi.spyOn(f.vault, 'process'),
    move = vi.spyOn(f.vault, 'move');
  f.store.setStatusFolders({ later: 'Mapped' });
  expect(process).not.toHaveBeenCalled();
  expect(move).not.toHaveBeenCalled();
  expect((await f.store.move(f.snapshot, 'Later')).path).toBe(f.snapshot.path);
  expect((await f.store.move(await f.store.read(f.file.path), 'Archive')).path).toBe(
    f.snapshot.path,
  );
  expect(move).not.toHaveBeenCalled();
});
it('supports root, shared folder and collision suffix without overwriting', async () => {
  const f = await fixture();
  f.store.setStatusFolders({ later: '', archive: '' });
  const existing = await f.vault.create('Article.md', 'Keep me');
  const saved = await f.store.move(f.snapshot, 'Later');
  expect(saved.path).toBe('Article 2.md');
  expect(await f.vault.read(existing)).toBe('Keep me');
  expect((await f.store.move(saved, 'Archive')).path).toBe(saved.path);
});
it('creates mapped captures directly; unmapped creation retains capture destination', async () => {
  const f = await fixture();
  f.store.setStatusFolders({ inbox: 'Mapped', feed: '' });
  expect((await f.store.capture({ url: 'https://example.com/manual' })).path).toMatch(/^Mapped\//);
  expect(
    (await f.store.capture({ url: 'https://example.com/feed', queue: 'Feed' })).path,
  ).not.toContain('/');
  expect(
    (await f.store.capture({ url: 'https://example.com/later', queue: 'Later' })).path,
  ).toMatch(/^Reading\/Articles\//);
});
it.each(['feed', undefined])('promotes %s and relocates before annotating', async (status) => {
  const f = await fixture(status ?? '');
  f.store.setStatusFolders({ later: 'Retained' });
  const saved = await f.store.annotate(f.snapshot, (raw) =>
    raw.replace('Words and', '==Words== and'),
  );
  expect(saved.path).toBe('Retained/Article.md');
  expect(saved.body).toContain('==Words==');
  expect(saved.properties.status).toBe('later');
});
it('move failure retains status and already-saved annotation', async () => {
  const f = await fixture();
  f.store.setStatusFolders({ later: 'Retained' });
  f.vault.failMove = true;
  await expect(
    f.store.annotate(f.snapshot, (raw) => raw.replace('Words and', '==Words== and')),
  ).rejects.toThrow(/Status saved as later/);
  const saved = await f.store.read(f.file.path);
  expect(saved.properties.status).toBe('later');
  expect(saved.body).toContain('==Words==');
});
it('native relative-link rewriting follows the annotation commit, preserving both', async () => {
  const f = await fixture();
  f.store.setStatusFolders({ later: 'Retained' });
  const move = f.vault.move.bind(f.vault);
  f.vault.move = async (...args) => {
    await move(...args);
    f.vault.bytes.set(
      f.file,
      (await f.vault.read(f.file)).replace('./other.md', '../Source/other.md'),
    );
  };
  await f.store.annotate(f.snapshot, (raw) => raw.replace('Words and', '==Words== and'));
  const saved = await f.store.read(f.file.path);
  expect(saved.properties.status).toBe('later');
  expect(saved.body).toContain('../Source/other.md');
  expect(saved.body).toContain('==Words==');
});
it('rejects a postrename status race without a stale annotation commit', async () => {
  const f = await fixture();
  f.store.setStatusFolders({ later: 'Retained' });
  const move = f.vault.move.bind(f.vault);
  const process = vi.spyOn(f.vault, 'process');
  f.vault.move = async (...args) => {
    await move(...args);
    f.vault.bytes.set(f.file, patchProperties(await f.vault.read(f.file), { status: 'feed' }));
  };
  await expect(
    f.store.annotate(f.snapshot, (raw) => raw.replace('Words and', '==Words== and')),
  ).rejects.toThrow();
  // The annotation was committed only before the native rename and external edit.
  expect(process).toHaveBeenCalledTimes(2);
  expect(readDocument(await f.vault.read(f.file)).properties.status).toBe('feed');
});

it('reconciles a native rename that succeeds then rejects', async () => {
  const f = await fixture();
  f.store.setStatusFolders({ later: 'Retained' });
  const move = f.vault.move.bind(f.vault);
  f.vault.move = async (...args) => {
    await move(...args);
    throw new Error('Late native failure');
  };
  await expect(f.store.move(f.snapshot, 'Later')).rejects.toThrow(/Status saved/);
  expect(f.file.path).toBe('Retained/Article.md');
  expect(f.store.catalog.article(f.snapshot.path)).toBeUndefined();
  expect(f.store.catalog.article(f.file.path)?.status).toBe('later');
});
it.each(['dirty', 'stale', 'cancel', 'stopped', 'renamed'] as const)(
  'guards %s changes at move boundary',
  async (kind) => {
    const f = await fixture();
    f.store.setStatusFolders({ later: 'Retained' });
    let cancelled = false;
    f.vault.beforeMove = async () => {
      if (kind === 'dirty') f.vault.dirty.add(f.file);
      if (kind === 'stale')
        f.vault.bytes.set(f.file, (await f.vault.read(f.file)) + 'New user text');
      if (kind === 'cancel') cancelled = true;
      if (kind === 'stopped') f.store.dispose();
      if (kind === 'renamed') {
        f.vault.files.delete(f.file.path);
        f.file.path = 'User.md';
        f.vault.files.set(f.file.path, f.file);
      }
    };
    await expect(
      f.store.move(f.snapshot, 'Later', () => {
        if (cancelled) throw new Error('Cancelled');
      }),
    ).rejects.toThrow();
    expect(f.file.path).not.toBe('Retained/Article.md');
    expect(readDocument(await f.vault.read(f.file)).properties.status).toBe('later');
  },
);
it('rejects stale input before changing status or moving', async () => {
  const f = await fixture();
  f.store.setStatusFolders({ later: 'Retained' });
  f.vault.bytes.set(f.file, patchProperties(f.snapshot.raw, { custom: 'New' }));
  await expect(f.store.move(f.snapshot, 'Later')).rejects.toThrow();
  expect(f.file.path).toBe(f.snapshot.path);
  expect(readDocument(await f.vault.read(f.file)).properties.status).toBe('feed');
});
