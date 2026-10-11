import { expect, it } from 'vitest';
import { DEFAULT_SETTINGS } from '../src/types';
import { MemoryStore } from '../src/storage/memory';
import { ReaderRepository } from '../src/storage/repository';
import { sidecarPath } from './sidecar-helpers';

const path = 'Reading/Inbox/Legacy.md';
const raw = '---\ntype: article\ncustom: !!str 001\nlabels: &labels [one, two]\nalias: *labels\n---\nAuthored source.\n';
const json = JSON.stringify({ schema: 1, path, metadata: { id: 'article-legacy', content: 'ready', extractor: 'manual' } });

it('reports matching legacy JSON without adopting or changing either file', async () => {
  const store = new MemoryStore({ [path]: raw, [sidecarPath(path)]: json }), before = store.snapshot();
  expect((await new ReaderRepository(store, DEFAULT_SETTINGS).prepareStorage()).errors.length).toBeGreaterThan(0);
  await expect(new ReaderRepository(store, DEFAULT_SETTINGS).setArticleError(path, 'blocked')).rejects.toThrow(/blocked|legacy/i);
  expect(store.snapshot()).toEqual(before);
});
it('protects both source and destination named by a JSON queueMove', async () => {
  const destination = 'Reading/Later/Legacy.md';
  const metadata = JSON.stringify({ schema: 1, path, metadata: { queueMove: { from: path, to: destination, hash: 'a'.repeat(64) } } });
  const store = new MemoryStore({ [path]: raw, [sidecarPath(path)]: metadata, [destination]: 'Independent destination.' });
  const before = store.snapshot(), repo = new ReaderRepository(store, DEFAULT_SETTINGS);
  expect((await repo.prepareStorage()).errors.length).toBeGreaterThan(0);
  await expect(repo['context'].assertWritable(destination)).rejects.toThrow(/blocked|legacy/i);
  expect(store.snapshot()).toEqual(before);
});
it.each(['', 'highlights: []\n'])('untracked quote blocks require review, not conversion (%s)', async metadata => {
  const note = '---\ntype: article\n' + metadata + '---\n## Highlights\n\n> Excerpt\n\n^hl-old\n\n## Article\n\nExcerpt\n';
  const store = new MemoryStore({ [path]: note }), before = store.snapshot();
  expect((await new ReaderRepository(store, DEFAULT_SETTINGS).prepareStorage()).errors.length).toBeGreaterThan(0);
  expect(store.snapshot()).toEqual(before);
});
it('preserves both historical metadata folders and reports the conflict', async () => {
  const current = sidecarPath(path), old = current.replace('Reading/Metadata/', 'Reading/Pullman Metadata/');
  const store = new MemoryStore({ [path]: raw, [current]: json, [old]: json }), before = store.snapshot();
  expect((await new ReaderRepository(store, DEFAULT_SETTINGS).prepareStorage()).errors.length).toBeGreaterThan(0);
  await expect(new ReaderRepository(store, DEFAULT_SETTINGS).setStatus(path, 'later')).rejects.toThrow(/blocked|legacy/i);
  expect(store.snapshot()).toEqual(before);
});
