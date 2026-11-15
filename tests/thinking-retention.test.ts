import { describe, expect, it } from 'vitest';
import { ArticleStore } from '../src/core/store';
import { ThinkingProtection } from '../src/core/thinking';
import { readDocument } from '../src/core/document';
import { MemoryVault } from './helpers/memory-vault';

async function fixture(queue = 'Inbox', status = 'inbox') {
  const vault = new MemoryVault();
  const path = `Reading/${queue}/Source.md`;
  const file = await vault.create(
    path,
    `---\ntype: article\nstatus: ${status}\nurl: https://example.org/source\npublished: 2020-01-01\ncustom: preserve # authored\n---\n\nOriginal source body.\n`,
  );
  const store = new ArticleStore(vault);
  const snapshot = await store.read(path);
  store.catalog.update(path, snapshot.properties);
  const protection = new ThinkingProtection();
  store.setReferenceProtection(async (sourcePath) => protection.authority(sourcePath));
  return { vault, store, file, snapshot, protection };
}

describe('thinking references protect source articles at the existing Store seam', () => {
  it('archives an otherwise unannotated referenced article on explicit Delete', async () => {
    const f = await fixture();
    f.protection.publish(
      f.protection.revision,
      [{ path: 'Notebook.md', sourcePaths: [f.snapshot.path], complete: true }],
      ['Notebook.md'],
    );
    await f.store.trash(f.snapshot);
    expect(f.vault.trashed).toEqual([]);
    expect(f.file.path).toBe('Reading/Treasury/Source.md');
    const saved = readDocument(await f.vault.read(f.file));
    expect(saved.body).toBe(f.snapshot.body);
    expect(saved.properties.status).toBe('archive');
    expect(saved.properties.custom).toBe('preserve');
  });

  it('archives a referenced expired Feed article without recording a deletion', async () => {
    const f = await fixture('Stream', 'feed');
    f.protection.publish(
      f.protection.revision,
      [{ path: 'Exploration.md', sourcePaths: [f.snapshot.path], complete: true }],
      ['Exploration.md'],
    );
    const result = await f.store.expire(new Date('2026-11-15T12:00:00Z'));
    expect(result).toEqual({ deleted: 0, retained: 0, promoted: 1 });
    expect(f.vault.trashed).toEqual([]);
    expect(f.file.path).toBe('Reading/Treasury/Source.md');
    expect(readDocument(await f.vault.read(f.file)).body).toBe(f.snapshot.body);
  });

  it('retains an explicit Delete when coverage is unknown rather than trusting a negative cache', async () => {
    const f = await fixture();
    await expect(f.store.trash(f.snapshot)).rejects.toThrow('coverage is uncertain');
    expect(f.vault.trashed).toEqual([]);
    expect(await f.vault.read(f.file)).toBe(f.snapshot.raw);
  });

  it('retains an expired source until complete reference coverage is available', async () => {
    const f = await fixture('Stream', 'feed');
    expect(await f.store.expire(new Date('2026-11-15T12:00:00Z'))).toEqual({
      deleted: 0,
      retained: 1,
      promoted: 0,
    });
    expect(await f.vault.read(f.file)).toBe(f.snapshot.raw);
  });

  it('allows ordinary unprotected deletion after a complete empty reference projection', async () => {
    const f = await fixture();
    f.protection.publish(f.protection.revision, [], []);
    await f.store.trash(f.snapshot);
    expect(f.vault.trashed).toEqual(['Reading/Inbox/Source.md']);
  });

  it('rechecks the witness after the final native await before explicit trash', async () => {
    const f = await fixture();
    f.protection.publish(f.protection.revision, [], []);
    f.vault.beforeTrash = async () => {
      f.protection.invalidate();
    };
    await expect(f.store.trash(f.snapshot)).rejects.toThrow();
    expect(f.vault.trashed).toEqual([]);
    expect(await f.vault.read(f.file)).toBe(f.snapshot.raw);
  });

  it('rechecks the same authority at the expiry trash boundary', async () => {
    const f = await fixture('Stream', 'feed');
    f.protection.publish(f.protection.revision, [], []);
    f.vault.beforeTrash = async () => {
      f.protection.invalidate();
    };
    expect(await f.store.expire(new Date('2026-11-15T12:00:00Z'))).toEqual({
      deleted: 0,
      retained: 1,
      promoted: 0,
    });
    expect(f.vault.trashed).toEqual([]);
  });

  it('does not inspect references while holding the source file lane', async () => {
    const f = await fixture();
    f.protection.publish(f.protection.revision, [], []);
    f.store.setReferenceProtection(async (path) => {
      await f.store.move(f.snapshot, 'Later');
      return f.protection.authority(path);
    });
    await expect(f.store.trash(f.snapshot)).rejects.toThrow();
    expect(f.file.path).toBe('Reading/Later/Source.md');
    expect(f.vault.trashed).toEqual([]);
  });
});
