// @vitest-environment node
import { expect, it } from 'vitest';
import { createDocument } from '../src/core/document';
import { ArticleStore } from '../src/core/store';
import { gate, MemoryVault } from './helpers/memory-vault';

it('audits duplicate URLs separately from uncertain legacy source anchors without repair writes', async () => {
  const vault = new MemoryVault(),
    store = new ArticleStore(vault);
  const first = await vault.create(
    'Reading/Inbox/One.md',
    createDocument(
      { type: 'article', url: 'https://example.com/article#one', unknown: 'preserve' },
      '\nAn ==unanchored passage==.\n\nA ==marked passage==. ^reader-duplicate\n\nAnother paragraph. ^reader-duplicate\n',
    ),
  );
  const second = await vault.create(
    'Reading/Later/Two.md',
    createDocument(
      { type: 'article', url: 'https://EXAMPLE.com:443/article#two' },
      '\nA ==safe passage==. ^reader-unique\n\n`==literal== ^reader-duplicate`\n',
    ),
  );
  for (const file of [first, second])
    store.catalog.update(file.path, (await store.read(file.path)).properties);
  const before = [await vault.read(first), await vault.read(second)];
  // Read-only audit is useful even while native editors are dirty and writes fail.
  vault.dirty.add(first);
  vault.failWrite = true;
  const report = await store.audit();
  expect(report.duplicateUrls).toEqual([
    { url: 'https://example.com/article', paths: [first.path, second.path] },
  ]);
  expect(report.uncertainLegacyAnchors).toEqual([
    expect.objectContaining({
      path: first.path,
      reason: 'duplicate-anchor',
      blockId: 'reader-duplicate',
    }),
    expect.objectContaining({ path: first.path, reason: 'missing-anchor' }),
  ]);
  expect(report.coverage).toMatchObject({
    scanned: 2,
    total: 2,
    skipped: [],
    urlEvidence: 'observed-metadata',
    legacyEvidence: 'source-snapshots',
  });
  expect(report.nextOffset).toBeUndefined();
  expect([await vault.read(first), await vault.read(second)]).toEqual(before);
  expect(vault.trashed).toEqual([]);
});

it('pages source inspection and reports incomplete coverage for oversized and unreadable notes', async () => {
  const vault = new MemoryVault(),
    store = new ArticleStore(vault);
  for (const [path, raw] of [
    ['A.md', createDocument({ type: 'article' }, '\n==Unanchored==.\n')],
    ['B.md', createDocument({ type: 'article' }, 'x'.repeat(300))],
    ['C.md', '---\ntype: article\ntype: article\n---\nProtected invalid YAML.'],
  ]) {
    await vault.create(path, raw);
    store.catalog.update(path, { type: 'article' });
  }
  const first = await store.audit({ limit: 1, maxSourceLength: 200 });
  expect(first.uncertainLegacyAnchors).toHaveLength(1);
  expect(first.nextOffset).toBe(1);
  const rest = await store.audit({ offset: first.nextOffset, maxSourceLength: 200 });
  expect(rest.coverage).toMatchObject({
    total: 3,
    scanned: 0,
    skipped: [
      { path: 'B.md', reason: 'oversized' },
      { path: 'C.md', reason: 'unreadable' },
    ],
  });
  expect(rest.nextOffset).toBeUndefined();
});

it('cancels promptly but retains the occupied native read slot and suppresses queued/late results', async () => {
  const vault = new MemoryVault(),
    store = new ArticleStore(vault);
  for (const path of ['A.md', 'B.md']) {
    await vault.create(path, createDocument({ type: 'article' }, '\n==Legacy==.\n'));
    store.catalog.update(path, { type: 'article' });
  }
  const entered = gate(),
    release = gate(),
    nextEntered = gate();
  const read = vault.read.bind(vault);
  let reads = 0;
  vault.read = async (file) => {
    reads++;
    if (reads === 1) {
      entered.resolve();
      await release.promise;
    } else nextEntered.resolve();
    return read(file);
  };
  const controller = new AbortController();
  const first = store.audit({ signal: controller.signal });
  await entered.promise;
  const rejected = expect(first).rejects.toMatchObject({ name: 'AbortError' });
  controller.abort();
  await rejected; // Native read is still held: cancellation is independently responsive.
  const queuedController = new AbortController();
  const queued = store.audit({ signal: queuedController.signal });
  const queuedRejected = expect(queued).rejects.toMatchObject({ name: 'AbortError' });
  queuedController.abort();
  await queuedRejected;
  const next = store.audit({ limit: 1 });
  await Promise.resolve();
  expect(reads).toBe(1);
  release.resolve();
  await nextEntered.promise;
  expect((await next).coverage.scanned).toBe(1);
  expect(reads).toBe(2); // Neither cancelled page reads its second source.
});

it('rejects already-cancelled requests without dispatching a source read', async () => {
  const vault = new MemoryVault(),
    store = new ArticleStore(vault);
  const file = await vault.create('A.md', createDocument({ type: 'article' }));
  store.catalog.update(file.path, { type: 'article' });
  vault.read = async () => {
    throw new Error('A cancelled audit must not read');
  };
  const controller = new AbortController();
  controller.abort();
  await expect(store.audit({ signal: controller.signal })).rejects.toMatchObject({
    name: 'AbortError',
  });
});

it('rejects stale-generation audit results and reports native file replacement as incomplete coverage', async () => {
  const vault = new MemoryVault(),
    store = new ArticleStore(vault);
  const file = await vault.create('A.md', createDocument({ type: 'article' }, '\n==Old==.\n'));
  store.catalog.update(file.path, { type: 'article' });
  const read = vault.read.bind(vault);
  vault.read = async (target) => {
    const raw = await read(target);
    vault.files.set(target.path, { path: target.path });
    return raw;
  };
  expect((await store.audit()).coverage).toMatchObject({
    scanned: 0,
    skipped: [{ path: 'A.md', reason: 'changed' }],
  });
  vault.files.set(file.path, file);
  vault.read = async (target) => {
    const raw = await read(target);
    store.dispose();
    return raw;
  };
  await expect(store.audit()).rejects.toThrow('Reader has stopped');
});
