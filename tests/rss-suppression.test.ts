import { describe, expect, it, vi } from 'vitest';
import {
  createDocument,
  patchProperties,
  readDocument,
  rememberDeletedUrl,
} from '../src/core/document';
import { ArticleStore } from '../src/core/store';
import { queues, vaultLink } from '../src/core/model';
import { gate, MemoryVault } from './helpers/memory-vault';

const url = 'https://example.com/article';
const feedPath = 'Reading/Wires/Example.md';
const feed = vaultLink(feedPath);
async function setup(extra: Record<string, unknown> = {}) {
  const vault = new MemoryVault();
  const store = new ArticleStore(vault);
  const subscription = await vault.create(
    feedPath,
    createDocument(
      { type: 'feed', url: 'https://example.com/rss', ...extra },
      '\nAuthored body.\n',
    ),
  );
  store.catalog.update(feedPath, readDocument(await vault.read(subscription)).properties);
  return { vault, store, subscription };
}

describe('permanent RSS suppression', () => {
  it.each(['url', 'enabled', 'cancelled', 'identity'])(
    'rejects %s changes during the final subscription read without metadata delivery',
    async (change) => {
      const { vault, store, subscription } = await setup();
      const read = vault.read.bind(vault);
      let cancelled = false;
      const check = () => {
        if (cancelled) throw new Error('Cancelled');
      };
      vi.spyOn(vault, 'read').mockImplementation(async (file) => {
        if (file === subscription) {
          if (change === 'url')
            vault.bytes.set(
              file,
              patchProperties(await read(file), { url: 'https://other.com/rss' }),
            );
          if (change === 'enabled')
            vault.bytes.set(file, patchProperties(await read(file), { enabled: false }));
          if (change === 'cancelled') cancelled = true;
          const raw = await read(file);
          if (change === 'identity') vault.files.set(file.path, { path: file.path });
          return raw;
        }
        return read(file);
      });
      await expect(
        store.importFeed({ url, feed }, new Date(), check, {
          url: 'https://example.com/rss',
          check,
        }),
      ).rejects.toThrow();
      expect(store.catalog.findUrl(url)).toBeUndefined();
      expect(store.catalog.feed(feedPath)?.enabled).toBe(true);
    },
  );

  it('resolves a short subscription link using the article source path', async () => {
    const { vault, store, subscription } = await setup();
    const resolveLink = vi.fn(() => subscription);
    Object.assign(vault, { resolveLink });
    const file = await store.capture({ url, feed: '[[Example]]' });
    await store.trash(await store.read(file.path));
    expect(resolveLink).toHaveBeenCalledWith('Example', file.path);
    expect(readDocument(await vault.read(subscription)).properties.deleted_urls).toEqual([url]);
  });

  it('retains articles when native link resolution is missing or ambiguous, even if a literal path exists', async () => {
    const { vault, store } = await setup();
    Object.assign(vault, { resolveLink: () => undefined });
    const file = await store.capture({ url, feed });
    await expect(store.trash(await store.read(file.path))).rejects.toThrow(
      'Subscription is missing',
    );
    expect(vault.file(file.path)).toBe(file);
  });
  it.each(queues)(
    'records before explicit %s trash; restart imports skip but manual capture works',
    async (queue) => {
      const { vault, store, subscription } = await setup();
      const file = await store.capture({ url: url + '#fragment', feed, queue });
      vault.beforeTrash = async () => {
        expect(readDocument(await vault.read(subscription)).properties.deleted_urls).toEqual([url]);
      };
      await store.trash(await store.read(file.path));
      const restarted = new ArticleStore(vault);
      expect(await restarted.importFeed({ url, feed })).toBeUndefined();
      expect(await restarted.capture({ url })).toBeDefined();
      expect(store.catalog.feed(feedPath)?.deletedUrls).toEqual([url]);
    },
  );

  it.each([
    'missing',
    'dirty',
    'invalid YAML',
    'wrong type',
    'malformed list',
    'invalid URL',
    'disk full',
    'stale article',
  ])('retains the article when suppression is unsafe: %s', async (failure) => {
    const { vault, store, subscription } = await setup();
    const file = await store.capture({ url, feed });
    const snapshot = await store.read(file.path);
    if (failure === 'missing') await vault.trash(subscription);
    if (failure === 'dirty') vault.dirty.add(subscription);
    if (failure === 'invalid YAML') vault.bytes.set(subscription, '---\ntype: [\n---\n');
    if (failure === 'wrong type')
      vault.bytes.set(subscription, createDocument({ type: 'article' }, ''));
    if (failure === 'malformed list')
      vault.bytes.set(subscription, createDocument({ type: 'feed', deleted_urls: url }, ''));
    if (failure === 'invalid URL')
      vault.bytes.set(
        subscription,
        createDocument({ type: 'feed', deleted_urls: ['javascript:alert(1)'] }, ''),
      );
    if (failure === 'disk full') vault.failWrite = true;
    if (failure === 'stale article') vault.bytes.set(file, snapshot.raw + 'Edited');
    await expect(store.trash(snapshot)).rejects.toThrow();
    expect(vault.file(file.path)).toBe(file);
  });

  it('preserves authored data, sequence comments, and normalized deduplication', () => {
    const raw =
      '---\ntype: feed\nunknown: &custom {a: 1}\ncopy: *custom\ndeleted_urls:\n  - https://example.com/old # keep entry comment\n---\nAuthored body.\n';
    const next = rememberDeletedUrl(raw, ' HTTPS://EXAMPLE.COM:443/article#fragment ');
    expect(next).toContain('# keep entry comment');
    expect(next).toContain('&custom');
    expect(readDocument(next).properties).toMatchObject({
      unknown: { a: 1 },
      copy: { a: 1 },
      deleted_urls: ['https://example.com/old', url],
    });
    expect(readDocument(next).body).toBe(readDocument(raw).body);
    expect(rememberDeletedUrl(next, url + '#again')).toBe(next);
  });

  it('retains suppression if trash fails', async () => {
    const { vault, store, subscription } = await setup();
    const file = await store.capture({ url, feed });
    vault.beforeTrash = async () => {
      throw new Error('Trash unavailable');
    };
    await expect(store.trash(await store.read(file.path))).rejects.toThrow('Trash unavailable');
    expect(vault.file(file.path)).toBe(file);
    expect(readDocument(await vault.read(subscription)).properties.deleted_urls).toEqual([url]);
  });

  it('does not remember native trash or expiry, and removing suppression permits reimport', async () => {
    const { vault, store, subscription } = await setup();
    const file = await store.importFeed({ url, feed, queue: 'Stream', published: '2020-01-01' });
    expect((await store.expire(new Date('2026-10-15'))).deleted).toBe(1);
    expect(readDocument(await vault.read(subscription)).properties.deleted_urls).toBeUndefined();
    const imported = await store.importFeed({ url, feed });
    await vault.trash(imported!);
    store.catalog.remove(imported!.path);
    expect(await store.importFeed({ url, feed })).toBeDefined();
    await store.trash(await store.read(store.catalog.findUrl(url)!.path));
    await vault.process(subscription, (raw) => patchProperties(raw, { deleted_urls: undefined }));
    expect(await store.importFeed({ url, feed })).toBeDefined();
    expect(file).toBeDefined();
  });

  it('uses fresh authoritative bytes, rejects malformed history, and scopes suppression per subscription', async () => {
    const { vault, store, subscription } = await setup();
    await vault.process(subscription, (raw) =>
      patchProperties(raw, { deleted_urls: [url + '#synced'] }),
    );
    expect(store.catalog.feed(feedPath)?.deletedUrls).toEqual([]);
    expect(await store.importFeed({ url, feed })).toBeUndefined();
    const other = 'Reading/Wires/Other.md';
    await vault.create(other, createDocument({ type: 'feed' }, ''));
    expect(await store.importFeed({ url, feed: vaultLink(other) })).toBeDefined();
    await vault.process(subscription, (raw) => patchProperties(raw, { deleted_urls: [false] }));
    await expect(store.importFeed({ url, feed })).rejects.toThrow('Invalid deleted_urls');
  });

  it('rechecks suppression in the final create guard after intervening synced changes', async () => {
    const { vault, store, subscription } = await setup();
    const create = vault.create.bind(vault);
    vi.spyOn(store.vault, 'create').mockImplementation(async (path, raw, guard) => {
      await vault.process(subscription, (current) => rememberDeletedUrl(current, url));
      await guard?.();
      return create(path, raw);
    });
    expect(await store.importFeed({ url, feed })).toBeUndefined();
    expect(store.catalog.findUrl(url)).toBeUndefined();
  });

  it('serializes import behind suppression and pending trash to prevent resurrection', async () => {
    const { vault, store } = await setup();
    const file = await store.capture({ url, feed });
    const entered = gate(),
      release = gate();
    vault.beforeTrash = async () => {
      entered.resolve();
      await release.promise;
    };
    const deletion = store.trash(await store.read(file.path));
    await entered.promise;
    const importing = store.importFeed({ url, feed });
    release.resolve();
    await deletion;
    expect(await importing).toBeUndefined();
    expect(store.catalog.findUrl(url)).toBeUndefined();
  });

  it('serializes trash behind a refresh already at the create boundary', async () => {
    const { vault, store } = await setup();
    const entered = gate(),
      release = gate();
    const create = vault.create.bind(vault);
    vi.spyOn(store.vault, 'create').mockImplementation(async (path, raw, guard) => {
      const file = await create(path, raw);
      entered.resolve();
      await release.promise;
      await guard?.();
      return file;
    });
    const importing = store.importFeed({ url, feed });
    await entered.promise;
    const file = [...vault.files.values()].find((file) => file.path !== feedPath)!;
    const deletion = store.trash(await store.read(file.path));
    release.resolve();
    await importing;
    await deletion;
    expect(await store.importFeed({ url, feed })).toBeUndefined();
    expect(vault.file(file.path)).toBeUndefined();
  });
});
