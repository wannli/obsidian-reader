import { describe, expect, it, vi } from 'vitest';
import { gate, nativeStore } from './helpers/native-store';
import { ReaderRepository } from '../src/storage/repository';
import { DEFAULT_SETTINGS } from '../src/types';

const from = 'Reading/Inbox/261009 Article.md';
const to = 'Reading/Later/261009 Article.md';
const raw = '---\nurl: https://example.com/article\ncustom: keep\n---\nSource 😀.\n\n## Comments\nPersonal text.\n';
const dailyPath = 'Daily/2026-10-09.md';
const daily = `## Reading\n\n> Source 😀.\n\n[[${from.replace(/\.md$/, '')}#^hl-example|Article]]\n`;

describe('native byte-preserving queue rename', () => {
  it('allows a clean queue move while Obsidian emits normal destination-folder create events', async () => {
    const original = '---\ntype: article\npullmanFormat: inline-v1\nid: article-move\nextractor: manual\ncontent: ready\nstatus: inbox\n---\nSource 😀.\n';
    const s = nativeStore({ [from]: original }), repo = new ReaderRepository(s.store, DEFAULT_SETTINGS);
    const moved = await repo.setStatus(from, 'later');
    expect(moved.path).toBe(to);
    expect(s.disk.get(to)).toBe(original);
    expect(s.vault.createFolder).toHaveBeenCalledWith('Reading/Later');
    expect(s.vault.rename).toHaveBeenCalledOnce();
  });

  it('moves the existing file identity without rewriting source or backlinks', async () => {
    const s = nativeStore({ [from]: raw, [dailyPath]: daily });
    const file = s.files.get(from);
    await s.store.rename(from, to, { expectedContent: raw });
    expect(s.files.get(to)).toBe(file);
    expect(file?.path).toBe(to);
    expect(s.disk.has(from)).toBe(false);
    expect(s.disk.get(to)).toBe(raw);
    expect(s.disk.get(dailyPath)).toBe(daily);
    expect(s.vault.rename).toHaveBeenCalledExactlyOnceWith(file, to);
    expect(s.vault.process).not.toHaveBeenCalled();
    expect(s.vault.create).not.toHaveBeenCalled();
    expect(s.events.filter(event => event.kind === 'rename')).toEqual([{ kind: 'rename', from, path: to, text: raw }]);
  });

  it('rejects a stale expected snapshot without changing either path', async () => {
    const latest = raw + 'Concurrent writing.\n', s = nativeStore({ [from]: latest });
    await expect(s.store.rename(from, to, { expectedContent: raw })).rejects.toThrow();
    expect(s.disk).toEqual(new Map([[from, latest]]));
    expect(s.vault.rename).not.toHaveBeenCalled();
  });

  it.each([to, to.toLowerCase()])('does not overwrite an occupied destination: %s', async occupied => {
    const s = nativeStore({ [from]: raw, [occupied]: 'Unrelated note.' });
    await expect(s.store.rename(from, to, { expectedContent: raw })).rejects.toThrow();
    expect(s.disk).toEqual(new Map([[from, raw], [occupied, 'Unrelated note.']]));
    expect(s.vault.rename).not.toHaveBeenCalled();
  });

  it('preserves the source when a file blocks the destination folder', async () => {
    const s = nativeStore({ [from]: raw, 'Reading/Later': 'Not a folder.' });
    await expect(s.store.rename(from, to, { expectedContent: raw })).rejects.toThrow();
    expect(s.disk).toEqual(new Map([[from, raw], ['Reading/Later', 'Not a folder.']]));
    expect(s.vault.rename).not.toHaveBeenCalled();
  });

  it.each(['../outside.md', '/absolute.md', 'Reading/../outside.md', 'Reading/%2e%2e/outside.md', 'Reading\\outside.md'])(
    'rejects unsafe destinations without renaming: %s', async unsafe => {
      const s = nativeStore({ [from]: raw });
      await expect(s.store.rename(from, unsafe, { expectedContent: raw })).rejects.toThrow();
      expect(s.disk).toEqual(new Map([[from, raw]]));
      expect(s.vault.rename).not.toHaveBeenCalled();
    },
  );

  it.each(['source', 'preview'])('does not discard a dirty %s Markdown view', async mode => {
    const s = nativeStore({ [from]: raw }), opened = s.open(from, raw + 'Unsaved typing.\n');
    opened.view.mode = mode;
    const before = opened.editor.value;
    await expect(s.store.rename(from, to, { expectedContent: raw })).rejects.toThrow();
    expect(opened.editor.value).toBe(before);
    expect(opened.editor.reloads).toBe(0);
    expect(opened.editor.transactions).toEqual([]);
    expect(s.disk).toEqual(new Map([[from, raw]]));
    expect(s.vault.rename).not.toHaveBeenCalled();
  });

  it('rechecks source bytes when the native read was delayed', async () => {
    const s = nativeStore({ [from]: raw }), blocked = gate();
    s.hooks.beforeRead = () => blocked.promise;
    const result = s.store.rename(from, to, { expectedContent: raw });
    const rejected = expect(result).rejects.toThrow();
    await vi.waitFor(() => expect(s.vault.read).toHaveBeenCalled());
    s.disk.set(from, raw + 'Later durable edit.\n'); blocked.release();
    await rejected;
    expect(s.disk).toEqual(new Map([[from, raw + 'Later durable edit.\n']]));
    expect(s.vault.rename).not.toHaveBeenCalled();
  });

  it('preserves a target created during native rename instead of overwriting it', async () => {
    const s = nativeStore({ [from]: raw });
    s.hooks.beforeRename = async () => { await s.vault.create(to, 'Racing destination.'); };
    await expect(s.store.rename(from, to, { expectedContent: raw })).rejects.toThrow();
    expect(s.disk).toEqual(new Map([[from, raw], [to, 'Racing destination.']]));
    expect(s.events.some(event => event.kind === 'rename')).toBe(false);
  });

  it('defers loading and ambiguous multiple native views without touching buffers', async () => {
    for (const state of ['loading', 'multiple']) {
      const s = nativeStore({ [from]: raw }), first = s.open(from);
      if (state === 'loading') first.view.mode = 'loading'; else s.open(from);
      await expect(s.store.rename(from, to, { expectedContent: raw })).rejects.toThrow();
      expect(first.editor.value).toBe(raw);
      expect(first.editor.reloads).toBe(0);
      expect(s.disk).toEqual(new Map([[from, raw]]));
      expect(s.vault.rename).not.toHaveBeenCalled();
    }
  });

  it('propagates native rename failure while preserving source and daily bytes', async () => {
    const s = nativeStore({ [from]: raw, [dailyPath]: daily });
    s.vault.rename.mockRejectedValueOnce(new Error('Native rename unavailable'));
    await expect(s.store.rename(from, to, { expectedContent: raw })).rejects.toThrow('Native rename unavailable');
    expect(s.disk).toEqual(new Map([[from, raw], [dailyPath, daily]]));
    expect(s.files.get(from)?.path).toBe(from);
    expect(s.files.has(to)).toBe(false);
  });
});
