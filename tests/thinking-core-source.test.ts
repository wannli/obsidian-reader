import { expect, it } from 'vitest';
import { ThinkingStore } from '../src/core/thinking';
import { ArticleStore } from '../src/core/store';
import { MemoryVault } from './helpers/memory-vault';

async function setup(body: string) {
  const vault = new MemoryVault();
  await vault.create('Book.md', '---\nfileClass: Notebook\n---\n');
  const file = await vault.create('Source.md', '---\ntype: article\n---\n' + body);
  const articles = new ArticleStore(vault),
    source = await articles.read(file.path);
  const store = new ThinkingStore(vault, { retainSource: async (source) => source });
  return { vault, source, store };
}
it('preserves nested rich inline code while retaining native paragraph anchors without treating them as visible source context', async () => {
  const { store, source, vault } = await setup('Before. **A `safe` passage**. ^native-paragraph\n');
  const result = await store.keep({
    notebookPath: 'Book.md',
    source,
    from: source.body.indexOf('A '),
    to: source.body.indexOf('**.'),
  });
  expect(result.status, result.message).toBe('saved');
  expect(result.affectedRecords?.[0].body).toBe('**A `safe` passage**');
  expect(result.affectedRecords?.[0].source).toMatchObject({
    path: 'Source.md',
    blockId: 'native-paragraph',
  });
  expect(result.affectedRecords?.[0].after).toBe('.');
  expect(await vault.read(source.file)).toBe(source.raw);
});
it('bounds context by Unicode code points, not UTF-16 units, while preserving the entire selection', async () => {
  const { store, source } = await setup('😀'.repeat(180) + ' Selected. ' + '語'.repeat(180));
  const from = source.body.indexOf('Selected.'),
    to = from + 'Selected.'.length;
  const result = await store.keep({ notebookPath: 'Book.md', source, from, to });
  expect(result.status).toBe('saved');
  expect(Array.from(result.records[0].before!)).toHaveLength(160);
  expect(Array.from(result.records[0].after!)).toHaveLength(160);
  expect(result.records[0].body).toBe('Selected.');
});
it.each(['`=private.value`', '`<% execute %>`', 'one\n\nsecond'])(
  'rejects unsafe or unsupported source selections before retention: %s',
  async (body) => {
    const { store, source } = await setup(body);
    const result = await store.keep({
      notebookPath: 'Book.md',
      source,
      from: 0,
      to: source.body.length,
    });
    expect(result.status).toBe('failed');
    expect((await store.read('Book.md')).records).toEqual([]);
  },
);
it('retains a source again when commenting on an existing passage and preserves attached authorship', async () => {
  const { store, source, vault } = await setup('A selected passage.');
  const kept = await store.keep({
    notebookPath: 'Book.md',
    source,
    from: 0,
    to: source.body.length,
  });
  let retained = false;
  const commenting = new ThinkingStore(vault, {
    retainSource: async (source) => {
      retained = true;
      return source;
    },
  });
  const result = await commenting.comment({
    notebookPath: 'Book.md',
    about: { path: 'Book.md', blockId: kept.records[0].blockId },
    body: 'Personal response.',
  });
  expect(result.status).toBe('saved');
  expect(retained).toBe(true);
  expect(result.affectedRecords?.[0].about).toMatchObject({
    path: 'Book.md',
    blockId: kept.records[0].blockId,
  });
  expect(result.affectedRecords?.[0].source).toBeUndefined();
});
it('reports result-limit truncation even when the final notebook was the only requested document', async () => {
  const { store } = await setup('Source.');
  await store.comment({ notebookPath: 'Book.md', body: 'One.' });
  await store.comment({ notebookPath: 'Book.md', body: 'Two.' });
  const result = await store.search(['Book.md'], '', { limit: 1 });
  expect(result.hits).toHaveLength(1);
  expect(result.complete).toBe(false);
});
