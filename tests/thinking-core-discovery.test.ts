import { expect, it } from 'vitest';
import { ThinkingStore, projectThinking } from '../src/core/thinking';
import { MemoryVault, gate } from './helpers/memory-vault';

async function setup() {
  const vault = new MemoryVault();
  await vault.create(
    'Unread.md',
    '---\ntype: article\n---\nA never opened source about galaxies.\n',
  );
  await vault.create('Book.md', '---\nfileClass: Notebook\n---\n');
  await vault.create(
    'Explore.md',
    '---\nfileClass: Exploration\n---\nUnfinished writing about galaxies.\n\n- [[Book#^comment-1]]\n',
  );
  const store = new ThinkingStore(vault, { now: () => new Date(2026, 10, 15) });
  await store.comment({ notebookPath: 'Book.md', body: 'An unclassified galaxy thought.' });
  await store.comment({ notebookPath: 'Book.md', body: 'Another unassigned entry.' });
  const generated = await store.read('Book.md');
  let native = generated.raw;
  for (const [index, record] of generated.records.entries())
    native = native.replace(`^${record.blockId}`, `^comment-${index + 1}`);
  vault.bytes.set(generated.file, native);
  return { vault, store };
}
it('searches unread sources, unclassified comments and exploration writing without storing state or inferring edges', async () => {
  const { vault, store } = await setup();
  const before = [...vault.bytes.values()];
  const result = await store.search(['Unread.md', 'Book.md', 'Explore.md'], 'galax');
  expect(result.complete).toBe(true);
  expect(result.hits.map((hit) => [hit.path, hit.evidence])).toEqual([
    ['Unread.md', 'literal'],
    ['Book.md', 'literal'],
    ['Explore.md', 'literal'],
  ]);
  expect([...vault.bytes.values()]).toEqual(before);
});
it('reports incomplete coverage for missing notes and capped reads rather than promising a complete index', async () => {
  const { store } = await setup();
  expect((await store.search(['Unread.md', 'Missing.md'], 'galax')).complete).toBe(false);
  const result = await store.search(['Unread.md', 'Book.md'], '', { maxReads: 1 });
  expect(result.inspected).toBe(1);
  expect(result.complete).toBe(false);
});
it('drops stale results after an uncancellable read settles', async () => {
  const { vault, store } = await setup();
  const entered = gate(),
    release = gate(),
    read = vault.read.bind(vault);
  vault.read = async (file) => {
    entered.resolve();
    await release.promise;
    return read(file);
  };
  const abort = new AbortController();
  const searching = store.search(['Unread.md', 'Book.md'], '', { signal: abort.signal });
  await entered.promise;
  abort.abort();
  release.resolve();
  const result = await searching;
  expect(result.cancelled).toBe(true);
  expect(result.hits).toEqual([]);
  expect(result.inspected).toBe(1);
});
it('bounds native search read slots across overlapping queries until native settlement', async () => {
  const { vault, store } = await setup();
  const entered = gate(),
    release = gate(),
    read = vault.read.bind(vault);
  let occupied = 0,
    maximum = 0;
  vault.read = async (file) => {
    occupied++;
    maximum = Math.max(maximum, occupied);
    if (occupied === 3) entered.resolve();
    await release.promise;
    const raw = await read(file);
    occupied--;
    return raw;
  };
  const operations = Array.from({ length: 8 }, () => store.search(['Unread.md'], 'galax'));
  await entered.promise;
  release.resolve();
  await Promise.all(operations);
  expect(maximum).toBeLessThanOrEqual(3);
});
it('projects explicit dates, overlapping native exploration membership and unassigned entries, never mtime history', async () => {
  const { store, vault } = await setup();
  await vault.create('Other.md', '---\nfileClass: Exploration\n---\n- [[Book.md#^comment-1]]\n');
  const documents = await Promise.all(
    ['Book.md', 'Explore.md', 'Other.md'].map((path) => store.read(path)),
  );
  const projection = projectThinking(documents, { complete: true });
  expect(projection.entries).toHaveLength(2);
  expect(projection.entries[0].explorations).toEqual(['Explore.md', 'Other.md']);
  expect(projection.unassigned.map((entry) => entry.record.blockId)).toEqual(['comment-2']);
  expect(projection.dates).toEqual(['2026-11-15']);
  expect(projection.complete).toBe(true);
  expect(documents[0].records[0].connections).toEqual([]);
});
it('fails closed on source-aware ambiguous link resolution even if a root filename happens to exist', async () => {
  const { store, vault } = await setup();
  const document = await store.read('Book.md');
  Object.assign(vault, { resolveLink: () => undefined });
  const result = await store.connect({
    record: document.records[0],
    target: { path: 'Book', blockId: 'comment-2' },
  });
  expect(result.status).toBe('failed');
  expect((await store.read('Book.md')).raw).toBe(document.raw);
});
