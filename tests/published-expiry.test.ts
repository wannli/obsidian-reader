import { expect, it, vi } from 'vitest';
import { createDocument } from '../src/core/document';
import { monthCutoff, publicationBefore, timestamp } from '../src/core/model';
import { ArticleStore } from '../src/core/store';
import { MemoryVault } from './helpers/memory-vault';

const minute = '2026-10-03T04:29';
const start = Date.parse(minute);
const clock = (cutoff: number) => {
  const now = new Date(cutoff);
  now.setUTCMonth(now.getUTCMonth() + 1);
  expect(monthCutoff(now)).toBe(cutoff);
  return now;
};

it.each([0, 1, 30_000, 59_999, 60_000, 60_001])(
  'retains the entire local minute before a cutoff offset of %s ms',
  (elapsed) => {
    expect(publicationBefore(minute, start + elapsed)).toBe(elapsed >= 60_000);
  },
);

it.each(['2026-10-03', '2026-10-03T04:29:00.000Z', '2026-10-03T06:29:00+02:00'])(
  'preserves strict instant cutoffs for legacy %s',
  (published) => {
    const instant = timestamp(published)!;
    expect(publicationBefore(published, instant)).toBe(false);
    expect(publicationBefore(published, instant + 1)).toBe(true);
  },
);

it.each([undefined, 'invalid', '2026-02-30T04:29'])(
  'does not round filename fallback or invent an age for %j',
  (published) => {
    expect(publicationBefore(published, start + 1)).toBe(false);
    expect(publicationBefore(published, start, start)).toBe(false);
    expect(publicationBefore(published, start + 1, start)).toBe(true);
  },
);

it.each([0, 30_000, 59_999, 60_000])(
  'applies minute protection in the metadata candidate filter (%s ms)',
  async (elapsed) => {
    const vault = new MemoryVault(),
      store = new ArticleStore(vault);
    const properties = { type: 'article', status: 'feed', published: minute };
    const file = await vault.create(
      'Reading/Stream/Article.md',
      createDocument(properties, 'Publisher body.'),
    );
    store.catalog.update(file.path, properties);
    const read = vi.spyOn(vault, 'read');
    await store.expire(clock(start + elapsed));
    if (elapsed < 60_000) {
      expect(read).not.toHaveBeenCalled();
      expect(vault.trashed).toEqual([]);
    } else {
      expect(vault.trashed).toEqual([file.path]);
    }
  },
);

it('does not trust stale older metadata when fresh Markdown contains an ambiguous minute', async () => {
  const vault = new MemoryVault(),
    store = new ArticleStore(vault);
  const file = await vault.create(
    'Reading/Stream/Article.md',
    createDocument({ type: 'article', status: 'feed', published: minute }, 'Publisher body.'),
  );
  store.catalog.update(file.path, {
    type: 'article',
    status: 'feed',
    published: '2026-09-01T00:00:00Z',
  });
  const raw = await vault.read(file);
  const read = vi.spyOn(vault, 'read');
  await store.expire(clock(start + 30_000));
  expect(read).toHaveBeenCalled();
  expect(vault.trashed).toEqual([]);
  expect(await vault.read(file)).toBe(raw);
});

it('rechecks newly minute-precision publication bytes at the final trash boundary', async () => {
  const vault = new MemoryVault(),
    store = new ArticleStore(vault);
  const old = { type: 'article', status: 'feed', published: '2026-09-01T00:00:00Z' };
  const file = await vault.create(
    'Reading/Stream/Article.md',
    createDocument(old, 'Publisher body.'),
  );
  store.catalog.update(file.path, old);
  const changed = createDocument(
    { type: 'article', status: 'feed', published: minute },
    'Publisher body.',
  );
  const boundary = vi.fn(async () => {
    vault.bytes.set(file, changed);
  });
  vault.beforeTrash = boundary;
  await store.expire(clock(start + 30_000));
  expect(boundary).toHaveBeenCalledOnce();
  expect(vault.trashed).toEqual([]);
  expect(await vault.read(file)).toBe(changed);
});
