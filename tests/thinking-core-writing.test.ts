import { expect, it } from 'vitest';
import { ThinkingStore } from '../src/core/thinking';
import { ArticleStore } from '../src/core/store';
import { MemoryVault, gate } from './helpers/memory-vault';

async function setup() {
  const vault = new MemoryVault();
  await vault.create('Book.md', '---\nfileClass: Notebook\n---\nOutside.\n');
  const store = new ThinkingStore(vault);
  await store.comment({ notebookPath: 'Book.md', body: 'First personal thought.' });
  await store.comment({
    notebookPath: 'Book.md',
    body: 'Second thought with an incidental [[Book#^comment-1]] mention.',
  });
  return { vault, store, document: await store.read('Book.md') };
}
it('persists one explicit directed connection, escapes its label and deduplicates the exact endpoint and label', async () => {
  const { store, document } = await setup();
  const record = document.records[0];
  const result = await store.connect({
    record,
    target: { path: 'Book', blockId: 'comment-2' },
    label: 'Supports [[not an edge]] *partly*',
  });
  expect(result.status).toBe('saved');
  const read = await store.read('Book.md');
  expect(read.records[0].connections).toEqual([
    { target: { path: 'Book', blockId: 'comment-2' }, label: 'Supports [[not an edge]] *partly*' },
  ]);
  expect(read.records[1].connections).toEqual([]);
  expect(read.records[1].raw).toBe(document.records[1].raw);
  const duplicate = await store.connect({
    record: read.records[0],
    target: { path: 'Book.md', blockId: 'comment-2' },
    label: 'Supports [[not an edge]] *partly*',
  });
  expect(duplicate.status).toBe('unchanged');
});
it.each(['self', 'missing', 'newline', 'file'] as const)(
  'refuses %s ordinary connections without changing content',
  async (mode) => {
    const { store, document } = await setup();
    const target =
      mode === 'missing'
        ? { path: 'Missing', blockId: 'missing' }
        : mode === 'self'
          ? { path: 'Book', blockId: 'comment-1' }
          : mode === 'file'
            ? { path: 'Book' }
            : { path: 'Book', blockId: 'comment-2' };
    const result = await store.connect({
      record: document.records[0],
      target,
      label: mode === 'newline' ? 'label\n- [[Injected]]' : '',
    });
    expect(result.status).toBe('failed');
    expect((await store.read('Book.md')).raw).toBe(document.raw);
  },
);
it('permits a deliberate structured-note file connection without fabricating a quotation or inverse edge', async () => {
  const { store, vault, document } = await setup();
  const note = await vault.create(
    'Claim.md',
    '---\nfileClass: Claim\norigin: "[[Book#^comment-1]]"\n---\nUser writing.\n',
  );
  const result = await store.connect({
    record: document.records[0],
    target: { path: 'Claim.md' },
    allowFileTarget: true,
  });
  expect(result.status).toBe('saved');
  expect(result.records[0].connections).toEqual([{ target: { path: 'Claim.md' } }]);
  expect(await vault.read(note)).toBe(
    '---\nfileClass: Claim\norigin: "[[Book#^comment-1]]"\n---\nUser writing.\n',
  );
});
it('supports explicit connection label edits and removal without rewriting authored body text', async () => {
  const { store, document } = await setup();
  const connected = await store.connect({
    record: document.records[0],
    target: { path: 'Book', blockId: 'comment-2' },
    label: 'Supports',
  });
  const old = connected.records[0].connections[0];
  const edited = await store.editConnection({
    record: connected.records[0],
    connection: old,
    label: 'Contrasts',
  });
  expect(edited.status).toBe('saved');
  expect(edited.records[0].body).toBe(document.records[0].body);
  expect(edited.records[0].connections[0].label).toBe('Contrasts');
  const removed = await store.editConnection({
    record: edited.records[0],
    connection: edited.records[0].connections[0],
    remove: true,
  });
  expect(removed.status).toBe('saved');
  expect(removed.records[0].connections).toEqual([]);
});
it('removes one exact membership and reorders only selected list slots around prose', async () => {
  const { store, vault, document } = await setup();
  const original =
    '---\nfileClass: Exploration\n---\nQuestion.\n\n- [[Book#^comment-1]]\n\nMiddle prose stays.\n\n- [[Book#^comment-2]]\n\nTrailing prose.\n';
  await vault.create('Explore.md', original);
  const exploration = await store.read('Explore.md');
  expect(exploration.memberships).toHaveLength(2);
  const reordered = await store.editExploration({
    document: exploration,
    action: 'reorder',
    memberships: exploration.memberships,
    order: [1, 0],
  });
  expect(reordered.status).toBe('saved');
  expect(reordered.document?.raw).toBe(
    original
      .replace('comment-1', 'temporary')
      .replace('comment-2', 'comment-1')
      .replace('temporary', 'comment-2'),
  );
  const removed = await store.editExploration({
    document: reordered.document!,
    action: 'remove',
    membership: reordered.document!.memberships[0],
  });
  expect(removed.status).toBe('saved');
  expect(removed.document?.raw).toContain('Middle prose stays.');
  expect(removed.document?.memberships).toHaveLength(1);
  expect((await store.read('Book.md')).raw).toBe(document.raw);
});
it('includes multiple explorations without copying personal writing and refuses stale removal', async () => {
  const { store, vault } = await setup();
  for (const path of ['One.md', 'Two.md']) {
    await vault.create(path, '---\nfileClass: Exploration\n---\n');
    const result = await store.editExploration({
      document: await store.read(path),
      action: 'add',
      target: { path: 'Book', blockId: 'comment-1' },
    });
    expect(result.status).toBe('saved');
  }
  const document = await store.read('One.md');
  vault.bytes.set(document.file, document.raw + '\nNative after.\n');
  const result = await store.editExploration({
    document,
    action: 'remove',
    membership: document.memberships[0],
  });
  expect(result.status).toBe('failed');
  expect((await store.read('One.md')).memberships).toHaveLength(1);
  expect((await store.read('Two.md')).memberships).toHaveLength(1);
});
it('writes gap comments with unique source context and leaves changed gaps unplaced', async () => {
  const vault = new MemoryVault();
  const file = await vault.create(
    'Source.md',
    '---\ntype: article\n---\nFirst paragraph.\n\nNext paragraph.\n',
  );
  await vault.create('Book.md', '---\nfileClass: Notebook\n---\n');
  const articles = new ArticleStore(vault),
    source = await articles.read(file.path);
  const store = new ThinkingStore(vault, { retainSource: async (source) => source });
  const gap = source.body.indexOf('\n\n');
  const result = await store.comment({
    notebookPath: 'Book.md',
    source,
    gap,
    body: 'Between them.',
  });
  expect(result.status).toBe('saved');
  const record = result.records[0];
  expect(store.context(record, source).status).toBe('exact');
  expect(
    store.context(record, { ...source, body: 'Changed paragraph.\n\nNext paragraph.\n' }).status,
  ).toBe('unplaced');
  expect(await vault.read(file)).toBe(source.raw);
});
it('coalesces in-flight identical free-comment Save actions without introducing a persisted operation identity', async () => {
  const { store, vault } = await setup();
  const entered = gate(),
    release = gate(),
    process = vault.process.bind(vault);
  vault.process = async (file, update) => {
    entered.resolve();
    await release.promise;
    return process(file, update);
  };
  const first = store.comment({ notebookPath: 'Book.md', body: 'Double click.' });
  await entered.promise;
  const second = store.comment({ notebookPath: 'Book.md', body: 'Double click.' });
  release.resolve();
  await Promise.all([first, second]);
  expect(
    (await store.read('Book.md')).records.filter((record) => record.body === 'Double click.'),
  ).toHaveLength(1);
});
