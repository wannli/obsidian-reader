// @vitest-environment node
import { describe, expect, it, vi } from 'vitest';
import { Lexer } from 'marked';
import { Catalog, ReadingQueue } from '../src/core/catalog';
import { addHighlight, locateSelection } from '../src/core/annotations';
import { ChangedNote, readDocument, replaceBody } from '../src/core/document';
import { ArticleStore } from '../src/core/store';
import { SerialWrites, WorkQueue } from '../src/core/work';
import { gate, MemoryVault } from './helpers/memory-vault';

async function setup(queue: 'Inbox' | 'Feed' = 'Feed') {
  const vault = new MemoryVault(),
    store = new ArticleStore(vault);
  const file = await store.capture({
    url: 'https://example.com/one',
    title: 'One',
    body: 'A meaningful passage.',
    queue,
    published: '2026-08-01',
  });
  return { vault, store, file, snapshot: await store.read(file.path) };
}
function highlight(raw: string): string {
  const body = readDocument(raw).body,
    range = locateSelection(body, 'meaningful passage');
  return replaceBody(raw, body, addHighlight(body, range.from, range.to));
}

describe('dog-ear handoff', () => {
  it('marks the destination, removes the old marker and preserves independent bookmarks', async () => {
    const { store, vault, file } = await setup('Inbox');
    const second = await store.capture({ url: 'https://example.com/two', queue: 'Inbox' });
    await store.position(file.path, 'A meaningful passage.');
    await store.dogEar(file.path);
    await store.dogEar(second.path);
    expect((await store.read(file.path)).properties).toMatchObject({
      bookmark: 'A meaningful passage.',
    });
    expect((await store.read(file.path)).properties).not.toHaveProperty('dog_ear');
    expect((await store.read(second.path)).properties.dog_ear).toBe(true);
    expect(
      [...store.catalog.values()].filter((item) => item.dogEar).map((item) => item.path),
    ).toEqual([second.path]);
    expect(vault.files.size).toBe(2);
  });
  it('retains both pointers rather than overwriting unsafe old-note bytes after marking a new article', async () => {
    const { store, vault, file } = await setup();
    const second = await store.capture({ url: 'https://example.com/two' });
    await store.dogEar(file.path);
    const process = vault.process.bind(vault);
    vault.process = async (target, update) => {
      if (target === file) throw new Error('Old note is not writable');
      return process(target, update);
    };
    await expect(store.dogEar(second.path)).rejects.toThrow('Old note is not writable');
    expect((await store.read(file.path)).properties.dog_ear).toBe(true);
    expect((await store.read(second.path)).properties.dog_ear).toBe(true);
    vault.process = process;
    await store.dogEar(second.path);
    expect((await store.read(file.path)).properties).not.toHaveProperty('dog_ear');
  });
  it('leaves the old marker if the destination is unsafe or its write fails', async () => {
    const { store, vault, file } = await setup();
    const second = await store.capture({ url: 'https://example.com/two' });
    await store.dogEar(file.path);
    vault.failWrite = true;
    await expect(store.dogEar(second.path)).rejects.toThrow('Disk full');
    vault.failWrite = false;
    expect((await store.read(file.path)).properties.dog_ear).toBe(true);
    expect((await store.read(second.path)).properties).not.toHaveProperty('dog_ear');
    vault.bytes.set(
      second,
      (await vault.read(second)).replace('type: article', 'type: article\ndog_ear: other'),
    );
    await expect(store.dogEar(second.path)).rejects.toThrow('Unsupported dog_ear');
    expect((await store.read(file.path)).properties.dog_ear).toBe(true);
  });
});

describe('guarded article operations', () => {
  it('rechecks capture-modal cancellation immediately before moving a duplicate to Inbox', async () => {
    const { vault, store, file, snapshot } = await setup();
    const original = file.path;
    let cancelled = false;
    const read = vault.read.bind(vault);
    vault.read = async (target) => {
      const raw = await read(target);
      cancelled = true;
      return raw;
    };
    await expect(
      store.move(snapshot, 'Inbox', () => {
        if (cancelled) throw new Error('cancelled');
      }),
    ).rejects.toThrow('cancelled');
    expect(file.path).toBe(original);
    expect(vault.files.size).toBe(1);
  });
  it('captures immediately without network and deduplicates simultaneous requests', async () => {
    const vault = new MemoryVault(),
      store = new ArticleStore(vault);
    const files = await Promise.all(
      Array.from({ length: 20 }, () => store.capture({ url: 'https://example.com/offline' })),
    );
    expect(new Set(files).size).toBe(1);
    expect(vault.files.size).toBe(1);
    expect((await store.read(files[0].path)).body).toBe('');
  });
  it('deduplicates after queue moves and permits reimport after deletion', async () => {
    const { store, file, snapshot } = await setup();
    const moved = await store.move(snapshot, 'Archive');
    expect(await store.capture({ url: 'https://example.com/one' })).toBe(file);
    await store.trash(moved);
    expect(await store.capture({ url: 'https://example.com/one' })).not.toBe(file);
  });
  it('promotes Stream before saving an annotation', async () => {
    const { store, file, snapshot } = await setup();
    const saved = await store.annotate(snapshot, highlight);
    expect((await store.read(file.path)).properties.status).toBe('later');
    expect(saved.body).toContain('==meaningful passage==');
    expect(store.catalog.article(file.path)?.queue).toBe('Later');
  });
  it('invalid/no-op annotation attempts never move an article', async () => {
    const { store, file, snapshot } = await setup();
    await expect(
      store.annotate(snapshot, () => {
        throw new Error('Invalid selection');
      }),
    ).rejects.toThrow();
    await store.annotate(snapshot, (raw) => raw);
    expect(file.path).toBe(snapshot.path);
    expect((await store.read(file.path)).properties.status).toBe('feed');
  });
  it('a failed move prevents annotation; a failed save retains the promoted article', async () => {
    const { store, vault, file, snapshot } = await setup();
    vault.failWrite = true;
    await expect(store.annotate(snapshot, highlight)).rejects.toThrow('Disk full');
    expect(await vault.read(file)).toBe(snapshot.raw);
    vault.failWrite = false;
    const process = vault.process.bind(vault);
    let writes = 0;
    vault.process = async (target, update) => {
      if (++writes === 2) throw new Error('Annotation failed');
      return process(target, update);
    };
    await expect(store.annotate(snapshot, highlight)).rejects.toThrow('Annotation failed');
    expect(file.path).toBe(snapshot.path);
    expect((await store.read(file.path)).properties.status).toBe('later');
    expect((await store.read(file.path)).body).toBe(snapshot.body);
    expect((await store.expire(new Date('2026-10-13'))).deleted).toBe(0);
  });
  it('does not expire an annotation/promotion in flight', async () => {
    const { store, vault, file, snapshot } = await setup();
    const moving = gate(),
      entered = gate();
    const process = vault.process.bind(vault);
    vault.process = async (target, update) => {
      entered.resolve();
      await moving.promise;
      return process(target, update);
    };
    const saving = store.annotate(snapshot, highlight);
    await entered.promise;
    expect((await store.expire(new Date('2026-10-13'))).deleted).toBe(0);
    expect(vault.trashed).toEqual([]);
    moving.resolve();
    await saving;
    expect((await store.read(file.path)).properties.status).toBe('later');
  });
  it('rejects stale source, replaced identity, and unfinished native edits', async () => {
    const { store, vault, file, snapshot } = await setup('Inbox');
    vault.bytes.set(file, snapshot.raw + 'external edit');
    await expect(store.annotate(snapshot, highlight)).rejects.toThrow(ChangedNote);
    vault.bytes.set(file, snapshot.raw);
    vault.dirty.add(file);
    await expect(store.annotate(snapshot, highlight)).rejects.toThrow(/unfinished/);
    vault.dirty.clear();
    vault.files.set(file.path, { path: file.path });
    await expect(store.trash(snapshot)).rejects.toThrow(ChangedNote);
    expect(vault.trashed).toEqual([]);
  });
  it('never lets a stale reading-position save overwrite a newer body edit', async () => {
    const { store, vault, file, snapshot } = await setup('Inbox');
    vault.bytes.set(file, snapshot.raw + 'external edit');
    const saved = await store.position(file.path, 'A meaningful passage.');
    expect(saved.body).toContain('external edit');
    expect(saved.properties.bookmark).toBe('A meaningful passage.');
  });
  it('expiry promotes source-authored annotations, ignores publisher links, and uses recoverable trash', async () => {
    const { store, vault } = await setup();
    await store.capture({
      url: 'https://example.com/two',
      body: 'An ==annotated passage==.',
      queue: 'Feed',
      published: '2026-08-01',
    });
    await store.capture({
      url: 'https://example.com/three',
      body: '[Publisher](https://example.com)',
      queue: 'Feed',
      published: '2026-08-01',
    });
    const result = await store.expire(new Date('2026-10-13'));
    expect(result).toEqual({ deleted: 2, promoted: 1, retained: 0 });
    expect(vault.trashed).toHaveLength(2);
    expect(store.catalog.list('Later')).toHaveLength(1);
  });
  it.each([
    '> ==first\n> second==',
    '- ==first\n  second==',
    '> ==first\r\n> second==',
    '- ==first\r\n  second==',
    '123. ==first\n     second==',
    '- outer\r\n  - ==first\r\n    second==',
    '> ==first\n> second==\n> ---',
    '- ==first\r\n  `second`==',
    '==first\n    second==',
    '==first\n\tsecond==',
    '==first\r\n    second==',
    '==first\r\n\tsecond==',
    '==first\n    second==\n---',
    '==first\n\tsecond==\n---',
    '==first\r\n    second==\r\n---',
    '==first\r\n\tsecond==\r\n---',
    '\\`==keep==\\`',
    '\\\\\\`==keep==\\\\\\`',
    'before ``==keep==` after',
    '==before `literal== after`',
    '%% hidden\r\n\r\nsecret %% ==keep==',
    '==keep %% hidden  \nsecret %% visible==',
  ])(
    'expiry promotes and byte-preserves paragraph/heading/container highlights: %j',
    async (body) => {
      const vault = new MemoryVault(),
        store = new ArticleStore(vault);
      const file = await store.capture({
        title: 'Nested highlight',
        url: 'https://example.com/nested',
        body,
        queue: 'Feed',
        published: '2026-08-01',
      });
      const raw = await vault.read(file);
      expect(await store.expire(new Date('2026-10-13'))).toEqual({
        deleted: 0,
        promoted: 1,
        retained: 0,
      });
      expect((await store.read(file.path)).properties.status).toBe('later');
      expect(readDocument(await vault.read(file)).properties).toEqual({
        ...readDocument(raw).properties,
        status: 'later',
      });
      expect((await store.read(file.path)).body).toBe(readDocument(raw).body);
      expect(vault.trashed).toEqual([]);
    },
  );

  it.each([
    '`==literal==`',
    '\\\\`==literal==\\\\`',
    '``a ` ==literal== ``',
    '%% ==hidden== %%',
    '%%\n\n==hidden==\n\n%%',
    '```\n%% ==literal== %%\n```',
  ])('does not invent annotations in literal code or hidden comments: %j', async (body) => {
    const vault = new MemoryVault(),
      store = new ArticleStore(vault);
    await store.capture({
      title: 'Literal',
      url: 'https://example.com/literal',
      body,
      queue: 'Feed',
      published: '2026-08-01',
    });
    expect(await store.expire(new Date('2026-10-13'))).toEqual({
      deleted: 1,
      promoted: 0,
      retained: 0,
    });
    expect(vault.trashed).toHaveLength(1);
  });

  it('retains highlighted Markdown if block source offsets cannot be proven', async () => {
    const { store, vault, file, snapshot } = await setup();
    vault.bytes.set(file, replaceBody(snapshot.raw, snapshot.body, '> ==first\n> second=='));
    const before = await vault.read(file);
    // A future/unsupported lexer transformation must not turn uncertainty into unannotated data.
    const lex = vi.spyOn(Lexer, 'lex').mockReturnValueOnce(
      Object.assign(
        [
          {
            type: 'paragraph',
            raw: 'not present in the original source',
            text: 'first second',
            tokens: [],
          },
        ],
        { links: {} },
      ),
    );
    try {
      expect(await store.expire(new Date('2026-10-13'))).toEqual({
        deleted: 0,
        promoted: 0,
        retained: 1,
      });
      expect(lex).toHaveBeenCalledOnce();
      expect(vault.trashed).toEqual([]);
      expect(await vault.read(file)).toBe(before);
    } finally {
      lex.mockRestore();
    }
  });

  it('does not delete articles exactly on the cutoff, newer articles, or other queues', async () => {
    const vault = new MemoryVault(),
      store = new ArticleStore(vault);
    for (const [url, published, queue] of [
      ['one', '2026-09-13', 'Feed'],
      ['two', '2026-10-01', 'Feed'],
      ['three', '2026-01-01', 'Inbox'],
    ] as const) {
      await store.capture({ url: `https://example.com/${url}`, published, queue });
    }
    expect((await store.expire(new Date('2026-10-13'))).deleted).toBe(0);
  });
  it.each(['body edit', 'rename', 'replacement', 'dispose'])(
    'rejects %s at the final trash boundary',
    async (change) => {
      const { store, vault, file, snapshot } = await setup();
      vault.beforeTrash = async () => {
        if (change === 'body edit') vault.bytes.set(file, highlight(snapshot.raw));
        if (change === 'rename') {
          vault.files.delete(file.path);
          file.path = 'Reading/Later/Moved.md';
          vault.files.set(file.path, file);
        }
        if (change === 'replacement') vault.files.set(file.path, { path: file.path });
        if (change === 'dispose') store.dispose();
      };
      await expect(store.trash(snapshot)).rejects.toThrow();
      expect(vault.trashed).toEqual([]);
      expect(vault.bytes.get(file)).toBe(
        change === 'body edit' ? highlight(snapshot.raw) : snapshot.raw,
      );
      expect(store.catalog.article(snapshot.path)).toBeDefined();
    },
  );
  it.each(['active reader', 'pending backlink promotion'])(
    'rechecks the expiry protection guard after the final await: %s',
    async () => {
      const { store, vault, file } = await setup();
      const protectedFiles = new Set<typeof file>();
      vault.beforeTrash = async () => {
        protectedFiles.add(file);
      };
      expect(
        await store.expire(new Date('2026-10-13'), (current) => protectedFiles.has(current)),
      ).toEqual({ deleted: 0, promoted: 0, retained: 1 });
      expect(vault.trashed).toEqual([]);
      expect(vault.files.get(file.path)).toBe(file);
    },
  );
  it('stops writes after disposal', async () => {
    const { store, snapshot } = await setup();
    store.dispose();
    await expect(store.annotate(snapshot, highlight)).rejects.toThrow(/stopped/);
    await expect(store.capture({ url: 'https://example.com/new' })).rejects.toThrow(/stopped/);
  });
});

describe('incremental index and bounded work', () => {
  it('indexes 10,000 articles without bodies and pages the result', () => {
    const catalog = new Catalog();
    for (let i = 0; i < 10_000; i++)
      catalog.update(`Reading/Stream/261001 Article ${i}.md`, {
        type: 'article',
        title: `Article ${i}`,
        url: `https://example.com/${i}`,
      });
    expect(catalog.size).toBe(10_000);
    expect(catalog.list('Feed')).toHaveLength(50);
    expect(catalog.findUrl('https://example.com/9999')?.title).toBe('Article 9999');
    expect(
      catalog.update('Reading/Stream/261001 Article 0.md', {
        type: 'article',
        title: 'Article 0',
        url: 'https://example.com/0',
        bookmark: 'new marker',
      }),
    ).toBe(false);
    catalog.remove('Reading/Stream/261001 Article 0.md');
    expect(catalog.findUrl('https://example.com/0')).toBeUndefined();
  });
  it('lists indexed descendants at folder boundaries, including subscriptions but not sibling prefixes', () => {
    const catalog = new Catalog();
    catalog.update('Reading/Wires/Group/Article.md', { type: 'article' });
    catalog.update('Reading/Wires/Group/Nested/Feed.md', {
      type: 'feed',
      url: 'https://example.com/feed',
    });
    catalog.update('Reading/Wires/Grouped/Other.md', { type: 'article' });
    expect(catalog.pathsWithin('Reading/Wires/Group').sort()).toEqual([
      'Reading/Wires/Group/Article.md',
      'Reading/Wires/Group/Nested/Feed.md',
    ]);
    expect(catalog.pathsWithin('Missing')).toEqual([]);
  });
  it('keeps navigation in its browsing snapshot and skips deleted neighbours', () => {
    const queue = new ReadingQueue();
    queue.open(['a', 'b', 'c'], 'a');
    queue.rename('a', 'kept-a');
    expect(queue.current).toBe('kept-a');
    expect(queue.neighbour(1, (path) => path !== 'b')).toBe('c');
    expect(queue.neighbour(-1, () => true)).toBeUndefined();
    queue.select('c');
    expect(queue.neighbour(1, () => true)).toBeUndefined();
  });
  it('serializes a file, but does not globally block unrelated files', async () => {
    const writes = new SerialWrites<string>(),
      first = gate(),
      events: string[] = [];
    const a = writes.run('one', async () => {
      events.push('a');
      await first.promise;
    });
    const b = writes.run('one', async () => {
      events.push('b');
    });
    await writes.run('two', async () => {
      events.push('other');
    });
    expect(events).toEqual(['a', 'other']);
    first.resolve();
    await Promise.all([a, b]);
    expect(events).toEqual(['a', 'other', 'b']);
  });
  it('bounds background work, deduplicates jobs, and prioritizes foreground work', async () => {
    const queue = new WorkQueue(1),
      first = gate(),
      events: string[] = [];
    const one = queue.enqueue('one', async () => {
      events.push('one');
      await first.promise;
    });
    const two = queue.enqueue('two', async () => {
      events.push('two');
    });
    expect(queue.enqueue('one', async () => {})).toBe(one);
    const urgent = queue.enqueue(
      'urgent',
      async () => {
        events.push('urgent');
      },
      true,
    );
    first.resolve();
    await Promise.all([one, two, urgent]);
    expect(events).toEqual(['one', 'urgent', 'two']);
  });
});
