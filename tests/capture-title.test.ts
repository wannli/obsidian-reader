// @vitest-environment node
import { describe, expect, it, vi } from 'vitest';
import { ChangedNote, createDocument, patchProperties } from '../src/core/document';
import { filename } from '../src/core/model';
import { ArticleStore, type NoteFile } from '../src/core/store';
import { gate, MemoryVault } from './helpers/memory-vault';

const day = () => new Date(2026, 9, 13, 12);
const url = 'https://example.com/article';
const article = 'Acquired **article text**.';
async function setup(input: Parameters<ArticleStore<NoteFile>['capture']>[0] = { url }) {
  const vault = new MemoryVault(),
    store = new ArticleStore(vault);
  const file = await store.capture(input, day());
  return { vault, store, file, snapshot: await store.read(file.path) };
}

describe('session-only manual capture filenames', () => {
  it('saves first, then uses native link-aware move and returns/indexes the actual saved snapshot', async () => {
    const { vault, store, file, snapshot } = await setup();
    expect(snapshot.path).toBe('Reading/Inbox/261013 example.com.md');
    expect(snapshot.properties).toEqual({
      type: 'article',
      status: 'inbox',
      url,
      published: '2026-10-13T12:00',
    });
    const nativeMove = vault.move.bind(vault);
    const move = vi.spyOn(vault, 'move').mockImplementation(async (file, path) => {
      expect(await vault.read(file)).toContain(article);
      await nativeMove(file, path);
      store.noteRenamed(file);
      // A link-aware host may update self-links during rename.
      vault.bytes.set(file, (await vault.read(file)) + '\n[[261013 Publisher title]]\n');
    });
    const saved = await store.acquire(snapshot, article, '  Publisher title  ');
    expect(move).toHaveBeenCalledExactlyOnceWith(
      file,
      'Reading/Inbox/261013 Publisher title.md',
      expect.any(Function),
    );
    expect(saved).toEqual(await store.read(file.path));
    expect(saved.raw).toBe(await vault.read(file));
    expect(saved.properties).toEqual({
      type: 'article',
      status: 'inbox',
      url,
      title: 'Publisher title',
      published: '2026-10-13T12:00',
    });
    expect(saved.body).toContain('[[261013 Publisher title]]');
    expect(vault.file(snapshot.path)).toBeUndefined();
    expect(store.catalog.article(snapshot.path)).toBeUndefined();
    expect(store.catalog.findUrl(url)?.path).toBe(saved.path);
    expect(store.catalog.list('Inbox').map((row) => row.path)).toEqual([saved.path]);
    expect(await store.capture({ url })).toBe(file);
  });

  it('uses the creation date, sanitizes publisher titles, and preserves colliding files', async () => {
    const vault = new MemoryVault(),
      store = new ArticleStore(vault),
      date = day();
    const file = await store.capture({ url }, date);
    date.setFullYear(2030); // Caller-owned Date must not mutate the receipt.
    const title = 'An / unsafe: [title] #^?';
    const target = `Reading/Inbox/${filename(title, day())}`;
    const existing = await vault.create(target, 'User note');
    const existing2 = await vault.create(target.replace('.md', ' 2.md'), 'Another note');
    const saved = await store.acquire(await store.read(file.path), article, title);
    expect(saved.path).toBe(target.replace('.md', ' 3.md'));
    expect(await vault.read(existing)).toBe('User note');
    expect(await vault.read(existing2)).toBe('Another note');
    expect(saved.properties.title).toBe(title);
  });

  it.each(['example.com', 'Example.COM'])(
    'does not allocate a suffix or rename when %s already matches the own path',
    async (title) => {
      const { vault, store, snapshot } = await setup();
      Object.assign(vault, {
        exists: (path: string) =>
          [...vault.files.keys()].some((key) => key.toLowerCase() === path.toLowerCase()),
      });
      const move = vi.spyOn(vault, 'move');
      const saved = await store.acquire(snapshot, article, title);
      expect(saved.path).toBe(snapshot.path);
      expect(saved.properties.title).toBe(title);
      expect(move).not.toHaveBeenCalled();
    },
  );

  it('also preserves an own numbered filename when earlier collision candidates remain occupied', async () => {
    const { vault, store } = await setup();
    const file = await store.capture({ url: 'https://example.com/second' }, day());
    expect(file.path).toBe('Reading/Inbox/261013 example.com 2.md');
    Object.assign(vault, {
      exists: (path: string) =>
        [...vault.files.keys()].some((key) => key.toLowerCase() === path.toLowerCase()),
    });
    const move = vi.spyOn(vault, 'move');
    const saved = await store.acquire(await store.read(file.path), article, 'Example.COM');
    expect(saved.path).toBe('Reading/Inbox/261013 example.com 2.md');
    expect(move).not.toHaveBeenCalled();
  });

  it('uses optional host existence checks for case aliases and folders without overwriting either', async () => {
    const { vault, store, snapshot } = await setup();
    const folders = new Set(['Reading/Inbox/261013 TITLE 2.md']);
    const other = await vault.create('Reading/Inbox/261013 TITLE.md', 'User-owned bytes');
    Object.assign(vault, {
      exists: (path: string) =>
        [...vault.files.keys(), ...folders].some((key) => key.toLowerCase() === path.toLowerCase()),
    });
    const saved = await store.acquire(snapshot, article, 'Title');
    expect(saved.path).toBe('Reading/Inbox/261013 Title 3.md');
    expect(await vault.read(other)).toBe('User-owned bytes');
    expect(folders.size).toBe(1);
    const next = await store.capture({ url: 'https://example.com/next', title: 'title' }, day());
    expect(next.path).toBe('Reading/Inbox/261013 title 4.md');
  });

  it('never infers filename ownership after restart', async () => {
    const { vault, store, file, snapshot } = await setup();
    store.dispose();
    const restarted = new ArticleStore(vault);
    restarted.catalog.update(snapshot.path, snapshot.properties);
    const saved = await restarted.acquire(
      await restarted.read(file.path),
      article,
      'Publisher title',
    );
    expect(saved.path).toBe(snapshot.path);
    expect(saved.properties.title).toBe('Publisher title');
    expect(saved.body).toContain(article);
  });

  it('does not grant or keep a receipt for duplicate URL capture', async () => {
    const { store, file, snapshot } = await setup();
    expect(await store.capture({ url: `${url}#fragment`, title: 'Duplicate title' })).toBe(file);
    const saved = await store.acquire(snapshot, article, 'Publisher title');
    expect(saved.path).toBe(snapshot.path);
    expect(saved.properties.title).toBe('Publisher title');
  });

  it.each([
    { feed: '[[Reading/Feeds/Feed.md]]' },
    { prefix: 'Feed' },
    { queue: 'Feed' as const },
    { published: '2026-10-13' },
    { title: 'My chosen title' },
    { body: 'Current proven excerpt' },
  ])('never renames nonempty, explicitly titled, or feed-style captures: %j', async (input) => {
    const { store, snapshot } = await setup({ url, ...input });
    const saved = await store.acquire(snapshot, article, 'Publisher title', snapshot.body);
    expect(saved.path).toBe(snapshot.path);
    expect(saved.properties.title).toBe(input.title ?? 'Publisher title');
  });

  it.each(['My title', '', '   ', null, 42])(
    'preserves every explicit user title, including %j',
    async (title) => {
      const { vault, store, file } = await setup();
      vault.bytes.set(
        file,
        patchProperties(await vault.read(file), { title, custom: 'Preserve me' }),
      );
      const snapshot = await store.read(file.path);
      const saved = await store.acquire(snapshot, article, 'Publisher title');
      expect(saved.path).toBe(snapshot.path);
      expect(saved.properties.title).toBe(title);
      expect(saved.properties.custom).toBe('Preserve me');
    },
  );

  it('keeps eligibility across failed writes and acquisition error metadata, without persisting ownership', async () => {
    const { vault, store, file, snapshot } = await setup();
    vault.failWrite = true;
    await expect(store.acquire(snapshot, article, 'Title')).rejects.toThrow('Disk full');
    expect(await vault.read(file)).toBe(snapshot.raw);
    vault.failWrite = false;
    const failed = await store.error(snapshot, 'Offline');
    expect(failed.properties).toEqual({
      type: 'article',
      status: 'inbox',
      url,
      error: 'Offline',
      published: '2026-10-13T12:00',
    });
    const saved = await store.acquire(failed, article, 'Title');
    expect(saved.path).toBe('Reading/Inbox/261013 Title.md');
    expect(saved.properties).toEqual({
      type: 'article',
      status: 'inbox',
      url,
      title: 'Title',
      published: '2026-10-13T12:00',
    });
  });

  it('consumes a receipt on success even when the publisher supplied no title', async () => {
    const { store, snapshot } = await setup();
    const saved = await store.acquire(snapshot, article, '');
    const retry = await store.acquire(saved, 'Later acquired text.', 'Later title', saved.body);
    expect(retry.path).toBe(snapshot.path);
    expect(retry.properties.title).toBe('Later title');
  });

  it.each(['noop', 'failed', 'moved'] as const)(
    'explicit %s moves conservatively invalidate ownership',
    async (kind) => {
      const { vault, store, file, snapshot } = await setup();
      if (kind === 'failed') {
        vault.failWrite = true;
        await expect(store.move(snapshot, 'Later')).rejects.toThrow('Disk full');
        vault.failWrite = false;
      } else await store.move(snapshot, kind === 'noop' ? 'Inbox' : 'Later');
      const path = file.path;
      expect((await store.acquire(await store.read(path), article, 'Title')).path).toBe(path);
    },
  );

  it('preserves native user renames, including a rename back after the change was observed', async () => {
    const { vault, store, file, snapshot } = await setup();
    await vault.move(file, 'Reading/Inbox/My filename.md');
    await expect(store.acquire(snapshot, article, 'Title')).rejects.toThrow(ChangedNote);
    await vault.move(file, snapshot.path);
    expect((await store.acquire(await store.read(file.path), article, 'Title')).path).toBe(
      snapshot.path,
    );
  });

  it('revokes the receipt on host rename events even after an unobserved rename back', async () => {
    const { vault, store, file, snapshot } = await setup();
    await vault.move(file, 'Reading/Inbox/User filename.md');
    store.noteRenamed(file);
    await vault.move(file, snapshot.path);
    store.noteRenamed(file);
    // No store read or mutation observed the intermediate filename.
    const move = vi.spyOn(vault, 'move');
    const saved = await store.acquire(snapshot, article, 'Publisher title');
    expect(saved.path).toBe(snapshot.path);
    expect(saved.properties.title).toBe('Publisher title');
    expect(saved.body).toContain(article);
    expect(move).not.toHaveBeenCalled();
  });

  it('does not transfer a receipt to a replacement file at the same path', async () => {
    const { vault, store, file, snapshot } = await setup();
    await vault.trash(file);
    const replacement = await vault.create(snapshot.path, snapshot.raw);
    await expect(store.acquire(snapshot, article, 'Title')).rejects.toThrow(ChangedNote);
    const saved = await store.acquire(await store.read(replacement.path), article, 'Title');
    expect(saved.file).toBe(replacement);
    expect(saved.path).toBe(snapshot.path);
  });

  it('rejects stale acquisitions without losing user text', async () => {
    const { vault, store, file, snapshot } = await setup();
    vault.bytes.set(file, snapshot.raw + '\nMy own text.\n');
    await expect(store.acquire(snapshot, article, 'Title')).rejects.toThrow(ChangedNote);
    expect(await vault.read(file)).toBe(snapshot.raw + '\nMy own text.\n');
    expect(file.path).toBe(snapshot.path);
  });

  it('skips rename if the just-saved revision changes or a native editor opens', async () => {
    for (const dirty of [false, true]) {
      const { vault, store, file, snapshot } = await setup();
      const process = vault.process.bind(vault),
        move = vi.spyOn(vault, 'move');
      vi.spyOn(vault, 'process').mockImplementation(async (file, update) => {
        const raw = await process(file, update);
        if (dirty) vault.dirty.add(file);
        else
          vault.bytes.set(
            file,
            patchProperties(raw + '\nUser comment.\n', { title: 'User title' }),
          );
        return raw;
      });
      const saved = await store.acquire(snapshot, article, 'Publisher title');
      expect(move).not.toHaveBeenCalled();
      expect(saved).toEqual(await store.read(file.path));
      expect(saved.path).toBe(snapshot.path);
      expect(saved.body).toContain(article);
      expect(store.catalog.article(saved.path)?.title).toBe(
        dirty ? 'Publisher title' : 'User title',
      );
    }
  });

  it.each([false, true])(
    'keeps saved text and the actual path when native rename rejects (after move: %s)',
    async (afterMove) => {
      const { vault, store, file, snapshot } = await setup();
      const nativeMove = vault.move.bind(vault);
      const move = vi.spyOn(vault, 'move').mockImplementation(async (file, path) => {
        if (afterMove) await nativeMove(file, path);
        throw new Error('Native rename failed');
      });
      const saved = await store.acquire(snapshot, article, 'Title');
      expect(saved.path).toBe(afterMove ? 'Reading/Inbox/261013 Title.md' : snapshot.path);
      expect(saved.raw).toBe(await vault.read(file));
      expect(saved.body).toContain(article);
      expect(store.catalog.findUrl(url)?.path).toBe(saved.path);
      expect(store.catalog.size).toBe(1);
      // Even clearing the title/body cannot revive a consumed receipt.
      vault.bytes.set(file, createDocument({ type: 'article', url }));
      expect((await store.acquire(await store.read(file.path), article, 'Other title')).path).toBe(
        saved.path,
      );
      expect(move).toHaveBeenCalledTimes(1);
    },
  );

  it('safely retains the hostname filename when a folder collision is invisible to VaultPort.file', async () => {
    const { vault, store, snapshot } = await setup();
    const folders = new Set(['Reading/Inbox/261013 Title.md']);
    const nativeMove = vault.move.bind(vault);
    vi.spyOn(vault, 'move').mockImplementation(async (file, path) => {
      if (folders.has(path)) throw new Error('Folder exists');
      return nativeMove(file, path);
    });
    const saved = await store.acquire(snapshot, article, 'Title');
    expect(saved.path).toBe(snapshot.path);
    expect(saved.body).toContain(article);
    expect(folders.size).toBe(1);
  });
});

describe('capture naming concurrency', () => {
  it('serializes concurrent acquisitions by identity', async () => {
    const { vault, store, snapshot } = await setup();
    const move = vi.spyOn(vault, 'move');
    const results = await Promise.allSettled([
      store.acquire(snapshot, article, 'First title'),
      store.acquire(snapshot, 'Second body', 'Second title'),
    ]);
    expect(results.map((result) => result.status)).toEqual(['fulfilled', 'rejected']);
    expect(move).toHaveBeenCalledTimes(1);
    expect((await store.read(snapshot.file.path)).body).toContain(article);
  });

  it('serializes same-title acquisition targets across files', async () => {
    const { vault, store, snapshot } = await setup();
    const second = await store.capture({ url: 'https://other.example/two' }, day());
    const saved = await Promise.all([
      store.acquire(snapshot, article, 'Same title'),
      store.acquire(await store.read(second.path), 'Second body', 'Same title'),
    ]);
    expect(saved.map((note) => note.path).sort()).toEqual([
      'Reading/Inbox/261013 Same title 2.md',
      'Reading/Inbox/261013 Same title.md',
    ]);
    expect(vault.files.size).toBe(2);
    expect(saved.map((note) => note.body)).toEqual([`\n${article}\n`, '\nSecond body\n']);
  });

  it('shares filename allocation with capture while the native rename is pending', async () => {
    const { vault, store, snapshot } = await setup();
    const entered = gate(),
      release = gate();
    vault.beforeMove = async () => {
      entered.resolve();
      await release.promise;
    };
    const acquisition = store.acquire(snapshot, article, 'Same title');
    await entered.promise;
    const capture = store.capture({ url: 'https://other.example/two', title: 'Same title' }, day());
    release.resolve();
    const [saved, created] = await Promise.all([acquisition, capture]);
    expect(saved.path).toBe('Reading/Inbox/261013 Same title.md');
    expect(created.path).toBe('Reading/Inbox/261013 Same title 2.md');
  });

  it('invalidates immediately when an explicit move is requested during acquisition', async () => {
    const { vault, store, snapshot } = await setup();
    const entered = gate(),
      release = gate(),
      process = vault.process.bind(vault);
    vi.spyOn(vault, 'process').mockImplementation(async (file, update) => {
      const raw = await process(file, update);
      entered.resolve();
      await release.promise;
      return raw;
    });
    const acquisition = store.acquire(snapshot, article, 'Title');
    await entered.promise;
    const moving = store.move(snapshot, 'Later');
    const moveCheck = expect(moving).rejects.toThrow(ChangedNote);
    release.resolve();
    expect((await acquisition).path).toBe(snapshot.path);
    await moveCheck;
  });

  it('forwards the create guard so the host can recheck after async folder preparation', async () => {
    const vault = new MemoryVault(),
      store = new ArticleStore(vault);
    const entered = gate(),
      release = gate(),
      create = vault.create.bind(vault);
    let allowed = true;
    const guard = vi.fn(() => {
      if (!allowed) throw new Error('Cancelled');
    });
    vi.spyOn(vault, 'create').mockImplementation(
      async (path, raw, boundaryGuard?: () => void | Promise<void>) => {
        entered.resolve();
        await release.promise;
        await boundaryGuard?.();
        return create(path, raw);
      },
    );
    const capture = store.capture({ url }, day(), guard);
    const check = expect(capture).rejects.toThrow('Cancelled');
    await entered.promise;
    allowed = false;
    release.resolve();
    await check;
    expect(guard).toHaveBeenCalledTimes(2);
    expect(vault.files.size).toBe(0);
    expect(store.catalog.size).toBe(0);
  });
});

describe('expiry metadata prefilter', () => {
  it('does zero body reads for 10,000 fresh Feed entries and unknown-age notes', async () => {
    const vault = new MemoryVault(),
      store = new ArticleStore(vault);
    for (let i = 0; i < 10_000; i++) {
      const path = `Reading/Stream/260101 Fresh ${i}.md`;
      const properties = { type: 'article', status: 'feed', published: '2026-10-01' };
      await vault.create(path, createDocument(properties, 'Fresh ==annotation==.'));
      store.catalog.update(path, properties);
    }
    for (const path of [
      'Reading/Stream/Unknown age.md',
      'Reading/Stream/260913 Cutoff.md',
      'Reading/Stream/261001 Fresh filename.md',
    ]) {
      const properties = { type: 'article', status: 'feed' };
      await vault.create(path, createDocument(properties));
      store.catalog.update(path, properties);
    }
    const read = vi.spyOn(vault, 'read');
    expect(await store.expire(new Date('2026-10-13T00:00:00Z'))).toEqual({
      deleted: 0,
      promoted: 0,
      retained: 0,
    });
    expect(read).not.toHaveBeenCalled();
  });

  it('still rereads old candidates, archives annotations, and checks current publication before trash', async () => {
    const vault = new MemoryVault(),
      store = new ArticleStore(vault);
    const annotated = await store.capture({
      url,
      queue: 'Feed',
      published: '2026-08-01',
      body: 'My ==highlight==.',
    });
    const changed = await store.capture({
      url: 'https://example.com/new-date',
      queue: 'Feed',
      published: '2026-08-01',
      body: 'Fresh now.',
    });
    vault.bytes.set(
      changed,
      patchProperties(await vault.read(changed), { published: '2026-10-01' }),
    );
    const old = await store.capture({
      url: 'https://example.com/old',
      queue: 'Feed',
      published: '2026-08-01',
      body: 'Old article.',
    });
    expect(await store.expire(new Date('2026-10-13T00:00:00Z'))).toEqual({
      deleted: 1,
      promoted: 1,
      retained: 0,
    });
    expect(annotated.path).toMatch(/^Reading\/Treasury\//);
    expect((await store.read(annotated.path)).properties.status).toBe('archive');
    expect((await store.read(annotated.path)).body).toContain('==highlight==');
    expect(vault.file(changed.path)).toBe(changed);
    expect(vault.trashed).toEqual([old.path]);
  });
});
