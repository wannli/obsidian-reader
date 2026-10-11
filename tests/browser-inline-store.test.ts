import { afterEach, expect, it, vi } from 'vitest';
import { BrowserStore } from '../preview/store';

let count = 0;
const fixture = () => { const key = 'reader-inline-store-test-' + count++; return { key, store: new BrowserStore(key) }; };
const metadata = 'Reading/Metadata/' + 'a'.repeat(64) + '.json';
afterEach(() => { vi.restoreAllMocks(); localStorage.clear(); });

it('lists JSON paths so legacy ownership can be inventoried without hiding them', async () => {
  const { store } = fixture(); await store.create(metadata, '{"legacy":true}');
  expect(await store.list()).toEqual([metadata]);
});

it('honors create and rename lifecycle guards without changing durable data', async () => {
  const { store, key } = fixture(); await store.create('Reading/Inbox/Note.md', 'original');
  const before = store.snapshot(), guard = () => { throw new Error('stale generation'); };
  await expect(store.create('Reading/Inbox/New.md', 'stale', { guard })).rejects.toThrow('stale generation');
  await expect(store.rename('Reading/Inbox/Note.md', 'Reading/Later/Note.md', { expectedContent: 'original', guard })).rejects.toThrow('stale generation');
  expect(store.snapshot()).toEqual(before); expect(new BrowserStore(key).snapshot()).toEqual(before);
});

it('publishes create/process state only after localStorage accepts it', async () => {
  const { store, key } = fixture(); await store.create('Reading/Inbox/Note.md', 'original');
  const before = store.snapshot();
  vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new DOMException('Storage full', 'QuotaExceededError'); });
  await expect(store.create('Reading/Inbox/New.md', 'new')).rejects.toThrow('Storage full');
  await expect(store.process('Reading/Inbox/Note.md', () => 'changed')).rejects.toThrow('Storage full');
  expect(store.snapshot()).toEqual(before); expect(new BrowserStore(key).snapshot()).toEqual(before);
});

it('has no delete capability: old JSON remains readable and byte-identical', async () => {
  const { store, key } = fixture(); await store.create('Reading/Inbox/Note.md', 'old note'); await store.create(metadata, 'old JSON');
  const before = store.snapshot();
  expect('remove' in store).toBe(false);
  expect(await store.read(metadata)).toBe('old JSON');
  expect(store.snapshot()).toEqual(before); expect(new BrowserStore(key).snapshot()).toEqual(before);
});
