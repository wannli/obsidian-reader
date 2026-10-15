import { expect, it, vi } from 'vitest';
import { createDocument, patchProperties, readDocument } from '../src/core/document';
import { ArticleStore } from '../src/core/store';
import { StatusObserver } from '../src/host/status-observer';
import { gate, MemoryVault } from './helpers/memory-vault';

// Drain bounded promise-only work; no timers, polling sleeps, or native vaults.
async function settle() {
  for (let i = 0; i < 100; i++) await Promise.resolve();
}

async function fixture() {
  const vault = new MemoryVault();
  const store = new ArticleStore(vault);
  const raw = createDocument({ type: 'article', status: 'inbox' }, 'Article words.');
  const file = await vault.create('Source/Article.md', raw);
  const report = vi.fn();
  const observer = new StatusObserver(store, report);
  observer.seed(file, 'inbox');
  return { vault, store, file, observer, report };
}

it('a delayed own Later acknowledgement cannot cancel a newer external Archive transition', async () => {
  const f = await fixture();
  // Produce a real own-write receipt, but delay delivery of its metadata event.
  const own = await f.store.move(await f.store.read(f.file.path), 'Later');
  f.store.setStatusFolders({ later: 'Later', archive: 'Archive' });
  const external = patchProperties(own.raw, { status: 'archive' });
  f.vault.bytes.set(f.file, external);
  f.vault.dirty.add(f.file);
  f.observer.changed(f.file, external, 'archive', true);
  f.observer.changed(f.file, own.raw, 'later', true);
  f.vault.dirty.delete(f.file);
  f.observer.retry();
  await settle();
  expect(f.file.path).toBe('Archive/Article.md');
  expect(readDocument(await f.vault.read(f.file)).properties.status).toBe('archive');
  expect(f.report).not.toHaveBeenCalled();
  f.observer.stop();
});

it('a same-status editor save supersedes an in-flight raw revision and retries the successor', async () => {
  const f = await fixture();
  f.store.setStatusFolders({ later: 'Later' });
  const first = patchProperties(await f.vault.read(f.file), { status: 'later' });
  f.vault.bytes.set(f.file, first);
  const hold = gate();
  const entered = gate();
  const original = f.store.observedStatusChange.bind(f.store);
  const observed = vi.spyOn(f.store, 'observedStatusChange').mockImplementation(async (...args) => {
    if (observed.mock.calls.length === 1) {
      entered.resolve();
      await hold.promise;
    }
    return original(...args);
  });
  f.observer.changed(f.file, first, 'later', true);
  await entered.promise;
  const second = first + '\nNew authored text.\n';
  f.vault.bytes.set(f.file, second);
  f.observer.changed(f.file, second, 'later', true);
  hold.resolve();
  await settle();
  expect(f.file.path).toBe('Later/Article.md');
  expect(await f.vault.read(f.file)).toBe(second);
  expect(observed).toHaveBeenCalledTimes(2);
  expect(f.report).not.toHaveBeenCalled();
  f.observer.stop();
});

it('an own bookmark acknowledgement cannot consume a pending external status transition', async () => {
  const f = await fixture();
  f.store.setStatusFolders({ later: 'Later' });
  const external = patchProperties(await f.vault.read(f.file), { status: 'later' });
  f.vault.bytes.set(f.file, external);
  f.vault.dirty.add(f.file);
  f.observer.changed(f.file, external, 'later', true);
  // A clean own non-status write occurs before the pending organization retries.
  f.vault.dirty.delete(f.file);
  const bookmark = await f.store.position(f.file.path, 'Article words');
  f.vault.dirty.add(f.file);
  f.observer.changed(f.file, bookmark.raw, 'later', true);
  f.vault.dirty.delete(f.file);
  f.observer.retry();
  await settle();
  expect(f.file.path).toBe('Later/Article.md');
  expect(readDocument(await f.vault.read(f.file)).properties.bookmark).toBe('Article words');
  expect(f.report).not.toHaveBeenCalled();
  f.observer.stop();
});
