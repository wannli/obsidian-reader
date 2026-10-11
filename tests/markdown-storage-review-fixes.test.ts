import { expect, it } from 'vitest';
import { MemoryStore } from '../src/storage/memory';
import { ReaderRepository } from '../src/storage/repository';
import { DEFAULT_SETTINGS } from '../src/types';
import { sidecarPath } from './sidecar-helpers';

const path = 'Reading/Inbox/Review.md';
const raw = '---\ntype: article\npullmanFormat: inline-v1\nid: article-review\nextractor: manual\ncontent: ready\n---\nA ==word==.\n';
const repo = (store: MemoryStore) => new ReaderRepository(store, DEFAULT_SETTINGS);

it.each(['pullmanLegacyHash', 'pullmanLegacyStateHash'])('treats stale %s receipts as unsupported, never cleans them', async key => {
  const note = raw.replace('pullmanFormat: inline-v1', 'pullmanFormat: inline-v1\n' + key + ': ' + 'a'.repeat(64));
  const store = new MemoryStore({ [path]: note }), before = store.snapshot();
  expect((await repo(store).prepareStorage()).errors.join(' ')).toMatch(/receipt/i);
  await expect(repo(store).setArticleError(path, 'blocked')).rejects.toThrow(/receipt/i);
  expect(store.snapshot()).toEqual(before);
});

it('reports malformed/conflicting JSON and preserves both files across restart', async () => {
  const jsonPath = sidecarPath(path), json = '{"schema":1,"path":"wrong","path":"' + path + '","metadata":{"id":"conflict"}}';
  const store = new MemoryStore({ [path]: raw, [jsonPath]: json }), before = store.snapshot();
  for (let i = 0; i < 2; i++) {
    expect((await repo(store).prepareStorage()).errors.length).toBeGreaterThan(0);
    await expect(repo(store).setArticleError(path, 'must remain blocked ' + i)).rejects.toThrow(/blocked|legacy/i);
    expect(store.snapshot()).toEqual(before);
  }
});

it('rechecks unsupported metadata from the latest native buffer at mutation time', async () => {
  class NativeBufferStore extends MemoryStore {
    override async process(file: string, update: (current: string) => string): Promise<void> {
      const latestEditorBuffer = (await this.read(file)).replace('type: article', 'type: article\nqueueMove: {from: Reading/Inbox/Review.md, to: Reading/Later/Review.md}');
      update(latestEditorBuffer); // ObsidianStore's editor path likewise evaluates against its latest buffer.
    }
  }
  const store = new NativeBufferStore({ [path]: raw }), before = store.snapshot();
  await expect(repo(store).setArticleError(path, 'must not overwrite')).rejects.toThrow(/queueMove/i);
  expect(store.snapshot()).toEqual(before);
});

it('keeps clean inline notes writable without changing their current-format marker', async () => {
  const store = new MemoryStore({ [path]: raw }), repository = repo(store);
  expect((await repository.prepareStorage()).errors).toEqual([]);
  await repository.setArticleError(path, 'temporary failure');
  expect(await store.read(path)).toContain('pullmanFormat: inline-v1');
});
