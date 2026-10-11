import { expect, it } from 'vitest';
import { ReaderRepository } from '../src/storage/repository';
import { MemoryStore } from '../src/storage/memory';
import { DEFAULT_SETTINGS } from '../src/types';
import { sidecarPath } from './sidecar-helpers';
import { articlePath } from '../src/storage/article-path';

const path = 'Reading/Inbox/Legacy.md';
const note = '---\ntype: article\npullmanFormat: inline-v1\nextractor: manual\ncontent: ready\n---\nText.\n';

it('reports and preserves historical JSON, then blocks writes to its Markdown owner', async () => {
  const jsonPath = sidecarPath(path), json = '{"schema":1,"path":"' + path + '","metadata":{"content":"ready"}}';
  const store = new MemoryStore({ [path]: note, [jsonPath]: json }), before = store.snapshot();
  for (let restart = 0; restart < 2; restart++) {
    const repo = new ReaderRepository(store, DEFAULT_SETTINGS);
    expect((await repo.prepareStorage()).errors.join(' ')).toMatch(/legacy JSON|manual review/i);
    await expect(repo.setArticleError(path, 'must not overwrite legacy-owned Markdown')).rejects.toThrow(/blocked|legacy/i);
    expect(store.snapshot()).toEqual(before);
  }
});

it.each([
  ['malformed JSON', '{invalid'],
  ['conflicting JSON', JSON.stringify({ schema: 1, path, metadata: { content: 'ready' }, conflicting: true })],
])('reports %s and preserves all evidence byte-for-byte', async (_label, json) => {
  const jsonPath = sidecarPath(path), store = new MemoryStore({ [path]: note, [jsonPath]: json }), before = store.snapshot();
  const repo = new ReaderRepository(store, DEFAULT_SETTINGS);
  expect((await repo.prepareStorage()).errors.length).toBeGreaterThan(0);
  await expect(repo.setStatus(path, 'later')).rejects.toThrow(/blocked|legacy/i);
  expect(store.snapshot()).toEqual(before);
});

it('protects orphan metadata ownership against path reuse', async () => {
  const input = { title: 'Reused', url: '', status: 'later' as const }, destination = articlePath(input, []);
  const jsonPath = sidecarPath(destination), orphan = JSON.stringify({ path: destination, metadata: { queueMove: { from: path, to: destination } } });
  const store = new MemoryStore({ [jsonPath]: orphan }), repo = new ReaderRepository(store, DEFAULT_SETTINGS), before = store.snapshot();
  expect((await repo.prepareStorage()).errors.join(' ')).toMatch(/orphaned/i);
  await expect(repo.createArticle({ ...input, body: 'Must not reuse this path.' })).rejects.toThrow(/blocked|legacy|orphaned/i);
  expect(await store.exists(destination)).toBe(false);
  expect(store.snapshot()).toEqual(before);
});

it('blocks path ownership even when a malformed YAML move endpoint precedes the valid endpoint', async () => {
  const owner = 'Reading/Inbox/Malformed move.md', target = 'Reading/Topics/Reserved.md';
  const evidence = '---\ntype: article\npullmanFormat: inline-v1\nqueueMove:\n  from: ../invalid.md\n  to: ' + target + '\n---\nKeep evidence.\n';
  const store = new MemoryStore({ [owner]: evidence }), repo = new ReaderRepository(store, DEFAULT_SETTINGS);
  expect((await repo.prepareStorage()).errors.length).toBeGreaterThan(0);
  await expect(store.create(target, '---\\ntype: topic\\n---\\n')).rejects.toThrow(/queueMove|owns this path/i);
  expect(await store.exists(target)).toBe(false);
  expect(await store.read(owner)).toBe(evidence);
});

it('reports nested uppercase JSON and blocks its named path', async () => {
  const target = 'Reading/Topics/Nested owner.md', jsonPath = 'Reading/Metadata/archive/OLD.JSON';
  const json = JSON.stringify({ path: target, metadata: { id: 'nested-owner' } });
  const store = new MemoryStore({ [jsonPath]: json }), repo = new ReaderRepository(store, DEFAULT_SETTINGS);
  expect((await repo.prepareStorage()).errors.join(' ')).toMatch(/OLD.JSON|old.json|legacy/i);
  await expect(store.create(target, '---\\ntype: topic\\n---\\n')).rejects.toThrow(/legacy JSON|legacy/i);
  expect(await store.exists(target)).toBe(false);
  expect(await store.read(jsonPath)).toBe(json);
});

it('blocks direct FileStore.create callers from creating over legacy-owned typed-node paths', async () => {
  const target = 'Reading/Topics/Owned topic.md', jsonPath = sidecarPath(target);
  const json = JSON.stringify({ path: target, metadata: { id: 'legacy-topic' } });
  const store = new MemoryStore({ [jsonPath]: json });
  await expect(store.create(target, '---\ntype: topic\n---\n'))
    .rejects.toThrow(/legacy JSON sidecar owns this path/i);
  expect(await store.exists(target)).toBe(false);
  expect(await store.read(jsonPath)).toBe(json);
});
