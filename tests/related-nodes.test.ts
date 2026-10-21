import { describe, expect, it, vi } from 'vitest';
import { ChangedNote, createDocument, patchProperties, readDocument } from '../src/core/document';
import { ArticleStore, type NoteFile } from '../src/core/store';
import { MemoryVault, gate } from './helpers/memory-vault';

const body = '\n==An existing highlight== (※ [[Concepts/A]]) ^reader-related\n';
async function fixture(
  topics: unknown = ['[[Concepts/A|Authored alias]]'],
  queue: 'Inbox' | 'Feed' = 'Inbox',
) {
  const vault = new MemoryVault(),
    store = new ArticleStore(vault);
  const source = await store.capture({
    url: 'https://example.com/related',
    title: 'Related',
    body: 'Initial body',
    queue,
  });
  const a = await vault.create(
    'Concepts/A.md',
    '---\nfileClass: Concept\n---\n## Highlights\n\n> User-owned snapshot A.\n',
  );
  const b = await vault.create(
    'Concepts/B.md',
    '---\nfileClass: Person\n---\n## Highlights\n\n> User-owned snapshot B.\n',
  );
  const untyped = await vault.create('Notes/Untyped.md', '---\nauthored: true\n---\nKeep.\n');
  const aliases = new Map<string, NoteFile>([['Short A', a]]);
  const resolve = vi.fn(
    (link: string, _sourcePath: string) =>
      aliases.get(link) ?? vault.file(link) ?? vault.file(link + '.md'),
  );
  Object.assign(vault, { resolveLink: resolve });
  const properties = {
    ...(await store.read(source.path)).properties,
    custom: { keep: true },
    topics,
  };
  vault.bytes.set(source, createDocument(properties, body));
  const snapshot = await store.read(source.path),
    targets = [a.path, b.path],
    guard = vi.fn();
  return { vault, store, source, a, b, untyped, aliases, resolve, snapshot, targets, guard };
}

describe('atomic related typed nodes', () => {
  it('adds/removes the selected relationships in one source annotation, preserving aliases, order and body', async () => {
    const f = await fixture([
      '[[Concepts/A|Authored alias]]',
      '[[Concepts/B.md|Earlier B]]',
      'Legacy text',
      { keep: 'mapping' },
    ]);
    const aBefore = await f.vault.read(f.a),
      bBefore = await f.vault.read(f.b),
      process = vi.spyOn(f.vault, 'process');
    const saved = await f.store.setRelatedNodes(
      f.snapshot,
      [f.b.path, f.b.path],
      f.targets,
      f.guard,
    );
    expect(saved.properties.topics).toEqual([
      '[[Concepts/B.md|Earlier B]]',
      'Legacy text',
      { keep: 'mapping' },
    ]);
    expect(saved.body).toBe(body);
    expect(process).toHaveBeenCalledTimes(1);
    expect(process.mock.calls[0][0]).toBe(f.source);
    expect(await f.vault.read(f.a)).toBe(aBefore);
    expect(await f.vault.read(f.b)).toBe(bBefore);
    expect(f.guard.mock.calls.length).toBeGreaterThan(1);
    expect(saved.raw).toBe(await f.vault.read(f.source));
  });

  it('removes only baseline eligible links, never untyped, unresolved or arbitrary raw values', async () => {
    const previous = [
      '[[Concepts/A]]',
      '[[Notes/Untyped]]',
      '[[Missing]]',
      7,
      null,
      { custom: ['value'] },
    ];
    const f = await fixture(previous);
    const saved = await f.store.setRelatedNodes(f.snapshot, [], f.targets, f.guard);
    expect(saved.properties.topics).toEqual(previous.slice(1));
    expect(saved.body).toBe(body);
    expect(saved.raw).toBe(patchProperties(f.snapshot.raw, { topics: previous.slice(1) }));
    expect(f.vault.trashed).toEqual([]);
  });

  it('resolves authored short links natively and keeps their alias spelling when still selected', async () => {
    const f = await fixture(['[[Short A|Original spelling]]']);
    const saved = await f.store.setRelatedNodes(
      f.snapshot,
      [f.a.path, f.b.path, f.b.path],
      f.targets,
      f.guard,
    );
    expect(saved.properties.topics).toEqual(['[[Short A|Original spelling]]', '[[Concepts/B.md]]']);
    expect(f.resolve).toHaveBeenCalledWith('Short A', f.snapshot.path);
    expect(saved.body).toBe(body);
  });

  it('preserves authored sequence nodes and their comments when adding a canonical link', async () => {
    const f = await fixture();
    const raw =
      '---\ntype: article\ncustom: untouched # outer\ntopics:\n  - "[[Concepts/A|Alias]]" # selected comment\n  - { legacy: value } # unknown comment\n---\n' +
      body;
    f.vault.bytes.set(f.source, raw);
    const saved = await f.store.setRelatedNodes(
      await f.store.read(f.source.path),
      [f.a.path, f.b.path],
      f.targets,
      f.guard,
    );
    expect(saved.raw).toContain('"[[Concepts/A|Alias]]" # selected comment');
    expect(saved.raw).toContain('{ legacy: value } # unknown comment');
    expect(saved.raw).toContain('custom: untouched # outer');
    expect(saved.properties.topics).toEqual([
      '[[Concepts/A|Alias]]',
      { legacy: 'value' },
      '[[Concepts/B.md]]',
    ]);
    expect(saved.body).toBe(body);
  });

  it.each(
    [null, 'Raw old value', 42, { authored: 'mapping' }, ['[[Missing]]', 7]].map((topics) => ({
      topics,
    })),
  )('retains a legacy topics value while adding a typed node: $topics', async ({ topics }) => {
    const f = await fixture(topics);
    const saved = await f.store.setRelatedNodes(f.snapshot, [f.b.path], f.targets, f.guard);
    expect(saved.properties.topics).toEqual([
      ...(Array.isArray(topics) ? topics : [topics]),
      '[[Concepts/B.md]]',
    ]);
    expect(saved.body).toBe(body);
  });

  it.each([null, [], 'Raw old value', { authored: 'mapping' }].map((topics) => ({ topics })))(
    'leaves a no-op legacy value byte-identical and does not retain Feed: $topics',
    async ({ topics }) => {
      const f = await fixture(topics, 'Feed'),
        process = vi.spyOn(f.vault, 'process'),
        move = vi.spyOn(f.vault, 'move');
      const saved = await f.store.setRelatedNodes(f.snapshot, [], f.targets, f.guard);
      expect(saved).toStrictEqual(f.snapshot);
      expect(await f.vault.read(f.source)).toBe(f.snapshot.raw);
      expect(process).not.toHaveBeenCalled();
      expect(move).not.toHaveBeenCalled();
      expect(f.source.path).toBe(f.snapshot.path);
    },
  );

  it('preserves links into Templates/trash as ineligible legacy values and rejects selecting them', async () => {
    const f = await fixture(['[[Templates/Typed]]', '[[.trash/Typed]]']);
    const template = await f.vault.create(
      'Templates/Typed.md',
      '---\nfileClass: Concept\n---\nTemplate.\n',
    );
    const trashed = await f.vault.create(
      '.trash/Typed.md',
      '---\nfileClass: Concept\n---\nTrashed.\n',
    );
    const baseline = [...f.targets, template.path, trashed.path];
    const saved = await f.store.setRelatedNodes(f.snapshot, [], baseline, f.guard);
    expect(saved.raw).toBe(f.snapshot.raw);
    for (const target of [template, trashed]) {
      await expect(
        f.store.setRelatedNodes(f.snapshot, [target.path], baseline, f.guard),
      ).rejects.toThrow('related typed destination changed');
      expect(await f.vault.read(f.source)).toBe(f.snapshot.raw);
    }
  });

  it('can clear the last recognized relationship without touching its old highlight or target snapshot', async () => {
    const f = await fixture(),
      targetBefore = await f.vault.read(f.a);
    const saved = await f.store.setRelatedNodes(f.snapshot, [], f.targets, f.guard);
    expect(saved.properties).not.toHaveProperty('topics');
    expect(saved.body).toBe(body);
    expect(await f.vault.read(f.a)).toBe(targetBefore);
  });

  it('supports missing topics without introducing an empty property on an empty draft', async () => {
    const f = await fixture();
    f.vault.bytes.set(f.source, patchProperties(f.snapshot.raw, { topics: undefined }));
    const before = await f.store.read(f.source.path);
    const saved = await f.store.setRelatedNodes(before, [], f.targets, f.guard);
    expect(saved.raw).toBe(before.raw);
    expect(saved.properties).not.toHaveProperty('topics');
  });

  it('requires a live public typed-provider guard', async () => {
    const f = await fixture(undefined, 'Feed');
    await expect(f.store.setRelatedNodes(f.snapshot, [f.b.path], f.targets)).rejects.toThrow(
      /typed.*guard/,
    );
    expect(await f.vault.read(f.source)).toBe(f.snapshot.raw);
  });

  it.each(['stale', 'dirty', 'identity', 'provider', 'membership'] as const)(
    'rejects a %s source/selection at its mutation boundary',
    async (kind) => {
      const f = await fixture(),
        process = f.vault.process.bind(f.vault);
      let current = true;
      const guard = vi.fn(() => {
        if (!current) throw new Error('Typed provider or membership changed');
      });
      if (kind === 'stale') f.vault.bytes.set(f.source, f.snapshot.raw + '\nNative source edit.');
      if (kind === 'dirty') f.vault.dirty.add(f.source);
      vi.spyOn(f.vault, 'process').mockImplementation(async (file, update) => {
        if (kind === 'identity') f.vault.files.set(f.b.path, { path: f.b.path });
        if (kind === 'provider' || kind === 'membership') current = false;
        return process(file, update);
      });
      const before = await f.vault.read(f.source);
      await expect(
        f.store.setRelatedNodes(f.snapshot, [f.b.path], f.targets, guard),
      ).rejects.toThrow();
      expect(await f.vault.read(f.source)).toBe(before);
    },
  );

  it('rejects a native alias rebind instead of deleting or retaining a link with changed meaning', async () => {
    const f = await fixture(['[[Short A|Alias]]']),
      process = f.vault.process.bind(f.vault);
    vi.spyOn(f.vault, 'process').mockImplementation(async (file, update) => {
      f.aliases.set('Short A', f.b);
      return process(file, update);
    });
    await expect(
      f.store.setRelatedNodes(f.snapshot, [f.b.path], f.targets, f.guard),
    ).rejects.toThrow('changed meaning');
    expect(await f.vault.read(f.source)).toBe(f.snapshot.raw);
  });

  it('freezes the original native link meaning before its source lane starts', async () => {
    const f = await fixture(['[[Short A|Alias]]']);
    const saving = f.store.setRelatedNodes(f.snapshot, [f.b.path], f.targets, f.guard);
    f.aliases.set('Short A', f.b);
    await expect(saving).rejects.toThrow('changed meaning');
    expect(await f.vault.read(f.source)).toBe(f.snapshot.raw);
  });

  it('freezes queued selected and baseline path arrays', async () => {
    const f = await fixture(),
      entered = gate(),
      release = gate(),
      process = f.vault.process.bind(f.vault);
    vi.spyOn(f.vault, 'process').mockImplementationOnce(async (file, update) => {
      entered.resolve();
      await release.promise;
      return process(file, update);
    });
    const selected = [f.b.path],
      baseline = [...f.targets];
    const saving = f.store.setRelatedNodes(f.snapshot, selected, baseline, f.guard);
    selected.splice(0, selected.length, f.untyped.path);
    baseline.length = 0;
    await entered.promise;
    release.resolve();
    const saved = await saving;
    expect(saved.properties.topics).toEqual(['[[Concepts/B.md]]']);
  });

  it('retains Feed once, writes the relationship change once, then relocates without altering target bytes', async () => {
    const f = await fixture([], 'Feed'),
      trace: string[] = [],
      process = f.vault.process.bind(f.vault),
      move = f.vault.move.bind(f.vault);
    const before = await f.vault.read(f.b);
    vi.spyOn(f.vault, 'process').mockImplementation(async (file, update) =>
      process(file, (raw) => {
        const next = update(raw);
        trace.push(
          (readDocument(next).properties.topics as unknown[]).length ? 'related' : 'retention',
        );
        return next;
      }),
    );
    vi.spyOn(f.vault, 'move').mockImplementation(async (...args) => {
      trace.push('move');
      return move(...args);
    });
    const saved = await f.store.setRelatedNodes(f.snapshot, [f.b.path], f.targets, f.guard);
    expect(trace).toEqual(['retention', 'related', 'move']);
    expect(saved.path).toContain('Reading/Later/');
    expect(saved.properties.status).toBe('later');
    expect(saved.body).toBe(body);
    expect(await f.vault.read(f.b)).toBe(before);
  });

  it('still validates a no-op stale snapshot instead of silently accepting it', async () => {
    const f = await fixture();
    f.vault.bytes.set(f.source, f.snapshot.raw + '\nNative edit.');
    await expect(
      f.store.setRelatedNodes(f.snapshot, [f.a.path], f.targets, f.guard),
    ).rejects.toBeInstanceOf(ChangedNote);
    expect(await f.vault.read(f.source)).toBe(f.snapshot.raw + '\nNative edit.');
  });
});
