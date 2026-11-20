import { expect, it, vi } from 'vitest';
import { ArticleStore } from '../src/core/store';
import { createDocument, patchProperties } from '../src/core/document';
import {
  loadStatusFolders,
  saveStatusFolderSettings,
  validateStatusFolders,
} from '../src/core/status-folders';
import { MemoryVault } from './helpers/memory-vault';

async function fixture(status = 'feed') {
  const vault = new MemoryVault(),
    store = new ArticleStore(vault);
  const file = await vault.create(
    'Source/Article.md',
    createDocument(
      { type: 'article', status, bookmark: 'Words', custom: { keep: true } },
      'Words and [local](./other.md).',
    ),
  );
  const snapshot = await store.read(file.path);
  store.catalog.update(file.path, snapshot.properties);
  return { vault, store, file, snapshot };
}
it('loads capture defaults and preserves unrelated settings', () => {
  const defaults = {
    inbox: 'Reading/Inbox',
    feed: 'Reading/Stream',
    later: 'Reading/Later',
    archive: 'Reading/Treasury',
  };
  expect(loadStatusFolders({ folders: { later: 'Legacy' } })).toEqual(defaults);
  expect(
    saveStatusFolderSettings({ other: 1, statusFolders: { future: 'Keep' } }, { inbox: 'New' }),
  ).toEqual({ other: 1, statusFolders: { future: 'Keep', ...defaults, inbox: 'New' } });
});
it.each([
  '../x',
  '/absolute',
  'A//B',
  '.obsidian',
  'Bad\\Path',
  null,
  '',
  'Templates/Queue',
  '.trash/Queue',
  'Reading/Stream/Sub',
])('rejects unsafe capture mapping %j', (path) => {
  expect(() => validateStatusFolders({ later: path })).toThrow();
});
it.each(['Inbox', 'Feed', 'Later', 'Archive'] as const)(
  'changes YAML to %s without relocating or rewriting content',
  async (queue) => {
    const f = await fixture('unknown');
    f.store.setStatusFolders({ inbox: 'Inbox', feed: 'Feed', later: 'Later', archive: 'Archive' });
    const move = vi.spyOn(f.vault, 'move');
    const saved = await f.store.move(f.snapshot, queue);
    expect(saved.path).toBe(f.snapshot.path);
    expect(saved.body).toBe(f.snapshot.body);
    expect(saved.properties).toEqual({ ...f.snapshot.properties, status: queue.toLowerCase() });
    expect(f.store.catalog.article(saved.path)?.queue).toBe(queue);
    expect(move).not.toHaveBeenCalled();
  },
);
it('capture settings do not reclassify, move, or write existing notes', async () => {
  const f = await fixture('later');
  const process = vi.spyOn(f.vault, 'process'),
    move = vi.spyOn(f.vault, 'move');
  f.store.setStatusFolders({ later: 'Mapped' });
  expect(f.store.catalog.article(f.file.path)?.queue).toBe('Later');
  expect(process).not.toHaveBeenCalled();
  expect(move).not.toHaveBeenCalled();
  expect((await f.store.move(f.snapshot, 'Later')).raw).toBe(f.snapshot.raw);
});
it('ignores destination collisions and native rename failures for status-only transitions', async () => {
  const f = await fixture();
  const existing = await f.vault.create('Reading/Later/Article.md', 'Keep me');
  f.vault.failMove = true;
  const saved = await f.store.move(f.snapshot, 'Later');
  expect(saved.path).toBe(f.snapshot.path);
  expect(await f.vault.read(existing)).toBe('Keep me');
  expect(saved.properties.status).toBe('later');
});
it('creates new captures in the configured destinations, independent of status actions', async () => {
  const f = await fixture();
  f.store.setStatusFolders({ inbox: 'Mapped' });
  expect((await f.store.capture({ url: 'https://example.com/manual' })).path).toMatch(/^Mapped\//);
  expect((await f.store.capture({ url: 'https://example.com/feed', queue: 'Feed' })).path).toMatch(
    /^Reading\/Stream\//,
  );
});
it.each(['feed', '', 'archive'])(
  'only promotes explicit feed annotations, preserving relative links and path: %s',
  async (status) => {
    const f = await fixture(status);
    f.vault.failMove = true;
    const saved = await f.store.annotate(f.snapshot, (raw) =>
      raw.replace('Words and', '==Words== and'),
    );
    expect(saved.path).toBe(f.snapshot.path);
    expect(saved.body).toBe('==Words== and [local](./other.md).');
    expect(saved.properties.status).toBe(status === 'feed' ? 'later' : status);
  },
);
it.each(['dirty', 'stale', 'cancel', 'stopped', 'renamed'] as const)(
  'guards %s changes before the status commit',
  async (kind) => {
    const f = await fixture();
    if (kind === 'dirty') f.vault.dirty.add(f.file);
    if (kind === 'stale')
      f.vault.bytes.set(f.file, patchProperties(f.snapshot.raw, { custom: 'New' }));
    if (kind === 'stopped') f.store.dispose();
    if (kind === 'renamed') await f.vault.move(f.file, 'User.md');
    await expect(
      f.store.move(f.snapshot, 'Later', () => {
        if (kind === 'cancel') throw new Error('Cancelled');
      }),
    ).rejects.toThrow();
    expect(await f.vault.read(f.file)).not.toContain('status: "later"');
  },
);
