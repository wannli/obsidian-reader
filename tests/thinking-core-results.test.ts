import { expect, it } from 'vitest';
import { ThinkingStore } from '../src/core/thinking';
import { ArticleStore } from '../src/core/store';
import { MemoryVault } from './helpers/memory-vault';

it('distinguishes affected entries from the whole current notebook and exposes attempted anchors after uncertain settlement', async () => {
  const vault = new MemoryVault();
  await vault.create('Book.md', '---\nfileClass: Notebook\n---\n');
  const store = new ThinkingStore(vault);
  await store.comment({ notebookPath: 'Book.md', body: 'Earlier.' });
  const result = await store.comment({ notebookPath: 'Book.md', body: 'New writing.' });
  expect(result.records).toHaveLength(2);
  expect(result.affectedRecords?.map((record) => record.body)).toEqual(['New writing.']);
  const process = vault.process.bind(vault),
    read = vault.read.bind(vault);
  let settled = false;
  vault.process = async (file, update) => {
    const next = await process(file, update);
    settled = true;
    return next;
  };
  vault.read = async (file) => {
    if (settled) throw new Error('Readback unavailable');
    return read(file);
  };
  const uncertain = await store.comment({ notebookPath: 'Book.md', body: 'Maybe saved.' });
  expect(uncertain.status).toBe('possibly-saved');
  expect(uncertain.records).toEqual([]);
  expect(uncertain.attemptedRecords?.map((record) => [record.blockId, record.body])).toEqual([
    ['comment-3', 'Maybe saved.'],
  ]);
});
it('preserves manually edited snapshots rather than silently deduplicating or appending another candidate on retry', async () => {
  const vault = new MemoryVault();
  await vault.create('Book.md', '---\nfileClass: Notebook\n---\n');
  const file = await vault.create(
    'Source.md',
    '---\ntype: article\n---\nBefore. A selected passage. After.',
  );
  const articles = new ArticleStore(vault),
    source = await articles.read(file.path);
  const store = new ThinkingStore(vault, { retainSource: async (source) => source });
  const request = {
    notebookPath: 'Book.md',
    source,
    from: source.body.indexOf('A selected'),
    to: source.body.indexOf(' After.'),
  };
  expect((await store.keep(request)).status).toBe('saved');
  const document = await store.read('Book.md');
  vault.bytes.set(
    document.file,
    document.raw.replace('> A selected passage.', '> My edited snapshot.'),
  );
  const result = await store.keep(request);
  expect(result.status).toBe('failed');
  expect(result.message).toMatch(/existing|edited|candidate/i);
  expect((await store.read('Book.md')).records.map((record) => record.body)).toEqual([
    'My edited snapshot.',
  ]);
});
it('revokes publication through the supplied lifetime/source-revision guard if source changes during the target native phase', async () => {
  const vault = new MemoryVault();
  await vault.create('Book.md', '---\nfileClass: Notebook\n---\n');
  const file = await vault.create('Source.md', '---\ntype: article\n---\nSelected words.');
  const articles = new ArticleStore(vault),
    source = await articles.read(file.path);
  const store = new ThinkingStore(vault, { retainSource: async (source) => source });
  const process = vault.process.bind(vault);
  let sourceRevision = 0;
  vault.process = async (file, update) => {
    sourceRevision++;
    return process(file, update);
  };
  const result = await store.keep({
    notebookPath: 'Book.md',
    source,
    from: 0,
    to: source.body.length,
    guard: () => {
      if (sourceRevision !== 0) throw new Error('Source observation changed.');
    },
  });
  expect(result.status).toBe('partial');
  expect((await store.read('Book.md')).records).toEqual([]);
});
