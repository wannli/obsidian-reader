import { expect, it, vi } from 'vitest';
import { ArticleStore } from '../src/core/store';
import { createDocument, patchProperties } from '../src/core/document';
import { StatusObserver } from '../src/host/status-observer';
import { gate, MemoryVault } from './helpers/memory-vault';

async function settle() {
  for (let i = 0; i < 150; i++) await Promise.resolve();
}
async function fixture() {
  const vault = new MemoryVault(),
    store = new ArticleStore(vault);
  const file = await vault.create(
    'Source/Article.md',
    createDocument({ type: 'article', status: 'inbox' }, 'Words.'),
  );
  store.setStatusFolders({ later: 'Later', archive: 'Archive' });
  const report = vi.fn(),
    observer = new StatusObserver(store, report);
  observer.seed(file, 'inbox');
  const emit = async (status: unknown, suffix = '') => {
    const raw = patchProperties(await vault.read(file), { status }) + suffix;
    vault.bytes.set(file, raw);
    observer.changed(file, raw, status, true);
    await settle();
    return raw;
  };
  return { vault, store, file, report, observer, emit };
}
it('does not move startup, creation baseline, body-only or invalid statuses', async () => {
  const f = await fixture();
  const raw = patchProperties(await f.vault.read(f.file), { status: 'later' });
  f.vault.bytes.set(f.file, raw);
  f.observer.changed(f.file, raw, 'later', false);
  await settle();
  await f.emit('later', 'More body');
  expect(f.file.path).toBe('Source/Article.md');
  await f.emit('INVALID');
  expect(f.file.path).toBe('Source/Article.md');
});
it('does no body reads for disabled mappings across metadata status/body events', async () => {
  const f = await fixture();
  f.store.setStatusFolders({});
  const raw = await f.vault.read(f.file);
  const read = vi.spyOn(f.vault, 'read');
  for (let i = 0; i < 1000; i++) f.observer.changed(f.file, raw, i % 2 ? 'later' : 'archive', true);
  await settle();
  expect(read).not.toHaveBeenCalled();
});

it('does no body reads for initial discovery/startup or ordinary notes', async () => {
  const f = await fixture(),
    read = vi.spyOn(f.vault, 'read');
  for (let i = 0; i < 10000; i++) {
    const file = { path: `Notes/${i}.md` };
    f.observer.changed(file, 'Body', i % 2 ? 'later' : undefined, false);
    f.observer.changed(file, 'Body-only save', i % 2 ? 'later' : undefined, true);
  }
  const created = { path: 'New article.md' };
  f.observer.changed(created, 'Unknown identity', 'later', true);
  f.observer.changed(created, 'Body-only save', 'later', true);
  await settle();
  expect(read).not.toHaveBeenCalled();
});

it('skips body-only mapped events with no pending or in-flight candidate', async () => {
  const f = await fixture();
  const own = await f.store.move(await f.store.read(f.file.path), 'Later');
  f.observer.changed(f.file, own.raw, 'later', true);
  const read = vi.spyOn(f.vault, 'read');
  for (let i = 0; i < 1000; i++) f.observer.changed(f.file, own.raw + `Body ${i}`, 'later', true);
  await settle();
  expect(read).not.toHaveBeenCalled();
});

it('defers dirty source editors until safe workspace retry', async () => {
  const f = await fixture();
  f.vault.dirty.add(f.file);
  await f.emit('later');
  expect(f.file.path).toBe('Source/Article.md');
  f.vault.dirty.delete(f.file);
  f.observer.retry();
  await settle();
  expect(f.file.path).toBe('Later/Article.md');
  expect(f.report).not.toHaveBeenCalled();
});
it('queues a genuine external transition behind occupied file writes', async () => {
  const f = await fixture(),
    entered = gate(),
    hold = gate();
  const process = f.vault.process.bind(f.vault);
  f.vault.process = async (...args) => {
    entered.resolve();
    await hold.promise;
    return process(...args);
  };
  const position = f.store.position(f.file.path, 'Words').catch(() => {});
  await entered.promise;
  await f.emit('later');
  hold.resolve();
  await position;
  await settle();
  expect(f.file.path).toBe('Later/Article.md');
});
it.each(['rename', 'settings', 'delete', 'stop'] as const)(
  'invalidates deferred transition on %s',
  async (action) => {
    const f = await fixture();
    f.vault.dirty.add(f.file);
    await f.emit('later');
    if (action === 'rename') {
      const move = f.vault.move.bind(f.vault);
      await move(f.file, 'Manual/Article.md');
      f.observer.seed(f.file, 'inbox');
    }
    if (action === 'settings') f.store.setStatusFolders({ later: 'Different' });
    if (action === 'delete') {
      f.vault.files.delete(f.file.path);
      f.observer.forget(f.file);
    }
    if (action === 'stop') f.observer.stop();
    f.vault.dirty.delete(f.file);
    f.observer.retry();
    await settle();
    expect(f.file.path).not.toMatch(/^(Later|Different)\//);
  },
);
it('reports a permanent native move failure once instead of retrying on body changes', async () => {
  const f = await fixture();
  f.vault.failMove = true;
  await f.emit('later');
  f.observer.retry();
  await f.emit('later', 'More text');
  expect(f.report).toHaveBeenCalledTimes(1);
  expect(f.file.path).toBe('Source/Article.md');
});
it('rejects stale non-own metadata before it can regress the status baseline', async () => {
  const f = await fixture();
  const stale = patchProperties(await f.vault.read(f.file), { status: 'later' });
  await f.emit('archive');
  await f.vault.move(f.file, 'Manual/Article.md');
  f.observer.seed(f.file, 'archive');
  f.observer.changed(f.file, stale, 'later', true);
  await settle();
  await f.emit('archive', 'Body-only save');
  expect(f.file.path).toBe('Manual/Article.md');
  expect(f.report).not.toHaveBeenCalled();
});
it('preserves own baseline across file/folder rename seeding with stale cached status', async () => {
  const f = await fixture();
  const own = await f.store.move(await f.store.read(f.file.path), 'Later');
  f.observer.seed(f.file, 'inbox'); // Native file/folder rename can still have old metadata.
  f.observer.changed(f.file, own.raw, 'later', true);
  await f.vault.move(f.file, 'Manual/Article.md');
  f.observer.seed(f.file, 'inbox');
  await f.emit('later', 'Body-only save');
  expect(f.file.path).toBe('Manual/Article.md');
});
it('a stale same-baseline event cannot invalidate an in-flight real transition', async () => {
  const f = await fixture(),
    hold = gate();
  const read = f.vault.read.bind(f.vault);
  const stale = await read(f.file);
  const later = patchProperties(stale, { status: 'later' });
  f.vault.bytes.set(f.file, later);
  let first = true;
  f.vault.read = async (file) => {
    if (first) {
      first = false;
      await hold.promise;
      return later;
    }
    return read(file);
  };
  f.observer.changed(f.file, later, 'later', true);
  f.observer.changed(f.file, stale, 'inbox', true);
  await settle();
  hold.resolve();
  await settle();
  expect(f.file.path).toBe('Later/Article.md');
  expect(f.report).not.toHaveBeenCalled();
});

it('ignores an older event read completing after newer metadata', async () => {
  const f = await fixture(),
    hold = gate();
  const read = f.vault.read.bind(f.vault);
  const old = patchProperties(await read(f.file), { status: 'later' });
  let first = true;
  f.vault.read = async (file) => {
    if (first) {
      first = false;
      await hold.promise;
      return old;
    }
    return read(file);
  };
  f.observer.changed(f.file, old, 'later', true);
  await f.emit('archive');
  hold.resolve();
  await settle();
  await f.vault.move(f.file, 'Manual/Article.md');
  f.observer.seed(f.file, 'archive');
  await f.emit('archive', 'Body only');
  expect(f.file.path).toBe('Manual/Article.md');
});
