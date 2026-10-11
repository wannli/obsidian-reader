import { mark } from './markdown-helpers';
import { expect, it, vi } from 'vitest';
import { nativeStore } from './helpers/native-store';
import { ReaderRepository } from '../src/storage/repository';
import { ReaderController } from '../src/controller';
import { DEFAULT_SETTINGS, type HttpGet } from '../src/types';
import { EditorWriteDeferredError } from '../src/editor-transaction';
import { parseNote } from '../src/storage/markdown';
const path = 'Reading/Inbox/Guarded.md';
// The durable stub and highlighted buffer represent the same note path.
const raw = '---\ntype: article\nurl: https://example.com/article\nstatus: inbox\n---\n\n## Article\n\n## Comments\n\nKeep comments.\n\n## Custom\n\nKeep custom.\n';
it('a newer inline-highlighted buffer is preserved and defers before any write', async () => {
  const shadow = nativeStore({ [path]: raw.replace('## Article\n\n', '## Article\n\nAuthored source.\n\n') }), shadowRepo = new ReaderRepository(shadow.store, { ...DEFAULT_SETTINGS });
  await mark(shadowRepo, path, { quote: 'Authored source.' });
  const protectedBuffer = shadow.disk.get(path)!, f = nativeStore({ [path]: raw }), { editor, view } = f.open(path, protectedBuffer), settings = { ...DEFAULT_SETTINGS };
  const controller = new ReaderController(new ReaderRepository(f.store, settings), vi.fn<HttpGet>(), settings);
  try { await expect(controller.acquire(path, true)).rejects.toThrow(/unchanged editor state|saved|stale acquisition/i); expect(editor.value).toBe(protectedBuffer); expect(f.disk.get(path)).toBe(raw); expect(f.events).toEqual([]); expect(editor.reloads).toBe(0); expect(editor.setValue).not.toHaveBeenCalled(); expect(view.save).not.toHaveBeenCalled(); }
  finally { await controller.shutdown(); }
});
it('live acquisition failure cannot stamp error/retry/id into ambiguous editor state', async () => {
  const f = nativeStore({ [path]: raw }), first = f.open(path), other = f.open(path, raw + 'Other buffer'), settings = { ...DEFAULT_SETTINGS, useDummyContent: false }, get = vi.fn<HttpGet>().mockRejectedValue(new Error('Network failed'));
  const controller = new ReaderController(new ReaderRepository(f.store, settings), get, settings);
  try { controller.setActive(true); await vi.waitFor(() => expect(controller.message).toContain('multiple Markdown views')); expect(f.disk.get(path)).toBe(raw); expect(first.editor.value).toBe(raw); expect(other.editor.value).toBe(raw + 'Other buffer'); expect(f.events).toEqual([]); await new Promise(resolve => setTimeout(resolve, 300)); expect(get).toHaveBeenCalledTimes(1); }
  finally { await controller.shutdown(); }
});
it('a second reading-mode Markdown view is also treated as an unproven save lifecycle', async () => {
  const f = nativeStore({ [path]: raw }), first = f.open(path), other = f.open(path, raw + 'Unpersisted mode-switch data'); other.view.mode = 'preview';
  const update = vi.fn(text => text + 'Reader write'); await expect(f.store.process(path, update)).rejects.toBeInstanceOf(EditorWriteDeferredError); expect(update).not.toHaveBeenCalled(); expect(first.view.save).not.toHaveBeenCalled(); expect(f.events).toEqual([]);
});
it('an editor opening before the disk callback prevents fallback disk mutation', async () => {
  const f = nativeStore({ [path]: raw }), original = f.vault.process.getMockImplementation()!;
  f.vault.process.mockImplementation(async (file, update) => { f.open(path, raw + 'Typed while disk read waited'); return original(file, update); });
  const update = vi.fn(text => text + 'Reader write'); await expect(f.store.process(path, update)).rejects.toBeInstanceOf(EditorWriteDeferredError); expect(update).not.toHaveBeenCalled(); expect(f.disk.get(path)).toBe(raw); expect(f.events).toEqual([]);
});
it('closed-file unchanged updates perform no disk write, and dirty reading-mode data defers', async () => {
  const f = nativeStore({ [path]: raw }); await f.store.process(path, text => text); expect(f.events).toEqual([]);
  const { view, editor } = f.open(path, raw + 'Dirty preview'); view.mode = 'preview'; const update = vi.fn(text => text + 'Reader');
  await expect(f.store.process(path, update)).rejects.toBeInstanceOf(EditorWriteDeferredError); expect(update).not.toHaveBeenCalled(); expect(editor.value).toBe(raw + 'Dirty preview'); expect(f.events).toEqual([]);
});
